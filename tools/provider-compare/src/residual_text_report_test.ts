import assert from "node:assert/strict";
import test from "node:test";
import { buildReferenceIndex, longestSharedRun, summariseOverlap } from "./residual_text_report.ts";
import { redactNopostSample, titleKeyOf, normaliseTitle } from "./eval_redaction.ts";
import { buildNopostReport } from "../scripts/nopost_report.ts";

// Synthetic texts only. The report returns counts; these tests also check that nothing it returns contains a text.

const SHARED = "合成の基準文があり、この一続きの文字列は参照側と対象側の両方に現れる。";
const refs = [
  { key: "body:00000001", text: `前置きの合成文。${SHARED}後書きの合成文。` },
  { key: "title:00000002", text: "別の合成の見出し（試験用・これは参照）" },
];

test("a text that repeats a run from a reference is counted at the window sizes it reaches, with the longest run", () => {
  const target = `無関係な書き出し。${SHARED}無関係な結び。`;
  const summary = summariseOverlap("target", [target, "まったく関係のない短い合成文です。"], refs, [10, 20, 30]);
  assert.equal(summary.texts, 2);
  assert.equal(summary.withRun[10], 1);
  assert.equal(summary.withRun[20], 1);
  assert.ok(summary.longestRun >= SHARED.length, `longest ${summary.longestRun}`);
  assert.deepEqual(summary.top, [summary.longestRun]);
});

test("a text with no shared run counts nothing, and whitespace does not hide a run", () => {
  const none = summariseOverlap("none", ["完全に別の合成の文章。数字だけ 12345。"], refs, [10, 20]);
  assert.deepEqual(none.withRun, { 10: 0, 20: 0 });
  assert.equal(none.longestRun, 0);
  const spaced = SHARED.split("").join(" ");
  assert.equal(summariseOverlap("spaced", [spaced], refs, [20]).withRun[20], 1);
});

test("the longest run is exact, and a run shorter than the smallest window is reported as 0", () => {
  assert.equal(longestSharedRun("abcdefghij", [{ key: "r", text: "xxabcdefghijyy" }], 5), 10);
  assert.equal(longestSharedRun("abcd", [{ key: "r", text: "xxabcdyy" }], 5), 0);
  assert.equal(buildReferenceIndex([{ key: "r", text: "abc" }], 5).size, 0, "a reference shorter than the window adds nothing");
});

test("the summary carries numbers only", () => {
  const summary = summariseOverlap("target", [`先頭。${SHARED}`], refs);
  const json = JSON.stringify(summary);
  assert.ok(!json.includes(SHARED.slice(0, 12)), "no text in the summary");
  assert.deepEqual(Object.keys(summary).sort(), ["longestRun", "name", "texts", "top", "withRun"]);
});

// --- negative tests for the redaction keys and generated reports -----------------------------------------------------
test("two withheld headlines with the same normalised text share a key; different text does not", async () => {
  const file = {
    cases: [
      { caseId: "d-1", candidateId: "11111111-0000-4000-8000-000000000000", title: "合成の見出し（試験用）  A", sourceUrl: "https://www.release.tdnet.info/a" },
      { caseId: "d-2", candidateId: "22222222-0000-4000-8000-000000000000", title: "合成の見出し(試験用) a", sourceUrl: "https://www.release.tdnet.info/b" },
      { caseId: "d-3", candidateId: "33333333-0000-4000-8000-000000000000", title: "合成の別の見出し（試験用）", sourceUrl: "https://www.release.tdnet.info/c" },
    ],
  };
  assert.equal(normaliseTitle(file.cases[0].title), normaliseTitle(file.cases[1].title));
  await redactNopostSample(file);
  const [a, b, c] = file.cases.map((item) => titleKeyOf(item));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(file.cases.every((item) => item.title.startsWith("（見出し非保持")), "the placeholders differ by id but never carry the text");
  assert.notEqual(file.cases[0].title, file.cases[1].title);
});

test("a report built from a redacted sample carries placeholders, never the original headline", async () => {
  const original = "合成の見出し R（試験用・報告書に出てはならない）";
  const item = {
    caseId: "nopost-tdnet-aaaaaaaa", candidateId: "aaaaaaaa-0000-4000-8000-000000000000", title: original,
    sourceUrl: "https://www.release.tdnet.info/a", sourceName: "tdnet", layer: "not_gated", bodyStored: false,
    cell: { n: 10, sampled: 1, rank: 1 },
    recorded: { importance: "no_post", model: "synthetic", confidence: 0.5, escalatedToSol: false, reason: "合成", coverageSeverity: null },
    label: { status: "independent_confirmed", expected: "important", rule: "r", suspected: true, rationale: "合成の理由", keyFacts: ["合成の事実"], headline: true },
  };
  await redactNopostSample({ cases: [item] });
  const report = buildNopostReport([item as never]);
  assert.ok(!JSON.stringify(report).includes(original));
});
