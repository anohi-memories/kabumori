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

// Task41: source → draft → rewrite grounding for the synthetic (合成・手書き) cases. No provider is called.
import {
  AI_LAB_SOURCE_GROUNDING_REJECTED,
  prepareAiLabVoiceRewrite,
  ungroundedClaims,
  wordingSimilarity,
} from "./ai_lab_voice_rewrite.ts";

const TAG = "\n\n#個人開発";
const caseOf = (prefix: string) => SYNTHETIC.find((c) => c.id.startsWith(prefix))!;
const rewriteOf = (c: { seed: string; draft?: string }, text: string, draft = c.draft! + TAG) =>
  prepareAiLabVoiceRewrite({ brandId: "ai_salaryman_lab", postType: "brand_post", text: draft }, c.seed)
    .validate({ decision: "rewritten", text, edits: [] });
const verdict = (run: () => unknown) => {
  try {
    run();
    return "通過";
  } catch (e) {
    return (e as Error).message;
  }
};

test("task41 (1): each postable synthetic draft and preview is grounded and is a real rewrite of the draft", () => {
  const lines = ["=== task41 合成・手書き 出典→原案→自然化（非課金。実モデル出力ではない・本人の文体PASSではない）==="];
  for (const c of SYNTHETIC.filter((x) => x.postable)) {
    assert.ok(c.draft && c.preview && c.paraphrases?.length, c.id);
    assert.deepEqual(ungroundedClaims(c.draft + TAG, c.seed), [], c.id);
    assert.deepEqual(ungroundedClaims(c.preview + TAG, c.seed), [], c.id);
    assert.ok(wordingSimilarity(c.draft, c.preview) < 0.85, c.id);
    assert.deepEqual(rewriteOf(c, c.preview + TAG), { text: c.preview + TAG, decision: "edited" }, c.id);
    lines.push(
      `[合成・手書き] ${c.id}`,
      `  題材: ${c.seed.replaceAll("\n", " / ")}`,
      `  原案: ${c.draft}`,
      `  自然化（通過）: ${c.preview}`,
      ...c.paraphrases.map((p) => `  言い換え: ${p}`),
    );
  }
  console.log(lines.join("\n"));
});

test("task41 (2): a rewrite identical to the draft is still a sameness hold, not a pass", () => {
  for (const c of SYNTHETIC.filter((x) => x.postable)) {
    assert.throws(() => rewriteOf(c, c.preview + TAG, c.preview + TAG), /AI_LAB_VOICE_REWRITE_REJECTED/, c.id);
  }
});

test("task41 (1): a plain 決めたこと verb grounds only its own 「〜ことにした」, never a finished action", () => {
  const s1 = caseOf("S1").seed;
  assert.deepEqual(ungroundedClaims("使ってないサブスクを1つだけ解約することにした。", s1), []);
  for (
    const [text, why] of [
      ["使ってないサブスクを1つだけ解約した。", "解約した（済んだとは書いていない）"],
      ["使ってないサブスクを1つだけ解約しました。", "丁寧形の解約しました"],
      ["使ってないサブスクを1つだけ解約するようにした。", "するようにした（実施済みとも読める）"],
      ["使ってないサブスクを1つだけ見直すことにした。", "別の動詞"],
      ["使ってないサブスクを解約する前に1つだけ見直すことにした。", "決めたことの語はあるが別の動詞"],
      ["使ってない動画を1つだけ解約することにした。", "決めたことの語（サブスク）が無い"],
      ["サブスクを1つだけ解約することにした。動画も1つ解約することにした。", "決定が二つ"],
      ["使ってないサブスクを1つだけ解約することにしました。動画も1つ解約することにしました。", "丁寧形の決定が二つ"],
    ] as const
  ) {
    assert.notDeepEqual(ungroundedClaims(text, s1), [], why);
  }
  assert.notDeepEqual(ungroundedClaims("鞄の定位置を決めた。", caseOf("S7").seed), []);
  assert.notDeepEqual(ungroundedClaims("消す前にバックアップを取った。", caseOf("S2").seed), []);
  assert.notDeepEqual(ungroundedClaims("押したらボタンを無効にした。", caseOf("S6").seed), []);
  assert.notDeepEqual(ungroundedClaims("押したらボタンを無効にするようにした。", caseOf("S6").seed), []);
  // Lines that do not state a plain decision ground nothing (fail closed).
  // A longer verb phrase is not read as a plain decision either: it stays held for review.
  for (const line of ["まだ解約しない。", "解約するか迷っている。", "解約します。", "サブスクは解約しないでおく。"]) {
    const verb = line.replace(/^.*?(解約[^。]*)。$/u, "$1");
    for (const text of ["サブスクを解約することにした。", `サブスクは${verb}ことにした。`]) {
      assert.notDeepEqual(ungroundedClaims(text, `決めたこと: ${line}`), [], line + " / " + text);
    }
  }
  // An できごと line is not a decision.
  assert.notDeepEqual(ungroundedClaims("サブスクを解約することにした。", "できごと: サブスクを解約する。"), []);
  // A past action the topic itself states is still fine.
  assert.deepEqual(ungroundedClaims("サブスクを解約した。", "できごと: サブスクを解約した。\n決めたこと: サブスクを解約する。"), []);
});

