// View model of the 銘柄 tab's portfolio dashboard (no RN imports, so it is testable with Deno).
//
// Every figure comes from the latest SAVED close report (`portfolio_snapshot`, computed in code by the
// personalized-reports Edge Function) -- there is no live quote stream, so nothing here says "now" and a
// stale report never gets today's wording. Missing values stay null (rendered as "—", never 0). The only
// prose is the Fact-passed text already stored in the report; nothing here calls an AI or the network.
//
// The report selection itself stays in report-presentation (`latestCloseReport`); the screen passes the
// chosen report in, which keeps this module free of runtime imports.

import type { HoldingImpact, PersonalizedReport, ReportSnapshot, ReportStock, Stance } from './report-presentation';
import type { TrackedStock } from './stocks';

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// ---- dates / basis ------------------------------------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "10/6" for a YYYY-MM-DD date; null when malformed. */
export function shortDate(date: string): string | null {
  const match = DATE.exec(date);
  return match ? `${Number(match[2])}/${Number(match[3])}` : null;
}

export type PortfolioBasis = {
  report: PersonalizedReport;
  snapshot: ReportSnapshot;
  /** The date of the prices the figures are based on. */
  basisDate: string;
  /** True only when those prices are today's (JST); every "今日" wording depends on this alone. */
  isToday: boolean;
  /** "10/6", or null when the date is malformed. */
  dateLabel: string | null;
};

export function portfolioBasis(report: PersonalizedReport | null, todayJst: string): PortfolioBasis | null {
  const snapshot = report?.portfolio_snapshot ?? null;
  if (!report || !snapshot) return null;
  const basisDate = snapshot.price_basis_date ?? report.trading_date;
  return { report, snapshot, basisDate, isToday: basisDate === todayJst, dateLabel: shortDate(basisDate) };
}

export type PortfolioLabels = {
  /** "10/6 終値ベース": what the numbers are, never "現在". */
  basis: string;
  aiTitle: string;
  aiCta: string;
  impactTitle: string;
  dayChange: string;
  priceWord: '終値';
};

/** Date-aware wording: "今日" only when the basis is today, otherwise the date or "最新". */
export function portfolioLabels(basis: PortfolioBasis | null): PortfolioLabels {
  const date = basis?.dateLabel ?? null;
  const today = basis?.isToday === true;
  return {
    basis: date ? `${date} 終値ベース` : '保存済み終値ベース',
    aiTitle: today ? '今日のポートフォリオ' : '最新のポートフォリオ',
    aiCta: today ? '今日のポイントを見る' : '詳しいポイントを見る',
    impactTitle: today ? '今日の資産への影響' : date ? `${date}の資産への影響` : '最新の資産への影響',
    dayChange: today ? '今日の増減' : date ? `${date}の増減` : '直近の増減',
    priceWord: '終値',
  };
}

// ---- asset summary ---------------------------------------------------------------------------------------------

/**
 * Unrealized P/L as a percent of the cost basis. The totals carry no percent, so the cost is derived as
 * `market value - unrealized P/L` and the percent is only produced when that is finite and positive.
 */
export function unrealizedPercent(marketValue: number | null, unrealizedPl: number | null): number | null {
  const value = finite(marketValue);
  const pl = finite(unrealizedPl);
  if (value === null || pl === null) return null;
  const cost = value - pl;
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const percent = (pl / cost) * 100;
  return Number.isFinite(percent) ? percent : null;
}

export type AssetSummary = {
  assetValue: number | null;
  unrealizedPl: number | null;
  unrealizedPlPercent: number | null;
  dayPl: number | null;
  dayChangePercent: number | null;
  holdingCount: number;
  /** False when some holding could not be valued: the totals then do not cover every holding. */
  allValued: boolean;
};

