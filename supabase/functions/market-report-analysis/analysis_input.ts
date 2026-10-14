// Deterministic input for the shared market analysis. Pure: no I/O.
//
// Everything numeric the model may mention is pre-formatted here from the
// immutable market_data_packet, and every fact carries a ref the model must cite.
// Direction and major moves are decided in code, never by the model.

import type { MarketDataPacket, Metric } from "../market-report-data-packet/packet_schema.ts";
import type { MajorMove, MarketDirection, NewsScope, ReportType, SessionView } from "../_shared/market_report_packet.ts";
import {
  bandRuleJa,
  evaluateMorningForecast,
  YUME_FLAT_BAND_PCT,
  YUME_STANCE_JA,
  YUME_TARGET,
  YUME_UNDETERMINABLE_JA,
  YUME_VERDICT_JA,
  type YumeMorningSource,
  type YumeReview,
} from "../_shared/market_report_yume.ts";

export const MAX_NEWS_ITEMS = 15;
export const FLAT_THRESHOLD_PCT = 0.1;

export type NewsTextRow = {
  id: string;
  source_type: string | null;
  company_code: string | null;
  company_name: string | null;
  title: string | null;
  coverage_severity: string | null;
  coverage_categories: string[] | null;
  published_at: string | null;
  created_at: string;
  app_title_ja: string | null;
  app_summary_ja: string | null;
  app_copy_fact_status: string | null;
  generated_text: string | null;
  generation_fact_status: string | null;
};

export type NewsInputItem = {
  ref: string;
  headline_ja: string;
  summary_ja: string | null;
  severity: string;
  categories: string[];
  company: string | null;
  published_at: string | null;
  /** Editorial reach of the item, decided from its categories and whether it names one company. */
  scope: NewsScope;
};

/** What the hard-fact guards need to know about one metric: its own session and its own numbers. */
export type MetricFact = {
  key: string;
  label: string;
  sessionDate: string;
  dateJa: string;
  valueDisplay: string;
  changeDisplay: string | null;
  /** -1 / 0 / 1 from the day change; null when the packet has no day change for it. */
  changeSign: number | null;
  freshness: "fresh" | "stale";
};

export type AnalysisInput = {
  reportType: ReportType;
  tradingDate: string;
  dataPacketId: string;
  dataContentHash: string;
  direction: MarketDirection;
  directionBasis: string[];
  majorMoves: MajorMove[];
  dataGapsJa: string[];
  news: NewsInputItem[];
  /** Serialised as the model input. */
  modelInput: Record<string, unknown>;
  allowedRefs: Set<string>;
  newsRefs: Set<string>;
  headlineByRef: Map<string, string>;
  /** Verified policy/macro news that must be surfaced (BOJ/FOMC/FX intervention, emergency/critical). */
  majorNewsRefs: Set<string>;
  /** Terms from those items; the X post must mention at least one of them. */
  majorKeywords: string[];
  /** Japanese and US sessions are different calendar dates (e.g. close on 9/18 vs US 9/17). */
  sessionsDiffer: boolean;
  /** Tokyo and US directions, each for its own session (a morning packet holds both). */
  sessionViews: SessionView[];
  metricFacts: MetricFact[];
  /** Scope by news ref, for ordering key_news in the packet. */
  scopeByRef: Map<string, NewsScope>;
  /** Close only: the code's look-back at the same day's morning call (null on a morning report). */
  yumeReview: YumeReview | null;
  /** Referenced news left out of the model input, each with a fixed reason code (recorded in the run diagnostics). */
  excludedNews: NewsExclusion[];
};

const MAJOR_CATEGORIES = new Set(["monetary_policy"]);
const MAJOR_SEVERITIES = new Set(["emergency", "critical"]);
export const MAJOR_KEYWORDS = [
  "日銀", "日本銀行", "FRB", "FOMC", "ECB", "政策金利", "利上げ", "利下げ", "為替介入", "金融政策",
] as const;

