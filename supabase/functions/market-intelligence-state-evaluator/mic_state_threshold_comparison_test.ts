// Exact decimal threshold comparison (State freshness Stage 0).
// Production, rates US10Y, 2026-10-01: baseline 5.24, latest 5.29, threshold
// 0.05. In JS 5.29 - 5.24 = 0.04999999999999982, so a move of exactly the
// threshold was judged "no change". These tests pin the boundary.
import assert from "node:assert/strict";
import test from "node:test";
import {
  absChangeReaches,
  canonicalDecimal,
  evaluateMaterialChange,
  exactAbsChange,
  pctChangeReaches,
} from "./mic_state_decision_logic.ts";
import type { MetricDomainMapRow, NewObservation } from "./mic_state_types.ts";

function mapRow(overrides: Partial<MetricDomainMapRow> = {}): MetricDomainMapRow {
  return {
    metricKey: "US10Y", domain: "rates", displayName: "US10Y",
    pctChangeThreshold: null, absChangeThreshold: 0.05, alwaysMaterial: false, ...overrides,
  };
}

function changed(metricKey: string, previousBaselineValue: number, currentValue: number): NewObservation {
  return { metricKey, currentValue, previousBaselineValue, reason: "value_changed" };
}

const decide = (baseline: number, latest: number, row: Partial<MetricDomainMapRow> = {}) =>
  evaluateMaterialChange([changed("US10Y", baseline, latest)], new Map([["US10Y", mapRow(row)]]));

// The comparison this replaces, kept only to show what changed.
const legacyAbs = (current: number, baseline: number, threshold: number) => Math.abs(current - baseline) >= threshold;

test("the Production case: 5.24 -> 5.29 with threshold 0.05 is material (it was not, by float error)", () => {
  assert.equal(5.29 - 5.24, 0.04999999999999982, "the float result that hid the move");
  assert.equal(legacyAbs(5.29, 5.24, 0.05), false);
  const decision = decide(5.24, 5.29);
  assert.equal(decision.isMaterial, true);
  assert.deepEqual(decision.materialMetricKeys, ["US10Y"]);
  assert.equal(decision.reason, "US10Y: abs_change 0.05 >= 0.05");
});

test("absolute threshold boundary: just below is not material, exactly and just above are", () => {
  assert.equal(decide(5.24, 5.289).isMaterial, false, "0.049 < 0.05");
  assert.equal(decide(5.24, 5.2899).isMaterial, false, "0.0499 < 0.05");
  assert.equal(decide(5.24, 5.29).isMaterial, true, "exactly 0.05");
  assert.equal(decide(5.24, 5.2901).isMaterial, true, "0.0501 > 0.05");
  assert.equal(decide(5.24, 5.3).isMaterial, true);
});

test("direction does not matter: 5.24 -> 5.19 is material, 5.24 -> 5.191 is not", () => {
  const down = decide(5.24, 5.19);
  assert.equal(down.isMaterial, true);
  assert.equal(down.reason, "US10Y: abs_change 0.05 >= 0.05");
  assert.equal(decide(5.24, 5.191).isMaterial, false);
  assert.equal(decide(-0.1, -0.15).isMaterial, true, "negative yields");
  assert.equal(decide(-0.02, 0.03).isMaterial, true, "crossing zero: 0.05");
  assert.equal(decide(-0.02, 0.029).isMaterial, false, "crossing zero: 0.049");
});

test("other float-unsafe exact boundaries now reach their threshold", () => {
  for (const [baseline, latest, threshold] of [
    [4.87, 4.92, 0.05], [2.943, 2.993, 0.05], [3.75, 3.76, 0.01], [14.2, 16.2, 2], [0.1, 0.3, 0.2], [1.1, 1.15, 0.05],
  ]) {
    assert.equal(absChangeReaches(latest, baseline, threshold).reached, true, `${baseline} -> ${latest} (>= ${threshold})`);
    assert.equal(absChangeReaches(baseline, latest, threshold).reached, true, "symmetric");
  }
});

test("threshold 0 and no threshold behave as before", () => {
  assert.equal(decide(5.24, 5.2401, { absChangeThreshold: 0 }).isMaterial, true);
  assert.equal(decide(5.24, 5.24, { absChangeThreshold: 0 }).isMaterial, true, "0 >= 0, as with the old comparison");
  assert.equal(legacyAbs(5.24, 5.24, 0), true);
  assert.equal(decide(5.24, 9.99, { absChangeThreshold: null, pctChangeThreshold: null }).isMaterial, false, "no threshold configured");
});

