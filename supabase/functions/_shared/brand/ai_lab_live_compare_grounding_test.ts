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

// Task58: the two fact changes Task57 found the guard let through. Both are
// built from REWRITE_1010 and must be held with the grounding code.
const GROUNDING = "AI_LAB_SOURCE_GROUNDING_REJECTED";

test("task58 held: a decision retold as done and a possibility retold as an event", () => {
  for (
    const [label, from, to, words] of [
      ["decision → done (出す)", "画面に出すことにした。", "画面に出した。", ["出した"]],
      ["decision → done (polite)", "画面に出すことにした。", "画面に出しました。", ["出しました"]],
      ["decision → done (見せる)", "画面に出すことにした。", "画面に見せた。", ["見せた"]],
      ["possible → occurred", "後から届くかもしれなかった。", "後から届いて別の画面に混ざった。", ["届いて", "混ざった"]],
      ["possible → arrived", "後から届くかもしれなかった。", "後から届いた。", ["届いた"]],
      ["prevented → occurred", "後から届くかもしれなかった。", "後から届くかもしれなくて混ざった。", ["混ざった"]],
    ] as const
  ) {
    const text = REWRITE_1010.replace(from, to);
    assert.notEqual(text, REWRITE_1010, label);
    const found = ungroundedClaims(text, SOURCE_1010);
    for (const word of words) assert.ok(found.includes(word), `${label}: ${found}`);
    // The polite form is refused earlier, by the plain-voice check.
    const expected = label.includes("polite") ? "AI_LAB_VOICE_STYLE_REJECTED" : GROUNDING;
    assert.equal(rewriteVerdict(DRAFT_1010, text, SOURCE_1010), expected, label);
  }
});

test("task58 allowed: retellings that keep the decision, the possibility and what was really done", () => {
  for (
    const [label, from, to] of [
      ["fixture as is", "", ""],
      ["checked then shown", "まで見てから画面に出すことにした。", "を確認してから画面に出す。"],
      ["possibility kept", "後から届くかもしれなかった。", "後から届く可能性があった。"],
      ["arrival kept possible", "後から届くかもしれなかった。", "後から届いて混ざるかもしれなかった。"],
      ["could arrive", "後から届くかもしれなかった。", "後から届くこともあり得た。"],
      ["fixed (done in the topic)", "混ざらないよう直した。", "混ざらないように直した。"],
      ["stopped (done in the topic)", "同じ保存が二重に送られるのも止めた。", "同じ保存が二重に送られないようにもした。"],
      ["tested (done in the topic)", "順番を入れ替えたテストでも確かめた。", "順番を入れ替えたテストで確かめた。"],
    ] as const
  ) {
    const text = from ? REWRITE_1010.replace(from, to) : REWRITE_1010;
    assert.notEqual(from ? text : "", from ? REWRITE_1010 : "x", label);
    assert.deepEqual(ungroundedClaims(text, SOURCE_1010), [], label);
    assert.equal(rewriteVerdict(DRAFT_1010, text, SOURCE_1010), "edited", label);
  }
  // 10/09: 「分けた」 and the design are done in the topic; the draft keeps them.
  assert.deepEqual(ungroundedClaims(DRAFT_1009, SOURCE_1009), []);
  assert.deepEqual(ungroundedClaims(DRAFT_1010, SOURCE_1010), []);
});

test("task58 boundary: another verb or an unasserted form is not the decision done", () => {
  for (
    const sentence of [
      "前の相談を思い出した。",
      "画面に出したら混ざるかもしれなかった。",
      "画面に出したくなかった。",
      "後から届いたら別の相談に混ざるかもしれなかった。",
    ]
  ) {
    const found = ungroundedClaims(sentence, SOURCE_1010);
    assert.ok(!found.includes("出した"), `${sentence}: ${found}`);
    assert.ok(!found.includes("届いた"), `${sentence}: ${found}`);
  }
  for (
    const sentence of [
      "後から届いても混ざらない。",
      "後から届いてないか確かめた。",
      "返事が届いてから今の相談か確かめる。",
    ]
  ) {
    const found = ungroundedClaims(sentence, SOURCE_1010);
    assert.ok(!found.includes("届いて"), `${sentence}: ${found}`);
  }
});

