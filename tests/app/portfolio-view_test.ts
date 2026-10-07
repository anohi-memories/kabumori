import assert from "node:assert/strict";
import test from "node:test";

import type { PersonalizedReport, ReportSnapshot, ReportStock } from "../../src/lib/report-presentation.ts";
import type { TrackedStock } from "../../src/lib/stocks.ts";
import {
  aiSummary,
  assetSummary,
  avatarLabel,
  buildHoldingRows,
  buildWatchRows,
  formatAmount,
  formatPriceYen,
  formatSignedAmount,
  formatSignedPercent,
  portfolioBasis,
  portfolioLabels,
  shortDate,
  sparklineValues,
  topImpacts,
  unrealizedPercent,
} from "../../src/lib/portfolio-view.ts";

function stock(ticker: string, name: string, overrides: Partial<ReportStock> = {}): ReportStock {
  return {
    ticker_code: ticker, company_name: name, sector: null, tracking_type: "holding", quantity: 100, average_price: 1000,
    position_type: "cash", side: "long",
    price: { status: "ok", sessionDate: "2026-10-06", close: 2731, previousClose: 2666, change: 65, changePercent: 2.44 },
    market_value: 273100, day_pl: 6500, unrealized_pl: 106200, unrealized_pl_percent: 14.2, news_ids: [], market_news_ids: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<ReportSnapshot> = {}): ReportSnapshot {
  return {
    report_type: "close", trading_date: "2026-10-06", price_basis_date: "2026-10-06",
    holdings: [stock("7203", "トヨタ自動車")], watch: [], indices: [],
    totals: { holding_count: 1, watch_count: 0, all_holdings_valued: true, market_value: 3248500, day_pl: 32600, day_change_percent: 1.01, unrealized_pl: 218400, topix_change_percent: null, relative_to_topix_pt: null, relative_label: null },
    sector_weights: [], top_impact: [], gainers: [], decliners: [], news: [], data_gaps: [],
    ...overrides,
  };
}

function report(date: string, snap: ReportSnapshot | null, extra: Partial<PersonalizedReport> = {}): PersonalizedReport {
  return { id: `r-${date}`, report_type: "close", trading_date: date, title_ja: null, summary_ja: null, body: null, portfolio_snapshot: snap, generated_at: `${date}T07:00:00Z`, ...extra };
}

function tracked(id: string, ticker: string, name: string, kind: "holding" | "watch" = "holding"): TrackedStock {
  return {
    id, user_id: "u", stock_id: `s-${id}`, tracking_type: kind, quantity: kind === "holding" ? 100 : null, average_price: null,
    position_type: null, side: null, target_buy_price: null, target_sell_price: null, memo: null,
    stocks_master: { id: `s-${id}`, ticker_code: ticker, company_name: name, market: "プライム" },
  };
}

test("unrealized percent: derived from the cost basis only when it is safe", () => {
  // cost = 3,248,500 - 218,400 = 3,030,100; 218,400 / 3,030,100 = 7.2074%
  assert.equal(Number(unrealizedPercent(3248500, 218400)?.toFixed(2)), 7.21);
  assert.equal(Number(unrealizedPercent(900, -100)?.toFixed(2)), -10);
  for (const [value, pl] of [[null, 1], [1, null], [100, 100], [100, 200], [0, 0], [NaN, 1], [100, Infinity]] as const) {
    assert.equal(unrealizedPercent(value, pl), null, `${value}/${pl}`);
  }
});

test("asset summary: values from snapshot.totals, null (never 0) when missing", () => {
  const full = assetSummary(snapshot());
  assert.equal(full.assetValue, 3248500);
  assert.equal(full.unrealizedPl, 218400);
  assert.equal(full.dayPl, 32600);
  assert.equal(full.dayChangePercent, 1.01);
  assert.equal(Number(full.unrealizedPlPercent?.toFixed(2)), 7.21);
  const empty = assetSummary(null);
  assert.deepEqual(
    [empty.assetValue, empty.unrealizedPl, empty.unrealizedPlPercent, empty.dayPl, empty.dayChangePercent, empty.holdingCount],
    [null, null, null, null, null, 0],
  );
  const gap = assetSummary(snapshot({ totals: { ...snapshot().totals, market_value: null, day_pl: null, unrealized_pl: null, all_holdings_valued: false } }));
  assert.equal(gap.assetValue, null);
  assert.equal(gap.dayPl, null);
  assert.equal(gap.allValued, false);
});

test("null never turns into 0 or a fake sign when formatted", () => {
  for (const format of [formatAmount, formatSignedAmount, formatPriceYen]) assert.equal(format(null), "—");
  assert.equal(formatSignedPercent(null), "—");
  assert.equal(formatAmount(NaN), "—");
  assert.equal(formatSignedAmount(0), "±¥0");
  assert.equal(formatSignedPercent(0), "±0.00%");
});

test("number formatting: yen, signed yen, signed percent, price", () => {
  assert.equal(formatAmount(3248500), "¥3,248,500");
  assert.equal(formatSignedAmount(218400), "+¥218,400");
  assert.equal(formatSignedAmount(-7600), "−¥7,600");
  assert.equal(formatSignedPercent(7.2074), "+7.21%");
  assert.equal(formatSignedPercent(-1.3, 1), "−1.3%");
  assert.equal(formatPriceYen(2731), "¥2,731");
  assert.equal(formatPriceYen(2731.5), "¥2,731.5");
});

test("basis and labels: only today's prices get 今日 wording; a stale report is dated, never 'today'", () => {
  const today = portfolioBasis(report("2026-10-06", snapshot()), "2026-10-06");
  assert.equal(today?.isToday, true);
  assert.deepEqual(portfolioLabels(today), {
    basis: "10/6 終値ベース", aiTitle: "今日のポートフォリオ", aiCta: "今日のポイントを見る",
    impactTitle: "今日の資産への影響", dayChange: "今日の増減", priceWord: "終値",
  });
  const stale = portfolioBasis(report("2026-10-06", snapshot()), "2026-10-07");
  assert.equal(stale?.isToday, false);
  const labels = portfolioLabels(stale);
  assert.equal(labels.basis, "10/6 終値ベース");
  assert.equal(labels.aiTitle, "最新のポートフォリオ");
  assert.equal(labels.aiCta, "詳しいポイントを見る");
  assert.equal(labels.impactTitle, "10/6の資産への影響");
  assert.equal(labels.dayChange, "10/6の増減");
  for (const text of Object.values(labels)) assert.ok(!/今日/.test(text), `stale label "${text}" must not say 今日`);
  // The basis date is the PRICE date, so a report written today on yesterday's prices is stale too.
  const lagging = portfolioBasis(report("2026-10-06", snapshot({ price_basis_date: "2026-10-05" })), "2026-10-06");
  assert.equal(lagging?.isToday, false);
  assert.equal(portfolioLabels(lagging).basis, "10/5 終値ベース");
  // No report at all.
  assert.equal(portfolioBasis(null, "2026-10-06"), null);
  assert.equal(portfolioBasis(report("2026-10-06", null), "2026-10-06"), null);
  assert.equal(portfolioLabels(null).basis, "保存済み終値ベース");
  assert.equal(shortDate("2026-10-06"), "10/6");
  assert.equal(shortDate("nonsense"), null);
});

test("sparkline: recent CLOSE totals, oldest first, one per date, finite only, bounded", () => {
  const withValue = (value: number | null) => snapshot({ totals: { ...snapshot().totals, market_value: value } });
  const values = sparklineValues([
    report("2026-10-06", withValue(300)),
    report("2026-10-04", withValue(100)),
    report("2026-10-05", withValue(200)),
    report("2026-10-03", withValue(null)),                             // not finite: skipped
    report("2026-10-02", null),                                        // no snapshot: skipped
    { ...report("2026-10-01", withValue(999)), report_type: "morning" }, // morning is never a basis
    report("2026-10-05", withValue(210), { generated_at: "2026-10-05T09:00:00Z", id: "later" }), // the newest generation of a date wins
  ]);
  assert.deepEqual(values, [100, 210, 300]);
  const many = Array.from({ length: 30 }, (_, index) => report(`2026-09-${String(index + 1).padStart(2, "0")}`, withValue(index + 1)));
  assert.equal(sparklineValues(many).length, 12);
  assert.deepEqual(sparklineValues(many).slice(-1), [30]);
  assert.deepEqual(sparklineValues([report("2026-10-06", withValue(300))]), [300], "a single point is returned; the UI draws no line for it");
  assert.deepEqual(sparklineValues([]), []);
});

test("impact top 3: ranked by absolute day P/L, null day P/L excluded, at most 3", () => {
  const impacts = topImpacts(snapshot({
    holdings: [
      stock("A", "アルファ", { day_pl: 1000 }),
      stock("B", "ベータ", { day_pl: -9000 }),
      stock("C", "ガンマ", { day_pl: null }),
      stock("D", "デルタ", { day_pl: 5000 }),
      stock("E", "イプシロン", { day_pl: -5000 }),
      stock("F", "ゼータ", { day_pl: 0 }),
    ],
  }));
  assert.deepEqual(impacts.map((item) => item.ticker), ["B", "D", "E"], "|−9000| first; the 5000 tie is by ticker");
  assert.equal(impacts[0].dayPl, -9000);
  assert.equal(topImpacts(snapshot({ holdings: [stock("A", "ア", { day_pl: null })] })).length, 0, "no numeric holding => no section");
  assert.equal(topImpacts(null).length, 0);
  assert.equal(topImpacts(snapshot({ holdings: [stock("A", "ア", { price: { status: "unavailable", sessionDate: null, close: null, previousClose: null, change: null, changePercent: null } })] }))[0].changePercent, null);
});

test("holding rows join the CURRENT registrations to the latest report by ticker", () => {
  const rep = report("2026-10-06", snapshot({
    holdings: [
      stock("7203", "トヨタ自動車", { market_value: 300000, unrealized_pl: 106200, unrealized_pl_percent: 14.2 }),
      stock("8306", "三菱UFJフィナンシャルG", { market_value: 500000, unrealized_pl: 62400, unrealized_pl_percent: 11.6 }),
    ],
  }));
  const rows = buildHoldingRows([
    tracked("a", "7203", "トヨタ自動車"),
    tracked("b", "8306", "三菱UFJフィナンシャルG"),
    tracked("c", "9999", "新規登録株式会社"),   // registered after the report was written
    tracked("w", "6758", "ソニー", "watch"),
  ], rep);
  assert.deepEqual(rows.map((row) => row.ticker), ["8306", "7203", "9999"], "market value desc, rows without one last");
  const known = rows[0];
  assert.equal(known.reflected, true);
  assert.equal(known.close, 2731);
  assert.equal(known.marketValue, 500000);
  const fresh = rows[2];
  assert.equal(fresh.reflected, false, "not in the report => honest 未反映, not dropped");
  assert.deepEqual([fresh.close, fresh.marketValue, fresh.unrealizedPl, fresh.unrealizedPlPercent, fresh.tag, fresh.line], [null, null, null, null, null, null]);
  assert.equal(rows.some((row) => row.ticker === "6758"), false, "watch records are not holdings");
});

test("holding rows without any report keep every registered holding, all unreflected", () => {
  const rows = buildHoldingRows([tracked("a", "7203", "トヨタ自動車"), tracked("b", "1332", "ニッスイ")], null);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => !row.reflected && row.close === null));
  assert.deepEqual(rows.map((row) => row.ticker), ["1332", "7203"], "deterministic fallback: by ticker");
});

