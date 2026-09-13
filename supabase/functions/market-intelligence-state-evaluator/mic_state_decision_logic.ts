// Pure, deterministic decision logic for the State evaluator. No network,
// no DB, no AI -- everything here is a plain function over already-fetched
// data, per docs/market-intelligence/PHASE_1B_STATE_LAYER.md sections 6 and 8.
//
// Two-step design (per the design doc's Phase-1B-review fix): Step 1
// (detectNewObservations) is a cheap, AI-irrelevant diff against the last
// evaluation's baseline. Step 2 (evaluateMaterialChange) decides, among
// those new observations, which ones actually warrant calling AI --
// "a new number arrived" and "this is material" are never conflated.
import type {
  CoverageStatus,
  EventFact,
  FetchStatus,
  MaterialChangeDecision,
  MetricDomainMapRow,
  MetricObservationRow,
  NewObservation,
  ObservationStatus,
  PriorState,
} from "./mic_state_types.ts";

export function computeRunWindow(domain: string, now: Date = new Date()): string {
  const bucket = now.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  return `${domain}:${bucket}`;
}

// Step 1: which metrics changed at all since the last evaluation's
// baseline snapshot? A metric with no baseline entry yet is
// "first_observation" -- this is what makes the very first evaluation of
// a domain (narrative still null) naturally produce at least one
// new_observation once any Fact exists, without a separate special case.
export function detectNewObservations(
  metrics: MetricObservationRow[],
  baseline: PriorState["numericBaselineSnapshot"],
): NewObservation[] {
  const observations: NewObservation[] = [];
  for (const metric of metrics) {
    if (metric.currentValue === null) continue; // no Fact yet for this metric_key
    const prior = baseline?.[metric.metricKey];
    if (!prior) {
      observations.push({
        metricKey: metric.metricKey,
        currentValue: metric.currentValue,
        previousBaselineValue: null,
        reason: "first_observation",
      });
      continue;
    }
    if (prior.value !== metric.currentValue) {
      observations.push({
        metricKey: metric.metricKey,
        currentValue: metric.currentValue,
        previousBaselineValue: prior.value,
        reason: "value_changed",
      });
      continue;
    }
    const observationTimeChanged = metric.timePrecision === "timestamp"
      ? prior.observedAt !== metric.observedAt
      : prior.observedDate !== metric.observedDate;
    if (observationTimeChanged) {
      observations.push({
        metricKey: metric.metricKey,
        currentValue: metric.currentValue,
        previousBaselineValue: prior.value,
        reason: "observation_time_changed",
      });
    }
  }
  return observations;
}

// Step 2: among the new observations, which ones cross this metric's
// registered threshold (or are flagged always_material)? Any single
// material metric makes the whole domain material -- per the design doc,
// evaluation happens at domain granularity, not per-metric.
export function evaluateMaterialChange(
  newObservations: NewObservation[],
  domainMap: Map<string, MetricDomainMapRow>,
): MaterialChangeDecision {
  const materialMetricKeys: string[] = [];
  const reasons: string[] = [];

  for (const observation of newObservations) {
    const mapping = domainMap.get(observation.metricKey);
    if (!mapping) continue; // shouldn't happen if caller scoped correctly, but never crash on it

    if (mapping.alwaysMaterial) {
      materialMetricKeys.push(observation.metricKey);
      reasons.push(`${observation.metricKey}: always_material`);
      continue;
    }
    if (observation.previousBaselineValue === null) {
      // First observation ever for this metric: material by definition
      // (design doc section 6.5 -- initial evaluation), since there is no
      // baseline to compare a threshold against.
      materialMetricKeys.push(observation.metricKey);
      reasons.push(`${observation.metricKey}: first_observation`);
      continue;
    }

    const absChange = Math.abs(observation.currentValue - observation.previousBaselineValue);
    if (mapping.absChangeThreshold !== null && absChange >= mapping.absChangeThreshold) {
      materialMetricKeys.push(observation.metricKey);
      reasons.push(`${observation.metricKey}: abs_change ${absChange} >= ${mapping.absChangeThreshold}`);
      continue;
    }
    if (mapping.pctChangeThreshold !== null && observation.previousBaselineValue !== 0) {
      const pctChange = Math.abs(
        (observation.currentValue - observation.previousBaselineValue) / observation.previousBaselineValue * 100,
      );
      if (pctChange >= mapping.pctChangeThreshold) {
        materialMetricKeys.push(observation.metricKey);
        reasons.push(`${observation.metricKey}: pct_change ${pctChange.toFixed(3)}% >= ${mapping.pctChangeThreshold}%`);
      }
    }
  }

  return {
    isMaterial: materialMetricKeys.length > 0,
    materialMetricKeys,
    reason: reasons.length > 0 ? reasons.join("; ") : "no metric crossed its threshold",
  };
}

