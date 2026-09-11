import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedNumbers,
  BENCHMARK_LABEL,
  latinWords,
  buildPacket,
  buildSnapshot,
  generateReport,
  isTradingDay,
  localReportIssues,
  newsWindowStartIso,
  parseReportDraft,
  parseYahooDaily,
  previousTradingDay,
  priceFactFor,
  REPORT_MODEL,
  reportDraftRequestBody,
  reportUpdate,
  snapshotBlockers,
  unknownNumbers,
  unsupportedMultiDayWords,
  type NewsInput,
  type PriceSeries,
  type ReportBody,
  type Requester,
  type TrackedInput,
} from "./report_logic.ts";

const DAY = "2026-09-11"; // Friday
const HOLIDAYS = new Set<string>();

function series(closes: Array<[string, number]>, marketTimeIso: string | null = "2026-09-11T06:30:00Z"): PriceSeries {
  return { bars: closes.map(([date, close]) => ({ date, close })), marketTimeIso };
}

const STANDARD = series([["2026-09-09", 1000], ["2026-09-10", 1100], ["2026-09-11", 1210]]);

function tracked(overrides: Partial<TrackedInput> & { tickerCode: string }): TrackedInput {
  return {
    trackedStockId: `t-${overrides.tickerCode}`,
    companyName: `会社${overrides.tickerCode}`,
    sector: "サービス業",
    trackingType: "holding",
    quantity: 100,
    averagePrice: 1000,
    positionType: "cash",
    side: "long",
    ...overrides,
  };
}

function news(overrides: Partial<NewsInput> & { newsId: string }): NewsInput {
  return {
    tickerCode: "1111",
    companyName: "会社1111",
    trackingType: "holding",
    severity: "high",
    matchedSectors: [],
    newsTime: "2026-09-11T01:00:00Z",
    sourceUrl: "https://example.com/a",
    sourceType: "tdnet",
    textOrigin: "app_copy",
    headlineJa: "自己株式の取得を決定",
    summaryJa: "上限50万株の自己株式取得を決めました。",
    keyPointsJa: ["上限50万株"],
    ...overrides,
  };
}

const INDICES = [
  { label: "日経平均", series: series([["2026-09-10", 40000], ["2026-09-11", 40400]]) },
  { label: BENCHMARK_LABEL, series: series([["2026-09-10", 2800], ["2026-09-11", 2828]]) },
];

function closeSnapshot(extra: { tracked?: TrackedInput[]; prices?: Map<string, PriceSeries | null>; news?: NewsInput[] } = {}) {
  const trackedList = extra.tracked ?? [
    tracked({ tickerCode: "1111" }),
    tracked({ tickerCode: "2222", trackingType: "watch", quantity: null, averagePrice: null, positionType: null, side: null }),
  ];
  return buildSnapshot({
    reportType: "close",
    tradingDate: DAY,
    tracked: trackedList,
    prices: extra.prices ?? new Map(trackedList.map((stock) => [stock.tickerCode, STANDARD])),
    indices: INDICES,
    news: extra.news ?? [],
  });
}

// --- dates ----------------------------------------------------------------

test("trading days skip weekends and listed holidays", () => {
  assert.equal(isTradingDay("2026-09-11", HOLIDAYS), true);
  assert.equal(isTradingDay("2026-09-12", HOLIDAYS), false);
  assert.equal(isTradingDay("2026-09-21", new Set(["2026-09-21"])), false);
  assert.equal(previousTradingDay("2026-09-14", HOLIDAYS), "2026-09-11");
  assert.equal(previousTradingDay("2026-09-23", new Set(["2026-09-21", "2026-09-22"])), "2026-09-18");
});

test("news window starts at the previous session's 15:00 JST", () => {
  assert.equal(newsWindowStartIso("2026-09-14", HOLIDAYS), "2026-09-11T06:00:00.000Z");
});

// --- prices ---------------------------------------------------------------

