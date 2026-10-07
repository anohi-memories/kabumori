// MIC Stage 1 Slice 0: shadow verification evidence for State no_change runs.
//
// Observation only. The result rides along in the no_change run's
// decision_detail.verification_shadow and is read by nothing: it never feeds
// the material decision, the AI gate, the State write, data_confidence or any
// Scenario input. Its job is to make three different no_change situations
// auditable, which the run's reason ("no metric crossed its threshold") could
// not tell apart:
//
//   no_new_observation  no metric has an observation newer than the one the
//                       current narrative was written on;
//   below_threshold     at least one newer observation exists and every one
//                       was compared, exactly, and stayed below its threshold;
//   not_verifiable      something prevents treating this pass as a
//                       verification candidate (reason says what).
//
// "New observation" is decided by observation identity (metric_key plus the
// observed date or timestamp, per time_precision) moving strictly past the
// one in numeric_baseline_snapshot -- never by the value. The same value on a
// later date IS a new observation; a different value on the same date is a
// revision whose newness cannot be proven, so it is not_verifiable.
//
// Threshold comparisons reuse the Stage 0 exact-decimal helpers, in the same
// order evaluateMaterialChange applies them, and the result is cross-checked
// against that decision (comparison_mismatch if they ever disagree).
import {
  absChangeReaches,
  canonicalDecimal,
  detectNewObservations,
  exactAbsChange,
  pctChangeReaches,
} from "./mic_state_decision_logic.ts";
import type {
  CoverageStatus,
  Domain,
  EventFact,
  FetchStatus,
  MaterialChangeDecision,
  MetricDomainMapRow,
  MetricObservationRow,
  ObservationStatus,
  PriorState,
} from "./mic_state_types.ts";

export const VERIFICATION_SHADOW_VERSION = 1;

export type VerificationShadowStatus = "no_new_observation" | "below_threshold" | "not_verifiable";

// Blocking reasons, highest priority first; `reason` is the first one present.
export const NOT_VERIFIABLE_REASONS = [
  "identity_missing", // current State has no narrative / source run / AI time
  "all_stale_guard", // material decision suppressed because every metric is stale/unknown
  "material_change", // a metric or event is material (AI route, not a no_change)
  "comparison_mismatch", // this module and evaluateMaterialChange disagree
  "fetch_not_fresh",
  "coverage_unavailable",
  "coverage_partial",
  "metric_missing", // a registered metric has no Fact
  "observation_not_acceptable", // domain observation_status is stale or unknown
  "observation_identity_missing", // observation date/time missing or unparseable
  "observation_regressed", // latest observation is older than the baseline's
  "observation_revised", // same observation identity, different value
  "threshold_undefined", // new observation, no threshold and not always_material
  "comparison_unavailable", // a defined threshold could not be compared exactly
] as const;

export type NotVerifiableReason = typeof NOT_VERIFIABLE_REASONS[number] | "shadow_error";

export type ObservationChange =
  | "new" // identity strictly later than the baseline's
  | "first" // no baseline entry for this metric
  | "same" // same identity, same value
  | "revised" // same identity, different value
  | "older" // identity earlier than the baseline's
  | "identity_missing"
  | "missing"; // no Fact for this metric

export type MetricResult =
  | "unchanged"
  | "below_threshold"
  | "threshold_reached"
  | "always_material"
  | "first_observation"
  | "threshold_undefined"
  | "comparison_unavailable"
  | "revised_same_observation"
  | "older_observation"
  | "observation_identity_missing"
  | "missing"
  | "unmapped";

export type ThresholdKind = "abs" | "pct" | "abs_or_pct" | "always_material" | "undefined";

export type VerificationShadowMetric = {
  metric_key: string;
  registered: boolean;
  time_precision: "date" | "timestamp" | null;
  observation_status: ObservationStatus | null;
  baseline: { value: string | null; observed: string | null } | null;
  latest: { value: string | null; observed: string | null } | null;
  observation_change: ObservationChange;
  new_observation: boolean;
  threshold: { kind: ThresholdKind; abs: string | null; pct: string | null } | null;
  abs_change: string | null;
  threshold_reached: boolean | null;
  result: MetricResult;
};

