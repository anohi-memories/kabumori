// Session-date guard calibration (2026-10-02 07:55). The first natural morning run was rejected with
//   日付と指標の不一致（NYダウ・S&P500・ナスダック総合は10月1日の値、本文は10月2日）
// for sentences such as 「10月2日は、米国株高や半導体株高が日本株でどう表れるかを見ます」. There 「10月2日」
// dates today's watch and 「米国株高」 refers to the 10/1 US session that is already known; the sentence
// does not say that US stocks rose on 10/2. A date attached to a value, to a change, or to a statement
// that a session moved stays a hard reject.
// Input: the real 10/2 morning packets (US session 10/1, Tokyo previous session 10/1).
import assert from "node:assert/strict";
import test from "node:test";
import type { MarketDataPacket } from "../market-report-data-packet/packet_schema.ts";
import type { MarketReportPacket } from "../_shared/market_report_packet.ts";
import { type GeneratedAnalysis, generateSharedAnalysis, localAnalysisCheck, MAX_GENERATIONS, type Requester } from "./analysis_logic.ts";
import { metricFactIssues } from "./hard_fact_guards.ts";
import { inputOf, loadFixture, richMorning1001 } from "./test_support.ts";

const morning1002 = await loadFixture("morning_2026-10-02");
const morning1001 = await loadFixture("morning_2026-10-01");
const input = inputOf(morning1002);
const delivered: MarketReportPacket = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/morning_2026-10-02_generated_report.json", import.meta.url)),
).payload;
const DATE_ISSUE = "日付と指標の不一致";
const US_ON_1002 = "日付と指標の不一致（NYダウ・S&P500・ナスダック総合は10月1日の値、本文は10月2日）";
const has = (issues: string[], fragment: string) => issues.some((issue) => issue.includes(fragment));
const factual = (sentence: string) => metricFactIssues({ factual: [`${sentence}。`], forward: [] }, input);

/** The generation delivered at 08:05 on 2026-10-02 (hard-fact safe). */
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
/** The same sentence in each factual presentation field. */
const FIELDS: Array<[string, (analysis: GeneratedAnalysis, sentence: string) => void]> = [
  ["market_summary_ja", (a, s) => { a.market_summary_ja = `10月1日の東京市場は上昇しました。${s}。`; }],
  ["x_post.context_ja", (a, s) => { a.x_post.context_ja = `10月1日の東京市場では日経平均が上昇しました。${s}。`; }],
  ["x_post.closing_ja", (a, s) => { a.x_post.closing_ja = `${s}。`; }],
  ["app_story.summary_ja", (a, s) => { a.app_story!.summary_ja = `10月1日の東京市場は上昇しました。${s}。`; }],
  ["app_story.japan_ja", (a, s) => { a.app_story!.japan_ja = `${a.app_story!.japan_ja}${s}。`; }],
  ["claim (observation)", (a, s) => { a.claims[0] = { ...a.claims[0], text_ja: `${s}。` }; }],
];

test("the 10/2 input: the US session is 10/1 and the report date is 10/2", () => {
  assert.equal(input.tradingDate, "2026-10-02");
  const us = input.metricFacts.filter((fact) => ["dow", "sp500", "nasdaq_composite"].includes(fact.key));
  assert.deepEqual(us.map((fact) => [fact.dateJa, fact.valueDisplay]), [["10月1日", "50,926.56"], ["10月1日", "7,666.45"], ["10月1日", "26,871.60"]]);
  assert.deepEqual(localAnalysisCheck(live(), input).hard, [], "the delivered draft is hard-fact safe");
});

// ---------------------------------------------------------------------------------------------
// Must PASS: today's date frames a watch; the US move is referred to, not asserted for today
// ---------------------------------------------------------------------------------------------

