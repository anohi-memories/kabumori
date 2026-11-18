// Task54: where the grounding guard stands on the Task53 10/09 and 10/10 texts.
// Allowed: retellings that keep what the topic says. Held: anything that adds
// an act, a finished state, an experience, a feeling or a number.
import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareAiLabVoiceRewrite,
  ungroundedClaims,
} from "./ai_lab_voice_rewrite.ts";
import {
  DRAFT_1009,
  DRAFT_1010,
  REWRITE_1009,
  REWRITE_1010,
  SOURCE_1009,
  SOURCE_1010,
} from "./ai_lab_live_compare_fixtures.ts";

const DECIDED_1010 = "順番を入れ替えたテストで確かめて、アカウント名だけじゃなく「今開いてる相談への返事か」を見てから画面に出すことにした。";
const DESIGN_1009 = "「削除しました」も本当に消えたか確かめてから出すようにしてる。";

function rewriteVerdict(draft: string, text: string, source: string) {
  const { validate } = prepareAiLabVoiceRewrite({
    brandId: "ai_salaryman_lab",
    postType: "brand_post",
    text: draft,
  }, source);
  try {
    return validate({ decision: "rewritten", text, edits: [] }).decision;
  } catch (error) {
    return (error as Error).message;
  }
}

test("task54 10/10 allowed: the Task53 draft retells 「決めたこと」 with everyday words", () => {
  // Basis: 決めたこと「アカウントの名前が同じかだけでなく、「今開いている相談なのか」を
  // 確認してから返事を画面へ表示する。」 — 確認 → 見て, 表示する → 出す, every other
  // word of the clause (今開・相談・返事・画面) is in the sentence.
  assert.deepEqual(ungroundedClaims(DRAFT_1010, SOURCE_1010), []);
  assert.deepEqual(ungroundedClaims(DECIDED_1010, SOURCE_1010), []);
  // The plain verb itself still grounds it (Task41/44 path unchanged).
  assert.deepEqual(
    ungroundedClaims(DECIDED_1010.replace("出す", "表示する"), SOURCE_1010),
    [],
  );
});

test("task54 10/10 held: another act, a negated act, a missing word, a habit or a finished state", () => {
  for (
    const [label, text] of [
      // 「出す」 is not 「消す」: the act must be the decision's own.
      ["other act", DECIDED_1010.replace("出す", "消す")],
      // Keeps the words and flips the act.
      ["negated act", DECIDED_1010.replace("見てから", "見ずに")],
      ["negated check", "アカウント名だけじゃなく今開いてる相談かを確かめずに返事を画面に出すことにした。"],
      ["negative decision", DECIDED_1010.replace("出すことにした", "出さないことにした")],
      // 返事 is gone: no longer the topic's decision.
      ["missing word", "アカウント名だけじゃなく今開いてる相談かを見てから画面に出すことにした。"],
      // A plain decision is not a built design, so no 「ようにしてる」 habit.
      ["decision as habit", DECIDED_1010.replace("出すことにした", "出すようにしてる")],
      ["recent habit", "最近は今開いてる相談への返事かを見てから画面に出すようにしてる。"],
      // Decided, not reported as done in the decision's own verb.
      ["decision as done", "今開いている相談なのかを確認してから返事を画面へ表示した。"],
      ["decision as done (polite)", "今開いている相談なのかを確認してから返事を画面へ表示しました。"],
    ] as const
  ) {
    assert.ok(ungroundedClaims(text, SOURCE_1010).length > 0, label);
  }
});

test("task54 10/09 allowed: the Task53 rewrite's 「ようにしてる」 retells the draft's 「作りにしてる」", () => {
  // Basis: 決めたこと「…削除したと表示する前に結果を確認する設計にした。」 states a
  // finished design; the draft says 「…確認してから表示する作りにしてる」. The rewrite
  // keeps 削除・確認(確かめ)・表示(出す) and only 結果 is said as 「消えたか」.
  assert.deepEqual(ungroundedClaims(DRAFT_1009, SOURCE_1009), []);
  assert.deepEqual(ungroundedClaims(REWRITE_1009, SOURCE_1009), []);
  assert.deepEqual(ungroundedClaims(DESIGN_1009, SOURCE_1009), []);
  assert.equal(rewriteVerdict(DRAFT_1009, REWRITE_1009, SOURCE_1009), "edited");
});

test("task54 10/09 held: a habit, a finished prototype, a done deletion, an experience, a feeling or a number", () => {
  for (
    const [label, text] of [
      ["daily habit", "毎日「削除しました」も本当に消えたか確かめてから出すようにしてる。"],
      ["recent habit", "最近は消えたか確かめてから出すようにしてる。"],
      // The verb before ようにして is not the design's act.
      ["other act", "「削除しました」も本当に消えたか確かめてから消すようにしてる。"],
      ["negated check", "「削除しました」も消えたか確かめずに出すようにしてる。"],
      // 試作 → 完成 / 公開
      ["prototype as finished", "別々に選べる画面を完成させた。"],
      ["prototype as shipped", "別々に選べる画面を公開した。"],
      ["prototype as released", "削除の画面を本番に入れた。"],
      // 確認前 → 削除済み
      ["deletion done", "共通アカウントを丸ごと削除した。"],
      ["deletion done (kana)", "アカウントのデータを全部消した。"],
      ["deletion done (state)", "共通アカウントはもう削除済み。"],
      // Experience, feeling, number the topic does not record.
      ["experience", "最初は退会ボタンは1つで足りると思ってた。"],
      ["feeling", "片方のデータまで消えそうで怖かった。"],
      ["number", "削除の順番を3回作り直した。"],
    ] as const
  ) {
    assert.ok(ungroundedClaims(text, SOURCE_1009).length > 0, label);
  }
  // A quoted screen text, a condition and a reported label are not a done deletion.
  assert.deepEqual(
    ungroundedClaims("「削除しました」って出す前に結果を確認する。", SOURCE_1009),
    [],
  );
  assert.deepEqual(ungroundedClaims("片方のデータまで消したら困る。", SOURCE_1009), []);
});

