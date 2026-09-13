import assert from "node:assert/strict";
import test from "node:test";
import { applyMaterialChangeUpdate, refreshStatusOnly } from "./mic_state_writer_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";

const ctx: RestContext = { supabaseUrl: "https://example.supabase.co", secretKey: "secret-key" };

test("refreshStatusOnly: PATCHes only the deterministic status columns, never narrative", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  await refreshStatusOnly(
    ctx,
    "rates",
    { asOf: "2026-09-13T00:00:00.000Z", coverageStatus: "full", fetchStatus: "fresh", observationStatus: "fresh", dataConfidence: 1.0 },
    fetchImpl as typeof fetch,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "PATCH");
  assert.match(calls[0].url, /market_state_current\?domain=eq\.rates/);
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
        { asOf: null, coverageStatus: "unavailable", fetchStatus: "unknown", observationStatus: "unknown", dataConfidence: 0 },
        fetchImpl as typeof fetch,
      ),
    /STATE_STATUS_REFRESH_FAILED:500/,
  );
});

function sampleUpdate() {
  return {
    asOf: "2026-09-13T00:00:00.000Z",
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

test("applyMaterialChangeUpdate: fetches the pre-update row, PATCHes the new interpretation, then appends history with the OLD snapshot", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const previousRow = { domain: "rates", narrative: "old narrative", as_of: "2026-09-12T00:00:00.000Z" };
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (!init || init.method === undefined) {
      // the pre-update GET
      return new Response(JSON.stringify([previousRow]), { status: 200 });
    }
    if (init.method === "PATCH") return new Response(null, { status: 204 });
    if (init.method === "POST") return new Response(null, { status: 201 });
    throw new Error(`unexpected method ${init.method}`);
  };
  await applyMaterialChangeUpdate(ctx, "rates", sampleUpdate(), "US10Y crossed threshold", fetchImpl as typeof fetch);

  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /market_state_current\?domain=eq\.rates&select=\*/);
  assert.equal(calls[1].init?.method, "PATCH");
  const patchBody = JSON.parse(String(calls[1].init?.body));
  assert.equal(patchBody.narrative, "米金利は落ち着いた動き。");
  assert.equal(patchBody.ai_model, "gpt-5.6-luna");
  assert.ok(typeof patchBody.ai_evaluated_at === "string");

  assert.equal(calls[2].init?.method, "POST");
  assert.match(calls[2].url, /market_state_history$/);
  const historyBody = JSON.parse(String(calls[2].init?.body));
  assert.equal(historyBody.domain, "rates");
  assert.equal(historyBody.triggered_by, "material_change");
  assert.equal(historyBody.reason, "US10Y crossed threshold");
  // The history row captures what the state looked like BEFORE this
  // update -- the old narrative, not the new one.
  assert.deepEqual(historyBody.snapshot, previousRow);
});

test("applyMaterialChangeUpdate: throws if the pre-update fetch fails, without attempting the PATCH", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    calls.push(String(url));
    return new Response("error", { status: 500 });
  };
  await assert.rejects(
    () => applyMaterialChangeUpdate(ctx, "rates", sampleUpdate(), "reason", fetchImpl as typeof fetch),
    /STATE_PRE_UPDATE_FETCH_FAILED:500/,
  );
  assert.equal(calls.length, 1);
});

test("applyMaterialChangeUpdate: throws if the history insert fails after a successful PATCH", async () => {
  const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
    if (!init || init.method === undefined) return new Response(JSON.stringify([{ domain: "rates" }]), { status: 200 });
    if (init.method === "PATCH") return new Response(null, { status: 204 });
    return new Response("error", { status: 500 });
  };
  await assert.rejects(
    () => applyMaterialChangeUpdate(ctx, "rates", sampleUpdate(), "reason", fetchImpl as typeof fetch),
    /STATE_HISTORY_INSERT_FAILED:500/,
  );
});
