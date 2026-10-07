// MIC Stage 1 Slice 0: shadow verification evidence (no DB, no network, no AI).
// Fixtures mirror Production rates (four metrics, abs threshold 0.05) and the
// 2026-10-05 Stage 0 observation (JGB moves 0.033 / 0.040 below threshold).
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCoverageStatus,
  detectNewObservations,
  evaluateEventMaterialChange,
  evaluateMaterialChange,
  rollUpObservationStatus,
  shouldSkipAiForStaleness,
} from "./mic_state_decision_logic.ts";
import {
  buildVerificationShadow,
  buildVerificationShadowSafe,
  computeFactsFingerprint,
  NOT_VERIFIABLE_REASONS,
  type VerificationShadow,
  type VerificationShadowInput,
} from "./mic_state_verification_shadow.ts";
import type { EventFact, FetchStatus, MetricDomainMapRow, MetricObservationRow, PriorState } from "./mic_state_types.ts";

const NARRATIVE_RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const absMapping = (metricKey: string, abs: number | null = 0.05, extra: Partial<MetricDomainMapRow> = {}) => ({
  metricKey,
  domain: "rates" as const,
  displayName: metricKey,
  pctChangeThreshold: null,
  absChangeThreshold: abs,
  alwaysMaterial: false,
  ...extra,
});

const RATES_MAP: MetricDomainMapRow[] = ["US2Y", "US10Y", "JGB2Y", "JGB10Y"].map((k) => absMapping(k));

function row(
  metricKey: string,
  value: number | null,
  observedDate: string | null,
  extra: Partial<MetricObservationRow> = {},
): MetricObservationRow {
  return {
    metricKey,
    domain: "rates",
    currentValue: value,
    previousValue: null,
    pctChange: null,
    absChange: null,
    unit: "percent",
    observedDate,
    observedAt: null,
    timePrecision: "date",
    fetchedAt: "2026-10-05T09:00:05.000Z",
    sourceKey: metricKey.startsWith("JGB") ? "mof_jgb" : "fred",
    provider: null,
    isOfficial: true,
    expectedLagMinutes: 5760,
    observationAgeMinutes: 1000,
    observationStatus: "fresh",
    ...extra,
  };
}

// Narrative of 2026-10-01 21:15 UTC, grounded in these observations.
const BASELINE: NonNullable<PriorState["numericBaselineSnapshot"]> = {
  US2Y: { value: 3.58, observedDate: "2026-10-01", observedAt: null },
  US10Y: { value: 4.12, observedDate: "2026-10-01", observedAt: null },
  JGB2Y: { value: 1.886, observedDate: "2026-10-01", observedAt: null },
  JGB10Y: { value: 3.057, observedDate: "2026-10-01", observedAt: null },
};

function prior(overrides: Partial<PriorState> = {}): PriorState {
  return {
    domain: "rates",
    narrativeIsNull: false,
    numericBaselineSnapshot: BASELINE,
    sourceEventIds: [],
    updatedAt: "2026-10-05T06:15:03.000Z",
    aiEvaluatedAt: "2026-10-01T21:15:08.000Z",
    sourceEvaluationRunId: NARRATIVE_RUN,
    ...overrides,
  };
}

// Facts unchanged since the narrative.
const UNCHANGED = () => [
  row("US2Y", 3.58, "2026-10-01"),
  row("US10Y", 4.12, "2026-10-01"),
  row("JGB2Y", 1.886, "2026-10-01"),
  row("JGB10Y", 3.057, "2026-10-01"),
];

