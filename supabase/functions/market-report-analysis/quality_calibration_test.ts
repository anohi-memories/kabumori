// Quality-rewrite calibration (2026-10-02 morning, the first completed live presentation-v2 packet).
// The delivered draft was fact-safe and complete, yet the run spent a third model call on a quality
// rewrite because of (a) a news-priority warning that fired on a broad-first paragraph that named a
// company last, and (b) an app story 54 characters under the preferred 900. Neither is worth a
// generation. Hard-fact behaviour is not touched here.
// Inputs: the real 10/2 morning packets (fixtures/morning_2026-10-02_*).
import assert from "node:assert/strict";
import test from "node:test";
import { formatSharedXPost, type MarketReportPacket, sharedXPostWarnings } from "../_shared/market_report_packet.ts";
import { buildAppMarketStory } from "../_shared/market_report_story.ts";
import {
  APP_STORY_REWRITE_BELOW_CHARS,
  assemblePacket,
  editorialPriorityWarnings,
  type GeneratedAnalysis,
  generateSharedAnalysis,
  localAnalysisCheck,
  MAX_GENERATIONS,
  qualityRewriteHints,
  type Requester,
} from "./analysis_logic.ts";
import { inputOf, loadFixture } from "./test_support.ts";

const morning1002 = await loadFixture("morning_2026-10-02");
const input = inputOf(morning1002);
const delivered: MarketReportPacket = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/morning_2026-10-02_generated_report.json", import.meta.url)),
).payload;
const NOW = () => new Date("2026-10-01T23:05:30Z");
const LEADS = "X本文が個別企業の開示を市場全体のニュースより前に扱っている";
const ONLY = "X本文が個別企業の開示だけを扱い、市場全体のニュースに触れていない";
const NO_BROAD_KEY_NEWS = "市場全体のニュースが key_news に無い";
const has = (issues: string[], fragment: string) => issues.some((issue) => issue.includes(fragment));

/** The generation that was delivered at 08:05 on 2026-10-02, as the model returned it. */
function live(mutate: (analysis: GeneratedAnalysis) => void = () => {}): GeneratedAnalysis {
  const p = structuredClone(delivered);
  const analysis: GeneratedAnalysis = {
    headline_ja: p.headline_ja, market_summary_ja: p.market_summary_ja, claims: p.claims,
    key_news: p.key_news.map((news) => ({ ref: news.ref_id, why_it_matters_ja: news.why_it_matters_ja })),
    strong_themes: p.strong_themes, weak_themes: p.weak_themes, next_watch_ja: p.next_watch_ja, risks_ja: p.risks_ja,
    x_post: p.x_post, app_story: p.app_story,
  };
  mutate(analysis);
  return analysis;
}
const narrative = (analysis: GeneratedAnalysis) =>
  buildAppMarketStory(assemblePacket(input, analysis, { generatedAt: NOW(), attempts: 1 })).char_count;

function requester(steps: Array<{ step: "generate" | "fact"; payload?: unknown; fail?: boolean }>, calls: string[] = []): Requester {
  return (step) => {
    calls.push(step);
    const next = steps.shift();
    assert.ok(next, `unexpected ${step} call`);
    assert.equal(next.step, step);
    if (next.fail) return Promise.reject(new Error("ANALYSIS_OPENAI_GENERATE_FAILED:503"));
    return Promise.resolve({ payload: next.payload, inputTokens: 1000, outputTokens: 400 });
  };
}
const PASSED = { step: "fact" as const, payload: { passed: true, issues: [] } };

// ---------------------------------------------------------------------------------------------
// The exact 10/2 packet
// ---------------------------------------------------------------------------------------------

test("10/2 live draft: the broad-first paragraph no longer warns, and 846 characters is recorded without a rewrite", () => {
  assert.equal(delivered.presentation_version, "market_presentation.v2");
  assert.deepEqual(delivered.key_news.map((news) => news.scope), ["broad", "broad", "broad", "company"]);
  assert.ok(delivered.x_post.news_ja!.startsWith("市場全体では、イエメンで") && delivered.x_post.news_ja!.includes("ニデック"));
  const check = localAnalysisCheck(live(), input);
  assert.deepEqual(check.hard, []);
  // The live points were three metric lines (the shape the editorial points replace): recorded, not paid for.
  assert.deepEqual(check.warnings, ["X_POINTS_METRIC_RECAP:3", "APP_STORY_SHORTER_THAN_TARGET:846"], "length and points stay as telemetry");
  assert.deepEqual(qualityRewriteHints(check.warnings), [], "nothing worth a generation");
  assert.deepEqual(editorialPriorityWarnings(live(), input), []);
});