const DIRECTION_JA: Record<MarketDirection, string> = {
  up: "上昇", down: "下落", mixed: "まちまち", flat: "ほぼ横ばい", unknown: "判断できず",
};

// Editorial reach. Ranking by coverage_severity alone promoted a single company's impairment notice
// (critical) above trade-policy and geopolitical items on 2026-10-01, so the market-wide story orders
// news by reach first: the whole market, then a sector/theme, then one company.
const BROAD_CATEGORIES = new Set([
  "monetary_policy", "fx", "rates", "geopolitics", "disaster", "oil_energy", "commodities", "shipping_logistics",
  "us_market", "japan_market", "regulation_policy", "financial_system",
]);
const SYSTEMIC_CATEGORIES = new Set(["monetary_policy", "financial_system"]);
const SECTOR_CATEGORIES = new Set(["semiconductors", "ai_tech"]);
const SCOPE_RANK: Record<NewsScope, number> = { broad: 0, sector: 1, company: 2 };
export const SCOPE_JA: Record<NewsScope, string> = { broad: "市場全体", sector: "業種・テーマ", company: "個別企業" };

/** A company's own disclosure is company-scoped unless it is systemic (central bank / financial system). */
export function newsScope(categories: readonly string[], hasCompany: boolean): NewsScope {
  if (categories.some((category) => SYSTEMIC_CATEGORIES.has(category))) return "broad";
  if (hasCompany) return "company";
  if (categories.some((category) => BROAD_CATEGORIES.has(category))) return "broad";
  return categories.some((category) => SECTOR_CATEGORIES.has(category)) ? "sector" : "company";
}

/** Must be surfaced in the market-wide story: policy decisions, and emergency/critical items that are not one company's. */
export function isMajorNews(item: NewsInputItem): boolean {
  return item.categories.some((category) => MAJOR_CATEGORIES.has(category)) ||
    (MAJOR_SEVERITIES.has(item.severity) && item.scope !== "company");
}

const JAPANESE = /[ぁ-んァ-ヶ一-龠]/u;
const SEVERITY_RANK: Record<string, number> = { emergency: 4, critical: 3, high: 2, medium: 1 };