export type VerificationShadow = {
  version: typeof VERIFICATION_SHADOW_VERSION;
  status: VerificationShadowStatus;
  reason: VerificationShadowStatus | NotVerifiableReason;
  blocking_reasons: NotVerifiableReason[];
  narrative_identity: { source_evaluation_run_id: string | null; ai_evaluated_at: string | null };
  registered_metric_count: number | null;
  new_observation_count: number | null;
  checked_metric_count: number | null;
  observation_as_of: string | null;
  gates: {
    coverage_status: CoverageStatus;
    fetch_status: FetchStatus;
    observation_status: ObservationStatus;
    ai_suppressed_by_stale_guard: boolean;
    unseen_event_ids: string[];
  } | null;
  facts_fingerprint: string | null;
  metrics: VerificationShadowMetric[];
};

export type VerificationShadowInput = {
  domain: Domain;
  prior: PriorState;
  metrics: MetricObservationRow[];
  domainMap: MetricDomainMapRow[];
  metricDecision: MaterialChangeDecision;
  eventDecision: MaterialChangeDecision;
  unseenEvents: EventFact[];
  coverageStatus: CoverageStatus;
  fetchStatus: FetchStatus;
  observationStatus: ObservationStatus;
  // True only when the domain was material but the all-stale guard turned
  // the run into a no_change (index.ts shouldSkipAiForStaleness branch).
  aiSuppressedByStaleGuard: boolean;
};

