// Regression tests for the close-report validator issues found by production v22 dry-runs
// (close 3/3 REPORT_LOCAL_CHECK_FAILED: 2x IMPACT_TOO_LONG on brief holdings at 104-136 chars,
// 1x INFERENCE_NOT_HEDGED on a sentence that only said the cause could not be determined).
import assert from "node:assert/strict";
import test from "node:test";
import {
  BENCHMARK_LABEL,
  buildPacket,
  buildSnapshot,
  generateReport,
  holdingImpactIssues,
  inferenceIsHedged,
  localReportIssues,
  REPORT_LIMITS,
  reportDraftRequestBody,
  type HoldingImpact,
  type NewsInput,
  type PriceSeries,
  type ReportBody,
  type Requester,
  type SharedMarketInput,
  type TrackedInput,
} from "./report_logic.ts";
import { appMarketSection, type MarketReportPacket } from "../_shared/market_report_packet.ts";

const DAY = "2026-09-24";

function series(closes: Array<[string, number]>): PriceSeries {
  return { bars: closes.map(([date, close]) => ({ date, close })), marketTimeIso: "2026-09-24T06:30:00Z" };
}

// -0.50% on the day vs a flat benchmark: a "weaker" holding with no material, still brief
// (the gap stays under RELATIVE_DETAIL_PT).
const DOWN = series([["2026-09-22", 2000], ["2026-09-23", 2000], ["2026-09-24", 1990]]);
const FLAT = series([["2026-09-22", 1000], ["2026-09-23", 1000], ["2026-09-24", 1000]]);
const INDICES = [
  { label: "日経平均", series: series([["2026-09-23", 64000], ["2026-09-24", 64000]]) },
  { label: BENCHMARK_LABEL, series: FLAT },
];

function tracked(ticker: string, overrides: Partial<TrackedInput> = {}): TrackedInput {
  return {
    trackedStockId: `t-${ticker}`, tickerCode: ticker, companyName: `会社${ticker}`, sector: "サービス業",
    trackingType: "holding", quantity: 100, averagePrice: 1900, positionType: "cash", side: "long", ...overrides,
  };
}

function snapshot(reportType: "morning" | "close", prices: Record<string, PriceSeries> = { "1111": DOWN }, news: NewsInput[] = []) {
  return buildSnapshot({
    reportType, tradingDate: DAY, tracked: Object.keys(prices).map((ticker) => tracked(ticker)),
    prices: new Map(Object.entries(prices)), indices: INDICES, news,
  });
}

function impact(overrides: Partial<HoldingImpact> = {}): HoldingImpact {
  return {
    ticker_code: "1111", stance: "no_clear_material", basis: [],
    fact_ja: "明確な個別材料は確認できていません。", inference_ja: "", watch_ja: "", ...overrides,
  };
}

function body(overrides: Partial<ReportBody> = {}): ReportBody {
  return {
    title_ja: "保有株は小幅安", summary_ja: "保有銘柄は前日比-0.50%でした。", tone: "neutral",
    overview_ja: "保有銘柄は前日比-0.50%でした。", holding_impacts: [impact()], morning_review_ja: "",
    watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["明日の寄り付きを確認します。"], ...overrides,
  };
}

function chars(n: number): string {
  // Japanese filler without digits, so only the length check is exercised.
  return "値動きを確認しました".repeat(Math.ceil(n / 10)).slice(0, n);
}

const lengthOf = (value: string) => Array.from(value).length;

// --- A. brief length limits ---------------------------------------------------

test("brief limits are split by report type and stay tight (not a detailed write-up)", () => {
  assert.equal(REPORT_LIMITS.impactBriefMorning, 120);
  assert.equal(REPORT_LIMITS.impactBriefClose, 160);
  assert.ok(REPORT_LIMITS.impactBriefClose < REPORT_LIMITS.impactFact + REPORT_LIMITS.impactInference + REPORT_LIMITS.impactWatch,
    "a brief entry is still much shorter than a detailed one");
});

