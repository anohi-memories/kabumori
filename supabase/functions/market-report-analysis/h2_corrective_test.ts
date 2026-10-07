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
  objectiveCoverage,
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

// ---------------------------------------------------------------------------------------------
// Residuals after the B1-B4 rereview (2026-10-08): B1-R1, B2-R1, B3-R1
// ---------------------------------------------------------------------------------------------

const withNews = (text: string) => {
  const analysis = delivered();
  analysis.app_story!.news_ja = `${analysis.app_story!.news_ja}${text}`;
  analysis.x_post.news_ja = `${analysis.x_post.news_ja}${text}`;
  return analysis;
};
const quoted = (quote: string) => ({ passed: false, issues: ["入力と矛盾"], objective_issues: [{ quote_ja: quote, reason_ja: "入力と矛盾" }] });

test("B1-R1: a quote over two units removes both, the short one included (exact reproduction)", async () => {
  const text = "公正取引委員会はサッポロビールへの調査を実施していません。調査なし。";
  const outcome = await generateSharedAnalysis(input, scripted([
    { step: "generate", payload: withNews(text) }, { step: "fact", payload: quoted(text) },
    { step: "generate", payload: withNews(text) }, { step: "fact", payload: quoted(text) },
  ], []), NOW);
  assert.ok(outcome.ok);
  const json = outcome.ok ? JSON.stringify(outcome.packet) : "";
  assert.ok(!json.includes("調査なし") && !json.includes("実施していません"), "nothing of the quote is delivered");
  assert.equal(outcome.ok && outcome.packet.app_story!.news_ja, delivered().app_story!.news_ja);
  assert.equal(outcome.ok && outcome.packet.x_post.news_ja, delivered().x_post.news_ja);
});

test("B1-R1: a quote over three units removes all three", async () => {
  const text = "公正取引委員会はサッポロビールへの調査を実施していません。調査なし。問題なし。";
  const outcome = await generateSharedAnalysis(input, scripted([
    { step: "generate", payload: withNews(text) }, { step: "fact", payload: quoted(text) },
    { step: "generate", payload: withNews(text) }, { step: "fact", payload: quoted(text) },
  ], []), NOW);
  assert.ok(outcome.ok);
  const json = outcome.ok ? JSON.stringify(outcome.packet) : "";
  for (const part of ["実施していません", "調査なし", "問題なし"]) assert.ok(!json.includes(part), part);
});

test("B1-R1: coverage must be complete and anchored; a standalone short quote stays fail-closed", () => {
  const units = ["公正取引委員会はサッポロビールへの調査を実施していません", "調査なし", "問題なし", "サッポロビールは調査を公表"];
  assert.deepEqual([...objectiveCoverage("公正取引委員会はサッポロビールへの調査を実施していません調査なし", units)!], [units[0], units[1]]);
  assert.equal(objectiveCoverage("調査なし", units), null, "short and standalone: never mapped");
  assert.equal(objectiveCoverage("調査なし問題なし", units), null, "only short units: not anchored");
  assert.equal(objectiveCoverage("公正取引委員会はサッポロビールへの調査を実施していません追加の文", units), null, "a part not in any unit: not covered");
  // A quote that starts inside a unit and runs into the next one covers both.
  assert.deepEqual([...objectiveCoverage("サッポロビールへの調査を実施していません調査なし", units)!].sort(), [units[0], units[1]].sort());
});

test("B1-R1: an objective quote that cannot be fully covered leaves the candidate undeliverable", async () => {
  const text = "公正取引委員会はサッポロビールへの調査を実施していません。調査なし。";
  const partial = quoted(`${text}業績への影響もありません。`);
  const failed = await generateSharedAnalysis(input, scripted([
    { step: "generate", payload: withNews(text) }, { step: "fact", payload: partial },
    { step: "generate", payload: withNews(text) }, { step: "fact", payload: partial },
  ], []), NOW);
  assert.deepEqual([failed.ok, !failed.ok && failed.error], [false, "ANALYSIS_FACT_FAILED"]);
  assert.ok(!failed.ok && has(failed.issues, "FACT_OBJECTIVE_UNMAPPED"));
});

test("B2-R1: a date or subject fragment, or a chain of emoji, is no sentence: the wrong date is caught (exact shapes)", () => {
  for (const text of [
    "10月6日📉 日経平均は70,035.71（前日比−0.92%）でした。",
    "日経平均📉 10月6日は70,035.71（前日比−0.92%）でした。",
    "10月6日の📉 📉 日経平均は70,035.71（前日比−0.92%）でした。",
  ]) {
    assert.equal(splitUnits(text).length, 1, text);
    const analysis = delivered();
    analysis.x_post.context_ja = text;
    assert.ok(has(localAnalysisCheck(analysis, input).hard, "日付と指標の不一致"), text);
  }
});

test("B2-R1 controls: a completed statement before the emoji still ends the sentence", () => {
  for (const [text, parts] of [
    ["10月7日の日経平均は70,035.71（前日比−0.92%）でした📉 10月6日の米国市場では主要株価指数がそろって上昇。", 2],
    ["東京市場は下落📉 米国市場は上昇しました。", 2],
    ["10月7日の東京市場は下落しました📉 📈 10月6日の米国市場は上昇しました。", 2],
    ["東京市場は下落しました📉", 1],
    ["日経平均は下落📉 70,035.71でした。", 1],
  ] as const) assert.equal(splitUnits(text).length, parts, text);
  const analysis = delivered();
  analysis.x_post.context_ja = "10月7日の日経平均は70,035.71（前日比−0.92%）でした📉 10月6日の米国市場では主要株価指数がそろって上昇。";
  assert.deepEqual(localAnalysisCheck(analysis, input).hard, []);
});

test("B3-R1: a conjunction without a comma still closes the causal clause (exact が / けれど / ので)", () => {
  for (const conjunction of ["が", "けれど", "ので"]) {
    assert.equal(verdictOf(`ウクライナ情勢を受けて東京市場は下落しました${conjunction}今後の動きには不確実な可能性があります。`), "assertive", conjunction);
  }
});

test("B3-R1 controls: ものの / ため / 一方 / ただし / しかし without a comma, and genuine hedges", () => {
  const cases: Array<[string, string]> = [
    ["ウクライナ情勢を受けて東京市場は下落したものの今後は不確実な可能性があります。", "assertive"],
    ["ウクライナ情勢を受けて東京市場は下落したため今後は慎重な見方が出る可能性があります。", "assertive"],
    ["ウクライナ情勢を受けて東京市場は下落した一方今後は反発する可能性があります。", "assertive"],
    ["ウクライナ情勢を受けて東京市場は下落しましたただし今後は不確実な可能性があります。", "assertive"],
    ["ウクライナ情勢を受けて東京市場は下落ししかし今後は戻す可能性があります。", "assertive"],
    ["ウクライナ情勢が重しとなった可能性があります。", "speculative"],
    ["ウクライナ情勢が重しとなった可能性があるので続報を確認します。", "speculative"],
    ["東京市場は下落しましたがウクライナ情勢が重しとなった可能性があります。", "speculative"],
    ["ウクライナ情勢の影響で一方的に下落した可能性があります。", "speculative"],
  ];
  for (const [sentence, expected] of cases) assert.equal(verdictOf(sentence), expected, sentence);
});
