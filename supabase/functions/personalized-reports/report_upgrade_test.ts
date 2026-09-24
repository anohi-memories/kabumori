// App morning / close upgrade: detailed market section (code-built from the
// shared packets) + per-holding impact analysis + morning→close review.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  allowedBasis,
  BENCHMARK_LABEL,
  buildPacket,
  buildSnapshot,
  generateReport,
  holdingImpactIssues,
  localReportIssues,
  morningReportPath,
  morningStancesFromRows,
  outlookCheck,
  reportDraftRequestBody,
  reportUpdate,
  snapshotBlockers,
  type HoldingImpact,
  type NewsInput,
  type PriceSeries,
  type ReportBody,
  type Requester,
  type SharedMarketInput,
  type Stance,
  type TrackedInput,
} from "./report_logic.ts";
import { buildAppMarketDetail, crossAssetLines, metricLine, type AppMarketDetail } from "./market_detail.ts";
import {
  appMarketSection,
  formatSharedXPost,
  type MarketReportPacket,
} from "../_shared/market_report_packet.ts";

const FIXTURES = new URL("../market-report-analysis/fixtures/", import.meta.url);
const CLOSE_REPORT = JSON.parse(readFileSync(new URL("close_2026-09-18_generated_report.json", FIXTURES), "utf8"));
const CLOSE_DATA = JSON.parse(readFileSync(new URL("close_2026-09-18_data_packet.json", FIXTURES), "utf8"));
const REPORT: MarketReportPacket = CLOSE_REPORT.payload;
const METRICS: Array<Record<string, unknown>> = CLOSE_DATA.payload.metrics;
const DAY = "2026-09-18";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const MORNING_REPORT: MarketReportPacket = {
  ...REPORT,
  report_type: "morning",
  headline_ja: "米国株高を受けた寄り付きに注目",
  market_direction: "up",
  next_watch_ja: ["半導体株の寄り付き", "ドル円の水準"],
  risks_ja: ["原油高"],
};

function detail(reportType: "morning" | "close" = "close", morning: MarketReportPacket | null = MORNING_REPORT): AppMarketDetail {
  return buildAppMarketDetail({
    reportType,
    tradingDate: DAY,
    reportPacketId: CLOSE_REPORT.id,
    report: { ...REPORT, report_type: reportType },
    metrics: METRICS,
    morningPacket: morning,
  });
}

function shared(d: AppMarketDetail, themes = true): SharedMarketInput {
  return {
    direction: REPORT.market_direction,
    headlineJa: REPORT.headline_ja,
    summaryJa: REPORT.market_summary_ja,
    claims: REPORT.claims,
    nextWatchJa: REPORT.next_watch_ja,
    section: appMarketSection(REPORT, CLOSE_REPORT.id, CLOSE_REPORT.content_hash),
    tailwindThemesJa: themes ? ["半導体"] : [],
    headwindThemesJa: [],
    crossAssetJa: crossAssetLines(d),
    morningWatchJa: d.morning_reference?.next_watch_ja ?? [],
  };
}

function series(closes: Array<[string, number]>, marketTimeIso = "2026-09-18T06:30:00Z"): PriceSeries {
  return { bars: closes.map(([date, close]) => ({ date, close })), marketTimeIso };
}

const UP = series([["2026-09-16", 1000], ["2026-09-17", 1000], ["2026-09-18", 1050]]); // +5.00%
const FLAT = series([["2026-09-16", 1000], ["2026-09-17", 1000], ["2026-09-18", 1000]]); // ±0.00%
const DOWN = series([["2026-09-16", 1000], ["2026-09-17", 1000], ["2026-09-18", 980]]); // -2.00%
const INDICES = [
  { label: "日経平均", series: series([["2026-09-17", 64136.25], ["2026-09-18", 65018.95]]) },
  { label: BENCHMARK_LABEL, series: series([["2026-09-17", 1000], ["2026-09-18", 1000]]) }, // ±0.00%
];

function tracked(ticker: string, overrides: Partial<TrackedInput> = {}): TrackedInput {
  return {
    trackedStockId: `t-${ticker}`, tickerCode: ticker, companyName: `会社${ticker}`, sector: "電気機器",
    trackingType: "holding", quantity: 100, averagePrice: 900, positionType: "cash", side: "long", ...overrides,
  };
}

