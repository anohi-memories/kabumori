import assert from "node:assert/strict";
import test from "node:test";
import { falseAbsenceClaims } from "../_shared/absence_claims.ts";
import { generateSharedAnalysis, localAnalysisCheck, parseGeneratedAnalysis, type Requester } from "./analysis_logic.ts";
import { emojiDirectionIssues, metricFactIssues } from "./hard_fact_guards.ts";
import { openAiRequester } from "./handler.ts";
import { newTransportStats } from "./transport_retry.ts";
import { inputOf, loadFixture, richMorning1001 } from "./test_support.ts";

const fixture = await loadFixture("morning_2026-10-01");
const input = inputOf(fixture);
const now = () => new Date("2026-10-01T00:00:00Z");
const factIssues = (text: string) => metricFactIssues({ factual: [text], forward: [] }, input);

test("H1: value and change are not interchangeable even for the same metric", () => {
  for (const text of ["9月30日の日経平均の終値は1.94円でした。", "9月30日の日経平均の前日比は+66,753.72%でした。"]) {
    assert.ok(factIssues(text).length > 0, text);
  }
  assert.deepEqual(factIssues("9月30日の日経平均は66,753.72（前日比+1.94%）でした。"), []);
});

test("H1: a list cannot borrow one member's date, sign or number for every member", () => {
  const mixed = structuredClone(input);
  Object.assign(mixed.metricFacts.find((fact) => fact.key === "nikkei225")!, {
    sessionDate: "2026-09-29", dateJa: "9月29日", valueDisplay: "65,481.27", changeDisplay: "−0.60%", changeSign: -1, freshness: "stale",
  });
  for (const text of [
    "9月30日の日経平均とTOPIX連動ETF（1306）はそれぞれ65,481.27と431.5円でした。",
    "9月30日のNYダウとナスダック総合はそろって上昇しました。",
    "9月30日のNYダウとS&P500はそれぞれ+0.86%と+0.20%でした。",
  ]) {
    const checked = text.includes("65,481") ? mixed : input;
    assert.ok(metricFactIssues({ factual: [text], forward: [] }, checked).length > 0, text);
  }
  assert.deepEqual(factIssues("9月30日の米国株はまちまちでした。"), []);
});

test("H1: a correct date does not license describing stale data as the latest/current value", () => {
  assert.ok(factIssues("最新の日本国債10年利回りは8月31日時点で2.943%です。").length > 0);
  assert.deepEqual(factIssues("日本国債10年利回りは8月31日時点で2.943%です。最新の値は確認できません。"), []);
  assert.deepEqual(factIssues("最新のニュースとは別に、日本国債10年利回りは8月31日時点で2.943%です。"), []);
  assert.deepEqual(factIssues("日本国債10年利回りは8月31日時点で2.943%、最新の水準は確認できません。"), []);
});

test("H1: mixed-direction emoji are bound to their own clauses", () => {
  assert.ok(emojiDirectionIssues(["NYダウは下落📈、ナスダック総合は上昇📉"], input).length > 0);
  assert.deepEqual(emojiDirectionIssues(["NYダウは下落📉、ナスダック総合は上昇📈"], input), []);
});

test("H1: negated or hypothetical moves do not become a false direction assertion", () => {
  for (const text of ["NYダウは上昇していません。", "日経平均は下落しませんでした。", "日経平均が下落するかどうかを確認します。"]) {
    assert.deepEqual(factIssues(text), [], text);
  }
  assert.deepEqual(factIssues("9月30日の日経平均とTOPIX連動ETF（1306）はそれぞれ66,753.72（+1.94%）と431.5円（+1.43%）でした。"), []);
});

test("H1: a factual past-tense statement in the watch/caution fields still needs fact guards", () => {
  const draft = richMorning1001(input);
  draft.app_story!.caution_ja = "9月30日のNYダウは上昇しました。";
  assert.ok(localAnalysisCheck(draft, input).hard.some((issue) => issue.includes("方向の逆転")));
  draft.app_story!.caution_ja = "9月30日の東京市場は米国株高を受けて上昇しました。";
  assert.ok(localAnalysisCheck(draft, input).hard.some((issue) => issue.includes("因果の断定")));
});

