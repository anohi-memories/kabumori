// Delivery first (2026-10-07): an objective error removes or neutralizes the smallest unit that carries it and the
// rest is delivered; a Fact finding regenerates once and is then advisory; the cycle fails only when nothing coherent
// is left. Replays the 2026-10-07 close (production generations, read-only) and the required regressions.
import assert from "node:assert/strict";
import test from "node:test";
import {
  codeFallbacks,
  type GeneratedAnalysis,
  generateSharedAnalysis,
  localAnalysisCheck,
  MAX_GENERATIONS,
  MAX_MODEL_CALLS,
  parseGeneratedAnalysis,
  type Requester,
  unitChecker,
} from "./analysis_logic.ts";
import { sanitizeAnalysis, splitUnits } from "./unit_sanitizer.ts";
import { DEFAULT_TRANSPORT_RETRY } from "./transport_retry.ts";
import { inputOf, loadFixture, rich0917, richClose0930, richClose1001, richMorning1001 } from "./test_support.ts";
import {
  formatSharedXPost,
  REPORT_DISCLAIMER_JA,
  sharedXPostIssues,
  sharedXPostWarnings,
  X_POST_HARD_MAX_CHARS,
} from "../_shared/market_report_packet.ts";
import { appStoryText, buildAppMarketStory } from "../_shared/market_report_story.ts";

const input = inputOf(await loadFixture("close_2026-10-07"));
type Generation = { attempt: number; generation_index: number; stage: string; local_issues: string[]; candidate: unknown };
const generations: Generation[] = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/close_2026-10-07_generations.json", import.meta.url)),
);
const generation = (attempt: number, index: number) =>
  parseGeneratedAnalysis(generations.find((item) => item.attempt === attempt && item.generation_index === index)!.candidate)!;
/** 16:20 generation 1 (rejected for 「TOPIXそのものではなく」), 16:20 generation 2 (rejected for the date contrast). */
const g1 = () => generation(1, 1);
const g2 = () => generation(1, 2);
/** 16:35 generation 1: the delivered 10/7 close. */
const delivered = () => generation(2, 1);
const sanitize = (analysis: GeneratedAnalysis, built = input) =>
  sanitizeAnalysis(analysis, built, (kept) => unitChecker(built, kept), codeFallbacks(built));
const NOW = () => new Date("2026-10-07T07:20:05Z");
const PASSED = { passed: true, issues: [] };

function requester(steps: Array<{ step: "generate" | "fact"; payload: unknown }>, calls: string[]): Requester {
  return (step) => {
    calls.push(step);
    const next = steps.shift();
    assert.ok(next, `unexpected ${step} call`);
    assert.equal(next.step, step);
    return Promise.resolve({ payload: next.payload, inputTokens: 1000, outputTokens: 400 });
  };
}

// ---------------------------------------------------------------------------------------------
// The 10/7 false positives
// ---------------------------------------------------------------------------------------------

test("10/7 16:20: the exact 「TOPIXそのものではなく」 and 「10月7日の日経平均… 10月6日の米国市場…」 texts do not hard reject", () => {
  assert.ok(g1().app_story!.japan_ja.includes("後者はTOPIXそのものではなく、指数に連動するETFです。"));
  assert.ok(g2().x_post.context_ja!.includes("でした📉 10月6日の米国市場では主要株価指数がそろって上昇。"));
  for (const [label, analysis] of [["g1", g1()], ["g2", g2()], ["delivered", delivered()]] as const) {
    assert.deepEqual(localAnalysisCheck(analysis, input).hard, [], label);
    assert.deepEqual(sanitize(analysis).removed, [], `${label}: nothing is removed either`);
  }
  // Both 16:20 generations would now have been delivered at 16:20 without a regeneration.
  const calls: string[] = [];
  return generateSharedAnalysis(input, requester([{ step: "generate", payload: g1() }, { step: "fact", payload: PASSED }], calls), NOW)
    .then((outcome) => {
      assert.equal(outcome.ok, true);
      assert.deepEqual(calls, ["generate", "fact"]);
    });
});

test("the disambiguation is narrow: a bare TOPIX value claim is still caught", () => {
  const check = unitChecker(input, delivered().claims);
  for (const text of ["10月7日のTOPIXは437.0円（前日比−0.77%）でした。", "日経平均とTOPIXがそろって下落しました。"]) {
    assert.ok(check(text, "factual").remove.some((finding) => finding.code === "TOPIX_MISLABEL"), text);
  }
  for (const text of ["TOPIX連動ETF（1306）はTOPIXそのものではなく、指数に連動するETFです。", "1306はTOPIX自体ではありません。", "TOPIXとは異なり、1306はETFです。"]) {
    assert.deepEqual(check(text, "factual").remove, [], text);
  }
});

