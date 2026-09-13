// Writers for market_state_current / market_state_history.
//
// Two distinct update shapes, matching the design doc's flow (section 5):
// - refreshStatusOnly: runs on every evaluation, change or not. Updates
//   only the deterministic status/confidence columns (coverage_status,
//   fetch_status, observation_status, data_confidence, as_of) -- never
//   narrative/bullish/bearish/numeric_baseline_snapshot/ai_*. No
//   market_state_history row is written for this (routine status ticks
//   are not the kind of interpretive change history exists to audit).
// - applyMaterialChangeUpdate: only called when Step 2 (material_change)
//   is true and AI has produced a new narrative. Updates the full row
//   AND inserts a market_state_history snapshot of what the row looked
//   like immediately before this update (never overwritten).
import { restHeaders } from "./mic_state_run_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";
import type { CoverageStatus, Domain, FetchStatus, ObservationStatus } from "./mic_state_types.ts";

export type StatusRefresh = {
  asOf: string | null;
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
): Promise<void> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/market_state_current?domain=eq.${encodeURIComponent(domain)}`,
    {
      method: "PATCH",
      headers: restHeaders(ctx.secretKey, "return=minimal"),
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

// Fetches the row as it stands *before* the update (for the history
// snapshot), then PATCHes the new interpretation in, then inserts the
// pre-update snapshot into market_state_history. Never deletes/overwrites
// history -- each call appends exactly one row.
export async function applyMaterialChangeUpdate(
  ctx: RestContext,
  domain: Domain,
  update: MaterialChangeUpdate,
  reason: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const before = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/market_state_current?domain=eq.${encodeURIComponent(domain)}&select=*`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!before.ok) {
    throw new Error(`STATE_PRE_UPDATE_FETCH_FAILED:${before.status}:${(await before.text()).slice(0, 500)}`);
  }
  const beforeRows = await before.json() as Array<Record<string, unknown>>;
  const previousSnapshot = beforeRows[0] ?? { domain };

  const patchResult = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/market_state_current?domain=eq.${encodeURIComponent(domain)}`,
    {
      method: "PATCH",
      headers: restHeaders(ctx.secretKey, "return=minimal"),
      body: JSON.stringify({
        as_of: update.asOf,
        narrative: update.narrative,
        bullish_factors: update.bullishFactors,
        bearish_factors: update.bearishFactors,
        key_risks: update.keyRisks,
        numeric_baseline_snapshot: update.numericBaselineSnapshot,
        source_metric_keys: update.sourceMetricKeys,
        source_event_ids: update.sourceEventIds,
        ai_model: update.aiModel,
        ai_confidence: update.aiConfidence,
        ai_input_tokens: update.aiInputTokens,
        ai_output_tokens: update.aiOutputTokens,
        ai_cost_usd: update.aiCostUsd,
        ai_evaluated_at: new Date().toISOString(),
        coverage_status: update.coverageStatus,
        fetch_status: update.fetchStatus,
        observation_status: update.observationStatus,
        data_confidence: update.dataConfidence,
      }),
    },
  );
  if (!patchResult.ok) {
    throw new Error(`STATE_MATERIAL_UPDATE_FAILED:${patchResult.status}:${(await patchResult.text()).slice(0, 500)}`);
  }

  const historyResult = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/market_state_history`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey, "return=minimal"),
    body: JSON.stringify({
      domain,
      as_of: (previousSnapshot as Record<string, unknown>).as_of ?? null,
      snapshot: previousSnapshot,
      triggered_by: "material_change",
      reason,
    }),
  });
  if (!historyResult.ok) {
    throw new Error(`STATE_HISTORY_INSERT_FAILED:${historyResult.status}:${(await historyResult.text()).slice(0, 500)}`);
  }
}