test("close brief of 104-136 characters (the v22 dry-run range) now passes", () => {
  const snap = snapshot("close");
  assert.equal(snap.holdings[0].detail_level, "brief");
  assert.equal(snap.holdings[0].relative_label, "weaker");
  const packet = buildPacket(snap, []);
  for (const total of [104, 120, 136]) {
    const entry = impact({ fact_ja: chars(total - 20), watch_ja: chars(20) });
    assert.equal(lengthOf(entry.fact_ja) + lengthOf(entry.watch_ja), total);
    assert.deepEqual(holdingImpactIssues(body({ holding_impacts: [entry] }), snap, packet), [], `${total} chars`);
  }
});

test("close brief up to 160 characters passes; 161 fails", () => {
  const snap = snapshot("close");
  const packet = buildPacket(snap, []);
  assert.deepEqual(holdingImpactIssues(body({ holding_impacts: [impact({ fact_ja: chars(160) })] }), snap, packet), []);
  assert.deepEqual(holdingImpactIssues(body({ holding_impacts: [impact({ fact_ja: chars(161) })] }), snap, packet),
    ["IMPACT_TOO_LONG:1111"]);
  assert.deepEqual(
    holdingImpactIssues(body({ holding_impacts: [impact({ fact_ja: chars(100), inference_ja: "要因は特定できません。", watch_ja: chars(50) })] }), snap, packet),
    ["IMPACT_TOO_LONG:1111"], "the limit applies to fact + inference + watch combined");
});

test("morning brief limit is 120 characters", () => {
  const snap = snapshot("morning", { "1111": FLAT });
  assert.equal(snap.holdings[0].detail_level, "brief");
  const packet = buildPacket(snap, []);
  assert.deepEqual(holdingImpactIssues(body({ holding_impacts: [impact({ fact_ja: chars(120) })] }), snap, packet), []);
  assert.deepEqual(holdingImpactIssues(body({ holding_impacts: [impact({ fact_ja: chars(121) })] }), snap, packet),
    ["IMPACT_TOO_LONG:1111"]);
});

test("the prompt states the report-type-specific brief limit", () => {
  const close = String(reportDraftRequestBody("close", buildPacket(snapshot("close"), [])).instructions);
  const morning = String(reportDraftRequestBody("morning", buildPacket(snapshot("morning"), [])).instructions);
  assert.ok(close.includes("「簡潔に」の銘柄は三つの合計で160字以内"));
  assert.ok(morning.includes("「簡潔に」の銘柄は三つの合計で120字以内"));
});

// --- B. unknown-cause statements vs unhedged causal claims ---------------------

test("statements that the cause cannot be determined pass without a hedge", () => {
  for (const text of [
    "要因は特定できません。",
    "明確な要因は特定できません。",
    "明確な個別材料は確認できません。",
    "個別材料は確認できていません。",
    "入力情報から要因を判断できません。",
    "材料との因果関係は確認できません。",
    // The exact v22 close dry-run sentence that was rejected.
    "個別材料が確認できないため、当日の下落を特定の要因に結び付けることはできません。",
  ]) {
    assert.equal(inferenceIsHedged(text), true, text);
  }
});

test("unhedged causal or directional claims still fail", () => {
  for (const text of [
    "円高が逆風になりました。",
    "半導体安が下落の原因です。",
    "金利上昇で売られました。",
    "円高を受けて下落しました。",
    "円高が逆風になりましたが、要因は特定できません。",
    "要因は特定できません。円高が逆風になりました。",
    "当日は下落しました。",
  ]) {
    assert.equal(inferenceIsHedged(text), false, text);
  }
});

test("a later hedge or unknown-cause phrase cannot launder an asserted cause", () => {
  for (const text of [
    "円高が逆風になりましたが、要因は特定できない可能性があります。",
    "円高が逆風になりましたが、影響する可能性があります。",
    "円高を受けて下落しましたが理由は特定できません。",
    "円高が逆風になりました. 影響が続く可能性があります。",
    "円高が逆風になりました！影響が続く可能性があります。",
    "円高が逆風になりました\n影響が続く可能性があります。",
    "材料は特定できません。今日は株価が必ず上昇します。",
    "為替の影響が広がっていますが、個別材料は確認できません。",
    "市場背景は悪化し、要因は特定できません。",
    "株価は大幅に下落しましたが、明確な材料は確認できません。",
  ]) {
    assert.equal(inferenceIsHedged(text), false, text);
  }
});