test("material tag and line only come from stored report data", () => {
  const rep = report("2026-10-06", snapshot({
    holdings: [
      stock("1", "ニュースあり", { news_ids: ["n1"] }),
      stock("2", "追い風株"),
      stock("3", "逆風株"),
      stock("4", "中立株"),
      stock("5", "材料なし"),
    ],
  }), {
    body: {
      overview_ja: "概要です。",
      holding_impacts: [
        { ticker_code: "2", stance: "tailwind", basis: [], fact_ja: "好決算を発表しました。", inference_ja: "", watch_ja: "" },
        { ticker_code: "3", stance: "headwind", basis: [], fact_ja: "  ", inference_ja: "", watch_ja: "" },
        { ticker_code: "4", stance: "neutral", basis: [], fact_ja: "特に動きなし。", inference_ja: "", watch_ja: "" },
      ],
      stock_notes: [{ ticker_code: "3", note_ja: "従来メモ。" }],
    },
  });
  const rows = Object.fromEntries(buildHoldingRows(["1", "2", "3", "4", "5"].map((t) => tracked(t, t, `銘柄${t}`)), rep).map((row) => [row.ticker, row]));
  assert.deepEqual([rows["1"].tag, rows["1"].line], ["ニュース", null]);
  assert.deepEqual([rows["2"].tag, rows["2"].line], ["追い風", "好決算を発表しました。"]);
  assert.deepEqual([rows["3"].tag, rows["3"].line], ["逆風", "従来メモ。"], "a blank fact falls back to the stored note");
  assert.deepEqual([rows["4"].tag, rows["4"].line], [null, "特に動きなし。"], "a neutral stance gets no tag");
  assert.deepEqual([rows["5"].tag, rows["5"].line], [null, null], "nothing is guessed");
});

