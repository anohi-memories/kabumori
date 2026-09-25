import assert from "node:assert/strict";
import test from "node:test";
import {
  confidenceLabel,
  loadMicMarketContext,
  MIC_DOMAINS,
  micSourceBasis,
  toMicDomainState,
  toMicDomainStates,
  toMicPacketEntries,
  type MicDomainState,
  type MicMarketRow,
} from "./mic_market_context.ts";

function row(overrides: Partial<MicMarketRow> = {}): MicMarketRow {
  return {
    domain: "rates",
    narrative: "米金利は前日から小幅な動きにとどまりました。",
    bullish_factors: ["インフレ鈍化観測"],
    bearish_factors: ["FRBのタカ派発言"],
    key_risks: ["米雇用統計の下振れ"],
    data_confidence: 0.9,
    coverage_status: "full",
    observation_status: "fresh",
    ai_model: "gpt-5.6-luna",
    as_of: "2026-09-24T09:00:00Z",
    source_evaluation_run_id: "318bfbe1-cfda-40b1-aabd-d743f31e3c00",
    ...overrides,
  };
}

test("confidenceLabel: aligned with MIC's own computeDataConfidence bands (full+fresh=1.0/0.9 high, fetch-failed=0.2 low)", () => {
  assert.equal(confidenceLabel(1.0), "high");
  assert.equal(confidenceLabel(0.9), "high");
  assert.equal(confidenceLabel(0.8), "high");
  assert.equal(confidenceLabel(0.7), "medium");
  assert.equal(confidenceLabel(0.5), "medium");
  assert.equal(confidenceLabel(0.2), "low");
  assert.equal(confidenceLabel(0), "low");
});

test("toMicDomainState: parses a normal row, only the 3 target domains are recognized", () => {
  const state = toMicDomainState(row());
  assert.equal(state?.domain, "rates");
  assert.equal(state?.confidence, "high");
  assert.deepEqual(state?.bullishFactors, ["インフレ鈍化観測"]);
  assert.equal(toMicDomainState(row({ domain: "geopolitical" })), null, "domain outside rates/macro/equity_index is excluded");
  assert.equal(toMicDomainState(row({ domain: "fx" })), null);
});

test("toMicDomainState: a never-evaluated domain (narrative null) yields no context, not an error", () => {
  assert.equal(toMicDomainState(row({ narrative: null })), null);
  assert.equal(toMicDomainState(row({ narrative: "" })), null);
  assert.equal(toMicDomainState(row({ narrative: "   " })), null);
});

test("toMicDomainState: malformed rows fail open to null (per-row, not per-fetch)", () => {
  assert.equal(toMicDomainState(row({ data_confidence: "0.9" })), null, "non-numeric data_confidence excluded");
  assert.equal(toMicDomainState({}), null);
  assert.deepEqual(toMicDomainState(row({ bullish_factors: "not-an-array" }))?.bullishFactors, []);
  assert.deepEqual(toMicDomainState(row({ bullish_factors: ["a", 1, null, "b"] }))?.bullishFactors, ["a", "b"]);
});

test("toMicDomainStates: mixes valid/never-evaluated/invalid rows, keeps only usable ones", () => {
  const states = toMicDomainStates([
    row({ domain: "rates" }),
    row({ domain: "macro", narrative: null }),
    row({ domain: "equity_index", data_confidence: 0.6 }),
    row({ domain: "geopolitical" }),
  ]);
  assert.deepEqual(states.map((s) => s.domain), ["rates", "equity_index"]);
  assert.equal(states[1].confidence, "medium");
});

