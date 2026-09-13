import assert from "node:assert/strict";
import test from "node:test";
import {
  claimStateEvaluationRun,
  completeStateEvaluationRun,
  computeRunWindow,
  failStateEvaluationRun,
  MIC_STATE_STALE_RUN_THRESHOLD_MS,
  reconcileStaleStateEvaluationRuns,
} from "./mic_state_run_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";

const ctx: RestContext = { supabaseUrl: "https://example.supabase.co", secretKey: "secret-key" };

test("computeRunWindow buckets by domain and UTC hour", () => {
  const now = new Date("2026-09-13T09:45:00.000Z");
  assert.equal(computeRunWindow("rates", now), "rates:2026-09-13T09");
});

test("claimStateEvaluationRun: first attempt looks up attempt_no=0 and inserts attempt_no=1", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify([]), { status: 200 });
    return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201 });
  };
  const result = await claimStateEvaluationRun(
    ctx,
    { domain: "rates", runWindow: "rates:2026-09-13T09" },
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { claimed: true, runId: "run-1", attemptNo: 1 });
  assert.match(calls[0].url, /domain=eq\.rates&run_window=eq\.rates%3A2026-09-13T09/);
  const insertBody = JSON.parse(String(calls[1].init?.body));
  assert.equal(insertBody.attempt_no, 1);
  assert.equal(insertBody.status, "running");
});

test("claimStateEvaluationRun: retries as next attempt_no after a prior failed attempt", async () => {
  const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify([{ attempt_no: 1 }]), { status: 200 });
    return new Response(JSON.stringify([{ id: "run-2" }]), { status: 201 });
  };
  const result = await claimStateEvaluationRun(
    ctx,
    { domain: "rates", runWindow: "rates:2026-09-13T09" },
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { claimed: true, runId: "run-2", attemptNo: 2 });
});

test("claimStateEvaluationRun: a 409 from the active-claim index reports claimed:false", async () => {
  const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify([{ attempt_no: 1 }]), { status: 200 });
    return new Response("conflict", { status: 409 });
  };
  const result = await claimStateEvaluationRun(
    ctx,
    { domain: "rates", runWindow: "rates:2026-09-13T09" },
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { claimed: false, runId: null, attemptNo: null });
});

test("claimStateEvaluationRun: throws on a non-2xx, non-409 insert response", async () => {
  const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify([]), { status: 200 });
    return new Response("error", { status: 500 });
  };
  await assert.rejects(
    () => claimStateEvaluationRun(ctx, { domain: "rates", runWindow: "rates:2026-09-13T09" }, fetchImpl as typeof fetch),
    /STATE_RUN_CLAIM_FAILED:500/,
  );
});

test("completeStateEvaluationRun: PATCHes status=eq.running with decision_detail and ai_usage_event_id", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  await completeStateEvaluationRun(
    ctx,
    "run-1",
    { status: "evaluated", decisionDetail: { material: true }, aiUsageEventId: 42 },
    fetchImpl as typeof fetch,
  );
  assert.equal(calls[0].init?.method, "PATCH");
  assert.match(calls[0].url, /id=eq\.run-1&status=eq\.running/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.status, "evaluated");
  assert.deepEqual(body.decision_detail, { material: true });
  assert.equal(body.ai_usage_event_id, 42);
});

test("completeStateEvaluationRun: no_change status omits ai_usage_event_id (defaults to null)", async () => {
  const calls: Array<{ init?: RequestInit }> = [];
  const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
    calls.push({ init });
    return new Response(null, { status: 204 });
  };
  await completeStateEvaluationRun(
    ctx,
    "run-1",
    { status: "no_change", decisionDetail: { material: false } },
    fetchImpl as typeof fetch,
  );
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.ai_usage_event_id, null);
});

test("failStateEvaluationRun: never throws even if the PATCH itself fails", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  await assert.doesNotReject(() => failStateEvaluationRun(ctx, "run-1", "ADAPTER_ERROR", fetchImpl as typeof fetch));
});

test("reconcileStaleStateEvaluationRuns: PATCHes stale running rows and reports attempted:true", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  const now = new Date("2026-09-13T10:00:00.000Z");
  const result = await reconcileStaleStateEvaluationRuns(ctx, { now }, fetchImpl as typeof fetch);
  assert.deepEqual(result, { attempted: true });
  const expectedCutoff = new Date(now.getTime() - MIC_STATE_STALE_RUN_THRESHOLD_MS).toISOString();
  assert.ok(calls[0].url.includes(encodeURIComponent(expectedCutoff)));
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.error, "MIC_STATE_STALE_RUN_TERMINATION");
});

test("reconcileStaleStateEvaluationRuns: a non-2xx response reports attempted:false", async () => {
  const fetchImpl = async () => new Response("server error", { status: 500 });
  const result = await reconcileStaleStateEvaluationRuns(ctx, {}, fetchImpl as typeof fetch);
  assert.deepEqual(result, { attempted: false });
});

test("reconcileStaleStateEvaluationRuns: a thrown fetch failure reports attempted:false", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const result = await reconcileStaleStateEvaluationRuns(ctx, {}, fetchImpl as typeof fetch);
  assert.deepEqual(result, { attempted: false });
});