// The same wiring as index.ts computeDomainDecision, with the real decision
// functions, so a test can never pass on a decision the evaluator would not make.
function shadowInput(opts: {
  metrics?: MetricObservationRow[];
  map?: MetricDomainMapRow[];
  prior?: PriorState;
  fetchStatus?: FetchStatus;
  unseenEvents?: EventFact[];
} = {}): VerificationShadowInput & { isMaterial: boolean } {
  const metrics = opts.metrics ?? UNCHANGED();
  const map = opts.map ?? RATES_MAP;
  const p = opts.prior ?? prior();
  const unseen = opts.unseenEvents ?? [];
  const metricDecision = evaluateMaterialChange(
    detectNewObservations(metrics, p.numericBaselineSnapshot),
    new Map(map.map((m) => [m.metricKey, m])),
  );
  const eventDecision = evaluateEventMaterialChange(unseen);
  const isMaterial = metricDecision.isMaterial || eventDecision.isMaterial ||
    (p.narrativeIsNull && metrics.some((m) => m.currentValue !== null));
  return {
    domain: "rates",
    prior: p,
    metrics,
    domainMap: map,
    metricDecision,
    eventDecision,
    unseenEvents: unseen,
    coverageStatus: computeCoverageStatus(
      map.map((m) => m.metricKey),
      metrics.filter((m) => m.currentValue !== null).map((m) => m.metricKey),
    ),
    fetchStatus: opts.fetchStatus ?? "fresh",
    observationStatus: rollUpObservationStatus(metrics.map((m) => m.observationStatus)),
    aiSuppressedByStaleGuard: isMaterial && shouldSkipAiForStaleness(metrics, eventDecision),
    isMaterial,
  };
}

const metricOf = (shadow: VerificationShadow, key: string) => {
  const entry = shadow.metrics.find((m) => m.metric_key === key);
  assert.ok(entry, `metric ${key} missing from shadow`);
  return entry;
};

// --- Production representative cases ---

test("Case A: no new FRED/JGB observation -> no_new_observation", async () => {
  const input = shadowInput();
  assert.equal(input.isMaterial, false, "an ordinary no_change pass");
  const shadow = await buildVerificationShadow(input);
  assert.equal(shadow.version, 1);
  assert.equal(shadow.status, "no_new_observation");
  assert.equal(shadow.reason, "no_new_observation");
  assert.deepEqual(shadow.blocking_reasons, []);
  assert.equal(shadow.new_observation_count, 0);
  assert.equal(shadow.checked_metric_count, 0);
  assert.equal(shadow.observation_as_of, null);
  assert.deepEqual(shadow.narrative_identity, {
    source_evaluation_run_id: NARRATIVE_RUN,
    ai_evaluated_at: "2026-10-01T21:15:08.000Z",
  });
  for (const m of shadow.metrics) {
    assert.equal(m.observation_change, "same");
    assert.equal(m.new_observation, false);
    assert.equal(m.result, "unchanged");
  }
});

test("Case B: new JGB2Y / JGB10Y observations moving 0.033 / 0.040 (threshold 0.05) -> below_threshold", async () => {
  const input = shadowInput({
    metrics: [
      row("US2Y", 3.58, "2026-10-01"),
      row("US10Y", 4.12, "2026-10-01"),
      row("JGB2Y", 1.919, "2026-10-02"),
      row("JGB10Y", 3.097, "2026-10-02"),
    ],
  });
  assert.equal(input.isMaterial, false);
  const shadow = await buildVerificationShadow(input);
  assert.equal(shadow.status, "below_threshold");
  assert.equal(shadow.reason, "below_threshold");
  assert.equal(shadow.new_observation_count, 2);
  assert.equal(shadow.checked_metric_count, 2);
  assert.equal(shadow.observation_as_of, "2026-10-02");
  const jgb2 = metricOf(shadow, "JGB2Y");
  assert.deepEqual(jgb2, {
    metric_key: "JGB2Y",
    registered: true,
    time_precision: "date",
    observation_status: "fresh",
    baseline: { value: "1.886", observed: "2026-10-01" },
    latest: { value: "1.919", observed: "2026-10-02" },
    observation_change: "new",
    new_observation: true,
    threshold: { kind: "abs", abs: "0.05", pct: null },
    abs_change: "0.033",
    threshold_reached: false,
    result: "below_threshold",
  });
  assert.equal(metricOf(shadow, "JGB10Y").abs_change, "0.04");
  assert.equal(metricOf(shadow, "US10Y").result, "unchanged");
});

test("Case C: identical value, newer observation date -> a new observation (below_threshold), NOT no_new_observation", async () => {
  const input = shadowInput({
    metrics: [
      row("US2Y", 3.58, "2026-10-01"),
      row("US10Y", 4.12, "2026-10-02"), // same value, next day
      row("JGB2Y", 1.886, "2026-10-01"),
      row("JGB10Y", 3.057, "2026-10-01"),
    ],
  });
  const shadow = await buildVerificationShadow(input);
  assert.equal(shadow.status, "below_threshold");
  assert.notEqual(shadow.status, "no_new_observation");
  assert.equal(shadow.new_observation_count, 1);
  const us10 = metricOf(shadow, "US10Y");
  assert.equal(us10.observation_change, "new");
  assert.equal(us10.abs_change, "0");
  assert.equal(us10.result, "below_threshold");
});