test("parseYahooDaily keys bars by JST date and drops null closes", () => {
  const parsed = parseYahooDaily({
    chart: { result: [{
      meta: { regularMarketTime: 1789108200 },
      timestamp: [1788912000, 1788998400, 1789084800, 1789084900],
      indicators: { quote: [{ close: [1217.5, null, 1231.5, 1232] }] },
    }] },
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.bars, [{ date: "2026-09-09", close: 1217.5 }, { date: "2026-09-11", close: 1232 }]);
  assert.equal(parsed.marketTimeIso, "2026-09-11T06:30:00.000Z");
  assert.equal(parseYahooDaily({}), null);
});

test("close price requires today's bar and a market time at/after 15:30 JST", () => {
  const ok = priceFactFor(STANDARD, "close", DAY);
  assert.equal(ok.status, "ok");
  assert.equal(ok.close, 1210);
  assert.equal(ok.previousClose, 1100);
  assert.equal(ok.change, 110);
  assert.equal(ok.changePercent, 10);
  const intraday = priceFactFor(series([["2026-09-10", 1100], ["2026-09-11", 1210]], "2026-09-11T05:00:00Z"), "close", DAY);
  assert.equal(intraday.status, "unavailable");
  const stale = priceFactFor(series([["2026-09-09", 1000], ["2026-09-10", 1100]], "2026-09-10T06:30:00Z"), "close", DAY);
  assert.equal(stale.status, "unavailable");
  assert.equal(priceFactFor(null, "close", DAY).status, "unavailable");
});

test("morning price uses the last completed session before the trading date", () => {
  const morning = priceFactFor(STANDARD, "morning", DAY);
  assert.equal(morning.sessionDate, "2026-09-10");
  assert.equal(morning.close, 1100);
  assert.equal(morning.previousClose, 1000);
  assert.equal(morning.changePercent, 10);
});

// --- snapshot -------------------------------------------------------------

test("holding and watch are separated; watch never gets quantity or P/L", () => {
  const snapshot = closeSnapshot();
  assert.deepEqual(snapshot.holdings.map((stock) => stock.ticker_code), ["1111"]);
  assert.deepEqual(snapshot.watch.map((stock) => stock.ticker_code), ["2222"]);
  const watch = snapshot.watch[0];
  assert.equal(watch.quantity, null);
  assert.equal(watch.day_pl, null);
  assert.equal(watch.unrealized_pl, null);
});

test("close computes day P/L, unrealized P/L and relative strength in code", () => {
  const snapshot = closeSnapshot();
  const holding = snapshot.holdings[0];
  assert.equal(holding.market_value, 121000);
  assert.equal(holding.day_pl, 11000);
  assert.equal(holding.unrealized_pl, 21000);
  assert.equal(holding.unrealized_pl_percent, 21);
  assert.equal(snapshot.totals.day_pl, 11000);
  assert.equal(snapshot.totals.day_change_percent, 10);
  assert.equal(snapshot.totals.topix_change_percent, 1);
  assert.equal(snapshot.totals.relative_to_topix_pt, 9);
  assert.equal(snapshot.totals.relative_label, "stronger");
  assert.deepEqual(snapshot.gainers, ["1111"]);
});

test("short positions invert P/L", () => {
  const snapshot = closeSnapshot({ tracked: [tracked({ tickerCode: "1111", side: "short", positionType: "margin" })] });
  assert.equal(snapshot.holdings[0].day_pl, -11000);
  assert.equal(snapshot.holdings[0].unrealized_pl, -21000);
  assert.deepEqual(snapshot.decliners, ["1111"]);
});

test("missing quantity or average price falls back safely (no totals, no guesses)", () => {
  const snapshot = closeSnapshot({
    tracked: [
      tracked({ tickerCode: "1111" }),
      tracked({ tickerCode: "3333", quantity: null, averagePrice: null }),
    ],
  });
  const missing = snapshot.holdings.find((stock) => stock.ticker_code === "3333")!;
  assert.equal(missing.market_value, null);
  assert.equal(missing.day_pl, null);
  assert.equal(missing.unrealized_pl, null);
  assert.equal(missing.price.status, "ok");
  assert.equal(snapshot.totals.all_holdings_valued, false);
  assert.equal(snapshot.totals.day_pl, null);
  assert.equal(snapshot.totals.relative_label, null);
  assert.ok(snapshot.data_gaps.includes("HOLDING_QUANTITY_MISSING"));
  assert.equal(snapshot.sector_weights[0].basis, "count");
});

test("average price missing keeps market value but no unrealized P/L", () => {
  const snapshot = closeSnapshot({ tracked: [tracked({ tickerCode: "1111", averagePrice: null })] });
  assert.equal(snapshot.holdings[0].market_value, 121000);
  assert.equal(snapshot.holdings[0].unrealized_pl, null);
  assert.equal(snapshot.totals.unrealized_pl, null);
  assert.equal(snapshot.totals.day_pl, 11000);
});

test("holding priority: own news severity, then sector market news, then size", () => {
  const trackedList = [
    tracked({ tickerCode: "1111", quantity: 1000 }),
    tracked({ tickerCode: "2222", quantity: 10, sector: "銀行業" }),
    tracked({ tickerCode: "3333", quantity: 100 }),
    tracked({ tickerCode: "4444", quantity: 5 }),
  ];
  const snapshot = buildSnapshot({
    reportType: "morning",
    tradingDate: DAY,
    tracked: trackedList,
    prices: new Map(trackedList.map((stock) => [stock.tickerCode, STANDARD])),
    indices: INDICES,
    news: [
      news({ newsId: "n-critical", tickerCode: "4444", severity: "critical" }),
      news({ newsId: "n-market", tickerCode: null, companyName: "市場全体", matchedSectors: ["銀行業"] }),
    ],
  });
  assert.deepEqual(snapshot.holdings.map((stock) => stock.ticker_code), ["4444", "2222", "1111", "3333"]);
  assert.deepEqual(snapshot.top_impact, ["4444", "2222", "1111"]);
  assert.deepEqual(snapshot.holdings.map((stock) => stock.priority_rank), [1, 2, 3, 4]);
  assert.equal(snapshot.holdings[0].day_pl, null, "morning never reports a same-day P/L");
});

test("blockers: no prices at all or no tracked stocks", () => {
  const trackedList = [tracked({ tickerCode: "1111" })];
  const noPrices = closeSnapshot({ tracked: trackedList, prices: new Map([["1111", null]]) });
  assert.deepEqual(snapshotBlockers(noPrices), ["PRICES_UNAVAILABLE"]);
  const empty = closeSnapshot({ tracked: [] });
  assert.deepEqual(snapshotBlockers(empty), ["NO_TRACKED_STOCKS"]);
  assert.deepEqual(snapshotBlockers(closeSnapshot()), []);
});

test("packet carries only Fact-passed news text and preformatted numbers", () => {
  const items = [news({ newsId: "n1", tickerCode: "1111" })];
  const snapshot = closeSnapshot({ news: items });
  const packet = buildPacket(snapshot, items) as Record<string, unknown>;
  const text = JSON.stringify(packet);
  assert.ok(text.includes("自己株式の取得を決定"));
  assert.ok(text.includes("+11,000円"));
  assert.ok(text.includes("TOPIX連動ETF（1306）より強い"));
  assert.ok(text.includes("9月11日（金）"), "dates reach the model in Japanese form");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(text), "no ISO dates reach the model");
  assert.ok(text.includes("会社1111（1111）"), "gainers are named, not bare codes");
  assert.ok(!text.includes("https://"), "no URLs go to the model");
  assert.ok(!text.includes("n1"), "no internal ids go to the model");
});

