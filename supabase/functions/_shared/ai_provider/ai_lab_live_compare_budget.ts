// Task55: the price and budget gates of the A/B/C comparison runner.
//
// Task54's runner capped the number of paid calls but not the money. This module adds what must hold before the
// first paid call and before every later one:
//
// 1. Explicit approval. There is no default budget: the user-approved USD ceiling, the paid-call cap and the
//    per-call input/output token limits come from outside, with a reference to where the user approved them.
//    Task53's $0.30 is not reused; a missing or partial budget stops before any request.
// 2. Price confirmation. Every planned model's list price must have been compared with the official pricing page
//    within LIVE_COMPARE_PRICE_CHECK_MAX_AGE_MS, against this catalog version, and match the catalog. Unconfirmed,
//    stale or changed prices stop before any request.
// 3. Plan worst case. With the declared per-call limits, the most the whole plan can cost (every planned call,
//    plus any spare calls under the cap at the dearest planned model) must fit the ceiling before the free model
//    checks run, so a trial never starts that the budget cannot finish.
// 4. Per call. A request without an output token limit, with tools (server tools bill extra), or over the declared
//    limits is refused unsent. Each send reserves its own worst case; reservations are never refunded, also not
//    for a failure or an unknown outcome. A 200 answer without readable usage, or with usage above the reserved
//    bound, stops the whole trial.
//
// This is NOT a hard cap. Neither provider offers a per-request USD limit; the bound holds only while the
// provider honours max_tokens / max_output_tokens (thinking and reasoning tokens included), bills at most one
// token per request byte plus INPUT_TOKEN_OVERHEAD, and does not charge more than the confirmed list price times
// LIVE_COMPARE_COST_SAFETY_FACTOR. A provider-side change or an unannounced charge can break it; the only
// guarantee left is that the trial stops at the first sign of it and never re-sends.

import { INPUT_TOKEN_OVERHEAD } from "./cost.ts";
import { AI_PROVIDER_CATALOG_VERSION, findModelSpec, type ModelSpec } from "./model_catalog.ts";
import type { AiProvider } from "./types.ts";

/** Head-room on the confirmed list prices for rounding, small price changes and charges we do not model. */
export const LIVE_COMPARE_COST_SAFETY_FACTOR = 1.25;
/** A price check older than this (or in the future) does not count. */
export const LIVE_COMPARE_PRICE_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Stated in every result: the ceiling is a client-side estimate, not a provider-enforced limit. */
export const LIVE_COMPARE_CAP_KIND = "client_estimate_not_hard_cap" as const;

export type LiveCompareBudget = {
  /** Where the user approved these numbers (Issue comment URL etc.). Never a secret. */
  approvalRef: string;
  ceilingUsd: number;
  maxPaidCalls: number;
  maxInputTokensPerCall: number;
  maxOutputTokensPerCall: number;
};

/** The operator's record of comparing the catalog with the official pricing pages at run time. */
export type LiveComparePriceCheck = {
  checkedAtMs: number;
  catalogVersion: string;
  /** USD per 1M tokens as read on the official page, per model id. */
  prices: Readonly<Record<string, { inputPer1M: number; outputPer1M: number }>>;
};

export type LiveCompareBudgetStop =
  | "BUDGET_NOT_APPROVED"
  | "PLAN_EXCEEDS_CALL_CAP"
  | "BUDGET_INSUFFICIENT_FOR_PLAN"
  | "PRICE_UNCONFIRMED"
  | "PRICE_CHECK_STALE"
  | "PRICE_CHANGED"
  | "REQUEST_UNBOUNDED"
  | "REQUEST_OVER_LIMITS"
  | "BUDGET_EXCEEDED"
  | "PAID_USAGE_MISSING"
  | "PAID_COST_OVERRUN";

const MICRO = 1_000_000;
const UNIT = 100_000_000;
const roundUp = (usd: number) => Math.ceil(usd * UNIT) / UNIT;
const positiveInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** The dearest input-side and output price of a model over all tiers and cache kinds. */
export function worstPricesPer1M(spec: ModelSpec) {
  let input = 0, output = 0;
  for (const tier of spec.priceTiers) {
    input = Math.max(input, tier.inputPer1M, tier.cacheReadPer1M, tier.cacheWrite5mPer1M, tier.cacheWrite1hPer1M);
    output = Math.max(output, tier.outputPer1M);
  }
  return { input, output };
}

