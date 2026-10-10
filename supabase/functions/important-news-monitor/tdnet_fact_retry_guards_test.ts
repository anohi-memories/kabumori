// PR #116 independent review (2026-10-10): the Fact retry may only restore a hedge the source itself carries.
// Unit cases for the guards plus flow-level regressions through generateImportantNewsPost (scripted model steps).
import assert from "node:assert/strict";
import test from "node:test";
import {
  generateImportantNewsPost,
  type GenerationCandidate,
  type GenerationRunner,
  type GenerationStep,
  canonicalQuantities,
  isCriticalEventFactIssue,
  isNumericDiscrepancyIssue,
  isPendingApprovalOverAssertion,
  isRetryableFactFailure,
  retryIntroducedCriticalFact,
  sourceTextConflicts,
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
    { step: "fact_retry", payload: { text: "株主総会の承認を前提に、剰余金の配当を増額する議案を付議予定です。" } },
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
    { step: "fact_retry", payload: { text: "株主総会で配当を増額することが決まりました。" } },
    { step: "fact", payload: { passed: false, issues: ["承認前の議案を決まったと断定しています"] } },
  ]);
  const result = await generateImportantNewsPost(tdnet(), runner);
  assert.deepEqual(calls, ["draft", "fact", "fact_retry", "fact"]);
  assert.equal(result.fact.status, "failed");
  assert.equal(result.stoppedReason, "NEWS_GENERATION_FACT_RETRY_FAILED");
  assert.equal(result.status, "generation_failed");
});