test("H1: scoped no-news statements do not become a broad-absence block", () => {
  for (const text of ["この銘柄には材料がありません。", "この保有銘柄については個別ニュースがありません。", "日銀についてはニュースがありません。"]) {
    assert.deepEqual(falseAbsenceClaims([text], true), [], text);
  }
  assert.ok(falseAbsenceClaims(["ニュースはありません。"], true).length > 0);
  assert.ok(falseAbsenceClaims(["日銀についてはニュースがありません、材料はありません。"], true).length > 0);
  assert.ok(falseAbsenceClaims(["入力についてはニュースがありません。"], true).length > 0);
});

test("H1: malformed nested model output is classified as invalid, not an uncaught exception", () => {
  const draft = richMorning1001(input);
  for (const field of ["claims", "key_news", "strong_themes"]) {
    assert.equal(parseGeneratedAnalysis({ ...draft, [field]: [null] }), null, field);
  }
});

test("H1: the actual model input keeps broad news before an emergency sector item", () => {
  const rows = structuredClone(fixture.news).slice(0, 2);
  Object.assign(rows[0], { company_code: null, coverage_categories: ["regulation_policy"], coverage_severity: "medium" });
  Object.assign(rows[1], { company_code: null, coverage_categories: ["ai_tech"], coverage_severity: "emergency" });
  const narrowed = inputOf(fixture, { news: rows });
  assert.deepEqual(narrowed.news.map((news) => news.scope), ["broad", "sector"]);
  assert.deepEqual((narrowed.modelInput.ニュース as Array<{ 範囲: string }>).map((news) => news.範囲), ["市場全体", "業種・テーマ"]);
});

test("H1: Fact rejection of a quality rewrite delivers the original safe draft", async () => {
  const thin = richMorning1001(input);
  thin.x_post.context_ja = "";
  const steps = [thin, { passed: true }, richMorning1001(input), { passed: false, issues: ["rewrite fact failed"] }];
  const calls: string[] = [];
  const request: Requester = (step) => {
    calls.push(step);
    return Promise.resolve({ payload: steps.shift(), inputTokens: 1000, outputTokens: 400 });
  };
  const outcome = await generateSharedAnalysis(input, request, now);
  assert.equal(outcome.ok, true);
  assert.deepEqual([outcome.trace.deliveredGeneration, outcome.trace.hardRejections], [1, ["fact"]]);
  assert.deepEqual(calls, ["generate", "fact", "generate", "fact"]);
});

for (const failureStep of ["generate", "fact"] as const) {
  test(`H1: exhausted 429 during quality ${failureStep} preserves the Fact-passed original`, async () => {
    const thin = richMorning1001(input);
    thin.x_post.context_ja = "";
    let attempts = 0;
    const stats = newTransportStats();
    const waits: number[] = [];
    const request = openAiRequester("test-key", (_url, init) => {
      attempts += 1;
      const step = String(JSON.parse(String(init?.body)).instructions).includes("Factチェッカー") ? "fact" : "generate";
      if (attempts > 2 && step === failureStep) return Promise.resolve(new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 }));
      const payload = step === "fact" ? { passed: true } : attempts === 1 ? thin : richMorning1001(input);
      return Promise.resolve(new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }], usage: { input_tokens: 1000, output_tokens: 400 } })));
    }, { stats, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } });
    const outcome = await generateSharedAnalysis(input, request, now);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.trace.deliveredGeneration, 1);
    assert.equal(outcome.trace.rewriteRequestFailed, true);
    assert.equal(stats.retries, 2);
    assert.equal(stats.exhausted, true);
    assert.equal(attempts, failureStep === "generate" ? 5 : 6);
    assert.equal(waits.length, 2);
  });
}

test("H1: malformed first draft regenerates, but no safe original means transport failure stays closed", async () => {
  const steps = [{ ...richMorning1001(input), claims: [null] }, richMorning1001(input), { passed: true }];
  const request: Requester = () => Promise.resolve({ payload: steps.shift(), inputTokens: 1000, outputTokens: 400 });
  const outcome = await generateSharedAnalysis(input, request, now);
  assert.equal(outcome.ok, true);
  assert.deepEqual([outcome.trace.generations, outcome.trace.hardRejections], [2, ["invalid_output"]]);
  await assert.rejects(generateSharedAnalysis(input, () => Promise.reject(new Error("ANALYSIS_OPENAI_GENERATE_FAILED:429")), now));
});
