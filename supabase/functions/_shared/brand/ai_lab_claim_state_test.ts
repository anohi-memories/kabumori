// Task60: the claim-state prototype against the 10/09 and 10/10 topics, the
// texts that passed so far, every counter-example of AutoReview #717 and
// right retellings (done work, hypothesis + measure, 体言止め, polite and
// casual). Each case names the source state, the candidate state, the
// decision and the source span the decision stands on. The old guard
// (ungroundedClaims) is run on the same cases only to measure the difference.
// No network, no model, nothing posted.
import assert from "node:assert/strict";
import test from "node:test";
import { type ClaimDecision, type ClaimState, judgeClaimStates, readClaims } from "./ai_lab_claim_state.ts";
import { ungroundedClaims } from "./ai_lab_voice_rewrite.ts";
import {
  DRAFT_1009,
  DRAFT_1010,
  REWRITE_1009,
  REWRITE_1010,
  SOURCE_1009,
  SOURCE_1010,
} from "./ai_lab_live_compare_fixtures.ts";

interface Case {
  id: string;
  group: "current" | "review717" | "right" | "hypothesis";
  source: string;
  candidate: string;
  event: string;
  expected_claim_state: ClaimState | "ABSENT";
  candidate_claim_state: ClaimState;
  expected_decision: ClaimDecision;
  evidence_span: string;
  /** Task59 held these four right sentences on its conservative rule. */
  task59_held_right?: true;
  /** A right sentence the prototype holds on purpose (recorded false stop). */
  known_false_stop?: true;
}

const S10 = SOURCE_1010;
const S09 = SOURCE_1009;
const E_POSSIBLE = "古いAIの返事が後から届く可能性があった";
const E_MIXED = "前の相談内容や覚えた設定が別の相談に混ざらないよう直した";
const E_SHOWN = "確認してから返事を画面へ表示する";
const E_TESTED = "順番を入れ替えたテストで確かめた";
const E_SENT = "同じ保存を二重に送らないようにした";
const E_DELETE = "誤って消さないようにする";
const E_SPLIT = "共通アカウント全体の削除をはっきり分け";

const c = (
  id: string,
  group: Case["group"],
  source: string,
  candidate: string,
  event: string,
  expected: Case["expected_claim_state"],
  cand: ClaimState,
  decision: ClaimDecision,
  span: string,
  extra: Partial<Case> = {},
): Case => ({
  id,
  group,
  source,
  candidate,
  event,
  expected_claim_state: expected,
  candidate_claim_state: cand,
  expected_decision: decision,
  evidence_span: span,
  ...extra,
});

