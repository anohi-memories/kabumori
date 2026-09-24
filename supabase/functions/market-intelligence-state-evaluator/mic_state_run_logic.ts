// Claim/complete/fail for mic_state_evaluation_runs. Identical mechanism
// to market-intelligence-ingest's mic_ingestion_run_logic.ts: a plain
// INSERT that either succeeds or hits a unique-violation (409) on the
// partial index covering ('running','no_change','evaluated') -- a
// 'failed' row never blocks a later retry of the same
// (domain, run_window). attempt_no is audit-only, computed from a prior
// read; the actual exclusivity guarantee is the DB constraint, not this
// number being race-free.
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

export function computeRunWindow(domain: string, now: Date = new Date()): string {
  const bucket = now.toISOString().slice(0, 13);
  return `${domain}:${bucket}`;
}

export type ClaimStateEvaluationRunParams = { domain: string; runWindow: string };
export type ClaimStateEvaluationRunResult = { claimed: boolean; runId: string | null; attemptNo: number | null };

async function nextAttemptNo(
  ctx: RestContext,
  params: ClaimStateEvaluationRunParams,
  fetchImpl: typeof fetch,
): Promise<number> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_state_evaluation_runs` +
      `?domain=eq.${encodeURIComponent(params.domain)}&run_window=eq.${encodeURIComponent(params.runWindow)}` +
      `&select=attempt_no&order=attempt_no.desc&limit=1`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) {
    throw new Error(`STATE_RUN_ATTEMPT_LOOKUP_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<{ attempt_no?: unknown }>;
  const previous = typeof rows[0]?.attempt_no === "number" ? rows[0].attempt_no : 0;
  return previous + 1;
}

export async function claimStateEvaluationRun(
  ctx: RestContext,
  params: ClaimStateEvaluationRunParams,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaimStateEvaluationRunResult> {
  const attemptNo = await nextAttemptNo(ctx, params, fetchImpl);

  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/mic_state_evaluation_runs`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey, "return=representation"),
    body: JSON.stringify({
      domain: params.domain,
      run_window: params.runWindow,
      attempt_no: attemptNo,
      status: "running",
    }),
  });

  if (result.status === 409) {
    return { claimed: false, runId: null, attemptNo: null };
  }
  if (!result.ok) {
    throw new Error(`STATE_RUN_CLAIM_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<{ id?: unknown }>;
  const id = rows[0]?.id;
  if (typeof id !== "string") {
    throw new Error("STATE_RUN_CLAIM_RESPONSE_MISSING_ID");
  }
  return { claimed: true, runId: id, attemptNo };
}

// Successful completion ('no_change' / 'evaluated') happens only inside the
// State write RPCs (mic_state_writer_logic.ts), in the same transaction as
// the State change. This module only ever moves a still-'running' run to
// 'failed'; the status=eq.running filter (and a DB trigger) keeps it from
// overwriting a terminal status.
export async function failStateEvaluationRun(
  ctx: RestContext,
  runId: string,
  reason: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_state_evaluation_runs?id=eq.${encodeURIComponent(runId)}&status=eq.running`,
    {
      method: "PATCH",
      headers: restHeaders(ctx.secretKey, "return=minimal"),
      body: JSON.stringify({
        status: "failed",
        error: reason.slice(0, 2000),
        completed_at: new Date().toISOString(),
      }),
    },
  ).catch(() => undefined);
}

export type StateEvaluationRunStatus = "running" | "no_change" | "evaluated" | "failed";

// Used after an error to learn what actually committed: a State write RPC
// whose response was lost may still have marked the run terminal. Never
// throws; null means the status could not be read.
export async function fetchStateEvaluationRunStatus(
  ctx: RestContext,
  runId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StateEvaluationRunStatus | null> {
  try {
    const result = await fetchImpl(
      `${ctx.supabaseUrl}/rest/v1/mic_state_evaluation_runs?id=eq.${encodeURIComponent(runId)}&select=status`,
      { headers: restHeaders(ctx.secretKey) },
    );
    if (!result.ok) return null;
    const rows = await result.json() as Array<{ status?: unknown }>;
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const status = rows[0]?.status;
    return status === "running" || status === "no_change" || status === "evaluated" || status === "failed"
      ? status
      : null;
  } catch {
    return null;
  }
}

export const MIC_STATE_STALE_RUN_THRESHOLD_MS = 15 * 60 * 1000;

export async function reconcileStaleStateEvaluationRuns(
  ctx: RestContext,
  options: { staleThresholdMs?: number; now?: Date } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ attempted: boolean }> {
  const thresholdMs = options.staleThresholdMs ?? MIC_STATE_STALE_RUN_THRESHOLD_MS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - thresholdMs).toISOString();
  try {
    const result = await fetchImpl(
      `${ctx.supabaseUrl}/rest/v1/mic_state_evaluation_runs?status=eq.running&started_at=lt.${encodeURIComponent(cutoff)}`,
      {
        method: "PATCH",
        headers: restHeaders(ctx.secretKey, "return=minimal"),
        body: JSON.stringify({
          status: "failed",
          error: "MIC_STATE_STALE_RUN_TERMINATION",
          completed_at: now.toISOString(),
        }),
      },
    );
    if (!result.ok) return { attempted: false };
    return { attempted: true };
  } catch {
    return { attempted: false };
  }
}
