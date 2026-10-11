// View model of the 銘柄詳細 screen (no RN imports and no runtime sibling imports, so it is testable with Deno).
//
// The screen is READ-ONLY. Everything market-related comes from the signed-in user's latest SAVED close report
// (`portfolio_snapshot`): there is no live quote, so nothing here says "now"; a missing value stays null (the
// screen renders "—", never 0); and an unregistered stock never gets a user-specific quote or holding figure.
// The only way to change a registration is the existing TrackedStockEditor, opened by an explicit button.
//
// The route carries identifiers and the origin only -- never a price, a quantity or a token.

import type { PersonalizedReport, ReportSnapshot, ReportStock } from './report-presentation';
import type { StockMaster, TrackedStock, TrackingType } from './stocks';

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// ---- route params -------------------------------------------------------------------------------------------

export const STOCK_DETAIL_ROUTE = '/stock-detail';

/** Where the detail was opened from. It only labels the 戻る control: the screen below it in the stack is the origin. */
export type StockDetailOrigin = 'stocks' | 'search';

export type StockDetailParams = {
  /** The user's own tracked_stocks row (portfolio / watchlist rows). */
  trackedId: string | null;
  /** The shared stocks_master row (search results). A registered stock is resolved to its tracked row. */
  stockId: string | null;
  origin: StockDetailOrigin | null;
};

// Row identifiers are uuid-like; anything else (empty, a path, a query fragment) is dropped before it can reach
// a query. Parameters are bound by the client anyway; this only avoids pointless requests.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function paramString(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && ID.test(raw) ? raw : null;
}

export function parseStockDetailParams(raw: { trackedId?: unknown; stockId?: unknown; from?: unknown }): StockDetailParams {
  const from = Array.isArray(raw.from) ? raw.from[0] : raw.from;
  return {
    trackedId: paramString(raw.trackedId),
    stockId: paramString(raw.stockId),
    origin: from === 'stocks' || from === 'search' ? from : null,
  };
}

/** The route object for a registered stock opened from the 銘柄 tab (portfolio or watchlist). */
export function trackedDetailHref(trackedId: string) {
  return { pathname: STOCK_DETAIL_ROUTE, params: { trackedId, from: 'stocks' } } as const;
}

/** The route object for a registered search result. */
export function searchResultDetailHref(stockId: string) {
  return { pathname: STOCK_DETAIL_ROUTE, params: { stockId, from: 'search' } } as const;
}

/** The text of the 戻る control: it names the screen the swipe/back returns to. */
export function backLabel(origin: StockDetailOrigin | null): string {
  if (origin === 'search') return '検索に戻る';
  if (origin === 'stocks') return '銘柄に戻る';
  return '戻る';
}

// ---- saved close ----------------------------------------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function monthDay(date: string | null | undefined): string | null {
  const match = date ? DATE.exec(date) : null;
  return match ? `${Number(match[2])}/${Number(match[3])}` : null;
}

export const NOT_REALTIME_NOTE = 'リアルタイムではありません';

export type DetailPrice =
  | { available: false; reason: string }
  | {
    available: true;
    close: number;
    previousClose: number | null;
    change: number | null;
    changePercent: number | null;
    /** "10/6 終値ベース" -- the price's own session date, else the report's price basis date. */
    basisLabel: string;
  };

export const PRICE_REASON = {
  unregistered: '未登録の銘柄のため、保存済みの終値は表示されません。',
  noReport: '保存済みの大引けレポートがまだありません。',
  notInReport: '最新の保存済みレポートに、この銘柄の終値データがありません。',
} as const;

/** The snapshot's row for this ticker in the list that matches the registration (a holding never reads the watch list). */
export function snapshotStockFor(snapshot: ReportSnapshot | null, ticker: string, trackingType: TrackingType): ReportStock | null {
  if (!snapshot) return null;
  const list = trackingType === 'holding' ? snapshot.holdings : snapshot.watch;
  return list.find((entry) => entry.ticker_code === ticker) ?? null;
}

/**
 * Close, previous-close difference and signed percent, only when the saved row is `ok` with a finite close. The
 * date is the price's own session date when it has one; otherwise the report's `price_basis_date` -- never the
 * report's trading_date while a price basis date exists.
 */
export function detailPrice(report: PersonalizedReport | null, stock: ReportStock | null): DetailPrice {
  if (!report?.portfolio_snapshot) return { available: false, reason: PRICE_REASON.noReport };
  if (!stock || stock.price.status !== 'ok') return { available: false, reason: PRICE_REASON.notInReport };
  const close = finite(stock.price.close);
  if (close === null) return { available: false, reason: PRICE_REASON.notInReport };
  const snapshot = report.portfolio_snapshot;
  const date = monthDay(stock.price.sessionDate) ?? monthDay(snapshot.price_basis_date ?? report.trading_date);
  return {
    available: true,
    close,
    previousClose: finite(stock.price.previousClose),
    change: finite(stock.price.change),
    changePercent: finite(stock.price.changePercent),
    basisLabel: date ? `${date} 終値ベース` : '保存済み終値ベース',
  };
}

// ---- holdings --------------------------------------------------------------------------------------------------

export const POSITION_LABEL = { cash: '現物', margin: '信用' } as const;
export const SIDE_LABEL = { long: '買い', short: '売り' } as const;

export type HoldingDetail = {
  quantity: number | null;
  averagePrice: number | null;
  /** "現物" / "信用" / null (not entered). */
  positionLabel: string | null;
  /** "買い" / "売り" / null (not entered). */
  sideLabel: string | null;
  /** Saved valuation of the holding, only when the saved row really describes the CURRENT registration. */
  valuation: null | {
    marketValue: number | null;
    dayPl: number | null;
    unrealizedPl: number | null;
    unrealizedPlPercent: number | null;
  };
  /** Why there is no valuation (not yet in a report / registration changed since it), else null. */
  valuationNote: string | null;
};

