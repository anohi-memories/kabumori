// Claim/complete/fail + stale-run reconciliation for mic_ingestion_runs.
// The claim mechanism mirrors publish_claims (unique constraint IS the
// lock, via PostgREST's resolution=ignore-duplicates), and stale-run
// reconciliation mirrors important-news-monitor/stale_run_logic.ts (a
// best-effort sweep that force-completes runs stuck in 'running' past a
// threshold, run before claiming a new one, never allowed to block the new
// run if the sweep itself fails).
import { restHeaders } from "./mic_writer_logic.ts";
import type { RestContext } from "./mic_writer_logic.ts";

// Same 15-minute threshold important-news-monitor uses for its own runs
// table; there is no reason MIC ingestion (much lighter HTTP calls) should
// ever legitimately run longer than that.
export const MIC_STALE_RUN_THRESHOLD_MS = 15 * 60 * 1000;

// Buckets "now" into an hourly window per source, e.g. "fred:2026-09-12T09".
// Re-invoking the same source within the same UTC hour collides on the
// unique (source_key, run_window) constraint and is reported as
// skipped_duplicate rather than re-fetching.
export function computeRunWindow(sourceKey: string, now: Date = new Date()): string {
  const bucket = now.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  return `${sourceKey}:${bucket}`;
}

export type ClaimIngestionRunParams = {
  sourceKey: string;
  runWindow: string;
  triggerType: "manual" | "scheduled";
};

export type ClaimIngestionRunResult = { claimed: boolean; runId: string | null };

export async function claimIngestionRun(
  ctx: RestContext,
  params: ClaimIngestionRunParams,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaimIngestionRunResult> {
  const result = await fetchImpl(
    `${ctx.supabaseUrl}/rest/v1/mic_ingestion_runs?on_conflict=source_key,run_window`,
    {
      method: "POST",
      headers: restHeaders(ctx.secretKey, "return=representation,resolution=ignore-duplicates"),
      body: JSON.stringify({
        source_key: params.sourceKey,
        run_window: params.runWindow,
        trigger_type: params.triggerType,
        status: "running",
      }),
    },
  );
  if (!result.ok) {
    throw new Error(`INGESTION_RUN_CLAIM_FAILED:${result.status}:${(await result.text()).slice(0, 500)}`);
  }
  const rows = await result.json() as Array<{ id?: unknown }>;
  const id = rows[0]?.id;
  if (typeof id === "string") return { claimed: true, runId: id };
  return { claimed: false, runId: null };
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
  // picked up by the next invocation's stale-run sweep instead).
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
// runAfterBestEffortStaleRunReconciliation.
export async function reconcileStaleIngestionRuns(
  ctx: RestContext,
  options: { staleThresholdMs?: number; now?: Date } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ReconcileStaleRunsResult> {
  const thresholdMs = options.staleThresholdMs ?? MIC_STALE_RUN_THRESHOLD_MS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - thresholdMs).toISOString();
  try {
    await fetchImpl(
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
    return { attempted: true };
  } catch {
    return { attempted: false };
  }
}