function news(id: string, ticker: string | null, overrides: Partial<NewsInput> = {}): NewsInput {
  return {
    newsId: id, tickerCode: ticker, companyName: ticker ? `会社${ticker}` : "市場", trackingType: "holding",
    severity: "high", matchedSectors: [], newsTime: "2026-09-18T01:00:00Z", sourceUrl: null, sourceType: "tdnet",
    textOrigin: "app_copy", headlineJa: "業績予想を上方修正", summaryJa: "通期の営業利益予想を引き上げました。",
    keyPointsJa: [], ...overrides,
  };
}

function snapshotFor(input: {
  reportType?: "morning" | "close";
  tracked: TrackedInput[];
  prices: Record<string, PriceSeries | null>;
  news?: NewsInput[];
  morningStances?: Map<string, Stance>;
}) {
  return buildSnapshot({
    reportType: input.reportType ?? "close",
    tradingDate: DAY,
    tracked: input.tracked,
    prices: new Map(Object.entries(input.prices)),
    indices: INDICES,
    news: input.news ?? [],
    morningStances: input.morningStances,
  });
}

function impact(ticker: string, overrides: Partial<HoldingImpact> = {}): HoldingImpact {
  return {
    ticker_code: ticker, stance: "no_clear_material", basis: [],
    fact_ja: "明確な個別材料は確認できていません。", inference_ja: "", watch_ja: "", ...overrides,
  };
}

function body(overrides: Partial<ReportBody> = {}): ReportBody {
  return {
    title_ja: "保有株の値動きと材料", summary_ja: "保有銘柄の値動きを確認しました。", tone: "neutral",
    overview_ja: "保有銘柄の値動きを整理しました。", holding_impacts: [], morning_review_ja: "",
    watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["明日の寄り付きを確認します。"], ...overrides,
  };
}

function requester(draft: unknown, calls: string[] = []): Requester {
  return (step) => {
    calls.push(step);
    return Promise.resolve({ payload: step === "draft" ? { ...draft as object, sufficient_information: true } : { passed: true, issues: [] }, inputTokens: 10, outputTokens: 10 });
  };
}

// --- market-wide section ------------------------------------------------------

test("close market detail: cross-asset groups, themes, news and gaps come verbatim from the shared packets", () => {
  const d = detail("close");
  assert.deepEqual(d.metric_groups.map((group) => group.group_ja), ["日本株", "米国株", "半導体", "為替", "金利", "原油"]);
  const japan = d.metric_groups[0].items;
  assert.deepEqual(japan.map((item) => [item.label, item.value_display, item.change_display]), [
    ["日経平均", "65,018.95", "+1.38%"],
    ["TOPIX連動ETF（1306）", "426.3円", "-0.26%"],
    ["東証グロース市場250指数", null, null],
    ["日経平均先物", null, null],
  ]);
  assert.equal(japan[3].note_ja, "確認できる取得元がないため表示していません");
  const rates = d.metric_groups.find((group) => group.group_ja === "金利")!.items;
  assert.deepEqual(rates[0], {
    key: "us2y", label: "米国2年債利回り", value_display: "4.74%", change_display: "+0.07ポイント",
    session_date: "2026-09-16", freshness: "fresh", note_ja: null,
  });
  assert.equal(rates[2].freshness, "stale");
  assert.equal(rates[2].change_display, null, "a stale value never carries a day change");
  assert.match(rates[2].note_ja ?? "", /8月31日時点/);
  assert.equal(d.metric_groups.find((group) => group.group_ja === "為替")!.items[0].change_display, "+0.64円");
  assert.equal(d.headline_ja, REPORT.headline_ja);
  assert.equal(d.summary_ja, REPORT.market_summary_ja);
  assert.deepEqual(d.overnight_claims.map((claim) => claim.text_ja), REPORT.claims.filter((c) => c.scope === "overnight").map((c) => c.text_ja));
  assert.deepEqual(d.key_news, REPORT.key_news);
  assert.deepEqual(d.data_gaps_ja, REPORT.data_gaps_ja);
  assert.ok(d.watch_points_ja.includes("次回は、日経平均とTOPIX連動ETF（1306）の方向差が続くかを確認します。"));
});