test("exactness on the whole 0.01 grid: the decision equals integer arithmetic; only exact-threshold pairs changed", () => {
  let changedDecisions = 0;
  for (let i = 300; i <= 700; i++) {
    for (let j = 300; j <= 700; j++) {
      const [baseline, latest] = [i / 100, j / 100];
      const truth = Math.abs(i - j) >= 5;
      const now = absChangeReaches(latest, baseline, 0.05).reached;
      assert.equal(now, truth, `${baseline} -> ${latest}`);
      if (legacyAbs(latest, baseline, 0.05) !== truth) {
        changedDecisions++;
        assert.equal(Math.abs(i - j), 5, `the old comparison was only wrong exactly at the threshold (${baseline} -> ${latest})`);
      }
    }
  }
  assert.ok(changedDecisions > 0, "the float error really occurred on this grid");
});

test("three-decimal metrics (JGB) on a 0.001 grid", () => {
  for (let i = 2900; i <= 3100; i++) {
    for (let j = 2900; j <= 3100; j += 7) {
      assert.equal(absChangeReaches(j / 1000, i / 1000, 0.05).reached, Math.abs(i - j) >= 50, `${i / 1000} -> ${j / 1000}`);
    }
  }
});

test("percentage threshold: exact at the boundary, below and above", () => {
  // 1% of 200 is 2.
  assert.equal(pctChangeReaches(202, 200, 1), true);
  assert.equal(pctChangeReaches(201.99, 200, 1), false);
  assert.equal(pctChangeReaches(198, 200, 1), true, "direction does not matter");
  // 1.1 -> 1.111 is exactly 1%; float gives 0.99999...
  assert.ok(Math.abs((1.111 - 1.1) / 1.1 * 100) < 1, "the float result is below 1");
  assert.equal(pctChangeReaches(1.111, 1.1, 1), true);
  assert.equal(pctChangeReaches(1.1109, 1.1, 1), false);
  // Fractional thresholds (fx 0.5%, equity 1.2%).
  assert.equal(pctChangeReaches(150.75, 150, 0.5), true, "exactly 0.5%");
  assert.equal(pctChangeReaches(150.74, 150, 0.5), false);
  assert.equal(pctChangeReaches(30364.2, 30004.15, 1.2), true);
  assert.equal(pctChangeReaches(25303, 25000, 1.2), true, "1.212%");
  assert.equal(pctChangeReaches(25300, 25000, 1.2), true, "exactly 1.2%");
  assert.equal(pctChangeReaches(25299.99, 25000, 1.2), false);
  assert.equal(pctChangeReaches(-98, -100, 2), true, "negative baseline uses its magnitude");
});

test("percentage decision equals exact rational arithmetic on a grid (no divide, no float)", () => {
  for (let base = 9950; base <= 10050; base += 3) { // cents
    for (let cur = 9800; cur <= 10200; cur += 1) {
      for (const [threshold, tenths] of [[1, 10], [1.2, 12], [0.5, 5], [3, 30]] as const) {
        // |cur-base| / base * 100 >= threshold  <=>  |cur-base| * 1000 >= tenths * base
        const truth = Math.abs(cur - base) * 1000 >= tenths * base;
        assert.equal(pctChangeReaches(cur / 100, base / 100, threshold), truth, `${base / 100} -> ${cur / 100} @ ${threshold}%`);
      }
    }
  }
});

test("evaluateMaterialChange: pct path and the abs-or-pct rule keep working", () => {
  const vix = { metricKey: "VIX", domain: "equity_index" as const, absChangeThreshold: 2, pctChangeThreshold: 10 };
  const run = (baseline: number, latest: number) =>
    evaluateMaterialChange([changed("VIX", baseline, latest)], new Map([["VIX", mapRow(vix)]]));
  assert.match(run(30, 32).reason, /abs_change 2 >= 2/, "abs alone (6.7%)");
  assert.match(run(14, 15.4).reason, /pct_change 10\.000% >= 10%/, "pct alone (abs 1.4)");
  assert.equal(run(14, 15.39).isMaterial, false, "9.93% and abs 1.39");
  const nikkei = evaluateMaterialChange(
    [changed("NIKKEI225", 66753.72, 68956.72)],
    new Map([["NIKKEI225", mapRow({ metricKey: "NIKKEI225", domain: "equity_index", absChangeThreshold: null, pctChangeThreshold: 1 })]]),
  );
  assert.equal(nikkei.isMaterial, true);
  assert.match(nikkei.reason, /pct_change 3\.300% >= 1%/);
});

test("exponent notation retains exact decimal boundaries without a float fallback", () => {
  assert.equal(absChangeReaches(1.111e-7, 1.1e-7, 1.1e-9).reached, true);
  assert.equal(absChangeReaches(1.1109e-7, 1.1e-7, 1.1e-9).reached, false);
  assert.equal(absChangeReaches(-1.111e-7, -1.1e-7, 1.1e-9).change, "0.0000000011");
  assert.equal(absChangeReaches(2e-7, 1e-7, 1e-7).reached, true);
  assert.equal(absChangeReaches(1e21, 1, 5).reached, true);
  assert.equal(pctChangeReaches(2e-7, 1e-7, 50), true);
  assert.equal(pctChangeReaches(1.111e-7, 1.1e-7, 1), true);
  assert.equal(pctChangeReaches(1.1109e-7, 1.1e-7, 1), false);
});

