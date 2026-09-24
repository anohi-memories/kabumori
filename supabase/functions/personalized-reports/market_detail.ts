// App-only detailed market section for personalized morning / close reports.
//
// Built once per run, in code, from the shared layer only:
//   * market_data_packet metrics (facts: values, previous closes, session dates, freshness),
//   * market_report_packet analysis (Fact-passed text shared with X: claims, themes, news, watch points).
// No AI call and nothing user-specific happens here, so every user in a run gets
// the identical market section and it can never contradict the shared analysis.
// X-side code (_shared/market_report_packet.ts, x-test-post) is read, never changed.

import type { MarketReportPacket, ReportType } from "../_shared/market_report_packet.ts";

export type MetricFreshness = "fresh" | "stale" | "unavailable";

export type MarketMetricLine = {
  key: string;
  label: string;
  value_display: string | null;
  change_display: string | null;
  session_date: string | null;
  freshness: MetricFreshness;
  note_ja: string | null;
};

export type MarketMetricGroup = { group_ja: string; items: MarketMetricLine[] };

export type MarketClaimLine = { text_ja: string; claim_type: string };

export type MorningReference = {
  headline_ja: string;
  direction: MarketReportPacket["market_direction"];
  next_watch_ja: string[];
  risks_ja: string[];
};

export type AppMarketDetail = {
  version: "app_market_detail.v1";
  report_type: ReportType;
  trading_date: string;
  report_packet_id: string;
  direction: MarketReportPacket["market_direction"];
  headline_ja: string;
  summary_ja: string;
  metric_groups: MarketMetricGroup[];
  overnight_claims: MarketClaimLine[];
  today_claims: MarketClaimLine[];
  tailwind_themes_ja: string[];
  headwind_themes_ja: string[];
  key_news: Array<{ ref_id: string; headline_ja: string; why_it_matters_ja: string }>;
  watch_points_ja: string[];
  risks_ja: string[];
  data_gaps_ja: string[];
  // Close only: what the shared morning analysis expected, shown next to the close result.
  morning_reference: MorningReference | null;
};

type RawMetric = Record<string, unknown>;

