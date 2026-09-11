import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStockRows,
  dataGapNotes,
  formatDateJa,
  formatPercent,
  formatPrice,
  formatSignedYen,
  formatTimeJa,
  formatYen,
  type PersonalizedReport,
  positionLabel,
  relativeText,
  reportRouteForPush,
  type ReportStock,
  reportTypeLabel,
  toneLabel,
} from "../../src/lib/report-presentation.ts";

function stock(overrides: Partial<ReportStock> & { ticker_code: string }): ReportStock {
  return {
    company_name: `会社${overrides.ticker_code}`,
    sector: "サービス業",
    tracking_type: "holding",
    quantity: 100,
    average_price: 1000,
    position_type: "cash",
    side: "long",
    price: { status: "ok", sessionDate: "2026-09-11", close: 1210, previousClose: 1100, change: 110, changePercent: 10 },
    market_value: 121000,
    day_pl: 11000,
    unrealized_pl: 21000,
    unrealized_pl_percent: 21,
    news_ids: [],
    market_news_ids: [],
    ...overrides,
  };
}

function report(overrides: Partial<PersonalizedReport> = {}): PersonalizedReport {
  return {
    id: "8b0c3a64-1111-4a2b-9c3d-000000000001",
    report_type: "close",
    trading_date: "2026-09-11",
    title_ja: "保有株は上昇",
    summary_ja: "ポートは堅調でした。",
    generated_at: "2026-09-11T08:15:00Z",
    body: {
      tone: "positive",
      overview_ja: "TOPIXより強い一日でした。",
      stock_notes: [{ ticker_code: "1111", note_ja: "自己株式の取得を決定したと確認できます。" }],
      watch_notes: [{ ticker_code: "3333", note_ja: "新製品の発表が出ています。" }],
      risk_notes_ja: [],
      checkpoints_ja: ["取得の進み具合"],
    },
    portfolio_snapshot: {
      report_type: "close",
      trading_date: "2026-09-11",
      price_basis_date: "2026-09-11",
      holdings: [stock({ ticker_code: "1111", news_ids: ["n1"] }), stock({ ticker_code: "4444", quantity: null, market_value: null, day_pl: null, unrealized_pl: null, unrealized_pl_percent: null })],
      watch: [
        stock({ ticker_code: "2222", tracking_type: "watch", quantity: null, average_price: null, day_pl: null, unrealized_pl: null }),
        stock({ ticker_code: "3333", tracking_type: "watch", quantity: null, average_price: null, day_pl: null, unrealized_pl: null }),
      ],
      indices: [],
      totals: {
        holding_count: 2, watch_count: 2, all_holdings_valued: false, market_value: null, day_pl: null,
        day_change_percent: null, unrealized_pl: null, topix_change_percent: 1, relative_to_topix_pt: 9, relative_label: "stronger",
      },
      sector_weights: [],
      top_impact: [],
      gainers: ["1111"],
      decliners: [],
      news: [{ news_id: "n1", ticker_code: "1111", company_name: "会社1111", severity: "high", headline_ja: "自己株式の取得を決定", news_time: "2026-09-11T01:00:00Z", source_url: null }],
      data_gaps: ["PRICE_UNAVAILABLE:5555", "HOLDING_QUANTITY_MISSING"],
    },
    ...overrides,
  };
}

test("formatters are deterministic and signed", () => {
  assert.equal(formatPrice(1231.5), "1,231.5");
  assert.equal(formatPrice(40000), "40,000");
  assert.equal(formatPrice(null), "—");
  assert.equal(formatYen(121000), "121,000円");
  assert.equal(formatSignedYen(11000), "+11,000円");
  assert.equal(formatSignedYen(-2500.4), "-2,500円");
  assert.equal(formatSignedYen(0), "±0円");
  assert.equal(formatPercent(1.234), "+1.23%");
  assert.equal(formatPercent(-0.5), "-0.50%");
  assert.equal(formatDateJa("2026-09-11"), "9月11日（金）");
  assert.equal(formatTimeJa("2026-09-11T08:15:00Z"), "17:15");
});

