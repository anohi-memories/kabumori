import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImpactRows,
  changeDirection,
  hasHoldingImpacts,
  marketDirectionLabel,
  type PersonalizedReport,
  type ReportStock,
  stanceSummary,
} from "../../src/lib/report-presentation.ts";

function stock(ticker: string, overrides: Partial<ReportStock> = {}): ReportStock {
  return {
    ticker_code: ticker, company_name: `会社${ticker}`, sector: "電気機器", tracking_type: "holding",
    quantity: 100, average_price: 900, position_type: "cash", side: "long",
    price: { status: "ok", sessionDate: "2026-09-18", close: 1050, previousClose: 1000, change: 50, changePercent: 5 },
    market_value: 105000, day_pl: 5000, unrealized_pl: 15000, unrealized_pl_percent: 16.67,
    news_ids: [], market_news_ids: [], ...overrides,
  };
}

function report(overrides: Partial<PersonalizedReport> = {}, holdings = [
  stock("2222", { detail_level: "brief", relative_to_benchmark_pt: 0, morning_stance: null, outlook_check: "not_comparable" }),
  stock("1111", { detail_level: "detailed", relative_to_benchmark_pt: 5, morning_stance: "tailwind", outlook_check: "matched", news_ids: ["n1"] }),
]): PersonalizedReport {
  return {
    id: "r1", report_type: "close", trading_date: "2026-09-18", title_ja: "t", summary_ja: "s",
    generated_at: "2026-09-18T08:20:00Z",
    body: {
      overview_ja: "o",
      holding_impacts: [
        { ticker_code: "1111", stance: "tailwind", basis: ["company_news"], fact_ja: "上方修正が確認できます。", inference_ja: "評価された可能性があります。", watch_ja: "出来高を確認します。" },
        { ticker_code: "2222", stance: "no_clear_material", basis: [], fact_ja: "明確な個別材料は確認できていません。", inference_ja: "", watch_ja: "" },
      ],
    },
    portfolio_snapshot: {
      report_type: "close", trading_date: "2026-09-18", price_basis_date: "2026-09-18",
      holdings, watch: [], indices: [],
      totals: {
        holding_count: 2, watch_count: 0, all_holdings_valued: true, market_value: 210000, day_pl: 10000,
        day_change_percent: 5, unrealized_pl: 30000, benchmark_label: "TOPIX連動ETF（1306）",
        topix_change_percent: 0, relative_to_topix_pt: 5, relative_label: "stronger",
      },
      sector_weights: [], top_impact: [], gainers: [], decliners: [],
      news: [{ news_id: "n1", ticker_code: "1111", company_name: "会社1111", severity: "high", headline_ja: "業績予想を上方修正", news_time: "2026-09-18T01:00:00Z", source_url: null }],
      data_gaps: [],
    },
    ...overrides,
  };
}

test("impact rows: detailed holdings first, each with its own Fact-passed impact", () => {
  const rows = buildImpactRows(report());
  assert.deepEqual(rows.map((row) => row.stock.ticker_code), ["1111", "2222"]);
  assert.equal(rows[0].impact?.stance, "tailwind");
  assert.equal(rows[0].news[0].headline_ja, "業績予想を上方修正");
  assert.equal(rows[1].impact?.stance, "no_clear_material");
});

test("close rows show the benchmark comparison and the morning outlook check from code", () => {
  const [first, second] = buildImpactRows(report());
  assert.equal(first.relativeLine, "TOPIX連動ETF（1306）比 +5.00ポイント");
  assert.equal(first.outlookLine, "朝の見通し「追い風」→ 見通しどおり");
  assert.equal(first.outlookCheck, "matched");
  assert.equal(second.outlookLine, null, "no morning stance → no comparison line");
  assert.equal(first.plLine, "今日の損益 +5,000円");
});

test("morning rows never show close-only comparisons", () => {
  const base = report();
  const morning = report({
    report_type: "morning",
    portfolio_snapshot: { ...base.portfolio_snapshot!, report_type: "morning" },
  });
  const rows = buildImpactRows(morning);
  assert.ok(rows.every((row) => row.relativeLine === null && row.outlookLine === null && row.plLine === null));
  assert.equal(rows[0].priceLine, "前日終値 1,050円");
});

test("stance summary and labels", () => {
  assert.equal(stanceSummary(buildImpactRows(report())), "追い風 1・明確な材料なし 1");
  assert.equal(stanceSummary([]), null);
  assert.equal(changeDirection("+1.38%"), "up");
  assert.equal(changeDirection("-0.26%"), "down");
  assert.equal(changeDirection("±0.00%"), "flat");
  assert.equal(changeDirection(null), "none");
  assert.equal(marketDirectionLabel("mixed"), "まちまち");
  assert.equal(marketDirectionLabel("bogus"), "判断できず");
});

test("older stored reports without holding impacts keep the previous layout", () => {
  const legacy = report({ body: { overview_ja: "o", stock_notes: [{ ticker_code: "1111", note_ja: "n" }] } });
  assert.equal(hasHoldingImpacts(legacy), false);
  assert.equal(hasHoldingImpacts(report()), true);
  const rows = buildImpactRows(legacy);
  assert.ok(rows.every((row) => row.impact === null));
});

test("no holdings (e.g. a watch-only user): no impact rows, the market part stands on its own", () => {
  const empty = report({}, []);
  assert.deepEqual(buildImpactRows(empty), []);
  assert.equal(hasHoldingImpacts(empty), true);
});