export function assetSummary(snapshot: ReportSnapshot | null): AssetSummary {
  const totals = snapshot?.totals;
  const assetValue = finite(totals?.market_value);
  const unrealizedPl = finite(totals?.unrealized_pl);
  return {
    assetValue,
    unrealizedPl,
    unrealizedPlPercent: unrealizedPercent(assetValue, unrealizedPl),
    dayPl: finite(totals?.day_pl),
    dayChangePercent: finite(totals?.day_change_percent),
    holdingCount: finite(totals?.holding_count) ?? 0,
    allValued: totals?.all_holdings_valued !== false,
  };
}

// ---- sparkline ----------------------------------------------------------------------------------------------------

export const SPARKLINE_MAX_POINTS = 12;

/**
 * Total asset values of the recent saved CLOSE reports, oldest first, one per trading date (the newest
 * generation of a date wins). Reports without a finite market value are skipped. A history with fewer than
 * two points is returned as is: the caller shows a quiet fallback instead of a line.
 */
export function sparklineValues(reports: readonly PersonalizedReport[], maxPoints: number = SPARKLINE_MAX_POINTS): number[] {
  const byDate = new Map<string, { value: number; generated: string }>();
  for (const report of reports) {
    if (report.report_type !== 'close') continue;
    const value = finite(report.portfolio_snapshot?.totals.market_value);
    if (value === null) continue;
    const generated = report.generated_at ?? '';
    const existing = byDate.get(report.trading_date);
    if (!existing || generated > existing.generated) byDate.set(report.trading_date, { value, generated });
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry.value)
    .slice(-maxPoints);
}

/**
 * The real direction of the saved asset history: the last value against the first. "Flat" means no more than
 * 0.05% (at least ¥1) apart, so a tiny wobble is not dressed up as growth or decline. Fewer than two points
 * has no trend. The sparkline colour follows this and nothing else (a falling history is never green).
 */
export type SparkTrend = 'up' | 'down' | 'flat' | 'none';

