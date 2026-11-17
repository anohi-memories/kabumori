// Task40 (A)(B): audit of the topic-value filter against synthetic and recorded diary topics.
// No provider is called and nothing is posted. "合成" cases are invented for this audit; "実記録" cases
// come from the bundled dev diary. A postable verdict only means "no weak-vocabulary pattern matched";
// it is never a claim that a topic is interesting (that stays a human judgement).
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
import { assessAiLabTopicValue } from "./ai_lab_topic_value.ts";

import { SYNTHETIC } from "./ai_lab_topic_quality_fixtures.ts";

test("task40 (A): synthetic cases keep their documented verdicts and reasons", () => {
  const lines = ["=== task40 題材判定一覧（非課金。合成／実記録を明記。面白さのPASSではない）==="];
  for (const c of SYNTHETIC) {
    const r = assessAiLabTopicValue(c.seed);
    assert.equal(r.postable, c.postable, c.id);
    if (c.reasons) assert.deepEqual([...r.reasons], c.reasons, c.id);
    lines.push(`[${c.source}] ${c.id}: ${r.postable ? "投稿可" : "保留 " + r.reasons.join(",")} — ${c.note}`);
    if (c.preview) lines.push(`    プレビュー（手書き・合成）: ${c.preview}`);
  }
  console.log(lines.join("\n"));
});

test("task40 (A): two or more weak credential words hold; one does not; a reader-visible scene still wins", () => {
  assert.equal(assessAiLabTopicValue("できごと: 鍵と権限の話を整理した。").postable, false);
  assert.equal(assessAiLabTopicValue("できごと: 鍵を失くした。").postable, true);
  // A concrete outcome does not rescue a credential topic.
  assert.equal(
    assessAiLabTopicValue("できごと: 認証の確認が5分で終わった。\n詰まったこと: トークンの扱いが違った。").postable,
    false,
  );
  // 切り口 never counts, even with a rescue word in it.
  assert.equal(
    assessAiLabTopicValue("できごと: 設定と環境と処理を整えた。\n今回の切り口: 5分で戻せた話").postable,
    false,
  );
});

test("task40 (A): recorded diary verdicts are unchanged by the narrowing (実記録)", async () => {
  const markdown = await loadAiLabDevDiaryMarkdown();
  const held: string[] = [];
  const posted: string[] = [];
  for (const raw of parseDevDiaryMarkdown(markdown)) {
    const entry = sanitizeDiaryEntry(raw);
    assert.ok(entry?.eventId);
    const unit = diaryUnitsFor(entry, diaryEventKey(entry.eventId), 1, [])[0];
    (assessAiLabTopicValue(unit.seed).postable ? posted : held).push(entry.eventId);
  }
  assert.deepEqual(held, [
    "20260929-research-before-content-access",
    "20260930-x-auth-test-account-overlap",
    "20261001-shared-login-service-registration",
    "20261007-ai-model-update-centralized",
  ]);
  assert.equal(posted.length, 10);
  console.log(
    "[実記録] 日記14件: 保留4（" + held.join(" / ") + "）、投稿可10。" +
      "20261007は内部のモデル名集約の話で、読者に伝わる場面が無いため保留のまま（実記録の主観判断が割れうる）。",
  );
});

test("task40 (A): secret-looking and invalid diary fields never become a topic; weak events fall to evergreen", () => {
  const entry = (date: string, id: string, changed: string, extra = "") =>
    `## ${date}\nevent_id: ${date.replaceAll("-", "")}-${id}\nchanged: ${changed}\n${extra}`;
  const markdown = [
    entry("2026-11-16", "leaked-key", "キーは sk-abcdefghijklmnopqrstuvwxyz0123456789 を使って画面を直した。"),
    entry("2026-11-16", "mailed", "連絡先は taro@example.com に変えて画面を直した。"),
    entry("2026-11-15", "weak-report", "運用と進捗の設定ファイルを整えた。", "decided: 本番の環境と連携を進める。"),
    entry("2026-11-15", "good-button", "送信ボタンを押した直後にもう一度押せてしまい、同じ投稿が2件できていた。"),
  ].join("\n\n");
  const { candidates, exclusions } = buildAiLabTopicCandidates({
    markdown,
    now: new Date("2026-11-17T03:00:00Z"),
    rotationIndex: 0,
  });
  const diary = candidates.filter((c) => c.kind === "diary").map((c) => c.eventKey);
  assert.deepEqual(diary, ["diary:20261115-good-button"]);
  assert.equal(exclusions.filter((e) => e.reason === "DIARY_ENTRY_UNSAFE_OR_INVALID").length, 2);
  assert.ok(exclusions.some((e) => e.stage === "post_value" && e.candidate === "diary:20261115-weak-report"));
  assert.ok(candidates.some((c) => c.kind === "evergreen"));
  // No secret, mail address or Japanese text leaks into the exclusion log or the candidate keys.
  const logged = JSON.stringify(exclusions);
  assert.doesNotMatch(logged, /sk-abc|taro@example/u);
});
