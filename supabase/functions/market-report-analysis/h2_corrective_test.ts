// PR #110 H2 corrective (2026-10-08): B1 an objective contradiction found only by Fact is removed, never delivered
// as advisory; B2 a decorative emoji inside a clause does not split date / subject / value; B3 a hedge qualifies only
// its own clause. Built on the delivered 2026-10-07 close (production generation, read-only fixture).
import assert from "node:assert/strict";
import test from "node:test";
import {
  codeFallbacks,
  type GeneratedAnalysis,
  generateSharedAnalysis,
  localAnalysisCheck,
  MAX_MODEL_CALLS,
  parseGeneratedAnalysis,
  type Requester,
  unitChecker,
} from "./analysis_logic.ts";
import { sanitizeAnalysis, splitUnits } from "./unit_sanitizer.ts";
import { inputOf, loadFixture } from "./test_support.ts";
import { formatSharedXPost } from "../_shared/market_report_packet.ts";

const input = inputOf(await loadFixture("close_2026-10-07"));
type Generation = { attempt: number; generation_index: number; candidate: unknown };
const generations: Generation[] = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/close_2026-10-07_generations.json", import.meta.url)),
);
const delivered = () => parseGeneratedAnalysis(structuredClone(generations.find((g) => g.attempt === 2)!.candidate))!;
const NOW = () => new Date("2026-10-07T07:20:05Z");
const sanitize = (analysis: GeneratedAnalysis) =>
  sanitizeAnalysis(analysis, input, (kept) => unitChecker(input, kept), codeFallbacks(input));
const has = (issues: string[], part: string) => issues.some((issue) => issue.includes(part));

function scripted(steps: Array<{ step: "generate" | "fact"; payload: unknown }>, calls: string[]): Requester {
  return (step) => {
    calls.push(step);
    const next = steps.shift();
    assert.ok(next, `unexpected ${step} call`);
    assert.equal(next.step, step);
    return Promise.resolve({ payload: structuredClone(next.payload), inputTokens: 1000, outputTokens: 400 });
  };
}

// ---------------------------------------------------------------------------------------------
// B1
// ---------------------------------------------------------------------------------------------

const NEGATION = "公正取引委員会はサッポロビールへの調査を実施していません。";
const negated = () => {
  const analysis = delivered();
  analysis.app_story!.news_ja = `${analysis.app_story!.news_ja}${NEGATION}`;
  return analysis;
};
const objectiveFact = (quote = NEGATION) => ({
  passed: false,
  issues: ["サッポロビールへの調査を否定しているが、入力では調査を受けていると公表している"],
  objective_issues: [{ quote_ja: quote, reason_ja: "入力では公正取引委員会の調査を受けていると公表" }],
});

