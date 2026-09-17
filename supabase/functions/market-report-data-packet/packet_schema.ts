// market_data_packet.v1: types, metric catalogue and validator. Pure: no I/O.
//
// The packet is facts only. Values and prose never mix: labels are fixed
// display names, every other string is a code, a date, a timestamp or a URL.

import type { ReportType } from "./session_logic.ts";

export const SCHEMA_VERSION = "market_data_packet.v1";

/** Must never be shown as TOPIX itself (see DESIGN.md §4, §14). */
export const TOPIX_PROXY_LABEL = "TOPIX連動ETF（1306）";

export type Freshness = "fresh" | "stale" | "unavailable";
export type Quality = "official" | "trusted_free" | "unofficial_delayed";
export type MetricKind = "index" | "proxy_etf" | "fx" | "rate" | "commodity" | "futures";
export type GapReason =
  | "expected_session_not_available"
  | "session_not_closed"
  | "identity_mismatch"
  | "fetch_failed"
  | "invalid_value"
  | "no_observation"
  | "stale_observation"
  | "no_verified_source";

export type Metric = {
  key: string;
  label: string;
  kind: MetricKind;
  value: number | null;
  previous_close: number | null;
  change: number | null;
  change_pct: number | null;
  currency: string | null;
  unit: string;
  session_date: string | null;
  expected_session_date: string | null;
  observed_at: string | null;
  fetched_at: string | null;
  provider: string | null;
  source_url: string | null;
  basis: string | null;
  freshness: Freshness;
  quality: Quality | null;
  is_proxy: boolean;
  proxy_for: string | null;
  required: boolean;
  gap_reason: GapReason | null;
};

export type NewsRef = {
  ref_id: string;
  source_type: string | null;
  company_code: string | null;
  coverage_severity: string;
  coverage_categories: string[];
  emergency_class: string | null;
  published_at: string | null;
  recorded_at: string;
  source_url: string | null;
  fact_check_status: "passed";
};

export type SourceSummary = {
  provider: string;
  metric_keys: string[];
  fetch_status: "ok" | "partial" | "failed" | "not_attempted";
  quality: Quality | null;
};

export type DataQuality = {
  status: "ok" | "partial" | "blocked";
  required_missing: string[];
  stale: string[];
  unavailable: string[];
  proxies: string[];
  intentional_gaps: string[];
  notes: string[];
};

export type MarketDataPacket = {
  schema_version: typeof SCHEMA_VERSION;
  report_type: ReportType;
  trading_date: string;
  as_of: string;
  session: {
    timezone: "Asia/Tokyo";
    jpx_trading_day: true;
    jpx_session_date: string;
    us_session_date: string;
    nyse_calendar_covered: boolean;
  };
  metrics: Metric[];
  news_refs: { status: "ok" | "unavailable"; window_start: string; items: NewsRef[] };
  calendar_refs: { status: "unavailable"; gap_reason: "no_verified_source"; items: [] };
  data_quality: DataQuality;
  source_summary: SourceSummary[];
  generated_at: string;
};

// ---------------------------------------------------------------------------
// Metric catalogue
// ---------------------------------------------------------------------------

type BaseSpec = {
  key: string;
  label: string;
  kind: MetricKind;
  unit: string;
  currency: string | null;
  isProxy: boolean;
  proxyFor: string | null;
  requiredFor: ReportType[];
};

export type YahooSpec = BaseSpec & {
  source: "yahoo_daily";
  symbol: string;
  session: "jpx" | "nyse";
  /** Identity fields Yahoo must report for the response to be trusted. */
  expect: { symbol: string; currency: string; timezone: string; instrumentType: string };
  reportTypes: ReportType[];
};

export type MicSpec = BaseSpec & {
  source: "mic";
  micKey: string;
  basis: string;
  reportTypes: ReportType[];
};

export type GapSpec = BaseSpec & {
  source: "gap";
  gapReason: "no_verified_source";
  reportTypes: ReportType[];
};

export type MetricSpec = YahooSpec | MicSpec | GapSpec;

