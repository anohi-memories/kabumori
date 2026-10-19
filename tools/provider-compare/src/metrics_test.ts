import assert from "node:assert/strict";
import test from "node:test";
import { loadCases, type CaseFixture } from "./fixtures.ts";
import { checkMetric, draftMetric, isArticleLikeUrl, judgementMetric, searchMetric } from "./metrics.ts";
import { emptyResult } from "./providers/common.ts";
import { recordedDraftText } from "./tasks.ts";
import type { NeutralRequest, ProviderResult } from "./types.ts";

const cases = await loadCases();
const byGroup = (predicate: (c: CaseFixture) => boolean) => cases.find(predicate)!;

function result(parsed: unknown, ok = true): ProviderResult {
  return { ...emptyResult("mock", "m", "m"), ok, parsed, text: JSON.stringify(parsed) };
}

// --- judgement --------------------------------------------------------------------------------------------------

test("a matching importance is a match on both references", () => {
  const fixture = byGroup((c) => c.outcomeKind === "success" && c.expected.importance === "important");
  const metric = judgementMetric(result({ importance: "important", reason: "r" }), fixture);
  assert.deepEqual(
    [metric.valid, metric.matchesRecorded, metric.matchesExpected, metric.direction, metric.missedImportant, metric.falseAlarm, metric.hasReason],
    [true, true, true, "match", false, false, true],
  );
});

test("answering no_post where an important item was expected is a MISS", () => {
  const fixture = byGroup((c) => c.outcomeKind === "success" && c.expected.importance !== "no_post");
  const metric = judgementMetric(result({ importance: "no_post", reason: "routine" }), fixture);
  assert.equal(metric.missedImportant, true);
  assert.equal(metric.direction, "under");
  assert.equal(metric.falseAlarm, false);
});

test("answering important where no_post was expected is a FALSE ALARM (over)", () => {
  const fixture = byGroup((c) => c.outcomeKind === "negative_control");
  const metric = judgementMetric(result({ importance: "most_important", reason: "x" }), fixture);
  assert.equal(metric.falseAlarm, true);
  assert.equal(metric.direction, "over");
});

test("the known official-notice miss is scored against the human hint, not against production's wrong answer", () => {
  const fixture = byGroup((c) => c.outcomeKind === "miss");
  assert.equal(fixture.expected.source, "human_hint");
  assert.equal(fixture.recorded.judgement.importance, "no_post");
  const same = judgementMetric(result({ importance: "no_post", reason: "r" }), fixture);
  assert.equal(same.matchesRecorded, true);
  assert.equal(same.matchesExpected, false);
  assert.equal(same.missedImportant, true);
  const better = judgementMetric(result({ importance: "important", reason: "r" }), fixture);
  assert.equal(better.matchesRecorded, false);
  assert.equal(better.matchesExpected, true);
});

test("an unparseable, failed or out-of-range answer is invalid, never silently counted as a match", () => {
  const fixture = cases[0];
  for (const bad of [result(null), result({ importance: "urgent" }), result({}), result({ importance: "important" }, false)]) {
    const metric = judgementMetric(bad, fixture);
    assert.equal(metric.valid, false);
    assert.equal(metric.direction, "invalid");
    assert.equal(metric.matchesExpected, false);
  }
});

// --- draft ------------------------------------------------------------------------------------------------------

test("production's own recorded draft passes the local checks once the label and source line are re-applied", () => {
  const passing = cases.filter((c) => c.recorded.generation?.factStatus === "passed" && c.recorded.generation.text);
  assert.ok(passing.length >= 8);
  for (const fixture of passing) {
    const metric = draftMetric(recordedDraftText(fixture), fixture);
    assert.equal(metric.present, true);
    assert.deepEqual(metric.localFactIssues, [], fixture.caseId);
  }
});

test("a number that is in neither the title, the body nor the judgement reason is reported as unsupported", () => {
  const fixture = byGroup((c) => c.recorded.generation?.factStatus === "passed" && c.recorded.generation.text !== null);
  const clean = draftMetric(recordedDraftText(fixture), fixture);
  const tampered = draftMetric(`${recordedDraftText(fixture)} 売上は98765億円でした。`, fixture);
  assert.ok(tampered.unsupportedNumbers.includes("98765"));
  assert.ok(!clean.unsupportedNumbers.includes("98765"));
});

