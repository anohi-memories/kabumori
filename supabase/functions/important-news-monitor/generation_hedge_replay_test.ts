// Replay of the three 2026-09-29 BBC/Al Jazeera generation failures with their recorded drafts and
// checker issues. Model outputs after the first check are scripted: this proves the retry routing and
// the re-checks, not the model's wording.
import assert from "node:assert/strict";
import test from "node:test";
import {
  generateImportantNewsPost,
  type GenerationCandidate,
  type GenerationRunner,
  type GenerationStep,
  isOverAssertionFactIssue,
  isRetryableFactFailure,
  isRetryableVoiceFailure,
  requestGenerationStep,
} from "./post_generation_logic.ts";

const aj = (overrides: Partial<GenerationCandidate>): GenerationCandidate => ({
  id: "replay",
  sourceType: "breaking_market",
  sourceUrl: "https://www.aljazeera.com/news/2026/9/28/replay",
  sourceName: "al_jazeera",
  title: "t",
  bodySummary: "[単一ソース: Al Jazeera 記事（RSS見出し・本文要約）] s",
  companyName: null,
  companyCode: null,
  entityKey: "breaking:trigger:geopolitics",
  category: "geopolitics",
  publishedAt: "2026-09-28T16:00:00.000Z",
  importance: "important",
  affectedEntities: [],
  japanMarketRelevance: "low",
  judgementReason: "r",
  judgementFactStatus: "passed",
  status: "ready_for_generation",
  ...overrides,
});

function scripted(script: Array<{ step: GenerationStep; payload: unknown }>) {
  const calls: GenerationStep[] = [];
  let index = 0;
  const runner: GenerationRunner = (step) => {
    calls.push(step);
    const entry = script[index];
    if (!entry || entry.step !== step) throw new Error(`UNEXPECTED_STEP:${step} (expected ${entry?.step ?? "end"})`);
    index += 1;
    return Promise.resolve({ payload: entry.payload, model: "gpt-6-luna", inputTokens: 100, outputTokens: 50, estimatedCost: 0.0001 });
  };
  return { runner, calls };
}

// --- DMZ blast (Fact: over-assertion of "suspected") -----------------------------------------------

const DMZ = aj({
  title: "South Korea suspects North Korean mines behind DMZ blast",
  bodySummary: "[単一ソース: Al Jazeera 記事（RSS見出し・本文要約）] 本文冒頭: South Korea's military says an explosion that wounded three soldiers was likely caused by mines believed to have been recently planted by North Korean troops, according to a preliminary joint investigation with the UN Command.",
  sourceUrl: "https://www.aljazeera.com/news/2026/9/28/south-korea-suspects-north-korean-mines-behind-dmz-blast",
});
const DMZ_ISSUE = "「北朝鮮が最近設置した」と断定。元情報では北朝鮮軍が最近設置したとみられる地雷との説明にとどまる";

test("DMZ before: the recorded issue was not in any retryable Fact class; after: it is an over-assertion", () => {
  assert.equal(isOverAssertionFactIssue(DMZ_ISSUE), true);
  assert.equal(isRetryableFactFailure(DMZ, "【速報】本文", [DMZ_ISSUE]), true);
});

test("DMZ after: one hedge-restoring rewrite, then Fact and Voice pass", async () => {
  const { runner, calls } = scripted([
    { step: "draft", payload: { text: "韓国軍は、非武装地帯（DMZ）で軍人3人が負傷した爆発について、国連軍司令部との暫定調査で、北朝鮮が最近設置した地雷が原因の可能性が高いと判断したと発表しました。", sufficient_information: true, notes: [] } },
    { step: "fact", payload: { passed: false, issues: [DMZ_ISSUE] } },
    { step: "fact_retry", payload: { text: "韓国軍は、非武装地帯（DMZ）で軍人3人が負傷した爆発について、国連軍司令部との暫定調査で、北朝鮮軍が最近設置したとみられる地雷が原因の可能性が高いと発表しました。" } },
    { step: "fact", payload: { passed: true, issues: [] } },
    { step: "voice", payload: { passed: true, issues: [] } },
  ]);
  const result = await generateImportantNewsPost(DMZ, runner);
  assert.deepEqual(calls, ["draft", "fact", "fact_retry", "fact", "voice"]);
  assert.equal(result.factRetry.attempted, true);
  assert.equal(result.status, "ready_for_publish");
  assert.match(result.generatedText ?? "", /設置したとみられる地雷/);
});

