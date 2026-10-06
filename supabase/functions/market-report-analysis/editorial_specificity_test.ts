// 2026-10-06 close, the first natural run of PR #87's prompt: the three points were
// 「主要指数は上昇、主因は一つに絞れず」「国際情勢のニュースを確認」「次は米国株と為替の動きを見る」.
// Two of them were the prompt's own example sentences, the third could be written on any day, and the day's
// one fact (the Nikkei closed above 70,000 after 69,946.86) was missing. This pins the corrective:
//   - the prompt carries roles and rules, not sentences a model can copy;
//   - generic headlines are recorded (X_POINTS_GENERIC), never a hard failure and never a rewrite;
//   - a threshold crossed or a big move may carry its number, within what the input can prove;
//   - the X body length alone no longer buys a rewrite, and a rejected rewrite leaves fixed codes only;
//   - every hard check still applies to the points.
// Inputs: the real 10/6 close packets (fixtures/close_2026-10-06_*), which carry the delivered draft.
import assert from "node:assert/strict";
import test from "node:test";
import type { MarketReportPacket } from "../_shared/market_report_packet.ts";
import {
  assemblePacket,
  type GeneratedAnalysis,
  generateSharedAnalysis,
  generationDiagnostics,
  generationRequestBody,
  isGenericPoint,
  isMetricRecapPoint,
  localAnalysisCheck,
  pointsEditorialWarnings,
  POINTS_GENERIC_WARN_AT,
  qualityRewriteHints,
  rejectionCodes,
  type Requester,
  X_POST_REWRITE_BELOW_CHARS,
} from "./analysis_logic.ts";
import { inputOf, loadFixture } from "./test_support.ts";

const input = inputOf(await loadFixture("close_2026-10-06"));
const morningFixture = await loadFixture("morning_2026-10-02");
const live: MarketReportPacket = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/close_2026-10-06_generated_report.json", import.meta.url)),
).payload;
const LIVE_POINTS = ["主要指数は上昇、主因は一つに絞れず", "国際情勢のニュースを確認", "次は米国株と為替の動きを見る"];
const NOW = () => new Date("2026-10-06T07:20:30Z");
const has = (issues: string[], fragment: string) => issues.some((issue) => issue.includes(fragment));
const editorial = (warnings: string[]) => warnings.filter((warning) => warning.startsWith("X_POINTS_"));

/** The 10/6 delivered generation as the model returned it, with other points if given. */
function delivered(points: string[] = LIVE_POINTS, mutate: (analysis: GeneratedAnalysis) => void = () => {}): GeneratedAnalysis {
  const p = structuredClone(live);
  const analysis: GeneratedAnalysis = {
    headline_ja: p.headline_ja, market_summary_ja: p.market_summary_ja, claims: p.claims,
    key_news: p.key_news.map((news) => ({ ref: news.ref_id, why_it_matters_ja: news.why_it_matters_ja })),
    strong_themes: p.strong_themes, weak_themes: p.weak_themes, next_watch_ja: p.next_watch_ja, risks_ja: p.risks_ja,
    x_post: { ...p.x_post, points_ja: points }, app_story: p.app_story,
  };
  mutate(analysis);
  return analysis;
}

function requester(steps: Array<{ step: "generate" | "fact"; payload: unknown }>, calls: string[] = []): Requester {
  return (step) => {
    calls.push(step);
    const next = steps.shift();
    assert.ok(next, `unexpected ${step} call`);
    assert.equal(next.step, step);
    return Promise.resolve({ payload: next.payload, inputTokens: 1000, outputTokens: 400 });
  };
}

test("prompt: no sentence a model can copy (neither the old examples nor the 10/6 output)", () => {
  const prompt = String(generationRequestBody(input, []).instructions);
  for (
    const copyable of [
      "主要指数がそろって上昇、主因は絞れず", "主因は一つに絞れず", "次は米国株と為替の反応を確認", "（入力の重要ニュース）が最大の材料に",
      "前夜の米株高を日本株が引き継げるか", "半導体株の強さが続くかに注目", "為替の動きには要注意",
      "半導体株が上昇を主導", "円高で輸出株には重さ", "明日は米指標と為替を確認", "大型株中心に上昇、材料は分散",
      ...LIVE_POINTS,
    ]
  ) assert.ok(!prompt.includes(copyable), `the prompt must not hand the model: ${copyable}`);
  const morningPrompt = String(generationRequestBody(inputOf(morningFixture), []).instructions);
  for (const copyable of ["前夜の米株高を日本株が引き継げるか", "為替の動きには要注意"]) assert.ok(!morningPrompt.includes(copyable));
});

