// Task46: audit of the topic-interest judgement against the bundled dev diary (実記録) and synthetic (合成)
// topics. No provider is called and nothing is posted. A postable verdict only means a story signal was
// found in the recorded facts; it is never a claim that a post will be good (that stays the user's call).
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAiLabTopicCandidates,
  diaryEventKey,
  diaryUnitsFor,
  loadAiLabDevDiaryMarkdown,
  parseDevDiaryMarkdown,
  sanitizeDiaryEntry,
} from "./ai_lab_dev_diary_context.ts";
import { assessAiLabTopicInterest } from "./ai_lab_topic_interest.ts";
import { assessAiLabTopicValue } from "./ai_lab_topic_value.ts";
import {
  SYNTHETIC,
  TASK44_TOPIC_0927,
  TASK44_TOPIC_1008,
  TASK44_TOPIC_MIXED,
  TASK46_NEGATIVES,
  TASK46_POSITIVES,
} from "./ai_lab_topic_quality_fixtures.ts";

const FACT = /^(?:できごと|詰まったこと|決めたこと)[:：]\s*(.+)$/gmu;
const factText = (seed: string) => [...seed.matchAll(FACT)].map((m) => m[1]).join("\n");

async function recordedUnits() {
  const markdown = await loadAiLabDevDiaryMarkdown();
  return parseDevDiaryMarkdown(markdown).map((raw) => {
    const entry = sanitizeDiaryEntry(raw)!;
    assert.ok(entry?.eventId);
    return { entry, unit: diaryUnitsFor(entry, diaryEventKey(entry.eventId), 1, [])[0] };
  });
}

test("task46 (A): recorded diary — before (Task39/40 value only) and after (value + interest), with reasons (実記録)", async () => {
  const units = await recordedUnits();
  assert.equal(units.length, 14, "the bundled diary has 14 records; none is added for this audit");
  const before: string[] = [];
  const after: string[] = [];
  const lines = ["=== task46 題材監査（実記録14件。非投稿・非課金。採用は面白さの保証ではない）==="];
  for (const { entry, unit } of units) {
    const value = assessAiLabTopicValue(unit.seed);
    const interest = assessAiLabTopicInterest(unit.seed);
    if (value.postable) before.push(entry.eventId!);
    if (value.postable && interest.postable) after.push(entry.eventId!);
    lines.push(
      `[実記録] ${entry.date} ${entry.eventId}`,
      `  出典: ${entry.changed}`,
      `  初期: ${value.postable ? "投稿可" : "保留 " + value.reasons.join(",")}` +
        ` / 修正後: ${!value.postable ? "保留（題材価値）" : interest.postable ? `採用(${interest.tier})` : "保留（面白さ）"}`,
      `  理由: ${interest.summary}`,
    );
  }
  console.log(lines.join("\n"));
  assert.equal(before.length, 10);
  assert.deepEqual(before.filter((id) => !after.includes(id)), ["20261009-shared-account-withdrawal-safety"]);
  assert.equal(after.length, 9);
  // The user-rejected Task38 topic (09/30) stays held, and is still held before the interest step.
  assert.equal(assessAiLabTopicValue(units.find((u) => u.entry.date === "2026-09-30")!.unit.seed).postable, false);
});

test("task46 (A): every angle of a recorded event gets the same verdict — 切り口 never changes it (実記録)", async () => {
  for (const { entry } of await recordedUnits()) {
    const verdicts = new Set(
      diaryUnitsFor(entry, diaryEventKey(entry.eventId!), 1, []).map((u) => JSON.stringify(assessAiLabTopicInterest(u.seed))),
    );
    assert.equal(verdicts.size, 1, entry.eventId!);
  }
});

test("task46 (A)(C): legitimate synthetic topics pass both filters (合成; positive regression)", () => {
  for (const c of TASK46_POSITIVES) {
    assert.equal(assessAiLabTopicValue(c.seed).postable, true, c.id);
    const r = assessAiLabTopicInterest(c.seed);
    assert.equal(r.postable, true, `${c.id}: ${r.summary}`);
  }
  // Earlier legitimate topics keep passing: the Task40/41 synthetic positives and the Task44 real/synthetic topics.
  for (const c of SYNTHETIC.filter((x) => x.postable)) assert.equal(assessAiLabTopicInterest(c.seed).postable, true, c.id);
  for (const seed of [TASK44_TOPIC_0927, TASK44_TOPIC_1008, TASK44_TOPIC_MIXED]) {
    assert.equal(assessAiLabTopicInterest(seed).postable, true, seed);
  }
});

