// Fact V2（2026-10-11）: 事実は厳格に、事実に基づく分析・見通しは通す。
// - OBJECTIVE_FACT（値・日付・符号・企業の発表・出典）: これまでどおり厳格に外す
// - SUPPORTED_INTERPRETATION（事実＋一般的な経済の仕組みによる見立て）: ニュースに同じ記述が無くても通す
// - UNVERIFIED_ATTRIBUTION（過去の値動きの理由の断定）: 見立てとして書けば通し、事実として断定すれば外す
// 手元の擬似的な生成だけで確かめる（ネットワーク・本番・有料 API は使わない）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  codeFallbacks,
  FACT_INSTRUCTIONS,
  type GeneratedAnalysis,
  generateSharedAnalysis,
  generationRequestBody,
  localAnalysisCheck,
  MAX_GENERATIONS,
  MAX_MODEL_CALLS,
  parseGeneratedAnalysis,
  type Requester,
  unitChecker,
} from "./analysis_logic.ts";
import { sanitizeAnalysis } from "./unit_sanitizer.ts";
import { DEFAULT_TRANSPORT_RETRY } from "./transport_retry.ts";
import { inputOf, loadFixture } from "./test_support.ts";
import { formatSharedXPost, REPORT_DISCLAIMER_JA } from "../_shared/market_report_packet.ts";
import { appStoryText, buildAppMarketStory } from "../_shared/market_report_story.ts";

const input = inputOf(await loadFixture("close_2026-10-07"));
type Generation = { attempt: number; generation_index: number; candidate: unknown };
const generations: Generation[] = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/close_2026-10-07_generations.json", import.meta.url)),
);
const delivered = () => parseGeneratedAnalysis(structuredClone(generations.find((g) => g.attempt === 2)!.candidate))!;
const NOW = () => new Date("2026-10-07T07:20:05Z");
const PASSED = { passed: true, issues: [], objective_issues: [] };
const baseline = new Set(localAnalysisCheck(delivered(), input).hard);
/** Hard issues a text adds to the delivered 10/7 close, wherever it is placed. */
const addedHard = (place: (analysis: GeneratedAnalysis) => void) => {
  const analysis = delivered();
  place(analysis);
  return localAnalysisCheck(analysis, input).hard.filter((issue) => !baseline.has(issue));
};
const inContext = (text: string) => (analysis: GeneratedAnalysis) => { analysis.x_post.context_ja = text; };
const withAnalysis = (text: string) => {
  const analysis = delivered();
  analysis.x_post.context_ja = `${analysis.x_post.context_ja}${text}`;
  analysis.app_story!.japan_ja = `${analysis.app_story!.japan_ja}${text}`;
  return analysis;
};
const sanitize = (analysis: GeneratedAnalysis) =>
  sanitizeAnalysis(analysis, input, (kept) => unitChecker(input, kept), codeFallbacks(input));
function scripted(steps: Array<{ step: "generate" | "fact"; payload: unknown }>, calls: string[]): Requester {
  return (step) => {
    calls.push(step);
    const next = steps.shift();
    assert.ok(next, `unexpected ${step} call`);
    assert.equal(next.step, step);
    return Promise.resolve({ payload: structuredClone(next.payload), inputTokens: 1000, outputTokens: 400 });
  };
}

// ---------------------------------------------------------------------------------------------
// SUPPORTED_INTERPRETATION: 通す
// ---------------------------------------------------------------------------------------------

const INTERPRETATIONS = [
  // 原油 → 運輸の燃料費・利益率
  "原油価格が下がれば、運輸会社の燃料費の負担が軽くなり、利益率の改善につながると考えられます。",
  // 円高 → 輸出企業の採算
  "円高が進むと、輸出企業は海外の売上が円に換算して目減りするため、業績の重しになりやすいです。",
  // 金利 → 業種ごとの違い
  "金利の上昇は、銀行の利ざやには追い風になる一方、借り入れの多い不動産株には逆風になりやすいです。",
  // 複数の事実を組み合わせた見通し（日付はそれぞれ正しい）
  "10月6日の米国株高と10月7日の東京市場の下落を並べると、国内の材料待ちで買いが続きにくい地合いと考えられます。",
  // 文字どおりの「可能性」が無い一般的な仕組みの説明
  "米国の半導体株指数の動きは、日本の半導体関連株の売買の目安になりやすいです。",
  // 過去の値動きの理由を、見立てとして書いたもの
  "米国株高にもかかわらず東京市場が下げたのは、ウクライナ情勢が重しとなった可能性があります。",
];

test("ALLOW: 事実と一般的な経済の仕組みによる見立ては、ニュースに同じ記述が無くても外れない", () => {
  for (const text of INTERPRETATIONS) {
    assert.deepEqual(addedHard(inContext(text)), [], text);
    assert.deepEqual(sanitize(withAnalysis(text)).removed, [], text);
  }
});