type ObservationPoint = { text: string; ms: number };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Identity of one observation at its declared precision, normalized so the
// same instant written two ways ("+00:00" vs "Z") compares equal.
function observationPoint(
  precision: "date" | "timestamp" | null,
  observedDate: string | null,
  observedAt: string | null,
): ObservationPoint | null {
  if (precision === "date") {
    if (!observedDate || !DATE_PATTERN.test(observedDate)) return null;
    const ms = Date.parse(`${observedDate}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === observedDate
      ? { text: observedDate, ms }
      : null;
  }
  if (precision === "timestamp") {
    const ms = observedAt ? Date.parse(observedAt) : NaN;
    return Number.isFinite(ms) ? { text: new Date(ms).toISOString(), ms } : null;
  }
  return null;
}

const decimalOrNull = (value: number | null | undefined): string | null =>
  typeof value === "number" ? canonicalDecimal(value) : null;

function thresholdKind(mapping: MetricDomainMapRow): ThresholdKind {
  if (mapping.alwaysMaterial) return "always_material";
  if (mapping.absChangeThreshold !== null && mapping.pctChangeThreshold !== null) return "abs_or_pct";
  if (mapping.absChangeThreshold !== null) return "abs";
  if (mapping.pctChangeThreshold !== null) return "pct";
  return "undefined";
}

type Verdict = {
  result: "always_material" | "first_observation" | "threshold_reached" | "below_threshold" |
    "threshold_undefined" | "comparison_unavailable";
  reached: boolean | null;
};

// Same rule, same order, same helpers as evaluateMaterialChange.
function thresholdVerdict(current: number, baseline: number | null, mapping: MetricDomainMapRow): Verdict {
  if (mapping.alwaysMaterial) return { result: "always_material", reached: true };
  if (baseline === null) return { result: "first_observation", reached: true };

  let absCompared = false;
  if (mapping.absChangeThreshold !== null) {
    const abs = absChangeReaches(current, baseline, mapping.absChangeThreshold);
    if (abs.reached) return { result: "threshold_reached", reached: true };
    absCompared = abs.change !== "invalid";
  }
  let pctCompared = false;
  if (mapping.pctChangeThreshold !== null && baseline !== 0) {
    if (pctChangeReaches(current, baseline, mapping.pctChangeThreshold)) {
      return { result: "threshold_reached", reached: true };
    }
    pctCompared = Number.isFinite(current) && Number.isFinite(baseline) &&
      Number.isFinite(mapping.pctChangeThreshold) && mapping.pctChangeThreshold >= 0;
  }

  if (mapping.absChangeThreshold === null && mapping.pctChangeThreshold === null) {
    return { result: "threshold_undefined", reached: null };
  }
  // "Below threshold" only when every defined threshold was actually compared.
  const everyDefinedCompared = (mapping.absChangeThreshold === null || absCompared) &&
    (mapping.pctChangeThreshold === null || pctCompared);
  return everyDefinedCompared
    ? { result: "below_threshold", reached: false }
    : { result: "comparison_unavailable", reached: null };
}

const MATERIAL_RESULTS = new Set<MetricResult>(["always_material", "first_observation", "threshold_reached"]);

const METRIC_RESULT_REASON: Partial<Record<MetricResult, NotVerifiableReason>> = {
  always_material: "material_change",
  first_observation: "material_change",
  threshold_reached: "material_change",
  threshold_undefined: "threshold_undefined",
  comparison_unavailable: "comparison_unavailable",
  revised_same_observation: "observation_revised",
  older_observation: "observation_regressed",
  observation_identity_missing: "observation_identity_missing",
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Deterministic over the Facts the verdict rests on: canonical JSON tuples,
// sorted, so input order never changes the hash. Derived statuses (coverage,
// fetch, observation, data_confidence) are deliberately not inputs.
export async function computeFactsFingerprint(input: VerificationShadowInput): Promise<string> {
  const mapByKey = new Map(input.domainMap.map((m) => [m.metricKey, m]));
  const rowByKey = new Map(input.metrics.map((m) => [m.metricKey, m]));
  const keys = [...new Set([...mapByKey.keys(), ...rowByKey.keys()])];
  const lines: string[] = [
    JSON.stringify(["version", VERIFICATION_SHADOW_VERSION]),
    JSON.stringify(["domain", input.domain]),
    JSON.stringify(["narrative", input.prior.sourceEvaluationRunId]),
  ];
  for (const key of keys) {
    const row = rowByKey.get(key);
    const mapping = mapByKey.get(key);
    const prior = input.prior.numericBaselineSnapshot?.[key];
    const precision = row?.timePrecision ?? null;
    const latestObserved = row
      ? observationPoint(precision, row.observedDate, row.observedAt)?.text ??
        (precision === "timestamp" ? row.observedAt : row.observedDate)
      : null;
    const baselineObserved = prior
      ? observationPoint(precision, prior.observedDate, prior.observedAt)?.text ??
        (precision === "timestamp" ? prior.observedAt : prior.observedDate)
      : null;
    lines.push(JSON.stringify([
      "metric",
      key,
      precision,
      latestObserved ?? null,
      decimalOrNull(row?.currentValue),
      baselineObserved ?? null,
      decimalOrNull(prior?.value),
      mapping ? decimalOrNull(mapping.absChangeThreshold) : null,
      mapping ? decimalOrNull(mapping.pctChangeThreshold) : null,
      mapping ? mapping.alwaysMaterial : null,
    ]));
  }
  for (const event of input.unseenEvents) {
    lines.push(JSON.stringify(["event", event.id, event.updatedAt, event.importance]));
  }
  lines.sort();
  return `sha256:${await sha256Hex(lines.join("\n"))}`;
}

const sortedUnique = <T extends string>(values: T[]): T[] => [...new Set(values)].sort();

export async function buildVerificationShadow(input: VerificationShadowInput): Promise<VerificationShadow> {
  const mapByKey = new Map(input.domainMap.map((m) => [m.metricKey, m]));
  const rowByKey = new Map(input.metrics.map((m) => [m.metricKey, m]));
  const baseline = input.prior.numericBaselineSnapshot;
  // Metrics the existing material check looked at (value or time differs, or no baseline).
  const considered = new Set(detectNewObservations(input.metrics, baseline).map((o) => o.metricKey));

  const reasons: NotVerifiableReason[] = [];
  const metrics: VerificationShadowMetric[] = [];
  const shadowMaterialKeys: string[] = [];
  let newObservationCount = 0;
  let checkedMetricCount = 0;
  let latestNew: ObservationPoint | null = null;

  for (const key of [...new Set([...mapByKey.keys(), ...rowByKey.keys()])].sort()) {
    const row = rowByKey.get(key);
    const mapping = mapByKey.get(key);
    const prior = baseline?.[key];
    const precision = row?.timePrecision ?? null;
    const latestPoint = row ? observationPoint(precision, row.observedDate, row.observedAt) : null;
    const baselinePoint = prior ? observationPoint(precision, prior.observedDate, prior.observedAt) : null;

    const entry: VerificationShadowMetric = {
      metric_key: key,
      registered: mapping !== undefined,
      time_precision: precision,
      observation_status: row?.observationStatus ?? null,
      baseline: prior
        ? {
          value: decimalOrNull(prior.value),
          observed: baselinePoint?.text ?? (precision === "timestamp" ? prior.observedAt : prior.observedDate) ?? null,
        }
        : null,
      latest: row && row.currentValue !== null
        ? {
          value: decimalOrNull(row.currentValue),
          observed: latestPoint?.text ?? (precision === "timestamp" ? row.observedAt : row.observedDate) ?? null,
        }
        : null,
      observation_change: "missing",
      new_observation: false,
      threshold: mapping
        ? {
          kind: thresholdKind(mapping),
          abs: decimalOrNull(mapping.absChangeThreshold),
          pct: decimalOrNull(mapping.pctChangeThreshold),
        }
        : null,
      abs_change: null,
      threshold_reached: null,
      result: "missing",
    };
    metrics.push(entry);

    if (!row || row.currentValue === null) {
      if (mapping) reasons.push("metric_missing");
      continue;
    }
    const current = row.currentValue;

    // Observation identity, independent of the value.
    if (!prior) {
      entry.observation_change = "first";
    } else if (!latestPoint || !baselinePoint) {
      entry.observation_change = "identity_missing";
    } else if (latestPoint.ms > baselinePoint.ms) {
      entry.observation_change = "new";
    } else if (latestPoint.ms < baselinePoint.ms) {
      entry.observation_change = "older";
    } else {
      entry.observation_change = exactAbsChange(current, prior.value) === "0" ? "same" : "revised";
    }
    entry.new_observation = entry.observation_change === "new" || entry.observation_change === "first";
    if (entry.new_observation) {
      newObservationCount++;
      if (latestPoint && (!latestNew || latestPoint.ms > latestNew.ms)) latestNew = latestPoint;
    }
    if (prior) entry.abs_change = exactAbsChange(current, prior.value);

    if (!mapping) {
      entry.result = "unmapped";
      // evaluateMaterialChange skips unmapped metrics; a changed one is unjudged.
      if (considered.has(key)) reasons.push("comparison_unavailable");
      continue;
    }

    const verdict = considered.has(key) || entry.observation_change === "new" || entry.observation_change === "first"
      ? thresholdVerdict(current, prior ? prior.value : null, mapping)
      : null;
    if (verdict) {
      entry.threshold_reached = verdict.reached;
      if (considered.has(key) && MATERIAL_RESULTS.has(verdict.result)) shadowMaterialKeys.push(key);
    }

    switch (entry.observation_change) {
      case "first":
        entry.result = "first_observation";
        break;
      case "identity_missing":
        entry.result = "observation_identity_missing";
        break;
      case "older":
        entry.result = "older_observation";
        break;
      case "revised":
        entry.result = "revised_same_observation";
        break;
      case "same":
        entry.result = "unchanged";
        break;
      case "new":
        entry.result = verdict?.result ?? "comparison_unavailable";
        if (entry.result === "below_threshold" || entry.result === "threshold_reached") checkedMetricCount++;
        break;
    }
    const reason = METRIC_RESULT_REASON[entry.result];
    if (reason) reasons.push(reason);
    // A revision or regression that also reached its threshold is material too.
    if (verdict && entry.result !== verdict.result && MATERIAL_RESULTS.has(verdict.result)) {
      reasons.push("material_change");
    }
  }

  const { prior } = input;
  if (prior.narrativeIsNull || !prior.sourceEvaluationRunId || !prior.aiEvaluatedAt) reasons.push("identity_missing");
  if (input.aiSuppressedByStaleGuard) reasons.push("all_stale_guard");
  if (input.metricDecision.isMaterial || input.eventDecision.isMaterial) reasons.push("material_change");
  const existingMaterialKeys = sortedUnique(input.metricDecision.materialMetricKeys);
  const ownMaterialKeys = sortedUnique(shadowMaterialKeys);
  if (existingMaterialKeys.join("\n") !== ownMaterialKeys.join("\n")) reasons.push("comparison_mismatch");
  if (input.fetchStatus !== "fresh") reasons.push("fetch_not_fresh");
  if (input.coverageStatus === "unavailable") reasons.push("coverage_unavailable");
  if (input.coverageStatus === "partial") reasons.push("coverage_partial");
  if (input.observationStatus !== "fresh" && input.observationStatus !== "delayed_expected") {
    reasons.push("observation_not_acceptable");
  }

  const blocking = NOT_VERIFIABLE_REASONS.filter((r) => reasons.includes(r));
  const status: VerificationShadowStatus = blocking.length > 0
    ? "not_verifiable"
    : newObservationCount === 0
    ? "no_new_observation"
    : "below_threshold";

  return {
    version: VERIFICATION_SHADOW_VERSION,
    status,
    reason: status === "not_verifiable" ? blocking[0] : status,
    blocking_reasons: blocking,
    narrative_identity: {
      source_evaluation_run_id: prior.sourceEvaluationRunId,
      ai_evaluated_at: prior.aiEvaluatedAt,
    },
    registered_metric_count: mapByKey.size,
    new_observation_count: newObservationCount,
    checked_metric_count: checkedMetricCount,
    observation_as_of: (latestNew as ObservationPoint | null)?.text ?? null,
    gates: {
      coverage_status: input.coverageStatus,
      fetch_status: input.fetchStatus,
      observation_status: input.observationStatus,
      ai_suppressed_by_stale_guard: input.aiSuppressedByStaleGuard,
      unseen_event_ids: sortedUnique(input.unseenEvents.map((e) => e.id)),
    },
    facts_fingerprint: await computeFactsFingerprint(input),
    metrics,
  };
}

// Never throws: shadow evidence must not turn a successful State run into a
// failed one. Any internal error becomes not_verifiable / shadow_error.
export async function buildVerificationShadowSafe(input: VerificationShadowInput): Promise<VerificationShadow> {
  try {
    return await buildVerificationShadow(input);
  } catch {
    let identity: VerificationShadow["narrative_identity"] = { source_evaluation_run_id: null, ai_evaluated_at: null };
    try {
      identity = {
        source_evaluation_run_id: input.prior.sourceEvaluationRunId ?? null,
        ai_evaluated_at: input.prior.aiEvaluatedAt ?? null,
      };
    } catch {
      // keep the null identity
    }
    return {
      version: VERIFICATION_SHADOW_VERSION,
      status: "not_verifiable",
      reason: "shadow_error",
      blocking_reasons: ["shadow_error"],
      narrative_identity: identity,
      registered_metric_count: null,
      new_observation_count: null,
      checked_metric_count: null,
      observation_as_of: null,
      gates: null,
      facts_fingerprint: null,
      metrics: [],
    };
  }
}