test("AI summary is the stored overview_ja only (trimmed, never generated)", () => {
  const basis = portfolioBasis(report("2026-10-06", snapshot(), { body: { overview_ja: "  保有銘柄は全体的に上昇。  " } }), "2026-10-06");
  assert.deepEqual(aiSummary(basis), { text: "保有銘柄は全体的に上昇。", reportId: "r-2026-10-06" });
  assert.equal(aiSummary(portfolioBasis(report("2026-10-06", snapshot(), { body: { overview_ja: "   " } }), "2026-10-06")), null);
  assert.equal(aiSummary(portfolioBasis(report("2026-10-06", snapshot()), "2026-10-06")), null);
  assert.equal(aiSummary(null), null);
});

test("fallback avatar: one short deterministic label", () => {
  assert.equal(avatarLabel("トヨタ自動車", "7203"), "ト");
  assert.equal(avatarLabel("三菱UFJフィナンシャルG", "8306"), "三");
  assert.equal(avatarLabel("神戸製鋼所", "5406"), "神");
  assert.equal(avatarLabel("株式会社ニッスイ", "1332"), "ニ");
  assert.equal(avatarLabel("（株）サンリオ", "8136"), "サ");
  assert.equal(avatarLabel("SBIホールディングス", "8473"), "SB");
  assert.equal(avatarLabel("3Mジャパン", "1111"), "3M");
  assert.equal(avatarLabel("", "7203"), "72");
  assert.equal(avatarLabel("   ", ""), "?");
  assert.equal(avatarLabel("トヨタ自動車", "7203"), avatarLabel("トヨタ自動車", "7203"));
  for (const name of ["トヨタ自動車", "三菱UFJフィナンシャルG", "とても長い会社名の例株式会社ホールディングス"]) assert.ok(Array.from(avatarLabel(name, "1")).length <= 2);
});

test("watch rows keep the registered watch records (newest first as queried) with the report's price when known", () => {
  const rep = report("2026-10-06", snapshot({ watch: [stock("6758", "ソニー", { tracking_type: "watch", price: { status: "ok", sessionDate: "2026-10-06", close: 3000, previousClose: 2990, change: 10, changePercent: 0.33 } })] }));
  const rows = buildWatchRows([tracked("w1", "6758", "ソニー", "watch"), tracked("h", "7203", "トヨタ"), tracked("w2", "9984", "ソフトバンクグループ", "watch")], rep);
  assert.deepEqual(rows.map((row) => row.ticker), ["6758", "9984"]);
  assert.equal(rows[0].close, 3000);
  assert.equal(rows[1].close, null);
  assert.equal(rows[0].tracked.id, "w1", "the original record is kept so it stays editable");
});