test("flow: a retry that changes an amount is refused before any re-check (provider-independent invariant)", async () => {
  const { runner, calls } = scripted([
    { step: "draft", payload: DRAFT },
    { step: "fact", payload: { passed: false, issues: ["承認前の議案を「増額します」と確定として断定しています"] } },
    { step: "fact_retry", payload: { text: "株主総会の承認を前提に、配当を1株当たり80円とする議案を付議予定です。" } },
  ]);
  const result = await generateImportantNewsPost(tdnet(), runner);
  assert.deepEqual(calls, ["draft", "fact", "fact_retry"]);
  assert.deepEqual(result.fact.issues, ["FACT_RETRY_CHANGED_CRITICAL_FACT"]);
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

// ------------------------------------------------------------ 6. 2026-10-11 re-review (N1 / N4 / N5 / N6)

const nameSource = (over: Partial<GenerationCandidate> = {}) =>
  tdnet({
    title: "剰余金の配当に関するお知らせ",
    bodySummary: "当社は株主総会の承認を前提に、1株当たり45円の配当を実施する議案を付議予定です。連結ベースの当期純利益は50億円の見込みです。",
    ...over,
  });

test("N1: a wrong amount / direction / kind is refused although the issue says 承認前 (issue wording AND text-vs-source)", () => {
  const c = nameSource();
  // amount: source 45円, text 50円
  assert.equal(isRetryableFactFailure(c, "承認前の議案として1株当たり50円の配当を実施します。", [
    "承認前の議案で1株当たり50円と断定していますが、元情報は45円です",
  ]), false);
  // the same text is refused even when the issue is phrased as a plain hedge complaint (provider independent)
  assert.equal(isRetryableFactFailure(c, "1株当たり50円の配当を実施します。", ["承認前の議案を確定と断定しています"]), false);
  // direction: source 減配, text 増配
  const down = nameSource({ title: "減配に関するお知らせ", bodySummary: "当社は期末配当を減配する議案を株主総会の承認を前提に付議予定です。" });
  assert.equal(isRetryableFactFailure(down, "期末配当を増配します。", ["承認前の議案を増配と断定していますが、元情報は減配です"]), false);
  assert.equal(isRetryableFactFailure(down, "期末配当を増配します。", ["承認前の議案を確定と断定しています"]), false);
  // kind: source 取得, text 消却
  const buyback = nameSource({ title: "自己株式取得に係る事項の決定", bodySummary: "自己株式の取得を決議しました。取締役会決議であり、株主総会の承認前の議案ではありません。" });
  assert.equal(isRetryableFactFailure(buyback, "自己株式の消却を実施します。", ["承認前の議案ではなく取得です。消却と断定しています"]), false);
  assert.equal(isRetryableFactFailure(buyback, "自己株式の消却を決定しました。", ["予定を確定と断定しています"]), false);
});

test("N4: the company-name branch cannot be used to smuggle an outcome / kind error ('表記')", () => {
  const c = nameSource();
  for (const issue of [
    "否決を可決と表記しています",
    "株式併合を株式分割と表記しています",
    "連結を単体と表記しています",
    "臨時株主総会を定時株主総会と表記しています",
    "配当の増額を減額と表記しています",
  ]) assert.equal(isRetryableFactFailure(c, "本文です。", [issue]), false, issue);
  // a genuine name-spelling issue on a confirmed company is still retryable
  assert.equal(isRetryableFactFailure(c, "テスト株式会社は…", ["会社名の表記が略称になっています（正式名称は株式会社テスト）"]), true);
});

test("N5: consolidated / standalone, withdrawn proposal, approval state, resolution result, split / consolidation", () => {
  const c = nameSource();
  for (const issue of [
    "連結業績を単体業績と断定しています。予定です",
    "単体の数値を連結と断定しています。見込みです",
    "取り下げられた議案を有効と断定しています。承認前です",
    "撤回された議案を予定どおり付議されるとしています",
    "承認済みの議案を承認前と断定しています",
    "未承認の議案を承認済みと断定しています",
    "決議結果を取り違えて可決と断定しています",
    "株式分割を株式併合と断定しています。予定です",
  ]) assert.equal(isRetryableFactFailure(c, "本文です。", [issue]), false, issue);
});

test("N5 (text vs source): consolidated / standalone and split / consolidation swaps are caught without the issue wording", () => {
  const consolidated = nameSource({ bodySummary: "連結ベースの当期純利益は50億円の見込みです。" });
  assert.equal(isRetryableFactFailure(consolidated, "単体の当期純利益は50億円の見込みです。", ["見込みを確定と断定しています"]), false);
  const merge = nameSource({ title: "株式併合のお知らせ", bodySummary: "株式併合を実施する予定です。" });
  assert.equal(isRetryableFactFailure(merge, "株式分割を実施します。", ["予定を確定と断定しています"]), false);
});

test("N6: an unclear subject is refused even with an approval qualifier; plain wording 不明瞭 stays allowed", () => {
  const c = nameSource();
  assert.equal(isRetryableFactFailure(c, "本文です。", ["主体が不明瞭で、承認前の議案を確定と断定しています"]), false);
  assert.equal(isRetryableFactFailure(c, "本文です。", ["当事者が曖昧なまま、承認前の議案を確定と断定しています"]), false);
  assert.equal(isRetryableFactFailure(c, "本文です。", ["誰が承認するのかが不明で、承認前の議案を確定と断定しています"]), false);
  assert.equal(isRetryableFactFailure(c, "本文です。", ["承認前の議案である点が不明瞭。「増額します」と確定事項のように断定しています"]), true);
});

test("normal retries are kept: hedge words with an amount, existing DMZ / steel-mill style issues", () => {
  const c = nameSource();
  // source amount 45円 / 50億円 present in the text -> no conflict
  assert.equal(isRetryableFactFailure(c, "1株当たり45円の配当を実施します。", ["承認前の議案を確定と断定しています"]), true);
  assert.equal(isRetryableFactFailure(c, "連結ベースの当期純利益は50億円です。", ["50億円の見込みを確定と断定しています"]), true);
  assert.equal(isRetryableFactFailure(c, "連結ベースの当期純利益は50億円です。", ["確定ではなく意向です。見込みを断定しています"]), true);
  const dmz = tdnet({ sourceType: "breaking_market", sourceName: "al_jazeera", title: "t", bodySummary: "mines believed to have been recently planted by North Korean troops" });
  assert.equal(isRetryableFactFailure(dmz, "【速報】本文", ["「北朝鮮が最近設置した」と断定。元情報では北朝鮮軍が最近設置したとみられる地雷との説明にとどまる"]), true);
});

test("source-vs-text conflicts: rounding and truncation, unit conversion is not a conflict, no source amount = nothing to compare", () => {
  const c = tdnet({ title: "x", bodySummary: "売上高は155億5,000万円（15,550百万円）です。" });
  assert.deepEqual(sourceTextConflicts(c, "売上高は155億5,000万円です。"), []);
  assert.deepEqual(sourceTextConflicts(c, "売上高は15,550百万円です。"), []);
  assert.deepEqual(sourceTextConflicts(c, "売上高は155億円です。"), ["AMOUNT_NOT_IN_SOURCE:yen", "METRIC_VALUE_MISMATCH:sales"]);
  assert.deepEqual(sourceTextConflicts(tdnet({ title: "x", bodySummary: "Revenue rose." }), "売上高は155億円です。"), []);
});

test("canonical quantities: NFKC, commas, composite units, shares, per-share amount kept apart, sign", () => {
  const plain = (text: string) => canonicalQuantities(text).map(({ cls, value }) => ({ cls, value }));
  assert.deepEqual(plain("１５５億５，０００万円"), [{ cls: "yen", value: 15550000000 }]);
  assert.deepEqual(plain("5万株と1株当たり50円"), [{ cls: "per_share_yen", value: 50 }, { cls: "shares", value: 50000 }]);
  assert.deepEqual(plain("150億ドル"), [{ cls: "usd", value: 15000000000 }]);
  assert.deepEqual(plain("純利益 -50億円"), [{ cls: "yen", value: -5000000000 }]);
  assert.deepEqual(plain("純利益 －５０億円"), [{ cls: "yen", value: -5000000000 }], "full-width minus");
  assert.deepEqual(plain("純利益 ▲50億円"), [{ cls: "yen", value: -5000000000 }]);
  assert.deepEqual(plain("営業損失32億円"), [{ cls: "yen", value: -3200000000 }], "loss label is negative");
  assert.deepEqual(plain("10-20円"), [{ cls: "yen", value: 20 }], "a hyphen between digits is a range, not a sign");
});

test("flow N1: a wrong per-share amount with 承認前 stops at Fact — no retry, nothing published", async () => {
  const c = nameSource();
  const { runner, calls } = scripted([
    { step: "draft", payload: { text: "承認前の議案として1株当たり50円の配当を実施します。", sufficient_information: true, notes: [] } },
    { step: "fact", payload: { passed: false, issues: ["承認前の議案で1株当たり50円と断定していますが、元情報は45円です"] } },
  ]);
  const result = await generateImportantNewsPost(c, runner);
  assert.deepEqual(calls, ["draft", "fact"]);
  assert.equal(result.status, "generation_failed");
  assert.equal(result.factRetry.attempted, false);
});

test("flow safety: invalid Fact JSON / API error on the re-check leaves the post unpublished", async () => {
  const hedge = { step: "fact" as GenerationStep, payload: { passed: false, issues: ["承認前の議案を「増額します」と確定として断定しています"] } };
  const revised = { step: "fact_retry" as GenerationStep, payload: { text: "株主総会の承認を前提に、配当を増額する議案を付議予定です。" } };
  const invalid = scripted([{ step: "draft", payload: DRAFT }, hedge, revised, { step: "fact", payload: { oops: true } }]);
  const a = await generateImportantNewsPost(tdnet(), invalid.runner).catch((error: Error) => error);
  // either a failed result or a thrown INVALID_OUTPUT — never a publishable post
  if (a instanceof Error) assert.match(a.message, /INVALID_OUTPUT/);
  else {
    assert.notEqual(a.status, "ready_for_publish");
    assert.equal(a.fact.status, "failed");
  }
  let step = 0;
  const failing: GenerationRunner = (name) => {
    step += 1;
    if (name === "fact" && step > 3) return Promise.reject(new Error("OPENAI_503"));
    const payloads: Record<string, unknown> = { draft: DRAFT, fact: hedge.payload, fact_retry: revised.payload };
    return Promise.resolve({ payload: payloads[name], model: "gpt-6-luna" as const, inputTokens: 1, outputTokens: 1, estimatedCost: 0 });
  };
  const b = await generateImportantNewsPost(tdnet(), failing);
  assert.notEqual(b.status, "ready_for_publish");
  assert.equal(b.fact.status, "failed");
});

// ------------------------------------------------------------ 7. PR #116 re-review F1-F6 (2026-10-11)

const fin = (body: string, title = "決算短信") => tdnet({ title, bodySummary: body });
const ok = (c: GenerationCandidate, text: string, issue = "見込みを確定と断定しています") => isRetryableFactFailure(c, text, [issue]);

test("F1: currency swap (150億ドル -> 150億円) is refused even though the source has no yen amount", () => {
  const c = fin("投資額は150億ドルの意向です。");
  assert.equal(ok(c, "投資額は150億円の意向です。"), false);
  assert.equal(sourceTextConflicts(c, "投資額は150億円です。")[0], "CURRENCY_SWAPPED:yen");
  // a correct dollar amount, and amounts in two currencies that BOTH exist in the source, are fine
  assert.equal(ok(c, "投資額は150億ドルの意向です。"), true);
  const both = fin("投資額は150億ドル、売上高は2,000億円の見込みです。");
  assert.equal(ok(both, "投資額は150億ドル、売上高は2,000億円の見込みです。"), true);
});

test("F2: sign flip is refused (-50億円 -> +50億円), incl. full-width and 損失 wording", () => {
  const loss = fin("純利益は-50億円の見込みです。");
  assert.equal(ok(loss, "純利益は50億円の見込みです。"), false);
  assert.equal(ok(loss, "純利益は-50億円の見込みです。"), true);
  assert.equal(ok(fin("純利益は－５０億円の見込みです。"), "純利益は50億円の見込みです。"), false);
  assert.equal(ok(fin("純利益は▲50億円の見込みです。"), "純利益は50億円の見込みです。"), false);
  assert.equal(ok(fin("営業損失は32億円の見込みです。"), "営業利益は32億円の見込みです。"), false, "loss became profit");
  assert.equal(ok(fin("営業損失は32億円の見込みです。"), "営業損失は32億円の見込みです。"), true);
});

test("F3: metric <-> amount binding (売上高 / 純利益 swap) is refused; the correct pairing and reorderings are kept", () => {
  const c = fin("売上高100億円、純利益50億円の見込みです。");
  assert.equal(ok(c, "売上高50億円、純利益100億円の見込みです。"), false);
  assert.equal(ok(c, "売上高100億円、純利益50億円の見込みです。"), true);
  assert.equal(ok(c, "純利益は50億円、売上高は100億円の見込みです。"), true);
  assert.equal(ok(c, "50億円の純利益と、100億円の売上高を見込みます。"), true);
  assert.equal(ok(fin("配当は1株当たり50円、純利益は50億円です。"), "配当は1株当たり50円、純利益は50億円です。"), true, "same number, different metrics, both correct");
});

test("F3 (retry invariant): a rewrite may not move an amount to another metric or change sign / currency", () => {
  const original = "売上高100億円、純利益50億円と断定します。";
  assert.equal(retryIntroducedCriticalFact(original, "売上高50億円、純利益100億円の見込みです。"), true);
  assert.equal(retryIntroducedCriticalFact(original, "純利益-50億円の見込みです。"), true);
  assert.equal(retryIntroducedCriticalFact("純利益50億円と断定します。", "純利益50億ドルの見込みです。"), true);
  assert.equal(retryIntroducedCriticalFact(original, "売上高100億円、純利益50億円の見込みです。"), false);
});

test("F4: 非連結 is not 連結 (no partial match), 未承認 is not 承認済み, 撤回済み is not 付議予定", () => {
  const nonConsolidated = fin("非連結ベースの売上高は100億円の見込みです。");
  assert.equal(ok(nonConsolidated, "連結ベースの売上高は100億円の見込みです。"), false);
  assert.equal(ok(nonConsolidated, "非連結ベースの売上高は100億円の見込みです。"), true);
  const unapproved = fin("本議案は株主総会で未承認です。承認を前提に付議予定です。");
  assert.equal(ok(unapproved, "本議案は承認済みです。"), false);
  assert.equal(ok(unapproved, "本議案は承認されていません。付議予定です。"), true);
  const withdrawn = fin("第2号議案は撤回されました。");
  assert.equal(ok(withdrawn, "第2号議案は付議予定です。"), false);
  assert.equal(ok(withdrawn, "第2号議案は撤回されました。"), true);
  // dropping the withdrawal in a rewrite changes the fact too
  assert.equal(retryIntroducedCriticalFact("第2号議案は撤回されました。議案を確定と断定します。", "第2号議案を付議予定です。", withdrawn), true);
  assert.equal(retryIntroducedCriticalFact("第2号議案は撤回されました。", "第2号議案は撤回されました。", withdrawn), false);
  // rejected vs passed
  const rejected = fin("本議案は否決されました。");
  assert.equal(ok(rejected, "本議案は可決されました。"), false);
});

test("F4 (negation): 承認されていない / 承認されなかった count as pending-or-not-approved, never approved", () => {
  const c = fin("本議案は承認前です。");
  assert.equal(ok(c, "本議案は承認されていません。"), true);
  assert.equal(ok(c, "本議案は承認されました。"), false);
});

test("F5: an unclear party is refused whatever the distance, and wording-only 不明瞭 is still allowed", () => {
  const c = fin("本議案は承認前です。");
  for (const issue of [
    "対象企業についての記述が不明瞭で、承認前の議案を確定と断定しています",
    "対象会社についての説明がやや長いが曖昧で、承認前の議案を確定と断定しています",
    "主体が不明瞭で、承認前の議案を確定と断定しています",
    "発行者についての言及が判然とせず、承認前の議案を確定と断定しています",
    "当事者が明確でなく、どの会社が承認するのか特定できない状態で、承認前の議案を確定と断定しています",
  ]) assert.equal(isRetryableFactFailure(c, "本文です。", [issue]), false, issue);
  assert.equal(isRetryableFactFailure(c, "本文です。", ["承認前であることが不明瞭で、増額と確定事項のように断定しています"]), true);
});

test("F6: equivalent unit conversions are one canonical value (not a numeric discrepancy)", () => {
  assert.equal(isNumericDiscrepancyIssue("売上高は155億5,000万円（15,550百万円）と記載すべきところ、見込みを断定しています"), false);
  assert.equal(isRetryableFactFailure(fin("売上高は15,550百万円の見込みです。"), "売上高は155億5,000万円の見込みです。", [
    "売上高155億5,000万円（15,550百万円）の見込みを確定と断定しています",
  ]), true);
  // several correct, different amounts are fine
  assert.equal(ok(fin("売上高100億円、営業利益20億円、純利益10億円の見込みです。"), "売上高100億円、営業利益20億円、純利益10億円です。",
    "売上高100億円、営業利益20億円、純利益10億円の見込みを確定と断定しています"), true);
  // but a rounded value is still a conflict
  assert.equal(ok(fin("売上高は155億5,000万円の見込みです。"), "売上高は155億円の見込みです。"), false);
});

// ---- flows: the seven dangerous scenarios of the independent review, through generateImportantNewsPost -------------

type FlowCase = { name: string; body: string; draft: string; issue: string; revised: string };
const FLOWS: FlowCase[] = [
  { name: "currency swap", body: "投資額は150億ドルの意向です。", draft: "投資額は150億円です。", issue: "意向を確定と断定しています", revised: "投資額は150億円の意向です。" },
  { name: "sign flip", body: "純利益は-50億円の見込みです。", draft: "純利益は-50億円です。", issue: "見込みを確定と断定しています", revised: "純利益は50億円の見込みです。" },
  { name: "metric swap", body: "売上高100億円、純利益50億円の見込みです。", draft: "売上高100億円、純利益50億円です。", issue: "見込みを確定と断定しています", revised: "売上高50億円、純利益100億円の見込みです。" },
  { name: "non-consolidated as consolidated", body: "非連結ベースの売上高は100億円の見込みです。", draft: "連結ベースの売上高は100億円です。", issue: "見込みを確定と断定しています", revised: "連結ベースの売上高は100億円の見込みです。" },
  { name: "unapproved as approved", body: "本議案は未承認で、承認を前提に付議予定です。", draft: "本議案は承認済みです。", issue: "予定を確定と断定しています", revised: "本議案は承認済みの予定です。" },
  { name: "withdrawn as scheduled", body: "第2号議案は撤回されました。", draft: "第2号議案は付議します。", issue: "予定を確定と断定しています", revised: "第2号議案は付議予定です。" },
  { name: "unclear party", body: "本議案は承認前です。", draft: "議案は承認されます。", issue: "対象企業についての記述が不明瞭で、承認前の議案を確定と断定しています", revised: "議案は承認前です。" },
];

for (const flow of FLOWS) {
  test(`flow F: ${flow.name} never reaches a publishable post through the Fact retry`, async () => {
    const { runner, calls } = scripted([
      { step: "draft", payload: { text: flow.draft, sufficient_information: true, notes: [] } },
      { step: "fact", payload: { passed: false, issues: [flow.issue] } },
      { step: "fact_retry", payload: { text: flow.revised } },
      { step: "fact", payload: { passed: true, issues: [] } }, // even a (wrongly) passing re-check must not matter
      { step: "voice", payload: { passed: true, issues: [] } },
    ]);
    const result = await generateImportantNewsPost(fin(flow.body), runner).catch((error: Error) => error);
    if (result instanceof Error) return; // an unexpected step means the retry was (correctly) not attempted
    assert.notEqual(result.status, "ready_for_publish", `${flow.name}: ${calls.join(">")}`);
    assert.equal(result.fact.status === "passed" && result.voice.status === "passed", false);
  });
}

test("flow: a correct hedge restoration with an amount still goes Fact retry -> re-Fact -> Voice -> publishable", async () => {
  const c = fin("純利益は50億円の見込みです。");
  const { runner, calls } = scripted([
    { step: "draft", payload: { text: "純利益は50億円です。", sufficient_information: true, notes: [] } },
    { step: "fact", payload: { passed: false, issues: ["見込みを確定と断定しています"] } },
    { step: "fact_retry", payload: { text: "純利益は50億円の見込みです。" } },
    { step: "fact", payload: { passed: true, issues: [] } },
    { step: "voice", payload: { passed: true, issues: [] } },
  ]);
  const result = await generateImportantNewsPost(c, runner);
  assert.deepEqual(calls, ["draft", "fact", "fact_retry", "fact", "voice"]);
  assert.equal(result.status, "ready_for_publish");
});

test("flow: Voice failure after a retry keeps the post unpublished; Fact keeps being re-run", async () => {
  const c = fin("純利益は50億円の見込みです。");
  const { runner, calls } = scripted([
    { step: "draft", payload: { text: "純利益は50億円です。", sufficient_information: true, notes: [] } },
    { step: "fact", payload: { passed: false, issues: ["見込みを確定と断定しています"] } },
    { step: "fact_retry", payload: { text: "純利益は50億円の見込みです。" } },
    { step: "fact", payload: { passed: true, issues: [] } },
    { step: "voice", payload: { passed: false, issues: ["証券レポート調で不自然です"] } },
  ]);
  const result = await generateImportantNewsPost(c, runner).catch((error: Error) => error);
  if (!(result instanceof Error)) assert.notEqual(result.status, "ready_for_publish");
  assert.ok(calls.includes("voice"));
});

test("F4 (state preservation): a rewrite that merely DROPS a withdrawal / outcome / basis changes the fact", () => {
  assert.equal(retryIntroducedCriticalFact("第2号議案は撤回されました。議案を確定と断定します。", "第2号議案について説明します。"), true);
  assert.equal(retryIntroducedCriticalFact("本議案は否決されました。", "本議案について説明します。"), true);
  assert.equal(retryIntroducedCriticalFact("非連結ベースの売上高は100億円です。", "売上高は100億円です。"), true);
  assert.equal(retryIntroducedCriticalFact("臨時株主総会で決議します。", "株主総会で決議します。"), true);
  // restoring a pending qualifier that the SOURCE carries is allowed; inventing one the source lacks is not
  const pending = tdnet({ title: "t", bodySummary: "本議案は株主総会の承認を前提に付議予定です。" });
  assert.equal(retryIntroducedCriticalFact("配当を増額します。", "承認前の議案として配当を増額する予定です。", pending), false);
  const silent = tdnet({ title: "t", bodySummary: "配当を増額します。" });
  assert.equal(retryIntroducedCriticalFact("配当を増額します。", "承認前の議案として配当を増額する予定です。", silent), true);
});
