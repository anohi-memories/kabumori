import assert from "node:assert/strict";
import test from "node:test";
import {
  clampScenarioConfidence,
  classifyFreshness,
  classifyStates,
  confidenceCap,
  decideScenarioRegeneration,
  inputFingerprint,
  MIN_USABLE_DOMAINS,
  SCENARIO_PROMPT_VERSION,
  stateAsOf,
} from "./mic_scenario_state_logic.ts";
import type { ScenarioCurrentRow, StateRow } from "./mic_scenario_types.ts";

const NOW = Date.parse("2026-09-28T09:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const RUN = {
  rates: "11111111-1111-4111-8111-111111111111",
  macro: "22222222-2222-4222-8222-222222222222",
  equity_index: "33333333-3333-4333-8333-333333333333",
};

function stateRow(domain: "rates" | "macro" | "equity_index", overrides: Partial<StateRow> = {}): StateRow {
  return {
    domain,
    narrative: `${domain} narrative`,
    bullish_factors: ["b1"],
    bearish_factors: ["r1"],
    key_risks: ["k1"],
    ai_confidence: 0.8,
    data_confidence: 0.9,
    coverage_status: "full",
    observation_status: "fresh",
    ai_evaluated_at: hoursAgo(2),
    source_evaluation_run_id: RUN[domain],
    ...overrides,
  };
}

const allFresh = () => [stateRow("rates"), stateRow("macro"), stateRow("equity_index")];
const emptyCurrent: ScenarioCurrentRow = { updatedAt: "2026-09-28T00:00:00Z", sourceStateRunIds: [], inputFingerprint: null, sourceScenarioRunId: null };

test("freshness: per-domain thresholds (rates/equity daily, macro monthly)", () => {
  assert.equal(classifyFreshness("rates", hoursAgo(36), NOW), "fresh");
  assert.equal(classifyFreshness("rates", hoursAgo(37), NOW), "recent");
  assert.equal(classifyFreshness("equity_index", hoursAgo(96), NOW), "recent");
  assert.equal(classifyFreshness("equity_index", hoursAgo(97), NOW), "stale");
  assert.equal(classifyFreshness("macro", hoursAgo(24 * 7), NOW), "fresh");
  assert.equal(classifyFreshness("macro", hoursAgo(24 * 20), NOW), "recent");
  assert.equal(classifyFreshness("macro", hoursAgo(24 * 36), NOW), "stale");
});

test("freshness: missing, unparseable or far-future timestamps are unknown", () => {
  assert.equal(classifyFreshness("rates", null, NOW), "unknown");
  assert.equal(classifyFreshness("rates", "not a date", NOW), "unknown");
  assert.equal(classifyFreshness("rates", new Date(NOW + 3600_000).toISOString(), NOW), "unknown");
  assert.equal(classifyFreshness("rates", new Date(NOW + 60_000).toISOString(), NOW), "fresh", "small clock skew tolerated");
});

test("[A] fresh rates/macro/equity States are all usable and strong", () => {
  const { usable, excluded } = classifyStates(allFresh(), NOW);
  assert.deepEqual(usable.map((s) => [s.snapshot.domain, s.freshness, s.usability]), [
    ["rates", "fresh", "strong"], ["macro", "fresh", "strong"], ["equity_index", "fresh", "strong"],
  ]);
  assert.deepEqual(excluded, []);
  const decision = decideScenarioRegeneration({ usable, excluded }, emptyCurrent);
  assert.equal(decision.generate, true);
  assert.equal(decision.reason, "initial_scenario");
});

test("[F] the snapshot carries exactly the 11 State fields, copied verbatim", () => {
  const { usable } = classifyStates(allFresh(), NOW);
  assert.deepEqual(Object.keys(usable[0].snapshot).sort(), [
    "ai_confidence", "ai_evaluated_at", "bearish_factors", "bullish_factors", "coverage_status", "data_confidence",
    "domain", "key_risks", "narrative", "observation_status", "source_evaluation_run_id",
  ]);
  assert.deepEqual(usable[0].snapshot, { ...stateRow("rates") });
});