/**
 * True when the saved row was computed from the same quantity and average price the user has registered now.
 * After an edit the saved valuation belongs to the old numbers; it is withheld until the next report.
 */
export function registrationMatchesSnapshot(tracked: TrackedStock, saved: ReportStock): boolean {
  return finite(tracked.quantity) === finite(saved.quantity) && finite(tracked.average_price) === finite(saved.average_price);
}

export const VALUATION_NOTE = {
  pending: '最新のレポートにはまだ反映されていません。',
  changed: '登録内容を変更したため、評価額は次のレポートから反映されます。',
} as const;

function holdingDetail(tracked: TrackedStock, saved: ReportStock | null, hasReport: boolean): HoldingDetail {
  const base = {
    quantity: finite(tracked.quantity),
    averagePrice: finite(tracked.average_price),
    positionLabel: tracked.position_type ? POSITION_LABEL[tracked.position_type] ?? null : null,
    sideLabel: tracked.side ? SIDE_LABEL[tracked.side] ?? null : null,
  };
  if (!saved) return { ...base, valuation: null, valuationNote: hasReport ? VALUATION_NOTE.pending : null };
  if (!registrationMatchesSnapshot(tracked, saved)) return { ...base, valuation: null, valuationNote: VALUATION_NOTE.changed };
  return {
    ...base,
    valuation: {
      marketValue: finite(saved.market_value),
      dayPl: finite(saved.day_pl),
      unrealizedPl: finite(saved.unrealized_pl),
      unrealizedPlPercent: finite(saved.unrealized_pl_percent),
    },
    valuationNote: null,
  };
}

// ---- verified news -----------------------------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = { emergency: 3, critical: 2, high: 1 };

export type DetailNews = { newsId: string; headline: string; newsTime: string; severity: string };

/**
 * The strongest news fact the saved report really holds for this stock, or null. The same bar as the watchlist
 * card (`verifiedWatchNews`), for either registration type: the id is in the stock's OWN news_ids AND the item
 * has the same ticker, a non-empty headline, a parseable date and a high-signal severity. `news_ids` alone
 * proves nothing -- no headline, no date, no destination -- so it never produces a card.
 */
export function verifiedStockNews(snapshot: ReportSnapshot | null, ticker: string, trackingType: TrackingType): DetailNews | null {
  const stock = snapshotStockFor(snapshot, ticker, trackingType);
  if (!snapshot || !stock) return null;
  const linked = new Set(stock.news_ids);
  const best = snapshot.news
    .filter((item) =>
      item.ticker_code === ticker
      && linked.has(item.news_id)
      && typeof item.news_id === 'string' && item.news_id.trim() !== ''
      && typeof item.headline_ja === 'string' && item.headline_ja.trim() !== ''
      && Number.isFinite(Date.parse(item.news_time))
      && (SEVERITY_RANK[item.severity] ?? 0) > 0)
    .sort((left, right) =>
      (SEVERITY_RANK[right.severity] ?? 0) - (SEVERITY_RANK[left.severity] ?? 0)
      || Date.parse(right.news_time) - Date.parse(left.news_time)
      || left.news_id.localeCompare(right.news_id))[0];
  return best ? { newsId: best.news_id, headline: best.headline_ja.trim(), newsTime: best.news_time, severity: best.severity } : null;
}

// ---- the view ----------------------------------------------------------------------------------------------------

export type RegistrationKind = TrackingType | 'unregistered';

export const KIND_LABEL: Record<RegistrationKind, string> = { holding: '保有', watch: '監視', unregistered: '未登録' };

export type StockDetailView = {
  stockId: string;
  ticker: string;
  company: string;
  market: string;
  kind: RegistrationKind;
  kindLabel: string;
  price: DetailPrice;
  holding: HoldingDetail | null;
  targetBuy: number | null;
  targetSell: number | null;
  memo: string | null;
  news: DetailNews | null;
  /** The registered record the existing editor edits; null for an unregistered stock. */
  tracked: TrackedStock | null;
};

/**
 * `tracked` is the user's own registration (null = not registered); `stock` is the shared master record (for a
 * registration it is the one joined to it). `report` is the user's latest saved close report.
 */
export function buildStockDetail(input: { stock: StockMaster; tracked: TrackedStock | null; report: PersonalizedReport | null }): StockDetailView {
  const { stock, tracked, report } = input;
  const snapshot = report?.portfolio_snapshot ?? null;
  const common = { stockId: stock.id, ticker: stock.ticker_code, company: stock.company_name, market: stock.market };

  if (!tracked) {
    return {
      ...common,
      kind: 'unregistered',
      kindLabel: KIND_LABEL.unregistered,
      price: { available: false, reason: PRICE_REASON.unregistered },
      holding: null,
      targetBuy: null,
      targetSell: null,
      memo: null,
      news: null,
      tracked: null,
    };
  }

  const kind: TrackingType = tracked.tracking_type === 'holding' ? 'holding' : 'watch';
  const saved = snapshotStockFor(snapshot, stock.ticker_code, kind);
  return {
    ...common,
    kind,
    kindLabel: KIND_LABEL[kind],
    price: detailPrice(report, saved),
    holding: kind === 'holding' ? holdingDetail(tracked, saved, snapshot !== null) : null,
    targetBuy: finite(tracked.target_buy_price),
    targetSell: finite(tracked.target_sell_price),
    memo: tracked.memo?.trim() ? tracked.memo.trim() : null,
    news: verifiedStockNews(snapshot, stock.ticker_code, kind),
    tracked,
  };
}