const WATCH_FRAMES = [
  // the three sentence shapes rejected at 07:55
  "10月2日は、米国株高や半導体株高が日本株でどう表れるかを見ます",
  "10月2日は、米国株高や半導体株高の受け止め方を確認する一日です",
  "東京市場との関係は確認できないため、10月2日は米国株高や半導体株高が日本株でどう表れるかを見ます",
  // further shapes named in the task
  "10月2日は、米国株高を踏まえ、日本株の反応を確認します",
  "10月2日は、前夜の米国株高が日本株にどう波及するかではなく、実際の値動きを確認します",
  // the move as a noun with other wording
  "10月2日は、米国株の上昇が日本株でどう受け止められるかに注目です",
  "10月2日は、米国市場の上昇を受けた動きが続くかを確認します",
  "10月2日は、米国株高が日本株に波及するかどうかを見ます",
  "10月2日は、米国株高の影響を確認します",
  "10月2日は、米国株高を踏まえて日本株の反応を見ます",
];

test("PASS: today's date + a referred-to US move in a watch sentence is not a date mismatch", () => {
  for (const sentence of WATCH_FRAMES) assert.deepEqual(factual(sentence), [], sentence);
});

test("PASS: the same sentences in the summary, X context, X closing and app prose (not only watch fields)", () => {
  for (const sentence of WATCH_FRAMES.slice(0, 5)) {
    for (const [field, place] of FIELDS) {
      const issues = localAnalysisCheck(live((analysis) => place(analysis, sentence)), input).hard;
      assert.ok(!has(issues, DATE_ISSUE), `${field}: ${sentence} → ${issues.join(" / ")}`);
    }
  }
});

test("PASS: each market under its own date, and a watch sentence beside a correctly dated US value", () => {
  for (const sentence of [
    "10月2日は、10月1日の米国株高が日本株でどう表れるかを見ます",
    "10月2日は、10月1日のNYダウ50,926.56（前日比+0.04%）を踏まえ、米国株高が日本株でどう表れるかを見ます",
    "10月1日の東京市場は日経平均が68,956.72（前日比+3.30%）と上昇し、10月1日の米国市場もS&P500が7,666.45（前日比+0.19%）と上昇しました",
    "10月1日のNYダウは50,926.56（前日比+0.04%）でした",
    "10月1日の米国株は上昇しました",
  ]) {
    assert.deepEqual(factual(sentence), [], sentence);
  }
  // Two sentences in one field: the watch sentence, then the dated value.
  assert.deepEqual(metricFactIssues({
    factual: ["10月2日は、米国株高が日本株でどう表れるかを見ます。10月1日のS&P500は7,666.45（前日比+0.19%）でした。"], forward: [],
  }, input), []);
});

// ---------------------------------------------------------------------------------------------
// Must FAIL: the date is attached to a session's move or to a value
// ---------------------------------------------------------------------------------------------

test("FAIL: saying the US session moved on 10/2 stays a hard reject", () => {
  for (const sentence of [
    "10月2日の米国株は上昇しました",
    "10月2日は米国株が上昇しました",
    "10月2日は米国株高でした",
    "10月2日は、米国株が上昇しました",
    "10月2日の米国市場は上昇",
    "10月2日は米国株高",
    // the date sits on the move itself, even inside a watch sentence
    "10月2日の米国株高が日本株でどう表れるかを見ます",
    // a completed statement followed by a watch
    "10月2日は米国株が上昇し、日本株の反応を確認します",
    // a referred-to move without any watch frame
    "10月2日は、米国株高が日本株を押し上げました",
    // watch-like words in the past, or the move stated before the watch
    "10月2日は、米国株の上昇を確認しました",
    "10月2日は、米国株高となり、日本株の反応を確認します",
    "10月2日は、米国株も上昇したことを確認します",
    "10月2日は、米国株が上昇した流れを確認します",
    // another date as the topic is not today's watch
    "9月30日は、米国株高が日本株でどう表れるかを見ます",
  ]) {
    assert.ok(has(factual(sentence), "日付と指標の不一致（NYダウ・S&P500・ナスダック総合は10月1日の値"), `accepted: ${sentence} → ${factual(sentence).join(" / ")}`);
  }
});