test("exclusions: every unusable State is excluded with an explicit reason, never silently used", () => {
  const cases: Array<[Partial<StateRow>, string]> = [
    [{ narrative: null }, "no_narrative"],
    [{ narrative: "  " }, "no_narrative"],
    [{ source_evaluation_run_id: null }, "no_source_evaluation_run"],
    [{ source_evaluation_run_id: "not-a-uuid" }, "no_source_evaluation_run"],
    [{ bullish_factors: null }, "malformed_state"],
    [{ key_risks: ["ok", 1] }, "malformed_state"],
    [{ ai_confidence: "0.8" }, "malformed_state"],
    [{ data_confidence: 1.2 }, "invalid_data_confidence"],
    [{ data_confidence: null }, "invalid_data_confidence"],
    [{ ai_evaluated_at: null }, "freshness_unknown"],
    [{ ai_evaluated_at: hoursAgo(200) }, "narrative_stale"],
    [{ coverage_status: "unavailable" }, "coverage_unavailable"],
    [{ data_confidence: 0.2 }, "data_confidence_too_low"],
  ];
  for (const [override, reason] of cases) {
    const { usable, excluded } = classifyStates([stateRow("rates", override), stateRow("macro"), stateRow("equity_index")], NOW);
    assert.deepEqual(excluded, [{ domain: "rates", reason }], JSON.stringify(override));
    assert.deepEqual(usable.map((s) => s.snapshot.domain), ["macro", "equity_index"]);
  }
});

test("exclusions: missing, duplicated or unknown-domain rows never become input", () => {
  const { excluded } = classifyStates([stateRow("rates"), stateRow("rates"), { ...stateRow("macro"), domain: "fx" }], NOW);
  assert.deepEqual(excluded, [
    { domain: "rates", reason: "state_row_duplicated" },
    { domain: "macro", reason: "state_row_missing" },
    { domain: "equity_index", reason: "state_row_missing" },
  ]);
});

test("weak: recent narrative, stale/unknown observations, partial coverage or low data_confidence mark a State weak", () => {
  const { usable } = classifyStates([
    stateRow("rates", { observation_status: "stale", data_confidence: 0.6 }),
    stateRow("macro", { coverage_status: "partial", observation_status: "unknown" }),
    stateRow("equity_index", { ai_evaluated_at: hoursAgo(50) }),
  ], NOW);
  assert.deepEqual(usable.map((s) => [s.snapshot.domain, s.usability, s.weakReasons]), [
    ["rates", "weak", ["observation_stale", "data_confidence_low"]],
    ["macro", "weak", ["observation_unknown", "coverage_partial"]],
    ["equity_index", "weak", ["narrative_recent"]],
  ]);
});

test("[D] all target States stale -> no AI (insufficient_usable_states)", () => {
  const classification = classifyStates([
    stateRow("rates", { ai_evaluated_at: hoursAgo(100) }),
    stateRow("macro", { ai_evaluated_at: hoursAgo(24 * 40) }),
    stateRow("equity_index", { ai_evaluated_at: hoursAgo(100) }),
  ], NOW);
  assert.equal(classification.usable.length, 0);
  const decision = decideScenarioRegeneration(classification, emptyCurrent);
  assert.deepEqual(decision, { generate: false, reason: "insufficient_usable_states", fingerprint: null });
});

test("a single usable State is not enough for a cross-domain Scenario", () => {
  assert.equal(MIN_USABLE_DOMAINS, 2);
  const classification = classifyStates([
    stateRow("rates"), stateRow("macro", { ai_evaluated_at: hoursAgo(24 * 40) }), stateRow("equity_index", { narrative: null }),
  ], NOW);
  assert.equal(decideScenarioRegeneration(classification, emptyCurrent).generate, false);
});

test("[E] one stale domain: the Scenario is generated from the usable States only", () => {
  const classification = classifyStates([
    stateRow("rates"), stateRow("macro", { ai_evaluated_at: hoursAgo(24 * 40) }), stateRow("equity_index"),
  ], NOW);
  const decision = decideScenarioRegeneration(classification, emptyCurrent);
  assert.equal(decision.generate, true);
  assert.equal(decision.fingerprint, `${SCENARIO_PROMPT_VERSION}|equity_index:${RUN.equity_index}|rates:${RUN.rates}`);
  assert.deepEqual(classification.excluded, [{ domain: "macro", reason: "narrative_stale" }]);
});

test("[B] unchanged source_evaluation_run_ids -> no AI", () => {
  const classification = classifyStates(allFresh(), NOW);
  const current: ScenarioCurrentRow = {
    updatedAt: "x", sourceStateRunIds: [RUN.rates, RUN.macro, RUN.equity_index],
    inputFingerprint: inputFingerprint(classification.usable), sourceScenarioRunId: "s1",
  };
  assert.equal(decideScenarioRegeneration(classification, current).generate, false);
  assert.equal(decideScenarioRegeneration(classification, current).reason, "no_new_state_evaluation");
});

