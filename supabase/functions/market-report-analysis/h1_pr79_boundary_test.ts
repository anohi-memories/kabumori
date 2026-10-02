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
