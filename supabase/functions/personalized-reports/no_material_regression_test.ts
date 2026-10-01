// Regression for PR #32 head 722d191: the prompt asked for an empty fact_ja on no_clear_material holdings,
// parseReportDraft drops impacts with an empty fact_ja, and the missing impact failed the whole report
// (MISSING_HOLDING_IMPACTS). Fixed at the prompt level with a holding-scoped input-state sentence; the
// parser and existing validator rules are unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BENCHMARK_LABEL,
  buildPacket,
  buildSnapshot,
  EMPTY_NEWS_FACT_RULE,
  HOLDING_NO_MATERIAL_FACT_RULE,
  HOLDING_NO_MATERIAL_SENTENCE,
  inferenceIsHedged,
  localReportIssues,
  parseReportDraft,
  REPORT_FACT_INSTRUCTIONS,
  REPORT_LIMITS,
  reportDraftRequestBody,
  type NewsInput,
  type PriceSeries,
} from "./report_logic.ts";

function series(closes: Array<[string, number]>): PriceSeries {
  return { bars: closes.map(([date, close]) => ({ date, close })), marketTimeIso: "2026-09-25T06:30:00Z" };
}

const FLAT = series([["2026-09-24", 1000], ["2026-09-25", 1000], ["2026-09-28", 1000]]);

const NEWS_A: NewsInput = {
  newsId: "n1", tickerCode: "1111", companyName: "会社1111", trackingType: "holding", severity: "medium",
  matchedSectors: [], newsTime: "2026-09-25T06:00:00Z", sourceUrl: null, sourceType: null,
  textOrigin: "verified_post", headlineJa: "会社1111が資料を公表", summaryJa: null, keyPointsJa: [],
};

// Mixed-news morning: holding A (1111) has its own news, holding B (2222) has none.
function mixed() {
  const tracked = ["1111", "2222"].map((tickerCode) => ({
    trackedStockId: `t${tickerCode}`, tickerCode, companyName: `会社${tickerCode}`, sector: "サービス業",
    trackingType: "holding" as const, quantity: 100, averagePrice: 900, positionType: "cash" as const, side: "long" as const,
  }));
  const snapshot = buildSnapshot({
    reportType: "morning", tradingDate: "2026-09-28", tracked,
    prices: new Map([["1111", FLAT], ["2222", FLAT]]),
    indices: [{ label: "日経平均", series: FLAT }, { label: BENCHMARK_LABEL, series: FLAT }],
    news: [NEWS_A],
  });
  return { snapshot, packet: buildPacket(snapshot, [NEWS_A]) };
}

function draft(impacts: Array<Record<string, unknown>>) {
  return {
    sufficient_information: true, title_ja: "今日の注目点", summary_ja: "保有銘柄の注目点を整理しました。", tone: "neutral",
    overview_ja: "保有銘柄の注目点を整理しました。", holding_impacts: impacts, morning_review_ja: "",
    watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["前営業日の終値に照らして確認します。"],
  };
}

test("1-3: a no-material holding keeps a non-empty fact_ja, the parser keeps every impact, no MISSING_HOLDING_IMPACTS", () => {
  const { snapshot, packet } = mixed();
  const parsed = parseReportDraft(draft([
    { ticker_code: "1111", stance: "tailwind", basis: ["company_news"], fact_ja: "会社1111が資料を公表しました。", inference_ja: "", watch_ja: "" },
    { ticker_code: "2222", stance: "no_clear_material", basis: [], fact_ja: `${HOLDING_NO_MATERIAL_SENTENCE}。`, inference_ja: "", watch_ja: "" },
  ]));
  assert.ok(parsed.body);
  assert.deepEqual(parsed.body.holding_impacts.map((impact) => impact.ticker_code), ["1111", "2222"]);
  assert.ok(parsed.body.holding_impacts.every((impact) => impact.fact_ja.length > 0));
  assert.deepEqual(localReportIssues(parsed.body, snapshot, packet), []);
});

test("the old empty-fact_ja output still fails, which is why the prompt must never ask for it", () => {
  const { snapshot, packet } = mixed();
  const parsed = parseReportDraft(draft([
    { ticker_code: "1111", stance: "tailwind", basis: ["company_news"], fact_ja: "会社1111が資料を公表しました。", inference_ja: "", watch_ja: "" },
    { ticker_code: "2222", stance: "no_clear_material", basis: [], fact_ja: "", inference_ja: "", watch_ja: "" },
  ]));
  assert.ok(localReportIssues(parsed.body!, snapshot, packet).includes("MISSING_HOLDING_IMPACTS"));
  const prompt = String(reportDraftRequestBody("morning", packet).instructions);
  assert.ok(prompt.includes("fact_ja は空にしません。"));
  assert.ok(!prompt.includes("書ける事実がなければ空文字にします。"));
});