test("Case D: a move of exactly 5bp is material (AI route) and the shadow never reports it below threshold", async () => {
  const exact = shadowInput({
    prior: prior({ numericBaselineSnapshot: { ...BASELINE, US10Y: { value: 5.24, observedDate: "2026-10-01", observedAt: null } } }),
    metrics: [row("US2Y", 3.58, "2026-10-01"), row("US10Y", 5.29, "2026-10-02"), row("JGB2Y", 1.886, "2026-10-01"), row("JGB10Y", 3.057, "2026-10-01")],
  });
  assert.equal(exact.isMaterial, true, "5.24 -> 5.29 with threshold 0.05 goes to AI, never to no_change");
  const shadow = await buildVerificationShadow(exact);
  assert.equal(shadow.status, "not_verifiable");
  assert.equal(shadow.reason, "material_change");
  assert.equal(metricOf(shadow, "US10Y").result, "threshold_reached");
  assert.equal(metricOf(shadow, "US10Y").abs_change, "0.05");

  const below = shadowInput({
    prior: prior({ numericBaselineSnapshot: { ...BASELINE, US10Y: { value: 5.24, observedDate: "2026-10-01", observedAt: null } } }),
    metrics: [row("US2Y", 3.58, "2026-10-01"), row("US10Y", 5.289, "2026-10-02"), row("JGB2Y", 1.886, "2026-10-01"), row("JGB10Y", 3.057, "2026-10-01")],
  });
  assert.equal(below.isMaterial, false);
  const belowShadow = await buildVerificationShadow(below);
  assert.equal(belowShadow.status, "below_threshold");
  assert.equal(metricOf(belowShadow, "US10Y").abs_change, "0.049");
  assert.equal(metricOf(belowShadow, "US10Y").threshold_reached, false);
});

test("Case E: coverage partial -> not_verifiable / coverage_partial (metric_missing also recorded)", async () => {
  const input = shadowInput({
    metrics: [row("US2Y", 3.58, "2026-10-01"), row("US10Y", 4.13, "2026-10-02"), row("JGB10Y", 3.057, "2026-10-01")],
  });
  assert.equal(input.coverageStatus, "partial");
  const shadow = await buildVerificationShadow(input);
  assert.equal(shadow.status, "not_verifiable");
  assert.equal(shadow.reason, "coverage_partial");
  assert.deepEqual(shadow.blocking_reasons, ["coverage_partial", "metric_missing"]);
  const missing = metricOf(shadow, "JGB2Y");
  assert.equal(missing.result, "missing");
  assert.equal(missing.latest, null);
  assert.equal(shadow.new_observation_count, 1, "the new US10Y observation is still counted for audit");
});

test("Case F: fetch failed or stale -> not_verifiable / fetch_not_fresh (fetch success alone is never enough either)", async () => {
  const newObs = [row("US2Y", 3.58, "2026-10-01"), row("US10Y", 4.13, "2026-10-02"), row("JGB2Y", 1.886, "2026-10-01"), row("JGB10Y", 3.057, "2026-10-01")];
  for (const fetchStatus of ["failed", "stale", "unknown"] as const) {
    const shadow = await buildVerificationShadow(shadowInput({ metrics: newObs, fetchStatus }));
    assert.equal(shadow.status, "not_verifiable", fetchStatus);
    assert.equal(shadow.reason, "fetch_not_fresh", fetchStatus);
    assert.equal(shadow.gates?.fetch_status, fetchStatus);
  }
});