export function formatDateJa(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${month}月${day}日`;
}

function withCommas(value: number, digits: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function valueDisplay(metric: Metric): string {
  const value = metric.value as number;
  switch (metric.unit) {
    case "percent": return `${withCommas(value, 3).replace(/0+$/, "").replace(/\.$/, "")}%`;
    case "jpy_per_usd": return `${withCommas(value, 2)}円`;
    case "jpy_per_unit": return `${withCommas(value, 1)}円`;
    case "usd_per_barrel": return `${withCommas(value, 2)}ドル`;
    default: return withCommas(value, 2);
  }
}

export function changePctDisplay(metric: Metric): string | null {
  // MIC series compare with the previous stored observation, which can be days
  // apart (e.g. WTI +10.03% on 2026-09-17), so only session closes show a change.
  // basis, not provider: a value reused from an earlier packet of the same
  // session keeps its daily-close basis but is provided by market_data_packet.
  if (metric.change_pct === null || metric.basis !== "daily_close") return null;
  const sign = metric.change_pct > 0 ? "+" : metric.change_pct < 0 ? "−" : "±";
  return `${sign}${Math.abs(metric.change_pct).toFixed(2)}%`;
}

function usable(metric: Metric): boolean {
  return metric.value !== null && (metric.freshness === "fresh" || metric.freshness === "stale") && metric.session_date !== null;
}

const DIRECTION_KEYS: Record<ReportType, string[]> = {
  close: ["nikkei225", "topix_proxy_1306"],
  morning: ["dow", "sp500", "nasdaq_composite"],
};

const SESSION_KEYS: Record<SessionView["market"], string[]> = {
  tokyo: ["nikkei225", "topix_proxy_1306"],
  us: ["dow", "sp500", "nasdaq_composite"],
};

export function marketDirection(reportType: ReportType, metrics: Metric[]): { direction: MarketDirection; basis: string[] } {
  return directionOf(DIRECTION_KEYS[reportType], metrics);
}

/** Tokyo and US directions for their own sessions, so "mixed" on a morning never hides either one. */
export function sessionViews(metrics: Metric[]): SessionView[] {
  return (["tokyo", "us"] as const).map((market) => {
    const { direction, basis } = directionOf(SESSION_KEYS[market], metrics);
    const dates = basis.map((key) => metrics.find((metric) => metric.key === key)?.session_date).filter(Boolean) as string[];
    // One date only when every basis metric shares it; otherwise the view has no single session date.
    return { market, session_date: new Set(dates).size === 1 ? dates[0] : null, direction, basis };
  });
}

function directionOf(keys: readonly string[], metrics: Metric[]): { direction: MarketDirection; basis: string[] } {
  const basis = keys
    .map((key) => metrics.find((metric) => metric.key === key))
    .filter((metric): metric is Metric => Boolean(metric && metric.freshness === "fresh" && metric.change_pct !== null));
  if (basis.length === 0) return { direction: "unknown", basis: [] };
  const signs = basis.map((metric) =>
    Math.abs(metric.change_pct!) < FLAT_THRESHOLD_PCT ? 0 : Math.sign(metric.change_pct!)
  );
  const direction: MarketDirection = signs.every((sign) => sign === 0)
    ? "flat"
    : signs.every((sign) => sign >= 0) ? "up" : signs.every((sign) => sign <= 0) ? "down" : "mixed";
  return { direction, basis: basis.map((metric) => metric.key) };
}

export function majorMoves(metrics: Metric[]): MajorMove[] {
  return metrics.filter(usable).map((metric) => ({
    metric_key: metric.key,
    label: metric.label,
    session_date: metric.session_date!,
    value_display: valueDisplay(metric),
    change_pct_display: changePctDisplay(metric),
    freshness: metric.freshness as "fresh" | "stale",
  }));
}

const GAP_TEXT: Record<string, string> = {
  nikkei225_futures: "日経平均先物は確認できる取得元がないため載せていません",
  growth250: "東証グロース市場250指数は確認できる取得元がないため載せていません",
  sector_performance: "業種別の騰落は取得元がないため載せていません",
  event_calendar: "経済指標の予定は取得元がないため載せていません",
};

export function dataGapsJa(packet: MarketDataPacket): string[] {
  const gaps: string[] = [];
  for (const key of packet.data_quality.stale) {
    const metric = packet.metrics.find((item) => item.key === key);
    if (metric?.session_date) gaps.push(`${metric.label}は${formatDateJa(metric.session_date)}時点の値です`);
  }
  for (const key of packet.data_quality.unavailable) {
    const metric = packet.metrics.find((item) => item.key === key);
    if (metric) gaps.push(`${metric.label}は取得できませんでした`);
  }
  for (const key of packet.data_quality.intentional_gaps) {
    if (GAP_TEXT[key]) gaps.push(GAP_TEXT[key]);
  }
  return gaps;
}

function stripPostDecoration(text: string): string {
  return text
    .replace(/^\s*(【(重大)?速報】\s*)+/u, "")
    .replace(/\s*出典\s*[:：]\s*\S+\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Market-wide selection (2026-10-14, F2). The shared morning/close is about the whole market, so an ordinary company's
// own disclosure (earnings, dividends, buybacks, a single company's incident) is left out of the model input instead of
// being ranked last: on thin days the model filled the story with three such items. A company item stays only when it
// can move a major sector (semiconductors / AI) and is at least high severity, at most MAX_COMPANY_NEWS_ITEMS of them.
// Holdings-specific news is the personalized reports' job, not this one's. Every excluded item is recorded with a
// fixed reason code (PROJECT_RULES 候補選定と除外ログ).
const MARKET_MOVING_COMPANY_CATEGORIES = new Set(["semiconductors", "ai_tech"]);
const MARKET_MOVING_COMPANY_SEVERITIES = new Set(["emergency", "critical", "high"]);
export const MAX_COMPANY_NEWS_ITEMS = 2;

export type NewsExclusionReason = "NEWS_TEXT_NOT_FACT_PASSED" | "COMPANY_NOT_MARKET_WIDE" | "COMPANY_NEWS_CAP" | "NEWS_ITEM_CAP";
export type NewsExclusion = { ref: string; reason: NewsExclusionReason };

/** A company item that can move a major sector: semiconductors / AI news of high severity or above. */
export function isMarketMovingCompanyNews(item: Pick<NewsInputItem, "scope" | "severity" | "categories">): boolean {
  return item.scope === "company" && MARKET_MOVING_COMPANY_SEVERITIES.has(item.severity) &&
    item.categories.some((category) => MARKET_MOVING_COMPANY_CATEGORIES.has(category));
}

/** The items the market-wide report may use, and why each other item was left out. Order is kept. */
export function selectMarketWideNews(items: readonly NewsInputItem[]): { kept: NewsInputItem[]; excluded: NewsExclusion[] } {
  const kept: NewsInputItem[] = [];
  const excluded: NewsExclusion[] = [];
  let companies = 0;
  for (const item of items) {
    if (item.scope !== "company" || isMajorNews(item)) {
      kept.push(item);
    } else if (!isMarketMovingCompanyNews(item)) {
      excluded.push({ ref: item.ref, reason: "COMPANY_NOT_MARKET_WIDE" });
    } else if (companies >= MAX_COMPANY_NEWS_ITEMS) {
      excluded.push({ ref: item.ref, reason: "COMPANY_NEWS_CAP" });
    } else {
      companies += 1;
      kept.push(item);
    }
  }
  return { kept, excluded };
}

/** Fact-passed Japanese text only (same rule as personalized_report_news_inputs). */
export function newsInputItems(rows: readonly NewsTextRow[], refIds: readonly string[]): NewsInputItem[] {
  return rankedNewsItems(rows, refIds).items.slice(0, MAX_NEWS_ITEMS);
}

/** Every usable item, ranked (scope, then severity, then time), and the referenced rows without usable text. */
function rankedNewsItems(rows: readonly NewsTextRow[], refIds: readonly string[]): { items: NewsInputItem[]; unusable: NewsExclusion[] } {
  const allowed = new Set(refIds);
  const items: Array<NewsInputItem & { rank: number; time: string }> = [];
  const unusable: NewsExclusion[] = [];
  for (const row of rows) {
    if (!allowed.has(row.id)) continue;
    let headline: string | null = null;
    let summary: string | null = null;
    if (row.app_copy_fact_status === "passed" && row.app_title_ja?.trim() && row.app_summary_ja?.trim()) {
      headline = row.app_title_ja.trim();
      summary = row.app_summary_ja.trim();
    } else if (row.generation_fact_status === "passed" && row.generated_text?.trim()) {
      const body = stripPostDecoration(row.generated_text);
      headline = body.split("。")[0];
      summary = body;
    } else if (
      (row.source_type === "tdnet" || row.source_type === "company_ir") &&
      row.title?.trim() && JAPANESE.test(row.title)
    ) {
      headline = row.title.trim();
    }
    if (!headline) {
      unusable.push({ ref: `news:${row.id}`, reason: "NEWS_TEXT_NOT_FACT_PASSED" });
      continue;
    }
    items.push({
      ref: `news:${row.id}`,
      headline_ja: headline,
      summary_ja: summary,
      severity: row.coverage_severity ?? "medium",
      categories: Array.isArray(row.coverage_categories) ? row.coverage_categories : [],
      company: row.company_code ? `${row.company_name ?? ""}（${row.company_code.slice(0, 4)}）` : null,
      published_at: row.published_at,
      scope: newsScope(Array.isArray(row.coverage_categories) ? row.coverage_categories : [], Boolean(row.company_code)),
      rank: SEVERITY_RANK[row.coverage_severity ?? ""] ?? 0,
      time: row.published_at ?? row.created_at,
    });
  }
  const ranked = items
    .sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || b.rank - a.rank || b.time.localeCompare(a.time))
    .map(({ rank: _rank, time: _time, ...item }) => item);
  return { items: ranked, unusable };
}

export function buildAnalysisInput(args: {
  dataPacket: MarketDataPacket;
  dataPacketId: string;
  dataContentHash: string;
  newsRows: readonly NewsTextRow[];
  /** Close only: the same trading date's morning report as stored (immutable), null when none, "error" when unread. */
  morning?: YumeMorningSource;
  /**
   * "market_wide": ordinary company news is left out (selectMarketWideNews); the handler's default since 2026-10-14.
   * "all" (default of this pure builder): every referenced item, the pre-2026-10-14 input the guard fixtures use.
   */
  newsSelection?: "market_wide" | "all";
}): AnalysisInput {
  const { dataPacket } = args;
  const { direction, basis } = marketDirection(dataPacket.report_type, dataPacket.metrics);
  const moves = majorMoves(dataPacket.metrics);
  const gaps = dataGapsJa(dataPacket);
  const ranked = rankedNewsItems(args.newsRows, dataPacket.news_refs.items.map((item) => item.ref_id));
  const selection = args.newsSelection === "market_wide" ? selectMarketWideNews(ranked.items) : { kept: ranked.items, excluded: [] };
  const news = selection.kept.slice(0, MAX_NEWS_ITEMS);
  const excludedNews: NewsExclusion[] = [
    ...ranked.unusable,
    ...selection.excluded,
    ...selection.kept.slice(MAX_NEWS_ITEMS).map((item) => ({ ref: item.ref, reason: "NEWS_ITEM_CAP" as const })),
  ];
  const metricRefs = moves.map((move) => `metric:${move.metric_key}`);
  const newsRefs = news.map((item) => item.ref);

  const major = news.filter(isMajorNews);
  const majorText = major.map((item) => `${item.headline_ja} ${item.summary_ja ?? ""}`).join(" ");
  const sessionsDiffer = dataPacket.session.jpx_session_date !== dataPacket.session.us_session_date;
  const views = sessionViews(dataPacket.metrics);
  const viewJa = (market: SessionView["market"]) => {
    const view = views.find((item) => item.market === market)!;
    return view.session_date ? `${formatDateJa(view.session_date)}は${DIRECTION_JA[view.direction]}` : DIRECTION_JA[view.direction];
  };
  const facts: MetricFact[] = dataPacket.metrics.filter(usable).map((metric) => ({
    key: metric.key,
    label: metric.label,
    sessionDate: metric.session_date!,
    dateJa: formatDateJa(metric.session_date!),
    valueDisplay: valueDisplay(metric),
    changeDisplay: changePctDisplay(metric),
    changeSign: metric.change_pct === null || metric.basis !== "daily_close"
      ? null
      : Math.abs(metric.change_pct) < FLAT_THRESHOLD_PCT ? 0 : Math.sign(metric.change_pct),
    freshness: metric.freshness as "fresh" | "stale",
  }));
  const target = facts.find((fact) => fact.key === YUME_TARGET);
  const yumeReview = dataPacket.report_type === "close"
    ? evaluateMorningForecast({
      tradingDate: dataPacket.trading_date,
      morning: args.morning ?? null,
      actual: target ? { sessionDate: target.sessionDate, changeDisplay: target.changeDisplay, freshness: target.freshness } : null,
    })
    : null;

  // Japanese keys only: English field names in the input leaked into the text on
  // 2026-09-18 ("change_pctは+1.38%"). Only the ref identifiers stay ASCII.
  const modelInput = {
    種類: dataPacket.report_type === "close" ? "大引け" : "朝刊",
    取引日: formatDateJa(dataPacket.trading_date),
    東京市場の日付: formatDateJa(dataPacket.session.jpx_session_date),
    米国市場の日付: formatDateJa(dataPacket.session.us_session_date),
    日付の注意: sessionsDiffer
      ? `東京市場（${formatDateJa(dataPacket.session.jpx_session_date)}）と米国市場（${formatDateJa(dataPacket.session.us_session_date)}）は日付が違います。並べるときはそれぞれの日付を書き、「同じ日」とは書きません。`
      : "東京市場と米国市場は同じ日付です。",
    市場の方向: DIRECTION_JA[direction],
    方向の根拠: basis.map((key) => `metric:${key}`),
    // Each market's own session: a morning report must not merge these into one label.
    東京市場の方向: viewJa("tokyo"),
    米国市場の方向: viewJa("us"),
    指標: moves.map((move) => ({
      ref: `metric:${move.metric_key}`,
      名称: move.label,
      日付: formatDateJa(move.session_date),
      値: move.value_display,
      前日比: move.change_pct_display,
      鮮度: move.freshness === "fresh" ? "最新" : "古い値",
    })),
    // Keep the same broad > sector > company order the guards/consumers see. The major flag
    // communicates importance without promoting a narrow emergency above a broad-market item.
    ニュース: news.map((item) => ({
      ref: item.ref,
      見出し: item.headline_ja,
      要約: item.summary_ja,
      重要材料: isMajorNews(item),
      範囲: SCOPE_JA[item.scope],
      企業: item.company,
    })),
    取得できなかったデータ: gaps,
    // ゆめちゃん's call is judged against this fixed rule (stored in the morning record).
    ゆめちゃんの予想の基準: bandRuleJa(YUME_FLAT_BAND_PCT),
    ...(yumeReview ? { 朝刊の予想との答え合わせ: yumeReviewInput(yumeReview) } : {}),
  };

  return {
    reportType: dataPacket.report_type,
    tradingDate: dataPacket.trading_date,
    dataPacketId: args.dataPacketId,
    dataContentHash: args.dataContentHash,
    direction,
    directionBasis: basis,
    majorMoves: moves,
    dataGapsJa: gaps,
    news,
    modelInput,
    allowedRefs: new Set([...metricRefs, ...newsRefs]),
    newsRefs: new Set(newsRefs),
    headlineByRef: new Map(news.map((item) => [item.ref, item.headline_ja])),
    majorNewsRefs: new Set(major.map((item) => item.ref)),
    majorKeywords: MAJOR_KEYWORDS.filter((keyword) => majorText.includes(keyword)),
    sessionsDiffer,
    sessionViews: views,
    metricFacts: facts,
    scopeByRef: new Map(news.map((item) => [item.ref, item.scope])),
    yumeReview,
    excludedNews,
  };
}

/** The look-back as the model sees it: the verdict is fixed; only what the code knows, in Japanese. */
function yumeReviewInput(review: YumeReview): Record<string, unknown> {
  if (review.verdict === "undeterminable") {
    return {
      判定: YUME_VERDICT_JA.undeterminable,
      比べられない理由: YUME_UNDETERMINABLE_JA[review.reason_code] ?? "比べられる記録がありません",
      朝刊の予想: review.morning_stance ? YUME_STANCE_JA[review.morning_stance] : null,
      朝刊の見立て: review.morning_headline_ja,
    };
  }
  return {
    判定: YUME_VERDICT_JA[review.verdict],
    朝刊の予想: YUME_STANCE_JA[review.morning_stance!],
    朝刊の見立て: review.morning_headline_ja,
    判定の基準: bandRuleJa(review.flat_band_pct!),
    実績: `${formatDateJa(review.actual_session_date!)}の日経平均 前日比${review.actual_change_display}`,
  };
}
