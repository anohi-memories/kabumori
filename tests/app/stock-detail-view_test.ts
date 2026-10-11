import assert from "node:assert/strict";
import test from "node:test";

import { buildHoldingRows, verifiedWatchNews } from "../../src/lib/portfolio-view.ts";
import type { PersonalizedReport, ReportSnapshot, ReportStock } from "../../src/lib/report-presentation.ts";
import {
  backLabel,
  buildStockDetail,
  detailPrice,
  KIND_LABEL,
  NOT_REALTIME_NOTE,
  parseStockDetailParams,
  PRICE_REASON,
  registrationMatchesSnapshot,
  searchResultDetailHref,
  snapshotStockFor,
  trackedDetailHref,
  VALUATION_NOTE,
  verifiedStockNews,
} from "../../src/lib/stock-detail-view.ts";
import type { StockMaster, TrackedStock } from "../../src/lib/stocks.ts";

const master = (ticker: string, name = `会社${ticker}`): StockMaster => ({ id: `s-${ticker}`, ticker_code: ticker, company_name: name, market: "プライム" });

function tracked(ticker: string, overrides: Partial<TrackedStock> = {}): TrackedStock {
  const stock = master(ticker);
  return {
    id: `t-${ticker}`, user_id: "u1", stock_id: stock.id, tracking_type: "watch", quantity: null, average_price: null,
    position_type: null, side: null, target_buy_price: null, target_sell_price: null, memo: null, stocks_master: stock, ...overrides,
  };
}

function saved(ticker: string, overrides: Partial<ReportStock> = {}): ReportStock {
  return {
    ticker_code: ticker, company_name: `会社${ticker}`, sector: null, tracking_type: "watch", quantity: null, average_price: null,
    position_type: null, side: null,
    price: { status: "ok", sessionDate: "2026-10-06", close: 1250.5, previousClose: 1200, change: 50.5, changePercent: 4.21 },
    market_value: null, day_pl: null, unrealized_pl: null, unrealized_pl_percent: null, news_ids: [], market_news_ids: [], ...overrides,
  };
}

function report(snapshot: Partial<ReportSnapshot> = {}, overrides: Partial<PersonalizedReport> = {}): PersonalizedReport {
  return {
    id: "r1", report_type: "close", trading_date: "2026-10-07", title_ja: null, summary_ja: null, body: null, generated_at: "2026-10-06T08:15:00Z",
    portfolio_snapshot: {
      report_type: "close", trading_date: "2026-10-07", price_basis_date: "2026-10-06", holdings: [], watch: [], indices: [],
      totals: {
        holding_count: 0, watch_count: 0, all_holdings_valued: true, market_value: null, day_pl: null, day_change_percent: null,
        unrealized_pl: null, topix_change_percent: null, relative_to_topix_pt: null, relative_label: null,
      },
      sector_weights: [], top_impact: [], gainers: [], decliners: [], news: [], data_gaps: [], ...snapshot,
    },
    ...overrides,
  };
}

// ---- route params ---------------------------------------------------------------------------------------------

test("route params keep only identifiers and a known origin", () => {
  assert.deepEqual(parseStockDetailParams({ trackedId: "abc-123", from: "stocks" }), { trackedId: "abc-123", stockId: null, origin: "stocks" });
  assert.deepEqual(parseStockDetailParams({ stockId: "7f3c-9", from: "search" }), { trackedId: null, stockId: "7f3c-9", origin: "search" });
  assert.deepEqual(parseStockDetailParams({ trackedId: ["first", "second"], from: ["search"] }), { trackedId: "first", stockId: null, origin: "search" });
  assert.deepEqual(parseStockDetailParams({}), { trackedId: null, stockId: null, origin: null });
});

test("a malformed or hostile id is dropped before it can reach a query", () => {
  for (const bad of ["", " ", "a/b", "a b", "x=1&y=2", "id.eq.1,or(true)", "a".repeat(65), "../../etc", 42, null, undefined, {}]) {
    assert.equal(parseStockDetailParams({ trackedId: bad }).trackedId, null, String(bad));
    assert.equal(parseStockDetailParams({ stockId: bad }).stockId, null, String(bad));
  }
  assert.equal(parseStockDetailParams({ from: "home" }).origin, null, "an unknown origin is not trusted");
});