test("a sentence ends at a chart emoji followed by a space: each date is read with its own sentence", () => {
  assert.deepEqual(splitUnits("10月7日の日経平均は70,035.71（前日比−0.92%）でした📉 10月6日の米国市場では上昇。"), [
    "10月7日の日経平均は70,035.71（前日比−0.92%）でした📉 ",
    "10月6日の米国市場では上昇。",
  ]);
  assert.equal(splitUnits("見出し📉").join(""), "見出し📉", "units reproduce the text");
});

// ---------------------------------------------------------------------------------------------
// Unit removal
// ---------------------------------------------------------------------------------------------

test("a wrong-date numeric sentence is removed and the rest of the field is delivered", () => {
  const analysis = delivered();
  const wrong = "10月6日の日経平均は70,035.71（前日比−0.92%）でした。";
  analysis.app_story!.japan_ja = `${wrong}${analysis.app_story!.japan_ja}`;
  const result = sanitize(analysis);
  assert.deepEqual(result.removed.map((unit) => [unit.path, unit.code, unit.action]), [["app_story.japan_ja#0", "WRONG_DATE", "removed"]]);
  assert.equal(result.removed[0].text, wrong, "the trace keeps the removed text");
  assert.equal(result.analysis.app_story!.japan_ja, delivered().app_story!.japan_ja, "the other sentences are untouched");
  assert.deepEqual(localAnalysisCheck(result.analysis, input, { delivery: true }).hard, []);
});

test("「TOPIXは437.0円」 is neutralized to the 1306 label; a bare TOPIX without the value is removed", () => {
  const analysis = delivered();
  analysis.app_story!.japan_ja = `10月7日のTOPIXは437.0円（前日比−0.77%）でした。${analysis.app_story!.japan_ja}`;
  analysis.x_post.points_ja[0] = "日経平均とTOPIXがそろって下落";
  const result = sanitize(analysis);
  const japan = result.removed.find((unit) => unit.path === "app_story.japan_ja#0")!;
  assert.deepEqual([japan.code, japan.action], ["TOPIX_MISLABEL", "neutralized"]);
  assert.ok(result.analysis.app_story!.japan_ja.startsWith("10月7日のTOPIX連動ETF（1306）は437.0円（前日比−0.77%）でした。"));
  const point = result.removed.find((unit) => unit.path === "x_post.points_ja[0]")!;
  assert.deepEqual([point.code, point.action], ["TOPIX_MISLABEL", "removed"]);
  assert.equal(result.analysis.x_post.points_ja.length, 2);
  assert.deepEqual(localAnalysisCheck(result.analysis, input, { delivery: true }).hard, []);
});