test("hedged inference still passes, including mixed with an unknown-cause sentence", () => {
  assert.equal(inferenceIsHedged("円高が逆風になる可能性があります。"), true);
  assert.equal(inferenceIsHedged("金利上昇が重荷になったと考えられます。"), true);
  assert.equal(inferenceIsHedged("個別の要因は特定できません。市場全体の動きに連動したとみられます。"), true);
});

test("a hedged macro inference passes end to end only when the macro basis is allowed", () => {
  const snap = snapshot("close");
  const shared: SharedMarketInput = {
    direction: "down", headlineJa: "日経平均は横ばい", summaryJa: "日経平均は横ばいでした。", claims: [], nextWatchJa: [],
    section: appMarketSection({ claims: [], key_news: [], next_watch_ja: [], risks_ja: [], data_gaps_ja: [], major_moves: [] } as unknown as MarketReportPacket, "r", "h"),
    tailwindThemesJa: [], headwindThemesJa: [], crossAssetJa: ["為替: ドル円 150.00円（前日比 -1.00円）"],
  };
  const withMacro = buildPacket(snap, [], shared);
  const entry = impact({ stance: "headwind", basis: ["macro"], fact_ja: "前日比-0.50%でした。", inference_ja: "円高が逆風になる可能性があります。" });
  assert.deepEqual(holdingImpactIssues(body({ holding_impacts: [entry] }), snap, withMacro), []);
  assert.deepEqual(holdingImpactIssues(body({ holding_impacts: [{ ...entry, inference_ja: "円高が逆風になりました。" }] }), snap, withMacro),
    ["INFERENCE_NOT_HEDGED:1111"]);
  assert.deepEqual(holdingImpactIssues(body({ holding_impacts: [entry] }), snap, buildPacket(snap, [])),
    ["BASIS_NOT_AVAILABLE:1111"], "without the shared market there is no macro basis to cite");
});

// --- regressions ------------------------------------------------------------------

test("fact / inference / watch stay separate fields and all are checked", () => {
  const snap = snapshot("close");
  const packet = buildPacket(snap, []);
  const issues = localReportIssues(body({ holding_impacts: [impact({ watch_ja: "明日は必ず上がる見込みです。" })] }), snap, packet);
  assert.ok(issues.includes("CONTAINS_INVESTMENT_ADVICE"), "watch text is still scanned");
  const numbers = localReportIssues(body({ holding_impacts: [impact({ inference_ja: "12,345円まで下がった可能性があります。" })] }), snap, packet);
  assert.ok(numbers.some((issue) => issue.startsWith("NUMBER_NOT_IN_PACKET")), "inference numbers are still checked");
});

test("existing numeric / date / URL / advice / ticker / duplicate checks do not regress", () => {
  const snap = snapshot("close", { "1111": DOWN, "2222": FLAT });
  const packet = buildPacket(snap, []);
  const two = [impact(), impact({ ticker_code: "2222" })];
  assert.deepEqual(localReportIssues(body({ holding_impacts: two }), snap, packet), []);
  const check = (overrides: Partial<ReportBody>) => localReportIssues(body({ holding_impacts: two, ...overrides }), snap, packet);
  assert.ok(check({ overview_ja: "ポートは+99,999円でした。" }).some((issue) => issue.startsWith("NUMBER_NOT_IN_PACKET")));
  assert.ok(check({ overview_ja: "2026-09-24の値動きです。" }).includes("CONTAINS_ISO_DATE"));
  assert.ok(check({ overview_ja: "詳しくは https://example.com へ。" }).includes("CONTAINS_URL"));
  assert.ok(check({ checkpoints_ja: ["今のうちに買うべきです。"] }).includes("CONTAINS_INVESTMENT_ADVICE"));
  assert.ok(check({ holding_impacts: [...two, impact({ ticker_code: "9999" })] }).includes("UNKNOWN_HOLDING_TICKER"));
  assert.ok(check({ holding_impacts: [impact(), impact()] }).includes("DUPLICATE_TICKER_NOTE"));
  assert.ok(check({ holding_impacts: [impact()] }).includes("MISSING_HOLDING_IMPACTS"));
});