test("[C] a no_change status refresh (quality signals change, same run id) -> no AI", () => {
  const current: ScenarioCurrentRow = {
    updatedAt: "x", sourceStateRunIds: [RUN.rates, RUN.macro, RUN.equity_index], inputFingerprint: "old", sourceScenarioRunId: "s1",
  };
  const refreshed = classifyStates([
    stateRow("rates", { data_confidence: 0.6, observation_status: "stale" }), stateRow("macro"), stateRow("equity_index"),
  ], NOW);
  assert.deepEqual(decideScenarioRegeneration(refreshed, current), {
    generate: false, reason: "no_new_state_evaluation", fingerprint: inputFingerprint(refreshed.usable),
  });
});

test("a State aging out (usable set shrinks, nothing new) -> no AI", () => {
  const current: ScenarioCurrentRow = {
    updatedAt: "x", sourceStateRunIds: [RUN.rates, RUN.macro, RUN.equity_index], inputFingerprint: "old", sourceScenarioRunId: "s1",
  };
  const shrunk = classifyStates([stateRow("rates"), stateRow("macro", { ai_evaluated_at: hoursAgo(24 * 40) }), stateRow("equity_index")], NOW);
  assert.equal(decideScenarioRegeneration(shrunk, current).generate, false);
});

test("a newly evaluated State (new run id) triggers regeneration and names the domain", () => {
  const current: ScenarioCurrentRow = {
    updatedAt: "x", sourceStateRunIds: [RUN.rates, RUN.macro, RUN.equity_index], inputFingerprint: "old", sourceScenarioRunId: "s1",
  };
  const updated = classifyStates([
    stateRow("rates", { source_evaluation_run_id: "44444444-4444-4444-8444-444444444444" }), stateRow("macro"), stateRow("equity_index"),
  ], NOW);
  const decision = decideScenarioRegeneration(updated, current);
  assert.equal(decision.generate, true);
  assert.equal(decision.reason, "new_state_evaluation:rates");
});

test("[H] identical State set -> identical fingerprint regardless of row order (duplicate protection key)", () => {
  const a = inputFingerprint(classifyStates(allFresh(), NOW).usable);
  const b = inputFingerprint(classifyStates([...allFresh()].reverse(), NOW).usable);
  assert.equal(a, b);
  assert.equal(a, `${SCENARIO_PROMPT_VERSION}|equity_index:${RUN.equity_index}|macro:${RUN.macro}|rates:${RUN.rates}`);
});

test("[K] confidence cap: weakest data_confidence, recent narratives x0.8, -0.1 per excluded domain", () => {
  const { usable } = classifyStates([
    stateRow("rates", { data_confidence: 0.9 }), stateRow("macro", { data_confidence: 0.7 }), stateRow("equity_index", { ai_evaluated_at: hoursAgo(50), data_confidence: 1 }),
  ], NOW);
  assert.equal(confidenceCap(usable, 0), 0.7);
  const two = usable.filter((s) => s.snapshot.domain !== "macro");
  assert.ok(Math.abs(confidenceCap(two, 1) - 0.7) < 1e-9, "min(0.9, 1*0.8)=0.8, minus 0.1");
  assert.equal(confidenceCap([], 0), 0);
  assert.equal(confidenceCap(usable, 10), 0, "never negative");
});

test("[K] clamp: stored confidence never exceeds the cap or the AI's own confidence; indeterminate <= 0.3", () => {
  assert.deepEqual(clampScenarioConfidence(0.95, 0.72, "assessed"), { aiConfidence: 0.95, confidence: 0.72 });
  assert.deepEqual(clampScenarioConfidence(0.4, 0.9, "assessed"), { aiConfidence: 0.4, confidence: 0.4 });
  assert.deepEqual(clampScenarioConfidence(0.9, 0.9, "indeterminate"), { aiConfidence: 0.9, confidence: 0.3 });
  const odd = clampScenarioConfidence(0.87654, 0.9, "assessed");
  assert.ok(odd.confidence <= odd.aiConfidence && odd.confidence <= 0.87654);
  assert.equal(odd.aiConfidence, 0.877);
  const capped = clampScenarioConfidence(0.99, 0.72 * 0.8, "assessed");
  assert.ok(capped.confidence <= 0.72 * 0.8);
});

test("state_as_of is the oldest narrative used", () => {
  const { usable } = classifyStates([stateRow("rates", { ai_evaluated_at: hoursAgo(1) }), stateRow("equity_index", { ai_evaluated_at: hoursAgo(30) })], NOW);
  assert.equal(stateAsOf(usable), hoursAgo(30));
});