// --- local checks ---------------------------------------------------------

function body(overrides: Partial<ReportBody> = {}): ReportBody {
  return {
    title_ja: "保有株は上昇、TOPIX連動ETFより強い一日",
    summary_ja: "保有銘柄は前日比+10.00%でした。",
    tone: "positive",
    overview_ja: "ポートは+11,000円で、TOPIX連動ETF（1306）より強い結果でした。",
    stock_notes: [{ ticker_code: "1111", note_ja: "終値は1,210円、前日比+10.00%でした。自己株式の取得を決定したと確認できます。" }],
    watch_notes: [],
    risk_notes_ja: [],
    checkpoints_ja: ["自己株式取得の進み具合を確認します。"],
    ...overrides,
  };
}

test("numbers must appear in the packet; small counts without units are fine", () => {
  const items = [news({ newsId: "n1", tickerCode: "1111" })];
  const snapshot = closeSnapshot({ news: items });
  const packet = buildPacket(snapshot, items);
  const allowed = allowedNumbers(packet);
  assert.deepEqual(unknownNumbers("終値は1,210円、前日比+10.00%", allowed), []);
  assert.deepEqual(unknownNumbers("２つの材料と3点の確認事項", allowed), []);
  assert.deepEqual(unknownNumbers("9月11日の動き", allowed), []);
  assert.deepEqual(unknownNumbers("約1,200円まで上昇", allowed), ["1,200"]);
  assert.deepEqual(unknownNumbers("3%上昇", allowed), ["3"]);
  assert.deepEqual(localReportIssues(body(), snapshot, packet), []);
  assert.ok(localReportIssues(body({ overview_ja: "ポートは+12,345円でした。" }), snapshot, packet)
    .some((issue) => issue.startsWith("NUMBER_NOT_IN_PACKET")));
});

