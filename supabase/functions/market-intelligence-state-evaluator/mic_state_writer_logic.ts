// Writers for market_state_current / market_state_history.
//
// Two distinct update shapes, matching the design doc's flow (section 5):
// - refreshStatusOnly: runs on no-change / AI-skipped evaluations. Updates
//   only the deterministic status/confidence columns (coverage_status,
//   fetch_status, observation_status, data_confidence, as_of) -- never
//   narrative/bullish/bearish/numeric_baseline_snapshot/ai_*. No
//   market_state_history row is written for this (routine status ticks
//   are not the kind of interpretive change history exists to audit).
//   An updated_at compare-and-swap prevents a stale decision from
//   overwriting a newer run's status or as_of.
// - applyMaterialChangeUpdate: only called when Step 2 (material_change)
//   is true and AI has produced a new narrative. State Evidence Phase 2C1:
//   this is now a single call to the apply_mic_state_material_update RPC
//   (see the migration for the full transactional definition) instead of
//   a GET-then-PATCH-then-POST sequence of 3 separate REST calls. The RPC
//   updates market_state_current, inserts the market_state_history
//   snapshot, sets source_evaluation_run_id, and writes every
//   mic_state_evidence row in ONE Postgres transaction -- a failure
//   partway through (e.g. an evidence FK violation) rolls back the
//   current/history writes too, which the previous 3-call sequence could
//   never guarantee.
import { restHeaders } from "./mic_state_run_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";
import type { CoverageStatus, Domain, FetchStatus, ObservationStatus } from "./mic_state_types.ts";

export type StatusRefresh = {
  asOf: string | null;
  expectedCurrentUpdatedAt: string;
  coverageStatus: CoverageStatus;
  fetchStatus: FetchStatus;
  observationStatus: ObservationStatus;
  dataConfidence: number;
};

export async function refreshStatusOnly(
  ctx: RestContext,
  domain: Domain,
  refresh: StatusRefresh,
  fetchImpl: typeof fetch = fetch,
): Promise<"updated" | "stale"> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/market_state_current?domain=eq.${encodeURIComponent(domain)}` +
      `&updated_at=eq.${encodeURIComponent(refresh.expectedCurrentUpdatedAt)}&select=domain`,
    {
      method: "PATCH",
      headers: restHeaders(ctx.secretKey, "return=representation"),
      body: JSON.stringify({
        as_of: refresh.asOf,
        coverage_status: refresh.coverageStatus,
        fetch_status: refresh.fetchStatus,
        observation_status: refresh.observationStatus,
        data_confidence: refresh.dataConfidence,
      }),
    },
  );
  if (!result.ok) {
    throw new Error(`STATE_STATUS_REFRESH_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as unknown;
  if (!Array.isArray(rows) || rows.length > 1) throw new Error("STATE_STATUS_REFRESH_RESPONSE_INVALID");
  return rows.length === 1 ? "updated" : "stale";
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

// State Evidence Phase 2C1: the evaluation run this update belongs to
// (becomes market_state_current.source_evaluation_run_id), plus the
// already-resolved (never guessed) list of immutable artifacts this run
// actually used. marketEventIds is normally the same set as
// update.sourceEventIds -- kept as a separate field here rather than
// derived internally so this module never has to re-decide "which events
// count as evidence"; that decision is made once, by the caller, from
// decision.recentEvents.
export type MaterialChangeEvidence = {
  runId: string;
  marketEventIds: string[];
  fedStatementDiffIds: string[];
};

export type ApplyMaterialChangeResult = { status: "applied" | "already_applied" };

// Single atomic call to the apply_mic_state_material_update RPC (see the
// State Evidence Phase 2C1 migration): updates market_state_current,
// inserts the pre-update market_state_history snapshot, sets
// source_evaluation_run_id, and writes every mic_state_evidence row, all
// in one Postgres transaction. A failure anywhere inside the RPC (e.g. an
// evidence FK violation) rolls back the current/history writes too --
// this is exactly the "State updated but evidence missing" inconsistency
// the previous 3-separate-REST-call design could not prevent.
export async function applyMaterialChangeUpdate(
  ctx: RestContext,
  domain: Domain,
  update: MaterialChangeUpdate,
  reason: string,
  evidence: MaterialChangeEvidence,
  fetchImpl: typeof fetch = fetch,
): Promise<ApplyMaterialChangeResult> {
  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/rpc/apply_mic_state_material_update`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey, "return=representation"),
    body: JSON.stringify({
      p_domain: domain,
      p_run_id: evidence.runId,
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
      p_market_event_evidence_ids: evidence.marketEventIds,
      p_fed_statement_diff_evidence_ids: evidence.fedStatementDiffIds,
    }),
  });
  if (!result.ok) {
    throw new Error(`STATE_MATERIAL_UPDATE_RPC_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<{ result_status?: unknown }>;
  const status = rows[0]?.result_status;
  if (status !== "applied" && status !== "already_applied") {
    throw new Error(`STATE_MATERIAL_UPDATE_RPC_RESPONSE_INVALID:${JSON.stringify(rows).slice(0, 500)}`);
  }
  return { status };
}