test("the route objects carry identifiers and the origin only -- never a price, a quantity or a token", () => {
  assert.deepEqual(trackedDetailHref("t-1"), { pathname: "/stock-detail", params: { trackedId: "t-1", from: "stocks" } });
  assert.deepEqual(searchResultDetailHref("s-1"), { pathname: "/stock-detail", params: { stockId: "s-1", from: "search" } });
  for (const href of [trackedDetailHref("t-1"), searchResultDetailHref("s-1")]) {
    assert.ok(Object.keys(href.params).every((key) => ["trackedId", "stockId", "from"].includes(key)));
  }
});

test("戻る names the screen it returns to", () => {
  assert.equal(backLabel("stocks"), "銘柄に戻る");
  assert.equal(backLabel("search"), "検索に戻る");
  assert.equal(backLabel(null), "戻る");
});

// ---- saved close ----------------------------------------------------------------------------------------------

test("a saved price shows close, previous-close difference and percent with its own dated basis", () => {
  const r = report({ watch: [saved("1111")] });
  const price = detailPrice(r, saved("1111"));
  assert.deepEqual(price, { available: true, close: 1250.5, previousClose: 1200, change: 50.5, changePercent: 4.21, basisLabel: "10/6 終値ベース" });
  assert.equal(NOT_REALTIME_NOTE, "リアルタイムではありません");
});

test("the date is the price's session date, else the price basis date, and never the trading date while a basis date exists", () => {
  const noSession = saved("1111", { price: { status: "ok", sessionDate: null, close: 100, previousClose: null, change: null, changePercent: null } });
  const r = report({ price_basis_date: "2026-10-06" }); // trading_date is 10/7
  const price = detailPrice(r, noSession);
  assert.ok(price.available && price.basisLabel === "10/6 終値ベース", "price_basis_date wins over trading_date");
  const noBasis = report({ price_basis_date: null });
  const fallback = detailPrice(noBasis, noSession);
  assert.ok(fallback.available && fallback.basisLabel === "10/7 終値ベース", "trading_date only when there is no price basis date");
  const malformed = detailPrice(report({ price_basis_date: "not-a-date" }), { ...noSession, price: { ...noSession.price, sessionDate: "x" } });
  assert.ok(malformed.available && malformed.basisLabel === "保存済み終値ベース", "no invented date");
  const own = detailPrice(r, saved("1111", { price: { status: "ok", sessionDate: "2026-10-02", close: 5, previousClose: null, change: null, changePercent: null } }));
  assert.ok(own.available && own.basisLabel === "10/2 終値ベース", "the stock's own session date is the truthful one");
});

test("no report, no row, an unavailable price or a non-finite close is '—' with a reason -- never a zero or a fake figure", () => {
  assert.deepEqual(detailPrice(null, saved("1111")), { available: false, reason: PRICE_REASON.noReport });
  assert.deepEqual(detailPrice(report(), null), { available: false, reason: PRICE_REASON.notInReport });
  const unavailable = saved("1111", { price: { status: "unavailable", sessionDate: null, close: 100, previousClose: null, change: null, changePercent: null } });
  assert.deepEqual(detailPrice(report(), unavailable), { available: false, reason: PRICE_REASON.notInReport });
  for (const close of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const row = saved("1111", { price: { status: "ok", sessionDate: "2026-10-06", close, previousClose: 1, change: 1, changePercent: 1 } });
    assert.equal(detailPrice(report(), row).available, false, String(close));
  }
  const noSnapshot = { ...report(), portfolio_snapshot: null };
  assert.deepEqual(detailPrice(noSnapshot, saved("1111")), { available: false, reason: PRICE_REASON.noReport });
});

