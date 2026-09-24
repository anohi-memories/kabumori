import assert from "node:assert/strict";
import test from "node:test";
import { applyMaterialChangeUpdate, applyNoChangeUpdate, toMarketEventSnapshot } from "./mic_state_writer_logic.ts";
import type { EventFact } from "./mic_state_types.ts";

const ctx = { supabaseUrl: "https://example.supabase.co", secretKey: "secret-key" };

// The transactional behavior itself (CAS, atomic run completion, rollback,
// event re-verification, idempotency) lives in SQL and is verified against a
// disposable Postgres. These tests cover building each RPC call and
// interpreting its response.

function sampleRefresh() {
  return {
    asOf: "2026-09-13T00:00:00.000Z",
    expectedCurrentUpdatedAt: "2026-09-12T00:00:00.000Z",
    coverageStatus: "full" as const,
    fetchStatus: "fresh" as const,
    observationStatus: "fresh" as const,
    dataConfidence: 1.0,
  };
}

function recordingFetch(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(new Response(JSON.stringify(responseBody), { status }));
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

test("applyNoChangeUpdate: one RPC call carrying the status columns, the CAS token, the run id and decision_detail -- never narrative", async () => {
  const { calls, fetchImpl } = recordingFetch([{ result_status: "applied" }]);
  const result = await applyNoChangeUpdate(ctx, "rates", sampleRefresh(), {
    runId: "22222222-2222-2222-2222-222222222222",
    decisionDetail: { material: false, reason: "no change" },
  }, fetchImpl);
  assert.deepEqual(result, { status: "applied" });

  assert.equal(calls.length, 1, "State refresh and run completion are one RPC, not a PATCH plus a run PATCH");
  assert.equal(calls[0].init?.method, "POST");
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/apply_mic_state_no_change_update$/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(Object.keys(body).sort(), [
    "p_as_of",
    "p_coverage_status",
    "p_data_confidence",
    "p_decision_detail",
    "p_domain",
    "p_expected_current_updated_at",
    "p_fetch_status",
    "p_observation_status",
    "p_run_id",
  ]);
  assert.equal(body.p_run_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(body.p_expected_current_updated_at, "2026-09-12T00:00:00.000Z");
  assert.deepEqual(body.p_decision_detail, { material: false, reason: "no change" });
});

test("applyNoChangeUpdate: already_applied (response-loss retry) is passed through as success", async () => {
  const { fetchImpl } = recordingFetch([{ result_status: "already_applied" }]);
  const result = await applyNoChangeUpdate(ctx, "rates", sampleRefresh(), { runId: "r", decisionDetail: {} }, fetchImpl);
  assert.deepEqual(result, { status: "already_applied" });
});

test("applyNoChangeUpdate: a stale CAS rejected by the RPC surfaces MIC_STATE_STALE_DECISION", async () => {
  const { fetchImpl } = recordingFetch({ code: "P0001", message: "MIC_STATE_STALE_DECISION" }, 400);
  await assert.rejects(
    () => applyNoChangeUpdate(ctx, "rates", sampleRefresh(), { runId: "r", decisionDetail: {} }, fetchImpl),
    /STATE_NO_CHANGE_UPDATE_RPC_FAILED:400:.*MIC_STATE_STALE_DECISION/,
  );
});

test("applyNoChangeUpdate: an unrecognized or multi-row response is never treated as success", async () => {
  for (const body of [[{ result_status: "weird" }], [], [{ result_status: "applied" }, { result_status: "applied" }], {}]) {
    const { fetchImpl } = recordingFetch(body);
    await assert.rejects(
      () => applyNoChangeUpdate(ctx, "rates", sampleRefresh(), { runId: "r", decisionDetail: {} }, fetchImpl),
      /STATE_NO_CHANGE_UPDATE_RPC_RESPONSE_INVALID/,
    );
  }
});

function sampleUpdate() {
  return {
    ...sampleRefresh(),
    narrative: "米金利は落ち着いた動き。",
    bullishFactors: ["a"],
    bearishFactors: ["b"],
    keyRisks: ["c"],
    numericBaselineSnapshot: { US10Y: { value: 4.5, observedDate: "2026-09-10", observedAt: null } },
    sourceMetricKeys: ["US10Y"],
    sourceEventIds: ["39ec45a4-77b5-4869-a011-2f4aa98c228d"],
    aiModel: "gpt-5.6-luna",
    aiConfidence: 0.9,
    aiInputTokens: 100,
    aiOutputTokens: 50,
    aiCostUsd: 0.00007,
  };
}

const fedEvent: EventFact = {
  id: "39ec45a4-77b5-4869-a011-2f4aa98c228d",
  title: "Fed raises target range by 25bp",
  summary: "FOMC statement",
  importance: "high",
  eventType: "central_bank_decision",
  publishedAt: "2026-09-16T18:00:00+00:00",
  updatedAt: "2026-09-16T18:05:00.123456+00:00",
};

test("toMarketEventSnapshot: exactly the evaluator's event fields, values copied verbatim (no reformatting)", () => {
  assert.deepEqual(toMarketEventSnapshot(fedEvent), {
    id: "39ec45a4-77b5-4869-a011-2f4aa98c228d",
    title: "Fed raises target range by 25bp",
    summary: "FOMC statement",
    importance: "high",
    event_type: "central_bank_decision",
    published_at: "2026-09-16T18:00:00+00:00",
    updated_at: "2026-09-16T18:05:00.123456+00:00",
  });
});

test("applyMaterialChangeUpdate: one RPC call carrying State, event snapshots, Fed diff ids, and the run completion (decision_detail + usage id)", async () => {
  const { calls, fetchImpl } = recordingFetch([{ result_status: "applied" }]);
  const result = await applyMaterialChangeUpdate(
    ctx,
    "rates",
    sampleUpdate(),
    "1 high/critical event(s)",
    {
      marketEventSnapshots: [toMarketEventSnapshot(fedEvent)],
      fedStatementDiffIds: ["4c6f1ad7-255e-4ac7-8eab-b44904bf94b0"],
    },
    {
      runId: "22222222-2222-2222-2222-222222222222",
      decisionDetail: { material: true, reason: "1 high/critical event(s)" },
      aiUsageEventId: 101,
    },
    fetchImpl,
  );
  assert.deepEqual(result, { status: "applied" });

  assert.equal(calls.length, 1, "history+current+evidence+run completion are one RPC -- no separate run PATCH");
  assert.equal(calls[0].init?.method, "POST");
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/apply_mic_state_material_update$/);

  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.p_domain, "rates");
  assert.equal(body.p_run_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(body.p_expected_current_updated_at, "2026-09-12T00:00:00.000Z");
  assert.equal(body.p_narrative, "米金利は落ち着いた動き。");
  assert.equal(body.p_reason, "1 high/critical event(s)");
  assert.deepEqual(body.p_decision_detail, { material: true, reason: "1 high/critical event(s)" });
  assert.equal(body.p_ai_usage_event_id, 101);
  assert.deepEqual(body.p_source_event_ids, ["39ec45a4-77b5-4869-a011-2f4aa98c228d"]);
  assert.deepEqual(body.p_market_event_snapshots, [toMarketEventSnapshot(fedEvent)]);
  assert.deepEqual(body.p_fed_statement_diff_evidence_ids, ["4c6f1ad7-255e-4ac7-8eab-b44904bf94b0"]);
  assert.equal("p_market_event_evidence_ids" in body, false, "ids-only evidence was replaced by snapshots");
  // ai_evaluated_at / completed_at come from SQL now() inside the transaction.
  assert.equal("p_ai_evaluated_at" in body, false);
  assert.equal("p_completed_at" in body, false);
});

test("applyMaterialChangeUpdate: already_applied (response-loss retry) is passed through as success", async () => {
  const { fetchImpl } = recordingFetch([{ result_status: "already_applied" }]);
  const result = await applyMaterialChangeUpdate(
    ctx, "rates", sampleUpdate(), "r",
    { marketEventSnapshots: [], fedStatementDiffIds: [] },
    { runId: "r", decisionDetail: {}, aiUsageEventId: 1 },
    fetchImpl,
  );
  assert.deepEqual(result, { status: "already_applied" });
});

test("applyMaterialChangeUpdate: an event changed during evaluation (RPC fail-closed) is surfaced as an error", async () => {
  const { fetchImpl } = recordingFetch({ code: "P0001", message: "MIC_STATE_EVENT_CHANGED_DURING_EVALUATION" }, 400);
  await assert.rejects(
    () =>
      applyMaterialChangeUpdate(
        ctx, "rates", sampleUpdate(), "r",
        { marketEventSnapshots: [toMarketEventSnapshot(fedEvent)], fedStatementDiffIds: [] },
        { runId: "r", decisionDetail: {}, aiUsageEventId: 1 },
        fetchImpl,
      ),
    /STATE_MATERIAL_UPDATE_RPC_FAILED:400:.*MIC_STATE_EVENT_CHANGED_DURING_EVALUATION/,
  );
});

test("applyMaterialChangeUpdate: an unrecognized result_status is never treated as success", async () => {
  const { fetchImpl } = recordingFetch([{ result_status: "something_unexpected" }]);
  await assert.rejects(
    () =>
      applyMaterialChangeUpdate(
        ctx, "rates", sampleUpdate(), "r",
        { marketEventSnapshots: [], fedStatementDiffIds: [] },
        { runId: "r", decisionDetail: {}, aiUsageEventId: 1 },
        fetchImpl,
      ),
    /STATE_MATERIAL_UPDATE_RPC_RESPONSE_INVALID/,
  );
});