test("Case G: new observation on a metric with no threshold -> not_verifiable / threshold_undefined", async () => {
  const map = [...RATES_MAP.filter((m) => m.metricKey !== "US2Y"), absMapping("US2Y", null)];
  const input = shadowInput({
    map,
    metrics: [row("US2Y", 3.9, "2026-10-02"), row("US10Y", 4.12, "2026-10-01"), row("JGB2Y", 1.886, "2026-10-01"), row("JGB10Y", 3.057, "2026-10-01")],
  });
  assert.equal(input.isMaterial, false, "the existing rule never makes an undefined-threshold metric material");
  const shadow = await buildVerificationShadow(input);
  assert.equal(shadow.status, "not_verifiable");
  assert.equal(shadow.reason, "threshold_undefined");
  const us2 = metricOf(shadow, "US2Y");
  assert.deepEqual(us2.threshold, { kind: "undefined", abs: null, pct: null });
  assert.equal(us2.threshold_reached, null);
  assert.equal(us2.abs_change, "0.32");
  assert.equal(shadow.checked_metric_count, 0);
});

test("Case H: no new observation under an 11-day-old narrative is still only no_new_observation, never below_threshold", async () => {
  const input = shadowInput({ prior: prior({ aiEvaluatedAt: "2026-09-25T17:45:07.000Z" }) });
  const shadow = await buildVerificationShadow(input);
  assert.equal(shadow.status, "no_new_observation");
  assert.equal(shadow.checked_metric_count, 0);
  assert.equal(shadow.narrative_identity.ai_evaluated_at, "2026-09-25T17:45:07.000Z");
  // And with a stale observation it is not even that.
  const stale = UNCHANGED().map((m) => ({ ...m, observationStatus: "stale" as const }));
  const staleShadow = await buildVerificationShadow(shadowInput({ metrics: stale }));
  assert.equal(staleShadow.status, "not_verifiable");
  assert.equal(staleShadow.reason, "observation_not_acceptable");
});

// --- New-observation identity ---

test("same observation date, different value (revision) is not a new observation -> observation_revised", async () => {
  const input = shadowInput({
    metrics: [row("US2Y", 3.58, "2026-10-01"), row("US10Y", 4.13, "2026-10-01"), row("JGB2Y", 1.886, "2026-10-01"), row("JGB10Y", 3.057, "2026-10-01")],
  });
  assert.equal(input.isMaterial, false);
  const shadow = await buildVerificationShadow(input);
  assert.equal(shadow.status, "not_verifiable");
  assert.equal(shadow.reason, "observation_revised");
  assert.equal(shadow.new_observation_count, 0);
  const us10 = metricOf(shadow, "US10Y");
  assert.equal(us10.observation_change, "revised");
  assert.equal(us10.new_observation, false);
  assert.equal(us10.result, "revised_same_observation");
  assert.equal(us10.threshold_reached, false, "still compared, with the same helper, for the record");
});

test("an observation older than the baseline's -> observation_regressed", async () => {
  const shadow = await buildVerificationShadow(shadowInput({
    metrics: [row("US2Y", 3.58, "2026-09-30"), row("US10Y", 4.12, "2026-10-01"), row("JGB2Y", 1.886, "2026-10-01"), row("JGB10Y", 3.057, "2026-10-01")],
  }));
  assert.equal(shadow.reason, "observation_regressed");
  assert.equal(metricOf(shadow, "US2Y").observation_change, "older");
});

test("missing or malformed observation identity -> observation_identity_missing", async () => {
  for (const broken of [
    row("US10Y", 4.13, null),
    row("US10Y", 4.13, "2026-10-32"),
    row("US10Y", 4.13, "2026-10-02", { timePrecision: null }),
  ]) {
    const metrics = [row("US2Y", 3.58, "2026-10-01"), broken, row("JGB2Y", 1.886, "2026-10-01"), row("JGB10Y", 3.057, "2026-10-01")];
    const shadow = await buildVerificationShadow(shadowInput({ metrics }));
    assert.equal(shadow.status, "not_verifiable");
    assert.equal(shadow.reason, "observation_identity_missing");
    assert.equal(metricOf(shadow, "US10Y").new_observation, false);
  }
});