// Task58 review (AutoReview rv-g6-grounding-decision-hypothesis-d693809e): a
// dropped particle, a possibility before the event, and 「ちゃった」 are still
// the event; a possibility after it, and 「見た目」 under a 「確認する」 decision,
// are not.
test("task58 review: casual and mixed-mood retellings", () => {
  for (
    const [label, from, to, word] of [
      ["dropped particle (decision)", "画面に出すことにした。", "画面出した。", "出した"],
      ["dropped particle (event)", "返事が後から届くかもしれなかった。", "返事後から届いた。", "届いた"],
      ["ちゃった", "後から届くかもしれなかった。", "後から届いちゃった。", "届いちゃっ"],
      ["possibility before the event", "後から届くかもしれなかった。", "後から届くかもと思ったら届いた。", "届いた"],
      ["possibility then occurred, no comma", "後から届くかもしれなかった。", "後から届く可能性があったが実際に混ざった。", "混ざった"],
    ] as const
  ) {
    const text = REWRITE_1010.replace(from, to);
    assert.notEqual(text, REWRITE_1010, label);
    const found = ungroundedClaims(text, SOURCE_1010);
    assert.ok(found.includes(word), `${label}: ${found}`);
    assert.notEqual(rewriteVerdict(DRAFT_1010, text, SOURCE_1010), "edited", label);
  }
  const kept = REWRITE_1010.replace("後から届くかもしれなかった。", "後から届いて、混ざるかもしれなかった。");
  assert.deepEqual(ungroundedClaims(kept, SOURCE_1010), []);
  const confirmTopic = SOURCE_1010.replace(
    /決めたこと: .*/u,
    "決めたこと: 返事を画面へ出す前に、今開いている相談かを確認する。",
  ).replace("見た目は同じアカウントでも、", "");
  for (const sentence of ["見た目は同じでも今開いてる相談か確認する。", "そんな返事は見たことない。"]) {
    const found = ungroundedClaims(sentence, confirmTopic);
    assert.ok(!found.includes("見た") && !found.includes("見ました"), `${sentence}: ${found}`);
  }
});

// Task58 review 2 (AutoReview rv-g6-grounding-decision-hypothesis-f3618e33).
test("task58 review 2: a possibility after a finished clause, the act done in the topic, and conditions", () => {
  const closed = REWRITE_1010.replace(
    "後から届くかもしれなかった。",
    "後から届いて別の相談に混ざったから、名前だけでは大丈夫とはいえないかもしれない。",
  );
  const found = ungroundedClaims(closed, SOURCE_1010);
  assert.ok(found.includes("届いて") && found.includes("混ざった"), `${found}`);
  for (
    const sentence of [
      "後から届いて、混ざるかもしれなかった。",
      "後から届いて混ざると困る。",
      "相談を送って返事を待つ間に切り替えると混ざるかもしれない。",
      "後から届いちゃったら混ざる。",
    ]
  ) {
    const claims = ungroundedClaims(sentence, SOURCE_1010);
    assert.ok(
      !claims.some((word) => /^(?:届い|混ざっ|送っ)/u.test(word)),
      `${sentence}: ${claims}`,
    );
  }
  // 「確認する」 decided, 「確認した」 reported: 「確かめた」 is the act done; 「見ました」 is never read as it.
  const confirmTopic = [
    "開発日記（2026-10-10、昨日の出来事）より。",
    "できごと: 送信の前に宛先をテストで確認した。",
    "決めたこと: 送る前に宛先を確認する。",
  ].join("\n");
  for (const sentence of ["宛先をテストで確かめた。", "宛先の夢を見ました。"]) {
    const claims = ungroundedClaims(sentence, confirmTopic);
    assert.ok(!claims.includes("確かめた") && !claims.includes("見ました"), `${sentence}: ${claims}`);
  }
  const undone = confirmTopic.replace("できごと: 送信の前に宛先をテストで確認した。", "できごと: 送信画面を直した。");
  assert.ok(ungroundedClaims("宛先を確かめた。", undone).includes("確かめた"));
});

// Task58 review 3 (AutoReview rv-g6-grounding-decision-hypothesis-670c1d0a).
test("task58 review 3: a condition with a past result, and retold preventions", () => {
  const occurred = /^(?:届い|混ざっ|送っ)/u;
  // A condition whose result is past reports the event (review 3 issue 1).
  for (
    const sentence of [
      "後から届いて混ざると、前の相談の返事が出てきた。",
      "後から届いて別の相談に混ざったら、名前が違っていた。",
      "後から届いて、使い物にならなかった。",
      "後から届いて混ざるときがあった。",
      "後から届いて混ざるという不具合が出た。",
      "前の相談が別の相談に混ざってしまった。",
      // 「〜るとき」「ならない」 are not conditions even with a present result.
      "後から届いて混ざるときもある。",
      "後から届いて、使い物にならない。",
    ]
  ) {
    const claims = ungroundedClaims(sentence, SOURCE_1010);
    assert.ok(claims.some((word) => occurred.test(word)), `${sentence}: ${claims}`);
  }
  // Retold preventions and real conditions keep the topic (review 3 issue 2).
  // Task59: a condition followed by a past response is held (see the task59 test).
  for (
    const sentence of [
      "前の相談が別の相談に混ざってしまわないよう直した。",
      "前の相談が混ざってしまうのを防いだ。",
      "前の相談が混ざってほしくない。",
      "同じ保存を二重に送ってしまわないようにした。",
      "後から届いて混ざると困るんだよね。",
      "後から届いて混ざったら困る。",
      "後から届いて混ざるとまた面倒になる。",
    ]
  ) {
    const claims = ungroundedClaims(sentence, SOURCE_1010);
    assert.ok(!claims.some((word) => occurred.test(word)), `${sentence}: ${claims}`);
  }
});

