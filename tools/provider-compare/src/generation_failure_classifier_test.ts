import assert from "node:assert/strict";
import test from "node:test";
import { classifyGenerationFailure, type GenerationFailureInput, pr116Outlook } from "./generation_failure_classifier.ts";

function fact(issues: string[], extra: Partial<GenerationFailureInput> = {}): GenerationFailureInput {
  return {
    generationError: "NEWS_GENERATION_FACT_FAILED", factStatus: "failed", voiceStatus: "not_run",
    factIssues: JSON.stringify(issues), voiceIssues: '["FACT_NOT_PASSED"]', sourceName: "tdnet", ...extra,
  };
}

test("each cause is recognised from the issue text production stored", () => {
  const cases: Array<[string[], string]> = [
    [["MISSING_EXPLICIT_YEAR"], "year_missing"],
    [["返済状況の基準日「2026年9月30日」から年が欠落"], "year_missing"],
    [["UNEXPECTED_SOURCE_URL", "MISSING_EXPLICIT_YEAR"], "year_missing"],
    [["company_identity.sameCompanyConfirmed=falseのため、同一企業性を確認できません"], "identity"],
    [["企業名不一致：生成文の「Ｇ－ヒューマンメイド」は元情報の「HUMAN MADE株式会社」と一致せず"], "identity"],
    [["純利益の金額誤り：7,797百万円は約78億円（77億円ではない）"], "rounding"],
    [["累計取得額は上限50億円に達していません（49億9,986万4,362円）。「上限の50億円に達しました」は不正確です。"], "rounding"],
    [["営業利益予想は20.2％の上方修正（増額）であり、下方修正ではありません"], "numeric_other"],
    [["「売上高」ではなく、資料上の項目は「営業収益」"], "numeric_other"],
    [["株主総会での承認前の議案である点が不明瞭。「増額します」と確定事項のように断定しています"], "approval_state"],
    [["元情報にない市場反応の推測（「日本株では…見られそう」）を追記"], "hedge_unsupported"],
    [["重要条件の欠落：米国での受注活動には、FDA業務縮小の影響が依然残っている点を省略"], "omission"],
    [["警戒情報の誤訳：原文はhurricane watchであり、「ハリケーン警報」ではありません。"], "factual_detail"],
  ];
  for (const [issues, expected] of cases) {
    assert.equal(classifyGenerationFailure(fact(issues)).primary, expected, issues.join(" / "));
  }
});

test("a draft with two problems keeps both causes and reports the mechanical one first", () => {
  const c = classifyGenerationFailure(fact([
    "company_identity.sameCompanyConfirmed=falseのため、同一企業として扱う根拠が不足",
    "元情報にない予測・論評：「日本株では同社の開示内容と実際の投資進捗が見られそうです」",
  ]));
  assert.deepEqual(c.causes, ["identity", "hedge_unsupported"]);
  assert.equal(c.primary, "identity");
});

test("a voice failure is a stage of its own, and an invalid output is an API failure", () => {
  const voice = classifyGenerationFailure({
    generationError: "NEWS_GENERATION_VOICE_FAILED", factStatus: "passed", voiceStatus: "failed", factIssues: "[]",
    voiceIssues: '["締めが不自然です"]', sourceName: "al_jazeera",
  });
  assert.equal(voice.primary, "voice");
  assert.equal(voice.stage, "voice");
  const api = classifyGenerationFailure({
    generationError: "NEWS_GENERATION_INVALID_OUTPUT", factStatus: "not_run", voiceStatus: "not_run", factIssues: "", voiceIssues: "", sourceName: "tdnet",
  });
  assert.equal(api.primary, "api");
  assert.equal(api.stage, "api");
  const local = classifyGenerationFailure(fact(["MISSING_EXPLICIT_YEAR"], { generationError: "NEWS_GENERATION_LOCAL_FACT_FAILED" }));
  assert.equal(local.stage, "local");
});

test("an issue that matches nothing is 'other', not silently dropped", () => {
  assert.equal(classifyGenerationFailure(fact(["理由を特定できない指摘"])).primary, "other");
});

test("PR #116 outlook: TDnet numeric drafting and pre-approval wording only; identity, year, voice and other sources are not addressed", () => {
  assert.equal(pr116Outlook("rounding", "tdnet"), "expected_to_improve");
  assert.equal(pr116Outlook("approval_state", "tdnet"), "expected_to_improve");
  assert.equal(pr116Outlook("numeric_other", "tdnet"), "partly");
  assert.equal(pr116Outlook("hedge_unsupported", "tdnet"), "partly");
  assert.equal(pr116Outlook("identity", "tdnet"), "not_addressed");
  assert.equal(pr116Outlook("year_missing", "tdnet"), "not_addressed");
  assert.equal(pr116Outlook("voice", "tdnet"), "not_addressed");
  assert.equal(pr116Outlook("rounding", "al_jazeera"), "not_addressed");
});