function requester(draft: ReportBody, calls: string[] = []): Requester {
  return (step) => {
    calls.push(step);
    return Promise.resolve({
      payload: step === "draft" ? { ...draft, sufficient_information: true } : { passed: true, issues: [] },
      inputTokens: 10, outputTokens: 10,
    });
  };
}

test("the existing morning success case still passes end to end", async () => {
  const snap = snapshot("morning", { "1111": FLAT });
  const calls: string[] = [];
  const outcome = await generateReport(snap, buildPacket(snap, []), requester(body({
    title_ja: "今日は保有株の材料待ち", summary_ja: "目立った材料は確認できていません。", overview_ja: "保有銘柄の材料を確認します。",
    holding_impacts: [impact({ watch_ja: "寄り付きの値動きを確認します。" })],
  }), calls));
  assert.equal(outcome.status, "passed", outcome.issues.join(","));
  assert.deepEqual(calls, ["draft", "fact"]);
});

test("v22 close dry-run failure patterns (fixtured) now reach the Fact step and pass", async () => {
  const snap = snapshot("close", { "1111": DOWN, "2222": FLAT });
  const packet = buildPacket(snap, []);
  // Pattern 1: brief close entry of ~130 characters (was IMPACT_TOO_LONG at the 100-char limit).
  const longBrief = impact({
    fact_ja: "終値は1,990円で、前日比-0.50%でした。TOPIX連動ETF（1306）より弱い動きでしたが、この銘柄について当日確認できた個別の材料はありません。",
    watch_ja: "明日は寄り付き後に下げ止まるか、出来高を伴うかを確認します。",
  });
  const briefTotal = lengthOf(longBrief.fact_ja) + lengthOf(longBrief.watch_ja);
  assert.ok(briefTotal > 100 && briefTotal <= 160, `fixture is in the failing range (${briefTotal})`);
  // Pattern 2: the exact unknown-cause inference sentence (was INFERENCE_NOT_HEDGED).
  const unknownCause = impact({
    ticker_code: "2222",
    inference_ja: "個別材料が確認できないため、当日の下落を特定の要因に結び付けることはできません。",
  });
  const calls: string[] = [];
  const outcome = await generateReport(snap, packet, requester(body({ holding_impacts: [longBrief, unknownCause] }), calls));
  assert.equal(outcome.status, "passed", outcome.issues.join(","));
  assert.deepEqual(calls, ["draft", "fact"], "local checks pass and the Fact check runs");
});

// --- C. unknown-cause statements with a move subject (production v24 close dry-runs) ----------

test("v24 production failures: a move subject before the unknown cause now passes", () => {
  // Exact sentences rejected in production v24 close dry-runs #1 and #2.
  assert.equal(inferenceIsHedged("下落の要因は特定できません。"), true);
  assert.equal(inferenceIsHedged("当日の下落要因は特定できません。"), true);
  // The wording that already passed in dry-run #3 and the earlier bounded attribution sentence.
  assert.equal(inferenceIsHedged("要因は特定できません。"), true);
  assert.equal(inferenceIsHedged("個別材料が確認できないため、当日の下落を特定の要因に結び付けることはできません。"), true);
});

test("the move subject is narrow: only (当日の)(下落|上昇|値下がり|値上がり|値動き|変動)(の) before a named unknown", () => {
  for (const text of [
    "上昇の理由は判断できません。",
    "値動きの原因は確認できません。",
    "当日の変動要因は説明できません。",
    "当日の上昇の要因は特定できません。",
    "下落の背景は確認できていません。",
    "因果関係は確認できません。",
    "値下がりの要因は特定できません。",
    "値上がりの要因は特定できません。",
    "当日の値下がりの要因は特定できません。",
  ]) {
    assert.equal(inferenceIsHedged(text), true, text);
  }
  for (const text of [
    "円安による上昇の要因は特定できません。", // free text before the subject
    "半導体株の下落の要因は特定できません。", // subject other than the allowed move nouns
    "当日の要因は特定できません。円高が逆風になりました。",
    "急な下落の要因は特定できません。",
    "急な値下がりの要因は特定できません。",
  ]) {
    assert.equal(inferenceIsHedged(text), false, text);
  }
});

