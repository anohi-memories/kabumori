// The app's market-wide story, composed from one Fact-passed market_report_packet (and, on a close,
// the same day's morning packet). Pure: no I/O, no AI call, nothing user-specific.
//
// Headings, emoji and every metric line are written here in code: each value is printed next to the
// session date of its own metric, so two sessions can never be presented as one date (the legacy app
// report on 2026-10-01 showed the 9/29 Nikkei close and the 9/30 1306 close as "9月30日"). The model
// only contributes the prose in packet.app_story, which passed the same local and Fact checks as X.

import type {
  KeyNews,
  MajorMove,
  MarketDirection,
  MarketReportPacket,
  NewsScope,
  ReportType,
} from "./market_report_packet.ts";

export const APP_STORY_VERSION = "app_market_story.v2";
export const APP_STORY_TARGET_MIN_CHARS = 900;
export const APP_STORY_TARGET_MAX_CHARS = 1500;

export type AppStorySection = {
  key: string;
  heading_ja: string;
  /** Prose (model-written, Fact-passed). Empty when the evidence was too thin for this section. */
  body_ja: string;
  /** Code-rendered fact lines: metrics with their own session dates, news headlines, watch points. */
  lines_ja: string[];
};

export type AppMarketStory = {
  version: typeof APP_STORY_VERSION;
  report_type: ReportType;
  trading_date: string;
  headline_ja: string;
  sections: AppStorySection[];
  /** Narrative length: headline, headings and prose. The editorial target (900–1500) is measured on this. */
  char_count: number;
  /** Everything a reader sees, code-rendered fact lines included. */
  total_char_count: number;
};

const TOKYO_KEYS = ["nikkei225", "topix_proxy_1306"];
const US_KEYS = ["dow", "sp500", "nasdaq_composite"];
const CROSS_KEYS = ["sox", "usdjpy", "us2y", "us10y", "jgb2y", "jgb10y", "wti", "brent"];

const DIRECTION_JA: Record<MarketDirection, string> = {
  up: "上昇", down: "下落", mixed: "まちまち", flat: "ほぼ横ばい", unknown: "方向は判断できません",
};

const SCOPE_RANK: Record<NewsScope, number> = { broad: 0, sector: 1, company: 2 };