export const CLAIM_STATE_CASES: readonly Case[] = [
  // --- texts that passed so far (whole posts) ---
  c("draft-1010", "current", S10, DRAFT_1010, "表示する", "DECIDED", "DECIDED", "PASS_CANDIDATE", E_SHOWN),
  c("rewrite-1010", "current", S10, REWRITE_1010, "確認する", "DONE", "DONE", "PASS_CANDIDATE", E_TESTED),
  c("draft-1009", "current", S09, DRAFT_1009, "削除する", "PREVENTION", "POSSIBLE", "PASS_CANDIDATE", E_DELETE),
  // Held by the old guard on 「ようにしてる」; here on 「分けた」 (a decided design retold as done).
  c("rewrite-1009", "current", S09, REWRITE_1009, "分ける", "DECIDED", "DONE", "REJECT", E_SPLIT),

  // --- AutoReview #717 and Task58/59 counter-examples (must never pass) ---
  c("decided-to-done", "review717", S10, "だから今開いてる相談への返事か見てから画面に出した。", "表示する", "DECIDED", "DONE", "REJECT", E_SHOWN),
  c("decided-to-done-polite", "review717", S10, "返事を画面に表示しました。", "表示する", "DECIDED", "DONE", "REJECT", E_SHOWN),
  c("decided-to-done-1009", "review717", S09, "結果を確かめてから「削除しました」と表示した。", "表示する", "DECIDED", "DONE", "REJECT", "削除したと表示する前に結果を確認する設計にした"),
  c("possible-to-happened", "review717", S10, "古いAIの返事が後から届いて混ざった。", "届く", "POSSIBLE", "DONE", "REJECT", E_POSSIBLE),
  c("possible-to-happened-casual", "review717", S10, "前の返事が後から届いたんだよね。", "届く", "POSSIBLE", "DONE", "REJECT", E_POSSIBLE),
  c("prevented-polite-fail", "review717", S10, "前の相談が混ざってしまうのを防げませんでした。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("prevented-kirenai", "review717", S10, "前の相談が混ざってしまうのを止めきれなかった。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("prevented-progressive-neg", "review717", S10, "前の相談が混ざってしまうのを防いでいなかった。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("prevented-then-not", "review717", S10, "前の相談が混ざってしまうのを防げたので、安心していたが、実際は防げていなかった。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("prevented-seemed-then-not", "review717", S10, "前の相談が混ざってしまうのを防げたようだったが、実際は防げていなかった。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("prepared-result-occurred", "review717", S10, "後から届いて混ざるときに備えて、確認を足したが、結局前の返事が出ていた。", "表示する", "DECIDED", "DONE", "REJECT", E_SHOWN),
  c("prepared-too-late", "review717", S10, "後から届いて混ざるときに備えて、確認を足したが、間に合わなかった。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("nda-comma-past", "review717", S10, "後から届いて混ざるとまずいんだ、前に一度名前が違って出ちゃったから。", "表示する", "DECIDED", "DONE", "REJECT", E_SHOWN),
  c("hearsay-after-condition", "review717", S10, "後から届いて混ざると、前の返事が出たらしい。", "表示する", "DECIDED", "UNKNOWN", "HOLD", E_SHOWN),
  c("te-wa-ita", "review717", S10, "前の相談が混ざってはいた。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("te-mo-ita", "review717", S10, "後から届いてもいた。", "届く", "POSSIBLE", "DONE", "REJECT", E_POSSIBLE),
  c("te-kara-past", "review717", S10, "古い返事が届いてから、名前が変わった。", "届く", "POSSIBLE", "DONE", "REJECT", E_POSSIBLE),
  c("dict-prevent-fail", "review717", S10, "前の相談が混ざるのを防げなかった。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("habitual-occurs", "review717", S10, "後から届いて混ざるときもある。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("completive-casual", "review717", S10, "前の相談が混ざっちゃった。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("prevent-fail-shiki", "review717", S10, "前の相談が混ざってしまうのを防ぐことに失敗した。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("prevent-could-not", "review717", S10, "前の相談が混ざってしまわないようにできなかった。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("prevent-wanted-late", "review717", S10, "前の相談が混ざってしまうのを防ぐようにしたかったが、間に合わなかった。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("prevent-intent-only", "review717", S10, "前の相談が混ざってしまうのを防いだつもりだった。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("prevent-seemed", "review717", S10, "前の相談が混ざってしまうのを防いだように見えた。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("prevent-thought", "review717", S10, "前の相談が混ざってしまうのを防げた、と思っていた。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("prevent-question", "review717", S10, "前の相談が混ざってしまうのを防げた？", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("prepare-not", "review717", S10, "後から届いて混ざるときに備えていなかった。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("prepare-maybe", "review717", S10, "後から届いて混ざるときのためか、確認が入っていた。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("condition-noun-end", "review717", S10, "後から届いて混ざると、前の返事が出てきて冷や汗。", "表示する", "DECIDED", "UNKNOWN", "HOLD", E_SHOWN),
  c("decided-1009-deleted", "review717", S09, "片方のアプリのデータまで消してしまった。", "削除する", "PREVENTION", "DONE", "REJECT", E_DELETE),
  // Review #717 issue 1 family: only a later clause of the whole sentence shows the outcome.
  c("fixed-then-wrong-name", "review717", S10, "前の相談が混ざってしまわないよう直したので、安心していたが、結局名前が違っていた。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  // A present form says it is happening, which the prevented event is not.
  c("present-mixing", "review717", S10, "前の相談が混ざってる。", "混ざる", "PREVENTION", "DECIDED", "REJECT", E_MIXED),
  // AutoReview 6e6aeda9: a kanji right before the verb, subjectless failures,
  // 「と」 as a past discovery, null readings, reasons, labels.
  c("r2-kanji-before", "review717", S10, "前の相談が混ざらないよう直しました。前に一度混ざった。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("r2-kekkyoku", "review717", S10, "結局出た。", "表示する", "DECIDED", "DONE", "REJECT", E_SHOWN),
  c("r2-kikanakatta", "review717", S10, "前の相談が混ざってしまうのを防いだけど、効かなかった。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("r2-umaku", "review717", S10, "混ざらないよう直したが、うまくいかなかった。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("r2-dame", "review717", S10, "混ざらないよう直したのに、ダメだった。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("r2-osokatta", "review717", S10, "後から届いて混ざるときに備えて、確認を足したが、遅かった。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("r2-to-discovery", "review717", S10, "古い返事が後から届くと、別の人の名前になった。", "届く", "POSSIBLE", "UNKNOWN", "HOLD", E_POSSIBLE),
  c("r2-really", "review717", S10, "後から届く可能性があったが、本当に起きた。", "届く", "POSSIBLE", "UNKNOWN", "HOLD", E_POSSIBLE),
  c("r2-noga-fail", "review717", S10, "前の相談が混ざらないよう直した。前の相談が混ざるのが防げなかった。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("r2-noga-found", "review717", S10, "前の相談が混ざらないよう直した。混ざってしまうのが見つかった。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("r2-jitai", "review717", S10, "前の相談が混ざらないよう直した。混ざる事態が起きた。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("r2-hajimeta", "review717", S10, "前の相談が混ざらないよう直した。混ざり始めた。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  c("r2-iwareta", "review717", S10, "前の相談が混ざらないよう直した。前の返事が出たと言われた。", "表示する", "DECIDED", "UNKNOWN", "HOLD", E_SHOWN),
  c("r2-habit-reason", "review717", S10, "前の相談がよく混ざるので、ずっと困っていた。", "混ざる", "PREVENTION", "UNKNOWN", "HOLD", E_MIXED),
  c("r2-colon", "review717", S10, "前の相談が混ざった：原因は古い返事。", "混ざる", "PREVENTION", "DONE", "REJECT", E_MIXED),
  // A fix the topic never names for that event.
  c("invented-fix", "review717", S10, "後から届くのを防いだ。", "届く", "POSSIBLE", "PREVENTION", "HOLD", E_POSSIBLE),
  c("negated-check", "review717", S10, "今開いてる相談かを確かめずに返事を画面に出すことにした。", "確認する", "DONE", "UNKNOWN", "HOLD", E_TESTED),

  // --- right retellings: done work, polite, casual, 体言止め ---
  c("fixed-polite", "right", S10, "前の相談が混ざらないよう直しました。", "混ざる", "PREVENTION", "PREVENTION", "PASS_CANDIDATE", E_MIXED),
  c("fixed-casual", "right", S10, "前の相談が混ざらないように直したんだよね。", "混ざる", "PREVENTION", "PREVENTION", "PASS_CANDIDATE", E_MIXED),
  c("fixed-noun-end", "right", S10, "前の相談が混ざらないよう修正。", "混ざる", "PREVENTION", "PREVENTION", "PASS_CANDIDATE", E_MIXED),
  c("tested-noun-end", "right", S10, "順番を入れ替えたテストで確認済み。", "確認する", "DONE", "DONE", "PASS_CANDIDATE", E_TESTED),
  c("tested-done", "right", S10, "順番を入れ替えたテストでも確かめた。", "確認する", "DONE", "DONE", "PASS_CANDIDATE", E_TESTED),
  c("prevented-done", "right", S10, "前の相談が混ざってしまうのを防いだ。", "混ざる", "PREVENTION", "PREVENTION", "PASS_CANDIDATE", E_MIXED),
  c("prevented-polite", "right", S10, "前の相談が混ざってしまうのを防げました。", "混ざる", "PREVENTION", "PREVENTION", "PASS_CANDIDATE", E_MIXED),
  // Review 6e6aeda9: a later past without an object may be the outcome, so
  // 「安心した」 is held too (safe-side false stop, counted in measure()).
  c("prevented-relief", "right", S10, "前の相談が混ざってしまうのを防いだので、安心した。", "混ざる", "PREVENTION", "UNKNOWN", "PASS_CANDIDATE", E_MIXED, { known_false_stop: true }),
  c("prevent-decided", "right", S10, "前の相談が混ざってしまうのを防ぐことにしました。", "混ざる", "PREVENTION", "PREVENTION", "PASS_CANDIDATE", E_MIXED),
  c("sent-twice-stopped", "right", S10, "同じ保存が二重に送られるのも止めた。", "送る", "PREVENTION", "PREVENTION", "PASS_CANDIDATE", E_SENT),
  c("decided-casual", "right", S10, "返事を画面に出すことにしたんだ。", "表示する", "DECIDED", "DECIDED", "PASS_CANDIDATE", E_SHOWN),
  c("possible-kept", "right", S10, "後から届いて、混ざるかもしれなかった。", "届く", "POSSIBLE", "POSSIBLE", "PASS_CANDIDATE", E_POSSIBLE),

  // --- hypothesis + measure (no claim that it happened) ---
  c("prepared", "hypothesis", S10, "後から届いて混ざるときに備えて、確認を足した。", "混ざる", "PREVENTION", "PREVENTION", "PASS_CANDIDATE", E_MIXED),
  c("prepared-for", "hypothesis", S10, "後から届いて混ざるときのために、確認を足した。", "混ざる", "PREVENTION", "PREVENTION", "PASS_CANDIDATE", E_MIXED),
  c("cond-tame-decide", "hypothesis", S10, "後から届いて混ざると別の人の名前が出るため、確認を足すことにする。", "混ざる", "PREVENTION", "POSSIBLE", "PASS_CANDIDATE", E_MIXED),
  c("cond-aratamete", "hypothesis", S10, "後から届いて混ざると、あらためて確かめることになる。", "混ざる", "PREVENTION", "POSSIBLE", "PASS_CANDIDATE", E_MIXED),
  c("cond-polite-response", "hypothesis", S10, "後から届いて混ざると困りますので、確認を足しました。", "混ざる", "PREVENTION", "POSSIBLE", "PASS_CANDIDATE", E_MIXED),
  c("cond-result-measure", "hypothesis", S10, "後から届いて混ざると前の返事が出てしまうので、順番を確かめるようにした。", "表示する", "DECIDED", "POSSIBLE", "PASS_CANDIDATE", E_SHOWN),
  c("t59-thought", "hypothesis", S10, "後から届いて混ざるとまずいと思った。", "混ざる", "PREVENTION", "POSSIBLE", "PASS_CANDIDATE", E_MIXED, { task59_held_right: true }),
  c("t59-kara", "hypothesis", S10, "後から届いて混ざると困るから、画面に出す前に確かめるようにした。", "混ざる", "PREVENTION", "POSSIBLE", "PASS_CANDIDATE", E_MIXED, { task59_held_right: true }),
  c("t59-tame", "hypothesis", S10, "後から届いて混ざると困るため、画面に出す前に確かめるようにした。", "表示する", "DECIDED", "DECIDED", "PASS_CANDIDATE", E_SHOWN, { task59_held_right: true }),
  c("t59-node", "hypothesis", S10, "後から届いて混ざるとまずいので、順番を入れ替えたテストで確かめた。", "確認する", "DONE", "DONE", "PASS_CANDIDATE", E_TESTED, { task59_held_right: true }),
];

function judgementFor(item: Case) {
  const result = judgeClaimStates(item.candidate, item.source);
  return { result, j: result.judgements.find((j) => j.event === item.event) };
}

test("task60: every case keeps its source state, candidate state, decision and evidence span", () => {
  for (const item of CLAIM_STATE_CASES) {
    assert.ok(item.source.includes(item.evidence_span), `${item.id}: evidence_span is not in the source`);
    const { result, j } = judgementFor(item);
    assert.ok(j, `${item.id}: no judgement for ${item.event} (${JSON.stringify(result)})`);
    assert.equal(j.sourceState, item.expected_claim_state, `${item.id}: source state`);
    assert.equal(j.candidateState, item.candidate_claim_state, `${item.id}: candidate state (${j.reason})`);
    const actual = item.known_false_stop ? "HOLD" : item.expected_decision;
    assert.equal(result.decision, actual, `${item.id}: decision ${JSON.stringify(result.judgements)}`);
    assert.ok(j.evidence.includes(item.evidence_span), `${item.id}: evidence ${j.evidence}`);
    assert.ok(j.reason.length > 0, `${item.id}: a reason is given`);
  }
});

test("task60: decided→done, possible→happened and prevented→failed never pass", () => {
  for (const item of CLAIM_STATE_CASES.filter((x) => x.group === "review717")) {
    assert.notEqual(judgeClaimStates(item.candidate, item.source).decision, "PASS_CANDIDATE", item.id);
  }
});

test("task60: the topics read as the states they state", () => {
  const states = (text: string) =>
    Object.fromEntries(readClaims(text).map((m) => [`${m.event}:${m.span}`, m.state]));
  assert.deepEqual(states(SOURCE_1010), {
    "混ざる:混ざらない": "PREVENTION",
    "直す:直した": "DONE",
    "送る:送らない": "PREVENTION",
    "届く:届く": "POSSIBLE",
    "確認する:確かめた": "DONE",
    "確認する:確認して": "DECIDED",
    "表示する:表示する": "DECIDED",
  });
  assert.deepEqual(states(SOURCE_1009), {
    "試作する:試作した": "DONE",
    "削除する:消さない": "PREVENTION",
    "分ける:分け": "DECIDED",
    "表示する:表示する": "DECIDED",
    "確認する:確認する": "DECIDED",
  });
});

test("task60: nothing to check, or an untracked new event alone, is held", () => {
  assert.equal(judgeClaimStates("前の返事が出ていた", SOURCE_1010).decision, "REJECT");
  assert.equal(judgeClaimStates("冷や汗。", SOURCE_1010).decision, "HOLD");
  assert.equal(judgeClaimStates("サーバーが落ちた。", SOURCE_1010).decision, "HOLD");
  // An event the topic does not name at all.
  assert.equal(judgeClaimStates("試作した。", SOURCE_1010).decision, "HOLD");
});

// The measurement for the product decision. "should pass" = expected
// PASS_CANDIDATE. Old guard: any ungroundedClaims hit = HOLD.
export function measure() {
  const rows = CLAIM_STATE_CASES.map((item) => {
    const shouldPass = item.expected_decision === "PASS_CANDIDATE";
    const next = judgeClaimStates(item.candidate, item.source).decision === "PASS_CANDIDATE";
    const old = ungroundedClaims(item.candidate, item.source).length === 0;
    return { item, shouldPass, next, old };
  });
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  const right = count((r) => r.shouldPass);
  return {
    total: rows.length,
    should_pass: right,
    should_stop: rows.length - right,
    new_false_pass: count((r) => !r.shouldPass && r.next),
    new_false_stop: count((r) => r.shouldPass && !r.next),
    new_reach: count((r) => r.shouldPass && r.next),
    old_false_pass: count((r) => !r.shouldPass && r.old),
    old_false_stop: count((r) => r.shouldPass && !r.old),
    old_reach: count((r) => r.shouldPass && r.old),
    task59_four_old_held: count((r) => !!r.item.task59_held_right && !r.old),
    task59_four_new_passed: count((r) => !!r.item.task59_held_right && r.next),
    old_false_pass_ids: rows.filter((r) => !r.shouldPass && r.old).map((r) => r.item.id),
    old_false_stop_ids: rows.filter((r) => r.shouldPass && !r.old).map((r) => r.item.id),
  };
}

test("task60: measured against the old guard (no dangerous pass, the Task59 four reached)", () => {
  const m = measure();
  console.log(JSON.stringify(m));
  assert.equal(m.new_false_pass, 0);
  assert.equal(m.new_false_stop, CLAIM_STATE_CASES.filter((x) => x.known_false_stop).length);
  assert.equal(m.task59_four_new_passed, 4);
});
