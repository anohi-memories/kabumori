// REST I/O for the Scenario evaluator. Each function takes an injectable
// fetchImpl for tests. Only these tables are touched:
//   read:  market_state_current, mic_scenario_current, mic_scenario_evaluation_runs
//   write: mic_scenario_evaluation_runs (claim / no_change / failed),
//          ai_usage_events (one row per real OpenAI call),
//          rpc/apply_mic_scenario_update (current + history + evidence + evaluated)
import { SCENARIO_DOMAINS, SCENARIO_KEY, type ScenarioCurrentRow, type StateRow } from "./mic_scenario_types.ts";

export type RestContext = { supabaseUrl: string; secretKey: string };

export function restHeaders(secretKey: string, prefer?: string): Record<string, string> {
  return {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

export function safeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : "UNEXPECTED_ERROR";
  return value.slice(0, 500);
}

export function computeScenarioRunWindow(now: Date = new Date()): string {
  return `${SCENARIO_KEY}:${now.toISOString().slice(0, 13)}`;
}

const STATE_SELECT = "domain,narrative,bullish_factors,bearish_factors,key_risks,ai_confidence,data_confidence," +
  "coverage_status,observation_status,ai_evaluated_at,source_evaluation_run_id";

export async function fetchScenarioStates(ctx: RestContext, fetchImpl: typeof fetch = fetch): Promise<StateRow[]> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/market_state_current?domain=in.(${SCENARIO_DOMAINS.join(",")})&select=${STATE_SELECT}`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) throw new Error(`SCENARIO_STATE_FETCH_FAILED:${result.status}`);
  const rows = await result.json() as unknown;
  if (!Array.isArray(rows)) throw new Error("SCENARIO_STATE_FETCH_INVALID_RESPONSE");
  return rows as StateRow[];
}

export async function fetchScenarioCurrent(ctx: RestContext, fetchImpl: typeof fetch = fetch): Promise<ScenarioCurrentRow> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_scenario_current?scenario_key=eq.${SCENARIO_KEY}` +
      `&select=updated_at,source_state_run_ids,input_fingerprint,source_scenario_run_id`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) throw new Error(`SCENARIO_CURRENT_FETCH_FAILED:${result.status}`);
  const rows = await result.json() as Array<Record<string, unknown>>;
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.updated_at !== "string") {
    throw new Error("SCENARIO_CURRENT_ROW_MISSING");
  }
  const row = rows[0];
  return {
    updatedAt: row.updated_at as string,
    sourceStateRunIds: Array.isArray(row.source_state_run_ids)
      ? row.source_state_run_ids.filter((id): id is string => typeof id === "string")
      : [],
    inputFingerprint: typeof row.input_fingerprint === "string" ? row.input_fingerprint : null,
    sourceScenarioRunId: typeof row.source_scenario_run_id === "string" ? row.source_scenario_run_id : null,
  };
}

export type ClaimResult = { claimed: true; runId: string } | { claimed: false };

// A plain INSERT; the one-running-run unique index turns a concurrent claim
// into 409, so two invocations can never both reach the AI call.
export async function claimScenarioRun(
  ctx: RestContext,
  runWindow: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaimResult> {
  const lookup = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_scenario_evaluation_runs?scenario_key=eq.${SCENARIO_KEY}` +
      `&run_window=eq.${encodeURIComponent(runWindow)}&select=attempt_no&order=attempt_no.desc&limit=1`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!lookup.ok) throw new Error(`SCENARIO_RUN_ATTEMPT_LOOKUP_FAILED:${lookup.status}`);
  const previous = await lookup.json() as Array<{ attempt_no?: unknown }>;
  const attemptNo = (typeof previous[0]?.attempt_no === "number" ? previous[0].attempt_no : 0) + 1;

  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/mic_scenario_evaluation_runs`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey, "return=representation"),
    body: JSON.stringify({ scenario_key: SCENARIO_KEY, run_window: runWindow, attempt_no: attemptNo, status: "running" }),
  });
  if (result.status === 409) return { claimed: false };
  if (!result.ok) throw new Error(`SCENARIO_RUN_CLAIM_FAILED:${result.status}`);
  const rows = await result.json() as Array<{ id?: unknown }>;
  if (typeof rows[0]?.id !== "string") throw new Error("SCENARIO_RUN_CLAIM_RESPONSE_MISSING_ID");
  return { claimed: true, runId: rows[0].id };
}

// no_change is a single status=eq.running PATCH (one statement, atomic): no
// Scenario row, history or evidence is written on this path.
export async function completeScenarioRunNoChange(
  ctx: RestContext,
  runId: string,
  decisionDetail: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_scenario_evaluation_runs?id=eq.${encodeURIComponent(runId)}&status=eq.running&select=id`,
    {
      method: "PATCH",
      headers: restHeaders(ctx.secretKey, "return=representation"),
      body: JSON.stringify({ status: "no_change", decision_detail: decisionDetail, completed_at: new Date().toISOString() }),
    },
  );
  if (!result.ok) throw new Error(`SCENARIO_RUN_NO_CHANGE_FAILED:${result.status}`);
  const rows = await result.json() as unknown[];
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("SCENARIO_RUN_NO_CHANGE_NOT_APPLIED");
}

// Only a still-running run can become failed (status filter + DB trigger).
// Never throws.
export async function failScenarioRun(
  ctx: RestContext,
  runId: string,
  reason: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_scenario_evaluation_runs?id=eq.${encodeURIComponent(runId)}&status=eq.running`,
    {
      method: "PATCH",
      headers: restHeaders(ctx.secretKey, "return=minimal"),
      body: JSON.stringify({ status: "failed", error: reason.slice(0, 2000), completed_at: new Date().toISOString() }),
    },
  ).catch(() => undefined);
}