test("labels", () => {
  assert.equal(reportTypeLabel("morning"), "朝刊");
  assert.equal(reportTypeLabel("close"), "大引けレポート");
  assert.deepEqual(toneLabel({ tone: "cautious" }, "morning"), { text: "慎重に確認", tone: "cautious" });
  assert.deepEqual(toneLabel({ tone: "positive" }, "close"), { text: "堅調", tone: "positive" });
  assert.equal(toneLabel({}, "close"), null);
  assert.equal(positionLabel({ tracking_type: "holding", position_type: "margin", side: "short" }), "保有・信用・売り");
  assert.equal(positionLabel({ tracking_type: "watch", position_type: null, side: null }), "監視");
});

test("stock rows: holdings keep order, notes attach by ticker, P/L falls back when quantity is missing", () => {
  const rows = buildStockRows(report());
  assert.deepEqual(rows.holdings.map((row) => row.stock.ticker_code), ["1111", "4444"]);
  const first = rows.holdings[0];
  assert.equal(first.note, "自己株式の取得を決定したと確認できます。");
  assert.equal(first.priceLine, "終値 1,210円");
  assert.equal(first.changeLine, "前日比 +10.00%");
  assert.equal(first.changeDirection, "up");
  assert.equal(first.plLine, "今日の損益 +11,000円");
  assert.equal(first.unrealizedLine, "取得単価からの含み損益 +21,000円（+21.00%）");
  assert.equal(first.news[0].headline_ja, "自己株式の取得を決定");
  const missing = rows.holdings[1];
  assert.equal(missing.plLine, "今日の損益 —（数量未登録）");
  assert.equal(missing.unrealizedLine, "含み損益 —（取得単価・数量が未登録）");
});

test("watch rows appear only with a note or own news, and never show P/L", () => {
  const rows = buildStockRows(report());
  assert.deepEqual(rows.watch.map((row) => row.stock.ticker_code), ["3333"]);
  assert.equal(rows.watch[0].plLine, null);
  assert.equal(rows.watch[0].unrealizedLine, null);
});

test("morning rows use the previous close wording and no same-day P/L", () => {
  const morning = report({ report_type: "morning" });
  morning.portfolio_snapshot!.report_type = "morning";
  const rows = buildStockRows(morning);
  assert.equal(rows.holdings[0].priceLine, "前日終値 1,210円");
  assert.equal(rows.holdings[0].changeLine, "前営業日 +10.00%");
  assert.equal(rows.holdings[0].plLine, null);
});

test("unavailable prices never show a guessed number", () => {
  const withGap = report();
  withGap.portfolio_snapshot!.holdings[0] = stock({
    ticker_code: "1111",
    price: { status: "unavailable", sessionDate: null, close: null, previousClose: null, change: null, changePercent: null },
    market_value: null, day_pl: null, unrealized_pl: null, unrealized_pl_percent: null,
  });
  const row = buildStockRows(withGap).holdings[0];
  assert.equal(row.priceLine, "価格を取得できませんでした");
  assert.equal(row.changeLine, "");
  assert.equal(row.changeDirection, "none");
});

test("relative strength and data-gap notes", () => {
  assert.equal(relativeText(report().portfolio_snapshot!), "TOPIXより強い（差 +9.00ポイント）");
  assert.deepEqual(dataGapNotes(report().portfolio_snapshot!), [
    "1銘柄の価格を取得できませんでした。",
    "数量が未登録の保有銘柄があるため、ポート全体の損益は計算していません。",
  ]);
  assert.deepEqual(dataGapNotes(null), []);
});

test("push deep link routes only report pushes", () => {
  assert.equal(
    reportRouteForPush({ source_type: "personalized_report", source_id: "8b0c3a64-1111-4a2b-9c3d-000000000001" }),
    "/reports/8b0c3a64-1111-4a2b-9c3d-000000000001",
  );
  assert.equal(reportRouteForPush({ source_type: "personalized_report", source_id: "../../x" }), "/reports");
  assert.equal(reportRouteForPush({ source_type: "important_news", source_id: "abc" }), null);
  assert.equal(reportRouteForPush(undefined), null);
});

test("a report without a snapshot renders no rows", () => {
  assert.deepEqual(buildStockRows(report({ portfolio_snapshot: null })), { holdings: [], watch: [] });
});