test("ALLOW: 見立ての段落は、作り直しなしで X とアプリの両方に届く", async () => {
  const paragraph = INTERPRETATIONS.join("");
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, scripted([
    { step: "generate", payload: withAnalysis(paragraph) }, { step: "fact", payload: PASSED },
  ], calls), NOW);
  assert.deepEqual(calls, ["generate", "fact"]);
  assert.ok(outcome.ok);
  const packet = outcome.ok ? outcome.packet : null!;
  const post = formatSharedXPost(packet);
  for (const text of INTERPRETATIONS) {
    assert.ok(post.includes(text), `X: ${text}`);
    assert.ok(packet.app_story!.japan_ja.includes(text), `app: ${text}`);
  }
  assert.equal(packet.fact.ai_status, "passed");
  assert.equal(packet.fact.removed_units, undefined);
  assert.equal(post.split(REPORT_DISCLAIMER_JA).length, 2, "X の注意書きは1回");
  assert.equal(appStoryText(buildAppMarketStory(packet)).split(REPORT_DISCLAIMER_JA).length, 2, "アプリの注意書きは1回");
});

// ---------------------------------------------------------------------------------------------
// OBJECTIVE_FACT: 止める（遠くの「可能性」で通さない）
// ---------------------------------------------------------------------------------------------

test("GUARD: 日経平均の日付・値・符号の誤りは、後ろに「可能性」があっても止める", () => {
  const cases: Array<[string, string]> = [
    ["10月6日の日経平均は70,035.71（前日比−0.92%）でしたが、今後は上昇する可能性があります。", "日付と指標の不一致"],
    ["10月7日の日経平均は71,000.00でした。今後は戻す可能性があります。", "入力に無い数値"],
    ["10月7日の日経平均は上昇しましたが、今後は下落する可能性があります。", "方向の逆転"],
    ["10月7日の日経平均は70,035.71（前日比+0.92%）でしたが、今後の動きには不確実な可能性があります。", "方向の逆転"],
    ["10月7日のTOPIXは437.0円でしたが、今後は戻す可能性があります。", "TOPIX連動ETF（1306）をTOPIXと表記"],
  ];
  for (const [text, expected] of cases) {
    assert.ok(addedHard(inContext(text)).some((issue) => issue.startsWith(expected)), text);
  }
});

test("GUARD: 作り話の企業の発表は、Fact の客観的な指摘で外れる（推測として通さない）", async () => {
  const fabricated = "トヨタ自動車は10月7日に通期の業績予想を上方修正したと発表しました。";
  const fact = { passed: false, issues: ["入力に無い発表"], objective_issues: [{ quote_ja: fabricated, reason_ja: "input に該当するニュースが無い" }] };
  const outcome = await generateSharedAnalysis(input, scripted([
    { step: "generate", payload: withAnalysis(fabricated) }, { step: "fact", payload: fact },
    { step: "generate", payload: withAnalysis(fabricated) }, { step: "fact", payload: fact },
  ], []), NOW);
  assert.ok(outcome.ok);
  assert.ok(outcome.ok && !JSON.stringify(outcome.packet).includes("上方修正したと発表"), "作り話は配信されない");
  assert.equal(outcome.ok && outcome.packet.fact.ai_status, "advisory", "Fact の状態は passed と偽らない");
});

test("GUARD: 入力に無い出典を示す主張は外れる", () => {
  const analysis = delivered();
  analysis.claims.push({ claim_id: "c99", claim_type: "observation", evidence_refs: ["news:00000000-0000-4000-8000-000000000099"], text_ja: "海外の大手紙が日本株の急落を予想しました。", scope: "today" });
  const result = sanitize(analysis);
  assert.ok(result.removed.some((unit) => unit.code === "UNKNOWN_REF" && unit.path === "claims[c99]"));
});

// ---------------------------------------------------------------------------------------------
// UNVERIFIED_ATTRIBUTION: 過去の値動きの理由
// ---------------------------------------------------------------------------------------------

test("HISTORICAL: ニュースに無い理由で過去の値動きを断定した文は外れ、見立てとして書いた文は通る", () => {
  const asserted = "ウクライナ情勢を受けて、10月7日の東京市場は下落しました。";
  assert.ok(addedHard(inContext(asserted)).some((issue) => issue.startsWith("根拠の無い因果の断定")), asserted);
  const hedged = "10月7日の東京市場の下落には、ウクライナ情勢が重しとなった可能性があります。";
  assert.deepEqual(addedHard(inContext(hedged)), [], hedged);
  // 断定の節の後ろに関係のない「可能性」を足しても、断定は通らない（H2 R1 P1 と同じ規則）。
  const laundered = "ウクライナ情勢を受けて東京市場は下落しましたが今後の動きには不確実な可能性があります。";
  assert.ok(addedHard(inContext(laundered)).some((issue) => issue.startsWith("根拠の無い因果の断定")), laundered);
});