test("morning market detail labels Japanese closes as the previous session and has no morning reference", () => {
  const morningMetrics = METRICS.map((metric) => metric.key === "nikkei225" ? { ...metric, session_date: "2026-09-17" } : metric);
  const d = buildAppMarketDetail({
    reportType: "morning", tradingDate: DAY, reportPacketId: "m1", report: MORNING_REPORT, metrics: morningMetrics,
    morningPacket: MORNING_REPORT,
  });
  assert.equal(d.metric_groups[0].items[0].note_ja, "前営業日の終値");
  assert.equal(d.morning_reference, null);
  assert.equal(d.report_type, "morning");
});

test("close market detail carries the shared morning expectation for the morning→close comparison", () => {
  assert.deepEqual(detail("close").morning_reference, {
    headline_ja: "米国株高を受けた寄り付きに注目", direction: "up",
    next_watch_ja: ["半導体株の寄り付き", "ドル円の水準"], risks_ja: ["原油高"],
  });
  assert.equal(detail("close", null).morning_reference, null, "no morning packet → no comparison, not a guess");
});

test("missing market datapoints stay missing: unavailable or stale values never reach the per-user packet as facts", () => {
  const line = metricLine({ key: "wti", label: "WTI原油", unit: "usd_per_barrel", value: 107, freshness: "unavailable", gap_reason: "fetch_failed" }, "close", DAY);
  assert.deepEqual([line.value_display, line.change_display, line.note_ja], [null, null, "取得できませんでした"]);
  const lines = crossAssetLines(detail("close"));
  assert.ok(lines.some((l) => l.startsWith("半導体: フィラデルフィア半導体株指数（SOX） 11,599.49（前日比 +3.14%）")));
  assert.ok(!lines.some((l) => l.includes("日本国債")), "stale JGB yields are not offered as today's facts");
  assert.ok(!lines.some((l) => l.includes("先物")), "futures without a source are never offered");
});

test("building the app detail never changes the shared packet or the X post made from it", () => {
  const before = formatSharedXPost(REPORT);
  const frozen = JSON.stringify(REPORT);
  detail("close");
  crossAssetLines(detail("morning"));
  assert.equal(JSON.stringify(REPORT), frozen);
  assert.equal(formatSharedXPost(REPORT), before);
});

// --- portfolio impact ---------------------------------------------------------

test("holdings present: evidence, detail level and relative move are decided in code", () => {
  const snapshot = snapshotFor({
    tracked: [tracked("1111"), tracked("2222"), tracked("3333", { sector: "銀行業" })],
    prices: { "1111": UP, "2222": FLAT, "3333": DOWN },
    news: [news("n1", "1111"), news("m1", null, { matchedSectors: ["銀行業"], headlineJa: "日銀が利上げ" })],
  });
  const byTicker = new Map(snapshot.holdings.map((stock) => [stock.ticker_code, stock]));
  assert.deepEqual(byTicker.get("1111")!.evidence, { company_news: true, sector_news: false });
  assert.equal(byTicker.get("1111")!.detail_level, "detailed");
  assert.equal(byTicker.get("1111")!.relative_to_benchmark_pt, 5);
  assert.equal(byTicker.get("1111")!.relative_label, "stronger");
  assert.deepEqual(byTicker.get("3333")!.evidence, { company_news: false, sector_news: true });
  assert.equal(byTicker.get("3333")!.detail_level, "detailed");
  assert.equal(byTicker.get("2222")!.detail_level, "brief", "no material and an in-line move → brief");
  const d = detail();
  assert.deepEqual(allowedBasis(byTicker.get("1111")!, shared(d)), ["company_news", "market_theme", "macro"]);
  assert.deepEqual(allowedBasis(byTicker.get("2222")!, null), [], "legacy lane: no shared basis at all");
});