test("task41 (3): digit counts must come from the topic; links, tags and structured ids are not counts", () => {
  const s6 = caseOf("S6").seed;
  assert.deepEqual(ungroundedClaims("同じ投稿が２件できてた。", s6), []);
  assert.notDeepEqual(ungroundedClaims("同じ投稿が3件できてた。", s6), []);
  assert.notDeepEqual(ungroundedClaims("同じ投稿が2件できてた。直すのに2日かかった。", s6), []);
  assert.deepEqual(ungroundedClaims("同じ投稿が2件できてた。\n#個人開発2 https://example.test/9", s6), []);
});

const S7_PREVIEW = caseOf("S7").preview!;
const s7Negatives: readonly [string, string, RegExp][] = [
  ["時期（昨日）", "昨日" + S7_PREVIEW, /REJECTED/],
  ["人物（同僚）", S7_PREVIEW.replace("気づいた", "同僚に言われて気づいた"), /REJECTED/],
  ["感情（焦った）", S7_PREVIEW.replace("気づいた。", "気づいて焦った。"), /REJECTED/],
  ["思惑（つもり）", S7_PREVIEW.replace("決めることにした", "決めるつもり"), /REJECTED/],
  ["予定（次回）", S7_PREVIEW.replace("鞄の", "次回から鞄の"), /REJECTED/],
  ["数値（2回）", S7_PREVIEW.replace("置き忘れて", "2回置き忘れて"), /REJECTED/],
  ["出来事（合鍵）", S7_PREVIEW.replace("決めることにした。", "決めることにした。帰りに合鍵も作った。"), /REJECTED/],
  ["他ブランド（かぶモリ）", S7_PREVIEW.replace("家の鍵", "かぶモリの家の鍵"), /REJECTED/],
  ["決定の断定（決めた）", S7_PREVIEW.replace("決めることにした", "決めた"), /AI_LAB_SOURCE_GROUNDING_REJECTED/],
  ["題材に無い言い換え（コンビニ）", S7_PREVIEW.replace("会社に着いてから", "コンビニに寄ってから"), /AI_LAB_SOURCE_GROUNDING_REJECTED/],
];

for (const [why, text, pattern] of s7Negatives) {
  test(`task41 (3) hold: S7 rewrite that adds ${why}`, () => {
    assert.notEqual(text, S7_PREVIEW);
    assert.throws(() => rewriteOf(caseOf("S7"), text + TAG), pattern);
  });
}

test("task41 (3): drafts that claim a finished action, an unstated decision or a new count never reach the editor", () => {
  const holds: readonly [string, string][] = [
    ["S1", "家計を見直して、使っていないサブスクを1つだけ解約しました。"],
    ["S1", "家計を見直して、家計簿アプリを入れることにしました。"],
    ["S1", "固定費を3つ一覧にしてみた。"],
    ["S7", "家の鍵を玄関に置き忘れた。鞄の定位置を決めました。"],
  ];
  const lines = ["=== task41 拒否例（合成・手書き。原案段階で保留）==="];
  for (const [id, draft] of holds) {
    const c = caseOf(id);
    assert.throws(
      () => prepareAiLabVoiceRewrite({ brandId: "ai_salaryman_lab", postType: "brand_post", text: draft + TAG }, c.seed),
      new RegExp(AI_LAB_SOURCE_GROUNDING_REJECTED),
      draft,
    );
    lines.push(`[合成・手書き] ${id} 原案: ${draft} → 保留 ${ungroundedClaims(draft, c.seed).join(" / ")}`);
  }
  lines.push("=== task41 拒否例（合成・手書き。自然化段階で保留）===");
  for (const [why, text] of s7Negatives) {
    lines.push(`[合成・手書き] S7 ${why}: ${text} → ${verdict(() => rewriteOf(caseOf("S7"), text + TAG))}`);
  }
  console.log(lines.join("\n"));
});

