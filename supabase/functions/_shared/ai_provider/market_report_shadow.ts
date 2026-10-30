// Shared market report -> shared AI provider connection candidate (common AI foundation, Phase 2a; source only,
// NOT wired into any Edge Function).
//
// The shared market report (market-report-analysis) calls its model through a requester:
//   (step: "generate" | "fact", body: OpenAI Responses request body) => { payload, inputTokens, outputTokens }.
// createMarketReportRequester wraps that requester:
//   off (the default; also for an unset, unknown or incomplete setting) -> returns the legacy requester ITSELF:
//       nothing is read, sent or recorded, and the report behaves exactly as before;
//   shadow -> the legacy requester still produces every result the report uses. After a legacy step listed in
//       `steps` (default: "generate") returns, the SAME instructions, input and JSON schema are sent ONCE to the
//       caller's shadow model (an Anthropic model of the catalog; Claude Opus 5.5 is the Phase 2a candidate) through
//       executeAiRequest and the budget ledger (system subject, kabumori / market_report), and only
//       a content-free record goes to the caller's sink: ok / error code, tokens, the ledger-matching estimated
//       cost, latency and a structural comparison with the legacy payload. The shadow never changes the returned
//       value, never throws into the pipeline, never retries (one transport attempt), never falls back to another
//       provider, and never runs after the legacy step failed.
// A "primary" mode (Claude producing the delivered report) does not exist here: switching the delivered model is a
// separate, separately approved step (docs/ai-provider/PHASE2A_MARKET_REPORT_ADAPTER.md).
//
// Idempotency: every shadow call has a deterministic callId from the report cycle, its claim attempt, the step and
// its sequence number, so a re-run of the same claim attempt is refused by the ledger instead of paying twice.

import type { FetchLike } from "./adapter.ts";
import type { BudgetGuard } from "./budget.ts";
import { executeAiRequest } from "./execute.ts";
import { SupabaseLedgerBudgetGuard } from "./ledger_guard.ts";
import { findModelSpec } from "./model_catalog.ts";
import { type EnvReader, resolveProviderApiKey, SecretValue } from "./secrets.ts";
import type { AiErrorCode, AiReasoningEffort, AiRequest } from "./types.ts";

export const MARKET_REPORT_AI_MODE_ENV = "KABUMORI_MARKET_REPORT_AI_MODE";
export const SHADOW_PROVIDER = "anthropic";
export const DEFAULT_SHADOW_TIMEOUT_MS = 90_000;
/** At most this many shadow calls per invocation (the report makes at most two generations). */
export const DEFAULT_MAX_SHADOW_CALLS = 2;

export type MarketReportStep = "generate" | "fact";
export type MarketReportStepResult = { payload: unknown; inputTokens: number; outputTokens: number };
/** Structurally identical to market-report-analysis' Requester. */
export type MarketReportRequester = (step: MarketReportStep, body: Record<string, unknown>) => Promise<MarketReportStepResult>;

export type MarketReportAiMode = "off" | "shadow";
export type ModeDecision = {
  readonly mode: MarketReportAiMode;
  /**
   * Why: SHADOW, or why it is off (UNSET, OFF, UNSUPPORTED_VALUE, SHADOW_MODEL_INVALID, KEY_MISSING, KEY_INVALID, NO_LEDGER,
   * BAD_CONTEXT).
   */
  readonly reason: string;
};

/** Only the exact value "shadow" turns the shadow on; everything else, including typos and "primary", is off. */
export function parseMarketReportAiMode(raw: string | undefined): ModeDecision {
  if (raw === undefined || raw === "") return { mode: "off", reason: "UNSET" };
  if (raw === "off") return { mode: "off", reason: "OFF" };
  if (raw === "shadow") return { mode: "shadow", reason: "SHADOW" };
  return { mode: "off", reason: "UNSUPPORTED_VALUE" };
}