test("one holding with strong material: a tailwind citing its own news passes", async () => {
  const snapshot = snapshotFor({ tracked: [tracked("1111")], prices: { "1111": UP }, news: [news("n1", "1111")] });
  const packet = buildPacket(snapshot, [news("n1", "1111")], shared(detail()));
  const draft = body({
    holding_impacts: [impact("1111", {
      stance: "tailwind", basis: ["company_news", "macro"],
      fact_ja: "終値は1,050円、前日比+5.00%でした。業績予想の上方修正が確認できます。",
      inference_ja: "SOXの上昇も半導体関連の買い材料になった可能性があります。",
      watch_ja: "明日は上方修正後の値動きが続くかを確認します。",
    })],
  });
  const calls: string[] = [];
  const outcome = await generateReport(snapshot, packet, requester(draft, calls));
  assert.equal(outcome.status, "passed", outcome.issues.join(","));
  assert.deepEqual(calls, ["draft", "fact"]);
  // Latin names are allowed only when the packet's own text carries them — never the internal basis codes.
  const leaked = body({ holding_impacts: [impact("1111", { fact_ja: "company news が出ています。" })] });
  assert.ok(localReportIssues(leaked, snapshot, packet).some((issue) => issue.startsWith("CONTAINS_LATIN_WORD")));
});

test("holding with no direct material: no invented reason, basis must exist, brief stays brief", () => {
  const snapshot = snapshotFor({ tracked: [tracked("2222")], prices: { "2222": FLAT } });
  const packet = buildPacket(snapshot, [], shared(detail(), false));
  assert.deepEqual(holdingImpactIssues(body({ holding_impacts: [impact("2222")] }), snapshot, packet), []);
  assert.deepEqual(
    holdingImpactIssues(body({ holding_impacts: [impact("2222", { stance: "tailwind", basis: ["company_news"] })] }), snapshot, packet),
    ["BASIS_NOT_AVAILABLE:2222"],
  );
  assert.deepEqual(
    holdingImpactIssues(body({ holding_impacts: [impact("2222", { stance: "headwind", basis: [] })] }), snapshot, packet),
    ["STANCE_WITHOUT_BASIS:2222"],
  );
  assert.deepEqual(
    holdingImpactIssues(body({ holding_impacts: [impact("2222", { inference_ja: "円高が逆風になりました。" })] }), snapshot, packet),
    ["INFERENCE_NOT_HEDGED:2222"],
  );
  const long = "明確な個別材料は確認できていません。".repeat(6);
  assert.deepEqual(
    holdingImpactIssues(body({ holding_impacts: [impact("2222", { fact_ja: long })] }), snapshot, packet),
    ["IMPACT_TOO_LONG:2222"],
  );
  const instructions = String(reportDraftRequestBody("morning", packet).instructions);
  assert.ok(instructions.includes("無理に理由を作らず no_clear_material"));
});

test("multiple holdings: every holding gets exactly one impact, unknown or duplicated tickers fail", () => {
  const snapshot = snapshotFor({
    tracked: [tracked("1111"), tracked("2222"), tracked("4444", { trackingType: "watch", quantity: null, averagePrice: null })],
    prices: { "1111": UP, "2222": FLAT, "4444": FLAT },
    news: [news("n1", "1111")],
  });
  const packet = buildPacket(snapshot, [news("n1", "1111")], shared(detail()));
  const ok = body({ holding_impacts: [impact("1111", { stance: "tailwind", basis: ["company_news"], fact_ja: "前日比+5.00%でした。" }), impact("2222")] });
  assert.deepEqual(localReportIssues(ok, snapshot, packet), []);
  assert.ok(localReportIssues(body({ holding_impacts: [impact("1111")] }), snapshot, packet).includes("MISSING_HOLDING_IMPACTS"));
  assert.ok(localReportIssues(body({ holding_impacts: [impact("1111"), impact("2222"), impact("4444")] }), snapshot, packet)
    .includes("UNKNOWN_HOLDING_TICKER"), "watch stocks never get a holding impact");
  assert.ok(localReportIssues(body({ holding_impacts: [impact("1111"), impact("1111"), impact("2222")] }), snapshot, packet)
    .includes("DUPLICATE_TICKER_NOTE"));
});