test("integer scaling handles subnormal and maximum finite values without overflow", () => {
  assert.equal(absChangeReaches(1e-323, 5e-324, 5e-324).reached, true);
  assert.equal(absChangeReaches(Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE).reached, true);
  assert.equal(pctChangeReaches(1e-323, 5e-324, 100), true);
  assert.equal(pctChangeReaches(Number.MAX_VALUE, -Number.MAX_VALUE, 200), true);
  assert.equal(pctChangeReaches(Number.MAX_VALUE, -Number.MAX_VALUE, 201), false);
});

test("invalid numbers and negative thresholds fail closed; percentage zero baseline is undefined", () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (const [current, baseline, threshold] of [[invalid, 1, 0.05], [1, invalid, 0.05], [1, 1, invalid]]) {
      assert.equal(absChangeReaches(current, baseline, threshold).reached, false);
      assert.equal(pctChangeReaches(current, baseline, threshold), false);
    }
  }
  assert.equal(absChangeReaches(1, 1, -0.05).reached, false);
  assert.equal(pctChangeReaches(1, 1, -0.05), false);
  assert.equal(pctChangeReaches(1, 0, 1), false);
});

test("Production snapshot 2026-10-01 (rates): the baseline the State was written from vs the latest Facts", () => {
  const rates = new Map<string, MetricDomainMapRow>([
    ["US2Y", mapRow({ metricKey: "US2Y" })],
    ["US10Y", mapRow({ metricKey: "US10Y" })],
    ["JGB2Y", mapRow({ metricKey: "JGB2Y" })],
    ["JGB10Y", mapRow({ metricKey: "JGB10Y" })],
    ["FED_FUNDS_TARGET_LOWER", mapRow({ metricKey: "FED_FUNDS_TARGET_LOWER", absChangeThreshold: 0.01 })],
    ["FED_FUNDS_TARGET_UPPER", mapRow({ metricKey: "FED_FUNDS_TARGET_UPPER", absChangeThreshold: 0.01 })],
  ]);
  // As ingested on 2026-10-01 21:00 UTC (JGB still the 08-31 rows from the history file).
  const observed = [
    changed("US10Y", 5.24, 5.29), changed("US2Y", 4.92, 4.88),
    { metricKey: "FED_FUNDS_TARGET_LOWER", currentValue: 3.75, previousBaselineValue: 3.75, reason: "observation_time_changed" as const },
    { metricKey: "FED_FUNDS_TARGET_UPPER", currentValue: 4, previousBaselineValue: 4, reason: "observation_time_changed" as const },
  ];
  const decision = evaluateMaterialChange(observed, rates);
  assert.equal(decision.isMaterial, true);
  assert.deepEqual(decision.materialMetricKeys, ["US10Y"], "only the 5 bp move; US2Y (-0.04) and the unchanged target range stay quiet");
  // Once the adapter reads the current MOF file, the JGB move since 08-31 is material too.
  const withJgb = evaluateMaterialChange([changed("JGB10Y", 2.943, 3.057), changed("JGB2Y", 1.743, 1.952)], rates);
  assert.deepEqual(withJgb.materialMetricKeys, ["JGB10Y", "JGB2Y"]);
  assert.match(withJgb.reason, /JGB10Y: abs_change 0\.114 >= 0\.05; JGB2Y: abs_change 0\.209 >= 0\.05/);
});

test("audit helpers: canonicalDecimal and exactAbsChange are exact and agree with absChangeReaches", () => {
  assert.equal(canonicalDecimal(5.24), "5.24");
  assert.equal(canonicalDecimal(Number("3.0970")), "3.097");
  assert.equal(canonicalDecimal(1e-7), "0.0000001");
  assert.equal(canonicalDecimal(-0.5), "-0.5");
  assert.equal(canonicalDecimal(Number.NaN), null);
  assert.equal(exactAbsChange(5.29, 5.24), "0.05");
  assert.equal(exactAbsChange(5.289, 5.24), "0.049");
  assert.equal(exactAbsChange(5.24, 5.29), "0.05");
  assert.equal(exactAbsChange(4.12, 4.12), "0");
  assert.equal(exactAbsChange(Number.POSITIVE_INFINITY, 1), null);
  for (const [current, baseline] of [[5.29, 5.24], [3.097, 3.057], [1.919, 1.886]]) {
    assert.equal(exactAbsChange(current, baseline), absChangeReaches(current, baseline, 0.05).change);
  }
});