test("task41 (5): existing protected strings and the Task32 counts still hold in a grounded rewrite", () => {
  const c = caseOf("S2");
  const base = c.preview!;
  for (
    const text of [
      base.replace("5分", "５分"),
      base.replace("5分", "10分"),
      base.replace("戻せた。", "戻せた？"),
      base + "「戻せた」",
    ]
  ) {
    assert.throws(() => rewriteOf(c, text + TAG), /REJECTED/, text);
  }
  assert.throws(() => rewriteOf(c, base), /REJECTED/, "dropped tag");
});

// Task42: remaining grounding gaps (合成・手書き). No provider is called; nothing is posted.
import {
  TASK42_DRAFT_KNOWN_GAPS,
  TASK42_DRAFT_NEGATIVES,
  TASK42_DRAFT_POSITIVES,
  TASK42_REWRITE_NEGATIVES,
  TASK42_REWRITE_POSITIVES,
} from "./ai_lab_topic_quality_fixtures.ts";

const draftVerdict = (id: string, text: string) =>
  verdict(() =>
    prepareAiLabVoiceRewrite({ brandId: "ai_salaryman_lab", postType: "brand_post", text: text + TAG }, caseOf(id).seed)
  );

test("task42 (B): drafts that add an event, action, person, feeling, plan, result, resolve, verdict, thing or count hold before the editor", () => {
  const lines = ["=== task42 原案段階（合成・手書き。実モデル出力ではない）==="];
  for (const c of TASK42_DRAFT_NEGATIVES) {
    assert.equal(draftVerdict(c.id, c.text), AI_LAB_SOURCE_GROUNDING_REJECTED, c.why);
    lines.push(`[保留] ${c.id} ${c.why}: ${c.text} → ${ungroundedClaims(c.text, caseOf(c.id).seed).join(" / ")}`);
  }
  for (const c of [...TASK42_DRAFT_POSITIVES, ...SYNTHETIC.filter((x) => x.draft).map((x) => ({ id: x.id.slice(0, 2), text: x.draft!, why: "Task41の原案" }))]) {
    assert.deepEqual(ungroundedClaims(c.text, caseOf(c.id).seed), [], c.why);
    assert.equal(draftVerdict(c.id, c.text), "通過", c.why);
    lines.push(`[通過] ${c.id} ${c.why}: ${c.text}`);
  }
  for (const c of TASK42_DRAFT_KNOWN_GAPS) {
    // Documented limits: not detected today. If one starts holding, move it to the negatives.
    assert.equal(draftVerdict(c.id, c.text), "通過", c.why);
    lines.push(`[未検出の限界] ${c.id} ${c.why}: ${c.text}`);
  }
  console.log(lines.join("\n"));
});

test("task42 (A): rewrites that add a lone-kanji place, thing or person, or a kanji count, hold; legitimate rewrites pass", () => {
  const lines = ["=== task42 自然化段階（合成・手書き。実モデル出力ではない）==="];
  for (const c of TASK42_REWRITE_NEGATIVES) {
    const result = verdict(() => rewriteOf(caseOf(c.id), c.text + TAG));
    assert.equal(result, AI_LAB_SOURCE_GROUNDING_REJECTED, c.why);
    lines.push(`[保留] ${c.id} ${c.why}: ${c.text} → ${result}`);
  }
  for (const c of TASK42_REWRITE_POSITIVES) {
    assert.ok(wordingSimilarity(caseOf(c.id).draft!, c.text) < 0.85, c.why);
    assert.deepEqual(rewriteOf(caseOf(c.id), c.text + TAG), { text: c.text + TAG, decision: "edited" }, c.why);
    lines.push(`[通過] ${c.id} ${c.why}: ${c.text}`);
  }
  console.log(lines.join("\n"));
});

test("task42 (A): a lone kanji is only a noun before a particle; stems, adverbs and grounded nouns pass", () => {
  const s7 = caseOf("S7");
  // 置き・忘れ・着い・気づ are stems; 家 is in the topic; 後で・特に are adverbs.
  assert.deepEqual(rewriteOf(s7, s7.preview! + TAG).decision, "edited");
  assert.deepEqual(
    rewriteOf(s7, "家の鍵を玄関に置き忘れて、会社に着いてから気づいた。特に鞄の定位置を決めることにした。" + TAG).decision,
    "edited",
  );
  // The same character anywhere in the draft or topic licenses it (家 in 「家の鍵」).
  assert.throws(() => rewriteOf(caseOf("S6"), "家で" + caseOf("S6").preview! + TAG), new RegExp(AI_LAB_SOURCE_GROUNDING_REJECTED));
});