test("a price with missing or non-finite difference fields keeps the close and nulls only those fields; zero stays zero", () => {
  const partial = saved("1111", { price: { status: "ok", sessionDate: "2026-10-06", close: 980, previousClose: Number.NaN, change: null, changePercent: Number.POSITIVE_INFINITY } });
  const price = detailPrice(report(), partial);
  assert.deepEqual(price, { available: true, close: 980, previousClose: null, change: null, changePercent: null, basisLabel: "10/6 終値ベース" });
  const flat = detailPrice(report(), saved("1111", { price: { status: "ok", sessionDate: "2026-10-06", close: 500, previousClose: 500, change: 0, changePercent: 0 } }));
  assert.ok(flat.available && flat.change === 0 && flat.changePercent === 0, "a real 0 is shown as 0, not as missing");
});

// ---- registration kinds -----------------------------------------------------------------------------------------

test("an unregistered stock never gets a user-specific quote, holding or news, even when the report knows the ticker", () => {
  const r = report({ holdings: [saved("2222", { tracking_type: "holding", quantity: 10, average_price: 100, market_value: 1000 })], watch: [saved("1111")] });
  for (const ticker of ["1111", "2222"]) {
    const view = buildStockDetail({ stock: master(ticker), tracked: null, report: r });
    assert.equal(view.kind, "unregistered");
    assert.equal(view.kindLabel, "未登録");
    assert.deepEqual(view.price, { available: false, reason: PRICE_REASON.unregistered });
    assert.equal(view.holding, null);
    assert.equal(view.news, null);
    assert.equal(view.tracked, null);
    assert.equal(view.targetBuy, null);
    assert.equal(view.memo, null);
  }
});

test("a watch stock shows its saved price and targets, and no holding block", () => {
  const view = buildStockDetail({
    stock: master("1111"),
    tracked: tracked("1111", { target_buy_price: 1000, target_sell_price: 1500.5, memo: "  決算前に確認  " }),
    report: report({ watch: [saved("1111")] }),
  });
  assert.equal(view.kind, "watch");
  assert.equal(view.kindLabel, KIND_LABEL.watch);
  assert.equal(view.holding, null);
  assert.ok(view.price.available && view.price.close === 1250.5);
  assert.equal(view.targetBuy, 1000);
  assert.equal(view.targetSell, 1500.5);
  assert.equal(view.memo, "決算前に確認");
});

test("a watch stock reads only the watch list and a holding only the holdings list (no cross-leak)", () => {
  const r = report({ holdings: [saved("1111", { tracking_type: "holding", quantity: 5, average_price: 10 })], watch: [] });
  const watchView = buildStockDetail({ stock: master("1111"), tracked: tracked("1111"), report: r });
  assert.deepEqual(watchView.price, { available: false, reason: PRICE_REASON.notInReport });
  const r2 = report({ holdings: [], watch: [saved("1111")] });
  const holdingView = buildStockDetail({ stock: master("1111"), tracked: tracked("1111", { tracking_type: "holding", quantity: 5, average_price: 10 }), report: r2 });
  assert.deepEqual(holdingView.price, { available: false, reason: PRICE_REASON.notInReport });
  assert.equal(snapshotStockFor(r.portfolio_snapshot, "1111", "watch"), null);
  assert.ok(snapshotStockFor(r.portfolio_snapshot, "1111", "holding"));
});

test("a holding shows quantity, average price, position and side from the registration and the saved valuation when it matches", () => {
  const row = saved("3333", {
    tracking_type: "holding", quantity: 100, average_price: 900, position_type: "margin", side: "short",
    market_value: 125050, day_pl: -5000, unrealized_pl: -35050, unrealized_pl_percent: -21.9,
  });
  const reg = tracked("3333", { tracking_type: "holding", quantity: 100, average_price: 900, position_type: "margin", side: "short" });
  const view = buildStockDetail({ stock: master("3333"), tracked: reg, report: report({ holdings: [row] }) });
  assert.equal(view.kind, "holding");
  assert.equal(view.kindLabel, "保有");
  assert.deepEqual(view.holding, {
    quantity: 100, averagePrice: 900, positionLabel: "信用", sideLabel: "売り",
    valuation: { marketValue: 125050, dayPl: -5000, unrealizedPl: -35050, unrealizedPlPercent: -21.9 },
    valuationNote: null,
  });
  // The figures are exactly what the portfolio row shows (no second sign/arithmetic path).
  const portfolioRow = buildHoldingRows([reg], report({ holdings: [row] }), registrationMatchesSnapshot)[0];
  assert.equal(view.holding?.valuation?.marketValue, portfolioRow.marketValue);
  assert.equal(view.holding?.valuation?.dayPl, portfolioRow.dayPl);
  assert.equal(view.holding?.valuation?.unrealizedPl, portfolioRow.unrealizedPl);
  assert.equal(view.holding?.valuation?.unrealizedPlPercent, portfolioRow.unrealizedPlPercent);
  const price = view.price;
  assert.ok(price.available && price.close === portfolioRow.close && price.changePercent === portfolioRow.changePercent);
});

