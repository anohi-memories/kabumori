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

// All-stale guard (Phase 1B hardening, design doc section 9 addendum):
// a domain can be "material" purely because a metric's first-ever
// observation arrived (see evaluateMaterialChange below) while every
// metric in the domain is simultaneously stale/unknown -- i.e. the value
// is only "new" in the sense that we've never captured a baseline for it,
// not in the sense that it reflects anything close to the current market.
// Calling AI on that data would risk a narrative that reads as a current
// assessment when it is actually built entirely from old numbers. This
// guard is deliberately narrow: an event-driven material change (a real
// high/critical event just happened) always overrides it, since that is
// never about metric staleness.
export function shouldSkipAiForStaleness(
  metrics: MetricObservationRow[],
  eventDecision: MaterialChangeDecision,
): boolean {
  if (metrics.length === 0) return false;
  if (eventDecision.isMaterial) return false;
  return metrics.every((m) => m.observationStatus === "stale" || m.observationStatus === "unknown");
}

// Confidence clamp (Phase 1B hardening): the AI's self-reported confidence
// must never be trusted above what the deterministic data quality actually
// supports. dataConfidence already accounts for coverage/fetch/observation
// status (mic_state_decision_logic.computeDataConfidence); this is the
// floor-independent ceiling applied on top of the AI's own number.
export function clampAiConfidence(aiConfidence: number, dataConfidence: number): number {
  return Math.min(aiConfidence, dataConfidence);
}

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

// Exact decimal comparison for thresholds.
//
// Metric values and thresholds are short decimals (5.29, 2.943, 0.05), but
// binary floating point cannot hold them exactly: in JS 5.29 - 5.24 is
// 0.04999999999999982, so a move of exactly the 0.05 threshold used to be
// judged "below threshold" (Production, rates US10Y, 2026-10-01). An epsilon
// would only move that boundary somewhere else. Instead every number is read
// back as the decimal it was written as (its shortest round-trip string) and
// compared as scaled integers, so "exactly the threshold" is exactly equal.
type Decimal = { digits: bigint; scale: number };

function toDecimal(value: number): Decimal | null {
  if (!Number.isFinite(value)) return null;
  // Number#toString also uses scientific notation at small/large magnitudes.
  // Expand it as integers; never return to an imprecise float comparison.
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if (!match) return null;
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const scale = fraction.length - Number(exponent);
  const digits = BigInt(whole + fraction) * (sign === "-" ? -1n : 1n);
  return scale < 0
    ? { digits: digits * 10n ** BigInt(-scale), scale: 0 }
    : { digits, scale };
}

const rescale = (value: Decimal, scale: number): bigint => value.digits * 10n ** BigInt(scale - value.scale);
const magnitude = (value: bigint): bigint => (value < 0n ? -value : value);

function formatDecimal(digits: bigint, scale: number): string {
  const text = magnitude(digits).toString().padStart(scale + 1, "0");
  const whole = text.slice(0, text.length - scale);
  const fraction = scale > 0 ? text.slice(text.length - scale).replace(/0+$/, "") : "";
  return (digits < 0n ? "-" : "") + (fraction ? `${whole}.${fraction}` : whole);
}

// The decimal a number was written as, normalized ("5.240" -> "5.24",
// 1e-7 -> "0.0000001"); null for NaN/Infinity. Audit/fingerprint text only.
export function canonicalDecimal(value: number): string | null {
  const d = toDecimal(value);
  return d ? formatDecimal(d.digits, d.scale) : null;
}

// |current - baseline| as an exact decimal string; null when not comparable.
export function exactAbsChange(current: number, baseline: number): string | null {
  const [c, b] = [toDecimal(current), toDecimal(baseline)];
  if (!c || !b) return null;
  const scale = Math.max(c.scale, b.scale);
  return formatDecimal(magnitude(rescale(c, scale) - rescale(b, scale)), scale);
}

