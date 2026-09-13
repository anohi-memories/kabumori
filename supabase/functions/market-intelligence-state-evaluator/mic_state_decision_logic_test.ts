import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCoverageStatus,
  computeDataConfidence,
  computeRunWindow,
  detectNewObservations,
  eventTypesForDomain,
  evaluateEventMaterialChange,
  evaluateMaterialChange,
  rollUpFetchStatus,
  rollUpObservationStatus,
} from "./mic_state_decision_logic.ts";
import type { EventFact, MetricDomainMapRow, MetricObservationRow } from "./mic_state_types.ts";

function metric(overrides: Partial<MetricObservationRow> = {}): MetricObservationRow {
  return {
    metricKey: "US10Y",
    domain: "rates",
    currentValue: 4.5,
    previousValue: 4.4,
    pctChange: 2.27,
    absChange: 0.1,
    unit: "percent",
    observedDate: "2026-09-10",
    observedAt: null,
    timePrecision: "date",
    fetchedAt: "2026-09-12T00:00:00.000Z",
    sourceKey: "fred",
    provider: "FRED",
    isOfficial: true,
    expectedLagMinutes: 1440,
    observationAgeMinutes: 2880,
    observationStatus: "fresh",
    ...overrides,
  };
}

function mapRow(overrides: Partial<MetricDomainMapRow> = {}): MetricDomainMapRow {
  return {
    metricKey: "US10Y",
    domain: "rates",
    displayName: "US10Y",
    pctChangeThreshold: null,
    absChangeThreshold: 0.05,
    alwaysMaterial: false,
    ...overrides,
  };
}

test("computeRunWindow buckets by domain and UTC hour", () => {
  const now = new Date("2026-09-13T09:45:00.000Z");
  assert.equal(computeRunWindow("rates", now), "rates:2026-09-13T09");
});

// --- detectNewObservations ---

test("detectNewObservations: no baseline entry -> first_observation", () => {
  const result = detectNewObservations([metric()], {});
  assert.deepEqual(result, [
    { metricKey: "US10Y", currentValue: 4.5, previousBaselineValue: null, reason: "first_observation" },
  ]);
});

test("detectNewObservations: value changed vs baseline -> value_changed", () => {
  const result = detectNewObservations([metric({ currentValue: 4.6 })], {
    US10Y: { value: 4.5, observedDate: "2026-09-10", observedAt: null },
  });
  assert.deepEqual(result, [
    { metricKey: "US10Y", currentValue: 4.6, previousBaselineValue: 4.5, reason: "value_changed" },
  ]);
});

test("detectNewObservations: same value but newer observed_date -> observation_time_changed", () => {
  const result = detectNewObservations([metric({ currentValue: 4.5, observedDate: "2026-09-11" })], {
    US10Y: { value: 4.5, observedDate: "2026-09-10", observedAt: null },
  });
  assert.deepEqual(result, [
    { metricKey: "US10Y", currentValue: 4.5, previousBaselineValue: 4.5, reason: "observation_time_changed" },
  ]);
});

test("detectNewObservations: identical value and observed_date -> no observation", () => {
  const result = detectNewObservations([metric()], {
    US10Y: { value: 4.5, observedDate: "2026-09-10", observedAt: null },
  });
  assert.deepEqual(result, []);
});

test("detectNewObservations: skips metrics with no Fact yet (currentValue null)", () => {
  const result = detectNewObservations([metric({ currentValue: null })], {});
  assert.deepEqual(result, []);
});

test("detectNewObservations: timestamp precision compares observed_at, not observed_date", () => {
  const result = detectNewObservations(
    [metric({ timePrecision: "timestamp", observedAt: "2026-09-13T10:00:00.000Z", observedDate: "2026-09-13" })],
    { US10Y: { value: 4.5, observedDate: "2026-09-13", observedAt: "2026-09-13T09:00:00.000Z" } },
  );
  assert.equal(result[0]?.reason, "observation_time_changed");
});

// --- evaluateMaterialChange ---

test("evaluateMaterialChange: always_material flags any new observation as material", () => {
  const domainMap = new Map([["CPI", mapRow({ metricKey: "CPI", alwaysMaterial: true, absChangeThreshold: null })]]);
  const decision = evaluateMaterialChange(
    [{ metricKey: "CPI", currentValue: 3.1, previousBaselineValue: 3.0, reason: "value_changed" }],
    domainMap,
  );
  assert.equal(decision.isMaterial, true);
  assert.deepEqual(decision.materialMetricKeys, ["CPI"]);
});

test("evaluateMaterialChange: first_observation (no baseline) is always material regardless of threshold", () => {
  const domainMap = new Map([["US10Y", mapRow({ absChangeThreshold: 0.05 })]]);
  const decision = evaluateMaterialChange(
    [{ metricKey: "US10Y", currentValue: 4.5, previousBaselineValue: null, reason: "first_observation" }],
    domainMap,
  );
  assert.equal(decision.isMaterial, true);
});

test("evaluateMaterialChange: abs_change below threshold is not material", () => {
  const domainMap = new Map([["US10Y", mapRow({ absChangeThreshold: 0.05 })]]);
  const decision = evaluateMaterialChange(
    [{ metricKey: "US10Y", currentValue: 4.52, previousBaselineValue: 4.5, reason: "value_changed" }],
    domainMap,
  );
  assert.equal(decision.isMaterial, false);
});