/** The most one call can cost under the safety factor, priced at the dearest rates of the model. */
export function worstCallCostUsd(spec: ModelSpec, inputTokens: number, outputTokens: number): number {
  const { input, output } = worstPricesPer1M(spec);
  return roundUp((inputTokens * input + outputTokens * output) / MICRO * LIVE_COMPARE_COST_SAFETY_FACTOR);
}

export function checkBudgetApproval(budget: LiveCompareBudget | undefined): LiveCompareBudgetStop | null {
  if (
    !budget || typeof budget.approvalRef !== "string" || budget.approvalRef.trim() === "" ||
    typeof budget.ceilingUsd !== "number" || !Number.isFinite(budget.ceilingUsd) || budget.ceilingUsd <= 0 ||
    !positiveInt(budget.maxPaidCalls) || !positiveInt(budget.maxInputTokensPerCall) ||
    !positiveInt(budget.maxOutputTokensPerCall)
  ) return "BUDGET_NOT_APPROVED";
  return null;
}

export function checkPriceConfirmation(
  models: readonly string[],
  check: LiveComparePriceCheck | undefined,
  nowMs: number,
): LiveCompareBudgetStop | null {
  if (!check || !Number.isFinite(check.checkedAtMs)) return "PRICE_UNCONFIRMED";
  if (check.checkedAtMs > nowMs || nowMs - check.checkedAtMs > LIVE_COMPARE_PRICE_CHECK_MAX_AGE_MS) {
    return "PRICE_CHECK_STALE";
  }
  if (check.catalogVersion !== AI_PROVIDER_CATALOG_VERSION) return "PRICE_CHANGED";
  for (const model of models) {
    const seen = Object.hasOwn(check.prices, model) ? check.prices[model] : undefined;
    const spec = findModelSpec(model);
    if (!seen || !spec) return "PRICE_UNCONFIRMED";
    const base = spec.priceTiers[0];
    if (seen.inputPer1M !== base.inputPer1M || seen.outputPer1M !== base.outputPer1M) return "PRICE_CHANGED";
  }
  return null;
}

/**
 * The most the plan can cost: every planned call at the declared limits, plus the spare calls the cap still
 * allows at the dearest planned model.
 */
export function planWorstCaseUsd(
  calls: readonly string[],
  budget: LiveCompareBudget,
): number {
  let total = 0, dearest = 0;
  for (const model of calls) {
    const cost = worstCallCostUsd(findModelSpec(model)!, budget.maxInputTokensPerCall, budget.maxOutputTokensPerCall);
    total += cost;
    dearest = Math.max(dearest, cost);
  }
  total += Math.max(0, budget.maxPaidCalls - calls.length) * dearest;
  return roundUp(total);
}

/** Token bounds of one request body, or a stop when the body is unbounded or over the declared limits. */
export function requestBounds(
  provider: AiProvider,
  raw: string,
  budget: LiveCompareBudget,
): { inputTokens: number; outputTokens: number } | LiveCompareBudgetStop {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "REQUEST_UNBOUNDED";
  }
  const outputTokens = provider === "anthropic" ? body.max_tokens : body.max_output_tokens;
  if (!positiveInt(outputTokens) || "tools" in body || "tool_choice" in body) return "REQUEST_UNBOUNDED";
  const inputTokens = new TextEncoder().encode(raw).length + INPUT_TOKEN_OVERHEAD;
  if (inputTokens > budget.maxInputTokensPerCall || (outputTokens as number) > budget.maxOutputTokensPerCall) {
    return "REQUEST_OVER_LIMITS";
  }
  return { inputTokens, outputTokens: outputTokens as number };
}

/**
 * Billed tokens from a 200 answer. Anthropic reports cache reads/writes apart from input_tokens; OpenAI's
 * input_tokens already include cached ones. Output includes thinking / reasoning on both. Null = unreadable.
 */
export function billedTokens(
  provider: AiProvider,
  body: unknown,
): { inputTokens: number; outputTokens: number } | null {
  const usage = (body as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const n = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const input = n(usage.input_tokens), output = n(usage.output_tokens);
  if (input === null || output === null) return null;
  if (provider === "openai") return { inputTokens: input, outputTokens: output };
  const extra = (v: unknown) => v === undefined || v === null ? 0 : n(v);
  const write = extra(usage.cache_creation_input_tokens), read = extra(usage.cache_read_input_tokens);
  if (write === null || read === null) return null;
  return { inputTokens: input + write + read, outputTokens: output };
}
