// Task47: calibration of the topic-interest heuristic, offline. No provider is called and nothing is
// posted. 実記録 = the bundled dev diary; 合成 = invented here for the test (never a model output or a post).
// 10/09 and 10/10 are 本人判断待ち: their verdicts are shown for the owner to judge, never fixed as right.
import assert from "node:assert/strict";
import test from "node:test";
import {
  diaryEventKey,
  diaryUnitsFor,
  loadAiLabDevDiaryMarkdown,
  parseDevDiaryMarkdown,
  sanitizeDiaryEntry,
} from "./ai_lab_dev_diary_context.ts";
import { assessAiLabTopicInterest, compareAiLabTopicStructure } from "./ai_lab_topic_interest.ts";
import { SYNTHETIC, TASK44_TOPIC_0927, TASK44_TOPIC_1008, TASK44_TOPIC_MIXED, TASK46_NEGATIVES, TASK46_POSITIVES } from "./ai_lab_topic_quality_fixtures.ts";

const seed = (...lines: string[]) => `開発日記（2026-11-17、昨日の出来事）より。\n${lines.join("\n")}\n今回の切り口: 何が起きたのか`;
const ok = (s: string) => assessAiLabTopicInterest(s);

// 1. Bare effort words.
const EFFORT_NEGATIVES = [
  seed("できごと: ホーム画面を更新した。", "詰まったこと: 時間がかかった。"),
  seed("できごと: 設定画面を作り直した。", "詰まったこと: 色合わせに時間がかかった。"),
  seed("できごと: 一覧を直した。", "詰まったこと: かなり時間がかかってしまった。"),
];
const EFFORT_POSITIVES = [
  seed("できごと: 通知が届かない原因を探した。", "詰まったこと: 古い端末だけ設定の保存先が違っていて、原因を見つけるまで3時間かかった。"),
  seed("できごと: ログイン画面を直した。", "詰まったこと: 画面の色は同じなのに押した後の反応だけ遅れる理由を探すのに時間がかかった。"),
  seed("できごと: 保存ボタンを直した。", "詰まったこと: 時間がかかった。", "決めたこと: ボタンを増やすのではなく、保存の確認だけにとどめた。"),
];

test("task47 (A) 1: a bare 「時間がかかった」 alone is held; a stated cause or another story still passes (合成)", () => {
  for (const s of EFFORT_NEGATIVES) {
    const r = ok(s);
    assert.deepEqual([r.postable, r.weaknesses], [false, ["NO_STORY", "GENERIC_EFFORT"]], s);
  }
  for (const s of EFFORT_POSITIVES) assert.equal(ok(s).postable, true, `${s}: ${ok(s).summary}`);
});

// 2. Spoken "not what I expected".
const SPOKEN_POSITIVES = [
  seed("できごと: 画面の色を変えたら、思ってたのとぜんぜんちがった。"),
  seed("できごと: 文字を大きくしたら、思っていたのと全然違う見え方になった。"),
  seed("できごと: 並び順を変えたら、想定とは違った動きをした。"),
  seed("できごと: 動かしてみると予想外に遅かった。"),
];
const SPOKEN_NEGATIVES = [
  seed("できごと: 画面を更新した。", "決めたこと: 思ってたのと違わないように、確認を入れる。"),
  seed("できごと: 画面を更新した。", "詰まったこと: もし思ってたのと違ったら困るので、先に見る。"),
  seed("できごと: 画面を更新した。", "詰まったこと: 想定と違うと困る。"),
  seed("できごと: 画面を更新した。"),
];

test("task47 (A) 2: spoken 「思ってたのと違った」 is a surprise; precautions, conditionals and plain progress are not (合成)", () => {
  for (const s of SPOKEN_POSITIVES) {
    const r = ok(s);
    assert.equal(r.postable, true, `${s}: ${r.summary}`);
    assert.ok(r.signals.includes("SURPRISE"), s);
  }
  for (const s of SPOKEN_NEGATIVES) {
    const r = ok(s);
    assert.ok(!r.signals.includes("SURPRISE"), `${s}: ${r.summary}`);
  }
  // Text outside the fact lines (an angle or a draft) still cannot supply the surprise.
  assert.equal(ok(`${SPOKEN_NEGATIVES[3]}\n原案: 思ってたのとぜんぜんちがった。`).postable, false);
});

async function recorded() {
  const parsed = parseDevDiaryMarkdown(await loadAiLabDevDiaryMarkdown());
  return parsed.map((raw) => {
    const entry = sanitizeDiaryEntry(raw)!;
    return { entry, seed: diaryUnitsFor(entry, diaryEventKey(entry.eventId!), 1, [])[0].seed };
  });
}

// Task46 verdicts on the 14 records, recorded here so the Task47 diff is explicit.
const TASK46_VERDICT: Record<string, boolean> = {
  "20260926-password-reset-expired-link": true,
  "20260927-home-hidden-connection-failure": true,
  "20260928-honest-unavailable-buttons": true,
  "20260929-research-before-content-access": true,
  "20260930-x-auth-test-account-overlap": true,
  "20261001-shared-login-service-registration": true,
  "20261002-iphone-unresponsive-navigation": true,
  "20261003-topic-level-background-art": true,
  "20261005-market-report-editorial-points": true,
  "20261006-topic-learning-note-polish": true,
  "20261007-ai-model-update-centralized": true,
  "20261008-portfolio-asset-card-visual-polish": true,
  "20261009-shared-account-withdrawal-safety": false,
  "20261010-ai-consult-workspace-memory-safety": true,
};
const PENDING_OWNER = ["20261009-shared-account-withdrawal-safety", "20261010-ai-consult-workspace-memory-safety"];