// ---------------------------------------------------------------------------------------------
// 監査で再現した誤検知の修正（それぞれ本当の誤りの対照つき）
// ---------------------------------------------------------------------------------------------

test("誤検知の修正: 2つの日付を正しく並べた文は通り、日付を取り違えた文は止まる", () => {
  assert.deepEqual(addedHard(inContext("10月6日の米国株高と10月7日の東京市場の下落を並べると、買いが続きにくい地合いと考えられます。")), []);
  assert.ok(addedHard(inContext("10月7日の米国株高と10月7日の東京市場の下落を並べると、買いが続きにくい地合いと考えられます。"))
    .some((issue) => issue.startsWith("日付と指標の不一致")));
  assert.ok(addedHard(inContext("10月6日の米国株高と10月6日の東京市場の下落を並べると、買いが続きにくい地合いと考えられます。"))
    .some((issue) => issue.startsWith("日付と指標の不一致")));
});

test("誤検知の修正: 「TOPIXへの新規採用」は指数そのものの話として通り、1306の値を TOPIX と書いた文は止まる", () => {
  const place = (text: string) => (analysis: GeneratedAnalysis) => { analysis.app_story!.news_ja = text; };
  for (const text of ["個別では、ジーエヌアイグループのTOPIXへの新規採用が発表されています。", "TOPIX（東証株価指数）構成銘柄への新規採用に関するお知らせがありました。"]) {
    assert.deepEqual(addedHard(place(text)), [], text);
  }
  for (const text of ["10月7日のTOPIXは437.0円でした。", "日経平均とTOPIXがそろって下落しました。"]) {
    assert.ok(addedHard(place(text)).some((issue) => issue.startsWith("TOPIX連動ETF（1306）をTOPIXと表記")), text);
  }
});

test("誤検知の修正: 「同じ日」を否定する文は通り、日付の違う市場を同じ日と書いた文は止まる", () => {
  const place = (text: string) => (analysis: GeneratedAnalysis) => { analysis.app_story!.cross_asset_ja = text; };
  for (const text of [
    "為替には前日比がなく、金利・原油も観測日が異なるため、東京市場と同じ日の変化としては扱いません。",
    "米国市場と東京市場は同じ日の結果ではありません。",
  ]) assert.deepEqual(addedHard(place(text)), [], text);
  for (const text of ["米国市場と東京市場は同じ日に下落しました。", "同日の米国市場と東京市場はそろって下げました。"]) {
    assert.ok(addedHard(place(text)).some((issue) => issue.startsWith("日付の違う東京市場と米国市場を「同じ日」と表現")), text);
  }
});

// ---------------------------------------------------------------------------------------------
// 方針・上限
// ---------------------------------------------------------------------------------------------

test("方針: 生成の指示は見立てを促し、過去の値動きの理由の断定だけを禁じる。Fact の指示は見立てを指摘しない", () => {
  const instructions = String(generationRequestBody(input, []).instructions);
  assert.ok(instructions.includes("入力の事実を組み合わせた分析・見通しは積極的に書きます"));
  assert.ok(instructions.includes("ニュースに同じことが書かれていなくても書いてかまいません"));
  assert.ok(instructions.includes("すでに起きた値動きの理由は、入力のニュースが理由として明記している（causal の claim がある）場合だけ事実として書きます"));
  assert.ok(!instructions.includes("1回まで、推測だと分かる言い方の見立てを添えてかまいません"), "見立ての回数制限は無くなった");
  assert.ok(FACT_INSTRUCTIONS.includes("news に同じ記述が無くても問題にしません"));
  assert.ok(FACT_INSTRUCTIONS.includes("すでに起きた値動きの理由を news が理由として書いていないのに事実として断定したもの"));
  assert.ok(FACT_INSTRUCTIONS.includes("input に無い数字・日付・固有名詞・事実"), "事実の誤りは引き続き指摘する");
});

test("上限: 生成2回・呼び出し4回・通信の再試行の上限は変わらない", () => {
  assert.equal(MAX_GENERATIONS, 2);
  assert.equal(MAX_MODEL_CALLS, 4);
  assert.deepEqual(DEFAULT_TRANSPORT_RETRY, { maxRetriesPerCall: 2, runRetryBudget: 3, runWaitBudgetMs: 30_000, backoffMs: [2_000, 6_000], maxRetryAfterMs: 20_000 });
});