// K2 on PR #79 (head a70dfdd): the watch test was sentence-wide, so a watch phrase later in the sentence
// excused an earlier statement that the US move is happening or continuing on 10/2.
const ASSERTION_BEFORE_WATCH = [
  "10月2日は、米国株高が続き、日本株の反応を確認します",
  "10月2日は、米国株高が確認され、日本株の反応を確認します",
  "10月2日は、米国株高が鮮明となり、日本株の反応に注目です",
  "10月2日は、米国株高が一段と強まり、日本株の反応を見ます",
  "10月2日は、米国株高が継続し、日本株を見る一日です",
  "10月2日は、米国株高が続いています。日本株の反応を確認します",
  // the same pattern with 「米国市場の上昇」
  "10月2日は、米国市場の上昇が続き、日本株の反応を確認します",
  "10月2日は、米国市場の上昇が確認され、日本株の反応を確認します",
  "10月2日は、米国市場の上昇が鮮明となり、日本株の反応に注目です",
  "10月2日は、米国市場の上昇が一段と強まり、日本株の反応を見ます",
  // further shapes: the statement sits between the move and a real watch question
  "10月2日は、米国株高が続き、日本株でどう表れるかを見ます",
  "10月2日は、米国株高が進んだ東京市場でどう表れるかを見ます",
  "10月2日は、米国株高を踏まえ、買いが先行し、日本株の反応を確認します",
  "10月2日は、米国株高の受け止め方が分かれました",
  "10月2日は、米国株高の流れが続き、日本株の反応を確認します",
  // the same statements without a comma
  "10月2日は、米国株高が続き日本株でどう表れるかを見ます",
  "10月2日は、米国株高が鮮明となり日本株でどう表れるかを見ます",
  "10月2日は、米国株高が強まり日本株に波及するかどうかを見ます",
  "10月2日は、米国株高の影響が続き日本株の反応を確認します",
  "10月2日は、米国株高を踏まえ、買いが先行し日本株の反応を確認します",
  "10月2日は、米国株高を受けた買いが先行し、日本株の反応を確認します",
];

test("FAIL: a statement that the US move continues on 10/2 is not excused by a watch phrase later in the sentence", () => {
  for (const sentence of ASSERTION_BEFORE_WATCH) {
    const issues = metricFactIssues({ factual: [`${sentence}。`], forward: [] }, input);
    assert.ok(has(issues, "日付と指標の不一致（NYダウ・S&P500・ナスダック総合は10月1日の値"), `accepted: ${sentence} → ${issues.join(" / ")}`);
  }
  for (const [field, place] of FIELDS) {
    const issues = localAnalysisCheck(live((analysis) => place(analysis, ASSERTION_BEFORE_WATCH[0])), input).hard;
    assert.ok(has(issues, US_ON_1002), `${field} accepted an assertion before a watch phrase`);
  }
});

test("FAIL: a value or change under the wrong date stays a hard reject, watch wording or not", () => {
  for (const sentence of [
    "10月2日のNYダウは50,926.56でした",
    "10月2日はNYダウ50,926.56、S&P500 7,666.45でした",
    "10月2日は、NYダウ50,926.56の水準が日本株でどう表れるかを見ます",
    "10月2日は、S&P500の+0.19%が日本株でどう表れるかを見ます",
    "10月2日の日経平均は68,956.72（前日比+3.30%）でした",
    "10月2日は、日経平均68,956.72からの動きを確認します",
  ]) {
    assert.ok(has(factual(sentence), DATE_ISSUE), `accepted: ${sentence} → ${factual(sentence).join(" / ")}`);
  }
  for (const [field, place] of FIELDS) {
    const issues = localAnalysisCheck(live((analysis) => place(analysis, "10月2日の米国株は上昇しました")), input).hard;
    assert.ok(has(issues, US_ON_1002), `${field} accepted a 10/2 US session`);
  }
});

