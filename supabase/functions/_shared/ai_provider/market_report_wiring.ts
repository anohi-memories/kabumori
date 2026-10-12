// Phase 2b (offline, NOT wired): how the shared market report would attach the Phase 2a shadow without delaying or
// risking its delivery. Contract and runbook: docs/ai-provider/PHASE2B_MARKET_REPORT_WIRING_PLAN.md.
//
// prepareMarketReportShadow(...) -> { mode, reason, requester, flush }
//   off (default; any unset, unknown or incomplete setting): `requester` is the legacy requester ITSELF and `flush`
//     does nothing. Only KABUMORI_MARKET_REPORT_AI_MODE is read.
//   shadow (deferred): `requester` returns the legacy results unchanged and only REMEMBERS each successful generate
//     step (its request body and the legacy payload) in memory; it sends nothing. After the report has been delivered
//     (complete_market_report_analysis succeeded), the handler calls flush({ deadlineAtMs }). flush sends the
//     remembered generation(s) - by default only the last one - through the Phase 2a adapter (budget ledger, one
//     transport attempt, no retry, no fallback), with a timeout clipped to the time left before the deadline, and
//     sends nothing when too little time is left.
//
// Why deferred and not inline: an Edge Function on the Free plan stops after 150 s of wall clock and must answer
// within 150 s, and the report already makes up to four sequential OpenAI calls. A Claude call inserted after each
// generation (Phase 2a's inline use) could push the delivery itself past those limits. Deferred, the shadow can only
// spend time that is left after the report is safe.

import type { FetchLike } from "./adapter.ts";
import {
  createMarketReportRequester,
  DEFAULT_SHADOW_TIMEOUT_MS,
  ledgerGuardFromEdgeEnv,
  MARKET_REPORT_AI_MODE_ENV,
  type MarketReportRequester,
  type MarketReportShadowRecord,
  type MarketReportStepResult,
  parseMarketReportAiMode,
} from "./market_report_shadow.ts";
import type { EnvReader } from "./secrets.ts";

/** The shadow model, chosen by configuration (this layer never names a model); it must be an Anthropic catalog model. */
export const MARKET_REPORT_SHADOW_MODEL_ENV = "KABUMORI_MARKET_REPORT_SHADOW_MODEL";
/** Kept free before the deadline for the handler's own wrap-up. */
export const SHADOW_DEADLINE_MARGIN_MS = 10_000;
/** A shadow with less time than this is not sent (a timeout would still be charged at its upper bound). */
export const MIN_SHADOW_WINDOW_MS = 20_000;

/** "last": only the generation the report ended with (one call per report); "all": every remembered generation. */
export type ShadowSelection = "last" | "all";

/** The claim row fields the handler already has (claim_market_report_analysis). */
export type MarketReportClaim = { readonly cycle_id: string | null; readonly attempt: number };

export type FlushSummary = {
  /** Shadow requests started (each is one ledger reservation; the outcome is in the sink's records). */
  readonly attempted: number;
  /** Remembered generations not sent (no time left, cancelled, or beyond the selection). */
  readonly skipped: number;
  /** null when everything selected was attempted; otherwise why not. */
  readonly reason: "OFF" | "ALREADY_FLUSHED" | "NOTHING_CAPTURED" | "NO_TIME" | "CANCELLED" | null;
};

export type PreparedMarketReportShadow = {
  readonly mode: "off" | "shadow";
  readonly reason: string;
  readonly requester: MarketReportRequester;
  flush(options: { readonly deadlineAtMs: number; readonly signal?: AbortSignal }): Promise<FlushSummary>;
};

export type PrepareOptions = {
  readonly legacy: MarketReportRequester;
  readonly readEnv: EnvReader;
  readonly claim: MarketReportClaim | null;
  readonly sink: (record: MarketReportShadowRecord) => void;
  readonly selection?: ShadowSelection;
  /** Upper bound for "all" (the report makes at most two generations). */
  readonly maxShadowCalls?: number;
  readonly fetch?: FetchLike;
  readonly nowMs?: () => number;
  /** Defaults SHADOW_DEADLINE_MARGIN_MS / MIN_SHADOW_WINDOW_MS; smaller values only make sense in tests. */
  readonly timing?: { readonly marginMs?: number; readonly minWindowMs?: number };
};

type Captured = { readonly body: Record<string, unknown>; readonly result: MarketReportStepResult };

