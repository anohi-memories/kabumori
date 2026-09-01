import assert from "node:assert/strict";
import test from "node:test";
import {
  IMPORTANT_NEWS_STALE_RUN_ERROR,
  IMPORTANT_NEWS_STALE_RUN_RECONCILIATION_FAILED,
  IMPORTANT_NEWS_STALE_RUN_THRESHOLD_MS,
  reconcileStaleImportantNewsRuns,
  runAfterBestEffortStaleRunReconciliation,
} from "./stale_run_logic.ts";

type Run = {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
  error: string | null;
};

const referenceTime = new Date("2026-09-01T04:00:00.000Z");

function repository(runs: Run[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    assert.equal(init?.method, "PATCH");
    assert.equal(url.searchParams.get("status"), "eq.running");
    const cutoffValue = url.searchParams.get("started_at") ?? "";
    assert.match(cutoffValue, /^lte\./);
    const cutoff = Date.parse(cutoffValue.slice(4));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const updated: Array<{ id: string }> = [];
    for (const run of runs) {
      if (run.status !== "running" || Date.parse(run.startedAt) > cutoff) continue;
      run.status = body.status as "failed";
      run.completedAt = body.completed_at as string;
      run.error = body.error as string;
      updated.push({ id: run.id });
    }
    return Response.json(updated);
  };
}

async function reconcile(runs: Run[]) {
  return await reconcileStaleImportantNewsRuns({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-key",
    referenceTime,
    fetcher: repository(runs),
  });
}

test("a running run younger than the threshold is unchanged", async () => {
  const runs: Run[] = [{
    id: "recent", status: "running",
    startedAt: new Date(referenceTime.getTime() - IMPORTANT_NEWS_STALE_RUN_THRESHOLD_MS + 1).toISOString(),
    completedAt: null, error: null,
  }];
  assert.equal(await reconcile(runs), 0);
  assert.equal(runs[0].status, "running");
  assert.equal(runs[0].completedAt, null);
});

test("a running run at the threshold is failed as stale", async () => {
  const runs: Run[] = [{
    id: "stale", status: "running",
    startedAt: new Date(referenceTime.getTime() - IMPORTANT_NEWS_STALE_RUN_THRESHOLD_MS).toISOString(),
    completedAt: null, error: null,
  }];
  assert.equal(await reconcile(runs), 1);
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].completedAt, referenceTime.toISOString());
  assert.equal(runs[0].error, IMPORTANT_NEWS_STALE_RUN_ERROR);
});

test("completed and failed runs are never reconciled", async () => {
  const old = new Date(referenceTime.getTime() - 60 * 60 * 1000).toISOString();
  const runs: Run[] = [
    { id: "completed", status: "completed", startedAt: old, completedAt: old, error: null },
    { id: "failed", status: "failed", startedAt: old, completedAt: old, error: "EXISTING" },
  ];
  assert.equal(await reconcile(runs), 0);
  assert.deepEqual(runs.map((run) => run.status), ["completed", "failed"]);
});

test("only stale running rows are updated when several runs exist", async () => {
  const runs: Run[] = [
    { id: "stale-1", status: "running", startedAt: "2026-09-01T03:00:00Z", completedAt: null, error: null },
    { id: "stale-2", status: "running", startedAt: "2026-09-01T03:30:00Z", completedAt: null, error: null },
    { id: "recent", status: "running", startedAt: "2026-09-01T03:50:00Z", completedAt: null, error: null },
    { id: "done", status: "completed", startedAt: "2026-09-01T03:00:00Z", completedAt: "2026-09-01T03:01:00Z", error: null },
  ];
  assert.equal(await reconcile(runs), 2);
  assert.deepEqual(runs.map((run) => run.status), ["failed", "failed", "running", "completed"]);
});

test("normal processing continues after successful reconciliation", async () => {
  let processed = false;
  const result = await runAfterBestEffortStaleRunReconciliation(
    async () => 2,
    async () => { processed = true; return "new-run"; },
  );
  assert.equal(processed, true);
  assert.equal(result.value, "new-run");
  assert.deepEqual(result.reconciliation, { reconciledCount: 2, error: null });
});

test("reconciliation failure is reported but does not block normal processing", async () => {
  let processed = false;
  const result = await runAfterBestEffortStaleRunReconciliation(
    async () => { throw new Error("database unavailable"); },
    async () => { processed = true; return "new-run"; },
  );
  assert.equal(processed, true);
  assert.equal(result.value, "new-run");
  assert.deepEqual(result.reconciliation, {
    reconciledCount: 0,
    error: IMPORTANT_NEWS_STALE_RUN_RECONCILIATION_FAILED,
  });
});