const BOTH: ReportType[] = ["morning", "close"];

export const METRIC_SPECS: readonly MetricSpec[] = [
  {
    source: "yahoo_daily", key: "nikkei225", label: "日経平均", kind: "index", unit: "index_points",
    currency: "JPY", isProxy: false, proxyFor: null, requiredFor: BOTH, reportTypes: BOTH,
    symbol: "^N225", session: "jpx",
    expect: { symbol: "^N225", currency: "JPY", timezone: "Asia/Tokyo", instrumentType: "INDEX" },
  },
  {
    source: "yahoo_daily", key: "topix_proxy_1306", label: TOPIX_PROXY_LABEL, kind: "proxy_etf",
    unit: "jpy_per_unit", currency: "JPY", isProxy: true, proxyFor: "TOPIX", requiredFor: BOTH, reportTypes: BOTH,
    symbol: "1306.T", session: "jpx",
    expect: { symbol: "1306.T", currency: "JPY", timezone: "Asia/Tokyo", instrumentType: "ETF" },
  },
  {
    source: "yahoo_daily", key: "dow", label: "NYダウ", kind: "index", unit: "index_points",
    currency: "USD", isProxy: false, proxyFor: null, requiredFor: [], reportTypes: BOTH,
    symbol: "^DJI", session: "nyse",
    expect: { symbol: "^DJI", currency: "USD", timezone: "America/New_York", instrumentType: "INDEX" },
  },
  {
    source: "yahoo_daily", key: "sp500", label: "S&P500", kind: "index", unit: "index_points",
    currency: "USD", isProxy: false, proxyFor: null, requiredFor: [], reportTypes: BOTH,
    symbol: "^GSPC", session: "nyse",
    expect: { symbol: "^GSPC", currency: "USD", timezone: "America/New_York", instrumentType: "INDEX" },
  },
  {
    source: "yahoo_daily", key: "nasdaq_composite", label: "ナスダック総合", kind: "index", unit: "index_points",
    currency: "USD", isProxy: false, proxyFor: null, requiredFor: [], reportTypes: BOTH,
    symbol: "^IXIC", session: "nyse",
    expect: { symbol: "^IXIC", currency: "USD", timezone: "America/New_York", instrumentType: "INDEX" },
  },
  {
    source: "yahoo_daily", key: "sox", label: "フィラデルフィア半導体株指数（SOX）", kind: "index",
    unit: "index_points", currency: "USD", isProxy: false, proxyFor: null, requiredFor: [], reportTypes: BOTH,
    symbol: "^SOX", session: "nyse",
    expect: { symbol: "^SOX", currency: "USD", timezone: "America/New_York", instrumentType: "INDEX" },
  },
  {
    source: "mic", key: "usdjpy", label: "ドル円", kind: "fx", unit: "jpy_per_usd", currency: "JPY",
    isProxy: false, proxyFor: null, requiredFor: BOTH, reportTypes: BOTH,
    micKey: "USDJPY", basis: "ecb_daily_reference_rate",
  },
  {
    source: "mic", key: "us2y", label: "米国2年債利回り", kind: "rate", unit: "percent", currency: null,
    isProxy: false, proxyFor: null, requiredFor: [], reportTypes: BOTH, micKey: "US2Y", basis: "daily_constant_maturity",
  },
  {
    source: "mic", key: "us10y", label: "米国10年債利回り", kind: "rate", unit: "percent", currency: null,
    isProxy: false, proxyFor: null, requiredFor: [], reportTypes: BOTH, micKey: "US10Y", basis: "daily_constant_maturity",
  },
  {
    source: "mic", key: "jgb2y", label: "日本国債2年利回り", kind: "rate", unit: "percent", currency: null,
    isProxy: false, proxyFor: null, requiredFor: [], reportTypes: BOTH, micKey: "JGB2Y", basis: "daily_reference_yield",
  },
  {
    source: "mic", key: "jgb10y", label: "日本国債10年利回り", kind: "rate", unit: "percent", currency: null,
    isProxy: false, proxyFor: null, requiredFor: [], reportTypes: BOTH, micKey: "JGB10Y", basis: "daily_reference_yield",
  },
  {
    source: "mic", key: "wti", label: "WTI原油", kind: "commodity", unit: "usd_per_barrel", currency: "USD",
    isProxy: false, proxyFor: null, requiredFor: [], reportTypes: BOTH, micKey: "WTI", basis: "daily_spot_price",
  },
  {
    source: "mic", key: "brent", label: "ブレント原油", kind: "commodity", unit: "usd_per_barrel", currency: "USD",
    isProxy: false, proxyFor: null, requiredFor: [], reportTypes: BOTH, micKey: "BRENT", basis: "daily_spot_price",
  },
  {
    source: "gap", key: "nikkei225_futures", label: "日経平均先物", kind: "futures", unit: "index_points",
    currency: "JPY", isProxy: false, proxyFor: null, requiredFor: [], reportTypes: BOTH, gapReason: "no_verified_source",
  },
  {
    source: "gap", key: "growth250", label: "東証グロース市場250指数", kind: "index", unit: "index_points",
    currency: "JPY", isProxy: false, proxyFor: null, requiredFor: [], reportTypes: ["close"], gapReason: "no_verified_source",
  },
];

