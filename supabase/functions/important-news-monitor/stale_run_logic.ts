export const IMPORTANT_NEWS_STALE_RUN_THRESHOLD_MS = 15 * 60 * 1000;
export const IMPORTANT_NEWS_STALE_RUN_ERROR = "NEWS_MONITOR_STALE_RUNTIME_TERMINATION";
export const IMPORTANT_NEWS_STALE_RUN_RECONCILIATION_FAILED =
  "NEWS_MONITOR_STALE_RUN_RECONCILIATION_FAILED";

export type StaleRunReconciliationResult = {
  reconciledCount: number;
  error: string | null;
};

export async function reconcileStaleImportantNewsRuns(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  referenceTime?: Date;
  fetcher?: typeof fetch;
}): Promise<number> {
  const referenceTime = args.referenceTime ?? new Date();
  if (!Number.isFinite(referenceTime.getTime())) throw new Error("NEWS_MONITOR_REFERENCE_TIME_INVALID");
  const cutoff = new Date(referenceTime.getTime() - IMPORTANT_NEWS_STALE_RUN_THRESHOLD_MS).toISOString();
  const params = new URLSearchParams({
    status: "eq.running",
    started_at: `lte.${cutoff}`,
    select: "id",
  });
  const result = await (args.fetcher ?? fetch)(
    `${args.supabaseUrl}/rest/v1/important_news_monitor_runs?${params}`,
    {
      method: "PATCH",
      headers: {
        apikey: args.serviceRoleKey,
        Authorization: `Bearer ${args.serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        status: "failed",
        error: IMPORTANT_NEWS_STALE_RUN_ERROR,
        completed_at: referenceTime.toISOString(),
      }),
    },
  );
  if (!result.ok) throw new Error(IMPORTANT_NEWS_STALE_RUN_RECONCILIATION_FAILED);
  const rows = await result.json();
  if (!Array.isArray(rows)) throw new Error(IMPORTANT_NEWS_STALE_RUN_RECONCILIATION_FAILED);
  return rows.length;
}

export async function runAfterBestEffortStaleRunReconciliation<T>(
  reconcile: () => Promise<number>,
  operation: () => Promise<T>,
): Promise<{ value: T; reconciliation: StaleRunReconciliationResult }> {
  let reconciliation: StaleRunReconciliationResult;
  try {
    reconciliation = { reconciledCount: await reconcile(), error: null };
  } catch {
    reconciliation = {
      reconciledCount: 0,
      error: IMPORTANT_NEWS_STALE_RUN_RECONCILIATION_FAILED,
    };
  }
  return { value: await operation(), reconciliation };
}
