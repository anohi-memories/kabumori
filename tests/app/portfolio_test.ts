import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStockRows,
  formatYen,
  latestCloseReport,
  portfolioBasisLabel,
  positionLabel,
  type PersonalizedReport,
  type ReportSnapshot,
} from "../../src/lib/report-presentation.ts";

function snapshot(overrides: Partial<ReportSnapshot> = {}): ReportSnapshot {
  return {
    report_type: "close",
    trading_date: "2026-09-22",
    price_basis_date: "2026-09-21",
    holdings: [{
      ticker_code: "8136", company_name: "サンリオ", sector: "卸売業", tracking_type: "holding",
      quantity: 100, average_price: 5000, position_type: "cash", side: "long",
      price: { status: "ok", sessionDate: "2026-09-21", close: 5200, previousClose: 5100, change: 100, changePercent: 1.96 },
      market_value: 520000, day_pl: 10000, unrealized_pl: 20000, unrealized_pl_percent: 4, news_ids: [], market_news_ids: [],
    }],
    watch: [{
      ticker_code: "7203", company_name: "トヨタ", sector: "輸送用機器", tracking_type: "watch",
      quantity: null, average_price: null, position_type: null, side: null,
      price: { status: "ok", sessionDate: "2026-09-21", close: 3000, previousClose: 2990, change: 10, changePercent: 0.33 },
      market_value: null, day_pl: null, unrealized_pl: null, unrealized_pl_percent: null, news_ids: [], market_news_ids: [],
    }],
    indices: [],
    totals: { holding_count: 1, watch_count: 1, all_holdings_valued: true, market_value: 520000, day_pl: 10000, day_change_percent: 1.96, unrealized_pl: 20000, topix_change_percent: null, relative_to_topix_pt: null, relative_label: null },
    sector_weights: [], top_impact: [], gainers: [], decliners: [], news: [], data_gaps: [],
    ...overrides,
  };
}

function report(tradingDate: string, snapshotValue: ReportSnapshot | null): PersonalizedReport {
  return { id: tradingDate, report_type: "close", trading_date: tradingDate, title_ja: "大引け", summary_ja: null, body: null, portfolio_snapshot: snapshotValue, generated_at: `${tradingDate}T08:00:00Z` };
}

test("latest close report ignores morning reports and reports without snapshots", () => {
  const selected = latestCloseReport([
    { ...report("2026-09-22", snapshot()), report_type: "morning" },
    report("2026-09-20", snapshot()),
    report("2026-09-21", null),
    report("2026-09-19", snapshot()),
  ]);
  assert.equal(selected?.trading_date, "2026-09-20");
});

test("portfolio basis label makes stale closing data explicit", () => {
  assert.equal(portfolioBasisLabel(report("2026-09-22", snapshot())), "9/21 終値ベース");
  assert.equal(formatYen(snapshot().totals.market_value), "520,000円");
});

test("portfolio rows keep holdings separate from watchlist rows", () => {
  const built = buildStockRows(report("2026-09-22", snapshot()));
  assert.equal(built.holdings.length, 1);
  assert.equal(built.watch.length, 0);
  assert.equal(positionLabel(built.holdings[0].stock), "保有・現物");
  assert.equal(built.holdings[0].plLine, "今日の損益 +10,000円");
});

test("portfolio can represent unavailable totals without inventing values", () => {
  const value = snapshot({ totals: { ...snapshot().totals, market_value: null, day_pl: null, unrealized_pl: null, all_holdings_valued: false } });
  assert.equal(formatYen(value.totals.market_value), "—");
  assert.equal(value.totals.all_holdings_valued, false);
});