test("FAIL: the 10/1 mixed-session wording (9/29 Nikkei shown under 9月30日) stays a hard reject", () => {
  const payload: MarketDataPacket = structuredClone(morning1001.data.payload);
  Object.assign(payload.metrics.find((metric) => metric.key === "nikkei225")!, {
    session_date: "2026-09-29", value: 65481.2695, previous_close: 65877.6172, change: -396.3477, change_pct: -0.6, freshness: "stale",
  });
  const mixed = inputOf(morning1001, { payload });
  for (const sentence of [
    "9月30日は日経平均65,481.27（-0.60%）、1306は431.5（+1.43%）でした。",
    "9月30日（水）は日経平均が65,481.27で-0.60%、TOPIX連動ETF（1306）が431.5で+1.43%と、入力された指数の動きは分かれました。",
    // watch wording does not excuse a value
    "10月1日は、日経平均65,481.27からの動きを確認します。",
  ]) {
    const issues = metricFactIssues({ factual: [sentence], forward: [] }, mixed);
    assert.ok(has(issues, "日付と指標の不一致（日経平均は9月29日の値"), `${sentence} → ${issues.join(" / ")}`);
  }
  const analysis = richMorning1001(mixed);
  analysis.market_summary_ja = "9月30日は日経平均65,481.27（-0.60%）、1306は431.5（+1.43%）でした。";
  assert.ok(has(localAnalysisCheck(analysis, mixed).hard, "日付と指標の不一致（日経平均は9月29日の値、本文は9月30日）"));
});

test("FAIL: the other hard guards are untouched (direction, stale, 1306, emoji, causality, refs)", () => {
  const cases: Array<[string, (analysis: GeneratedAnalysis) => void]> = [
    // a referred-to move must still be the move that happened
    ["方向の逆転", (a) => { a.x_post.closing_ja = "10月2日は、米国株安が日本株でどう表れるかを見ます。"; }],
    ["方向の逆転", (a) => { a.x_post.closing_ja = "10月1日の日経平均は下落しました。"; }],
    ["古い値を日付なしで記載", (a) => { a.app_story!.cross_asset_ja = "日本国債10年利回りは2.943%です。"; }],
    ["古い値を現在・最新として記載", (a) => { a.app_story!.cross_asset_ja = "現在の日本国債10年利回りは8月31日時点で2.943%です。"; }],
    ["TOPIX連動ETF（1306）をTOPIXと表記", (a) => { a.x_post.lead_ja = "10月1日は日経平均もTOPIXも上昇しました📈"; }],
    ["絵文字の向きがデータと逆", (a) => { a.x_post.points_ja[0] = "日経平均は68,956.72（前日比+3.30%）でした📉"; }],
    ["根拠の無い因果の断定", (a) => { a.x_post.closing_ja = "10月2日は、米国株高を受けて東京市場も上昇しました。"; }],
    ["入力に無い ref", (a) => { a.claims[0] = { ...a.claims[0], evidence_refs: ["news:00000000-0000-4000-8000-000000000000"] }; }],
  ];
  for (const [expected, mutate] of cases) {
    const issues = localAnalysisCheck(live(mutate), input).hard;
    assert.ok(has(issues, expected), `${expected} not detected: ${issues.join(" / ")}`);
  }
});

// ---------------------------------------------------------------------------------------------
// The 07:55 run replayed
// ---------------------------------------------------------------------------------------------

test("replay 07:55: the rejected draft now reaches Fact in one generation; the call budget is unchanged", async () => {
  assert.equal(MAX_GENERATIONS, 2);
  const draft = live((analysis) => {
    analysis.x_post.closing_ja = "10月2日は、米国株高や半導体株高が日本株でどう表れるかを見ます。";
    analysis.app_story!.summary_ja = "10月1日の東京市場は上昇しました。10月2日は、米国株高や半導体株高の受け止め方を確認する一日です。";
  });
  assert.deepEqual(localAnalysisCheck(draft, input).hard, []);
  const calls: string[] = [];
  const request: Requester = (step) => {
    calls.push(step);
    return Promise.resolve({ payload: step === "fact" ? { passed: true, issues: [] } : draft, inputTokens: 1000, outputTokens: 400 });
  };
  const outcome = await generateSharedAnalysis(input, request, () => new Date("2026-10-01T22:55:30Z"));
  assert.equal(outcome.ok, true);
  assert.deepEqual([calls, outcome.trace.hardRejections, outcome.trace.deliveredGeneration], [["generate", "fact"], [], 1]);
});

