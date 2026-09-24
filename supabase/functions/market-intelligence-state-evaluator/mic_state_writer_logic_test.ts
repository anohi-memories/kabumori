import assert from "node:assert/strict";
import test from "node:test";
import { applyMaterialChangeUpdate, refreshStatusOnly } from "./mic_state_writer_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";

const ctx: RestContext = { supabaseUrl: "https://example.supabase.co", secretKey: "secret-key" };

test("refreshStatusOnly: PATCHes only the deterministic status columns, never narrative", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([{ domain: "rates" }]), { status: 200 });
  };
  await refreshStatusOnly(
    ctx,
    "rates",
    { asOf: "2026-09-13T00:00:00.000Z", expectedCurrentUpdatedAt: "2026-09-12T00:00:00.000Z", coverageStatus: "full", fetchStatus: "fresh", observationStatus: "fresh", dataConfidence: 1.0 },
    fetchImpl as typeof fetch,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "PATCH");
  assert.match(calls[0].url, /market_state_current\?domain=eq\.rates/);
  assert.match(calls[0].url, /updated_at=eq\.2026-09-12T00%3A00%3A00\.000Z/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(Object.keys(body).sort(), ["as_of", "coverage_status", "data_confidence", "fetch_status", "observation_status"]);
  assert.equal(body.coverage_status, "full");
});

test("refreshStatusOnly: throws on a non-2xx status", async () => {
  const fetchImpl = async () => new Response("error", { status: 500 });
  await assert.rejects(
    () =>
      refreshStatusOnly(
        ctx,
        "rates",
        { asOf: null, expectedCurrentUpdatedAt: "2026-09-12T00:00:00.000Z", coverageStatus: "unavailable", fetchStatus: "unknown", observationStatus: "unknown", dataConfidence: 0 },
        fetchImpl as typeof fetch,
      ),
    /STATE_STATUS_REFRESH_FAILED:500/,
  );
});

test("refreshStatusOnly: a CAS miss reports stale and cannot overwrite newer State", async () => {
  const fetchImpl = () => Promise.resolve(new Response("[]", { status: 200 }));
  const result = await refreshStatusOnly(ctx, "rates", {
    asOf: null, expectedCurrentUpdatedAt: "2026-09-12T00:00:00.000Z",
    coverageStatus: "full", fetchStatus: "fresh", observationStatus: "fresh", dataConfidence: 1,
  }, fetchImpl as typeof fetch);
  assert.equal(result, "stale");
});

function sampleUpdate() {
  return {
    asOf: "2026-09-13T00:00:00.000Z",
    expectedCurrentUpdatedAt: "2026-09-12T00:00:00.000Z",
    coverageStatus: "full" as const,
    fetchStatus: "fresh" as const,
    observationStatus: "fresh" as const,
    dataConfidence: 1.0,
    narrative: "米金利は落ち着いた動き。",
    bullishFactors: ["a"],
    bearishFactors: ["b"],
    keyRisks: ["c"],
    numericBaselineSnapshot: { US10Y: { value: 4.5, observedDate: "2026-09-10", observedAt: null } },
    sourceMetricKeys: ["US10Y"],
    sourceEventIds: [],
    aiModel: "gpt-5.6-luna",
    aiConfidence: 0.9,
    aiInputTokens: 100,
    aiOutputTokens: 50,
    aiCostUsd: 0.00007,
  };
}

function sampleEvidence(overrides: Partial<{ runId: string; marketEventIds: string[]; fedStatementDiffIds: string[] }> = {}) {
  return {
    runId: "11111111-1111-1111-1111-111111111111",
    marketEventIds: [],
    fedStatementDiffIds: [],
    ...overrides,
  };
}

// State Evidence Phase 2C1: applyMaterialChangeUpdate is now a single POST
// to the apply_mic_state_material_update RPC -- the previous
// GET-then-PATCH-then-POST 3-call sequence (and its "history captures the
// pre-update row" behavior) is now entirely inside that RPC's own SQL
// transaction (verified separately by the local-DB RPC tests, not
// mockable at the TS-fetch level since it never leaves the database). What
// this module is responsible for is building the RPC call correctly and
// interpreting its response.

test("applyMaterialChangeUpdate: POSTs a single call to the apply_mic_state_material_update RPC with the full update payload plus run id and evidence", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([{ result_status: "applied" }]), { status: 200 });
  };
  const result = await applyMaterialChangeUpdate(
    ctx,
    "rates",
    sampleUpdate(),
    "US10Y crossed threshold",
    sampleEvidence({
      runId: "22222222-2222-2222-2222-222222222222",
      marketEventIds: ["39ec45a4-77b5-4869-a011-2f4aa98c228d"],
      fedStatementDiffIds: ["4c6f1ad7-255e-4ac7-8eab-b44904bf94b0"],
    }),
    fetchImpl as typeof fetch,
  );
  assert.deepEqual(result, { status: "applied" });

  assert.equal(calls.length, 1, "exactly one HTTP call -- the RPC does history+current+evidence atomically, no separate REST calls from this module");
  assert.equal(calls[0].init?.method, "POST");
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/apply_mic_state_material_update$/);

  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.p_domain, "rates");
  assert.equal(body.p_run_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(body.p_expected_current_updated_at, "2026-09-12T00:00:00.000Z");
  assert.equal(body.p_narrative, "米金利は落ち着いた動き。");
  assert.equal(body.p_ai_model, "gpt-5.6-luna");
  assert.equal(body.p_reason, "US10Y crossed threshold");
  assert.deepEqual(body.p_market_event_evidence_ids, ["39ec45a4-77b5-4869-a011-2f4aa98c228d"]);
  assert.deepEqual(body.p_fed_statement_diff_evidence_ids, ["4c6f1ad7-255e-4ac7-8eab-b44904bf94b0"]);
  // ai_evaluated_at is no longer set from TS Date.now() -- the RPC uses
  // SQL now() inside the same transaction instead, so it is deliberately
  // absent from the outgoing payload.
  assert.equal("ai_evaluated_at" in body, false);
  assert.equal("p_ai_evaluated_at" in body, false);
});

test("applyMaterialChangeUpdate: returns already_applied when the RPC reports the run was already applied (retry idempotency)", async () => {
  const fetchImpl = async () => new Response(JSON.stringify([{ result_status: "already_applied" }]), { status: 200 });
  const result = await applyMaterialChangeUpdate(ctx, "rates", sampleUpdate(), "reason", sampleEvidence(), fetchImpl as typeof fetch);
  assert.deepEqual(result, { status: "already_applied" });
});

test("applyMaterialChangeUpdate: throws if the RPC call itself fails (non-2xx)", async () => {
  const fetchImpl = async () => new Response("error", { status: 500 });
  await assert.rejects(
    () => applyMaterialChangeUpdate(ctx, "rates", sampleUpdate(), "reason", sampleEvidence(), fetchImpl as typeof fetch),
    /STATE_MATERIAL_UPDATE_RPC_FAILED:500/,
  );
});

test("applyMaterialChangeUpdate: throws if the RPC returns an unrecognized result_status (defensive -- never silently treat an unknown response as success)", async () => {
  const fetchImpl = async () => new Response(JSON.stringify([{ result_status: "something_unexpected" }]), { status: 200 });
  await assert.rejects(
    () => applyMaterialChangeUpdate(ctx, "rates", sampleUpdate(), "reason", sampleEvidence(), fetchImpl as typeof fetch),
    /STATE_MATERIAL_UPDATE_RPC_RESPONSE_INVALID/,
  );
});