// Display order and grouping for the cross-asset table. Keys match market_data_packet.v1.
export const METRIC_GROUPS: ReadonlyArray<{ group_ja: string; keys: string[] }> = [
  { group_ja: "日本株", keys: ["nikkei225", "topix_proxy_1306", "growth250", "nikkei225_futures"] },
  { group_ja: "米国株", keys: ["dow", "sp500", "nasdaq_composite"] },
  { group_ja: "半導体", keys: ["sox"] },
  { group_ja: "為替", keys: ["usdjpy"] },
  { group_ja: "金利", keys: ["us2y", "us10y", "jgb2y", "jgb10y"] },
  { group_ja: "原油", keys: ["wti", "brent"] },
];

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function grouped(value: number, digits: number): string {
  return Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signed(value: number, digits: number): string {
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? "+" : rounded < 0 ? "-" : "±"}${grouped(rounded, digits)}`;
}

/** Value with its unit, e.g. "65,018.95" / "155.69円" / "4.74%" / "107.02ドル". */
export function metricValueDisplay(unit: string, value: number): string {
  switch (unit) {
    case "jpy_per_unit":
      return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}円`;
    case "jpy_per_usd":
      return `${grouped(value, 2)}円`;
    case "percent":
      return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}%`;
    case "usd_per_barrel":
      return `${grouped(value, 2)}ドル`;
    default:
      return grouped(value, 2);
  }
}

/** Day change: percent for prices and indices, points for yields (a % change of a % is misleading). */
export function metricChangeDisplay(unit: string, change: number | null, changePct: number | null): string | null {
  if (unit === "percent") return change === null ? null : `${signed(change, 2)}ポイント`;
  if (unit === "jpy_per_usd") return change === null ? null : `${signed(change, 2)}円`;
  return changePct === null ? null : `${signed(changePct, 2)}%`;
}

function gapNote(metric: RawMetric, reportType: ReportType, tradingDate: string): string | null {
  const freshness = metric.freshness;
  if (freshness === "unavailable") {
    return metric.gap_reason === "no_verified_source"
      ? "確認できる取得元がないため表示していません"
      : "取得できませんでした";
  }
  if (freshness === "stale") {
    const date = str(metric.session_date);
    return date ? `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日時点の値です（最新ではありません）` : "最新の値ではありません";
  }
  // A fresh Japanese close on a morning report is the previous session, never "today".
  const date = str(metric.session_date);
  if (reportType === "morning" && date && date < tradingDate && ["nikkei225", "topix_proxy_1306"].includes(String(metric.key))) {
    return "前営業日の終値";
  }
  return null;
}

export function metricLine(metric: RawMetric, reportType: ReportType, tradingDate: string): MarketMetricLine {
  const freshness: MetricFreshness = metric.freshness === "fresh" || metric.freshness === "stale" ? metric.freshness : "unavailable";
  const unit = str(metric.unit) ?? "";
  const value = num(metric.value);
  // Only a fresh value carries a day change; a stale value's change would describe an old session.
  const showValue = freshness !== "unavailable" && value !== null;
  return {
    key: String(metric.key ?? ""),
    label: str(metric.label) ?? String(metric.key ?? ""),
    value_display: showValue ? metricValueDisplay(unit, value!) : null,
    change_display: freshness === "fresh" ? metricChangeDisplay(unit, num(metric.change), num(metric.change_pct)) : null,
    session_date: showValue ? str(metric.session_date) : null,
    freshness: showValue ? freshness : "unavailable",
    note_ja: gapNote(showValue ? metric : { ...metric, freshness: "unavailable" }, reportType, tradingDate),
  };
}

export function metricGroups(metrics: RawMetric[], reportType: ReportType, tradingDate: string): MarketMetricGroup[] {
  const byKey = new Map(metrics.map((metric) => [String(metric.key), metric]));
  return METRIC_GROUPS.map((group) => ({
    group_ja: group.group_ja,
    items: group.keys
      .map((key) => byKey.get(key))
      .filter((metric): metric is RawMetric => !!metric)
      .map((metric) => metricLine(metric, reportType, tradingDate)),
  })).filter((group) => group.items.length > 0);
}

export function morningReference(packet: MarketReportPacket | null): MorningReference | null {
  if (!packet || packet.report_type !== "morning") return null;
  return {
    headline_ja: packet.headline_ja,
    direction: packet.market_direction,
    next_watch_ja: packet.next_watch_ja.slice(0, 3),
    risks_ja: packet.risks_ja.slice(0, 3),
  };
}

export function buildAppMarketDetail(input: {
  reportType: ReportType;
  tradingDate: string;
  reportPacketId: string;
  report: MarketReportPacket;
  metrics: RawMetric[];
  morningPacket?: MarketReportPacket | null;
}): AppMarketDetail {
  const { report } = input;
  const claimLine = (claim: MarketReportPacket["claims"][number]) => ({ text_ja: claim.text_ja, claim_type: claim.claim_type });
  const watch = [
    ...report.claims.filter((claim) => claim.scope === "next").map((claim) => claim.text_ja),
    ...report.next_watch_ja,
  ];
  return {
    version: "app_market_detail.v1",
    report_type: input.reportType,
    trading_date: input.tradingDate,
    report_packet_id: input.reportPacketId,
    direction: report.market_direction,
    headline_ja: report.headline_ja,
    summary_ja: report.market_summary_ja,
    metric_groups: metricGroups(input.metrics, input.reportType, input.tradingDate),
    overnight_claims: report.claims.filter((claim) => claim.scope === "overnight").map(claimLine),
    today_claims: report.claims.filter((claim) => claim.scope === "today").map(claimLine),
    tailwind_themes_ja: report.strong_themes.map((theme) => theme.name_ja),
    headwind_themes_ja: report.weak_themes.map((theme) => theme.name_ja),
    key_news: report.key_news,
    watch_points_ja: [...new Set(watch)],
    risks_ja: report.risks_ja,
    data_gaps_ja: report.data_gaps_ja,
    morning_reference: input.reportType === "close" ? morningReference(input.morningPacket ?? null) : null,
  };
}

/**
 * Compact, preformatted cross-asset lines for the per-user packet, so the
 * portfolio commentary can connect holdings to US stocks, SOX, FX, rates and oil
 * using only these exact strings (numbers are then allowed by the local check).
 */
export function crossAssetLines(detail: AppMarketDetail): string[] {
  return detail.metric_groups.flatMap((group) =>
    group.items
      .filter((item) => item.freshness === "fresh" && item.value_display)
      .map((item) => `${group.group_ja}: ${item.label} ${item.value_display}${item.change_display ? `（前日比 ${item.change_display}）` : ""}`)
  );
}