test("toMicPacketEntries: exposes only narrative/factors/confidence label -- no raw number, model, run id or as_of reaches the AI packet", () => {
  const entries = toMicPacketEntries([toMicDomainState(row())!]);
  assert.deepEqual(entries, [{
    domain: "金利",
    narrative: "米金利は前日から小幅な動きにとどまりました。",
    bullish_points: ["インフレ鈍化観測"],
    bearish_points: ["FRBのタカ派発言"],
    key_risks: ["米雇用統計の下振れ"],
    confidence: "高",
  }]);
  for (const key of ["ai_model", "as_of", "source_evaluation_run_id", "data_confidence", "dataConfidence"]) {
    assert.equal(key in entries[0], false, `${key} must not reach the AI-visible packet`);
  }
});

test("toMicPacketEntries: domain label and confidence label are in Japanese for all 3 target domains", () => {
  const states: MicDomainState[] = [
    toMicDomainState(row({ domain: "rates" }))!,
    toMicDomainState(row({ domain: "macro" }))!,
    toMicDomainState(row({ domain: "equity_index", data_confidence: 0.2 }))!,
  ];
  const entries = toMicPacketEntries(states);
  assert.deepEqual(entries.map((e) => e.domain), ["金利", "マクロ経済", "国内株式（指数）"]);
  assert.equal(entries[2].confidence, "低");
});

test("micSourceBasis: undefined when empty (spreads to nothing), carries provenance (not content) per domain otherwise", () => {
  assert.equal(micSourceBasis([]), undefined);
  const basis = micSourceBasis([toMicDomainState(row())!]);
  assert.deepEqual(basis, {
    mic_state: [{
      domain: "rates", ai_model: "gpt-5.6-luna", as_of: "2026-09-24T09:00:00Z",
      source_evaluation_run_id: "318bfbe1-cfda-40b1-aabd-d743f31e3c00", data_confidence: 0.9,
    }],
  });
});

test("loadMicMarketContext: queries market_state_current only, for exactly the 3 target domains, never mic_state_evaluation_runs/mic_state_evidence", async () => {
  const calls: string[] = [];
  const db = { get: <T>(path: string) => { calls.push(path); return Promise.resolve([row(), row({ domain: "macro" })] as unknown as T); } };
  const states = await loadMicMarketContext(db);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^market_state_current\?domain=in\.\(rates,macro,equity_index\)&select=/);
  assert.equal(calls[0].includes("mic_state_evaluation_runs"), false);
  assert.equal(calls[0].includes("mic_state_evidence"), false);
  assert.equal(calls[0].includes("mic_fed_statement_diffs"), false);
  assert.equal(states.length, 2);
  assert.deepEqual(MIC_DOMAINS, ["rates", "macro", "equity_index"]);
});

test("loadMicMarketContext: a REST error fails open to [] -- report generation is never blocked by MIC being unavailable", async () => {
  const db = { get: () => Promise.reject(new Error("REST_GET_FAILED:market_state_current:500")) };
  assert.deepEqual(await loadMicMarketContext(db), []);
});

test("loadMicMarketContext: a non-array or malformed response also fails open to []", async () => {
  const dbObject = { get: <T>() => Promise.resolve({ message: "unexpected" } as unknown as T) };
  assert.deepEqual(await loadMicMarketContext(dbObject), []);
  const dbThrowingJson = { get: () => { throw new SyntaxError("Unexpected token"); } };
  assert.deepEqual(await loadMicMarketContext(dbThrowingJson), []);
});

test("loadMicMarketContext: a no_change-only domain (current row unchanged, but present) still contributes context", async () => {
  // market_state_current is written by BOTH 'no_change' (status-only refresh)
  // and 'evaluated' runs; this module only ever reads that table, so there is
  // nothing here that distinguishes "last write was no_change" from
  // "last write was evaluated" -- and nothing needs to, since the row content
  // itself (narrative etc.) is what matters, not which RPC last touched it.
  const db = { get: <T>() => Promise.resolve([row({ domain: "rates" })] as unknown as T) };
  const states = await loadMicMarketContext(db);
  assert.equal(states.length, 1);
  assert.equal(states[0].narrative.length > 0, true);
});
