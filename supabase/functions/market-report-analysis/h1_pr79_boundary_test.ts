// H1 independent pre-deploy regressions for PR #79, exact candidate 9ce344b.
// These deliberately assert the required boundary, not the currently broken behavior.
import assert from "node:assert/strict";
import test from "node:test";
import type { MarketReportPacket } from "../_shared/market_report_packet.ts";
import { type GeneratedAnalysis, localAnalysisCheck } from "./analysis_logic.ts";
import { metricFactIssues } from "./hard_fact_guards.ts";
import { inputOf, loadFixture } from "./test_support.ts";

const input = inputOf(await loadFixture("morning_2026-10-02"));
const delivered: MarketReportPacket = JSON.parse(await Deno.readTextFile(
  new URL("./fixtures/morning_2026-10-02_generated_report.json", import.meta.url),
)).payload;
function draft(): GeneratedAnalysis {
  const p = structuredClone(delivered);
  return {
    headline_ja: p.headline_ja, market_summary_ja: p.market_summary_ja, claims: p.claims,
    key_news: p.key_news.map((n) => ({ ref: n.ref_id, why_it_matters_ja: n.why_it_matters_ja })),
    strong_themes: p.strong_themes, weak_themes: p.weak_themes,
    next_watch_ja: p.next_watch_ja, risks_ja: p.risks_ja, x_post: p.x_post, app_story: p.app_story,
  };
}
const fields: Array<[string, (a: GeneratedAnalysis, s: string) => void]> = [
  ["summary", (a, s) => { a.market_summary_ja += s; }],
  ["X context", (a, s) => { a.x_post.context_ja += s; }],
  ["X closing", (a, s) => { a.x_post.closing_ja = s; }],
  ["App summary", (a, s) => { a.app_story!.summary_ja += s; }],
  ["App japan", (a, s) => { a.app_story!.japan_ja += s; }],
  ["claim", (a, s) => { a.claims[0].text_ja = s; }],
];
const dateIssue = (issues: string[]) => issues.some((i) => i.includes("日付と指標の不一致"));

test("H1 PR79: an asserted move before a hypothetical tail still needs date/direction checks", () => {
  const missing: string[] = [];
  for (const s of [
    "10月2日は、米国株高が強まり波及するかどうかを見ます。",
    "10月2日は、米国株高が鮮明となり波及するかどうかを見ます。",
    "10月2日は、米国株高が継続し波及するかどうかを見ます。",
    "10月2日の米国株は下落しており次も続くかを見ます。",
  ]) for (const [name, place] of fields) {
    const a = draft();
    place(a, s);
    const hard = localAnalysisCheck(a, input).hard;
    if (!dateIssue(hard)) missing.push(`${name}: ${s} -> ${hard.join(" / ") || "no Hard rejection"}`);
  }
  assert.deepEqual(missing, []);
});

test("H1 PR79: MOVE_LIST must not discard an assertion that a parallel move happened today", () => {
  const missing: string[] = [];
  for (const s of [
    "10月2日は、米国株高や今日上昇した半導体株高が日本株でどう表れるかを見ます。",
    "10月2日は、米国株高や今日反落した半導体株安が日本株でどう表れるかを見ます。",
  ]) for (const [name, place] of fields) {
    const a = draft();
    place(a, s);
    const hard = localAnalysisCheck(a, input).hard;
    if (hard.length === 0) missing.push(`${name}: ${s}`);
  }
  assert.deepEqual(missing, []);
});

test("H1 PR79: normal prior-night watch variants do not falsely assert today's US session", () => {
  const rejected: string[] = [];
  for (const s of [
    "10月2日は、前夜の米国株高を受け、日本株の反応を見る。",
    "10月2日は、米国株高の流れをどう受け止めるかが焦点。",
    "10月2日は、前日の米国株上昇を踏まえて、日本株の反応を確認する。",
  ]) for (const [name, place] of fields) {
    const a = draft();
    place(a, s);
    const hard = localAnalysisCheck(a, input).hard;
    if (dateIssue(hard)) rejected.push(`${name}: ${s}`);
  }
  assert.deepEqual(rejected, []);
});

test("H1 PR79 controls: genuine hypotheticals and the known delivery remain Hard-safe", () => {
  assert.deepEqual(localAnalysisCheck(draft(), input).hard, []);
  for (const s of [
    "10月2日は、米国株高が強まるかどうかを見ます。",
    "10月2日は、米国株が上昇すれば買いを検討します。",
    "10月2日は、米国株安が続くかを確認します。",
  ]) assert.deepEqual(metricFactIssues({ factual: [s], forward: [] }, input), [], s);
});