// --- Iowa steel mill (Fact: over-assertion of "intends to build") ----------------------------------

const STEEL = aj({
  title: "Trump announces $15bn steel mill project in Iowa before US midterms",
  category: "us_government_policy",
  bodySummary: "[単一ソース: Al Jazeera 記事（RSS見出し・本文要約）] 本文冒頭: Minnesota-based Mesabi Metallics said it intends to build a $15bn steel mill in Iowa, with production planned to start in 2030.",
  sourceUrl: "https://www.aljazeera.com/economy/2026/9/28/trump-announces-15bn-steel-mill-project-in-iowa-before-us-midterms",
});
const STEEL_ISSUE = "建設主体の断定：元情報はMesabi Metallicsが建設する意向を示したとしており、建設が確定したとは述べていません。";

test("steel mill: over-assertion of an intention is retried once and re-checked; a failed re-check stays failed", async () => {
  assert.equal(isOverAssertionFactIssue(STEEL_ISSUE), true);
  const ok = scripted([
    { step: "draft", payload: { text: "トランプ大統領、アイオワ州に150億ドルの製鉄所計画を発表。建設するのは、ミネソタ州を拠点とするMesabi Metallicsです。生産開始は2030年を予定しています。", sufficient_information: true, notes: [] } },
    { step: "fact", payload: { passed: false, issues: [STEEL_ISSUE] } },
    { step: "fact_retry", payload: { text: "トランプ大統領、アイオワ州に150億ドルの製鉄所計画を発表。ミネソタ州を拠点とするMesabi Metallicsが建設する意向を示しています。生産開始は2030年の予定です。" } },
    { step: "fact", payload: { passed: true, issues: [] } },
    { step: "voice", payload: { passed: true, issues: [] } },
  ]);
  const passed = await generateImportantNewsPost(STEEL, ok.runner);
  assert.equal(passed.status, "ready_for_publish");
  assert.match(passed.generatedText ?? "", /建設する意向/);

  const recheckFails = scripted([
    { step: "draft", payload: { text: "Mesabi Metallicsがアイオワ州に製鉄所を建設します。生産開始は2030年を予定しています。", sufficient_information: true, notes: [] } },
    { step: "fact", payload: { passed: false, issues: [STEEL_ISSUE] } },
    { step: "fact_retry", payload: { text: "Mesabi Metallicsがアイオワ州に製鉄所を建設します。生産開始は2030年を予定しています。" } },
    { step: "fact", payload: { passed: false, issues: [STEEL_ISSUE] } },
  ]);
  const failed = await generateImportantNewsPost(STEEL, recheckFails.runner);
  assert.deepEqual(recheckFails.calls, ["draft", "fact", "fact_retry", "fact"], "one retry only, no Voice after a failed re-check");
  assert.equal(failed.status, "generation_failed");
});

test("wrong numbers, people, companies, dates, events and market claims are still not retried as over-assertions", () => {
  for (const issue of [
    "金額を150億ドルと断定しているが元情報は15億ドルの可能性",
    "企業名の取り違え：建設主体をNucorと断定",
    "日付の誤り：2030年と断定しているが元情報は2031年の予定",
    "事実誤認：爆発を北朝鮮の攻撃と断定（元情報は地雷の疑い）",
    "日本株への影響を断定しているが元情報は可能性にとどまる",
    "断定が強い",
  ]) {
    assert.equal(isOverAssertionFactIssue(issue), false, issue);
  }
  assert.equal(isRetryableFactFailure(STEEL, "t", [STEEL_ISSUE, "数値の誤り"]), false, "every issue must be retryable");
});