test("a holding edited after the report was saved withholds the old valuation instead of pairing it with new numbers", () => {
  const row = saved("3333", { tracking_type: "holding", quantity: 100, average_price: 900, market_value: 125050, day_pl: 1, unrealized_pl: 2, unrealized_pl_percent: 3 });
  const edited = tracked("3333", { tracking_type: "holding", quantity: 200, average_price: 900 });
  assert.equal(registrationMatchesSnapshot(edited, row), false);
  const view = buildStockDetail({ stock: master("3333"), tracked: edited, report: report({ holdings: [row] }) });
  assert.equal(view.holding?.quantity, 200);
  assert.equal(view.holding?.valuation, null);
  assert.equal(view.holding?.valuationNote, VALUATION_NOTE.changed);
  const same = tracked("3333", { tracking_type: "holding", quantity: 100, average_price: 900 });
  assert.equal(registrationMatchesSnapshot(same, row), true);
});

// K1 correction (PR #136): the saved valuation belongs to the exact position it was computed for. Quantity and
// average price alone are not enough -- 現物/信用 and 買い/売り change what the saved figures mean.
function valued(overrides: Partial<ReportStock> = {}): ReportStock {
  return saved("3333", {
    tracking_type: "holding", quantity: 100, average_price: 900, position_type: "cash", side: "long",
    market_value: 125050, day_pl: 1500, unrealized_pl: 35050, unrealized_pl_percent: 38.9, ...overrides,
  });
}
function registered(overrides: Partial<TrackedStock> = {}): TrackedStock {
  return tracked("3333", { tracking_type: "holding", quantity: 100, average_price: 900, position_type: "cash", side: "long", ...overrides });
}
function detailFor(reg: TrackedStock, row: ReportStock) {
  return buildStockDetail({ stock: master("3333"), tracked: reg, report: report({ holdings: [row] }) });
}

test("the saved valuation is kept only when quantity, average price, position type, side and role all match", () => {
  const view = detailFor(registered(), valued());
  assert.equal(registrationMatchesSnapshot(registered(), valued()), true);
  assert.deepEqual(view.holding?.valuation, { marketValue: 125050, dayPl: 1500, unrealizedPl: 35050, unrealizedPlPercent: 38.9 });
  assert.equal(view.holding?.valuationNote, null);
});

test("same quantity and average price, but the side changed (long <-> short): the old valuation is withheld", () => {
  for (const [now, then] of [["long", "short"], ["short", "long"]] as const) {
    const reg = registered({ side: now });
    const row = valued({ side: then });
    assert.equal(registrationMatchesSnapshot(reg, row), false, `${then} -> ${now}`);
    const view = detailFor(reg, row);
    assert.equal(view.holding?.valuation, null);
    assert.equal(view.holding?.valuationNote, VALUATION_NOTE.changed);
    assert.equal(view.holding?.sideLabel, now === "long" ? "買い" : "売り", "the registration's own label is still shown");
  }
});

