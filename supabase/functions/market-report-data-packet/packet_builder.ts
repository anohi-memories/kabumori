// Assembles market_data_packet.v1 from already-fetched inputs. Pure: no I/O,
// no clock (as_of / generated_at / fetched_at are passed in).

import {
  deriveDataQuality,
  isCredentialFreeUrl,
  type MarketDataPacket,
  type Metric,
  type NewsRef,
  SCHEMA_VERSION,
  type SourceSummary,
  specsFor,
} from "./packet_schema.ts";
import { micMetric, type MicMetricRow, type MicThresholdRow } from "./mic_metrics.ts";
import { expectedJpxSessionDate, expectedUsSessionDate, type ReportType } from "./session_logic.ts";
import { YAHOO_PROVIDER, yahooMetric } from "./yahoo_daily.ts";

export const MAX_NEWS_REFS = 30;
const NEWS_SEVERITIES = new Set(["emergency", "critical", "high", "medium"]);

export type YahooFetchResult = { ok: true; payload: unknown } | { ok: false };

export type NewsCandidateRow = {
  id: string;
  source_type: string | null;
  company_code: string | null;
  coverage_severity: string | null;
  coverage_categories: string[] | null;
  emergency_class: string | null;
  published_at: string | null;
  created_at: string;
  source_url: string | null;
  fact_check_status: string | null;
  duplicate_of: string | null;
};

export type PacketInputs = {
  reportType: ReportType;
  tradingDate: string;
  asOf: Date;
  generatedAt: Date;
  jpxHolidays: ReadonlySet<string>;
  nyseHolidays: ReadonlySet<string>;
  nyseCalendarLastDate: string | null;
  yahoo: ReadonlyMap<string, { result: YahooFetchResult; fetchedAt: string }>;
  micRows: readonly MicMetricRow[] | null;
  micThresholds: readonly MicThresholdRow[];
  newsRows: readonly NewsCandidateRow[] | null;
  newsWindowStart: Date;
};

export function toNewsRefs(rows: readonly NewsCandidateRow[], asOf: Date, windowStart: Date): NewsRef[] {
  return rows
    .filter((row) =>
      row.duplicate_of === null &&
      row.fact_check_status === "passed" &&
      row.coverage_severity !== null && NEWS_SEVERITIES.has(row.coverage_severity) &&
      Date.parse(row.created_at) >= windowStart.getTime() &&
      Date.parse(row.created_at) <= asOf.getTime()
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_NEWS_REFS)
    .map((row) => ({
      ref_id: row.id,
      source_type: row.source_type,
      company_code: row.company_code,
      coverage_severity: row.coverage_severity!,
      coverage_categories: Array.isArray(row.coverage_categories) ? [...row.coverage_categories] : [],
      emergency_class: row.emergency_class,
      published_at: row.published_at,
      recorded_at: row.created_at,
      source_url: row.source_url && isCredentialFreeUrl(row.source_url) ? row.source_url : null,
      fact_check_status: "passed" as const,
    }));
}

function gapMetric(spec: Extract<ReturnType<typeof specsFor>[number], { source: "gap" }>): Metric {
  return {
    key: spec.key, label: spec.label, kind: spec.kind,
    value: null, previous_close: null, change: null, change_pct: null,
    currency: spec.currency, unit: spec.unit,
    session_date: null, expected_session_date: null, observed_at: null, fetched_at: null,
    provider: null, source_url: null, basis: null,
    freshness: "unavailable", quality: null,
    is_proxy: spec.isProxy, proxy_for: spec.proxyFor, required: false,
    gap_reason: spec.gapReason,
  };
}

function summarize(provider: string, metrics: Metric[], attempted: boolean): SourceSummary {
  const usable = metrics.filter((metric) => metric.freshness !== "unavailable").length;
  return {
    provider,
    metric_keys: metrics.map((metric) => metric.key),
    fetch_status: !attempted ? "not_attempted" : usable === metrics.length ? "ok" : usable === 0 ? "failed" : "partial",
    quality: metrics.find((metric) => metric.quality)?.quality ?? null,
  };
}

export function buildMarketDataPacket(inputs: PacketInputs): MarketDataPacket {
  const jpxSessionDate = expectedJpxSessionDate(inputs.reportType, inputs.tradingDate, inputs.jpxHolidays);
  const usSessionDate = expectedUsSessionDate(inputs.asOf, inputs.nyseHolidays);
  const yahooMetrics: Metric[] = [];
  const micMetrics: Metric[] = [];
  const metrics: Metric[] = [];

  for (const spec of specsFor(inputs.reportType)) {
    const required = spec.requiredFor.includes(inputs.reportType);
    if (spec.source === "yahoo_daily") {
      const fetched = inputs.yahoo.get(spec.symbol);
      const expected = spec.session === "jpx" ? jpxSessionDate : usSessionDate;
      const metric = yahooMetric(
        spec,
        fetched?.result ?? { ok: false },
        expected,
        required,
        fetched?.fetchedAt ?? inputs.generatedAt.toISOString(),
      );
      yahooMetrics.push(metric);
      metrics.push(metric);
    } else if (spec.source === "mic") {
      const metric = micMetric(spec, inputs.micRows, inputs.micThresholds, inputs.asOf, required);
      micMetrics.push(metric);
      metrics.push(metric);
    } else {
      metrics.push(gapMetric(spec));
    }
  }

  const newsStatus = inputs.newsRows === null ? "unavailable" : "ok";
  const dataQuality = deriveDataQuality(metrics, newsStatus, inputs.reportType);
  const nyseCovered = inputs.nyseCalendarLastDate !== null && usSessionDate <= inputs.nyseCalendarLastDate;
  if (!nyseCovered) dataQuality.notes.push("nyse_calendar_not_covered");

  const micProviders = [...new Set(micMetrics.map((metric) => metric.provider ?? "market_metrics"))];
  return {
    schema_version: SCHEMA_VERSION,
    report_type: inputs.reportType,
    trading_date: inputs.tradingDate,
    as_of: inputs.asOf.toISOString(),
    session: {
      timezone: "Asia/Tokyo",
      jpx_trading_day: true,
      jpx_session_date: jpxSessionDate,
      us_session_date: usSessionDate,
      nyse_calendar_covered: nyseCovered,
    },
    metrics,
    news_refs: {
      status: newsStatus,
      window_start: inputs.newsWindowStart.toISOString(),
      items: inputs.newsRows ? toNewsRefs(inputs.newsRows, inputs.asOf, inputs.newsWindowStart) : [],
    },
    calendar_refs: { status: "unavailable", gap_reason: "no_verified_source", items: [] },
    data_quality: dataQuality,
    source_summary: [
      summarize(YAHOO_PROVIDER, yahooMetrics, true),
      ...micProviders.map((provider) =>
        summarize(provider, micMetrics.filter((metric) => (metric.provider ?? "market_metrics") === provider), true)
      ),
    ],
    generated_at: inputs.generatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Content hash: identity of the facts, independent of when they were fetched
// ---------------------------------------------------------------------------

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function packetContentHash(packet: MarketDataPacket): Promise<string> {
  const identity = {
    schema_version: packet.schema_version,
    report_type: packet.report_type,
    trading_date: packet.trading_date,
    session: packet.session,
    metrics: packet.metrics.map(({ fetched_at: _fetchedAt, ...metric }) => metric),
    news_ref_ids: packet.news_refs.items.map((item) => item.ref_id),
    data_quality_status: packet.data_quality.status,
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(identity)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