test("a reversed sign or direction is omitted, never rewritten", () => {
  const analysis = delivered();
  analysis.x_post.points_ja[0] = "10月7日の日経平均は上昇";
  analysis.app_story!.overseas_ja = `10月6日のS&P500は7,818.93（前日比−0.58%）でした。${analysis.app_story!.overseas_ja}`;
  const result = sanitize(analysis);
  const codes = result.removed.map((unit) => `${unit.code}@${unit.path}`);
  assert.ok(codes.includes("WRONG_DIRECTION@x_post.points_ja[0]"), codes.join(" "));
  assert.ok(codes.some((code) => /^WRONG_(?:VALUE|DIRECTION)@app_story\.overseas_ja#0$/.test(code)), codes.join(" "));
  assert.ok(result.removed.every((unit) => unit.action === "removed"));
  assert.ok(!formatSharedXPost(packetFrom(result.analysis)).includes("日経平均は上昇"));
});

test("a stale value presented as current and an unknown ref are isolated", () => {
  const analysis = delivered();
  analysis.app_story!.cross_asset_ja = `${analysis.app_story!.cross_asset_ja}足元のWTI原油は96.16ドルです。`;
  analysis.claims.push({ claim_id: "c9", claim_type: "observation", evidence_refs: ["news:00000000-0000-4000-8000-000000000000"], text_ja: "架空の報道がありました。", scope: "today" });
  analysis.strong_themes = [{ name_ja: "半導体", claim_ids: ["c9"] }];
  analysis.key_news.push({ ref: "news:00000000-0000-4000-8000-000000000001", why_it_matters_ja: "存在しないニュース。" });
  const result = sanitize(analysis);
  const codes = result.removed.map((unit) => `${unit.code}@${unit.path}`);
  assert.ok(codes.some((code) => code.startsWith("STALE_AS_CURRENT@app_story.cross_asset_ja#")), codes.join(" "));
  assert.ok(codes.includes("UNKNOWN_REF@claims[c9]"));
  assert.ok(codes.includes("THEME_CLAIMS@strong_themes[0]"), "a theme resting on a removed claim goes with it");
  assert.ok(codes.some((code) => code.startsWith("UNKNOWN_REF@key_news[")));
  assert.equal(result.analysis.claims.length, delivered().claims.length);
  assert.equal(result.analysis.app_story!.cross_asset_ja, delivered().app_story!.cross_asset_ja);
  assert.deepEqual(localAnalysisCheck(result.analysis, input, { delivery: true }).hard, []);
});

test("an asserted unsupported cause is removed; the same reason offered as a possibility is kept and recorded", () => {
  const analysis = delivered();
  analysis.x_post.context_ja = `米国株高を受けて東京市場は下落しました。${analysis.x_post.context_ja}`;
  analysis.app_story!.japan_ja = `${analysis.app_story!.japan_ja}ウクライナ情勢が重しとなった可能性があります。`;
  const result = sanitize(analysis);
  assert.deepEqual(result.removed.map((unit) => `${unit.code}@${unit.path}`), ["UNSUPPORTED_CAUSALITY@x_post.context_ja#0"]);
  assert.ok(result.analysis.app_story!.japan_ja.endsWith("ウクライナ情勢が重しとなった可能性があります。"));
  assert.ok(result.advisories.some((advisory) => advisory.startsWith("SPECULATIVE_CAUSALITY@app_story.japan_ja#")), result.advisories.join(" "));
  assert.ok(localAnalysisCheck(result.analysis, input, { delivery: true }).warnings.includes("SPECULATIVE_CAUSALITY:1"));
});

test("one bad point plus two safe points delivers two points; one bad App sentence delivers the rest", async () => {
  const bad = delivered();
  bad.x_post.points_ja[1] = "ロシア軍の攻撃を受けて東京市場は下落";
  bad.app_story!.news_ja = `${bad.app_story!.news_ja}サッポロビールの株価は99,999円でした。`;
  const calls: string[] = [];
  // Generation contract: the bad point is a reason to regenerate once; the regeneration repeats it.
  const outcome = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: bad }, { step: "generate", payload: bad }, { step: "fact", payload: PASSED },
  ], calls), NOW);
  assert.deepEqual(calls, ["generate", "generate", "fact"]);
  assert.ok(outcome.ok);
  const packet = outcome.ok ? outcome.packet : null!;
  assert.deepEqual(packet.x_post.points_ja, [delivered().x_post.points_ja[0], delivered().x_post.points_ja[2]]);
  const post = formatSharedXPost(packet);
  assert.ok(post.includes("📌 今日の2ポイント\n・"), "the heading counts what is delivered");
  assert.deepEqual(sharedXPostIssues(packet, post), []);
  assert.equal(packet.app_story!.news_ja, delivered().app_story!.news_ja);
  const removed = packet.fact.removed_units ?? [];
  assert.equal(removed.length, 2, removed.join(" "));
  assert.ok(removed.includes("UNIT_REMOVED:UNSUPPORTED_CAUSALITY@x_post.points_ja[1]"), removed.join(" "));
  assert.ok(removed.some((code) => /^UNIT_REMOVED:VALUE_NOT_IN_INPUT@app_story\.news_ja#\d+$/.test(code)), removed.join(" "));
  assert.ok(packet.fact.quality_warnings!.includes("X_POINTS_REDUCED:2"));
  assert.equal(outcome.trace.records.find((record) => record.selectedForDelivery)?.fallbackReason, "sanitized_units");
});

test("a headline or summary removed as wrong is replaced by the code-rendered one (values next to their own dates)", () => {
  const analysis = delivered();
  analysis.headline_ja = "10月6日の日経平均は70,035.71";
  analysis.market_summary_ja = "日経平均は99,999.99でした。";
  const result = sanitize(analysis);
  assert.equal(result.analysis.headline_ja, "10月7日の東京市場：日経平均 70,035.71（前日比−0.92%）");
  assert.ok(result.analysis.market_summary_ja.startsWith("10月7日の東京市場：日経平均 70,035.71（前日比−0.92%）、TOPIX連動ETF（1306） 437.0円（前日比−0.77%）。10月6日の米国市場："));
  assert.deepEqual(result.removed.filter((unit) => unit.action === "fallback").map((unit) => unit.path), ["headline_ja", "market_summary_ja"]);
  assert.deepEqual(localAnalysisCheck(result.analysis, input, { delivery: true }).hard, []);
});