test("4: mixed news — the holding with news cannot claim no material; the one without can", () => {
  const { snapshot, packet } = mixed();
  const holdings = (packet as { holdings: Array<{ ticker_code: string; material_in_input: string }> }).holdings;
  assert.deepEqual(holdings.map((h) => [h.ticker_code, h.material_in_input]), [["1111", "含まれている"], ["2222", "含まれていない"]]);
  const falseClaim = parseReportDraft(draft([
    { ticker_code: "1111", stance: "no_clear_material", basis: [], fact_ja: `${HOLDING_NO_MATERIAL_SENTENCE}。`, inference_ja: "", watch_ja: "" },
    { ticker_code: "2222", stance: "no_clear_material", basis: [], fact_ja: `${HOLDING_NO_MATERIAL_SENTENCE}。`, inference_ja: "", watch_ja: "" },
  ])).body!;
  assert.deepEqual(localReportIssues(falseClaim, snapshot, packet), ["FALSE_NO_MATERIAL_CLAIM:1111"]);
  assert.ok(HOLDING_NO_MATERIAL_FACT_RULE.includes("「含まれている」銘柄にこの文を書いた場合"));
  assert.ok(REPORT_FACT_INSTRUCTIONS.includes(HOLDING_NO_MATERIAL_FACT_RULE));
});

test("5: the packet-wide empty-input sentence stays conditional on all news being empty", () => {
  assert.ok(EMPTY_NEWS_FACT_RULE.includes("すべて空のときに限り"));
  assert.ok(EMPTY_NEWS_FACT_RULE.includes("1件でもあるのに空入力を断定した場合は passed を false"));
  const prompt = String(reportDraftRequestBody("morning", mixed().packet).instructions);
  assert.ok(prompt.includes("すべて空の場合に限り、fact_ja に「入力に明確な個別材料は含まれていません」と書くこともできます。"));
});

test("6-7: world-state no-news claims and observed intraday claims remain Fact failures", () => {
  for (const rule of ["「ニュースはありません」", "「材料はありません」", "「個別ニュースは確認されていません」", "寄り付き・場中の値動きを観測済みの事実として書く"]) {
    assert.ok(EMPTY_NEWS_FACT_RULE.includes(rule), rule);
  }
  assert.ok(HOLDING_NO_MATERIAL_FACT_RULE.includes("世の中にニュースが無いと断定した場合は passed を false"));
  for (const rule of ["売買推奨", "ニュースと値動きの因果の断定", "packetに無い数字・日付・固有名詞・事実"]) {
    assert.ok(REPORT_FACT_INSTRUCTIONS.includes(rule), rule);
  }
});

test("8: close validator behaviour is unchanged", () => {
  assert.equal(inferenceIsHedged("値下がりの要因は特定できません。"), true);
  assert.equal(inferenceIsHedged("円高が逆風になりましたが、値下がりの要因は特定できません。"), false);
  assert.equal(inferenceIsHedged("小幅高でしたが、指数との比較では相対的に弱く、値動きの要因は特定できません。"), false);
});

test("9: brief limits stay morning 120 / close 160", () => {
  assert.equal(REPORT_LIMITS.impactBriefMorning, 120);
  assert.equal(REPORT_LIMITS.impactBriefClose, 160);
});

// 2026-09-30 close: the app report was withheld by the Fact check after the overview said
// 「個別材料が含まれていない入力」 while the packet held market and watch-list news. The report-level,
// unscoped claim is now rejected by the local check (before Fact), and stays allowed when it is true.
test("10: a report-level 'no material' claim without a scope is rejected while the packet holds news", () => {
  const { snapshot, packet } = mixed();
  const impacts = [
    { ticker_code: "1111", stance: "neutral", basis: [], fact_ja: "会社1111が資料を公表しました。", inference_ja: "", watch_ja: "" },
    { ticker_code: "2222", stance: "no_clear_material", basis: [], fact_ja: `${HOLDING_NO_MATERIAL_SENTENCE}。`, inference_ja: "", watch_ja: "" },
  ];
  const withOverview = (overview: string) => parseReportDraft({ ...draft(impacts), overview_ja: overview }).body!;
  for (const overview of [
    "保有銘柄の入力には個別材料がなく、前営業日の終値が確認ポイントです。",
    "個別材料が含まれていない入力のため、指数の動きを確認します。",
    "きょうは目立ったニュースはありません。",
  ]) {
    assert.deepEqual(localReportIssues(withOverview(overview), snapshot, packet), ["FALSE_BROAD_NO_MATERIAL_CLAIM"], overview);
  }
  // Scoped to one holding, or about something specific: allowed (the holding-level rule still applies).
  for (const overview of [
    "会社1111は資料を公表しました。会社2222についての個別ニュースはありません。",
    "値動きの理由を説明するニュースは確認できません。",
  ]) {
    assert.deepEqual(localReportIssues(withOverview(overview), snapshot, packet), [], overview);
  }
  // With no news anywhere in the packet the statement is true and stays allowed.
  const tracked = [{
    trackedStockId: "t2222", tickerCode: "2222", companyName: "会社2222", sector: "サービス業",
    trackingType: "holding" as const, quantity: 100, averagePrice: 900, positionType: "cash" as const, side: "long" as const,
  }];
  const emptySnapshot = buildSnapshot({
    reportType: "morning", tradingDate: "2026-09-28", tracked, prices: new Map([["2222", FLAT]]),
    indices: [{ label: "日経平均", series: FLAT }, { label: BENCHMARK_LABEL, series: FLAT }], news: [],
  });
  const quiet = parseReportDraft({ ...draft([impacts[1]]), overview_ja: "入力に個別の材料は含まれていません。" }).body!;
  assert.deepEqual(localReportIssues(quiet, emptySnapshot, buildPacket(emptySnapshot, [])), []);
});