/** The report cycle a requester serves; it makes the shadow callIds deterministic. */
export type MarketReportContext = { readonly cycleId: string; readonly claimAttempt: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function validContext(context: MarketReportContext | undefined): context is MarketReportContext {
  return !!context && typeof context.cycleId === "string" && UUID.test(context.cycleId) &&
    Number.isInteger(context.claimAttempt) && context.claimAttempt >= 1 && context.claimAttempt <= 99;
}

export function marketReportShadowCallId(context: MarketReportContext, step: MarketReportStep, sequence: number): string {
  return `mr:${context.cycleId.toLowerCase()}:a${context.claimAttempt}:${step}:${sequence}`;
}

const EFFORTS: readonly AiReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

/**
 * The shadow request for one legacy Responses-API body: the same instructions, input, schema, output cap and effort,
 * sent to the shadow model as the system market report. Rejected (nothing sent) when the body is not the shape the
 * report builds. The legacy model id in the body is ignored on purpose: the caller names the shadow model.
 */
export function shadowRequestFromResponsesBody(
  step: MarketReportStep,
  body: Record<string, unknown>,
  options: { readonly callId: string; readonly timeoutMs: number; readonly model: string },
): { readonly ok: true; readonly request: AiRequest } | { readonly ok: false; readonly code: string } {
  const text = body.text as { format?: { type?: unknown; name?: unknown; schema?: unknown } } | undefined;
  const format = text?.format;
  const reasoning = body.reasoning as { effort?: unknown } | undefined;
  if (typeof body.instructions !== "string" || body.instructions === "") return { ok: false, code: "BODY_INSTRUCTIONS" };
  if (typeof body.input !== "string" || body.input === "") return { ok: false, code: "BODY_INPUT" };
  if (!format || format.type !== "json_schema" || typeof format.name !== "string" || typeof format.schema !== "object" || format.schema === null) {
    return { ok: false, code: "BODY_SCHEMA" };
  }
  if (!Number.isInteger(body.max_output_tokens) || (body.max_output_tokens as number) < 1) return { ok: false, code: "BODY_MAX_OUTPUT" };
  const effort = reasoning?.effort;
  if (typeof effort !== "string" || !EFFORTS.includes(effort as AiReasoningEffort)) return { ok: false, code: "BODY_EFFORT" };
  return {
    ok: true,
    request: {
      logicalRole: `kabumori.market_report.${step}.shadow`,
      provider: SHADOW_PROVIDER,
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

/** Content-free shape comparison: key names of the schema, array lengths, string lengths, key counts. Never text. */
export type FieldShape = { readonly kind: "string" | "array" | "object" | "number" | "boolean" | "null" | "absent"; readonly size: number | null };
export type StructureComparison = {
  readonly sameTopLevelKeys: boolean;
  readonly missingInShadow: readonly string[];
  readonly extraInShadow: readonly string[];
  readonly fields: Readonly<Record<string, { readonly legacy: FieldShape; readonly shadow: FieldShape }>>;
};

function shape(value: unknown): FieldShape {
  if (value === undefined) return { kind: "absent", size: null };
  if (value === null) return { kind: "null", size: null };
  if (typeof value === "string") return { kind: "string", size: [...value].length };
  if (Array.isArray(value)) return { kind: "array", size: value.length };
  if (typeof value === "object") return { kind: "object", size: Object.keys(value as object).length };
  if (typeof value === "number") return { kind: "number", size: null };
  if (typeof value === "boolean") return { kind: "boolean", size: null };
  return { kind: "null", size: null };
}

const KEY = /^[A-Za-z0-9_]{1,64}$/u;

export function compareStructure(legacy: unknown, shadow: unknown): StructureComparison {
  const keysOf = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as object).filter((key) => KEY.test(key)) : [];
  const legacyKeys = keysOf(legacy);
  const shadowKeys = keysOf(shadow);
  const all = [...new Set([...legacyKeys, ...shadowKeys])].sort();
  const fields: Record<string, { legacy: FieldShape; shadow: FieldShape }> = {};
  for (const key of all) {
    fields[key] = {
      legacy: shape((legacy as Record<string, unknown> | null)?.[key]),
      shadow: shape((shadow as Record<string, unknown> | null)?.[key]),
    };
  }
  return {
    sameTopLevelKeys: legacyKeys.length === shadowKeys.length && legacyKeys.every((key) => shadowKeys.includes(key)),
    missingInShadow: legacyKeys.filter((key) => !shadowKeys.includes(key)).sort(),
    extraInShadow: shadowKeys.filter((key) => !legacyKeys.includes(key)).sort(),
    fields,
  };
}

/** What the sink receives: identifiers, counts, codes and the structural comparison. No prompt, output or key. */
export type MarketReportShadowRecord = {
  readonly step: MarketReportStep;
  readonly sequence: number;
  readonly callId: string;
  readonly model: string;
  readonly ok: boolean;
  readonly errorCode: AiErrorCode | "BAD_BODY" | "SHADOW_EXCEPTION" | null;
  readonly detail: string | null;
  readonly providerRequests: number;
  readonly actualModel: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Same figure the ledger was settled with (catalog price x usage, or the upper bound when usage is unknown). */
  readonly estimatedCostUsd: number;
  readonly costBasis: string;
  readonly latencyMs: number;
  readonly structure: StructureComparison | null;
};

export type MarketReportRequesterOptions = {
  /** The existing requester; it alone produces what the report uses. */
  readonly legacy: MarketReportRequester;
  /**
   * The model the shadow calls. Chosen by the caller (this layer never picks a model): it must be an Anthropic model
   * of the catalog, and the ledger only admits the one its policies name (Claude Opus 5.5 in Phase 2a).
   */
  readonly shadowModel: string;
  /** Reads ONE environment variable (an Edge Function: `(name) => Deno.env.get(name)`). */
  readonly readEnv: EnvReader;
  readonly context?: MarketReportContext;
  /** The budget ledger (SupabaseLedgerBudgetGuard in production). Without one the shadow stays off. */
  readonly budget: BudgetGuard | null;
  readonly sink: (record: MarketReportShadowRecord) => void;
  readonly steps?: readonly MarketReportStep[];
  readonly timeoutMs?: number;
  readonly maxShadowCalls?: number;
  /** Aborts an in-flight shadow and prevents new ones (the report's own run deadline / cancellation). */
  readonly signal?: AbortSignal;
  readonly fetch?: FetchLike;
  readonly nowMs?: () => number;
};

export type MarketReportRequesterDecision = ModeDecision & { readonly requester: MarketReportRequester };

function abortableFetch(base: FetchLike, signal: AbortSignal | undefined): FetchLike {
  if (!signal) return base;
  return (input, init) => {
    if (signal.aborted) return Promise.reject(new DOMException("shadow cancelled", "AbortError"));
    const combined = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
    return base(input, { ...init, signal: combined });
  };
}

/**
 * The requester the report should use. The mode comes from KABUMORI_MARKET_REPORT_AI_MODE; "shadow" also needs a
 * usable Anthropic key, a budget ledger and a valid report context, otherwise it is off. Off returns `legacy`
 * unchanged (the same function).
 */
export function createMarketReportRequester(options: MarketReportRequesterOptions): MarketReportRequesterDecision {
  const legacy = options.legacy;
  let raw: string | undefined;
  try {
    raw = options.readEnv(MARKET_REPORT_AI_MODE_ENV);
  } catch {
    raw = undefined;
  }
  const decision = parseMarketReportAiMode(raw);
  if (decision.mode === "off") return { ...decision, requester: legacy };
  const shadowModel = options.shadowModel;
  if (typeof shadowModel !== "string" || findModelSpec(shadowModel)?.provider !== SHADOW_PROVIDER) {
    return { mode: "off", reason: "SHADOW_MODEL_INVALID", requester: legacy };
  }
  const key = resolveProviderApiKey(SHADOW_PROVIDER, options.readEnv);
  if (!key.ok) return { mode: "off", reason: key.code, requester: legacy };
  if (!options.budget) return { mode: "off", reason: "NO_LEDGER", requester: legacy };
  if (!validContext(options.context)) return { mode: "off", reason: "BAD_CONTEXT", requester: legacy };

  const context = options.context;
  const budget = options.budget;
  const steps = options.steps ?? ["generate"];
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHADOW_TIMEOUT_MS;
  const maxShadowCalls = options.maxShadowCalls ?? DEFAULT_MAX_SHADOW_CALLS;
  const nowMs = options.nowMs ?? Date.now;
  const fetchImpl = abortableFetch(options.fetch ?? ((input, init) => fetch(input, init)), options.signal);
  const sequences: Record<MarketReportStep, number> = { generate: 0, fact: 0 };
  let shadowCalls = 0;

  const emit = (record: MarketReportShadowRecord) => {
    try {
      options.sink(record);
    } catch {
      // A sink failure never reaches the report.
    }
  };

  const runShadow = async (step: MarketReportStep, body: Record<string, unknown>, legacyPayload: unknown) => {
    sequences[step] += 1;
    const sequence = sequences[step];
    const callId = marketReportShadowCallId(context, step, sequence);
    const base = { step, sequence, callId, model: shadowModel };
    const translated = shadowRequestFromResponsesBody(step, body, { callId, timeoutMs, model: shadowModel });
    if (!translated.ok) {
      emit({ ...base, ok: false, errorCode: "BAD_BODY", detail: translated.code, providerRequests: 0, actualModel: null,
        inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, costBasis: "no_request", latencyMs: 0, structure: null });
      return;
    }
    const start = nowMs();
    try {
      const result = await executeAiRequest(translated.request, {
        readEnv: options.readEnv,
        budget,
        fetch: fetchImpl,
        nowMs,
        deadlineAtMs: start + timeoutMs,
      });
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
        structure: result.ok ? compareStructure(legacyPayload, result.parsedPayload) : null,
      });
    } catch {
      emit({ ...base, ok: false, errorCode: "SHADOW_EXCEPTION", detail: null, providerRequests: 0, actualModel: null,
        inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, costBasis: "unknown", latencyMs: Math.max(0, nowMs() - start), structure: null });
    }
  };

  const requester: MarketReportRequester = async (step, body) => {
    const result = await legacy(step, body);
    if (steps.includes(step) && shadowCalls < maxShadowCalls && !options.signal?.aborted) {
      shadowCalls += 1;
      await runShadow(step, body, result.payload);
    }
    return result;
  };
  return { mode: "shadow", reason: "SHADOW", requester };
}

/**
 * The production budget ledger from an Edge Function's environment: SUPABASE_URL and the new-format secret key
 * SUPABASE_SECRET_KEYS["default"] (the pattern the report already uses). Null when either is missing or unusable,
 * which keeps the shadow off.
 */
export function ledgerGuardFromEdgeEnv(readEnv: EnvReader, fetchImpl?: FetchLike): SupabaseLedgerBudgetGuard | null {
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