// Task58 review 4 (AutoReview rv-g6-grounding-decision-hypothesis-b359917a).
test("task58 review 4: failed preventions and reactions after a link, reasons and preparations", () => {
  const occurred = /^(?:届い|混ざっ|送っ)/u;
  for (
    const sentence of [
      "前の相談が混ざってしまうのを防げなかった。",
      "前の相談が混ざってしまうのを止められなかった。",
      "前の相談が混ざってしまうのを避けられなかった。",
      "後から届いて混ざると、前の返事が出てくるので焦った。",
      "後から届いて混ざると、前の返事が出てきて、名前も違うし、困った。",
    ]
  ) {
    const claims = ungroundedClaims(sentence, SOURCE_1010);
    assert.ok(claims.some((word) => occurred.test(word)), `${sentence}: ${claims}`);
  }
  for (
    const sentence of [
      "後から届いて混ざるときに備えて、確認を足した。",
      "前の相談が混ざってしまうのを防いだ。",
      "前の相談が混ざってしまうのを止めた。",
    ]
  ) {
    const claims = ungroundedClaims(sentence, SOURCE_1010);
    assert.ok(!claims.some((word) => occurred.test(word)), `${sentence}: ${claims}`);
  }
});

// Task59 (AutoReview rv-g6-grounding-decision-hypothesis-5ba88544, review 5):
// an ambiguous retelling of a possibility or prevention is held, never passed.
test("task59: ambiguous possibility and prevention retellings are held", () => {
  const occurred = /^(?:届い|混ざっ|送っ)/u;
  for (
    const sentence of [
      // Review 5 issue 2 and the task: polite and auxiliary negatives.
      "前の相談が混ざってしまうのを防げませんでした。",
      "前の相談が混ざってしまうのを止められませんでした。",
      "前の相談が混ざってしまうのを防げていなかった。",
      "前の相談が混ざってしまうのを止めきれなかった。",
      "前の相談が混ざってしまうのを防いでいなかった。",
      "前の相談が混ざってしまうのを防いだつもりだった。",
      "前の相談が混ざってしまうのを止めたかった。",
      // Review 5 issue 3: a hypothetical result and a past response are held.
      "後から届いて混ざると前の返事が出てしまうので、順番を確かめるようにした。",
      "後から届いて混ざると困りますので、確認を足しました。",
      "後から届いて混ざるとまずいですから、確認を足した。",
      "後から届いて混ざるとまずいことになるので、確認を足した。",
      "後から届いて混ざると困るから、画面に出す前に確かめるようにした。",
      "後から届いて混ざると困るため、画面に出す前に確かめるようにした。",
      "後から届いて混ざるとまずいので、順番を入れ替えたテストで確かめた。",
      "後から届いて混ざるとまずいと思った。",
      // Review 5 issue 4: 「あとから」 does not cut the result short.
      "後から届いて混ざると、あとから直すのが面倒なので先に確かめるようにした。",
      // Review 5 issue 5: only the exact preparation passes.
      "後から届いて混ざるときのためか、確認が入っていた。",
      // The task: 「届くかもしれなかった」 retold as an event; a habit is not a possibility.
      "後から届いて混ざった。",
      "後から届いて混ざるときもある。",
      // Task59 review 1: failures after a prevention, loose endings, no preparation.
      "前の相談が混ざってしまうのを防ぐことに失敗した。",
      "前の相談が混ざってしまうのを防ぐようにはできなかった。",
      "前の相談が混ざってしまうのを防ぐようにしたかったが、間に合わなかった。",
      "前の相談が混ざってしまわないようにできなかった。",
      "前の相談が混ざってしまうのを防げたようだったが、実際は防げていなかった。",
      "前の相談が混ざってしまうのを防いだように見えた。",
      "前の相談が混ざってしまうのを防げた、と思っていた。",
      "前の相談が混ざってしまうのを防げた？",
      "後から届いて混ざるときに備えていなかった。",
      "後から届いて混ざるときのためにはなっていなかった。",
    ]
  ) {
    const claims = ungroundedClaims(sentence, SOURCE_1010);
    assert.ok(claims.some((word) => occurred.test(word)), `${sentence}: ${claims}`);
  }
  for (
    const sentence of [
      // Review 5 issue 1: the link 「ため」 itself is not a past ending.
      "後から届いて混ざると別の人の名前が出るため、確認を足すことにする。",
      "後から届いて混ざると、あらためて確かめることになる。",
      "後から届いて混ざるときに備えて、確認を足した。",
      "後から届いて混ざるときのために、確認を足した。",
      "前の相談が混ざってしまうのを防いだ。",
      "前の相談が混ざってしまうのを防げました。",
      "前の相談が混ざってしまうのを止めた。",
      "前の相談が混ざってしまうのを防ぐようにした。",
      "前の相談が混ざってしまうのを防ぐことにしました。",
      "前の相談が混ざってしまうのを防いだので、安心した。",
      "後から届いて、混ざるかもしれなかった。",
    ]
  ) {
    const claims = ungroundedClaims(sentence, SOURCE_1010);
    assert.ok(!claims.some((word) => occurred.test(word)), `${sentence}: ${claims}`);
  }
});