test("unknown tickers, advice and URLs fail the local checks", () => {
  const snapshot = closeSnapshot();
  const packet = buildPacket(snapshot, []);
  const base = body({ summary_ja: "保有銘柄は上昇しました。", overview_ja: "ポートは上昇しました。",
    stock_notes: [{ ticker_code: "1111", note_ja: "上昇しました。" }] });
  assert.deepEqual(localReportIssues(base, snapshot, packet), []);
  assert.ok(localReportIssues({ ...base, stock_notes: [{ ticker_code: "9999", note_ja: "上昇。" }] }, snapshot, packet)
    .includes("UNKNOWN_HOLDING_TICKER"));
  assert.ok(localReportIssues({ ...base, watch_notes: [{ ticker_code: "1111", note_ja: "注目。" }] }, snapshot, packet)
    .includes("UNKNOWN_WATCH_TICKER"));
  assert.ok(localReportIssues({ ...base, checkpoints_ja: ["ここは買い増しを検討すべき局面です。"] }, snapshot, packet)
    .length > 0);
  assert.ok(localReportIssues({ ...base, checkpoints_ja: ["今のうちに買うべきです。"] }, snapshot, packet)
    .includes("CONTAINS_INVESTMENT_ADVICE"));
  assert.ok(localReportIssues({ ...base, checkpoints_ja: ["明日は必ず上がる見込みです。"] }, snapshot, packet)
    .includes("CONTAINS_INVESTMENT_ADVICE"));
  assert.ok(localReportIssues({ ...base, overview_ja: "詳しくは https://example.com へ。" }, snapshot, packet)
    .includes("CONTAINS_URL"));
  assert.ok(localReportIssues({ ...base, stock_notes: [] }, snapshot, packet).includes("MISSING_HOLDING_NOTES"));
  assert.ok(localReportIssues({ ...base, overview_ja: "2026-09-11のポートは上昇しました。" }, snapshot, packet)
    .includes("CONTAINS_ISO_DATE"));
  assert.ok(localReportIssues({ ...base, risk_notes_ja: ["セクターウェightsはサービス業です。"] }, snapshot, packet)
    .some((issue) => issue.startsWith("CONTAINS_LATIN_WORD")));
  assert.deepEqual(latinWords("TOPIX連動ETFとTDnetの開示"), []);
  assert.ok(localReportIssues({ ...base, title_ja: "保有株は続落" }, snapshot, packet)
    .some((issue) => issue.startsWith("UNSUPPORTED_MULTI_DAY_WORD:続落")));
  assert.deepEqual(unsupportedMultiDayWords(["年初来高値を更新したと発表"], { news: "年初来高値を更新したと発表" }), [],
    "allowed when the packet itself says it");
  assert.ok(localReportIssues({ ...base, checkpoints_ja: [] }, snapshot, packet).includes("CHECKPOINTS_INVALID"));
});

test("parseReportDraft rejects insufficient or empty output", () => {
  assert.equal(parseReportDraft({ sufficient_information: false }).error, "REPORT_INSUFFICIENT_INFORMATION");
  assert.equal(parseReportDraft(null).error, "REPORT_INVALID_OUTPUT");
  assert.equal(parseReportDraft({ ...body(), sufficient_information: true, overview_ja: " " }).error, "REPORT_EMPTY_FIELD");
  const parsed = parseReportDraft({ ...body(), sufficient_information: true, tone: "weird" });
  assert.equal(parsed.body?.tone, "neutral");
});

// --- orchestration ----------------------------------------------------------

function requester(draft: unknown, verdict: unknown, calls: string[] = []): Requester {
  return (step) => {
    calls.push(step);
    return Promise.resolve({ payload: step === "draft" ? draft : verdict, inputTokens: 1000, outputTokens: 500 });
  };
}

