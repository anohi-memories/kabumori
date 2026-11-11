// A案 (2026-10-14, Phase 2): a move whose reason no news confirms is written as ゆめちゃん's own view, not as "the reason
// cannot be confirmed". The guards are not weakened: an asserted cause without news is still removed, a cause stated by
// the news is still a fact, and an invented number inside a view is still removed. Offline only.
import assert from "node:assert/strict";
import test from "node:test";
import {
  codeFallbacks,
  FACT_INSTRUCTIONS,
  type GeneratedAnalysis,
  generateSharedAnalysis,
  generationRequestBody,
  MAX_MODEL_CALLS,
  qualityRewriteHints,
  reasonAbsenceSentences,
  type Requester,
  speculativeCausalSentences,
  unitChecker,
  unsupportedCausalSentences,
} from "./analysis_logic.ts";
import { sanitizeAnalysis } from "./unit_sanitizer.ts";
import { inputOf, loadFixture, rich0917, richMorning1001 } from "./test_support.ts";

const close0917 = await loadFixture("close_2026-09-17");
const close0918 = await loadFixture("close_2026-09-18");
const morning1001 = await loadFixture("morning_2026-10-01");
const input0917 = inputOf(close0917);

const withJapan = (analysis: GeneratedAnalysis, japan: string): GeneratedAnalysis => ({ ...analysis, app_story: { ...analysis.app_story!, japan_ja: japan } });

test("the prompt asks for her view instead of 'no reason'; one short 'はっきりした材料は見当たりません' at most, followed by her view", () => {
  for (const input of [inputOf(morning1001), input0917]) {
    const prompt = String(generationRequestBody(input, []).instructions);
    assert.ok(prompt.includes("「理由は確認できません」「理由を示すニュースは見当たりません」と書く代わりに、ゆめちゃんの見立て（仮説）として理由を書きます"));
    assert.ok(prompt.includes("「材料ははっきりしませんが、私は円高が重しになったとみています」"));
    assert.ok(prompt.includes("見立ての言い方は毎回変え"));
    assert.ok(prompt.includes("「はっきりした材料は見当たりません」を短く1回まで書いてよく、その場合も続けてゆめちゃんの見方を書きます"));
    assert.ok(prompt.includes("その文（「理由は確認できない」など）を x_post・app_story・market_summary_ja の本文にそのまま書き写しません"), "insufficient_evidence stays internal");
    assert.ok(prompt.includes("見立ての中でも、入力に無い数値・日付・ニュース・発表は作らず"));
    for (const gone of ["理由が確認できないことを書くのは1回だけにします", "理由が確認できないことを正直に", "東京市場の値動きの理由を説明するニュースは確認できません"]) {
      assert.ok(!prompt.includes(gone), `no longer handed to the model: ${gone}`);
    }
    // The fact line is unchanged.
    assert.ok(prompt.includes("すでに起きた値動きの理由は、入力のニュースが理由として明記している（causal の claim がある）場合だけ事実として書きます"));
  }
});

test("the Fact check treats her reading of a past move as a view, and an asserted cause as before", () => {
  assert.ok(FACT_INSTRUCTIONS.includes("「材料ははっきりしませんが、私は〜が重しになったとみています」"));
  assert.ok(FACT_INSTRUCTIONS.includes("理由を事実として断定した文（「〜を受けて下落しました」など）は、これまでどおり問題にします"));
});

test("her view of a reason is speculative: never removed, recorded as advisory (each wording she may use)", () => {
  const base = rich0917(input0917);
  for (const sentence of [
    // Each one names a cause in a form the causal guard reads (が支えに / が追い風に / が響い ...) for a market move.
    "材料ははっきりしませんが、私は円安が支えになって東京市場が上がったとみています。",
    "円安が追い風になって東京市場が上がったのかもしれません。",
    "円安が支えになって東京市場が上がったように見えます。",
    "私は、円安が響いて東京市場が上がった気がしています。",
    "円安が支えになって東京市場が上がったのではないかと思います。",
    "東京市場は、円安が追い風になっていそうです。",
    "私は、円安が支えになって東京市場が上がったと読んでいます。",
  ]) {
    const analysis = withJapan(base, sentence);
    assert.deepEqual(unsupportedCausalSentences(analysis, input0917), [], sentence);
    assert.ok(speculativeCausalSentences(analysis, input0917).length > 0, `recorded as a view: ${sentence}`);
    const kept = sanitizeAnalysis(analysis, input0917, (claims) => unitChecker(input0917, claims), codeFallbacks(input0917));
    assert.ok(kept.analysis.app_story!.japan_ja.includes(sentence.replace(/。$/u, "")), `delivered: ${sentence}`);
  }
});