function readOne(readEnv: EnvReader, name: string): string | undefined {
  try {
    return readEnv(name);
  } catch {
    return undefined;
  }
}

export function prepareMarketReportShadow(options: PrepareOptions): PreparedMarketReportShadow {
  const legacy = options.legacy;
  const decision = parseMarketReportAiMode(readOne(options.readEnv, MARKET_REPORT_AI_MODE_ENV));
  const off = (reason: string): PreparedMarketReportShadow => ({
    mode: "off",
    reason,
    requester: legacy,
    flush: () => Promise.resolve({ attempted: 0, skipped: 0, reason: "OFF" }),
  });
  if (decision.mode === "off") return off(decision.reason);

  const shadowModel = readOne(options.readEnv, MARKET_REPORT_SHADOW_MODEL_ENV) ?? "";
  const budget = ledgerGuardFromEdgeEnv(options.readEnv, options.fetch);
  const context = options.claim && typeof options.claim.cycle_id === "string"
    ? { cycleId: options.claim.cycle_id, claimAttempt: options.claim.attempt }
    : undefined;
  const nowMs = options.nowMs ?? Date.now;
  const selection = options.selection ?? "last";
  const maxShadowCalls = options.maxShadowCalls ?? 2;
  const marginMs = options.timing?.marginMs ?? SHADOW_DEADLINE_MARGIN_MS;
  const minWindowMs = options.timing?.minWindowMs ?? MIN_SHADOW_WINDOW_MS;

  // The adapter alone decides whether the shadow may run (mode, key, ledger, context, model); its decision is final.
  const probe = createMarketReportRequester({
    legacy, shadowModel, readEnv: options.readEnv, context, budget, sink: options.sink, fetch: options.fetch, nowMs,
  });
  if (probe.mode === "off") return off(probe.reason);

  const captured: Captured[] = [];
  let flushed = false;

  const requester: MarketReportRequester = async (step, body) => {
    const result = await legacy(step, body);
    if (step === "generate") captured.push({ body, result });
    return result;
  };

  const flush = async ({ deadlineAtMs, signal }: { readonly deadlineAtMs: number; readonly signal?: AbortSignal }): Promise<FlushSummary> => {
    if (flushed) return { attempted: 0, skipped: 0, reason: "ALREADY_FLUSHED" };
    flushed = true;
    if (captured.length === 0) return { attempted: 0, skipped: 0, reason: "NOTHING_CAPTURED" };
    const targets = selection === "last" ? captured.slice(-1) : captured.slice(0, maxShadowCalls);
    const beyondSelection = captured.length - targets.length;
    // The time left is checked again before each send (below); here it only sizes the per-send timeout.
    const usable = deadlineAtMs - marginMs - nowMs();

    // One adapter instance for the whole flush: its callIds count the shadow sends of this claim attempt (1, 2), so a
    // re-run of the same attempt reproduces them and the ledger refuses to pay again. Its legacy step only replays the
    // remembered result: nothing is requested from OpenAI again.
    let current: Captured | null = null;
    const replay: MarketReportRequester = () => Promise.resolve(current!.result);
    const adapter = createMarketReportRequester({
      legacy: replay,
      shadowModel,
      readEnv: options.readEnv,
      context,
      budget,
      sink: options.sink,
      steps: ["generate"],
      timeoutMs: Math.max(1_000, Math.min(DEFAULT_SHADOW_TIMEOUT_MS, Math.floor(usable / targets.length))),
      maxShadowCalls: targets.length,
      signal,
      fetch: options.fetch,
      nowMs,
    });
    if (adapter.mode === "off") return { attempted: 0, skipped: captured.length, reason: "OFF" };

    let attempted = 0;
    for (const target of targets) {
      if (signal?.aborted) return { attempted, skipped: captured.length - attempted, reason: "CANCELLED" };
      if (deadlineAtMs - marginMs - nowMs() < minWindowMs) {
        return { attempted, skipped: captured.length - attempted, reason: "NO_TIME" };
      }
      current = target;
      attempted += 1;
      try {
        await adapter.requester("generate", target.body);
      } catch {
        // The replay cannot fail and the adapter never throws; this only guards the report.
      }
    }
    return { attempted, skipped: beyondSelection, reason: null };
  };

  return { mode: "shadow", reason: "SHADOW", requester, flush };
}
