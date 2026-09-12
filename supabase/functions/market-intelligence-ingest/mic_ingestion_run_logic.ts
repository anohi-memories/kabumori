// Claim/complete/fail + stale-run reconciliation for mic_ingestion_runs.
//
// Claim mechanism (per Phase 1A review): a single table-wide
// unique(source_key, run_window) would make a window permanently stuck
// once its one allowed row becomes 'failed' -- nothing could ever retry
// it. Instead, the DB enforces exclusivity only among 'running'/'completed'
// rows (a partial unique index -- see the migration), so claimIngestionRun
// does a plain INSERT and treats a unique-violation (409) as "not claimed"
// rather than using on_conflict/ignore-duplicates, exactly mirroring how
// mic_writer_logic.ts's writeMarketEvent handles a content_hash conflict.
// A 'failed' row never blocks a later attempt for the same window.
//
// Stale-run reconciliation mirrors
// important-news-monitor/stale_run_logic.ts (a best-effort sweep that
// force-completes runs stuck in 'running' past a threshold, run before
// claiming a new one, never allowed to block the new run if the sweep
// itself fails) -- and per Phase 1A review, "failed" here means any
// non-2xx response too, not only a thrown/rejected fetch.
import { restHeaders } from "./mic_writer_logic.ts";
import type { RestContext } from "./mic_writer_logic.ts";

// Same 15-minute threshold important-news-monitor uses for its own runs
// table; there is no reason MIC ingestion (much lighter HTTP calls) should
// ever legitimately run longer than that.
export const MIC_STALE_RUN_THRESHOLD_MS = 15 * 60 * 1000;

// Buckets "now" into an hourly window per source, e.g. "fred:2026-09-12T09".
// Re-invoking the same source within the same UTC hour collides on the
// active-claim index and is reported as skipped_duplicate rather than
// re-fetching, unless the prior attempt for that window already failed.
export function computeRunWindow(sourceKey: string, now: Date = new Date()): string {
  const bucket = now.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  return `${sourceKey}:${bucket}`;
}

export type ClaimIngestionRunParams = {
  sourceKey: string;
  runWindow: string;
  triggerType: "manual" | "scheduled";
};

export type ClaimIngestionRunResult = { claimed: boolean; runId: string | null; attemptNo: number | null };

// attempt_no is audit metadata, not a lock -- it is read here (best-effort,
// "one more than the highest attempt_no seen so far for this window") and
// is not itself required to be race-free: the actual exclusivity guarantee
// comes entirely from the partial unique index on (source_key, run_window)
// WHERE status in ('running','completed'), enforced by the INSERT below.
// If two callers happen to compute the same attempt_no concurrently, at
// most one of their INSERTs can ever succeed; the loser's INSERT is
// rejected outright (never persisted), so no duplicate attempt_no row is
// ever actually stored.
async function nextAttemptNo(ctx: RestContext, params: ClaimIngestionRunParams, fetchImpl: typeof fetch): Promise<number> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_ingestion_runs` +
      `?source_key=eq.${encodeURIComponent(params.sourceKey)}&run_window=eq.${encodeURIComponent(params.runWindow)}` +
      `&select=attempt_no&order=attempt_no.desc&limit=1`,
    { headers: restHeaders(ctx.secretKey) },
  );
  if (!result.ok) {
    throw new Error(`INGESTION_RUN_ATTEMPT_LOOKUP_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<{ attempt_no?: unknown }>;
  const previous = typeof rows[0]?.attempt_no === "number" ? rows[0].attempt_no : 0;
  return previous + 1;
}

export async function claimIngestionRun(
  ctx: RestContext,
  params: ClaimIngestionRunParams,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaimIngestionRunResult> {
  const attemptNo = await nextAttemptNo(ctx, params, fetchImpl);

  const result = await fetchImpl(`${ctx.supabaseUrl}/rest/v1/mic_ingestion_runs`, {
    method: "POST",
    headers: restHeaders(ctx.secretKey, "return=representation"),
    body: JSON.stringify({
      source_key: params.sourceKey,
      run_window: params.runWindow,
      attempt_no: attemptNo,
      trigger_type: params.triggerType,
      status: "running",
    }),
  });

  if (result.status === 409) {
    // Another row already holds the active-claim slot for this window
    // (running or completed) -- not an error, just "not claimed".
    return { claimed: false, runId: null, attemptNo: null };
  }
  if (!result.ok) {
    throw new Error(`INGESTION_RUN_CLAIM_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<{ id?: unknown }>;
  const id = rows[0]?.id;
  if (typeof id !== "string") {
    throw new Error("INGESTION_RUN_CLAIM_RESPONSE_MISSING_ID");
  }
  return { claimed: true, runId: id, attemptNo };
}

export type CompleteIngestionRunCounts = {
  fetchedCount: number;
  newCount: number;
  duplicateCount: number;
};

export async function completeIngestionRun(
  ctx: RestContext,
  runId: string,
  counts: CompleteIngestionRunCounts,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_ingestion_runs?id=eq.${encodeURIComponent(runId)}&status=eq.running`,
    {
      method: "PATCH",
      headers: restHeaders(ctx.secretKey, "return=minimal"),
      body: JSON.stringify({
        status: "completed",
        fetched_count: counts.fetchedCount,
        new_count: counts.newCount,
        duplicate_count: counts.duplicateCount,
        completed_at: new Date().toISOString(),
      }),
    },
  );
  if (!result.ok) {
    throw new Error(`INGESTION_RUN_COMPLETE_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
}

export async function failIngestionRun(
  ctx: RestContext,
  runId: string,
  reason: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // Best-effort, mirrors stocks-master-sync's failRun: if this PATCH itself
  // fails there is nothing further to do (the run row is left 'running' and
  // picked up by the next invocation's stale-run sweep instead). Marking it
  // 'failed' here is also what makes the window retryable (see the partial
  // unique index) -- a stuck 'running' row still blocks a new claim until
  // reconcileStaleIngestionRuns (or this PATCH) flips it.
  await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_ingestion_runs?id=eq.${encodeURIComponent(runId)}&status=eq.running`,
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

export type ReconcileStaleRunsResult = { attempted: boolean };

// Force-completes any run still 'running' older than the threshold. This
// never throws -- a failure here must never block a new run from starting,
// exactly like important-news-monitor's
// runAfterBestEffortStaleRunReconciliation. Per Phase 1A review: a resolved
// fetch with a non-2xx status (e.g. PostgREST rejecting the PATCH) is also
// treated as not-attempted, not just a thrown/rejected fetch -- the caller
// must be able to tell "the sweep actually ran" from "fetch resolved but
// nothing was reconciled".
export async function reconcileStaleIngestionRuns(
  ctx: RestContext,
  options: { staleThresholdMs?: number; now?: Date } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ReconcileStaleRunsResult> {
  const thresholdMs = options.staleThresholdMs ?? MIC_STALE_RUN_THRESHOLD_MS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - thresholdMs).toISOString();
  try {
    const result = await fetchImpl(
      `${ctx.supabaseUrl}/rest/v1/mic_ingestion_runs?status=eq.running&started_at=lt.${encodeURIComponent(cutoff)}`,
      {
        method: "PATCH",
        headers: restHeaders(ctx.secretKey, "return=minimal"),
        body: JSON.stringify({
          status: "failed",
          error: "MIC_STALE_RUN_TERMINATION",
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