export function sparklineTrend(values: readonly number[]): SparkTrend {
  if (values.length < 2) return 'none';
  const first = values[0];
  const last = values[values.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 'none';
  const change = last - first;
  if (Math.abs(change) <= Math.max(1, Math.abs(first) * 0.0005)) return 'flat';
  return change > 0 ? 'up' : 'down';
}

// ---- impact top 3 -------------------------------------------------------------------------------------------------

export type ImpactItem = {
  ticker: string;
  company: string;
  dayPl: number;
  changePercent: number | null;
};

/** Holdings with a numeric day P/L, biggest absolute impact first (ties by ticker); at most `limit`. */
export function topImpacts(snapshot: ReportSnapshot | null, limit = 3): ImpactItem[] {
  if (!snapshot) return [];
  return snapshot.holdings
    .flatMap((stock): ImpactItem[] => {
      const dayPl = finite(stock.day_pl);
      if (dayPl === null) return [];
      return [{
        ticker: stock.ticker_code,
        company: stock.company_name,
        dayPl,
        changePercent: stock.price.status === 'ok' ? finite(stock.price.changePercent) : null,
      }];
    })
    .sort((left, right) => Math.abs(right.dayPl) - Math.abs(left.dayPl) || left.ticker.localeCompare(right.ticker))
    .slice(0, limit);
}

// ---- holdings ----------------------------------------------------------------------------------------------------------

const LEGAL_FORMS = /^(株式会社|（株）|\(株\)|㈱)|(株式会社|（株）|\(株\)|㈱)$/g;

/**
 * One short, deterministic avatar label (the slot a licensed logo can replace later): the first character of
 * a Japanese name, up to two leading Latin letters/digits of a Latin name, else the start of the ticker.
 */
export function avatarLabel(company: string, ticker: string): string {
  const name = company.replace(LEGAL_FORMS, '').trim();
  const first = Array.from(name)[0];
  if (first) {
    if (/[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/.test(first)) {
      const latin = /^[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]{1,2}/.exec(name)?.[0] ?? first;
      return latin.toUpperCase();
    }
    return first;
  }
  return ticker.trim().slice(0, 2) || '?';
}

export type HoldingRow = {
  trackedId: string;
  ticker: string;
  company: string;
  market: string;
  avatar: string;
  /** False when the latest report has no row for this holding (e.g. registered after it was written). */
  reflected: boolean;
  close: number | null;
  changePercent: number | null;
  marketValue: number | null;
  dayPl: number | null;
  unrealizedPl: number | null;
  unrealizedPlPercent: number | null;
  /** A restrained tag: only what the stored report really supports. */
  tag: string | null;
  /** One short Fact-passed line from the stored report. */
  line: string | null;
};

const STANCE_TAG: Partial<Record<Stance, string>> = { tailwind: '追い風', headwind: '逆風' };

function materialFor(stock: ReportStock, impact: HoldingImpact | undefined, note: string | undefined): { tag: string | null; line: string | null } {
  // A tag is only shown when it is backed by stored data: linked news, or the report's own tailwind/headwind
  // stance. It is never guessed from the company name or free-form prose.
  const tag = stock.news_ids.length > 0 ? 'ニュース' : impact ? STANCE_TAG[impact.stance] ?? null : null;
  const text = impact?.fact_ja?.trim() || note?.trim() || '';
  return { tag, line: text || null };
}

/**
 * The CURRENT registered holdings (tracked_stocks), each enriched with the latest report's row for the same
 * ticker. A holding the report does not know yet is kept and flagged `reflected: false` -- never dropped.
 * Order: market value descending (finite first), then holdings without one, ties by ticker.
 */
export function buildHoldingRows(tracked: readonly TrackedStock[], report: PersonalizedReport | null): HoldingRow[] {
  const snapshot = report?.portfolio_snapshot ?? null;
  const byTicker = new Map((snapshot?.holdings ?? []).map((stock) => [stock.ticker_code, stock]));
  const impacts = new Map((report?.body?.holding_impacts ?? []).map((impact) => [impact.ticker_code, impact]));
  const notes = new Map((report?.body?.stock_notes ?? []).map((entry) => [entry.ticker_code, entry.note_ja]));
  const rows = tracked
    .filter((item) => item.tracking_type === 'holding')
    .map((item): HoldingRow => {
      const ticker = item.stocks_master.ticker_code;
      const company = item.stocks_master.company_name;
      const stock = byTicker.get(ticker);
      const base = {
        trackedId: item.id,
        ticker,
        company,
        market: item.stocks_master.market,
        avatar: avatarLabel(company, ticker),
      };
      if (!stock) {
        return {
          ...base, reflected: false, close: null, changePercent: null, marketValue: null, dayPl: null,
          unrealizedPl: null, unrealizedPlPercent: null, tag: null, line: null,
        };
      }
      const priced = stock.price.status === 'ok';
      return {
        ...base,
        reflected: true,
        close: priced ? finite(stock.price.close) : null,
        changePercent: priced ? finite(stock.price.changePercent) : null,
        marketValue: finite(stock.market_value),
        dayPl: finite(stock.day_pl),
        unrealizedPl: finite(stock.unrealized_pl),
        unrealizedPlPercent: finite(stock.unrealized_pl_percent),
        ...materialFor(stock, impacts.get(ticker), notes.get(ticker)),
      };
    });
  return rows.sort((left, right) => {
    const leftValue = left.marketValue;
    const rightValue = right.marketValue;
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue) return rightValue - leftValue;
    if (leftValue !== null && rightValue === null) return -1;
    if (leftValue === null && rightValue !== null) return 1;
    return left.ticker.localeCompare(right.ticker);
  });
}

export type WatchRow = {
  tracked: TrackedStock;
  ticker: string;
  company: string;
  avatar: string;
  close: number | null;
  changePercent: number | null;
};

/** The registered watch records, in the order given (newest first from the query), with the report's price if known. */
export function buildWatchRows(tracked: readonly TrackedStock[], report: PersonalizedReport | null): WatchRow[] {
  const byTicker = new Map((report?.portfolio_snapshot?.watch ?? []).map((stock) => [stock.ticker_code, stock]));
  return tracked
    .filter((item) => item.tracking_type === 'watch')
    .map((item): WatchRow => {
      const stock = byTicker.get(item.stocks_master.ticker_code);
      const priced = stock?.price.status === 'ok';
      return {
        tracked: item,
        ticker: item.stocks_master.ticker_code,
        company: item.stocks_master.company_name,
        avatar: avatarLabel(item.stocks_master.company_name, item.stocks_master.ticker_code),
        close: priced ? finite(stock?.price.close) : null,
        changePercent: priced ? finite(stock?.price.changePercent) : null,
      };
    });
}

// ---- watchlist highlights ----------------------------------------------------------------------------------------------

/** A saved close move of at least this many percent (either way, inclusive) makes a watch stock a candidate. */
export const FEATURED_CHANGE_THRESHOLD = 5.0;

/** At most this many featured cards; every other watch stock stays in the compact list. */
export const FEATURED_MAX = 3;

// Only the report's own high-signal severities count as a "verified high-impact" news fact.
const NEWS_SEVERITY_RANK: Record<string, number> = { emergency: 3, critical: 2, high: 1 };

/** A stock-linked news item that the saved report really contains (headline, date, id) -- never inferred. */
export type VerifiedNews = { newsId: string; headline: string; newsTime: string; severity: string };

/**
 * The strongest news fact for a watch stock, or null. A news card is only allowed when the saved report holds a
 * real item for this ticker: its id is in the stock's own news_ids AND it has a non-empty headline, a parseable
 * date and a high-signal severity. `news_ids` alone proves nothing (no headline, no date, no destination).
 */
export function verifiedWatchNews(snapshot: ReportSnapshot | null, ticker: string): VerifiedNews | null {
  if (!snapshot) return null;
  const stock = snapshot.watch.find((entry) => entry.ticker_code === ticker);
  if (!stock) return null;
  const linked = new Set(stock.news_ids);
  const usable = snapshot.news
    .filter((item) =>
      item.ticker_code === ticker
      && linked.has(item.news_id)
      && typeof item.news_id === 'string' && item.news_id.trim() !== ''
      && typeof item.headline_ja === 'string' && item.headline_ja.trim() !== ''
      && Number.isFinite(Date.parse(item.news_time))
      && (NEWS_SEVERITY_RANK[item.severity] ?? 0) > 0)
    .sort((left, right) =>
      (NEWS_SEVERITY_RANK[right.severity] ?? 0) - (NEWS_SEVERITY_RANK[left.severity] ?? 0)
      || Date.parse(right.news_time) - Date.parse(left.news_time)
      || left.news_id.localeCompare(right.news_id));
  const best = usable[0];
  return best ? { newsId: best.news_id, headline: best.headline_ja.trim(), newsTime: best.news_time, severity: best.severity } : null;
}

/** 「大きく下落/上昇」 for a move that meets the featured threshold; null otherwise (including a missing %). */
export function featuredMoveLabel(changePercent: number | null): string | null {
  if (changePercent === null || !Number.isFinite(changePercent) || Math.abs(changePercent) < FEATURED_CHANGE_THRESHOLD) return null;
  return changePercent > 0 ? '大きく上昇' : '大きく下落';
}

export type FeaturedKind = 'news' | 'rise' | 'fall';

export type FeaturedWatch = { row: WatchRow; kind: FeaturedKind; news: VerifiedNews | null };

export type WatchLayout = {
  /** 0-3 cards. Empty means the featured section is not rendered at all. */
  featured: FeaturedWatch[];
  /** Every other watch record, in the given order (a featured stock is never repeated here, none is dropped). */
  rest: WatchRow[];
  /** Tickers in `rest` that also qualified but did not fit the cap: they get a small 注目 marker. */
  flagged: ReadonlySet<string>;
};

/**
 * Splits the watch records into featured cards and the compact list, deterministically from the saved report.
 * Candidates: a verified high-impact news fact, or |change| >= 5.0%. News candidates come first (severity, then
 * newest, then ticker), then price candidates (largest |change|, then ticker). A stock appears exactly once.
 * A missing price/percent never qualifies a stock; a stock stays listed and editable regardless.
 */
export function layoutWatchlist(rows: readonly WatchRow[], snapshot: ReportSnapshot | null): WatchLayout {
  const candidates = rows.flatMap((row): Array<{ featured: FeaturedWatch; rank: [number, number, number, string] }> => {
    const news = verifiedWatchNews(snapshot, row.ticker);
    if (news) {
      return [{
        featured: { row, kind: 'news', news },
        rank: [0, -(NEWS_SEVERITY_RANK[news.severity] ?? 0), -Date.parse(news.newsTime), row.ticker],
      }];
    }
    const change = row.changePercent;
    if (change !== null && Number.isFinite(change) && Math.abs(change) >= FEATURED_CHANGE_THRESHOLD) {
      return [{
        featured: { row, kind: change > 0 ? 'rise' : 'fall', news: null },
        rank: [1, -Math.abs(change), 0, row.ticker],
      }];
    }
    return [];
  });
  candidates.sort((left, right) =>
    left.rank[0] - right.rank[0]
    || left.rank[1] - right.rank[1]
    || left.rank[2] - right.rank[2]
    || left.rank[3].localeCompare(right.rank[3]));
  const featured = candidates.slice(0, FEATURED_MAX).map((entry) => entry.featured);
  const featuredIds = new Set(featured.map((entry) => entry.row.tracked.id));
  const flagged = new Set(candidates.slice(FEATURED_MAX).map((entry) => entry.featured.row.ticker));
  return { featured, rest: rows.filter((row) => !featuredIds.has(row.tracked.id)), flagged };
}

/**
 * The compact list under the featured cards. It exists only when there is something left to list, and its count
 * is exactly the number of rows shown there -- never the featured stocks, which are listed in their cards.
 * All featured => no group at all (no "0銘柄" placeholder); none featured => 監視銘柄; otherwise その他の監視銘柄.
 */
export function remainingGroup(featuredCount: number, restCount: number): { show: boolean; title: string; count: number } {
  return {
    show: restCount > 0,
    title: featuredCount > 0 ? 'その他の監視銘柄' : '監視銘柄',
    count: restCount,
  };
}

/** Section wording: 「今日の」 only when the saved prices are today's; otherwise date-neutral with the dated basis. */
export function watchlistLabels(basis: PortfolioBasis | null): { featuredTitle: string; basis: string } {
  const labels = portfolioLabels(basis);
  return { featuredTitle: basis?.isToday ? '今日の注目銘柄' : '注目銘柄', basis: labels.basis };
}

// ---- AI summary card ---------------------------------------------------------------------------------------------------

export type AiSummary = { text: string; reportId: string };

/** The stored, Fact-passed overview of the basis report; never generated or rewritten here. */
export function aiSummary(basis: PortfolioBasis | null): AiSummary | null {
  const text = basis?.report.body?.overview_ja?.trim();
  return basis && text ? { text, reportId: basis.report.id } : null;
}

// ---- number formatting ------------------------------------------------------------------------------------------------

const MINUS = '−';

function group(value: number, maxFractionDigits = 0): string {
  return Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxFractionDigits });
}

/** "¥3,248,500"; "—" for a missing value (never 0). */
export function formatAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  return `${rounded < 0 ? MINUS : ''}¥${group(rounded)}`;
}

/** "+¥218,400" / "−¥7,600" / "±¥0"; "—" for a missing value. */
export function formatSignedAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : rounded < 0 ? MINUS : '±'}¥${group(rounded)}`;
}

/** "+7.21%" / "−1.3%" / "±0.0%"; "—" for a missing value. */
export function formatSignedPercent(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const fixed = Math.abs(value).toFixed(digits);
  const zero = Number(fixed) === 0;
  return `${zero ? '±' : value > 0 ? '+' : MINUS}${fixed}%`;
}

/** A share price: "¥2,731" (up to two decimals when the price has them); "—" when missing. */
export function formatPriceYen(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value < 0 ? MINUS : ''}¥${group(value, 2)}`;
}

export type Tone = 'up' | 'down' | 'flat' | 'none';

export function tone(value: number | null): Tone {
  if (value === null || !Number.isFinite(value)) return 'none';
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}