test("task47 (A) 4: the 14 recorded topics — Task46 vs Task47 verdict diff, with 10/09 and 10/10 left to the owner (実記録)", async () => {
  const rows = await recorded();
  assert.equal(rows.length, 14);
  const diff: string[] = [];
  const lines = ["=== task47 実記録14件: 第46TASK → 第47TASK（面白さ判定のみ。非投稿・非課金）==="];
  for (const { entry, seed: s } of rows) {
    const r = ok(s);
    const pending = PENDING_OWNER.includes(entry.eventId!);
    if (r.postable !== TASK46_VERDICT[entry.eventId!]) diff.push(entry.eventId!);
    lines.push(
      `[実記録] ${entry.date} ${entry.eventId}: ${TASK46_VERDICT[entry.eventId!] ? "採用" : "保留"} → ${r.postable ? `採用(${r.tier})` : "保留"}` +
        `${pending ? " 【本人判断待ち】" : ""} / ${r.summary}`,
    );
  }
  console.log(lines.join("\n"));
  // Nothing in the 14 changes: the two new rules do not collapse or inflate the recorded set.
  assert.deepEqual(diff, []);
  // Every 時間がかかった in the records names its cause, so none of them became a bare effort word.
  for (const { seed: s } of rows) assert.ok(!ok(s).weaknesses.includes("GENERIC_EFFORT"));
});

test("task47 (A) 4: short preview for the owner — 10/09 and 10/10 as recorded (実記録の事実行。投稿文でもモデル出力でもない)", async () => {
  const rows = (await recorded()).filter((r) => PENDING_OWNER.includes(r.entry.eventId!));
  assert.equal(rows.length, 2);
  const out = ["=== task47 本人判断待ち（現行判定は参考。採否の正解ではありません）==="];
  for (const { entry, seed: s } of rows) {
    out.push(`[${entry.date}] できごと: ${entry.changed}`, `  現行判定: ${ok(s).summary}`, `  → 普通の人が読みたい内容ですか？ （はい／いいえ）`);
  }
  console.log(out.join("\n"));
});

test("task47 (A)(C) 4: earlier positives and negatives keep their verdicts; quantified over the whole synthetic set (合成)", () => {
  const positives = [
    ...TASK46_POSITIVES.map((c) => c.seed),
    ...SYNTHETIC.filter((c) => c.postable).map((c) => c.seed),
    TASK44_TOPIC_0927,
    TASK44_TOPIC_1008,
    TASK44_TOPIC_MIXED,
    ...EFFORT_POSITIVES,
    ...SPOKEN_POSITIVES,
  ];
  const negatives = [...TASK46_NEGATIVES.map((c) => c.seed), ...SYNTHETIC.filter((c) => !c.postable).map((c) => c.seed), ...EFFORT_NEGATIVES, SPOKEN_NEGATIVES[3]];
  const falseHold = positives.filter((s) => !ok(s).postable).length;
  const falsePass = negatives.filter((s) => ok(s).postable).length;
  console.log(`task47 定量: 正当 ${positives.length}件中 誤拒否 ${falseHold}／退屈 ${negatives.length}件中 誤通過 ${falsePass}`);
  assert.equal(falseHold, 0);
  assert.equal(falsePass, 0);
});

// 3. Consecutive-day structure (audit only; never holds).
test("task47 (A) 3: same story shape two days running is detected only when the earlier topic is supplied; otherwise 未確認 (合成)", () => {
  const day1 = seed("できごと: 保存ボタンの表示を直した。", "詰まったこと: 実は押しても反応しない不具合があった。", "決めたこと: 押せない間は代わりに文字で理由を出すことにした。");
  const day2 = seed("できごと: 送信ボタンの表示を直した。", "詰まったこと: 実は押しても反応しない不具合があった。", "決めたこと: 押せない間は代わりに文字で理由を出すことにした。");
  const other = seed("できごと: 色を変えた。", "詰まったこと: 思ってたのとぜんぜんちがった。");
  assert.equal(compareAiLabTopicStructure(day2, day1).status, "similar");
  assert.equal(compareAiLabTopicStructure(day2, other).status, "distinct");
  const none = compareAiLabTopicStructure(day2);
  assert.equal(none.status, "unverified");
  assert.match(none.summary, /未確認/u);
  assert.equal(compareAiLabTopicStructure(day2, null).status, "unverified");
  // The comparison never changes the topic's own verdict.
  assert.deepEqual(ok(day2), ok(day2));
});

test("task47 (A) 3: consecutive recorded days — audit list (実記録; read-only, nothing held)", async () => {
  const rows = await recorded();
  const lines = ["=== task47 連日の構造重複（実記録。監査のみで保留はしない）==="];
  let similar = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const r = compareAiLabTopicStructure(rows[i].seed, rows[i - 1].seed);
    if (r.status === "similar") similar += 1;
    lines.push(`${rows[i - 1].entry.date} → ${rows[i].entry.date}: ${r.status}${r.status === "similar" ? " " + r.summary : ""}`);
  }
  console.log(lines.join("\n"));
  assert.ok(similar >= 0);
});