// ---------------------------------------------------------------------------------------------
// H1 on PR #79 (head 9ce344b): a question later in the clause must not cancel a move stated before it;
// ordinary prior-night watch wording must not be read as today's US session.
// ---------------------------------------------------------------------------------------------

const STATED_THEN_ASKED = [
  "10月2日の米国株は下落しており次も続くかを見ます",
  "10月2日は、米国株高が強まり波及するかどうかを見ます",
  "10月2日は、米国株高が鮮明となり波及するかどうかを見ます",
  "10月2日は、米国株高が継続し波及するかどうかを見ます",
  "10月2日は、米国株が上昇しており、さらに上昇するかを見ます",
];

test("P1: a move stated before a question or condition is still dated and directed, in all six placements", () => {
  for (const sentence of STATED_THEN_ASKED) {
    assert.ok(has(factual(sentence), "日付と指標の不一致（NYダウ・S&P500・ナスダック総合は10月1日の値"), `accepted: ${sentence}`);
    for (const [field, place] of FIELDS) {
      const issues = localAnalysisCheck(live((analysis) => place(analysis, sentence)), input).hard;
      assert.ok(has(issues, DATE_ISSUE), `${field}: ${sentence} → ${issues.join(" / ")}`);
    }
  }
  // The stated move is also checked against the session's direction (S&P500 was +0.19% on 10/1).
  assert.ok(has(factual(STATED_THEN_ASKED[0]), "方向の逆転"), "a stated fall before the question is an inversion");
});

test("P1: a move that is itself the question or the condition is not a statement, so neither date nor direction is judged", () => {
  for (const sentence of [
    "10月2日は、米国株高が強まるかどうかを見ます",
    "10月2日は、米国株が上昇すれば、日本株の反応を見ます",
    "10月2日は、米国株が上昇すれば買いを検討します",
    "10月2日は、米国株安が続くかを見ます",
    "10月2日は、米国株安が続くかを確認します",
    "米国株高が強まるかどうかを見る",
    "米国株が上昇すれば、日本株の反応を見る",
    "米国株安が続くかを見る",
  ]) {
    assert.deepEqual(factual(sentence), [], sentence);
  }
});

test("P2: ordinary prior-night watch wording is not a date mismatch in any placement", () => {
  for (const sentence of [
    "10月2日は、前夜の米国株高を受け、日本株の反応を見る",
    "10月2日は、米国株高の流れをどう受け止めるかが焦点",
    "10月2日は、前日の米国株上昇を踏まえて、日本株の反応を確認する",
    "前日の米国株上昇を踏まえて、日本株の反応を確認する",
  ]) {
    assert.ok(!has(factual(sentence), DATE_ISSUE), `${sentence} → ${factual(sentence).join(" / ")}`);
    for (const [field, place] of FIELDS) {
      const issues = localAnalysisCheck(live((analysis) => place(analysis, sentence)), input).hard;
      assert.ok(!has(issues, DATE_ISSUE), `${field}: ${sentence} → ${issues.join(" / ")}`);
    }
  }
});

test("P2: the new shapes do not excuse a move stated between them and the watch", () => {
  for (const sentence of [
    "10月2日は、米国株高を受け、米国株高が続き、日本株を見る",
    "10月2日は、米国株高を受け、買いが先行し、日本株の反応を見る",
    "10月2日は、米国株高の流れが続き、日本株の反応を見る",
    "10月2日は、米国株高の流れが強まり、どう受け止めるかが焦点",
    // 「前夜」 is evidence, not an exemption
    "10月2日は、前夜の米国株高が続き、日本株の反応を確認します",
    "10月2日の前夜の米国株は上昇しました",
  ]) {
    assert.ok(has(factual(sentence), DATE_ISSUE), `accepted: ${sentence} → ${factual(sentence).join(" / ")}`);
  }
});