test("same quantity and average price, but the position type changed (cash <-> margin): the old valuation is withheld", () => {
  for (const [now, then] of [["cash", "margin"], ["margin", "cash"]] as const) {
    const reg = registered({ position_type: now });
    const row = valued({ position_type: then });
    assert.equal(registrationMatchesSnapshot(reg, row), false, `${then} -> ${now}`);
    const view = detailFor(reg, row);
    assert.equal(view.holding?.valuation, null);
    assert.equal(view.holding?.valuationNote, VALUATION_NOTE.changed);
    assert.equal(view.holding?.positionLabel, now === "cash" ? "現物" : "信用");
  }
});

test("a saved row whose own role is not 'holding' is never paired with a holding registration", () => {
  const row = valued({ tracking_type: "watch" });
  assert.equal(registrationMatchesSnapshot(registered(), row), false);
  const view = detailFor(registered(), row);
  assert.equal(view.holding?.valuation, null);
  assert.equal(view.holding?.valuationNote, VALUATION_NOTE.changed);
  // The role is compared against the registration too (a watch registration vs a holding row).
  assert.equal(registrationMatchesSnapshot(registered({ tracking_type: "watch" }), valued()), false);
});

test("missing values never turn into a match: null/legacy fields match only each other, never a concrete value", () => {
  // Both sides blank (the user never entered them): same position, so the valuation stays.
  const blankReg = registered({ position_type: null, side: null });
  const blankRow = valued({ position_type: null, side: null });
  assert.equal(registrationMatchesSnapshot(blankReg, blankRow), true);
  // A legacy saved row without the fields at all counts as blank, not as a wildcard.
  const legacy = { ...blankRow } as Record<string, unknown>;
  delete legacy.position_type;
  delete legacy.side;
  assert.equal(registrationMatchesSnapshot(blankReg, legacy as unknown as ReportStock), true);
  assert.equal(registrationMatchesSnapshot(registered(), legacy as unknown as ReportStock), false, "a concrete registration vs a blank saved row");
  assert.equal(registrationMatchesSnapshot(blankReg, valued()), false, "a blank registration vs a concrete saved row");
  // A non-finite number is not equal to anything, including another non-finite number.
  assert.equal(registrationMatchesSnapshot(registered({ quantity: Number.NaN }), valued({ quantity: Number.NaN })), true, "both normalise to null = both blank");
  assert.equal(registrationMatchesSnapshot(registered({ quantity: Number.NaN }), valued()), false);
});

test("an edit that is reverted matches again (the valuation comes back); the share price stays visible throughout", () => {
  const row = valued();
  const edited = detailFor(registered({ side: "short" }), row);
  assert.equal(edited.holding?.valuation, null);
  assert.ok(edited.price.available, "the saved close is independent of the position and keeps its dated basis");
  const reverted = detailFor(registered(), row);
  assert.notEqual(reverted.holding?.valuation, null);
});

test("a holding the report does not know yet says so; with no report at all there is no note and no valuation", () => {
  const reg = tracked("4444", { tracking_type: "holding", quantity: 10, average_price: 100 });
  const pending = buildStockDetail({ stock: master("4444"), tracked: reg, report: report({ holdings: [] }) });
  assert.equal(pending.holding?.valuation, null);
  assert.equal(pending.holding?.valuationNote, VALUATION_NOTE.pending);
  assert.deepEqual(pending.price, { available: false, reason: PRICE_REASON.notInReport });
  const none = buildStockDetail({ stock: master("4444"), tracked: reg, report: null });
  assert.equal(none.holding?.valuation, null);
  assert.equal(none.holding?.valuationNote, null);
  assert.deepEqual(none.price, { available: false, reason: PRICE_REASON.noReport });
});

test("a holding with nothing entered keeps nulls (never 0) and non-finite numbers are dropped", () => {
  const reg = tracked("5555", { tracking_type: "holding", quantity: Number.NaN, average_price: null, position_type: null, side: null, target_buy_price: Number.POSITIVE_INFINITY, target_sell_price: null });
  const view = buildStockDetail({ stock: master("5555"), tracked: reg, report: null });
  assert.deepEqual(view.holding, { quantity: null, averagePrice: null, positionLabel: null, sideLabel: null, valuation: null, valuationNote: null });
  assert.equal(view.targetBuy, null);
  assert.equal(view.targetSell, null);
});