// Event-driven material change: independent of any metric threshold.
// Per the design doc, this is deliberately narrow for Phase 1B -- only
// the domains with an unambiguous event_type mapping are covered here.
// price_move-style events that could plausibly touch fx/equity_index/
// commodities are left unmapped (design doc section 12, open question),
// since Phase 1B has no event-producing source for those domains anyway.
const DOMAIN_EVENT_TYPES: Record<string, readonly string[]> = {
  geopolitical: ["geopolitical", "sanction", "political_statement"],
  corporate_events: [
    "earnings",
    "guidance",
    "buyback",
    "dividend",
    "ma_deal",
    "large_order",
    "regulatory",
    "shareholder_structure",
  ],
  rates: ["rate_decision"],
  macro: ["macro_release"],
};

export function eventTypesForDomain(domain: string): readonly string[] {
  return DOMAIN_EVENT_TYPES[domain] ?? [];
}

export function evaluateEventMaterialChange(events: EventFact[]): MaterialChangeDecision {
  const material = events.filter((event) => event.importance === "high" || event.importance === "critical");
  return {
    isMaterial: material.length > 0,
    materialMetricKeys: [],
    reason: material.length > 0
      ? `${material.length} high/critical event(s): ${material.map((e) => e.id).join(",")}`
      : "no high/critical event",
  };
}

// --- Freshness/coverage roll-ups (design doc sections 8-9) ---

const FETCH_STATUS_SEVERITY: Record<FetchStatus, number> = { fresh: 0, unknown: 1, stale: 2, failed: 3 };
const OBSERVATION_STATUS_SEVERITY: Record<ObservationStatus, number> = {
  fresh: 0,
  unknown: 1,
  delayed_expected: 2,
  stale: 3,
};

export function rollUpFetchStatus(statuses: FetchStatus[]): FetchStatus {
  if (statuses.length === 0) return "unknown";
  return statuses.reduce((worst, s) => (FETCH_STATUS_SEVERITY[s] > FETCH_STATUS_SEVERITY[worst] ? s : worst));
}

export function rollUpObservationStatus(statuses: ObservationStatus[]): ObservationStatus {
  if (statuses.length === 0) return "unknown";
  return statuses.reduce((worst, s) =>
    OBSERVATION_STATUS_SEVERITY[s] > OBSERVATION_STATUS_SEVERITY[worst] ? s : worst
  );
}

export function computeCoverageStatus(registeredMetricKeys: string[], metricsWithFacts: string[]): CoverageStatus {
  if (registeredMetricKeys.length === 0) return "unavailable";
  const withFacts = new Set(metricsWithFacts);
  const coveredCount = registeredMetricKeys.filter((key) => withFacts.has(key)).length;
  if (coveredCount === 0) return "unavailable";
  if (coveredCount === registeredMetricKeys.length) return "full";
  return "partial";
}

// Deterministic, code-only confidence -- never set by AI. fetch_status
// failing outright (our own pipeline broken) is weighted more heavily
// than observation_status alone being stale (the source just hasn't
// published something new), matching the design doc's intent that these
// are different kinds of problems.
export function computeDataConfidence(
  coverage: CoverageStatus,
  fetchStatus: FetchStatus,
  observationStatus: ObservationStatus,
): number {
  if (coverage === "unavailable") return 0;
  if (fetchStatus === "failed") return 0.2;

  let score = coverage === "full" ? 1.0 : 0.7;
  if (fetchStatus === "stale") score -= 0.2;
  if (observationStatus === "delayed_expected") score -= 0.1;
  if (observationStatus === "stale") score -= 0.4;
  if (observationStatus === "unknown") score -= 0.3;

  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}
