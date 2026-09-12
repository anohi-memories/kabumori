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

// claimIngestionRun makes exactly two calls: a GET to compute the next
// attempt_no (audit metadata, not a lock), then a POST insert. The actual
// exclusivity guarantee comes only from the partial unique index on
// (source_key, run_window) WHERE status in ('running','completed') --
// a unique-violation there surfaces as a 409 from PostgREST.

test("claimIngestionRun: first attempt for a window looks up attempt_no=0 and inserts attempt_no=1", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify([]), { status: 200 }); // no prior attempts
    }
    return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201 });
  };
  const result = await claimIngestionRun(
    ctx,
    { sourceKey: "fred", runWindow: "fred:2026-09-12T09", triggerType: "manual" },
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { claimed: true, runId: "run-1", attemptNo: 1 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /source_key=eq\.fred&run_window=eq\.fred%3A2026-09-12T09/);
  assert.match(calls[0].url, /order=attempt_no\.desc&limit=1/);
  const insertBody = JSON.parse(String(calls[1].init?.body));
  assert.equal(insertBody.attempt_no, 1);
  assert.equal(insertBody.status, "running");
});

test("claimIngestionRun: after a prior failed attempt, looks up its attempt_no and retries as the next one", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if ((init?.method ?? "GET") === "GET") {
      // A prior 'failed' row for this window still exists (failed rows are
      // never deleted) -- its attempt_no must still be visible here.
      return new Response(JSON.stringify([{ attempt_no: 1 }]), { status: 200 });
    }
    return new Response(JSON.stringify([{ id: "run-2" }]), { status: 201 });
  };
  const result = await claimIngestionRun(
    ctx,
    { sourceKey: "fred", runWindow: "fred:2026-09-12T09", triggerType: "scheduled" },
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { claimed: true, runId: "run-2", attemptNo: 2 });
  const insertBody = JSON.parse(String(calls[1].init?.body));
  assert.equal(insertBody.attempt_no, 2);
});

test("claimIngestionRun: a 409 from the active-claim index (running/completed already holds it) reports claimed:false", async () => {
  const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify([{ attempt_no: 1 }]), { status: 200 });
    return new Response("conflict", { status: 409 });
  };
  const result = await claimIngestionRun(
    ctx,
    { sourceKey: "fred", runWindow: "fred:2026-09-12T09", triggerType: "manual" },
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { claimed: false, runId: null, attemptNo: null });
});

test("claimIngestionRun: throws on a non-2xx, non-409 response from the attempt_no lookup", async () => {
  const fetchImpl = async () => new Response("error", { status: 500 });
  await assert.rejects(
    () =>
      claimIngestionRun(
        ctx,
        { sourceKey: "fred", runWindow: "fred:2026-09-12T09", triggerType: "manual" },
        fetchImpl as typeof fetch,
      ),
    /INGESTION_RUN_ATTEMPT_LOOKUP_FAILED:500/,
  );
});

test("claimIngestionRun: throws on a non-2xx, non-409 response from the insert", async () => {
  const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify([]), { status: 200 });
    return new Response("error", { status: 500 });
  };
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

test("reconcileStaleIngestionRuns swallows a thrown fetch failure and reports attempted:false", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const result = await reconcileStaleIngestionRuns(ctx, {}, fetchImpl as typeof fetch);
  assert.deepEqual(result, { attempted: false });
});

test("reconcileStaleIngestionRuns reports attempted:false when the PATCH resolves with a non-2xx status", async () => {
  // A resolved-but-failed response (e.g. PostgREST rejecting the PATCH)
  // must NOT be reported as a successful sweep just because fetch didn't
  // throw.
  const fetchImpl = async () => new Response("server error", { status: 500 });
  const result = await reconcileStaleIngestionRuns(ctx, {}, fetchImpl as typeof fetch);
  assert.deepEqual(result, { attempted: false });
});