test("10/2 live draft: delivered in one generation and one Fact call (was three calls)", async () => {
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([{ step: "generate", payload: live() }, PASSED], calls), NOW);
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, ["generate", "fact"]);
  assert.deepEqual([outcome.trace.qualityRewrite, outcome.trace.deliveredGeneration, outcome.trace.generations], [false, 1, 1]);
  assert.deepEqual(outcome.ok && outcome.packet.fact.quality_warnings, ["X_POINTS_METRIC_RECAP:3", "APP_STORY_SHORTER_THAN_TARGET:846"]);
});

test("the 486-character X body is inside the target: no length warning", () => {
  const packet = assemblePacket(input, live(), { generatedAt: NOW(), attempts: 1 });
  const post = formatSharedXPost(packet);
  assert.equal(Array.from(post).length, 486);
  assert.deepEqual(sharedXPostWarnings(packet, post), []);
});

// ---------------------------------------------------------------------------------------------
// A. news priority is an ordering rule
// ---------------------------------------------------------------------------------------------

test("priority: broad first and a company later, broad only, or no company at all do not warn", () => {
  const cases: Array<[string, (analysis: GeneratedAnalysis) => void]> = [
    ["exact 10/2 paragraph", () => {}],
    ["broad only", (a) => { a.x_post.news_ja = "イエメンで政府軍とフーシ派の戦闘が続いていることや、エチオピアの首都での爆発が報じられました。"; }],
    ["broad paragraph, then company detail", (a) => {
      a.x_post.news_ja = "ロシア側がカリーニングラードへの攻撃に警告したと報じられました。イエメンでも戦闘が続いています。個別では、オムロンが事業譲渡の完了を、ニデックが過年度決算の修正を公表しました。";
    }],
    ["a company in the 3 points while the news paragraph leads with broad items", (a) => { a.x_post.points_ja[2] = "ニデックが過年度決算の修正を公表"; }],
  ];
  for (const [label, mutate] of cases) {
    const analysis = live(mutate);
    assert.deepEqual(editorialPriorityWarnings(analysis, input), [], label);
    assert.deepEqual(localAnalysisCheck(analysis, input).hard, [], label);
  }
});

test("priority: a company disclosure ahead of available broad news, or instead of it, warns (never a hard failure)", () => {
  const first = live((a) => { a.x_post.news_ja = "ニデックの過年度決算修正が公表されました。イエメンでは政府軍とフーシ派の戦闘が続いていると報じられています。"; });
  assert.deepEqual(editorialPriorityWarnings(first, input), [LEADS]);
  const lead = live((a) => { a.x_post.lead_ja = "ニデックが過年度決算の修正を公表。10月1日の日本株は上昇しました📈"; });
  assert.deepEqual(editorialPriorityWarnings(lead, input), [LEADS], "the lead comes before the news paragraph");
  const only = live((a) => { a.x_post.news_ja = "ニデックが過年度決算の修正を公表し、オムロンは事業譲渡の完了を発表しました。"; });
  assert.deepEqual(editorialPriorityWarnings(only, input), [ONLY]);
  const noParagraph = live((a) => { a.x_post.news_ja = ""; a.x_post.points_ja[2] = "ニデックが過年度決算の修正を公表"; });
  assert.deepEqual(editorialPriorityWarnings(noParagraph, input), [ONLY], "no news paragraph: the digest itself is company-only");
  const keyNews = live((a) => { a.key_news = a.key_news.filter((news) => input.scopeByRef.get(news.ref) !== "broad"); });
  assert.ok(has(editorialPriorityWarnings(keyNews, input), NO_BROAD_KEY_NEWS));
  for (const analysis of [first, lead, only, noParagraph, keyNews]) {
    const check = localAnalysisCheck(analysis, input);
    assert.deepEqual(check.hard, [], "an editorial warning is never a hard failure");
    assert.ok(qualityRewriteHints(check.warnings).length > 0, "a real ordering problem is still worth one rewrite");
  }
});

test("priority: with no broad news in the input there is nothing to put first", () => {
  const companyOnly = inputOf(morning1002, { news: morning1002.news.filter((row) => row.company_code) });
  assert.ok(companyOnly.news.every((item) => item.scope === "company"));
  const analysis = live((a) => {
    a.key_news = a.key_news.filter((news) => companyOnly.newsRefs.has(news.ref));
    a.x_post.news_ja = "ニデックが過年度決算の修正を公表しました。";
  });
  assert.deepEqual(editorialPriorityWarnings(analysis, companyOnly), []);
});

