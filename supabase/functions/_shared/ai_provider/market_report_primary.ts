// F6 V0 (2026-10-13): Claude as the PRIMARY generator of the shared CLOSE market report. Not a shadow. Default off.
// Contract and activation: docs/ai-provider/F6_OPUS_PRIMARY_CLOSE_V0.md.
//
// prepareMarketReportPrimary(...) -> one of
//   legacy:  KABUMORI_MARKET_REPORT_AI_MODE is not exactly "primary_close", or the report is not "close". The caller
//            keeps its OpenAI requester untouched; only the mode variable was read.
//   invalid: "primary_close" for a close report, but it cannot run (model, key, ledger or claim missing). The caller
//            fails the report with ANALYSIS_PRIMARY_CONFIG:<reason>; it never falls back to OpenAI silently.
//   primary: every model call of the report (generate AND fact) goes to the configured Anthropic catalog model through
//            executeAiRequest and the budget ledger: one transport attempt, no retry, no automatic OpenAI fallback,
//            each call bounded by the time left before the caller's deadline. A failed call throws
//            ANALYSIS_PRIMARY_<STEP>_FAILED:<code>, so the report fails like an OpenAI failure does today.
//
// The mode variable is the one the Phase 2a shadow reads; only "shadow" turns the shadow on, so one variable cannot
// enable shadow and primary for the same attempt.

import type { FetchLike } from "./adapter.ts";
import type { BudgetGuard } from "./budget.ts";
import { executeAiRequest } from "./execute.ts";
import { SupabaseLedgerBudgetGuard } from "./ledger_guard.ts";
import { findModelSpec } from "./model_catalog.ts";
import { DEFAULT_RETRY_TIMING } from "./retry.ts";
import { type EnvReader, resolveProviderApiKey, SecretValue } from "./secrets.ts";
import type { AiCostBasis, AiReasoningEffort, AiRequest } from "./types.ts";

export const MARKET_REPORT_AI_MODE_ENV = "KABUMORI_MARKET_REPORT_AI_MODE";
export const PRIMARY_CLOSE_MODE = "primary_close";
/** The primary model, by configuration (this layer never names a model); it must be an Anthropic catalog model. */
export const MARKET_REPORT_PRIMARY_MODEL_ENV = "KABUMORI_MARKET_REPORT_PRIMARY_MODEL";
export const PRIMARY_PROVIDER = "anthropic";
/** Per call, as the OpenAI path (OPENAI_TIMEOUT_MS). */
export const PRIMARY_CALL_TIMEOUT_MS = 90_000;
/** From the start of the invocation: leaves about 20 s of a 150 s Edge wall clock for the report's own writes. */
export const PRIMARY_RUN_BUDGET_MS = 130_000;
/** execute.ts sends only while min(minAttemptMs, timeout) is left; a call with less time than this is not started. */
export const PRIMARY_MIN_CALL_MS = DEFAULT_RETRY_TIMING.minAttemptMs + 1_000;

export type PrimaryStep = "generate" | "fact";
export type PrimaryStepResult = { readonly payload: unknown; readonly inputTokens: number; readonly outputTokens: number };
export type PrimaryRequester = (step: PrimaryStep, body: Record<string, unknown>) => Promise<PrimaryStepResult>;

/** What the sink receives per call: identifiers, counts and codes. No prompt, output or key. */
export type MarketReportPrimaryRecord = {
  readonly step: PrimaryStep;
  readonly sequence: number;
  readonly callId: string;
  readonly model: string;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly detail: string | null;
  readonly providerRequests: number;
  readonly actualModel: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly costBasis: AiCostBasis | "unknown";
  readonly latencyMs: number;
};

export type PrimaryTotals = { readonly calls: number; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number };

export type PreparedMarketReportPrimary =
  | { readonly mode: "legacy"; readonly reason: string }
  | { readonly mode: "invalid"; readonly reason: string }
  | {
    readonly mode: "primary";
    readonly reason: "PRIMARY";
    readonly provider: typeof PRIMARY_PROVIDER;
    readonly model: string;
    readonly requester: PrimaryRequester;
    /** Ledger-consistent sums over every call made so far (failed calls included at what they were settled for). */
    totals(): PrimaryTotals;
  };