test("evaluateMaterialChange: abs_change at/above threshold is material", () => {
  const domainMap = new Map([["US10Y", mapRow({ absChangeThreshold: 0.05 })]]);
  const decision = evaluateMaterialChange(
    [{ metricKey: "US10Y", currentValue: 4.56, previousBaselineValue: 4.5, reason: "value_changed" }],
    domainMap,
  );
  assert.equal(decision.isMaterial, true);
  assert.match(decision.reason, /US10Y/);
});

test("evaluateMaterialChange: pct_change threshold path (commodities-style)", () => {
  const domainMap = new Map([
    ["WTI", mapRow({ metricKey: "WTI", domain: "commodities", pctChangeThreshold: 3.0, absChangeThreshold: null })],
  ]);
  const below = evaluateMaterialChange(
    [{ metricKey: "WTI", currentValue: 70, previousBaselineValue: 68.5, reason: "value_changed" }], // ~2.19%
    domainMap,
  );
  assert.equal(below.isMaterial, false);

  const above = evaluateMaterialChange(
    [{ metricKey: "WTI", currentValue: 71, previousBaselineValue: 68, reason: "value_changed" }], // ~4.41%
    domainMap,
  );
  assert.equal(above.isMaterial, true);
});

test("evaluateMaterialChange: one material metric makes the whole domain material even with others unchanged", () => {
  const domainMap = new Map([
    ["US2Y", mapRow({ metricKey: "US2Y", absChangeThreshold: 0.05 })],
    ["US10Y", mapRow({ metricKey: "US10Y", absChangeThreshold: 0.05 })],
  ]);
  const decision = evaluateMaterialChange(
    [
      { metricKey: "US2Y", currentValue: 4.61, previousBaselineValue: 4.60, reason: "value_changed" }, // below threshold
      { metricKey: "US10Y", currentValue: 4.60, previousBaselineValue: 4.50, reason: "value_changed" }, // above threshold
    ],
    domainMap,
  );
  assert.equal(decision.isMaterial, true);
  assert.deepEqual(decision.materialMetricKeys, ["US10Y"]);
});

test("evaluateMaterialChange: no new observations -> not material", () => {
  const decision = evaluateMaterialChange([], new Map());
  assert.equal(decision.isMaterial, false);
});

// --- event-driven ---

test("eventTypesForDomain: geopolitical/corporate_events/rates/macro are mapped; equity_index is not (open question)", () => {
  assert.deepEqual(eventTypesForDomain("geopolitical"), ["geopolitical", "sanction", "political_statement"]);
  assert.ok(eventTypesForDomain("corporate_events").includes("regulatory"));
  assert.deepEqual(eventTypesForDomain("rates"), ["rate_decision"]);
  assert.deepEqual(eventTypesForDomain("macro"), ["macro_release"]);
  assert.deepEqual(eventTypesForDomain("equity_index"), []);
});

function event(overrides: Partial<EventFact> = {}): EventFact {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    title: "t",
    summary: "s",
    importance: "high",
    eventType: "regulatory",
    publishedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

test("evaluateEventMaterialChange: high/critical importance is material, low/medium/null is not", () => {
  assert.equal(evaluateEventMaterialChange([event({ importance: "high" })]).isMaterial, true);
  assert.equal(evaluateEventMaterialChange([event({ importance: "critical" })]).isMaterial, true);
  assert.equal(evaluateEventMaterialChange([event({ importance: "medium" })]).isMaterial, false);
  assert.equal(evaluateEventMaterialChange([event({ importance: "low" })]).isMaterial, false);
  assert.equal(evaluateEventMaterialChange([event({ importance: null })]).isMaterial, false);
  assert.equal(evaluateEventMaterialChange([]).isMaterial, false);
});

// --- roll-ups ---

test("rollUpFetchStatus: worst case wins, failed > stale > unknown > fresh", () => {
  assert.equal(rollUpFetchStatus(["fresh", "fresh"]), "fresh");
  assert.equal(rollUpFetchStatus(["fresh", "stale"]), "stale");
  assert.equal(rollUpFetchStatus(["fresh", "failed", "stale"]), "failed");
  assert.equal(rollUpFetchStatus([]), "unknown");
});

test("rollUpObservationStatus: worst case wins, stale > delayed_expected > unknown > fresh", () => {
  assert.equal(rollUpObservationStatus(["fresh", "fresh"]), "fresh");
  assert.equal(rollUpObservationStatus(["fresh", "delayed_expected"]), "delayed_expected");
  assert.equal(rollUpObservationStatus(["fresh", "stale", "delayed_expected"]), "stale");
  assert.equal(rollUpObservationStatus([]), "unknown");
});

// --- coverage ---

test("computeCoverageStatus: full/partial/unavailable", () => {
  assert.equal(computeCoverageStatus([], []), "unavailable");
  assert.equal(computeCoverageStatus(["A", "B"], []), "unavailable");
  assert.equal(computeCoverageStatus(["A", "B"], ["A"]), "partial");
  assert.equal(computeCoverageStatus(["A", "B"], ["A", "B"]), "full");
});

// --- confidence ---

test("computeDataConfidence: unavailable coverage is always 0", () => {
  assert.equal(computeDataConfidence("unavailable", "fresh", "fresh"), 0);
});

test("computeDataConfidence: fetch failed is heavily penalized even if data looks fine otherwise", () => {
  assert.equal(computeDataConfidence("full", "failed", "fresh"), 0.2);
});

test("computeDataConfidence: full + fresh + fresh is highest", () => {
  assert.equal(computeDataConfidence("full", "fresh", "fresh"), 1.0);
});

test("computeDataConfidence: stays within [0, 1]", () => {
  const value = computeDataConfidence("partial", "stale", "stale");
  assert.ok(value >= 0 && value <= 1);
});