test("an asserted cause without news is still removed (the line A案 does not move)", () => {
  const asserted = withJapan(rich0917(input0917), "円安を受けて東京市場は上昇しました。");
  assert.equal(unsupportedCausalSentences(asserted, input0917).length, 1);
  const kept = sanitizeAnalysis(asserted, input0917, (claims) => unitChecker(input0917, claims), codeFallbacks(input0917));
  assert.ok(!kept.analysis.app_story!.japan_ja.includes("円安を受けて"));
  assert.ok(kept.removed.some((unit) => unit.path.startsWith("app_story.japan_ja")));
});

test("a cause the news states (causal claim) stays a fact: not downgraded, not flagged", () => {
  const input = inputOf(close0918);
  const boj = input.news.find((news) => news.headline_ja.includes("日銀"))!;
  assert.ok(boj, "the 9/18 fixture has the BOJ item");
  const base = rich0917(input0917);
  const analysis: GeneratedAnalysis = {
    ...withJapan(base, "日銀の決定発表を受けて東京市場は上昇しました。"),
    claims: [{ claim_id: "c1", text_ja: boj.headline_ja, claim_type: "causal", evidence_refs: [boj.ref], scope: "today" }],
  };
  assert.deepEqual(unsupportedCausalSentences(analysis, input), []);
  assert.deepEqual(speculativeCausalSentences(analysis, input), [], "a confirmed cause is a fact, not a view");
});

test("an invented number or news inside her view is removed; the rest of the paragraph stays", () => {
  const view = "私は、円安が支えになって東京市場が上がったとみています。";
  const invented = "ドル円が165.00円まで動いたことも効いたのかもしれません。";
  const analysis = withJapan(rich0917(input0917), `${view}${invented}`);
  const kept = sanitizeAnalysis(analysis, input0917, (claims) => unitChecker(input0917, claims), codeFallbacks(input0917));
  assert.ok(kept.analysis.app_story!.japan_ja.includes("円安が支えになって東京市場が上がった"));
  assert.ok(!kept.analysis.app_story!.japan_ja.includes("165.00"));
  assert.ok(kept.removed.some((unit) => unit.code === "VALUE_NOT_IN_INPUT"));
});

test("'no reason' sentences in the body are counted; one is allowed, more are telemetry only (never a rewrite)", () => {
  const base = richMorning1001(inputOf(morning1001));
  const clean: GeneratedAnalysis = {
    ...base,
    market_summary_ja: "9月30日の東京市場は上昇しました。私は、半導体株の強さが支えになったとみています。",
    x_post: { ...base.x_post, context_ja: "日経平均は上がりました。私は半導体株の強さが支えだったとみています。", closing_ja: "あすも半導体株の動きが鍵になりそうです。" },
    app_story: Object.fromEntries(Object.keys(base.app_story!).map((key) => [key, ""])) as unknown as GeneratedAnalysis["app_story"],
  };
  assert.equal(reasonAbsenceSentences(clean), 0);
  const once = { ...clean, x_post: { ...clean.x_post, closing_ja: "はっきりした材料は見当たりませんが、私は半導体株に注目しています。" } };
  assert.equal(reasonAbsenceSentences(once), 1);
  const twice = { ...once, market_summary_ja: "上昇の理由は確認できません。" };
  assert.equal(reasonAbsenceSentences(twice), 2);
  assert.deepEqual(qualityRewriteHints(["REASON_ABSENCE_STATED:4"]), [], "telemetry: no extra model call");
});

test("the call budget is unchanged: an old-style 'no reason' draft costs one generation and one Fact call, never a rewrite", async () => {
  assert.equal(MAX_MODEL_CALLS, 4);
  const input = inputOf(morning1001);
  const calls: string[] = [];
  const draft = richMorning1001(input);
  assert.ok(reasonAbsenceSentences(draft) >= 2, "the pre-A案 fixture states 'no reason' more than once");
  const requester: Requester = (step) => {
    calls.push(step);
    return Promise.resolve({ payload: step === "fact" ? { passed: true, issues: [] } : draft, inputTokens: 1000, outputTokens: 400 });
  };
  const outcome = await generateSharedAnalysis(input, requester, () => new Date("2026-09-30T22:56:00Z"));
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, ["generate", "fact"]);
  assert.ok(outcome.ok && outcome.packet.fact.quality_warnings?.some((warning) => warning.startsWith("REASON_ABSENCE_STATED:")));
});