export type ThresholdComparison = { reached: boolean; change: string };

// |current - baseline| >= threshold, exactly. `change` is the exact difference.
export function absChangeReaches(current: number, baseline: number, threshold: number): ThresholdComparison {
  const [c, b, t] = [toDecimal(current), toDecimal(baseline), toDecimal(threshold)];
  if (!c || !b || !t || t.digits < 0n) return { reached: false, change: "invalid" };
  const scale = Math.max(c.scale, b.scale, t.scale);
  const change = magnitude(rescale(c, scale) - rescale(b, scale));
  return { reached: change >= rescale(t, scale), change: formatDecimal(change, scale) };
}

// |current - baseline| / |baseline| * 100 >= thresholdPct, exactly, without
// dividing: |current - baseline| * 100 >= thresholdPct * |baseline|.
// Callers guarantee baseline !== 0.
export function pctChangeReaches(current: number, baseline: number, thresholdPct: number): boolean {
  const [c, b, t] = [toDecimal(current), toDecimal(baseline), toDecimal(thresholdPct)];
  if (!c || !b || !t || t.digits < 0n || b.digits === 0n) return false;
  const scale = Math.max(c.scale, b.scale);
  const change = magnitude(rescale(c, scale) - rescale(b, scale));
  // Left side is in units of 10^-scale; the right side carries 10^-(scale + t.scale).
  return change * 100n * 10n ** BigInt(t.scale) >= t.digits * magnitude(rescale(b, scale));
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

    if (mapping.absChangeThreshold !== null) {
      const abs = absChangeReaches(observation.currentValue, observation.previousBaselineValue, mapping.absChangeThreshold);
      if (abs.reached) {
        materialMetricKeys.push(observation.metricKey);
        reasons.push(`${observation.metricKey}: abs_change ${abs.change} >= ${mapping.absChangeThreshold}`);
        continue;
      }
    }
    if (mapping.pctChangeThreshold !== null && observation.previousBaselineValue !== 0) {
      if (pctChangeReaches(observation.currentValue, observation.previousBaselineValue, mapping.pctChangeThreshold)) {
        // Displayed value only; the decision above is exact.
        const pctChange = Math.abs(
          (observation.currentValue - observation.previousBaselineValue) / observation.previousBaselineValue * 100,
        );
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
  // central_bank_decision (Fed statement events, importance='high') is
  // added alongside the existing rate_decision type -- no new evaluator
  // logic, no Fed-specific code path. evaluateEventMaterialChange already
  // treats any importance='high'|'critical' event as material regardless
  // of event_type, so this is a pure scope addition: the rates domain now
  // also looks at market_events rows of this type when gathering recent
  // events, and any that arrive get folded into the same generic
  // high/critical-importance material check every other domain already
  // uses.
  rates: ["rate_decision", "central_bank_decision"],
  macro: ["macro_release"],
};

export function eventTypesForDomain(domain: string): readonly string[] {
  return DOMAIN_EVENT_TYPES[domain] ?? [];
}

export function unseenEvents(events: EventFact[], priorSourceEventIds: string[], priorAiEvaluatedAt: string | null): EventFact[] {
  const seen = new Set(priorSourceEventIds);
  const priorEvaluationMs = priorAiEvaluatedAt ? Date.parse(priorAiEvaluatedAt) : NaN;
  return events.filter((event) => {
    if (!seen.has(event.id)) return true;
    const eventUpdatedMs = event.updatedAt ? Date.parse(event.updatedAt) : NaN;
    // Same-id in-place corrections (including Fed canonical reprocess) must
    // be reconsidered. Missing/invalid timestamps fail open toward an AI
    // reevaluation, never toward silently missing a revised policy event.
    return !Number.isFinite(priorEvaluationMs) || !Number.isFinite(eventUpdatedMs) ||
      eventUpdatedMs > priorEvaluationMs;
  });
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