test("prompt: specificity, the milestone exception and the proof limit are stated as rules", () => {
  const prompt = String(generationRequestBody(input, []).instructions);
  for (const generic of ["ニュースを確認", "動きを見る", "情勢に注目", "材料を確認", "今後の動向に注意"]) {
    assert.ok(prompt.includes(`「${generic}」`), `banned generic headline named: ${generic}`);
  }
  assert.ok(prompt.includes("どこの何の出来事かを書きます"));
  assert.ok(prompt.includes("節目を超えた、大幅に上昇・下落した、急変した、政策金利が決まった"));
  assert.ok(prompt.includes("前日の終値を上回った等"));
  assert.ok(prompt.includes("「初めて」「史上最高」「〜年ぶり」"));
  assert.ok(prompt.includes("3つすべてを抽象的にしません"));
});

test("replay 10/6: the three delivered points are generic, and recorded as such", () => {
  for (const point of LIVE_POINTS) assert.equal(isGenericPoint(point), true, point);
  assert.deepEqual(pointsEditorialWarnings(LIVE_POINTS), ["X_POINTS_GENERIC:3"]);
  // On the real input the draft passes every hard check: the signal is quality only.
  const check = localAnalysisCheck(delivered(), input);
  assert.deepEqual(check.hard, []);
  assert.ok(check.warnings.includes("X_POINTS_GENERIC:3"), check.warnings.join(" / "));
});

test("generic: the banned vocabulary is generic, a headline with a named event or place is not", () => {
  for (const point of ["ニュースを確認", "動きを見る", "情勢に注目", "材料を確認", "今後の動向に注意", "国際情勢に注意", "市場の動向を引き続き確認"]) {
    assert.equal(isGenericPoint(point), true, point);
  }
  for (
    const point of [
      "スーダン停戦決議を国連人権理事会が採択", "イエメン政府側がバブ・エル・マンデブ海峡の確保を発表", "黒海での穀物船攻撃をゼレンスキー氏が非難",
      "日経平均が7万円台に乗せ、前日の終値を上回る", "不二越の3Q累計は営業利益72.8%増", "韓国の9月輸出が過去最高",
      "前夜の米株高を日本株が引き継げるか", "半導体株の強さが続くかに注目",
    ]
  ) assert.equal(isGenericPoint(point), false, point);
});

test("generic: one generic watch point is allowed, two or more are recorded, and the signal is never hard", () => {
  assert.equal(POINTS_GENERIC_WARN_AT, 2);
  const specific = ["日経平均が7万円台に乗せ、前日の終値を上回る", "スーダン停戦決議を国連人権理事会が採択"];
  assert.deepEqual(pointsEditorialWarnings([...specific, "次は米国株と為替の動きを見る"]), []);
  assert.deepEqual(pointsEditorialWarnings([specific[0], "国際情勢のニュースを確認", "次は米国株と為替の動きを見る"]), ["X_POINTS_GENERIC:2"]);
  assert.deepEqual(qualityRewriteHints(["X_POINTS_GENERIC:3", "X_POINTS_METRIC_RECAP:3"]), [], "telemetry only: never a rewrite");
  const check = localAnalysisCheck(delivered(), input);
  assert.deepEqual(check.hard, [], "a generic headline is not a hard failure");
});

test("milestone: a crossed threshold or a big move may carry its number; a plain value recap still counts", () => {
  for (
    const point of [
      "日経平均が7万円台に乗せ、前日の終値を上回る", "日経平均は70,683.98円と節目を超えて上昇", "日経平均が終値で7万円台に到達",
      "日銀が政策金利を据え置き", "日経平均が大幅高、終値は70,683.98円",
    ]
  ) assert.equal(isMetricRecapPoint(point), false, point);
  for (const point of ["日経平均は70,683.98（前日比+1.05%）", "TOPIX連動ETF（1306）は440.4円（前日比+0.94%）"]) {
    assert.equal(isMetricRecapPoint(point), true, point);
  }
  // Two plain recaps are still recorded; a milestone headline among them is not counted as one.
  assert.deepEqual(
    pointsEditorialWarnings(["日経平均が7万円台に乗せ、前日の終値を上回る", "TOPIX連動ETF（1306）は440.4円（前日比+0.94%）", "スーダン停戦決議を国連人権理事会が採択"]),
    [],
  );
});