test("task42 (C): counts compare by value across 1/１/一/ひとつ; idioms and ids are not counts", () => {
  const s1 = caseOf("S1").seed;
  const s6 = caseOf("S6").seed;
  for (const text of ["サブスクを１つだけ解約することにした。", "サブスクを一つだけ解約することにした。", "サブスクをひとつだけ解約することにした。"]) {
    assert.deepEqual(ungroundedClaims(text, s1), [], text);
  }
  assert.deepEqual(ungroundedClaims("同じ投稿が二件できていた。", s6), []);
  assert.deepEqual(ungroundedClaims("同じ投稿がふたつできていた。", s6), []);
  assert.deepEqual(ungroundedClaims("同じ投稿が三件できていた。", s6), ["三"]);
  assert.deepEqual(ungroundedClaims("サブスクをふたつ解約することにした。", s1), ["ふたつ"]);
  assert.deepEqual(ungroundedClaims("同じ投稿が2件できた。もう二回押せた。", s6), ["二"]);
  // Not counts: list, identity, distributive, idioms, a kanji word before the numeral.
  for (
    const text of [
      "固定費を一覧にした。",
      "同一の投稿が2件できた。",
      "第三回の投稿が2件できた。",
      "固定費をひとつずつ見直した。",
      "固定費を一つ一つ見直した。",
      "固定費は十分に見直した。",
      "一時的に固定費を見直した。",
    ]
  ) {
    assert.deepEqual(ungroundedClaims(text, s1 + "\n" + s6), [], text);
  }
  // A kanji or kana 1 against the topic alone is the idiomatic singular; 2 and more are compared.
  assert.deepEqual(ungroundedClaims("家計もひとつ見直した。", s1.replace("1つだけ", "")), []);
  // Tags, URLs and structured ids carry no count, and stay byte-exact through the rewrite.
  assert.deepEqual(ungroundedClaims("固定費を見直した。\n#一日一善 https://example.test/2 {\"id\":3}", s1), []);
});

test("task42 (C): protected strings stay byte-exact; a rewrite cannot turn a digit into kana or change a tag or quote", () => {
  const c = caseOf("S1");
  const base = c.preview!;
  for (
    const [text, draft] of [
      [base.replace("1つだけ", "ひとつだけ"), c.draft! + TAG],
      [base.replace("1つだけ", "一つだけ"), c.draft! + TAG],
      [base + "\n\n#一日二善", c.draft! + "\n\n#一日一善"],
      [base.replace("固定費", "「固定費」二回"), c.draft!.replace("固定費", "「固定費」一回")],
      [base + "\n\nhttps://example.test/2", c.draft! + "\n\nhttps://example.test/1"],
    ] as const
  ) {
    assert.throws(() => rewriteOf(c, text.endsWith(TAG) || text.includes("#") ? text : text + TAG, draft), /REJECTED/, text);
  }
  // A kanji count the draft has may be reworded with the same value only.
  const s6 = caseOf("S6");
  assert.equal(rewriteOf(s6, s6.preview! + TAG).decision, "edited");
  assert.throws(() => rewriteOf(s6, s6.preview!.replace("もう一回", "もう二回") + TAG), new RegExp(AI_LAB_SOURCE_GROUNDING_REJECTED));
});

test("task42 (B): every recorded diary seed grounds its own fact lines (実記録, no false hold)", async () => {
  const markdown = await loadAiLabDevDiaryMarkdown();
  let checked = 0;
  for (const raw of parseDevDiaryMarkdown(markdown)) {
    const entry = sanitizeDiaryEntry(raw);
    assert.ok(entry?.eventId);
    const unit = diaryUnitsFor(entry, diaryEventKey(entry.eventId), 1, [])[0];
    const facts = unit.seed.split("\n").filter((line) => /^(?:できごと|詰まったこと)[:：]/u.test(line))
      .map((line) => line.replace(/^[^:：]+[:：]\s*/u, ""));
    for (const fact of facts) {
      assert.deepEqual(ungroundedClaims(fact, unit.seed), [], `${entry.eventId}: ${fact}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 14, String(checked));
  console.log(`[実記録] 日記の できごと/詰まったこと ${checked}行を、そのまま原案にしても保留しない（題材の語だけの文）。`);
});