test("a blank memo is no memo", () => {
  const view = buildStockDetail({ stock: master("6666"), tracked: tracked("6666", { memo: "   " }), report: null });
  assert.equal(view.memo, null);
});

// ---- verified news ----------------------------------------------------------------------------------------------

function newsItem(overrides: Partial<ReportSnapshot["news"][number]> = {}): ReportSnapshot["news"][number] {
  return {
    news_id: "n1", ticker_code: "1111", company_name: "会社1111", severity: "high", headline_ja: "業績予想を修正",
    news_time: "2026-10-06T06:00:00Z", source_url: null, ...overrides,
  };
}

test("a news card needs a real item: own news_ids, same ticker, headline, parseable date and a high-signal severity", () => {
  const stock = saved("1111", { news_ids: ["n1"] });
  const ok = report({ watch: [stock], news: [newsItem()] }).portfolio_snapshot;
  assert.deepEqual(verifiedStockNews(ok, "1111", "watch"), { newsId: "n1", headline: "業績予想を修正", newsTime: "2026-10-06T06:00:00Z", severity: "high" });
  const cases: Array<[string, Partial<ReportSnapshot["news"][number]>]> = [
    ["another ticker", { ticker_code: "9999" }],
    ["blank headline", { headline_ja: "   " }],
    ["bad date", { news_time: "yesterday" }],
    ["low severity", { severity: "medium" }],
    ["id not linked", { news_id: "n2" }],
  ];
  for (const [label, override] of cases) {
    const snapshot = report({ watch: [stock], news: [newsItem(override)] }).portfolio_snapshot;
    assert.equal(verifiedStockNews(snapshot, "1111", "watch"), null, label);
  }
  const idsOnly = report({ watch: [stock], news: [] }).portfolio_snapshot;
  assert.equal(verifiedStockNews(idsOnly, "1111", "watch"), null, "news_ids alone proves nothing");
  assert.equal(verifiedStockNews(null, "1111", "watch"), null);
});

test("the detail applies the same news bar as the watchlist card, for watch stocks and holdings alike", () => {
  const stock = saved("1111", { news_ids: ["n1", "n2", "n3"] });
  const items = [
    newsItem({ news_id: "n1", severity: "high", news_time: "2026-10-06T09:00:00Z" }),
    newsItem({ news_id: "n2", severity: "critical", news_time: "2026-10-05T09:00:00Z", headline_ja: "重大な発表" }),
    newsItem({ news_id: "n3", severity: "critical", news_time: "2026-10-06T01:00:00Z", headline_ja: "新しい重大な発表" }),
  ];
  const snapshot = report({ watch: [stock], news: items }).portfolio_snapshot;
  const watch = verifiedWatchNews(snapshot, "1111");
  const detail = verifiedStockNews(snapshot, "1111", "watch");
  assert.deepEqual(detail, watch, "severity first, then the newest, exactly as verifiedWatchNews");
  assert.equal(detail?.newsId, "n3");
  const holdingSnapshot = report({ holdings: [{ ...stock, tracking_type: "holding" }], news: items }).portfolio_snapshot;
  assert.equal(verifiedStockNews(holdingSnapshot, "1111", "holding")?.newsId, "n3");
  assert.equal(verifiedStockNews(holdingSnapshot, "1111", "watch"), null, "a holding's news is not borrowed for a watch lookup");
});

test("the view carries the news only for a registered stock that has a verified item", () => {
  const snapshot = { watch: [saved("1111", { news_ids: ["n1"] })], news: [newsItem()] };
  const registered = buildStockDetail({ stock: master("1111"), tracked: tracked("1111"), report: report(snapshot) });
  assert.equal(registered.news?.newsId, "n1");
  const unregistered = buildStockDetail({ stock: master("1111"), tracked: null, report: report(snapshot) });
  assert.equal(unregistered.news, null);
  const without = buildStockDetail({ stock: master("1111"), tracked: tracked("1111"), report: report({ watch: [saved("1111")], news: [] }) });
  assert.equal(without.news, null);
});