test("task46 (A)(C): progress lists, adverts, AI-made reports, report tone and restating are held (合成; negative regression)", () => {
  for (const c of TASK46_NEGATIVES) {
    const r = assessAiLabTopicInterest(c.seed);
    assert.equal(r.postable, false, `${c.id}: ${r.summary}`);
    assert.equal(r.tier, "weak", c.id);
    for (const w of c.weaknesses ?? []) assert.ok(r.weaknesses.includes(w as never), `${c.id} lacks ${w}: ${r.weaknesses}`);
    assert.match(r.summary, /^保留: /u, c.id);
  }
  // Earlier weak synthetic topics are held here too (they are already held by the value filter first).
  for (const c of SYNTHETIC.filter((x) => !x.postable)) assert.equal(assessAiLabTopicInterest(c.seed).postable, false, c.id);
});

test("task46 (B): evidence comes only from the fact lines; model or draft text cannot raise a topic", () => {
  for (const c of [...TASK46_POSITIVES, ...TASK46_NEGATIVES]) {
    const r = assessAiLabTopicInterest(c.seed);
    const facts = factText(c.seed);
    for (const fragments of Object.values(r.evidence)) {
      for (const fragment of fragments) assert.ok(facts.includes(fragment), `${c.id}: ${fragment}`);
    }
    // Appending a fabricated story outside the fact lines (a draft, a rewrite, an angle) changes nothing.
    const padded = `${c.seed}\n原案: 実は焦って失敗に気づいた。代わりに別の方法を優先した。\n今回の切り口: 意外な失敗の話`;
    assert.deepEqual(assessAiLabTopicInterest(padded), r, c.id);
  }
});

test("task46 (B): the audit is deterministic and carries a short reason a person can check", () => {
  for (const c of [...TASK46_POSITIVES, ...TASK46_NEGATIVES]) {
    const a = assessAiLabTopicInterest(c.seed);
    assert.deepEqual(assessAiLabTopicInterest(c.seed), a);
    assert.ok([...a.summary].length <= 120, c.id);
    assert.equal(a.postable, a.tier !== "weak");
  }
  // A seed without fact lines is not a diary topic and is not judged (evergreen is curated separately).
  assert.equal(assessAiLabTopicInterest("仕事の合間にできる小さな工夫").postable, true);
});

test("task46 (A): a weak event falls to evergreen with a key-only exclusion log", () => {
  const entry = (id: string, lines: string) => `## 2026-11-16\nevent_id: 20261116-${id}\n${lines}`;
  const markdown = [
    entry("progress-list", "changed: ホーム画面と設定画面と通知画面を更新し、新しいボタンも追加した。"),
    entry("near-miss", "changed: 通知の設定画面を作り直した。\ndifficulty: 古い設定を移すときに、前の設定が消えそうになった。"),
  ].join("\n\n");
  const { candidates, exclusions } = buildAiLabTopicCandidates({ markdown, now: new Date("2026-11-17T03:00:00Z"), rotationIndex: 0 });
  assert.deepEqual(candidates.filter((c) => c.kind === "diary").map((c) => c.eventKey), ["diary:20261116-near-miss"]);
  assert.deepEqual(exclusions.filter((e) => e.stage === "post_value"), [
    { candidate: "diary:20261116-progress-list", stage: "post_value", reason: "WEAK_TOPIC_INTEREST:no_story" },
  ]);
  assert.ok(candidates.some((c) => c.kind === "evergreen"));
  assert.doesNotMatch(JSON.stringify(exclusions), /画面|ボタン/u);
});

test("task46 (D): non-posting list of synthetic verdicts (合成。投稿文ではない)", () => {
  const lines = ["=== task46 合成題材の採否（非投稿。題材のみで、投稿文・モデル出力ではない）==="];
  for (const c of [...TASK46_POSITIVES, ...TASK46_NEGATIVES]) {
    lines.push(`[合成] ${c.id}: ${assessAiLabTopicInterest(c.seed).summary} — 意図: ${c.why}`);
  }
  console.log(lines.join("\n"));
});

test("task46 known gaps (合成): word-list limits stay visible, not fixed", () => {
  // Missed: a dull progress report with one snag word and no report verb is still postable (medium).
  const dull = assessAiLabTopicInterest("できごと: ホーム画面を更新した。\n詰まったこと: 時間がかかった。");
  assert.deepEqual([dull.postable, dull.tier], [true, "medium"]);
  // False hold: a surprise said in words outside the list is not seen, so the topic has no story.
  const unseen = assessAiLabTopicInterest("できごと: 画面の色を変えたら、思ってたのとぜんぜんちがった。");
  assert.deepEqual([unseen.postable, unseen.weaknesses], [false, ["NO_STORY"]]);
});