test("B1: the exact サッポロビール negation passes the local guards and is removed on Fact's objective finding", async () => {
  assert.deepEqual(localAnalysisCheck(negated(), input).hard, [], "the local guards cannot see it (why Fact is needed)");
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, scripted([
    { step: "generate", payload: negated() }, { step: "fact", payload: objectiveFact() },
    { step: "generate", payload: negated() }, { step: "fact", payload: objectiveFact() },
  ], calls), NOW);
  assert.deepEqual(calls, ["generate", "fact", "generate", "fact"]);
  assert.ok(outcome.ok);
  const packet = outcome.ok ? outcome.packet : null!;
  assert.ok(!JSON.stringify(packet).includes("調査を実施していません"), "the contradiction is never delivered");
  assert.equal(packet.app_story!.news_ja, delivered().app_story!.news_ja, "the rest of the paragraph stays");
  assert.ok(packet.fact.removed_units!.some((code) => /^UNIT_REMOVED:FACT_OBJECTIVE@app_story\.news_ja#\d+$/.test(code)), packet.fact.removed_units!.join(" "));
  assert.equal(packet.fact.ai_status, "advisory", "the remaining (soft) findings stay advisory");
  const record = outcome.trace.records.find((item) => item.selectedForDelivery)!;
  assert.ok(record.localWarnings.some((warning) => warning.startsWith("FACT_OBJECTIVE:「公正取引委員会は")), "the finding is in the trace");
});

test("B1: a quote that matches no unit leaves the candidate undeliverable; another safe one is chosen, else the cycle fails", async () => {
  const unmapped = objectiveFact("この文は本文のどこにもありません。");
  // Generation 2 has only a soft finding: it is delivered, generation 1 is not.
  const mixed = await generateSharedAnalysis(input, scripted([
    { step: "generate", payload: negated() }, { step: "fact", payload: unmapped },
    { step: "generate", payload: delivered() }, { step: "fact", payload: { passed: false, issues: ["言い回しが硬い"], objective_issues: [] } },
  ], []), NOW);
  assert.ok(mixed.ok);
  assert.equal(mixed.trace.deliveredGeneration, 2);
  assert.ok(has(mixed.trace.records[0].deliveryIssues, "FACT_OBJECTIVE_UNMAPPED"));
  assert.ok(mixed.ok && !JSON.stringify(mixed.packet).includes("調査を実施していません"));
  // Both unmapped: nothing objectively safe is left, the cycle fails (and is retried by the schedule).
  const calls: string[] = [];
  const failed = await generateSharedAnalysis(input, scripted([
    { step: "generate", payload: negated() }, { step: "fact", payload: unmapped },
    { step: "generate", payload: negated() }, { step: "fact", payload: unmapped },
  ], calls), NOW);
  assert.deepEqual([failed.ok, !failed.ok && failed.error], [false, "ANALYSIS_FACT_FAILED"]);
  assert.equal(calls.length, MAX_MODEL_CALLS);
  assert.ok(!failed.ok && has(failed.issues, "FACT_OBJECTIVE_UNMAPPED"));
});

test("B1: an unchecked candidate whose Fact verdict makes it unsafe is skipped; the next one gets the last call", async () => {
  const wrong = delivered();
  wrong.headline_ja = "日経平均とTOPIXがそろって下落"; // removed locally: generation 1 is a sanitized, unchecked candidate
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, scripted([
    { step: "generate", payload: wrong },
    { step: "generate", payload: negated() }, { step: "fact", payload: objectiveFact("どこにも無い文です。ここにも無い。") },
    { step: "fact", payload: { passed: true, issues: [], objective_issues: [] } },
  ], calls), NOW);
  assert.deepEqual(calls, ["generate", "generate", "fact", "fact"]);
  assert.ok(outcome.ok);
  assert.equal(outcome.trace.deliveredGeneration, 1);
  assert.equal(outcome.ok && outcome.packet.fact.ai_status, "passed");
});

test("B1: soft Fact findings alone stay advisory and remove nothing", async () => {
  const outcome = await generateSharedAnalysis(input, scripted([
    { step: "generate", payload: delivered() }, { step: "fact", payload: { passed: false, issues: ["文体が硬い"], objective_issues: [] } },
    { step: "generate", payload: delivered() }, { step: "fact", payload: { passed: false, issues: ["文体が硬い"] } },
  ], []), NOW);
  assert.ok(outcome.ok);
  assert.equal(outcome.ok && outcome.packet.fact.ai_status, "advisory");
  assert.equal(outcome.ok && outcome.packet.fact.removed_units, undefined);
});

// ---------------------------------------------------------------------------------------------
// B2
// ---------------------------------------------------------------------------------------------

test("B2: an inline emoji before the value keeps date, subject and value together; the wrong date is removed", () => {
  const exact = "10月6日の日経平均は📉 70,035.71（前日比−0.92%）でした。";
  assert.deepEqual(splitUnits(exact), [exact]);
  const analysis = delivered();
  analysis.app_story!.japan_ja = `${exact}${analysis.app_story!.japan_ja}`;
  assert.ok(has(localAnalysisCheck(analysis, input).hard, "日付と指標の不一致"));
  const result = sanitize(analysis);
  assert.deepEqual(result.removed.map((unit) => `${unit.code}@${unit.path}`), ["WRONG_DATE@app_story.japan_ja#0"]);
});

test("B2: probes — emoji before the value, the percentage, between subject/date/value, next to punctuation", () => {
  for (const text of [
    "10月6日の日経平均は📉 70,035.71（前日比−0.92%）でした。",
    "10月6日の日経平均は70,035.71（前日比📉 −0.92%）でした。",
    "10月6日の日経平均は70,035.71（前日比−0.92📉 %）でした。",
    "10月6日の📉 日経平均は70,035.71でした。",
    "10月6日の日経平均📉 は70,035.71でした。",
    "10月6日📉 の日経平均は70,035.71でした。",
    "10月6日の日経平均は70,035.71📉 （前日比−0.92%）でした。",
    "10月6日の日経平均は70,035.71📉 、前日比−0.92%でした。",
    "日経平均は下落📉 70,035.71でした。",
  ]) {
    assert.equal(splitUnits(text).length, 1, text);
    const analysis = delivered();
    analysis.x_post.context_ja = text;
    if (text.startsWith("10月6日")) assert.ok(has(localAnalysisCheck(analysis, input).hard, "日付と指標の不一致"), text);
  }
});

