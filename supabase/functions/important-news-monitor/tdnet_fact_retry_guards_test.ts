// PR #116 independent review (2026-10-10): the Fact retry may only restore a hedge the source itself carries.
// Unit cases for the guards plus flow-level regressions through generateImportantNewsPost (scripted model steps).
import assert from "node:assert/strict";
import test from "node:test";
import {
  generateImportantNewsPost,
  type GenerationCandidate,
  type GenerationRunner,
  type GenerationStep,
  isCriticalEventFactIssue,
  isNumericDiscrepancyIssue,
  isPendingApprovalOverAssertion,
  isRetryableFactFailure,
} from "./post_generation_logic.ts";

const tdnet = (overrides: Partial<GenerationCandidate> = {}): GenerationCandidate => ({
  id: "c1",
  sourceType: "tdnet",
  sourceUrl: "https://www.release.tdnet.info/inbs/a.pdf",
  sourceName: "tdnet",
  title: "第60回定時株主総会招集ご通知",
  bodySummary: "当社は2026年10月に定時株主総会を開催します。第1号議案 剰余金処分の件（1株当たり50円）。本議案は株主総会の承認を前提とします。",
  companyName: "テスト株式会社",
  companyCode: "1234",
  entityKey: "company:1234",
  category: "other_corporate_ir",
  publishedAt: "2026-10-09T06:00:00.000Z",
  importance: "important",
  affectedEntities: [],
  japanMarketRelevance: "medium",
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

const retryable = (issue: string, text = "本文です。") => isRetryableFactFailure(tdnet(), text, [issue]);

// ------------------------------------------------------------ 1. a real outcome / kind error is never retried

test("outcome and kind mix-ups are refused even when the issue also mentions an approval-stage word", () => {
  for (const issue of [
    "株主総会で否決された議案を可決と断定しています。承認前の議案である点も不明です",
    "選任議案を定款変更議案と断定しています（承認前の議案）",
    "株式併合を株式分割と断定しており、承認前の議案という留保もありません",
    "臨時株主総会を定時株主総会と断定しています。付議予定の議案です",
    "すでに承認済みの事項を承認前と断定しています",
    "取締役会決議だけの事項を株主総会で承認されたと断定しています。承認前です",
    "承認前の議案を可決されたと断定しています",
  ]) assert.equal(retryable(issue), false, issue);
});

test("bare nouns 議案 / 付議 / 上程 are not a hedge", () => {
  for (const issue of ["第1号議案の内容を断定しています", "付議された議案を確定と断定しています", "上程された事項を断定しています"]) {
    assert.equal(retryable(issue), false, issue);
  }
});

test("guards: kind groups, outcome words, contrast particles", () => {
  assert.equal(isCriticalEventFactIssue("選任議案を定款変更議案と断定"), true);
  assert.equal(isCriticalEventFactIssue("株式併合を株式分割と断定"), true);
  assert.equal(isCriticalEventFactIssue("否決を可決と断定"), true);
  assert.equal(isCriticalEventFactIssue("議案ではなく報告事項"), true);
  assert.equal(isCriticalEventFactIssue("承認前の増配を確定と断定"), false);
  assert.equal(isCriticalEventFactIssue("剰余金の配当（増配）を確定と断定"), false, "dividend + surplus are one kind");
});

// ------------------------------------------------------------ 2. normal hedge restoration is kept (also with amounts)

test("hedge restoration that merely contains an amount is retryable", () => {
  for (const issue of [
    "純利益50億円の見込みを確定と断定しています",
    "150億ドルの投資意向を確定した投資と断定しています",
    "配当性向30％の方針を確定と断定しています",
    "1株当たり50円の承認前の議案を確定と断定しています",
    "株主総会での承認前の議案である点が不明瞭。「増額します」と確定事項のように断定しています",
    "２０２７年３月期の配当予想（１株当たり５０円）が承認前であるのに確定と断定しています",
    "5万株の取得予定を確定と断定しています",
    "300万株の売出し予定を実施済みと断定しています",
  ]) assert.equal(retryable(issue), true, issue);
});

test("a number error is refused: different amount, rounding, cap not reached, unit, calculation basis (NFKC, 万株 / 千株 / 万ドル)", () => {
  for (const issue of [
    "2031年8月期の売上高は155億円ではなく、155億5,000万円です。見込みを断定しています",
    "営業損失32億円は、元情報の32億8,300万円からの切り捨てで不正確です。予定を断定しています",
    "上限の25億円に達したとの断定は不正確です（累計は24億9,990万円で上限を下回ります）。予定です",
    "１５０億ドルの投資意向ですが、本文は１５億ドルと誤っています",
    "5万株ではなく50万株の取得予定です。確定と断定しています",
    "3000千株の売出しを300万株と記載しており桁が異なります。予定を断定しています",
    "10万ドルの見込みを10万円と記載しており単位が異なります",
    "6.9％の算定対象は「自己株式を除く発行済株式総数」ですが、条件が欠落しています。意向を断定しています",
    "利益基準の「親会社株主に帰属する連結当期純利益」が省略されています。見込みを断定しています",
  ]) assert.equal(retryable(issue), false, issue);
});

test("numeric guard is semantic, not a count of numbers", () => {
  assert.equal(isNumericDiscrepancyIssue("純利益50億円の見込みを確定と断定"), false);
  assert.equal(isNumericDiscrepancyIssue("1株当たり50円の承認前の議案を確定と断定"), false);
  assert.equal(isNumericDiscrepancyIssue("売上高は155億円ではなく155億5,000万円"), true);
  assert.equal(isNumericDiscrepancyIssue("５０万株ではなく５万株"), true);
  assert.equal(isNumericDiscrepancyIssue("上限に達していません"), true);
});

// ------------------------------------------------------------ 3. 不明瞭 vs 不明 (and no spill into the company-name branch)

test("不明瞭 (wording) is allowed only inside the pending-approval path; 不明 (unknown fact) stays refused", () => {
  assert.equal(isPendingApprovalOverAssertion("承認前の議案である点が不明瞭。増額と断定しています"), true);
  assert.equal(isPendingApprovalOverAssertion("承認前かどうかが不明です。増額と断定しています"), false);
  assert.equal(retryable("承認前かどうかが不明です。増額と断定しています"), false);
});

test("a company-name issue that says 不明瞭 does not become retryable through the 不明瞭 relaxation", () => {
  // companyIdentityEvidence has no verified match here, so the name branch refuses; and 不明 in the generic list
  // still refuses it (the pending-approval path does not apply: no over-assertion, no approval hedge).
  assert.equal(retryable("会社名の表記が不明瞭です"), false);
});

// ------------------------------------------------------------ 4. year branch: honest scope

test("MISSING_EXPLICIT_YEAR retry is reachable only from the deterministic (local) check, not from LLM issue text", () => {
  // The year the news depends on comes from the headline / judgement reason and the body (explicitYears).
  const c = tdnet({ title: "2026年10月9日の取締役会決議について", bodySummary: "2026年10月9日に決議した。", judgementReason: null });
  const url = "出典: https://www.release.tdnet.info/inbs/a.pdf";
  // deterministic code, text without the year -> the year-restoration retry applies
  assert.equal(isRetryableFactFailure(c, `【速報】10月9日に決議しました。\n\n${url}`, ["MISSING_EXPLICIT_YEAR"]), true);
  // same code but the text already carries the year -> nothing to restore
  assert.equal(isRetryableFactFailure(c, `【速報】2026年10月9日に決議しました。\n\n${url}`, ["MISSING_EXPLICIT_YEAR"]), false);
  // An LLM issue sentence that merely mentions a year is NOT routed here by a number-looking word: in the real flow
  // the LLM-Fact branch runs only when localFactIssues is empty, so the year branch cannot be reached by LLM text.
  assert.equal(isRetryableFactFailure(c, `【速報】2026年10月9日に決議しました。\n\n${url}`, ["2031年8月期の売上高は155億円ではなく155億5,000万円です"]), false);
});

// ------------------------------------------------------------ 5. flow regressions through generateImportantNewsPost

const DRAFT = { text: "株主総会で剰余金の配当を増額します。", sufficient_information: true, notes: [] };

test("flow: an outcome mix-up Fact issue stops the post — no fact_retry, Fact failed, not publishable", async () => {
  const { runner, calls } = scripted([
    { step: "draft", payload: DRAFT },
    { step: "fact", payload: { passed: false, issues: ["株主総会で否決された議案を可決と断定しています。承認前の議案である点も不明瞭です"] } },
  ]);
  const result = await generateImportantNewsPost(tdnet(), runner);
  assert.deepEqual(calls, ["draft", "fact"]);
  assert.equal(result.fact.status, "failed");
  assert.equal(result.status, "generation_failed");
  assert.equal(result.stoppedReason, "NEWS_GENERATION_FACT_FAILED");
  assert.equal(result.factRetry.attempted, false);
});

test("flow: a pre-approval over-assertion is retried once and the rewrite is fully re-checked (Fact then Voice)", async () => {
  const { runner, calls } = scripted([
    { step: "draft", payload: DRAFT },
    { step: "fact", payload: { passed: false, issues: ["株主総会での承認前の議案である点が不明瞭。「増額します」と確定事項のように断定しています"] } },
    { step: "fact_retry", payload: { text: "株主総会の承認を前提に、剰余金の配当を1株当たり50円とする議案を付議予定です。" } },
    { step: "fact", payload: { passed: true, issues: [] } },
    { step: "voice", payload: { passed: true, issues: [] } },
  ]);
  const result = await generateImportantNewsPost(tdnet(), runner);
  assert.deepEqual(calls, ["draft", "fact", "fact_retry", "fact", "voice"]);
  assert.equal(result.factRetry.attempted, true);
  assert.equal(result.status, "ready_for_publish");
});

test("flow: when the re-check fails after the retry, nothing is published", async () => {
  const { runner, calls } = scripted([
    { step: "draft", payload: DRAFT },
    { step: "fact", payload: { passed: false, issues: ["承認前の議案を「増額します」と確定として断定しています"] } },
    { step: "fact_retry", payload: { text: "株主総会で配当を1株当たり80円に増額することが決まりました。" } },
    { step: "fact", payload: { passed: false, issues: ["1株当たり50円ではなく80円と記載しており誤りです"] } },
  ]);
  const result = await generateImportantNewsPost(tdnet(), runner);
  assert.deepEqual(calls, ["draft", "fact", "fact_retry", "fact"]);
  assert.equal(result.fact.status, "failed");
  assert.equal(result.stoppedReason, "NEWS_GENERATION_FACT_RETRY_FAILED");
  assert.equal(result.status, "generation_failed");
});

test("flow: a number error is not retried even with an approval hedge in the same issue", async () => {
  const { runner, calls } = scripted([
    { step: "draft", payload: DRAFT },
    { step: "fact", payload: { passed: false, issues: ["承認前の議案ですが、配当は1株当たり50円ではなく60円と記載されています"] } },
  ]);
  const result = await generateImportantNewsPost(tdnet(), runner);
  assert.deepEqual(calls, ["draft", "fact"]);
  assert.equal(result.status, "generation_failed");
});

test("flow: a mixed issue list is refused as a whole — a safe hedge issue cannot carry a critical one through", async () => {
  const { runner, calls } = scripted([
    { step: "draft", payload: DRAFT },
    { step: "fact", payload: { passed: false, issues: [
      "承認前の議案を確定と断定しています",
      "株式併合を株式分割と断定しています",
    ] } },
  ]);
  const result = await generateImportantNewsPost(tdnet(), runner);
  assert.deepEqual(calls, ["draft", "fact"]);
  assert.equal(result.status, "generation_failed");
});