// ---------------------------------------------------------------------------------------------
// B. app length: telemetry below 900, a rewrite only when materially thin
// ---------------------------------------------------------------------------------------------

test("app length: a complete story modestly under 900 is a warning only", () => {
  assert.equal(APP_STORY_REWRITE_BELOW_CHARS, 700);
  for (const analysis of [
    live(),
    // every section still present, shorter prose
    live((a) => { a.app_story!.caution_ja = "日本国債の利回りは8月31日時点の値です。"; a.app_story!.strong_ja = ""; }),
  ]) {
    const length = narrative(analysis);
    assert.ok(length >= APP_STORY_REWRITE_BELOW_CHARS && length < 900, `narrative ${length}`);
    const check = localAnalysisCheck(analysis, input);
    assert.deepEqual(check.warnings, ["X_POINTS_METRIC_RECAP:3", `APP_STORY_SHORTER_THAN_TARGET:${length}`]);
    assert.deepEqual(qualityRewriteHints(check.warnings), []);
  }
});

test("app length: a materially thin story asks for one rewrite, inside the unchanged call budget", async () => {
  assert.equal(MAX_GENERATIONS, 2);
  const thin = live((a) => {
    a.app_story = { ...a.app_story!, overseas_ja: "", japan_ja: "", cross_asset_ja: "", news_ja: "", strong_ja: "", caution_ja: "", watch_ja: "" };
  });
  const length = narrative(thin);
  assert.ok(length < APP_STORY_REWRITE_BELOW_CHARS, `narrative ${length}`);
  const check = localAnalysisCheck(thin, input);
  assert.deepEqual(check.hard, []);
  assert.ok(has(check.warnings, `APP_STORY_SHORTER_THAN_TARGET:${length}`));
  assert.ok(has(qualityRewriteHints(check.warnings), "app_story が短い"));
  // One rewrite, and the better draft is delivered.
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: thin }, PASSED, { step: "generate", payload: live() }, PASSED,
  ], calls), NOW);
  assert.deepEqual(calls, ["generate", "fact", "generate", "fact"]);
  assert.deepEqual([outcome.ok, outcome.trace.qualityRewrite, outcome.trace.deliveredGeneration], [true, true, 2]);
  // The length just under the threshold rewrites, the length on it does not: the policy is a band, not one number.
  assert.ok(has(qualityRewriteHints([`APP_STORY_SHORTER_THAN_TARGET:${APP_STORY_REWRITE_BELOW_CHARS - 1}`]), "app_story が短い"));
  assert.deepEqual(qualityRewriteHints([`APP_STORY_SHORTER_THAN_TARGET:${APP_STORY_REWRITE_BELOW_CHARS}`, "APP_STORY_SHORTER_THAN_TARGET:899"]), []);
});

// ---------------------------------------------------------------------------------------------
// C. the safe original is never lost
// ---------------------------------------------------------------------------------------------

test("fallback: a thin but safe draft survives a rewrite that breaks a hard fact, and a rewrite request that fails", async () => {
  const thin = live((a) => {
    a.app_story = { ...a.app_story!, overseas_ja: "", japan_ja: "", cross_asset_ja: "", news_ja: "", strong_ja: "", caution_ja: "", watch_ja: "" };
  });
  const broken = live((a) => { a.x_post.lead_ja = "10月1日は日経平均もTOPIXも上昇しました📈"; });
  assert.ok(has(localAnalysisCheck(broken, input).hard, "TOPIX連動ETF（1306）をTOPIXと表記"), "hard-fact guards are unchanged");

  const hardRewrite: string[] = [];
  const first = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: thin }, PASSED, { step: "generate", payload: broken },
  ], hardRewrite), NOW);
  assert.deepEqual(hardRewrite, ["generate", "fact", "generate"]);
  assert.deepEqual([first.ok, first.trace.deliveredGeneration, first.trace.hardRejections, first.trace.qualityRewrite], [true, 1, ["local"], true]);

  const failedRequest: string[] = [];
  const second = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: thin }, PASSED, { step: "generate", fail: true },
  ], failedRequest), NOW);
  assert.deepEqual([second.ok, second.trace.deliveredGeneration, second.trace.rewriteRequestFailed], [true, 1, true]);

  // A hard-fact failure with no safe draft still fails closed, and transport stays a separate matter.
  const closed = await generateSharedAnalysis(input, requester([{ step: "generate", payload: broken }, { step: "generate", payload: broken }]), NOW);
  assert.deepEqual([closed.ok, !closed.ok && closed.error], [false, "ANALYSIS_LOCAL_CHECK_FAILED"]);
});