test("no holdings: a market-wide report still stands when the shared analysis exists", async () => {
  const snapshot = snapshotFor({ tracked: [], prices: {} });
  assert.deepEqual(snapshotBlockers(snapshot), ["NO_TRACKED_STOCKS"], "legacy lane without market data: nothing to say");
  assert.deepEqual(snapshotBlockers(snapshot, true), []);
  const packet = buildPacket(snapshot, [], shared(detail()));
  const outcome = await generateReport(snapshot, packet, requester(body({ overview_ja: "今日は保有銘柄がないため、市場全体の動きを中心に確認しました。" })));
  assert.equal(outcome.status, "passed", outcome.issues.join(","));
  const update = reportUpdate(outcome, snapshot, {}, new Date("2026-09-18T08:20:00Z"), null, detail());
  assert.equal(update.status, "completed");
  assert.deepEqual((update.body as { holding_impacts: unknown[] }).holding_impacts, []);
  assert.ok((update.body as { market_detail?: unknown }).market_detail);
});

// --- morning → close ------------------------------------------------------------

test("outlook check compares a directional morning stance with the close, relative to the benchmark", () => {
  const ok = (changePercent: number) => ({ status: "ok" as const, sessionDate: DAY, close: 1, previousClose: 1, change: 0, changePercent });
  assert.equal(outlookCheck("tailwind", ok(5), 5), "matched");
  assert.equal(outlookCheck("tailwind", ok(-2), -2), "diverged");
  assert.equal(outlookCheck("tailwind", ok(0.1), 0.1), "mixed");
  assert.equal(outlookCheck("headwind", ok(-2), -2), "matched");
  assert.equal(outlookCheck("headwind", ok(3), null), "diverged", "falls back to the stock's own move");
  assert.equal(outlookCheck("neutral", ok(5), 5), "not_comparable");
  assert.equal(outlookCheck("no_clear_material", ok(5), 5), "not_comparable");
  assert.equal(outlookCheck(null, ok(5), 5), "not_comparable");
  assert.equal(outlookCheck("tailwind", { ...ok(0), status: "unavailable", changePercent: null }, null), "not_comparable");
});

test("close snapshot and packet carry the user's own morning outlook and its code-judged result", () => {
  const snapshot = snapshotFor({
    tracked: [tracked("1111"), tracked("3333")],
    prices: { "1111": UP, "3333": DOWN },
    morningStances: new Map<string, Stance>([["1111", "tailwind"], ["3333", "tailwind"]]),
  });
  const byTicker = new Map(snapshot.holdings.map((stock) => [stock.ticker_code, stock]));
  assert.equal(byTicker.get("1111")!.outlook_check, "matched");
  assert.equal(byTicker.get("3333")!.outlook_check, "diverged");
  const packet = buildPacket(snapshot, [], shared(detail())) as { holdings: Array<Record<string, unknown>>; shared_market: Record<string, unknown> };
  const first = packet.holdings.find((holding) => holding.ticker_code === "3333")!;
  assert.deepEqual(first.morning_outlook, { stance: "追い風", check: "朝の見通しと逆の動き" });
  assert.deepEqual(packet.shared_market.morning_watch, ["半導体株の寄り付き", "ドル円の水準"]);
  const morning = snapshotFor({ reportType: "morning", tracked: [tracked("1111")], prices: { "1111": UP }, morningStances: new Map([["1111", "tailwind"]]) });
  assert.equal(morning.holdings[0].morning_stance, null, "a morning report never compares with itself");
  assert.equal(morning.holdings[0].outlook_check, null);
  assert.ok(holdingImpactIssues(body({ morning_review_ja: "朝の想定どおりでした。", holding_impacts: [impact("1111")] }), morning,
    buildPacket(morning, [])).includes("MORNING_REVIEW_ON_MORNING"));
});

