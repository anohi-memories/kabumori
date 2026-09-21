import assert from "node:assert/strict";
import test from "node:test";
import {
  clampAiConfidence,
  computeCoverageStatus,
  computeDataConfidence,
  computeRunWindow,
  detectNewObservations,
  eventTypesForDomain,
  evaluateEventMaterialChange,
  evaluateMaterialChange,
  rollUpFetchStatus,
  rollUpObservationStatus,
  shouldSkipAiForStaleness,
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

// Fed target range is daily in FRED but only changes at policy decisions.
// A repeated value on a new effective date must not make rates material.
test("Fed target-range rates: first observation is material, unchanged daily repeats are not", () => {
  const metrics = [
    metric({ metricKey: "FED_FUNDS_TARGET_LOWER", currentValue: 3.5, observedDate: "2026-09-16" }),
    metric({ metricKey: "FED_FUNDS_TARGET_UPPER", currentValue: 3.75, observedDate: "2026-09-16" }),
  ];
  const mappings = new Map([
    ["FED_FUNDS_TARGET_LOWER", mapRow({ metricKey: "FED_FUNDS_TARGET_LOWER", absChangeThreshold: 0.01 })],
    ["FED_FUNDS_TARGET_UPPER", mapRow({ metricKey: "FED_FUNDS_TARGET_UPPER", absChangeThreshold: 0.01 })],
  ]);
  const first = detectNewObservations(metrics, {});
  assert.deepEqual(first.map((item) => item.reason), ["first_observation", "first_observation"]);
  assert.deepEqual(evaluateMaterialChange(first, mappings).materialMetricKeys, [
    "FED_FUNDS_TARGET_LOWER",
    "FED_FUNDS_TARGET_UPPER",
  ]);

  const baseline = {
    FED_FUNDS_TARGET_LOWER: { value: 3.5, observedDate: "2026-09-16", observedAt: null },
    FED_FUNDS_TARGET_UPPER: { value: 3.75, observedDate: "2026-09-16", observedAt: null },
  };
  const nextDay = metrics.map((item) => ({ ...item, observedDate: "2026-09-17" }));
  const repeated = detectNewObservations(nextDay, baseline);
  assert.deepEqual(repeated.map((item) => item.reason), ["observation_time_changed", "observation_time_changed"]);
  assert.equal(evaluateMaterialChange(repeated, mappings).isMaterial, false);
});

test("Fed target-range rates: lower-only, upper-only, and simultaneous changes are material", () => {
  const baseline = {
    FED_FUNDS_TARGET_LOWER: { value: 3.5, observedDate: "2026-09-16", observedAt: null },
    FED_FUNDS_TARGET_UPPER: { value: 3.75, observedDate: "2026-09-16", observedAt: null },
  };
  const mappings = new Map([
    ["FED_FUNDS_TARGET_LOWER", mapRow({ metricKey: "FED_FUNDS_TARGET_LOWER", absChangeThreshold: 0.01 })],
    ["FED_FUNDS_TARGET_UPPER", mapRow({ metricKey: "FED_FUNDS_TARGET_UPPER", absChangeThreshold: 0.01 })],
  ]);
  const lower = metric({ metricKey: "FED_FUNDS_TARGET_LOWER", currentValue: 3.75, observedDate: "2026-10-28" });
  const upper = metric({ metricKey: "FED_FUNDS_TARGET_UPPER", currentValue: 4.0, observedDate: "2026-10-28" });

  const lowerOnly = evaluateMaterialChange(detectNewObservations([lower], baseline), mappings);
  assert.deepEqual(lowerOnly.materialMetricKeys, ["FED_FUNDS_TARGET_LOWER"]);
  const upperOnly = evaluateMaterialChange(detectNewObservations([upper], baseline), mappings);
  assert.deepEqual(upperOnly.materialMetricKeys, ["FED_FUNDS_TARGET_UPPER"]);
  const both = evaluateMaterialChange(detectNewObservations([lower, upper], baseline), mappings);
  assert.deepEqual(both.materialMetricKeys, ["FED_FUNDS_TARGET_LOWER", "FED_FUNDS_TARGET_UPPER"]);
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

// --- fx / USDJPY (Frankfurter, Phase 1) ---
// The evaluator's decision logic is domain-agnostic -- these confirm the
// exact same generic functions (already proven for rates/commodities)
// produce the intended result for fx's 0.5% pct_change_threshold, without
// any evaluator code change. Only mic_metric_domain_map's seed data
// (20260918090000_mic_fx_phase1_usdjpy.sql) differs.

function usdjpyMapRow(overrides: Partial<MetricDomainMapRow> = {}): MetricDomainMapRow {
  return {
    metricKey: "USDJPY",
    domain: "fx",
    displayName: "USD/JPY",
    pctChangeThreshold: 0.5,
    absChangeThreshold: null,
    alwaysMaterial: false,
    ...overrides,
  };
}

test("fx/USDJPY: first observation (no baseline) is material regardless of the 0.5% threshold", () => {
  const domainMap = new Map([["USDJPY", usdjpyMapRow()]]);
  const observations = detectNewObservations(
    [metric({ metricKey: "USDJPY", domain: "fx", currentValue: 155.05, observedDate: "2026-09-16" })],
    {},
  );
  assert.deepEqual(observations, [
    { metricKey: "USDJPY", currentValue: 155.05, previousBaselineValue: null, reason: "first_observation" },
  ]);
  const decision = evaluateMaterialChange(observations, domainMap);
  assert.equal(decision.isMaterial, true);
});

test("fx/USDJPY: identical value and observed_date vs baseline -> no_change", () => {
  const domainMap = new Map([["USDJPY", usdjpyMapRow()]]);
  const observations = detectNewObservations(
    [metric({ metricKey: "USDJPY", domain: "fx", currentValue: 155.05, observedDate: "2026-09-16" })],
    { USDJPY: { value: 155.05, observedDate: "2026-09-16", observedAt: null } },
  );
  assert.deepEqual(observations, []);
  const decision = evaluateMaterialChange(observations, domainMap);
  assert.equal(decision.isMaterial, false);
});

test("fx/USDJPY: a >=0.5% move vs baseline is material", () => {
  const domainMap = new Map([["USDJPY", usdjpyMapRow()]]);
  // 155.05 -> 155.85 is +0.516%
  const observations = detectNewObservations(
    [metric({ metricKey: "USDJPY", domain: "fx", currentValue: 155.85, observedDate: "2026-09-17" })],
    { USDJPY: { value: 155.05, observedDate: "2026-09-16", observedAt: null } },
  );
  const decision = evaluateMaterialChange(observations, domainMap);
  assert.equal(decision.isMaterial, true);
  assert.deepEqual(decision.materialMetricKeys, ["USDJPY"]);
});

test("fx/USDJPY: a <0.5% move vs baseline is NOT material", () => {
  const domainMap = new Map([["USDJPY", usdjpyMapRow()]]);
  // 155.05 -> 155.30 is +0.161%
  const observations = detectNewObservations(
    [metric({ metricKey: "USDJPY", domain: "fx", currentValue: 155.30, observedDate: "2026-09-17" })],
    { USDJPY: { value: 155.05, observedDate: "2026-09-16", observedAt: null } },
  );
  const decision = evaluateMaterialChange(observations, domainMap);
  assert.equal(decision.isMaterial, false);
});

test("fx/USDJPY: stale metric is correctly classified and the all-stale guard fires for a stale-only fx domain", () => {
  const staleUsdjpy = metric({
    metricKey: "USDJPY",
    domain: "fx",
    observationStatus: "stale",
  });
  assert.equal(shouldSkipAiForStaleness([staleUsdjpy], evaluateEventMaterialChange([])), true);
});

// --- equity_index (FRED: NIKKEI225/SP500/NASDAQCOMPOSITE/NASDAQ100/VIX,
// Phase 1) ---
// Same point as the fx section above: the generic decision-logic
// functions (already proven for rates/commodities/fx) need zero code
// change to handle equity_index's thresholds correctly -- only
// mic_metric_domain_map's seed data (20260920090000_mic_equity_index_phase1.sql)
// differs.

function equityMapRow(overrides: Partial<MetricDomainMapRow> = {}): MetricDomainMapRow {
  return {
    metricKey: "NIKKEI225",
    domain: "equity_index",
    displayName: "Nikkei 225",
    pctChangeThreshold: 1.0,
    absChangeThreshold: null,
    alwaysMaterial: false,
    ...overrides,
  };
}

test("equity_index: first observation (no baseline) is material regardless of threshold", () => {
  const domainMap = new Map([["NIKKEI225", equityMapRow()]]);
  const observations = detectNewObservations(
    [metric({ metricKey: "NIKKEI225", domain: "equity_index", currentValue: 44800.12, observedDate: "2026-09-16" })],
    {},
  );
  assert.deepEqual(observations, [
    { metricKey: "NIKKEI225", currentValue: 44800.12, previousBaselineValue: null, reason: "first_observation" },
  ]);
  assert.equal(evaluateMaterialChange(observations, domainMap).isMaterial, true);
});

test("equity_index: identical value and observed_date vs baseline -> no_change", () => {
  const domainMap = new Map([["NIKKEI225", equityMapRow()]]);
  const observations = detectNewObservations(
    [metric({ metricKey: "NIKKEI225", domain: "equity_index", currentValue: 44800.12, observedDate: "2026-09-16" })],
    { NIKKEI225: { value: 44800.12, observedDate: "2026-09-16", observedAt: null } },
  );
  assert.deepEqual(observations, []);
  assert.equal(evaluateMaterialChange(observations, domainMap).isMaterial, false);
});

test("NIKKEI225/SP500 (1.0% threshold): a >=1.0% move is material, <1.0% is not", () => {
  const domainMap = new Map([["NIKKEI225", equityMapRow({ pctChangeThreshold: 1.0 })]]);
  const above = evaluateMaterialChange(
    // 44800 -> 45300 is +1.116%
    [{ metricKey: "NIKKEI225", currentValue: 45300, previousBaselineValue: 44800, reason: "value_changed" }],
    domainMap,
  );
  assert.equal(above.isMaterial, true);
  const below = evaluateMaterialChange(
    // 44800 -> 45050 is +0.558%
    [{ metricKey: "NIKKEI225", currentValue: 45050, previousBaselineValue: 44800, reason: "value_changed" }],
    domainMap,
  );
  assert.equal(below.isMaterial, false);
});

test("NASDAQCOMPOSITE/NASDAQ100 (1.2% threshold): a >=1.2% move is material, <1.2% is not", () => {
  const domainMap = new Map([["NASDAQCOMPOSITE", equityMapRow({ metricKey: "NASDAQCOMPOSITE", pctChangeThreshold: 1.2 })]]);
  const above = evaluateMaterialChange(
    // 22345.6 -> 22615 is +1.206%
    [{ metricKey: "NASDAQCOMPOSITE", currentValue: 22615, previousBaselineValue: 22345.6, reason: "value_changed" }],
    domainMap,
  );
  assert.equal(above.isMaterial, true);
  const below = evaluateMaterialChange(
    // 22345.6 -> 22500 is +0.691%
    [{ metricKey: "NASDAQCOMPOSITE", currentValue: 22500, previousBaselineValue: 22345.6, reason: "value_changed" }],
    domainMap,
  );
  assert.equal(below.isMaterial, false);
});

test("VIX: abs_change_threshold=2.0 alone triggers material even when pct_change is below 10%", () => {
  const domainMap = new Map([["VIX", equityMapRow({ metricKey: "VIX", pctChangeThreshold: 10.0, absChangeThreshold: 2.0 })]]);
  // 35 -> 37.5 is +2.5 abs (>=2.0) but only +7.14% (below 10%)
  const decision = evaluateMaterialChange(
    [{ metricKey: "VIX", currentValue: 37.5, previousBaselineValue: 35, reason: "value_changed" }],
    domainMap,
  );
  assert.equal(decision.isMaterial, true);
  assert.match(decision.reason, /abs_change/);
});

test("VIX: pct_change_threshold=10.0 alone triggers material even when abs_change is below 2.0", () => {
  const domainMap = new Map([["VIX", equityMapRow({ metricKey: "VIX", pctChangeThreshold: 10.0, absChangeThreshold: 2.0 })]]);
  // 12 -> 13.3 is +1.3 abs (below 2.0) but +10.83% (>=10%)
  const decision = evaluateMaterialChange(
    [{ metricKey: "VIX", currentValue: 13.3, previousBaselineValue: 12, reason: "value_changed" }],
    domainMap,
  );
  assert.equal(decision.isMaterial, true);
  assert.match(decision.reason, /pct_change/);
});

test("VIX: below both abs and pct thresholds -> not material", () => {
  const domainMap = new Map([["VIX", equityMapRow({ metricKey: "VIX", pctChangeThreshold: 10.0, absChangeThreshold: 2.0 })]]);
  // 17.2 -> 18.0 is +0.8 abs (below 2.0) and +4.65% (below 10%)
  const decision = evaluateMaterialChange(
    [{ metricKey: "VIX", currentValue: 18.0, previousBaselineValue: 17.2, reason: "value_changed" }],
    domainMap,
  );
  assert.equal(decision.isMaterial, false);
});

test("equity_index: stale metric correctly triggers the all-stale guard", () => {
  const staleNikkei = metric({ metricKey: "NIKKEI225", domain: "equity_index", observationStatus: "stale" });
  assert.equal(shouldSkipAiForStaleness([staleNikkei], evaluateEventMaterialChange([])), true);
});

// --- all-stale AI guard ---

function noMaterialEvents(): ReturnType<typeof evaluateEventMaterialChange> {
  return evaluateEventMaterialChange([]);
}

test("shouldSkipAiForStaleness: all metrics stale -> skip", () => {
  const metrics = [
    metric({ observationStatus: "stale" }),
    metric({ metricKey: "US2Y", observationStatus: "stale" }),
  ];
  assert.equal(shouldSkipAiForStaleness(metrics, noMaterialEvents()), true);
});

test("shouldSkipAiForStaleness: all metrics unknown -> skip", () => {
  const metrics = [metric({ observationStatus: "unknown" })];
  assert.equal(shouldSkipAiForStaleness(metrics, noMaterialEvents()), true);
});

test("shouldSkipAiForStaleness: mix of stale and unknown -> still skip", () => {
  const metrics = [
    metric({ observationStatus: "stale" }),
    metric({ metricKey: "US2Y", observationStatus: "unknown" }),
  ];
  assert.equal(shouldSkipAiForStaleness(metrics, noMaterialEvents()), true);
});

test("shouldSkipAiForStaleness: one fresh metric -> do not skip", () => {
  const metrics = [
    metric({ observationStatus: "fresh" }),
    metric({ metricKey: "JGB2Y", observationStatus: "stale" }),
  ];
  assert.equal(shouldSkipAiForStaleness(metrics, noMaterialEvents()), false);
});

test("shouldSkipAiForStaleness: delayed_expected counts as not-stale -> do not skip", () => {
  const metrics = [metric({ observationStatus: "delayed_expected" })];
  assert.equal(shouldSkipAiForStaleness(metrics, noMaterialEvents()), false);
});

test("shouldSkipAiForStaleness: a material event overrides the guard even if all metrics are stale", () => {
  const metrics = [metric({ observationStatus: "stale" })];
  const eventDecision = evaluateEventMaterialChange([event({ importance: "high" })]);
  assert.equal(shouldSkipAiForStaleness(metrics, eventDecision), false);
});

test("shouldSkipAiForStaleness: no registered metrics at all -> do not skip (nothing to guard)", () => {
  assert.equal(shouldSkipAiForStaleness([], noMaterialEvents()), false);
});

// --- confidence clamp ---

test("clampAiConfidence: AI confidence above data confidence is clamped down", () => {
  assert.equal(clampAiConfidence(0.85, 0.55), 0.55);
});

test("clampAiConfidence: AI confidence at or below data confidence passes through unchanged", () => {
  assert.equal(clampAiConfidence(0.4, 0.55), 0.4);
  assert.equal(clampAiConfidence(0.55, 0.55), 0.55);
});

test("clampAiConfidence: zero data confidence clamps to zero regardless of AI confidence", () => {
  assert.equal(clampAiConfidence(0.99, 0), 0);
});

// --- macro (FRED: US CPI/Core CPI/PCE/Core PCE/NFP/Unemployment Rate/GDP/
// Retail Sales, JP GDP -- Macro Indicators Phase 1A) ---
// Same point as the fx/equity_index sections above: the generic
// decision-logic functions need zero code change to handle macro's
// monthly/quarterly cadence and thresholds correctly -- only
// mic_metric_domain_map's seed data
// (20260922090000_mic_macro_indicators_phase1a.sql) differs. This section
// specifically exercises: first observation, unchanged (a plain re-fetch
// of the same observed_date/value), a new monthly observation (a later
// observed_date with a new value), a revision (same observed_date, a
// changed value -- detected as "value_changed", NOT a special case), the
// all-stale guard, and that macro's data-confidence computation uses the
// exact same domain-agnostic rollup as every other domain.

function cpiYoyMapRow(overrides: Partial<MetricDomainMapRow> = {}): MetricDomainMapRow {
  return {
    metricKey: "US_CPI_YOY",
    domain: "macro",
    displayName: "米CPI前年比",
    pctChangeThreshold: null,
    absChangeThreshold: null,
    alwaysMaterial: true,
    ...overrides,
  };
}

function cpiLevelMapRow(overrides: Partial<MetricDomainMapRow> = {}): MetricDomainMapRow {
  return {
    metricKey: "US_CPI",
    domain: "macro",
    displayName: "米CPI(消費者物価指数)",
    pctChangeThreshold: 0.3,
    absChangeThreshold: null,
    alwaysMaterial: false,
    ...overrides,
  };
}

test("macro/US_CPI_YOY: first observation (no baseline) is material regardless of always_material -- same code path as every other domain's first print", () => {
  const domainMap = new Map([["US_CPI_YOY", cpiYoyMapRow()]]);
  const observations = detectNewObservations(
    [metric({ metricKey: "US_CPI_YOY", domain: "macro", currentValue: 3.1, observedDate: "2026-08-01", unit: "percent" })],
    {},
  );
  assert.deepEqual(observations, [
    { metricKey: "US_CPI_YOY", currentValue: 3.1, previousBaselineValue: null, reason: "first_observation" },
  ]);
  const decision = evaluateMaterialChange(observations, domainMap);
  assert.equal(decision.isMaterial, true);
});

test("macro/US_CPI_YOY: unchanged -- a plain re-fetch of the same observed_date/value produces no observation and is not material", () => {
  const domainMap = new Map([["US_CPI_YOY", cpiYoyMapRow()]]);
  const observations = detectNewObservations(
    [metric({ metricKey: "US_CPI_YOY", domain: "macro", currentValue: 3.1, observedDate: "2026-08-01", unit: "percent" })],
    { US_CPI_YOY: { value: 3.1, observedDate: "2026-08-01", observedAt: null } },
  );
  assert.deepEqual(observations, [], "no new observation for an unchanged re-fetch, regardless of always_material");
  const decision = evaluateMaterialChange(observations, domainMap);
  assert.equal(decision.isMaterial, false);
});

test("macro/US_CPI_YOY: new monthly observation (a later observed_date with a new value) is detected as value_changed and is material via always_material", () => {
  const domainMap = new Map([["US_CPI_YOY", cpiYoyMapRow()]]);
  const observations = detectNewObservations(
    [metric({ metricKey: "US_CPI_YOY", domain: "macro", currentValue: 3.2, observedDate: "2026-09-01", unit: "percent" })],
    { US_CPI_YOY: { value: 3.1, observedDate: "2026-08-01", observedAt: null } },
  );
  assert.deepEqual(observations, [
    { metricKey: "US_CPI_YOY", currentValue: 3.2, previousBaselineValue: 3.1, reason: "value_changed" },
  ]);
  const decision = evaluateMaterialChange(observations, domainMap);
  assert.equal(decision.isMaterial, true);
  assert.deepEqual(decision.materialMetricKeys, ["US_CPI_YOY"]);
});

test("macro/US_CPI_YOY: revision -- SAME observed_date, a changed value is detected as value_changed (no special-cased 'revision' reason exists, nor is one needed) and is material via always_material", () => {
  const domainMap = new Map([["US_CPI_YOY", cpiYoyMapRow()]]);
  // The August print was originally captured as 3.1; a later FRED refresh
  // for the SAME 2026-08-01 observed_date now reports 3.2 (a revision).
  const observations = detectNewObservations(
    [metric({ metricKey: "US_CPI_YOY", domain: "macro", currentValue: 3.2, observedDate: "2026-08-01", unit: "percent" })],
    { US_CPI_YOY: { value: 3.1, observedDate: "2026-08-01", observedAt: null } },
  );
  assert.deepEqual(observations, [
    { metricKey: "US_CPI_YOY", currentValue: 3.2, previousBaselineValue: 3.1, reason: "value_changed" },
  ], "a same-observed_date revision is indistinguishable, at the State layer, from any other value change -- both correctly re-trigger evaluation");
  const decision = evaluateMaterialChange(observations, domainMap);
  assert.equal(decision.isMaterial, true);
});

test("macro/US_CPI (0.3% pct threshold, the level companion of US_CPI_YOY): a >=0.3% move is material, <0.3% is not", () => {
  const domainMap = new Map([["US_CPI", cpiLevelMapRow()]]);
  // 313.53 -> 314.53 is +0.319%
  const materialObservations = detectNewObservations(
    [metric({ metricKey: "US_CPI", domain: "macro", currentValue: 314.53, observedDate: "2026-09-01", unit: "cpi_index_1982_84_100" })],
    { US_CPI: { value: 313.53, observedDate: "2026-08-01", observedAt: null } },
  );
  assert.equal(evaluateMaterialChange(materialObservations, domainMap).isMaterial, true);

  // 313.53 -> 313.90 is +0.118%
  const nonMaterialObservations = detectNewObservations(
    [metric({ metricKey: "US_CPI", domain: "macro", currentValue: 313.90, observedDate: "2026-09-01", unit: "cpi_index_1982_84_100" })],
    { US_CPI: { value: 313.53, observedDate: "2026-08-01", observedAt: null } },
  );
  assert.equal(evaluateMaterialChange(nonMaterialObservations, domainMap).isMaterial, false);
});

test("macro: a stale-only macro domain correctly triggers the all-stale guard, same as every other domain", () => {
  const staleCpiYoy = metric({
    metricKey: "US_CPI_YOY",
    domain: "macro",
    observationStatus: "stale",
  });
  assert.equal(shouldSkipAiForStaleness([staleCpiYoy], evaluateEventMaterialChange([])), true);
});

test("macro: a fresh macro metric does NOT trigger the all-stale guard, even ~75 days after its observed_date (normal monthly gap, not staleness)", () => {
  const freshCpiYoy = metric({
    metricKey: "US_CPI_YOY",
    domain: "macro",
    observationStatus: "fresh",
    observationAgeMinutes: 75 * 1440,
  });
  assert.equal(shouldSkipAiForStaleness([freshCpiYoy], evaluateEventMaterialChange([])), false);
});

test("macro: computeDataConfidence uses the exact same domain-agnostic rollup as every other domain -- full coverage + fresh fetch/observation is highest confidence", () => {
  const full = computeDataConfidence("full", "fresh", "fresh");
  const partial = computeDataConfidence("partial", "fresh", "delayed_expected");
  const unavailable = computeDataConfidence("unavailable", "unknown", "unknown");
  assert.ok(full > partial);
  assert.ok(partial > unavailable);
  assert.equal(unavailable, 0);
});

// --- macro (e-Stat: Japan CPI / Core CPI -- Macro Indicators Phase 1B) ---
// Same point as every prior macro/fx/equity_index section: the generic
// decision-logic functions need zero code change for a brand-new source
// (e-Stat, not FRED) as long as mic_metric_domain_map has the right seed
// data -- confirming the domain-agnostic design holds even across sources,
// not just across metrics within one source.

function jpCpiYoyMapRow(overrides: Partial<MetricDomainMapRow> = {}): MetricDomainMapRow {
  return {
    metricKey: "JP_CPI_YOY",
    domain: "macro",
    displayName: "日本CPI前年比(全国・総合)",
    pctChangeThreshold: null,
    absChangeThreshold: null,
    alwaysMaterial: true,
    ...overrides,
  };
}

function jpCpiLevelMapRow(overrides: Partial<MetricDomainMapRow> = {}): MetricDomainMapRow {
  return {
    metricKey: "JP_CPI",
    domain: "macro",
    displayName: "日本CPI(全国・総合)",
    pctChangeThreshold: 0.3,
    absChangeThreshold: null,
    alwaysMaterial: false,
    ...overrides,
  };
}

test("macro/JP_CPI_YOY (e-Stat): first observation (no baseline) is material via always_material, same code path as every FRED macro metric", () => {
  const domainMap = new Map([["JP_CPI_YOY", jpCpiYoyMapRow()]]);
  const observations = detectNewObservations(
    [metric({ metricKey: "JP_CPI_YOY", domain: "macro", currentValue: 1.9, observedDate: "2026-08-01", unit: "percent", sourceKey: "estat", provider: "e-Stat" })],
    {},
  );
  assert.deepEqual(observations, [
    { metricKey: "JP_CPI_YOY", currentValue: 1.9, previousBaselineValue: null, reason: "first_observation" },
  ]);
  assert.equal(evaluateMaterialChange(observations, domainMap).isMaterial, true);
});

test("macro/JP_CPI_YOY (e-Stat): unchanged re-fetch of the same observed_date/value produces no observation, not material", () => {
  const domainMap = new Map([["JP_CPI_YOY", jpCpiYoyMapRow()]]);
  const observations = detectNewObservations(
    [metric({ metricKey: "JP_CPI_YOY", domain: "macro", currentValue: 1.9, observedDate: "2026-08-01", unit: "percent", sourceKey: "estat", provider: "e-Stat" })],
    { JP_CPI_YOY: { value: 1.9, observedDate: "2026-08-01", observedAt: null } },
  );
  assert.deepEqual(observations, []);
  assert.equal(evaluateMaterialChange(observations, domainMap).isMaterial, false);
});

test("macro/JP_CPI_YOY (e-Stat): a new month (later observed_date, changed value) is value_changed and material via always_material", () => {
  const domainMap = new Map([["JP_CPI_YOY", jpCpiYoyMapRow()]]);
  const observations = detectNewObservations(
    [metric({ metricKey: "JP_CPI_YOY", domain: "macro", currentValue: 2.0, observedDate: "2026-09-01", unit: "percent", sourceKey: "estat", provider: "e-Stat" })],
    { JP_CPI_YOY: { value: 1.9, observedDate: "2026-08-01", observedAt: null } },
  );
  assert.deepEqual(observations, [
    { metricKey: "JP_CPI_YOY", currentValue: 2.0, previousBaselineValue: 1.9, reason: "value_changed" },
  ]);
  assert.equal(evaluateMaterialChange(observations, domainMap).isMaterial, true);
});

test("macro/JP_CPI (0.3% pct threshold, the level companion of JP_CPI_YOY, e-Stat): a >=0.3% move is material, <0.3% is not", () => {
  const domainMap = new Map([["JP_CPI", jpCpiLevelMapRow()]]);
  // 102.2 -> 102.6 is +0.391%
  const materialObservations = detectNewObservations(
    [metric({ metricKey: "JP_CPI", domain: "macro", currentValue: 102.6, observedDate: "2026-09-01", unit: "cpi_index_2025_100", sourceKey: "estat", provider: "e-Stat" })],
    { JP_CPI: { value: 102.2, observedDate: "2026-08-01", observedAt: null } },
  );
  assert.equal(evaluateMaterialChange(materialObservations, domainMap).isMaterial, true);

  // 102.2 -> 102.4 is +0.196%
  const nonMaterialObservations = detectNewObservations(
    [metric({ metricKey: "JP_CPI", domain: "macro", currentValue: 102.4, observedDate: "2026-09-01", unit: "cpi_index_2025_100", sourceKey: "estat", provider: "e-Stat" })],
    { JP_CPI: { value: 102.2, observedDate: "2026-08-01", observedAt: null } },
  );
  assert.equal(evaluateMaterialChange(nonMaterialObservations, domainMap).isMaterial, false);
});

test("macro (e-Stat): a domain mixing FRED metrics (US_CPI_YOY) and e-Stat metrics (JP_CPI_YOY) in the same evaluation both surface as material observations -- confirms the 20-metric combined macro domain works with zero special-casing per source", () => {
  const domainMap = new Map([
    ["US_CPI_YOY", cpiYoyMapRow()],
    ["JP_CPI_YOY", jpCpiYoyMapRow()],
  ]);
  const observations = detectNewObservations(
    [
      metric({ metricKey: "US_CPI_YOY", domain: "macro", currentValue: 3.1, observedDate: "2026-08-01", unit: "percent", sourceKey: "fred", provider: "FRED" }),
      metric({ metricKey: "JP_CPI_YOY", domain: "macro", currentValue: 1.9, observedDate: "2026-08-01", unit: "percent", sourceKey: "estat", provider: "e-Stat" }),
    ],
    {},
  );
  const decision = evaluateMaterialChange(observations, domainMap);
  assert.equal(decision.isMaterial, true);
  assert.deepEqual(decision.materialMetricKeys.sort(), ["JP_CPI_YOY", "US_CPI_YOY"]);
});
