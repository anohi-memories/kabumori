import assert from "node:assert/strict";
import test from "node:test";
import {
  applyScenarioUpdate,
  claimScenarioRun,
  completeScenarioRunNoChange,
  computeScenarioRunWindow,
  failScenarioRun,
  fetchScenarioCurrent,
  fetchScenarioRunStatus,
  reconcileStaleScenarioRuns,
  recordScenarioUsage,
  restHeaders,
  safeErrorMessage,
} from "./mic_scenario_run_logic.ts";

const ctx = { supabaseUrl: "https://example.supabase.co", secretKey: "sk_test" };
const RUN = "22222222-2222-4222-8222-222222222222";

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };

function recorder(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = ((url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call ${url}`);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("run window is hourly and scoped to the market scenario", () => {
  assert.equal(computeScenarioRunWindow(new Date("2026-09-28T07:45:10Z")), "market:2026-09-28T07");
});

test("headers carry the secret key only as auth headers; errors are truncated", () => {
  assert.deepEqual(restHeaders("k", "return=minimal"), {
    apikey: "k", Authorization: "Bearer k", "Content-Type": "application/json", Prefer: "return=minimal",
  });
  assert.equal(safeErrorMessage(new Error("x".repeat(900))).length, 500);
  assert.equal(safeErrorMessage("boom"), "UNEXPECTED_ERROR");
});

test("current row: exactly one row is required", async () => {
  const ok = recorder([json([{ updated_at: "2026-09-28T00:00:00Z", source_state_run_ids: ["a"], input_fingerprint: null, source_scenario_run_id: null }])]);
  assert.deepEqual(await fetchScenarioCurrent(ctx, ok.impl), {
    updatedAt: "2026-09-28T00:00:00Z", sourceStateRunIds: ["a"], inputFingerprint: null, sourceScenarioRunId: null,
  });
  await assert.rejects(fetchScenarioCurrent(ctx, recorder([json([])]).impl), /SCENARIO_CURRENT_ROW_MISSING/);
});

test("[H] claim: next attempt number, and 409 (another run in flight) is not claimed", async () => {
  const ok = recorder([json([{ attempt_no: 2 }]), json([{ id: RUN }], 201)]);
  assert.deepEqual(await claimScenarioRun(ctx, "market:2026-09-28T07", ok.impl), { claimed: true, runId: RUN });
  assert.deepEqual(ok.calls[1].body, { scenario_key: "market", run_window: "market:2026-09-28T07", attempt_no: 3, status: "running" });
  const busy = recorder([json([]), json({ code: "23505" }, 409)]);
  assert.deepEqual(await claimScenarioRun(ctx, "market:2026-09-28T07", busy.impl), { claimed: false });
  await assert.rejects(claimScenarioRun(ctx, "w", recorder([json([]), json({}, 500)]).impl), /SCENARIO_RUN_CLAIM_FAILED:500/);
});

test("no_change: status-filtered PATCH that must hit exactly one running row", async () => {
  const ok = recorder([json([{ id: RUN }])]);
  await completeScenarioRunNoChange(ctx, RUN, { reason: "no_new_state_evaluation" }, ok.impl);
  assert.match(ok.calls[0].url, /id=eq\.2222.*&status=eq\.running/);
  assert.equal(ok.calls[0].method, "PATCH");
  assert.equal((ok.calls[0].body as Record<string, unknown>).status, "no_change");
  await assert.rejects(completeScenarioRunNoChange(ctx, RUN, {}, recorder([json([])]).impl), /SCENARIO_RUN_NO_CHANGE_NOT_APPLIED/);
});

test("fail: only running runs, never throws", async () => {
  const ok = recorder([new Response(null, { status: 204 })]);
  await failScenarioRun(ctx, RUN, "E".repeat(3000), ok.impl);
  assert.match(ok.calls[0].url, /status=eq\.running/);
  assert.equal(((ok.calls[0].body as Record<string, unknown>).error as string).length, 2000);
  await failScenarioRun(ctx, RUN, "E", recorder([new Error("net")]).impl);
});

test("run status read-back never throws", async () => {
  assert.equal(await fetchScenarioRunStatus(ctx, RUN, recorder([json([{ status: "evaluated" }])]).impl), "evaluated");
  assert.equal(await fetchScenarioRunStatus(ctx, RUN, recorder([json([{ status: "weird" }])]).impl), null);
  assert.equal(await fetchScenarioRunStatus(ctx, RUN, recorder([new Error("net")]).impl), null);
});

test("stale runs older than 15 minutes are terminated as failed", async () => {
  const r = recorder([new Response(null, { status: 204 })]);
  assert.deepEqual(await reconcileStaleScenarioRuns(ctx, new Date("2026-09-28T07:30:00Z"), r.impl), { attempted: true });
  assert.match(decodeURIComponent(r.calls[0].url), /status=eq\.running&started_at=lt\.2026-09-28T07:15:00\.000Z/);
  assert.deepEqual(await reconcileStaleScenarioRuns(ctx, new Date(), recorder([new Error("x")]).impl), { attempted: false });
});

test("[I] usage row is linked to the Scenario run", async () => {
  const r = recorder([json([{ id: 77 }], 201)]);
  assert.equal(await recordScenarioUsage(ctx, { runId: RUN, model: "gpt-5.6-luna", inputTokens: 10, outputTokens: 5, costUsd: 0.1 }, r.impl), 77);
  assert.deepEqual(r.calls[0].body, {
    feature: "mic_scenario_evaluation", model: "gpt-5.6-luna", input_tokens: 10, output_tokens: 5, web_search_calls: 0,
    cost_usd: 0.1, related_table: "mic_scenario_evaluation_runs", related_id: RUN,
  });
  await assert.rejects(recordScenarioUsage(ctx, { runId: RUN, model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0 }, recorder([json([{}])]).impl), /EVENT_ID_MISSING/);
});

test("RPC: parameters are mapped 1:1 and only applied/already_applied are accepted", async () => {
  const params = {
    runId: RUN, expectedCurrentUpdatedAt: "t", inputFingerprint: "fp", promptVersion: "mic-scenario-v1",
    assessmentStatus: "assessed" as const, baseCase: { b: 1 }, upsideCase: { u: 1 }, downsideCase: { d: 1 }, stateConflicts: [],
    confidence: 0.5, aiConfidence: 0.6, stateSnapshots: [{}], evidenceMeta: [{ domain: "rates", freshness: "fresh", usability: "strong" }],
    aiModel: "gpt-5.6-luna", aiInputTokens: 1, aiOutputTokens: 2, aiCostUsd: 0.01, decisionDetail: { generate: true }, aiUsageEventId: 5,
  };
  const r = recorder([json([{ result_status: "applied" }])]);
  assert.equal(await applyScenarioUpdate(ctx, params, r.impl), "applied");
  assert.match(r.calls[0].url, /\/rest\/v1\/rpc\/apply_mic_scenario_update$/);
  const body = r.calls[0].body as Record<string, unknown>;
  assert.equal(Object.keys(body).length, 20);
  assert.equal(body.p_scenario_key, "market");
  assert.equal(body.p_ai_usage_event_id, 5);
  assert.equal(await applyScenarioUpdate(ctx, params, recorder([json([{ result_status: "already_applied" }])]).impl), "already_applied");
  await assert.rejects(applyScenarioUpdate(ctx, params, recorder([json([{ result_status: "?" }])]).impl), /RESPONSE_INVALID/);
  await assert.rejects(
    applyScenarioUpdate(ctx, params, recorder([json({ message: "MIC_SCENARIO_STATE_CHANGED_DURING_EVALUATION:rates" }, 400)]).impl),
    /SCENARIO_UPDATE_RPC_FAILED:400:.*STATE_CHANGED_DURING_EVALUATION/,
  );
});
