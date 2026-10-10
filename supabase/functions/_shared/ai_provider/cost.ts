// Estimated API cost and usage totals.
//
// Every number here is an ESTIMATE computed from the list prices in model_catalog.ts. It is not the amount on the
// provider invoice or the Console, and it is not the Claude credit balance: those can only be read from the
// provider, and the persistent ledger that reconciles them is Phase 1b.

import { type ModelSpec, priceTierFor } from "./model_catalog.ts";
import type { AiCostBasis, AiRequest, AiTokenUsage, AiUsageTotals } from "./types.ts";

/**
 * Safety margin on top of the request bytes when bounding input tokens: message framing, the provider's own system
 * text and the structured-output grammar are not counted in our bytes.
 */
export const INPUT_TOKEN_OVERHEAD = 2_048;

const MICRO = 1_000_000;
const UNIT = 100_000_000; // 8 decimals, the scale of ai_usage_events.cost_usd

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Estimated cost of one attempt from the usage the provider reported. */
export function attemptCostUsd(spec: ModelSpec, usage: AiTokenUsage): number {
  const tier = priceTierFor(spec, usage.inputTokens);
  const cached = usage.cacheReadInputTokens + usage.cacheWrite5mInputTokens + usage.cacheWrite1hInputTokens;
  const uncached = Math.max(0, usage.inputTokens - cached);
  const usd = (uncached * tier.inputPer1M +
    usage.cacheReadInputTokens * tier.cacheReadPer1M +
    usage.cacheWrite5mInputTokens * tier.cacheWrite5mPer1M +
    usage.cacheWrite1hInputTokens * tier.cacheWrite1hPer1M +
    usage.outputTokens * tier.outputPer1M) / MICRO;
  return Math.round(usd * UNIT) / UNIT;
}

/**
 * An upper bound on the prompt tokens of a request. A byte-level tokenizer emits at most one token per UTF-8 byte,
 * so the byte count of everything we send (instructions, content, schema) plus a fixed overhead cannot be exceeded.
 * Japanese text is about three bytes per character, so this over-estimates on purpose: it is used for budget
 * reservations and for attempts whose usage is unknown, where under-estimating would let spend escape the budget.
 */
export function upperBoundInputTokens(request: AiRequest): number {
  return utf8Bytes(request.systemInstructions) + utf8Bytes(request.userContent) +
    utf8Bytes(JSON.stringify(request.jsonSchema.schema)) + utf8Bytes(request.jsonSchema.name) + INPUT_TOKEN_OVERHEAD;
}

/**
 * The most one HTTP attempt of this request can cost: the input upper bound at the price tier it would fall in
 * (higher tiers are never cheaper), plus every allowed output token. Rounded up.
 */
export function upperBoundAttemptCostUsd(spec: ModelSpec, request: AiRequest): number {
  const inputTokens = upperBoundInputTokens(request);
  const tier = priceTierFor(spec, inputTokens);
  const usd = (inputTokens * tier.inputPer1M + request.maxOutputTokens * tier.outputPer1M) / MICRO;
  return Math.ceil(usd * UNIT) / UNIT;
}

export const ZERO_USAGE: AiTokenUsage = Object.freeze({
  inputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWrite5mInputTokens: 0,
  cacheWrite1hInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: null,
});

/** Sum of the known usages; attempts with unknown usage are counted, never added as zero. */
export function sumUsage(usages: readonly (AiTokenUsage | null)[]): AiUsageTotals {
  let inputTokens = 0, cacheReadInputTokens = 0, cacheWrite5mInputTokens = 0, cacheWrite1hInputTokens = 0, outputTokens = 0;
  let reasoningOutputTokens: number | null = null;
  let unknownUsageAttempts = 0;
  for (const usage of usages) {
    if (!usage) {
      unknownUsageAttempts += 1;
      continue;
    }
    inputTokens += usage.inputTokens;
    cacheReadInputTokens += usage.cacheReadInputTokens;
    cacheWrite5mInputTokens += usage.cacheWrite5mInputTokens;
    cacheWrite1hInputTokens += usage.cacheWrite1hInputTokens;
    outputTokens += usage.outputTokens;
    if (usage.reasoningOutputTokens !== null) reasoningOutputTokens = (reasoningOutputTokens ?? 0) + usage.reasoningOutputTokens;
  }
  return {
    inputTokens,
    cacheReadInputTokens,
    cacheWrite5mInputTokens,
    cacheWrite1hInputTokens,
    outputTokens,
    reasoningOutputTokens,
    unknownUsageAttempts,
  };
}

/** Sum of attempt costs, rounded to the ledger scale. */
export function sumCostUsd(costs: readonly number[]): number {
  return Math.round(costs.reduce((total, cost) => total + cost, 0) * UNIT) / UNIT;
}

/** How a total cost was obtained (see AiCostBasis). */
export function costBasisOf(attempts: readonly { costIsUpperBound: boolean }[]): AiCostBasis {
  if (attempts.length === 0) return "no_request";
  return attempts.some((attempt) => attempt.costIsUpperBound) ? "includes_upper_bound" : "measured";
}

/** The JST calendar month ("YYYY-MM") of an instant, the `month` of a usage key. */
export function usageMonthJst(epochMs: number): string {
  const jst = new Date(epochMs + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
}