test("a date written in the headline but missing from the post is reported", () => {
  // No stored headline carries a month-day date, so the subject is a copy of a real case with one added.
  const fixture = structuredClone(cases[0]);
  fixture.candidate.title = `${fixture.candidate.title}（10月9日開示）`;
  const missing = draftMetric("内容だけを書いた短い本文です。", fixture);
  assert.deepEqual(missing.missingTitleDates, ["10月9日"]);
  const kept = draftMetric("10月9日に発表されました。", fixture);
  assert.deepEqual(kept.missingTitleDates, []);
});

test("a missing or empty draft is 'not present', with no issues invented", () => {
  const metric = draftMetric(null, cases[0]);
  assert.deepEqual(metric, {
    present: false, charCount: 0, unsupportedNumbers: [], missingTitleDates: [],
    companyNameRetained: null, localFactIssues: [], localVoiceIssues: [],
  });
  assert.equal(draftMetric("   ", cases[0]).present, false);
});

test("a draft that carries its own source line or headline label is caught by the local checks", () => {
  const fixture = byGroup((c) => Boolean(c.recorded.generation?.text) && c.recorded.judgement.importance !== "no_post");
  const metric = draftMetric(`【速報】${recordedDraftText(fixture)}\n\n出典: https://example.com/other`, fixture);
  assert.ok(metric.localFactIssues.length > 0);
});

// --- Fact / Voice -----------------------------------------------------------------------------------------------

test("a Fact verdict is compared with production's recorded verdict for the same post", () => {
  const failed = byGroup((c) => c.recorded.generation?.factStatus === "failed");
  const passed = byGroup((c) => c.recorded.generation?.factStatus === "passed");
  assert.equal(checkMetric(result({ passed: false, issues: ["x"] }), failed, "fact").agreesWithRecorded, true);
  assert.equal(checkMetric(result({ passed: true, issues: [] }), failed, "fact").agreesWithRecorded, false);
  assert.equal(checkMetric(result({ passed: true, issues: [] }), passed, "fact").agreesWithRecorded, true);
  assert.equal(checkMetric(result({ passed: false, issues: ["a", "b"] }), passed, "fact").issueCount, 2);
});

test("a Voice verdict is not scored when production never ran Voice on that post", () => {
  const notRun = byGroup((c) => c.recorded.generation !== null && c.recorded.generation.voiceStatus !== "passed" && c.recorded.generation.voiceStatus !== "failed");
  assert.equal(checkMetric(result({ passed: true, issues: [] }), notRun, "voice").agreesWithRecorded, null);
});

test("a non-boolean verdict is invalid", () => {
  const fixture = cases.find((c) => c.recorded.generation)!;
  assert.equal(checkMetric(result({ passed: "yes", issues: [] }), fixture, "fact").valid, false);
  assert.equal(checkMetric(result(null), fixture, "fact").valid, false);
});

// --- search -----------------------------------------------------------------------------------------------------

test("marketing / help / account pages are not article-like; real article paths are", () => {
  for (const url of [
    "https://pitch.nikkei.com/arc/x", "https://assist.bloomberg.com/help", "https://lei.bloomberg.com/le/12",
    "https://scoopbox.nhk.or.jp/a/b", "https://bookplus.nikkei.com/catalog/x", "https://www.reuters.com/",
    "not a url",
  ]) assert.equal(isArticleLikeUrl(url), false, url);
  for (const url of [
    "https://apnews.com/article/6a096d714c874db13632794a32cebaa6",
    "https://www.reuters.com/markets/asia/yen-slides-2026-10-09/",
    "https://www3.nhk.or.jp/news/html/20261009/k10000.html",
  ]) assert.equal(isArticleLikeUrl(url), true, url);
});

test("search metrics: counts, allowed-domain share, article share and candidate count", () => {
  const request = { webSearch: { allowedDomains: ["apnews.com", "nikkei.com"] } } as NeutralRequest;
  const res: ProviderResult = {
    ...result({ candidates: [{}, {}] }),
    sourceUrls: ["https://apnews.com/article/abc123", "https://pitch.nikkei.com/arc/x", "https://example.org/a/b/c"],
  };
  const metric = searchMetric(res, request);
  assert.equal(metric.sourceCount, 3);
  assert.ok(Math.abs((metric.allowedShare ?? 0) - 2 / 3) < 1e-9);
  assert.ok(Math.abs((metric.articleLikeShare ?? 0) - 2 / 3) < 1e-9);
  assert.equal(metric.candidateCount, 2);
  const none = searchMetric({ ...result({}), sourceUrls: [] }, request);
  assert.deepEqual(none, { sourceCount: 0, allowedShare: null, articleLikeShare: null, candidateCount: null });
});