test("B2: the 10/7 sentence boundary after a completed sentence is kept (no false positive)", () => {
  const legit = "10月7日の日経平均は70,035.71（前日比−0.92%）でした📉 10月6日の米国市場では主要株価指数がそろって上昇。";
  assert.deepEqual(splitUnits(legit), [
    "10月7日の日経平均は70,035.71（前日比−0.92%）でした📉 ",
    "10月6日の米国市場では主要株価指数がそろって上昇。",
  ]);
  const analysis = delivered();
  analysis.x_post.context_ja = legit;
  assert.deepEqual(localAnalysisCheck(analysis, input).hard, []);
  assert.deepEqual(splitUnits("東京市場は下落📉 米国市場は上昇しました。"), ["東京市場は下落📉 ", "米国市場は上昇しました。"]);
});

// ---------------------------------------------------------------------------------------------
// B3
// ---------------------------------------------------------------------------------------------

const CAUSAL = "根拠の無い因果の断定";
const verdictOf = (sentence: string) => {
  const analysis = delivered();
  analysis.x_post.closing_ja = sentence;
  const check = localAnalysisCheck(analysis, input);
  return has(check.hard, CAUSAL) ? "assertive" : check.warnings.some((w) => w.startsWith("SPECULATIVE_CAUSALITY")) ? "speculative" : "none";
};

test("B3: a hedge in another clause does not license a definite unsupported cause (exact reproduction)", () => {
  assert.equal(verdictOf("ウクライナ情勢を受けて東京市場は下落しましたが、今後の動きには不確実な可能性があります。"), "assertive");
  assert.equal(verdictOf("ウクライナ情勢が重しとなった可能性があります。"), "speculative");
});

test("B3: multi-clause controls (が / 一方 / ただし / ため / ので / しかし)", () => {
  const cases: Array<[string, string]> = [
    ["東京市場は下落しましたが、ウクライナ情勢が重しとなった可能性があります。", "speculative"],
    ["ウクライナ情勢が重しとなった可能性がある一方、米国株高を受けて東京市場は下落しました。", "assertive"],
    ["ウクライナ情勢を受けて東京市場は下落しました。ただし、今後は不透明な可能性があります。", "assertive"],
    ["ウクライナ情勢を受けて東京市場は下落したため、慎重な見方が出ている可能性があります。", "assertive"],
    ["ウクライナ情勢が重しとなった可能性があるため、続報を確認します。", "speculative"],
    ["ウクライナ情勢を受けて東京市場は下落したので、今後も変動する可能性があります。", "assertive"],
    ["ウクライナ情勢を受けて東京市場は下落しましたが、因果関係は確認できません。", "assertive"],
    ["ウクライナ情勢の影響かは断定できません。", "none"],
    ["米国株安の影響で日経平均も下落した可能性がありますが、しかし確認はできません。", "speculative"],
  ];
  for (const [sentence, expected] of cases) assert.equal(verdictOf(sentence), expected, sentence);
});

test("B3: the delivery re-check sees the same clause semantics: the asserted clause's sentence is removed", () => {
  const analysis = delivered();
  analysis.x_post.context_ja = `${analysis.x_post.context_ja}ウクライナ情勢を受けて東京市場は下落しましたが、今後の動きには不確実な可能性があります。`;
  const result = sanitize(analysis);
  assert.ok(result.removed.some((unit) => unit.code === "UNSUPPORTED_CAUSALITY" && unit.path.startsWith("x_post.context_ja#")));
  assert.deepEqual(localAnalysisCheck(result.analysis, input, { delivery: true }).hard, []);
  assert.ok(!formatSharedXPost({ ...packetLike(result.analysis) }).includes("ウクライナ情勢を受けて"));
});

function packetLike(analysis: GeneratedAnalysis) {
  return {
    schema_version: "market_report_packet.v1", report_type: "close", trading_date: "2026-10-07", headline_ja: analysis.headline_ja,
    x_post: analysis.x_post, presentation_version: "market_presentation.v2",
  } as unknown as Parameters<typeof formatSharedXPost>[0];
}