test("the sanitizer removes nothing from known-good analyses", async () => {
  const cases: Array<[string, GeneratedAnalysis, ReturnType<typeof inputOf>]> = [];
  const close0917 = inputOf(await loadFixture("close_2026-09-17"));
  const close0930 = inputOf(await loadFixture("close_2026-09-30"));
  const morning1001 = inputOf(await loadFixture("morning_2026-10-01"));
  const close1001 = inputOf(await loadFixture("close_2026-10-01"));
  cases.push(["0917", rich0917(close0917), close0917], ["0930", richClose0930(close0930), close0930]);
  cases.push(["1001m", richMorning1001(morning1001), morning1001], ["1001c", richClose1001(close1001), close1001]);
  cases.push(["1007", delivered(), input]);
  for (const [label, analysis, built] of cases) {
    const result = sanitize(analysis, built);
    assert.deepEqual(result.removed, [], label);
    assert.deepEqual(result.analysis, analysis, `${label}: unchanged`);
  }
});

// ---------------------------------------------------------------------------------------------
// Fact and failure
// ---------------------------------------------------------------------------------------------

test("a nonfatal Fact finding regenerates once, then the better generation is delivered as advisory", async () => {
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: delivered() }, { step: "fact", payload: { passed: false, issues: ["言い回しが硬い"] } },
    { step: "generate", payload: delivered() }, { step: "fact", payload: { passed: false, issues: ["言い回しが硬い"] } },
  ], calls), NOW);
  assert.deepEqual(calls, ["generate", "fact", "generate", "fact"]);
  assert.ok(outcome.ok);
  assert.equal(outcome.ok && outcome.packet.fact.ai_status, "advisory");
  assert.ok(String(outcome.trace.records[1].factIssues).includes("言い回しが硬い"), "the finding is recorded");
  assert.equal(outcome.trace.factStatus, "advisory");
});

test("an unchecked candidate gets the one remaining Fact call; after a verdict only checked ones are chosen", async () => {
  const wrong = delivered();
  wrong.headline_ja = "日経平均とTOPIXがそろって下落";
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: wrong },
    { step: "generate", payload: delivered() }, { step: "fact", payload: { passed: false, issues: ["a"] } },
    { step: "fact", payload: { passed: false, issues: ["b"] } },
  ], calls), NOW);
  assert.deepEqual(calls, ["generate", "generate", "fact", "fact"]);
  assert.equal(calls.length, MAX_MODEL_CALLS);
  // Both have findings: the one with nothing removed is delivered.
  assert.equal(outcome.trace.deliveredGeneration, 2);
  assert.ok(outcome.ok && outcome.packet.headline_ja === delivered().headline_ja);
});

test("the cycle fails only when no generation leaves a coherent report", async () => {
  const hopeless = delivered();
  const nonsense = "日経平均は99,999.99でした。";
  hopeless.headline_ja = nonsense;
  hopeless.market_summary_ja = nonsense;
  hopeless.x_post = { ...hopeless.x_post, lead_ja: nonsense, points_ja: [nonsense, nonsense, nonsense], closing_ja: nonsense, context_ja: nonsense, news_ja: nonsense, watch_ja: nonsense };
  hopeless.app_story = Object.fromEntries(Object.keys(hopeless.app_story!).map((key) => [key, nonsense])) as GeneratedAnalysis["app_story"];
  const result = sanitize(hopeless);
  assert.equal(result.coherent, false);
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: hopeless }, { step: "generate", payload: hopeless },
  ], calls), NOW);
  assert.deepEqual([outcome.ok, !outcome.ok && outcome.error], [false, "ANALYSIS_LOCAL_CHECK_FAILED"]);
  assert.deepEqual(calls, ["generate", "generate"], "no Fact call on nothing");
  assert.ok(outcome.trace.records.every((record) => record.deliveryIssues[0]?.startsWith("INCOHERENT")));

  const unparsable = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: { broken: true } }, { step: "generate", payload: { broken: true } },
  ], []), NOW);
  assert.deepEqual([unparsable.ok, !unparsable.ok && unparsable.error], [false, "ANALYSIS_INVALID_OUTPUT"]);
});

test("the call ceiling and the transport retry budget are unchanged", () => {
  assert.equal(MAX_GENERATIONS, 2);
  assert.equal(MAX_MODEL_CALLS, 4);
  assert.deepEqual(DEFAULT_TRANSPORT_RETRY, { maxRetriesPerCall: 2, runRetryBudget: 3, runWaitBudgetMs: 30_000, backoffMs: [2_000, 6_000], maxRetryAfterMs: 20_000 });
});

