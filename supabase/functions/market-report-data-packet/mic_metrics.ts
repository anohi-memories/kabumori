// Market Intelligence Core (market_metrics) rows → metrics. Reuses what the MIC
// ingest already stores (FRED, MOF JGB, EIA, Frankfurter/ECB) instead of
// fetching again. Source semantics (mic_source_registry.is_active etc.) are
// read as-is and never changed here.

import type { Metric, MicSpec, Quality } from "./packet_schema.ts";
import { isCredentialFreeUrl } from "./packet_schema.ts";

/** Fallbacks when mic_metric_domain_map has no threshold (JGB, EIA today). */
export const DEFAULT_FRESH_MINUTES = 4_320;

export type MicMetricRow = {
  metric_key: string;
  value: number | string | null;
  observed_date: string | null;
  observed_at: string | null;
  fetched_at: string | null;
  provider: string | null;
  source_url: string | null;
  quality_tier: string | null;
};

export type MicThresholdRow = {
  metric_key: string;
  expected_observation_lag_minutes: number | null;
};

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function quality(tier: string | null): Quality | null {
  if (tier === "official") return "official";
  if (tier === "trusted_free") return "trusted_free";
  return tier ? "unofficial_delayed" : null;
}

/** Newest observation per distinct observed_date, newest first. */
export function observationsFor(rows: readonly MicMetricRow[], micKey: string): MicMetricRow[] {
  const byDate = new Map<string, MicMetricRow>();
  for (const row of rows) {
    if (row.metric_key !== micKey || !row.observed_date || toNumber(row.value) === null) continue;
    const current = byDate.get(row.observed_date);
    if (!current || (row.fetched_at ?? "") > (current.fetched_at ?? "")) byDate.set(row.observed_date, row);
  }
  return [...byDate.values()].sort((a, b) => (b.observed_date ?? "").localeCompare(a.observed_date ?? ""));
}

export function micMetric(
  spec: MicSpec,
  rows: readonly MicMetricRow[] | null,
  thresholds: readonly MicThresholdRow[],
  asOf: Date,
  required: boolean,
): Metric {
  const base = {
    key: spec.key,
    label: spec.label,
    kind: spec.kind,
    currency: spec.currency,
    unit: spec.unit,
    expected_session_date: null,
    basis: spec.basis,
    is_proxy: spec.isProxy,
    proxy_for: spec.proxyFor,
    required,
  };
  const observations = rows ? observationsFor(rows, spec.micKey) : [];
  const latest = observations[0];
  const sourceUrl = latest?.source_url && isCredentialFreeUrl(latest.source_url) ? latest.source_url : null;
  if (!latest || !sourceUrl) {
    return {
      ...base,
      value: null, previous_close: null, change: null, change_pct: null,
      session_date: null, observed_at: null, fetched_at: latest?.fetched_at ?? null,
      provider: latest?.provider ?? null, source_url: sourceUrl,
      freshness: "unavailable", quality: quality(latest?.quality_tier ?? null),
      gap_reason: rows === null ? "fetch_failed" : "no_observation",
    };
  }

  const value = toNumber(latest.value)!;
  const previousRow = observations[1];
  const previous = previousRow ? toNumber(previousRow.value) : null;
  const threshold = thresholds.find((row) => row.metric_key === spec.micKey)?.expected_observation_lag_minutes;
  const freshMinutes = typeof threshold === "number" && threshold > 0 ? threshold : DEFAULT_FRESH_MINUTES;
  // Date-precision observations are aged from the end of their observed date (UTC).
  const observedEnd = latest.observed_at
    ? Date.parse(latest.observed_at)
    : Date.parse(`${latest.observed_date}T23:59:59Z`);
  const ageMinutes = (asOf.getTime() - observedEnd) / 60_000;
  const fresh = Number.isFinite(ageMinutes) && ageMinutes <= freshMinutes;

  return {
    ...base,
    value,
    previous_close: previous,
    change: previous === null ? null : round(value - previous, 4),
    change_pct: previous === null || previous === 0 ? null : round(((value - previous) / previous) * 100, 2),
    session_date: latest.observed_date,
    observed_at: latest.observed_at,
    fetched_at: latest.fetched_at,
    provider: latest.provider,
    source_url: sourceUrl,
    freshness: fresh ? "fresh" : "stale",
    quality: quality(latest.quality_tier),
    gap_reason: fresh ? null : "stale_observation",
  };
}