test("timestamp precision compares instants, not strings", async () => {
  const map = [absMapping("NIKKEI", null, { pctChangeThreshold: 1.0, domain: "equity_index" })];
  const base = { NIKKEI: { value: 39000, observedDate: null, observedAt: "2026-10-05T06:00:00+00:00" } };
  const sameInstant = row("NIKKEI", 39000, null, { timePrecision: "timestamp", observedAt: "2026-10-05T06:00:00Z" });
  const same = await buildVerificationShadow(shadowInput({ map, metrics: [sameInstant], prior: prior({ numericBaselineSnapshot: base }) }));
  assert.equal(same.status, "no_new_observation");
  assert.equal(metricOf(same, "NIKKEI").observation_change, "same");

  const later = row("NIKKEI", 39100, null, { timePrecision: "timestamp", observedAt: "2026-10-06T06:00:00Z" });
  const next = await buildVerificationShadow(shadowInput({ map, metrics: [later], prior: prior({ numericBaselineSnapshot: base }) }));
  assert.equal(next.status, "below_threshold");
  assert.equal(next.observation_as_of, "2026-10-06T06:00:00.000Z");
  assert.deepEqual(metricOf(next, "NIKKEI").threshold, { kind: "pct", abs: null, pct: "1" });
});

// --- Threshold semantics shared with evaluateMaterialChange ---

test("always_material new observation goes to the material route, never to below_threshold", async () => {
  const map = [...RATES_MAP.filter((m) => m.metricKey !== "US2Y"), absMapping("US2Y", 0.05, { alwaysMaterial: true })];
  const input = shadowInput({
    map,
    metrics: [row("US2Y", 3.58, "2026-10-02"), row("US10Y", 4.12, "2026-10-01"), row("JGB2Y", 1.886, "2026-10-01"), row("JGB10Y", 3.057, "2026-10-01")],
  });
  assert.equal(input.isMaterial, true);
  const shadow = await buildVerificationShadow(input);
  assert.equal(shadow.reason, "material_change");
  assert.equal(metricOf(shadow, "US2Y").result, "always_material");
});

test("pct threshold below -> below_threshold; pct threshold against a zero baseline -> comparison_unavailable", async () => {
  const map = [absMapping("X", null, { pctChangeThreshold: 1 })];
  const base = (value: number) => prior({ numericBaselineSnapshot: { X: { value, observedDate: "2026-10-01", observedAt: null } } });
  const ok = await buildVerificationShadow(shadowInput({ map, prior: base(100), metrics: [row("X", 100.99, "2026-10-02")] }));
  assert.equal(ok.status, "below_threshold");
  const reached = shadowInput({ map, prior: base(100), metrics: [row("X", 101, "2026-10-02")] });
  assert.equal(reached.isMaterial, true, "exactly 1% is material");
  const zero = shadowInput({ map, prior: base(0), metrics: [row("X", 0.5, "2026-10-02")] });
  assert.equal(zero.isMaterial, false, "existing rule skips pct against a zero baseline");
  const zeroShadow = await buildVerificationShadow(zero);
  assert.equal(zeroShadow.reason, "comparison_unavailable");
});

test("threshold verdicts agree with evaluateMaterialChange across the 0.05 boundary (abs and pct)", async () => {
  const pctMap = [absMapping("US10Y", null, { pctChangeThreshold: 1 })];
  for (let k = 0; k <= 120; k++) {
    const latest = Number((5.24 + k / 1000).toFixed(3));
    for (const map of [[absMapping("US10Y")], pctMap]) {
      const input = shadowInput({
        map,
        prior: prior({ numericBaselineSnapshot: { US10Y: { value: 5.24, observedDate: "2026-10-01", observedAt: null } } }),
        metrics: [row("US10Y", latest, "2026-10-02")],
      });
      const shadow = await buildVerificationShadow(input);
      assert.ok(!shadow.blocking_reasons.includes("comparison_mismatch"), `mismatch at ${latest}`);
      assert.equal(metricOf(shadow, "US10Y").threshold_reached, input.isMaterial, `verdict at ${latest}`);
      assert.equal(shadow.status === "below_threshold", !input.isMaterial, `status at ${latest}`);
    }
  }
});

test("a disagreement with the material decision is recorded as comparison_mismatch", async () => {
  const input = shadowInput({
    metrics: [row("US2Y", 3.58, "2026-10-01"), row("US10Y", 4.13, "2026-10-02"), row("JGB2Y", 1.886, "2026-10-01"), row("JGB10Y", 3.057, "2026-10-01")],
  });
  const shadow = await buildVerificationShadow({
    ...input,
    metricDecision: { isMaterial: false, materialMetricKeys: ["JGB2Y"], reason: "fabricated" },
  });
  assert.equal(shadow.reason, "comparison_mismatch");
});