test("close report positive: one draft + one Fact check, stored as completed", async () => {
  const items = [news({ newsId: "n1", tickerCode: "1111" })];
  const snapshot = closeSnapshot({ news: items });
  const packet = buildPacket(snapshot, items);
  const calls: string[] = [];
  const outcome = await generateReport(snapshot, packet,
    requester({ ...body(), sufficient_information: true }, { passed: true, issues: [] }, calls));
  assert.equal(outcome.status, "passed");
  assert.deepEqual(calls, ["draft", "fact"]);
  assert.equal(outcome.model, REPORT_MODEL);
  const update = reportUpdate(outcome, snapshot, { lane: "test" });
  assert.equal(update.status, "completed");
  assert.equal(update.fact_status, "passed");
  assert.equal(update.title_ja, body().title_ja);
  assert.equal((update.body as { stock_notes: unknown[] }).stock_notes.length, 1);
});

test("morning report positive", async () => {
  const trackedList = [tracked({ tickerCode: "1111" })];
  const snapshot = buildSnapshot({
    reportType: "morning", tradingDate: DAY, tracked: trackedList,
    prices: new Map([["1111", STANDARD]]), indices: INDICES, news: [],
  });
  const packet = buildPacket(snapshot, []);
  assert.equal((packet as { price_basis: string }).price_basis, "前営業日の終値");
  const draft = {
    sufficient_information: true,
    title_ja: "今日は保有株の材料待ち",
    summary_ja: "目立った材料は確認できていません。",
    tone: "neutral",
    overview_ja: "前営業日の終値は1,100円でした。",
    stock_notes: [{ ticker_code: "1111", note_ja: "目立った材料は確認できていません。" }],
    watch_notes: [],
    risk_notes_ja: ["サービス業に偏っています。"],
    checkpoints_ja: ["寄り付きの値動きを確認します。"],
  };
  const outcome = await generateReport(snapshot, packet, requester(draft, { passed: true, issues: [] }));
  assert.equal(outcome.status, "passed", outcome.issues.join(","));
  const request = reportDraftRequestBody("morning", packet);
  assert.equal(request.model, REPORT_MODEL);
  assert.match(String(request.instructions), /朝刊/);
});

test("Fact failure stores a failed report with no text (and so no push)", async () => {
  const snapshot = closeSnapshot();
  const packet = buildPacket(snapshot, []);
  const draft = { ...body({ summary_ja: "上昇しました。", overview_ja: "上昇しました。",
    stock_notes: [{ ticker_code: "1111", note_ja: "上昇しました。" }] }), sufficient_information: true };
  const outcome = await generateReport(snapshot, packet, requester(draft, { passed: false, issues: ["因果の断定"] }));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "REPORT_FACT_FAILED");
  const update = reportUpdate(outcome, snapshot, {});
  assert.equal(update.status, "failed");
  assert.equal(update.fact_status, "failed");
  assert.equal(update.title_ja, null);
  assert.deepEqual(update.body, {});
});

test("local check failure never reaches the Fact call", async () => {
  const snapshot = closeSnapshot();
  const packet = buildPacket(snapshot, []);
  const calls: string[] = [];
  const draft = { ...body({ overview_ja: "ポートは+99,999円でした。" }), sufficient_information: true };
  const outcome = await generateReport(snapshot, packet, requester(draft, { passed: true, issues: [] }, calls));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "REPORT_LOCAL_CHECK_FAILED");
  assert.deepEqual(calls, ["draft"]);
  assert.equal(reportUpdate(outcome, snapshot, {}).fact_status, "pending");
});

test("missing data fail-safe: no prices means no model call and a failed report", async () => {
  const trackedList = [tracked({ tickerCode: "1111" })];
  const snapshot = closeSnapshot({ tracked: trackedList, prices: new Map([["1111", null]]) });
  const calls: string[] = [];
  const outcome = await generateReport(snapshot, buildPacket(snapshot, []), requester({}, {}, calls));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "PRICES_UNAVAILABLE");
  assert.deepEqual(calls, []);
  assert.equal(reportUpdate(outcome, snapshot, {}).status, "failed");
});

test("transport errors become safe codes", async () => {
  const snapshot = closeSnapshot();
  const outcome = await generateReport(snapshot, buildPacket(snapshot, []),
    () => Promise.reject(new Error("REPORT_OPENAI_FAILED:500")));
  assert.equal(outcome.error, "REPORT_OPENAI_FAILED:500");
  const odd = await generateReport(snapshot, buildPacket(snapshot, []),
    () => Promise.reject(new Error("secret sk-abc leaked?")));
  assert.equal(odd.error, "REPORT_UNEXPECTED_ERROR");
});