// --- D. 値下がり/値上がり recognized as the same "cause unknown" statement as 下落/上昇 ----------
// Root cause: UNDETERMINED_MOVE_PREFIX's move-noun alternation had 下落/上昇 but not their more
// colloquial verb-noun synonyms 値下がり/値上がり, so a semantically identical hedge was wrongly
// rejected (observed in a production v26 close dry-run: 「値下がりの要因は特定できません」).

test("値下がり/値上がり pass exactly like their 下落/上昇 synonyms (root-cause regression)", () => {
  for (const text of [
    "下落の要因は特定できません。",
    "値下がりの要因は特定できません。",
    "上昇の要因は特定できません。",
    "値上がりの要因は特定できません。",
  ]) {
    assert.equal(inferenceIsHedged(text), true, text);
  }
});

test("値下がり/値上がり do not weaken hedging safety: an unrelated allowed noun is still not laundered, and a causal assertion naming 値下がり/値上がり is still rejected", () => {
  for (const text of [
    "値下がりの要因は円高です。", // asserts a cause using the allowed noun -- must still fail
    "値上がりの理由は好決算です。",
    "円高を受けて値下がりしましたが理由は特定できません。", // causal assertion elsewhere in the sentence
    "値下がりの要因は特定できません\n円高が逆風になりました", // multi-sentence: second sentence unhedged
  ]) {
    assert.equal(inferenceIsHedged(text), false, text);
  }
});

test("a holding_impacts draft using 値下がり/値上がり passes the local checks and reaches the Fact call (was INFERENCE_NOT_HEDGED, no MIC content involved)", async () => {
  const snap = snapshot("close", { "1111": DOWN, "2222": FLAT });
  const packet = buildPacket(snap, []);
  const unknownCauseFall = impact({ ticker_code: "2222", inference_ja: "値下がりの要因は特定できません。" });
  const unknownCauseRise = impact({ ticker_code: "1111", inference_ja: "値上がりの要因は特定できません。" });
  const calls: string[] = [];
  const outcome = await generateReport(snap, packet, requester(body({ holding_impacts: [unknownCauseFall, unknownCauseRise] }), calls));
  assert.equal(outcome.status, "passed", outcome.issues.join(","));
  assert.deepEqual(calls, ["draft", "fact"], "local checks pass and the Fact check runs");
});

test("causal assertions are still rejected even with an unknown-cause clause or a hedge", () => {
  for (const text of [
    "円高が逆風になりましたが、要因は特定できません。",
    "円高を受けて下落しましたが理由は特定できません。",
    "金利上昇が原因です。ただし要因は特定できません。",
    "金利上昇が原因です。下落の要因は特定できません。",
    "円高が逆風になりました。可能性もあります。",
    "円高で売られました、下落の要因は特定できない可能性があります。",
  ]) {
    assert.equal(inferenceIsHedged(text), false, text);
  }
});

test("multi-sentence unsafe text fails regardless of punctuation or newlines", () => {
  for (const text of [
    "下落の要因は特定できません\n円高が逆風になりました",
    "下落の要因は特定できません；金利上昇が原因です",
    "下落の要因は特定できません! 円高で売られました",
  ]) {
    assert.equal(inferenceIsHedged(text), false, JSON.stringify(text));
  }
});

test("an unrelated sentence containing an allowed noun is not laundered", () => {
  for (const text of [
    "下落の要因は円高です。",
    "上昇の理由は好決算です。",
    "材料が出たため下落しました。",
    "値動きの原因は需給悪化でした。",
  ]) {
    assert.equal(inferenceIsHedged(text), false, text);
  }
});

test("brief boundaries are unchanged (morning 120 / close 160)", () => {
  assert.equal(REPORT_LIMITS.impactBriefMorning, 120);
  assert.equal(REPORT_LIMITS.impactBriefClose, 160);
});