export function dateJa(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${month}月${day}日`;
}

/** "日経平均 66,753.72（前日比+1.94%）", with "（9月24日時点・最新ではありません）" on a stale value. */
export function moveText(move: MajorMove): string {
  const change = move.change_pct_display ? `（前日比${move.change_pct_display}）` : "";
  const stale = move.freshness === "stale" ? `（${dateJa(move.session_date)}時点・最新ではありません）` : "";
  return `${move.label} ${move.value_display}${change}${stale}`;
}

/**
 * One line per session date, so every value sits under the date of its own metric:
 * "9月30日の東京市場：日経平均 66,753.72（前日比+1.94%）、TOPIX連動ETF（1306） 431.5円（前日比+1.43%）".
 * Metrics of one market with different session dates get separate lines.
 */
export function sessionLines(moves: readonly MajorMove[], keys: readonly string[], marketJa: string): string[] {
  const selected = keys.map((key) => moves.find((move) => move.metric_key === key)).filter((move): move is MajorMove => !!move);
  const dates = [...new Set(selected.map((move) => move.session_date))].sort();
  return dates.map((date) =>
    `${dateJa(date)}の${marketJa}：${selected.filter((move) => move.session_date === date).map(moveText).join("、")}`
  );
}

/** Cross-asset values, each with its own date because these series update on different days. */
export function crossAssetLines(moves: readonly MajorMove[]): string[] {
  return CROSS_KEYS.map((key) => moves.find((move) => move.metric_key === key))
    .filter((move): move is MajorMove => !!move)
    .map((move) => move.freshness === "stale" ? moveText(move) : `${moveText(move)}（${dateJa(move.session_date)}）`);
}

/** Broad-market items first, then sector items, then single-company items; stable within a tier. */
export function orderKeyNews(news: readonly KeyNews[]): KeyNews[] {
  return news
    .map((item, index) => ({ item, index }))
    .sort((a, b) => SCOPE_RANK[a.item.scope ?? "company"] - SCOPE_RANK[b.item.scope ?? "company"] || a.index - b.index)
    .map(({ item }) => item);
}

const NEWS_HEADLINE_MAX = 56;

function newsLines(packet: MarketReportPacket): string[] {
  return orderKeyNews(packet.key_news).map((news) => {
    const headline = Array.from(news.headline_ja);
    const short = headline.length > NEWS_HEADLINE_MAX ? `${headline.slice(0, NEWS_HEADLINE_MAX).join("")}…` : news.headline_ja;
    return `${short} — ${news.why_it_matters_ja}`;
  });
}

function section(key: string, heading: string, body: string | undefined, lines: string[]): AppStorySection | null {
  const text = (body ?? "").trim();
  return text || lines.length > 0 ? { key, heading_ja: heading, body_ja: text, lines_ja: lines } : null;
}

function sessionDirectionLine(packet: MarketReportPacket, market: "tokyo" | "us", labelJa: string): string[] {
  const view = packet.session_views?.find((item) => item.market === market);
  if (!view || !view.session_date) return [];
  return [`${dateJa(view.session_date)}の${labelJa}の方向：${DIRECTION_JA[view.direction]}`];
}

function morningCheckLines(close: MarketReportPacket, morning: MarketReportPacket | null): string[] {
  if (!morning || morning.report_type !== "morning" || morning.trading_date !== close.trading_date) return [];
  return [
    `朝刊の見立て：${morning.headline_ja}`,
    ...morning.next_watch_ja.slice(0, 3).map((item) => `朝刊で挙げた注目点：${item}`),
    ...sessionLines(close.major_moves, TOKYO_KEYS, "東京市場の結果"),
  ];
}

/**
 * The app's market story. A v1 packet (no app_story) still gets the headings and code-rendered lines,
 * with its market summary as the opening prose.
 */
export function buildAppMarketStory(packet: MarketReportPacket, morningPacket: MarketReportPacket | null = null): AppMarketStory {
  const draft = packet.app_story;
  const moves = packet.major_moves;
  const themes = (items: MarketReportPacket["strong_themes"]) => items.map((theme) => `テーマ：${theme.name_ja}`);
  const sections = packet.report_type === "morning"
    ? [
      section("summary", "☀️ 今日の市場をひとことで", draft?.summary_ja ?? packet.market_summary_ja, []),
      section("overseas", "🇺🇸 前夜の米国市場", draft?.overseas_ja, [
        ...sessionLines(moves, US_KEYS, "米国市場"),
        ...sessionDirectionLine(packet, "us", "米国市場"),
      ]),
      section("japan", "🇯🇵 今日の日本株をどう見るか", draft?.japan_ja, [
        ...sessionLines(moves, TOKYO_KEYS, "東京市場（前営業日の終値）"),
        ...sessionDirectionLine(packet, "tokyo", "東京市場"),
      ]),
      section("cross_asset", "💹 為替・金利・半導体など", draft?.cross_asset_ja, crossAssetLines(moves)),
      section("news", "📰 重要ニュース", draft?.news_ja, newsLines(packet)),
      section("strong", "🔥 強い・注目テーマ", draft?.strong_ja, themes(packet.strong_themes)),
      section("caution", "⚠️ 注意テーマ・リスク", draft?.caution_ja, [...themes(packet.weak_themes), ...packet.risks_ja]),
      section("watch", "👀 今日の注目点", draft?.watch_ja, packet.next_watch_ja),
      section("gaps", "ℹ️ 確認できなかったデータ", "", packet.data_gaps_ja),
    ]
    : [
      section("summary", "🌙 今日の市場をひとことで", draft?.summary_ja ?? packet.market_summary_ja, []),
      section("japan", "🇯🇵 今日の日本株", draft?.japan_ja, [
        ...sessionLines(moves, TOKYO_KEYS, "東京市場"),
        ...sessionDirectionLine(packet, "tokyo", "東京市場"),
      ]),
      section("moves", "📊 主な値動き", [draft?.overseas_ja, draft?.cross_asset_ja].filter(Boolean).join("\n"), [
        ...sessionLines(moves, US_KEYS, "米国市場"),
        ...crossAssetLines(moves),
      ]),
      section("news", "📰 確認できた材料", draft?.news_ja, newsLines(packet)),
      section("strong", "🔥 強かったテーマ", draft?.strong_ja, themes(packet.strong_themes)),
      section("caution", "⚠️ 弱かったテーマ・リスク", draft?.caution_ja, [...themes(packet.weak_themes), ...packet.risks_ja]),
      section("morning_check", "☀️ 朝刊との答え合わせ", "", morningCheckLines(packet, morningPacket)),
      section("watch", "👀 明日以降の注目点", draft?.watch_ja, packet.next_watch_ja),
      section("gaps", "ℹ️ 確認できなかったデータ", "", packet.data_gaps_ja),
    ];
  const present = sections.filter((item): item is AppStorySection => item !== null);
  return {
    version: APP_STORY_VERSION,
    report_type: packet.report_type,
    trading_date: packet.trading_date,
    headline_ja: packet.headline_ja,
    sections: present,
    char_count: Array.from(appStoryText({ headline_ja: packet.headline_ja, sections: present }, false)).length,
    total_char_count: Array.from(appStoryText({ headline_ja: packet.headline_ja, sections: present })).length,
  };
}

/** Plain-text rendering of the story (what a reader sees; also used for length and test assertions). */
export function appStoryText(story: Pick<AppMarketStory, "headline_ja" | "sections">, withLines = true): string {
  return [
    story.headline_ja,
    ...story.sections
      .filter((item) => withLines || item.body_ja)
      .map((item) =>
        [item.heading_ja, item.body_ja, ...(withLines ? item.lines_ja.map((line) => `・${line}`) : [])].filter(Boolean).join("\n")
      ),
  ].join("\n\n");
}

/** Editorial shortfalls of a story. Recorded, never blocking. */
export function appStoryWarnings(story: AppMarketStory): string[] {
  const warnings: string[] = [];
  if (story.char_count < APP_STORY_TARGET_MIN_CHARS) warnings.push(`APP_STORY_SHORTER_THAN_TARGET:${story.char_count}`);
  if (story.char_count > APP_STORY_TARGET_MAX_CHARS) warnings.push(`APP_STORY_LONGER_THAN_TARGET:${story.char_count}`);
  const expected = story.report_type === "morning"
    ? ["summary", "overseas", "japan", "cross_asset", "news", "watch"]
    : ["summary", "japan", "moves", "news", "watch"];
  const keys = new Set(story.sections.map((item) => item.key));
  for (const key of expected) if (!keys.has(key)) warnings.push(`APP_STORY_SECTION_OMITTED:${key}`);
  return warnings;
}