test("the morning lookup is pinned to the same user and ignores any other user's row", () => {
  const path = morningReportPath(USER_A, DAY);
  assert.ok(path.includes(`user_id=eq.${USER_A}`));
  assert.ok(path.includes("report_type=eq.morning") && path.includes(`trading_date=eq.${DAY}`));
  assert.ok(path.includes("status=eq.completed") && path.includes("fact_status=eq.passed"));
  assert.throws(() => morningReportPath("*", DAY), /MORNING_REPORT_QUERY_INVALID/);
  assert.throws(() => morningReportPath(USER_A, "2026-09-18&user_id=neq.x"), /MORNING_REPORT_QUERY_INVALID/);
  const rows = [
    { id: "b-morning", user_id: USER_B, body: { holding_impacts: [{ ticker_code: "9999", stance: "headwind" }] } },
    { id: "a-morning", user_id: USER_A, body: { holding_impacts: [{ ticker_code: "1111", stance: "tailwind" }, { ticker_code: "2222", stance: "bogus" }] } },
  ];
  const own = morningStancesFromRows(rows, USER_A);
  assert.equal(own.reportId, "a-morning");
  assert.deepEqual([...own.stances], [["1111", "tailwind"]]);
  assert.deepEqual(morningStancesFromRows([rows[0]], USER_A), { reportId: null, stances: new Map() });
  assert.deepEqual(morningStancesFromRows(null, USER_A).stances.size, 0);
});

test("no cross-user leakage: each user's packet holds only that user's tickers and no user id", () => {
  const a = snapshotFor({ tracked: [tracked("1111")], prices: { "1111": UP } });
  const b = snapshotFor({ tracked: [tracked("7777", { companyName: "他人の会社" })], prices: { "7777": UP } });
  const d = detail();
  const packetA = JSON.stringify(buildPacket(a, [], shared(d)));
  const packetB = JSON.stringify(buildPacket(b, [], shared(d)));
  assert.ok(packetA.includes("1111") && !packetA.includes("7777") && !packetA.includes("他人の会社"));
  assert.ok(packetB.includes("7777") && !packetB.includes("会社1111"));
  for (const text of [packetA, packetB]) {
    assert.ok(!text.includes(USER_A) && !text.includes(USER_B), "no user id reaches the model");
  }
  assert.equal(JSON.stringify(buildPacket(a, [], shared(d)).shared_market), JSON.stringify(buildPacket(b, [], shared(d)).shared_market),
    "the market part is identical for every user");
});

// --- stored output ------------------------------------------------------------

test("stored body: market section, portfolio impacts and review in a stable shape, legacy notes kept", async () => {
  const snapshot = snapshotFor({
    tracked: [tracked("1111")], prices: { "1111": UP }, news: [news("n1", "1111")],
    morningStances: new Map<string, Stance>([["1111", "tailwind"]]),
  });
  const d = detail();
  const packet = buildPacket(snapshot, [news("n1", "1111")], shared(d));
  const draft = body({
    holding_impacts: [impact("1111", {
      stance: "tailwind", basis: ["company_news"],
      fact_ja: "前日比+5.00%で、朝の見通しどおりの動きでした。業績予想の上方修正が確認できます。",
      inference_ja: "上方修正が評価された可能性があります。",
      watch_ja: "明日も出来高を伴うかを確認します。",
    })],
    morning_review_ja: "朝は半導体株の寄り付きに注目していました。保有銘柄は朝の見通しどおりの動きでした。",
  });
  const outcome = await generateReport(snapshot, packet, requester(draft));
  assert.equal(outcome.status, "passed", outcome.issues.join(","));
  const update = reportUpdate(outcome, snapshot, {}, new Date("2026-09-18T08:20:00Z"), shared(d).section, d);
  const stored = update.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(stored), [
    "tone", "overview_ja", "holding_impacts", "morning_review_ja", "stock_notes", "watch_notes",
    "risk_notes_ja", "checkpoints_ja", "market_section", "market_detail",
  ]);
  assert.deepEqual(stored.stock_notes, [{
    ticker_code: "1111",
    note_ja: "前日比+5.00%で、朝の見通しどおりの動きでした。業績予想の上方修正が確認できます。 上方修正が評価された可能性があります。",
  }]);
  assert.equal((stored.market_detail as AppMarketDetail).version, "app_market_detail.v1");
  const snap = update.portfolio_snapshot as { holdings: Array<{ outlook_check: string; morning_stance: string }> };
  assert.equal(snap.holdings[0].outlook_check, "matched");
  assert.equal(snap.holdings[0].morning_stance, "tailwind");
});