test("H1 rereview: causal から and an asserted copula before a question are not hypotheses", () => {
  const accepted: string[] = [];
  for (const s of [
    "10月2日は、米国株安が続くから反応を見ます。",
    "10月2日の米国株は下落するから、反応を見ます。",
    "10月2日の米国株は下落が明白で続くかを見ます。",
    "10月2日の米国株は下落が確定し続くかを見ます。",
    "10月2日は、米国株安が明確となり続くかを見ます。",
    "10月2日は、米国株安が明白で次の動きを見ます。",
  ]) for (const [name, place] of fields) {
    const a = draft();
    place(a, s);
    const issues = localAnalysisCheck(a, input).hard;
    if (!dateIssue(issues) || !issues.some((i) => i.includes("方向の逆転"))) accepted.push(`${name}: ${s}`);
  }
  assert.deepEqual(accepted, []);
  // A matching direction must not hide the wrong date via WATCH_RELATION either.
  assert.ok(dateIssue(metricFactIssues({
    factual: ["10月2日は、米国株高が続くから反応を見ます。"], forward: [],
  }, input)));
});

test("H1 rereview: bounded degree adverbs do not make an honest question factual", () => {
  for (const s of [
    "10月2日は、米国株高が一段と強まるかどうかを見ます。",
    "10月2日は、米国株高がさらに強まるかどうかを見ます。",
    "10月2日は、米国株安がさらに続くかを見ます。",
    "10月2日は、米国株高が強くなるかを見ます。",
    "10月2日は、米国株が上昇したかどうかを確認します。",
    "10月2日は、米国株高が強まったかどうかを確認します。",
    "10月2日は、米国株高が再度大幅拡大するかどうかを見ます。",
  ]) assert.deepEqual(metricFactIssues({ factual: [s], forward: [] }, input), [], s);
});

test("H1 rereview: a pure reaction watch is deliverable in all factual placements, not just date-safe", () => {
  const rejected: string[] = [];
  for (const s of [
    "10月2日は、前夜の米国株高を受け、日本株の反応を見る。",
    "10月2日は、前夜の米国株高を受けて、日本株の反応を確認します。",
    "10月2日は、米国株高の流れをどう受け止めるかが焦点。",
    "10月2日は、米国市場の上昇を受けた動きが続くかを確認します。",
  ]) for (const [name, place] of fields) {
    const a = draft();
    place(a, s);
    const issues = localAnalysisCheck(a, input).hard;
    if (issues.length > 0) rejected.push(`${name}: ${s} -> ${issues.join(" / ")}`);
  }
  assert.deepEqual(rejected, []);
});

test("H1 rereview: a watch verb cannot launder an actual or speculative market causal claim", () => {
  for (const s of [
    "米国株高を受け、日本株が上昇しました。",
    "米国株高を受け、日本株の反応を見て、上昇したことを確認します。",
    "米国株高を受け、日本株の反応を見る前に上昇しました。",
    "米国株高を受け、日本株の反応を見る一方、買いが先行しています。",
    "米国株高を受け、日本株の反応を見ると上昇しました。",
    "米国株高を受け、日本株の反応を確認した。",
    "米国株高を受けた動きが続くから確認します。",
    "米国株高を受けた動きが強まり続くかを確認します。",
  ]) {
    const a = draft();
    a.x_post.closing_ja = s;
    assert.ok(localAnalysisCheck(a, input).hard.some((i) => i.includes("因果の断定")), s);
  }
  // A cause offered only as a possibility is advisory since 2026-10-07: recorded, never laundered into "no finding".
  const hedged = draft();
  hedged.x_post.closing_ja = "米国株高を受け、日本株の上昇が続く可能性があります。";
  const check = localAnalysisCheck(hedged, input);
  assert.ok(!check.hard.some((i) => i.includes("因果の断定")));
  assert.ok(check.warnings.includes("SPECULATIVE_CAUSALITY:1"), check.warnings.join(" / "));
});

test("H1 rereview: the narrow causal watch exemption does not exempt facts in its cause", () => {
  for (const [expected, s] of [
    ["日付と指標の不一致", "10月2日のNYダウ50,926.56を受け、日本株の反応を見る。"],
    ["方向の逆転", "10月2日は、前夜の米国株安を受け、日本株の反応を見る。"],
    ["方向の逆転", "10月1日のS&P500の-0.19%を受け、日本株の反応を見る。"],
  ]) for (const [name, place] of fields) {
    const a = draft();
    place(a, s);
    assert.ok(localAnalysisCheck(a, input).hard.some((i) => i.includes(expected)), `${name}: ${s}`);
  }
  const a = draft();
  a.claims[0].text_ja = "前夜の米国株高を受け、日本株の反応を見る。";
  a.claims[0].evidence_refs = ["news:00000000-0000-4000-8000-000000000000"];
  assert.ok(localAnalysisCheck(a, input).hard.some((i) => i.includes("入力に無い ref")));
});
