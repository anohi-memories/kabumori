// Shared types for the Market Intelligence Core State evaluator. Pure
// types only -- no I/O, no logic.

export type Domain =
  | "rates"
  | "fx"
  | "commodities"
  | "equity_index"
  | "macro"
  | "geopolitical"
  | "corporate_events";

export const ALL_DOMAINS: Domain[] = [
  "rates",
  "fx",
  "commodities",
  "equity_index",
  "macro",
  "geopolitical",
  "corporate_events",
];

export type FetchStatus = "fresh" | "stale" | "failed" | "unknown";
export type ObservationStatus = "fresh" | "delayed_expected" | "stale" | "unknown";
export type CoverageStatus = "full" | "partial" | "unavailable";

// One row of v_mic_metric_observation_status.
export type MetricObservationRow = {
  metricKey: string;
  domain: Domain;
  currentValue: number | null;
  previousValue: number | null;
  pctChange: number | null;
  absChange: number | null;
  unit: string | null;
  observedDate: string | null;
  observedAt: string | null;
  timePrecision: "date" | "timestamp" | null;
  fetchedAt: string | null;
  sourceKey: string | null;
  provider: string | null;
  isOfficial: boolean | null;
  expectedLagMinutes: number | null;
  observationAgeMinutes: number | null;
  observationStatus: ObservationStatus;
};

// One row of mic_metric_domain_map.
export type MetricDomainMapRow = {
  metricKey: string;
  domain: Domain;
  displayName: string;
  pctChangeThreshold: number | null;
  absChangeThreshold: number | null;
  alwaysMaterial: boolean;
};

// One row of v_mic_source_fetch_status.
export type SourceFetchStatusRow = {
  sourceKey: string;
  fetchStatus: FetchStatus;
};

// The prior interpretation, read from market_state_current before this
// evaluation -- narrative/AI fields are never fed to the decision logic,
// only numericBaselineSnapshot (what the last evaluation was grounded in).
export type PriorState = {
  domain: Domain;
  narrativeIsNull: boolean;
  numericBaselineSnapshot: Record<string, { value: number; observedDate: string | null; observedAt: string | null }> | null;
};

export type NewObservation = {
  metricKey: string;
  currentValue: number;
  previousBaselineValue: number | null;
  reason: "first_observation" | "value_changed" | "observation_time_changed";
};

export type MaterialChangeDecision = {
  isMaterial: boolean;
  materialMetricKeys: string[];
  reason: string;
};

export type EventFact = {
  id: string;
  title: string;
  summary: string;
  importance: "low" | "medium" | "high" | "critical" | null;
  eventType: string;
  publishedAt: string;
};
