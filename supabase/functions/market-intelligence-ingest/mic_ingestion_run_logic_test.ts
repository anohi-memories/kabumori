import assert from "node:assert/strict";
import test from "node:test";
import {
  claimIngestionRun,
  completeIngestionRun,
  computeRunWindow,
  failIngestionRun,
  MIC_STALE_RUN_THRESHOLD_MS,
  reconcileStaleIngestionRuns,
} from "./mic_ingestion_run_logic.ts";
import type { RestContext } from "./mic_writer_logic.ts";

const ctx: RestContext = { supabaseUrl: "https://example.supabase.co", secretKey: "secret-key" };

test("computeRunWindow buckets by source and UTC hour", () => {
  const now = new Date("2026-09-12T09:45:00.000Z");
  assert.equal(computeRunWindow("fred", now), "fred:2026-09-12T09");
  assert.equal(computeRunWindow("eia", now), "eia:2026-09-12T09");
});

test("claimIngestionRun reports claimed:true when the insert returns a row", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201 });
  };
  const result = await claimIngestionRun(
    ctx,
    { sourceKey: "fred", runWindow: "fred:2026-09-12T09", triggerType: "manual" },
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { claimed: true, runId: "run-1" });
  assert.match(calls[0].url, /on_conflict=source_key,run_window/);
  const prefer = (calls[0].init?.headers as Record<string, string>)?.Prefer;
  assert.match(prefer, /resolution=ignore-duplicates/);
});

test("claimIngestionRun reports claimed:false when ignore-duplicates returns zero rows", async () => {
  const fetchImpl = async () => new Response(JSON.stringify([]), { status: 201 });
  const result = await claimIngestionRun(
    ctx,
    { sourceKey: "fred", runWindow: "fred:2026-09-12T09", triggerType: "scheduled" },
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { claimed: false, runId: null });
});

test("claimIngestionRun throws on a non-2xx response", async () => {
  const fetchImpl = async () => new Response("error", { status: 500 });
  await assert.rejects(
    () =>
      claimIngestionRun(
        ctx,
        { sourceKey: "fred", runWindow: "fred:2026-09-12T09", triggerType: "manual" },
        fetchImpl as typeof fetch,
      ),
    /INGESTION_RUN_CLAIM_FAILED:500/,
  );
});

test("completeIngestionRun PATCHes with status=eq.running and the final counts", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  await completeIngestionRun(
    ctx,
    "run-1",
    { fetchedCount: 2, newCount: 2, duplicateCount: 0 },
    fetchImpl as typeof fetch,
  );
  assert.equal(calls[0].init?.method, "PATCH");
  assert.match(calls[0].url, /id=eq\.run-1&status=eq\.running/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.status, "completed");
  assert.equal(body.fetched_count, 2);
});

test("failIngestionRun never throws even if the PATCH itself fails", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  await assert.doesNotReject(() => failIngestionRun(ctx, "run-1", "ADAPTER_ERROR", fetchImpl as typeof fetch));
});

test("reconcileStaleIngestionRuns PATCHes running rows older than the threshold and never throws", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  const now = new Date("2026-09-12T10:00:00.000Z");
  const result = await reconcileStaleIngestionRuns(ctx, { now }, fetchImpl as typeof fetch);
  assert.deepEqual(result, { attempted: true });
  const expectedCutoff = new Date(now.getTime() - MIC_STALE_RUN_THRESHOLD_MS).toISOString();
  assert.match(calls[0].url, /status=eq\.running/);
  assert.ok(calls[0].url.includes(encodeURIComponent(expectedCutoff)));
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.error, "MIC_STALE_RUN_TERMINATION");
});

test("reconcileStaleIngestionRuns swallows a fetch failure and reports attempted:false", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const result = await reconcileStaleIngestionRuns(ctx, {}, fetchImpl as typeof fetch);
  assert.deepEqual(result, { attempted: false });
});