test("milestone: the 7万円台 headline passes every hard check on the 10/6 input; unprovable records are a prompt rule", () => {
  for (
    const point of [
      "日経平均が7万円台に乗せ、前日の終値を上回る", "日経平均は70,683.98円と節目を超えて上昇", "日経平均が終値で7万円台に到達",
      "日経平均が大幅高、終値は70,683.98円",
    ]
  ) {
    const check = localAnalysisCheck(delivered([point, "スーダン停戦決議を国連人権理事会が採択", "次は米国株と為替の動きを見る"]), input);
    assert.deepEqual(check.hard, [], `${point}\n${check.hard.join("\n")}`);
    assert.deepEqual(editorial(check.warnings), [], point);
  }
});

test("hard: a wrong value, wrong date, wrong sign, 1306 as TOPIX or an unsupported cause in a milestone headline still stops", () => {
  const rest = ["スーダン停戦決議を国連人権理事会が採択", "次は米国株と為替の動きを見る"];
  const cases: Array<[string, string]> = [
    ["日経平均が71,000.00円で7万円台に乗せた", "入力に無い数値"],
    ["10月5日の日経平均は70,683.98円で7万円台に", "日付と指標の不一致"],
    ["日経平均は70,683.98円（前日比-1.05%）で終了", "方向の逆転"],
    ["TOPIXが7万円台の日経平均とともに上昇", ""],
    ["米国株高を受けて日経平均が7万円台に乗せた", "根拠の無い因果"],
  ];
  for (const [point, fragment] of cases) {
    const check = localAnalysisCheck(delivered([point, ...rest]), input);
    assert.ok(check.hard.length > 0, `${point} must stay hard`);
    if (fragment) assert.ok(has(check.hard, fragment), `${point}\n${check.hard.join("\n")}`);
  }
  assert.ok(localAnalysisCheck(delivered(LIVE_POINTS.slice(0, 2)), input).hard.includes("X_POST_POINTS_INVALID"), "exactly three stays hard");
});

test("morning: forward-looking headlines on the 10/6 morning shape pass; completed-session assertions about today do not", () => {
  const morningInput = inputOf(morningFixture);
  const p = JSON.parse(
    Deno.readTextFileSync(new URL("./fixtures/morning_2026-10-02_generated_report.json", import.meta.url)),
  ).payload as MarketReportPacket;
  const morning = (points: string[]): GeneratedAnalysis => ({
    headline_ja: p.headline_ja, market_summary_ja: p.market_summary_ja, claims: p.claims,
    key_news: p.key_news.map((news) => ({ ref: news.ref_id, why_it_matters_ja: news.why_it_matters_ja })),
    strong_themes: p.strong_themes, weak_themes: p.weak_themes, next_watch_ja: p.next_watch_ja, risks_ja: p.risks_ja,
    x_post: { ...p.x_post, points_ja: points }, app_story: p.app_story,
  });
  const ok = localAnalysisCheck(morning(["前夜の米株高を日本株が引き継げるか", "イエメン情勢と半導体株の反応に注目", "米国株安の流れが続くかには注意"]), morningInput);
  assert.ok(!has(ok.hard, "日付と指標の不一致"), ok.hard.join("\n"));
  const wrong = localAnalysisCheck(morning(["米国株の下落を日本株が引き継ぐか", "イエメン情勢に注目", "半導体株の反応に注目"]), morningInput);
  assert.ok(has(wrong.hard, "方向の逆転"), wrong.hard.join("\n"));
});

test("rewrite: the X body length alone no longer buys a rewrite; a thin body still does", () => {
  assert.equal(X_POST_REWRITE_BELOW_CHARS, 300);
  assert.deepEqual(qualityRewriteHints(["X_POST_SHORTER_THAN_TARGET:387"]), [], "10/6 close: 387 characters, complete");
  assert.deepEqual(qualityRewriteHints(["X_POST_SHORTER_THAN_TARGET:430"]), []);
  assert.equal(qualityRewriteHints(["X_POST_SHORTER_THAN_TARGET:299"]).length, 1, "a paragraph is missing or cut");
  assert.deepEqual(qualityRewriteHints(["X_POST_SHORTER_THAN_TARGET:387", "APP_STORY_SHORTER_THAN_TARGET:840"]), []);
  // The app story keeps PR #77's band: 657 is under the 700 floor and still asks for one rewrite.
  assert.equal(qualityRewriteHints(["X_POST_SHORTER_THAN_TARGET:387", "APP_STORY_SHORTER_THAN_TARGET:657"]).length, 1);
  // The omission checks are unchanged.
  assert.equal(qualityRewriteHints(["X_POST_CONTEXT_OMITTED", "X_POST_WATCH_OMITTED"]).length, 2);
});