/** Non-scalar coverage that has no verified source yet (DESIGN.md §4.1). */
export const INTENTIONAL_SECTION_GAPS = ["sector_performance", "event_calendar"] as const;

export function specsFor(reportType: ReportType): MetricSpec[] {
  return METRIC_SPECS.filter((spec) => spec.reportTypes.includes(reportType));
}

// ---------------------------------------------------------------------------
// Data quality (derived only from metrics, so it can be recomputed to verify)
// ---------------------------------------------------------------------------

export function deriveDataQuality(metrics: Metric[], newsStatus: "ok" | "unavailable"): DataQuality {
  const intentional = metrics.filter((metric) => metric.gap_reason === "no_verified_source").map((m) => m.key);
  const attempted = metrics.filter((metric) => metric.gap_reason !== "no_verified_source");
  const requiredMissing = attempted.filter((metric) => metric.required && metric.freshness !== "fresh").map((m) => m.key);
  const stale = attempted.filter((metric) => metric.freshness === "stale").map((m) => m.key);
  const unavailable = attempted.filter((metric) => metric.freshness === "unavailable").map((m) => m.key);
  const notes: string[] = [];
  if (newsStatus === "unavailable") notes.push("news_refs_unavailable");
  const status = requiredMissing.length > 0
    ? "blocked"
    : stale.length > 0 || unavailable.length > 0 || newsStatus === "unavailable" ? "partial" : "ok";
  return {
    status,
    required_missing: requiredMissing,
    stale,
    unavailable,
    proxies: metrics.filter((metric) => metric.is_proxy).map((m) => m.key),
    intentional_gaps: [...intentional, ...INTENTIONAL_SECTION_GAPS],
    notes,
  };
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SECRET_PARAM = /^(?:api[_-]?key|apikey|key|token|access[_-]?token|secret|sig|signature|password|auth)$/i;

function isIsoInstant(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

export function isCredentialFreeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    for (const name of url.searchParams.keys()) if (SECRET_PARAM.test(name)) return false;
    return true;
  } catch {
    return false;
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function validateMarketDataPacket(packet: MarketDataPacket): string[] {
  const issues: string[] = [];
  if (packet.schema_version !== SCHEMA_VERSION) issues.push("schema_version");
  if (packet.report_type !== "morning" && packet.report_type !== "close") issues.push("report_type");
  if (!DATE.test(packet.trading_date)) issues.push("trading_date");
  if (!isIsoInstant(packet.as_of)) issues.push("as_of");
  if (!isIsoInstant(packet.generated_at)) issues.push("generated_at");
  if (!DATE.test(packet.session?.jpx_session_date ?? "")) issues.push("session.jpx_session_date");
  if (!DATE.test(packet.session?.us_session_date ?? "")) issues.push("session.us_session_date");
  if (packet.report_type === "close" && packet.session?.jpx_session_date !== packet.trading_date) {
    issues.push("session.close_must_use_trading_date");
  }
  if (packet.report_type === "morning" && !(packet.session?.jpx_session_date < packet.trading_date)) {
    issues.push("session.morning_must_use_previous_session");
  }

  const keys = new Set<string>();
  for (const metric of packet.metrics ?? []) {
    const at = `metrics.${metric.key}`;
    if (keys.has(metric.key)) issues.push(`${at}.duplicate`);
    keys.add(metric.key);
    const numbers = [metric.value, metric.previous_close, metric.change, metric.change_pct];
    if (numbers.some((n) => n !== null && (typeof n !== "number" || !Number.isFinite(n)))) issues.push(`${at}.number`);
    if (!["fresh", "stale", "unavailable"].includes(metric.freshness)) issues.push(`${at}.freshness`);
    if (metric.freshness === "unavailable") {
      if (metric.value !== null || metric.previous_close !== null || metric.change !== null || metric.change_pct !== null) {
        issues.push(`${at}.unavailable_has_value`);
      }
      if (!metric.gap_reason) issues.push(`${at}.unavailable_without_reason`);
    } else {
      if (metric.value === null) issues.push(`${at}.value_missing`);
      if (!metric.provider || !metric.source_url || !metric.session_date || !metric.fetched_at || !metric.quality) {
        issues.push(`${at}.lineage_missing`);
      }
    }
    if (metric.freshness === "stale" && metric.gap_reason !== "stale_observation") issues.push(`${at}.stale_without_reason`);
    if (metric.freshness === "fresh" && metric.gap_reason !== null) issues.push(`${at}.fresh_with_gap`);
    if (metric.session_date !== null && !DATE.test(metric.session_date)) issues.push(`${at}.session_date`);
    if (metric.observed_at !== null && !isIsoInstant(metric.observed_at)) issues.push(`${at}.observed_at`);
    if (metric.fetched_at !== null && !isIsoInstant(metric.fetched_at)) issues.push(`${at}.fetched_at`);
    if (metric.source_url !== null && !isCredentialFreeUrl(metric.source_url)) issues.push(`${at}.source_url`);
    if (metric.is_proxy !== (metric.proxy_for !== null)) issues.push(`${at}.proxy_flags`);
    if (/^TOPIX$/i.test(metric.label.trim()) || (metric.proxy_for === "TOPIX" && metric.label !== TOPIX_PROXY_LABEL)) {
      issues.push(`${at}.topix_label`);
    }
    if (
      metric.freshness === "fresh" && metric.expected_session_date !== null &&
      metric.session_date !== metric.expected_session_date
    ) {
      issues.push(`${at}.fresh_wrong_session`);
    }
  }
  if (!keys.has("nikkei225") || !keys.has("topix_proxy_1306")) issues.push("metrics.core_keys_missing");

  for (const item of packet.news_refs?.items ?? []) {
    if (!item.ref_id || item.fact_check_status !== "passed") issues.push("news_refs.item");
    if (item.source_url !== null && !isCredentialFreeUrl(item.source_url)) issues.push("news_refs.source_url");
  }
  if (!isIsoInstant(packet.news_refs?.window_start)) issues.push("news_refs.window_start");
  if (packet.calendar_refs?.status !== "unavailable" || (packet.calendar_refs?.items ?? []).length !== 0) {
    issues.push("calendar_refs");
  }

  const expected = deriveDataQuality(packet.metrics ?? [], packet.news_refs?.status ?? "unavailable");
  const actual = packet.data_quality;
  if (
    !actual || actual.status !== expected.status ||
    !sameList(actual.required_missing, expected.required_missing) ||
    !sameList(actual.stale, expected.stale) ||
    !sameList(actual.unavailable, expected.unavailable) ||
    !sameList(actual.proxies, expected.proxies)
  ) {
    issues.push("data_quality.inconsistent");
  }
  return issues;
}