// ---------------------------------------------------------------------------------------------
// Disclaimer and length
// ---------------------------------------------------------------------------------------------

/** The 10/7 close as delivered through the pipeline (a fresh copy per use). */
const deliveredOutcome = await generateSharedAnalysis(input, requester([{ step: "generate", payload: delivered() }, { step: "fact", payload: PASSED }], []), NOW);
if (!deliveredOutcome.ok) throw new Error("the 10/7 close must deliver");
const packetBase = () => structuredClone(deliveredOutcome.packet);
const packetFrom = (analysis: GeneratedAnalysis) => ({ ...packetBase(), headline_ja: analysis.headline_ja, x_post: analysis.x_post, app_story: analysis.app_story });

test("X: the disclaimer is added by code exactly once, at the end, and never shortened", () => {
  const packet = packetBase();
  const post = formatSharedXPost(packet);
  assert.ok(post.endsWith(`\n\n${REPORT_DISCLAIMER_JA}`));
  assert.equal(post.split(REPORT_DISCLAIMER_JA).length, 2);
  assert.ok(!post.includes("AIが独自調査"));
  // A long Premium post keeps the full disclaimer; length is a warning only.
  const long = packetBase();
  long.x_post = { ...long.x_post, context_ja: "10月7日の日経平均は70,035.71（前日比−0.92%）でした。".repeat(60) };
  const longPost = formatSharedXPost(long);
  assert.ok(Array.from(longPost).length > 2_000 && Array.from(longPost).length <= X_POST_HARD_MAX_CHARS);
  assert.ok(longPost.endsWith(REPORT_DISCLAIMER_JA));
  assert.deepEqual(sharedXPostIssues(long, longPost), []);
  assert.ok(sharedXPostWarnings(long, longPost).some((warning) => warning.startsWith("X_POST_LONGER_THAN_TARGET:")));
  // The disclaimer is not counted: the measured length is the body's.
  const measured = Number(sharedXPostWarnings(long, longPost).find((warning) => warning.startsWith("X_POST_LONGER_THAN_TARGET:"))!.split(":")[1]);
  assert.equal(measured, Array.from(longPost).length - Array.from(REPORT_DISCLAIMER_JA).length - 2);
});

test("a model-written disclaimer is removed so the post never repeats it", () => {
  const analysis = delivered();
  analysis.x_post.closing_ja = `${analysis.x_post.closing_ja}${REPORT_DISCLAIMER_JA}`;
  analysis.app_story!.watch_ja = `${analysis.app_story!.watch_ja}AIが独自調査した内容です。`;
  const result = sanitize(analysis);
  assert.ok(result.removed.some((unit) => unit.code === "MODEL_DISCLAIMER" && unit.path.startsWith("x_post.closing_ja#")));
  assert.ok(result.removed.some((unit) => unit.code === "MODEL_DISCLAIMER" && unit.path.startsWith("app_story.watch_ja#")));
  const post = formatSharedXPost(packetFrom(result.analysis));
  assert.equal(post.split(REPORT_DISCLAIMER_JA).length, 2);
  assert.ok(!post.includes("AIによる分析です。内容に誤り・不足を含む可能性があります。最終的な投資判断はご自身でお願いします。\n"));
});

test("App: the story ends with the disclaimer section exactly once; it is not part of the narrative length", () => {
  const packet = packetBase();
  const story = buildAppMarketStory(packet);
  assert.equal(story.sections.at(-1)!.key, "disclaimer");
  assert.equal(story.sections.at(-1)!.body_ja, REPORT_DISCLAIMER_JA);
  assert.equal(appStoryText(story).split(REPORT_DISCLAIMER_JA).length, 2);
  const without = { ...story, sections: story.sections.slice(0, -1) };
  assert.equal(story.char_count, Array.from(appStoryText(without, false)).length);
  assert.ok(story.total_char_count > Array.from(appStoryText(without)).length);
});

test("the delivered packet records its Fact status and removed units; the generation contract is unchanged", () => {
  const packet = packetBase();
  assert.equal(packet.fact.ai_status, "passed");
  assert.equal(packet.fact.removed_units, undefined, "nothing removed, no field");
  const two = delivered();
  two.x_post.points_ja = two.x_post.points_ja.slice(0, 2);
  assert.ok(localAnalysisCheck(two, input).hard.includes("X_POST_POINTS_INVALID"), "a generation still owes three points");
  assert.deepEqual(localAnalysisCheck(two, input, { delivery: true }).hard, [], "a delivery may carry fewer");
});