export type PrepareMarketReportPrimaryOptions = {
  /** Reads ONE environment variable (an Edge Function: `(name) => Deno.env.get(name)`). */
  readonly readEnv: EnvReader;
  readonly reportType: string;
  /** The claim row the handler already has (claim_market_report_analysis). */
  readonly claim: { readonly cycle_id: string | null; readonly attempt: number } | null;
  /** Absolute time (ms, same clock as nowMs) after which no call is started; usually start + PRIMARY_RUN_BUDGET_MS. */
  readonly deadlineAtMs: number;
  readonly sink: (record: MarketReportPrimaryRecord) => void;
  readonly fetch?: FetchLike;
  readonly nowMs?: () => number;
  /** Tests only: a ledger other than the one built from SUPABASE_URL / SUPABASE_SECRET_KEYS. */
  readonly budget?: BudgetGuard | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EFFORTS: readonly AiReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const CODE = /^[A-Za-z0-9_.:-]{1,60}$/u;

function readOne(readEnv: EnvReader, name: string): string | undefined {
  try {
    return readEnv(name);
  } catch {
    return undefined;
  }
}

export function marketReportPrimaryCallId(cycleId: string, claimAttempt: number, step: PrimaryStep, sequence: number): string {
  return `mrp:${cycleId.toLowerCase()}:a${claimAttempt}:${step}:${sequence}`;
}

/**
 * The primary request for one report Responses-API body: the same instructions, input, strict JSON schema, output cap
 * and effort, sent to the primary model as the system market report. Null when the body is not the shape the report
 * builds (nothing is sent). The OpenAI model id in the body is ignored: the configuration names the primary model.
 */
export function primaryRequestFromResponsesBody(
  step: PrimaryStep,
  body: Record<string, unknown>,
  options: { readonly callId: string; readonly timeoutMs: number; readonly model: string },
): { readonly ok: true; readonly request: AiRequest } | { readonly ok: false; readonly code: string } {
  const format = (body.text as { format?: { type?: unknown; name?: unknown; schema?: unknown } } | undefined)?.format;
  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort;
  if (typeof body.instructions !== "string" || body.instructions === "") return { ok: false, code: "BODY_INSTRUCTIONS" };
  if (typeof body.input !== "string" || body.input === "") return { ok: false, code: "BODY_INPUT" };
  if (!format || format.type !== "json_schema" || typeof format.name !== "string" || typeof format.schema !== "object" || format.schema === null) {
    return { ok: false, code: "BODY_SCHEMA" };
  }
  if (!Number.isInteger(body.max_output_tokens) || (body.max_output_tokens as number) < 1) return { ok: false, code: "BODY_MAX_OUTPUT" };
  if (typeof effort !== "string" || !EFFORTS.includes(effort as AiReasoningEffort)) return { ok: false, code: "BODY_EFFORT" };
  return {
    ok: true,
    request: {
      logicalRole: `kabumori.market_report.${step}.primary`,
      provider: PRIMARY_PROVIDER,
      model: options.model,
      systemInstructions: body.instructions,
      userContent: body.input,
      jsonSchema: { name: format.name, schema: format.schema as Record<string, unknown> },
      reasoningEffort: effort as AiReasoningEffort,
      maxOutputTokens: body.max_output_tokens as number,
      timeoutMs: options.timeoutMs,
      transport: { maxAttempts: 1, retryOnTimeout: false },
      usageContext: { application: "kabumori", feature: "market_report", subject: { kind: "system" } },
      callId: options.callId,
    },
  };
}

/** The production ledger from an Edge Function's environment (SUPABASE_URL + SUPABASE_SECRET_KEYS["default"]). */
export function primaryLedgerFromEdgeEnv(readEnv: EnvReader, fetchImpl?: FetchLike): SupabaseLedgerBudgetGuard | null {
  try {
    const url = readEnv("SUPABASE_URL");
    const raw = readEnv("SUPABASE_SECRET_KEYS");
    if (!url || !raw) return null;
    const key = (JSON.parse(raw) as Record<string, unknown>)["default"];
    if (typeof key !== "string" || key === "" || /\s/u.test(key)) return null;
    return new SupabaseLedgerBudgetGuard({ supabaseUrl: url, serviceKey: new SecretValue("SUPABASE_SECRET_KEYS.default", key), fetch: fetchImpl });
  } catch {
    return null;
  }
}

export function prepareMarketReportPrimary(options: PrepareMarketReportPrimaryOptions): PreparedMarketReportPrimary {
  const mode = readOne(options.readEnv, MARKET_REPORT_AI_MODE_ENV);
  if (mode !== PRIMARY_CLOSE_MODE) return { mode: "legacy", reason: "OFF" };
  if (options.reportType !== "close") return { mode: "legacy", reason: "NOT_CLOSE" };

  const model = readOne(options.readEnv, MARKET_REPORT_PRIMARY_MODEL_ENV) ?? "";
  if (findModelSpec(model)?.provider !== PRIMARY_PROVIDER) return { mode: "invalid", reason: "MODEL_INVALID" };
  const key = resolveProviderApiKey(PRIMARY_PROVIDER, options.readEnv);
  if (!key.ok) return { mode: "invalid", reason: key.code };
  const budget = options.budget === undefined ? primaryLedgerFromEdgeEnv(options.readEnv, options.fetch) : options.budget;
  if (!budget) return { mode: "invalid", reason: "NO_LEDGER" };
  const claim = options.claim;
  if (!claim || typeof claim.cycle_id !== "string" || !UUID.test(claim.cycle_id) || !Number.isInteger(claim.attempt) ||
    claim.attempt < 1 || claim.attempt > 99) {
    return { mode: "invalid", reason: "BAD_CONTEXT" };
  }
  if (!Number.isFinite(options.deadlineAtMs)) return { mode: "invalid", reason: "BAD_DEADLINE" };

  const cycleId = claim.cycle_id;
  const claimAttempt = claim.attempt;
  const nowMs = options.nowMs ?? Date.now;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const sequences: Record<PrimaryStep, number> = { generate: 0, fact: 0 };
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  const emit = (record: MarketReportPrimaryRecord) => {
    try {
      options.sink(record);
    } catch {
      // A sink failure never reaches the report.
    }
  };
  const fail = (step: PrimaryStep, code: string): Error =>
    new Error(`ANALYSIS_PRIMARY_${step.toUpperCase()}_FAILED:${CODE.test(code) ? code : "UNKNOWN"}`);

  const requester: PrimaryRequester = async (step, body) => {
    sequences[step] += 1;
    const sequence = sequences[step];
    const callId = marketReportPrimaryCallId(cycleId, claimAttempt, step, sequence);
    const base = { step, sequence, callId, model };
    const unsent = (errorCode: string, detail: string | null) =>
      emit({ ...base, ok: false, errorCode, detail, providerRequests: 0, actualModel: null, inputTokens: 0, outputTokens: 0,
        estimatedCostUsd: 0, costBasis: "no_request", latencyMs: 0 });

    const timeoutMs = Math.min(PRIMARY_CALL_TIMEOUT_MS, Math.floor(options.deadlineAtMs - nowMs()));
    if (!(timeoutMs >= PRIMARY_MIN_CALL_MS)) {
      unsent("DEADLINE_EXCEEDED", "run_budget");
      throw fail(step, "DEADLINE_EXCEEDED");
    }
    const translated = primaryRequestFromResponsesBody(step, body, { callId, timeoutMs, model });
    if (!translated.ok) {
      unsent("BAD_BODY", translated.code);
      throw fail(step, "BAD_BODY");
    }
    const start = nowMs();
    let result;
    try {
      result = await executeAiRequest(translated.request, { readEnv: options.readEnv, budget, fetch: fetchImpl, nowMs, deadlineAtMs: start + timeoutMs });
    } catch {
      emit({ ...base, ok: false, errorCode: "PRIMARY_EXCEPTION", detail: null, providerRequests: 0, actualModel: null, inputTokens: 0,
        outputTokens: 0, estimatedCostUsd: 0, costBasis: "unknown", latencyMs: Math.max(0, nowMs() - start) });
      throw fail(step, "PRIMARY_EXCEPTION");
    }
    calls += 1;
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    costUsd = Number((costUsd + result.estimatedCostUsd).toFixed(6));
    emit({
      ...base,
      ok: result.ok,
      errorCode: result.ok ? null : result.errorCode,
      detail: result.ok ? null : result.detail,
      providerRequests: result.transportAttempts,
      actualModel: result.actualModel,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      costBasis: result.costBasis,
      latencyMs: result.latencyMs,
    });
    if (!result.ok) throw fail(step, result.errorCode);
    return { payload: result.parsedPayload, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
  };

  return {
    mode: "primary",
    reason: "PRIMARY",
    provider: PRIMARY_PROVIDER,
    model,
    requester,
    totals: () => ({ calls, inputTokens, outputTokens, costUsd }),
  };
}