test("task54 10/09 rewrite held: 「ようにしてる」 only retells a draft that already said how it is built", () => {
  // The same rewrite against a draft without 「作りにしてる」 adds the state.
  const draftWithoutDesign = DRAFT_1009.replace(
    "あと「削除しました」って出す前に、ちゃんと消えたか結果を確認してから表示する作りにしてる。",
    "あと「削除しました」って出す前に、ちゃんと消えたか結果を確認する。",
  );
  assert.notEqual(draftWithoutDesign, DRAFT_1009);
  assert.equal(
    rewriteVerdict(draftWithoutDesign, REWRITE_1009, SOURCE_1009),
    "AI_LAB_VOICE_REWRITE_REJECTED",
  );
  // A design statement grounds one retelling, not a second habit.
  const twice = REWRITE_1009.replace(
    "だからアプリごとの利用終了とアカウント全体の削除ははっきり分けた。",
    "だからアプリごとの利用終了とアカウント全体の削除は分けるようにしてる。",
  );
  assert.notEqual(twice, REWRITE_1009);
  assert.notEqual(rewriteVerdict(DRAFT_1009, twice, SOURCE_1009), "edited");
  // Under 10/10's plain decision, the same move is a decision retold as built.
  assert.ok(
    ungroundedClaims(DECIDED_1010.replace("出すことにした", "出すようにしてる"), SOURCE_1010)
      .includes("ようにして"),
  );
});

test("task54 voice contract unchanged on the accepted 10/09 rewrite", () => {
  for (
    const [label, text, expected] of [
      // Task37: a polite ending the draft did not have.
      ["polite", REWRITE_1009.replace("出すようにしてる。", "出すようにしています。"), "AI_LAB_VOICE_STYLE_REJECTED"],
      // A period right before 笑.
      ["。笑", REWRITE_1009.replace("いけなくて😂", "いけなかった。笑"), "AI_LAB_VOICE_STYLE_REJECTED"],
      // 「私」 the draft did not have.
      ["私", REWRITE_1009.replace("だから", "だから私は"), "AI_LAB_VOICE_REWRITE_REJECTED"],
      // A second new emoji.
      ["emoji", REWRITE_1009.replace("分けた。", "分けた😊😊"), "AI_LAB_VOICE_REWRITE_REJECTED"],
      // The hashtag is protected.
      ["tag", REWRITE_1009.replace("#個人開発", "#開発"), "AI_LAB_VOICE_REWRITE_REJECTED"],
    ] as const
  ) {
    assert.notEqual(text, REWRITE_1009, label);
    const verdict = rewriteVerdict(DRAFT_1009, text, SOURCE_1009);
    assert.notEqual(verdict, "edited", label);
    if (expected) assert.match(verdict, /AI_LAB_(VOICE|SOURCE)_/u, label);
  }
});

test("task57 10/10 allowed: a free retelling of the draft grounded in the topic reaches edited", () => {
  // Hand-written fixture, not a model text. Basis per sentence: docs/operations/ai-lab-compare-operation-id-1010-grounding-20261118.md
  assert.deepEqual(ungroundedClaims(REWRITE_1010, SOURCE_1010), []);
  for (const sentence of REWRITE_1010.match(/[^。\n]+/gu)!) {
    assert.deepEqual(ungroundedClaims(sentence, SOURCE_1010), [], sentence);
  }
  assert.equal(rewriteVerdict(DRAFT_1010, REWRITE_1010, SOURCE_1010), "edited");
  // The decision keeps 確認(見て)→表示(出す), 今開・相談・返事・画面, and stays a decision (ことにした).
  assert.match(REWRITE_1010, /「今開いてる相談への返事か」まで見てから画面に出すことにした。/u);
});

test("task57 10/10 held: the same retelling with a changed fact is not edited", () => {
  for (
    const [label, from, to] of [
      ["unchecked", "まで見てから画面に出す", "を見ずに画面に出す"],
      ["shipped", "混ざらないよう直した。", "混ざらないよう直して公開した。"],
      ["finished", "混ざらないよう直した。", "混ざらないよう直して完成させた。"],
      ["to everyone", "混ざらないよう直した。", "混ざらないよう直して全員に配った。"],
      ["habit", "画面に出すことにした。", "画面に出すようにしてる。"],
      ["number", "後から届くかもしれなかった。", "後から3回届いた。"],
      ["person", "とはいかないんだよね。", "とはいかないんだよね。上司にも言われた。"],
      ["feeling", "とはいかないんだよね。", "とはいかなくて怖かった。"],
    ] as const
  ) {
    const text = REWRITE_1010.replace(from, to);
    assert.notEqual(text, REWRITE_1010, label);
    assert.notEqual(rewriteVerdict(DRAFT_1010, text, SOURCE_1010), "edited", label);
  }
});