// --- Other gates ---

test("all-stale guard (material decision suppressed) -> not_verifiable / all_stale_guard", async () => {
  const metrics = [...UNCHANGED(), row("US5Y", 3.7, "2026-08-31", { observationStatus: "stale" })]
    .map((m) => ({ ...m, observationStatus: "stale" as const }));
  const input = shadowInput({ metrics, map: [...RATES_MAP, absMapping("US5Y")] });
  assert.equal(input.isMaterial, true, "first observation of US5Y");
  assert.equal(input.aiSuppressedByStaleGuard, true);
  const shadow = await buildVerificationShadow(input);
  assert.equal(shadow.reason, "all_stale_guard");
  assert.equal(shadow.gates?.ai_suppressed_by_stale_guard, true);
  assert.equal(metricOf(shadow, "US5Y").result, "first_observation");
});

test("current State without a narrative identity -> identity_missing", async () => {
  for (const p of [prior({ sourceEvaluationRunId: null }), prior({ aiEvaluatedAt: null }), prior({ narrativeIsNull: true })]) {
    const shadow = await buildVerificationShadow(shadowInput({ prior: p }));
    assert.equal(shadow.status, "not_verifiable");
    assert.equal(shadow.reason, "identity_missing");
  }
});

test("delayed_expected observations are acceptable", async () => {
  const metrics = [
    row("US2Y", 3.58, "2026-10-01", { observationStatus: "delayed_expected" }),
    row("US10Y", 4.12, "2026-10-01", { observationStatus: "delayed_expected" }),
    row("JGB2Y", 1.919, "2026-10-02"),
    row("JGB10Y", 3.097, "2026-10-02"),
  ];
  const shadow = await buildVerificationShadow(shadowInput({ metrics }));
  assert.equal(shadow.status, "below_threshold");
  assert.equal(shadow.gates?.observation_status, "delayed_expected");
});

test("unseen non-material events are recorded (ids only) without blocking", async () => {
  const event: EventFact = {
    id: "ev-1", title: "t", summary: "s", importance: "medium", eventType: "rate_decision",
    publishedAt: "2026-10-04T00:00:00Z", updatedAt: null,
  };
  const shadow = await buildVerificationShadow(shadowInput({ unseenEvents: [event] }));
  assert.equal(shadow.status, "no_new_observation");
  assert.deepEqual(shadow.gates?.unseen_event_ids, ["ev-1"]);
  assert.ok(!JSON.stringify(shadow).includes("\"t\""), "event text is not copied");
});

// --- Fingerprint ---

test("facts fingerprint is deterministic, order-independent and sensitive to every Fact input", async () => {
  const metrics = [row("US2Y", 3.58, "2026-10-01"), row("US10Y", 4.12, "2026-10-01"), row("JGB2Y", 1.919, "2026-10-02"), row("JGB10Y", 3.097, "2026-10-02")];
  const event: EventFact = { id: "ev-1", title: "t", summary: "s", importance: "low", eventType: "rate_decision", publishedAt: "2026-10-04T00:00:00Z", updatedAt: null };
  const event2: EventFact = { ...event, id: "ev-2" };
  const a = await computeFactsFingerprint(shadowInput({ metrics, unseenEvents: [event, event2] }));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await computeFactsFingerprint(shadowInput({ metrics, unseenEvents: [event, event2] })), a);
  assert.equal(
    await computeFactsFingerprint(shadowInput({ metrics: [...metrics].reverse(), map: [...RATES_MAP].reverse(), unseenEvents: [event2, event] })),
    a,
    "input order must not matter",
  );
  // 3.097 and 3.0970 are the same decimal.
  const sameDecimal = metrics.map((m) => m.metricKey === "JGB10Y" ? { ...m, currentValue: Number("3.0970") } : m);
  assert.equal(await computeFactsFingerprint(shadowInput({ metrics: sameDecimal, unseenEvents: [event, event2] })), a);

  const variants: Array<Parameters<typeof shadowInput>[0]> = [
    { metrics: metrics.map((m) => m.metricKey === "JGB10Y" ? { ...m, currentValue: 3.098 } : m), unseenEvents: [event, event2] },
    { metrics: metrics.map((m) => m.metricKey === "JGB10Y" ? { ...m, observedDate: "2026-10-03" } : m), unseenEvents: [event, event2] },
    { metrics, unseenEvents: [event] },
    { metrics, unseenEvents: [event, event2], prior: prior({ sourceEvaluationRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }) },
    { metrics, unseenEvents: [event, event2], map: RATES_MAP.map((m) => m.metricKey === "JGB10Y" ? { ...m, absChangeThreshold: 0.04 } : m) },
    { metrics, unseenEvents: [event, event2], prior: prior({ numericBaselineSnapshot: { ...BASELINE, JGB2Y: { value: 1.887, observedDate: "2026-10-01", observedAt: null } } }) },
  ];
  const seen = new Set([a]);
  for (const variant of variants) {
    const fp = await computeFactsFingerprint(shadowInput(variant));
    assert.ok(!seen.has(fp), "every Fact input must change the fingerprint");
    seen.add(fp);
  }
});