test("rewrite: the delivered 10/6 draft costs two calls when the app story is not thin (it cost four with both warnings)", async () => {
  const analysis = delivered();
  analysis.app_story = { ...analysis.app_story!, japan_ja: `${analysis.app_story!.japan_ja}${"日経平均とTOPIX連動ETF（1306）はそろって上昇しました。".repeat(2)}`,
    news_ja: `${analysis.app_story!.news_ja}国連人権理事会の決議や黒海の船舶攻撃が報じられましたが、東京市場の上昇との関係は確認できません。`,
    watch_ja: `${analysis.app_story!.watch_ja}ドル円の水準と米国債利回りの更新も合わせて確認します。` };
  const check = localAnalysisCheck(analysis, input);
  assert.deepEqual(check.hard, []);
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([{ step: "generate", payload: analysis }, { step: "fact", payload: { passed: true, issues: [] } }], calls), NOW);
  assert.equal(outcome.ok, true);
  assert.ok(check.warnings.some((warning) => warning.startsWith("X_POST_SHORTER_THAN_TARGET")), "X is still short of the target");
  assert.deepEqual(calls, ["generate", "fact"], "the X length alone does not call the model again");
  assert.equal(outcome.trace.qualityRewrite, false);
});

test("diagnosis: a rejected draft leaves fixed codes, never text", async () => {
  assert.equal(rejectionCodes(["日付と指標の不一致（日経平均は10月6日の値、本文は10月5日）: 「10月5日の日経平均は70,683.98」"]), "date");
  assert.equal(rejectionCodes(["方向の逆転（日経平均は前日比+1.05%）: 「日経平均が下落」", "根拠の無い因果の断定（ニュースに理由の記載なし）: 「…を受け…」"]), "direction+causal");
  assert.equal(rejectionCodes(["TOPIX連動ETF（1306）をTOPIXと書いている: 「TOPIXが上昇」"]), "1306");
  assert.equal(rejectionCodes(["本文に入力に無い固有名詞がある"]), "ref");
  assert.equal(rejectionCodes(["なんとなく不自然"]), "other");
  assert.equal(rejectionCodes([]), "none");
  // The 10/6 shape: a fact-safe draft, a quality rewrite, and a rewrite the Fact check rejects.
  const thin = delivered();
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([
    { step: "generate", payload: thin },
    { step: "fact", payload: { passed: true, issues: [] } },
    { step: "generate", payload: delivered() },
    { step: "fact", payload: { passed: false, issues: ["本文の日付が入力と合わない（10月5日の日経平均）", "入力に無い固有名詞がある: ○○社"] } },
  ], calls), NOW);
  assert.equal(outcome.ok, true);
  const diagnostics = generationDiagnostics(outcome.trace);
  assert.equal(outcome.trace.qualityRewrite, true);
  assert.equal(diagnostics.hard_rejections, "fact");
  assert.equal(diagnostics.rejection_reasons, "date+ref:2");
  assert.ok(!JSON.stringify(diagnostics).includes("○○社") && !JSON.stringify(diagnostics).includes("10月5日の日経平均"));
  assert.equal(outcome.trace.deliveredGeneration, 1, "the safe original is delivered");
  assert.ok(diagnostics.rejection_reasons.length <= 160);
});

test("ceiling: no new model call and the same packet contract", async () => {
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(input, requester([{ step: "generate", payload: delivered() }, { step: "fact", payload: { passed: true, issues: [] } }], calls), NOW);
  assert.equal(outcome.ok, true);
  assert.ok(calls.length <= 4);
  const packet = assemblePacket(input, delivered(), { generatedAt: NOW(), attempts: 1 });
  assert.equal(packet.schema_version, "market_report_packet.v1");
  assert.equal(packet.x_post.points_ja.length, 3);
});