export type ScenarioRunStatus = "running" | "no_change" | "evaluated" | "failed";

// Read back what actually committed after an error (a lost response may hide
// a committed write). Never throws; null = unreadable.
export async function fetchScenarioRunStatus(
  ctx: RestContext,
  runId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ScenarioRunStatus | null> {
  try {
    const result = await fetchImpl(
      `${ctx.supabaseUrl}/rest/v1/mic_scenario_evaluation_runs?id=eq.${encodeURIComponent(runId)}&select=status`,
      { headers: restHeaders(ctx.secretKey) },
    );
    if (!result.ok) return null;
    const rows = await result.json() as Array<{ status?: unknown }>;
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const status = rows[0]?.status;
    return status === "running" || status === "no_change" || status === "evaluated" || status === "failed" ? status : null;
  } catch {
    return null;
  }
}

export const SCENARIO_STALE_RUN_THRESHOLD_MS = 15 * 60 * 1000;

// A run left 'running' (crashed invocation) would block every later claim;
// terminate it after 15 minutes. Never throws.
export async function reconcileStaleScenarioRuns(
  ctx: RestContext,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ attempted: boolean }> {
  const cutoff = new Date(now.getTime() - SCENARIO_STALE_RUN_THRESHOLD_MS).toISOString();
  try {
    const result = await fetchImpl(
      `${ctx.supabaseUrl}/rest/v1/mic_scenario_evaluation_runs?status=eq.running&started_at=lt.${encodeURIComponent(cutoff)}`,
      {
        method: "PATCH",
        headers: restHeaders(ctx.secretKey, "return=minimal"),
        body: JSON.stringify({ status: "failed", error: "MIC_SCENARIO_STALE_RUN_TERMINATION", completed_at: now.toISOString() }),
      },
    );
    return { attempted: result.ok };
  } catch {
    return { attempted: false };
  }
}

// One ai_usage_events row per real OpenAI call, linked to the run.
export async function recordScenarioUsage(
  ctx: RestContext,
  usage: { runId: string; model: string; inputTokens: number; outputTokens: number; costUsd: number },
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/ai_usage_events`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey, "return=representation"),
    body: JSON.stringify({
      feature: "mic_scenario_evaluation",
      model: usage.model,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      web_search_calls: 0,
      cost_usd: usage.costUsd,
      related_table: "mic_scenario_evaluation_runs",
      related_id: usage.runId,
    }),
  });
  if (!result.ok) throw new Error(`SCENARIO_AI_USAGE_INSERT_FAILED:${result.status}`);
  const rows = await result.json() as Array<{ id?: unknown }>;
  if (typeof rows[0]?.id !== "number") throw new Error("SCENARIO_AI_USAGE_EVENT_ID_MISSING");
  return rows[0].id;
}

export type ApplyScenarioParams = {
  runId: string;
  expectedCurrentUpdatedAt: string;
  inputFingerprint: string;
  promptVersion: string;
  assessmentStatus: "assessed" | "indeterminate";
  baseCase: unknown;
  upsideCase: unknown;
  downsideCase: unknown;
  stateConflicts: string[];
  confidence: number;
  aiConfidence: number;
  stateSnapshots: unknown[];
  evidenceMeta: Array<{ domain: string; freshness: string; usability: string }>;
  aiModel: string;
  aiInputTokens: number;
  aiOutputTokens: number;
  aiCostUsd: number;
  decisionDetail: Record<string, unknown>;
  aiUsageEventId: number;
};

export async function applyScenarioUpdate(
  ctx: RestContext,
  params: ApplyScenarioParams,
  fetchImpl: typeof fetch = fetch,
): Promise<"applied" | "already_applied"> {
  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/rpc/apply_mic_scenario_update`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey, "return=representation"),
    body: JSON.stringify({
      p_scenario_key: SCENARIO_KEY,
      p_run_id: params.runId,
      p_expected_current_updated_at: params.expectedCurrentUpdatedAt,
      p_input_fingerprint: params.inputFingerprint,
      p_prompt_version: params.promptVersion,
      p_assessment_status: params.assessmentStatus,
      p_base_case: params.baseCase,
      p_upside_case: params.upsideCase,
      p_downside_case: params.downsideCase,
      p_state_conflicts: params.stateConflicts,
      p_confidence: params.confidence,
      p_ai_confidence: params.aiConfidence,
      p_state_snapshots: params.stateSnapshots,
      p_evidence_meta: params.evidenceMeta,
      p_ai_model: params.aiModel,
      p_ai_input_tokens: params.aiInputTokens,
      p_ai_output_tokens: params.aiOutputTokens,
      p_ai_cost_usd: params.aiCostUsd,
      p_decision_detail: params.decisionDetail,
      p_ai_usage_event_id: params.aiUsageEventId,
    }),
  });
  if (!result.ok) {
    throw new Error(`SCENARIO_UPDATE_RPC_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<{ result_status?: unknown }>;
  const status = Array.isArray(rows) && rows.length === 1 ? rows[0]?.result_status : undefined;
  if (status !== "applied" && status !== "already_applied") {
    throw new Error(`SCENARIO_UPDATE_RPC_RESPONSE_INVALID:${JSON.stringify(rows).slice(0, 300)}`);
  }
  return status;
}