test("derived statuses are not fingerprint inputs", async () => {
  const a = await computeFactsFingerprint(shadowInput());
  assert.equal(await computeFactsFingerprint(shadowInput({ fetchStatus: "failed" })), a);
  assert.equal(await computeFactsFingerprint({ ...shadowInput(), observationStatus: "stale", coverageStatus: "partial" }), a);
});

// --- Shape and failure isolation ---

test("the shadow is plain JSON with a fixed key set (no raw payload, no extra metadata)", async () => {
  const shadow = await buildVerificationShadow(shadowInput({
    metrics: [row("US2Y", 3.58, "2026-10-01"), row("US10Y", 4.12, "2026-10-01"), row("JGB2Y", 1.919, "2026-10-02"), row("JGB10Y", 3.097, "2026-10-02")],
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(shadow)), shadow);
  assert.deepEqual(Object.keys(shadow).sort(), [
    "blocking_reasons", "checked_metric_count", "facts_fingerprint", "gates", "metrics", "narrative_identity",
    "new_observation_count", "observation_as_of", "reason", "registered_metric_count", "status", "version",
  ]);
  for (const m of shadow.metrics) {
    assert.deepEqual(Object.keys(m).sort(), [
      "abs_change", "baseline", "latest", "metric_key", "new_observation", "observation_change", "observation_status",
      "registered", "result", "threshold", "threshold_reached", "time_precision",
    ]);
  }
  assert.ok(!JSON.stringify(shadow).includes("fred"), "source keys / provider metadata are not copied");
});

test("blocking reasons are reported in precedence order and the primary reason is the first", async () => {
  const shadow = await buildVerificationShadow(shadowInput({
    metrics: [row("US2Y", 3.58, "2026-10-01"), row("US10Y", 4.13, "2026-10-01")],
    fetchStatus: "stale",
  }));
  assert.equal(shadow.reason, "fetch_not_fresh");
  const order = shadow.blocking_reasons.map((r) => NOT_VERIFIABLE_REASONS.indexOf(r as typeof NOT_VERIFIABLE_REASONS[number]));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  assert.deepEqual(shadow.blocking_reasons, ["fetch_not_fresh", "coverage_partial", "metric_missing", "observation_revised"]);
});

test("buildVerificationShadowSafe never throws: an internal error becomes not_verifiable / shadow_error", async () => {
  const broken = { ...shadowInput(), metrics: null as unknown as MetricObservationRow[] };
  await assert.rejects(() => buildVerificationShadow(broken));
  const shadow = await buildVerificationShadowSafe(broken);
  assert.equal(shadow.version, 1);
  assert.equal(shadow.status, "not_verifiable");
  assert.equal(shadow.reason, "shadow_error");
  assert.deepEqual(shadow.blocking_reasons, ["shadow_error"]);
  assert.equal(shadow.narrative_identity.source_evaluation_run_id, NARRATIVE_RUN);
  assert.equal(shadow.facts_fingerprint, null);

  const hostile = new Proxy({}, { get: () => { throw new Error("boom"); } }) as VerificationShadowInput;
  const hostileShadow = await buildVerificationShadowSafe(hostile);
  assert.equal(hostileShadow.reason, "shadow_error");
  assert.deepEqual(hostileShadow.narrative_identity, { source_evaluation_run_id: null, ai_evaluated_at: null });
});