// --- Starship (Voice: restated closing + meta sentence about the input) -----------------------------

const STARSHIP = aj({
  title: "SpaceX’s showpiece Starship rocket reaches orbit for first time",
  category: "other_market_moving",
  sourceUrl: "https://www.aljazeera.com/news/2026/9/28/spacexs-showpiece-starship-rocket-reaches-orbit-for-first-time",
});
const STARSHIP_ISSUES = [
  "「日本株への直接的な影響は、入力情報からは確認できません」は入力データについての説明に聞こえ、投稿文として不自然です。",
  "「関係するのはSpaceXとStarlinkです」は直前までに両者が登場しており、内容を言い直す締めになっています。",
];

test("Starship after: Voice retry runs, the revision is re-checked by Fact and Voice", async () => {
  assert.equal(isRetryableVoiceFailure(STARSHIP_ISSUES), true);
  const { runner, calls } = scripted([
    { step: "draft", payload: { text: "SpaceXの大型ロケット「Starship」が初めて軌道に到達しました。打ち上げではStarlinkの衛星26基も投入されています。日本株への直接的な影響は、入力情報からは確認できません。関係するのはSpaceXとStarlinkです。", sufficient_information: true, notes: [] } },
    { step: "fact", payload: { passed: true, issues: [] } },
    { step: "voice", payload: { passed: false, issues: STARSHIP_ISSUES } },
    { step: "voice_retry", payload: { text: "SpaceXの大型ロケット「Starship」が初めて軌道に到達しました。打ち上げではStarlinkの衛星26基も投入されています。エンジン1基が早期に停止したものの、ミッションは計画どおり続行されました。" } },
    { step: "fact", payload: { passed: true, issues: [] } },
    { step: "voice", payload: { passed: true, issues: [] } },
  ]);
  const result = await generateImportantNewsPost(STARSHIP, runner);
  assert.deepEqual(calls, ["draft", "fact", "voice", "voice_retry", "fact", "voice"]);
  assert.equal(result.status, "ready_for_publish");
  assert.doesNotMatch(result.generatedText ?? "", /入力情報/);
});

// --- Prompts -----------------------------------------------------------------------------------------

async function instructionsFor(step: GenerationStep, issues?: string[]): Promise<string> {
  let body: Record<string, unknown> = {};
  await requestGenerationStep("k", step, STEEL, step === "draft" ? undefined : "【速報】本文", (_url, init) => {
    body = JSON.parse(String(init?.body));
    const payload = step === "draft" ? { text: "x", sufficient_information: true, notes: [] } : { text: "x" };
    return Promise.resolve(new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 }));
  }, issues);
  return String(body.instructions);
}

test("draft prompt: keep hedges, no sentences about the input, no forced 'no impact' closing", async () => {
  const text = await instructionsFor("draft");
  assert.match(text, /元情報の不確実性・留保表現（『とみられる』『疑い』『意向』『可能性』『暫定』/);
  assert.match(text, /確定した事実として言い切りません/);
  assert.match(text, /『入力情報からは確認できません』『入力データでは〜』.*入力や情報源の扱いについて説明する文は書きません/);
  assert.match(text, /『日本株への影響は確認できません』のような締めの一文を入れる必要はありません/);
  // Existing guards are still there.
  assert.match(text, /元情報にない数値、日付、固有名詞、因果、規模、将来予測を追加しません/);
});

test("fact_retry prompt: restoring the source's own qualifier is an allowed repair; no new facts", async () => {
  const text = await instructionsFor("fact_retry", [DMZ_ISSUE]);
  assert.match(text, /元情報と同じ留保表現に戻すこと/);
  assert.match(text, /新しい事実・解釈・市場影響・因果関係を追加しません/);
  assert.match(text, /数値、企業・証券コードの同一性、日付や出来事の発生時刻/);
});
