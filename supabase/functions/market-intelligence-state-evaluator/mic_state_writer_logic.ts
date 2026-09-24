// Writers for market_state_current / market_state_history / the run's
// terminal status. Each outcome is exactly one RPC, and each RPC is one
// Postgres transaction that also moves the run out of 'running' (see the
// State Evidence Phase 2C1 migration). There is no separate "complete run"
// call, so State and its run's terminal status can never disagree.
//
// - applyNoChangeUpdate: no-change / AI-skipped evaluations. Updates only
//   the deterministic status columns via an updated_at compare-and-swap and
//   marks the run 'no_change'. No history row.
// - applyMaterialChangeUpdate: a material change with a new AI narrative.
//   Writes history, current, source_evaluation_run_id, evidence (with
//   immutable event snapshots re-verified against market_events under lock)
//   and marks the run 'evaluated'.
//
// Both return 'already_applied' when the run had already reached that
// terminal state (e.g. a retry after the HTTP response was lost).
import { restHeaders } from "./mic_state_run_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";
import type { CoverageStatus, Domain, EventFact, FetchStatus, ObservationStatus } from "./mic_state_types.ts";

export type StatusRefresh = {
  asOf: string | null;
  expectedCurrentUpdatedAt: string;
  coverageStatus: CoverageStatus;
  fetchStatus: FetchStatus;
  observationStatus: ObservationStatus;
  dataConfidence: number;
};

export type StateWriteResult = { status: "applied" | "already_applied" };

async function callStateRpc(
  ctx: RestContext,
  rpcName: string,
  errorPrefix: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<StateWriteResult> {
  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/rpc/${rpcName}`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey, "return=representation"),
    body: JSON.stringify(body),
  });
  if (!result.ok) {
    throw new Error(`${errorPrefix}_RPC_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<{ result_status?: unknown }>;
  const status = Array.isArray(rows) && rows.length === 1 ? rows[0]?.result_status : undefined;
  if (status !== "applied" && status !== "already_applied") {
    throw new Error(`${errorPrefix}_RPC_RESPONSE_INVALID:${JSON.stringify(rows).slice(0, 500)}`);
  }
  return { status };
}

export type RunCompletion = {
  runId: string;
  decisionDetail: Record<string, unknown>;
};

export function applyNoChangeUpdate(
  ctx: RestContext,
  domain: Domain,
  refresh: StatusRefresh,
  completion: RunCompletion,
  fetchImpl: typeof fetch = fetch,
): Promise<StateWriteResult> {
  return callStateRpc(ctx, "apply_mic_state_no_change_update", "STATE_NO_CHANGE_UPDATE", {
    p_domain: domain,
    p_run_id: completion.runId,
    p_expected_current_updated_at: refresh.expectedCurrentUpdatedAt,
    p_as_of: refresh.asOf,
    p_coverage_status: refresh.coverageStatus,
    p_fetch_status: refresh.fetchStatus,
    p_observation_status: refresh.observationStatus,
    p_data_confidence: refresh.dataConfidence,
    p_decision_detail: completion.decisionDetail,
  }, fetchImpl);
}

export type MaterialChangeUpdate = StatusRefresh & {
  narrative: string;
  bullishFactors: unknown[];
  bearishFactors: unknown[];
  keyRisks: unknown[];
  numericBaselineSnapshot: Record<string, { value: number; observedDate: string | null; observedAt: string | null }>;
  sourceMetricKeys: string[];
  sourceEventIds: string[];
  aiModel: string;
  aiConfidence: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  aiCostUsd: number;
};

// Exactly the event fields the evaluator uses for material judgment and the
// AI facts payload, plus id/updated_at. The RPC re-reads market_events under
// lock and fails closed if any of these differ.
export type MarketEventSnapshot = {
  id: string;
  title: string;
  summary: string;
  importance: EventFact["importance"];
  event_type: string;
  published_at: string;
  updated_at: string | null;
};

export function toMarketEventSnapshot(event: EventFact): MarketEventSnapshot {
  return {
    id: event.id,
    title: event.title,
    summary: event.summary,
    importance: event.importance,
    event_type: event.eventType,
    published_at: event.publishedAt,
    updated_at: event.updatedAt,
  };
}

export type MaterialChangeEvidence = {
  marketEventSnapshots: MarketEventSnapshot[];
  fedStatementDiffIds: string[];
};

export type MaterialRunCompletion = RunCompletion & { aiUsageEventId: number };

export function applyMaterialChangeUpdate(
  ctx: RestContext,
  domain: Domain,
  update: MaterialChangeUpdate,
  reason: string,
  evidence: MaterialChangeEvidence,
  completion: MaterialRunCompletion,
  fetchImpl: typeof fetch = fetch,
): Promise<StateWriteResult> {
  return callStateRpc(ctx, "apply_mic_state_material_update", "STATE_MATERIAL_UPDATE", {
    p_domain: domain,
    p_run_id: completion.runId,
    p_expected_current_updated_at: update.expectedCurrentUpdatedAt,
    p_as_of: update.asOf,
    p_coverage_status: update.coverageStatus,
    p_fetch_status: update.fetchStatus,
    p_observation_status: update.observationStatus,
    p_data_confidence: update.dataConfidence,
    p_narrative: update.narrative,
    p_bullish_factors: update.bullishFactors,
    p_bearish_factors: update.bearishFactors,
    p_key_risks: update.keyRisks,
    p_numeric_baseline_snapshot: update.numericBaselineSnapshot,
    p_source_metric_keys: update.sourceMetricKeys,
    p_source_event_ids: update.sourceEventIds,
    p_ai_model: update.aiModel,
    p_ai_confidence: update.aiConfidence,
    p_ai_input_tokens: update.aiInputTokens,
    p_ai_output_tokens: update.aiOutputTokens,
    p_ai_cost_usd: update.aiCostUsd,
    p_reason: reason,
    p_decision_detail: completion.decisionDetail,
    p_ai_usage_event_id: completion.aiUsageEventId,
    p_market_event_snapshots: evidence.marketEventSnapshots,
    p_fed_statement_diff_evidence_ids: evidence.fedStatementDiffIds,
  }, fetchImpl);
}
