import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_COPY_DRAFT_INSTRUCTIONS,
  APP_COPY_FACT_INSTRUCTIONS,
  APP_COPY_MODEL,
  APP_COPY_SOURCE_MAX,
  type AppCopy,
  appCopyDraftRequestBody,
  appCopyFactRequestBody,
  appCopySourceText,
  type AppCopySource,
  appCopyUpdate,
  type AppCopyRequester,
  generateAppCopy,
  localAppCopyIssues,
  needsAppCopy,
  parseAppCopyDraft,
} from "./app_copy_logic.ts";

// Shape of the real USTR row (English title, HTML-wrapped body).
const GREER: AppCopySource = {
  id: "34492714-0000-0000-0000-000000000000",
  title: "Ambassador Greer Issues Statement on President Trump’s Response to Canada’s Continued Retaliation Against the United States",
  bodySummary: '<span id="pageTitle" class="field field--name-title">Ambassador Greer Issues Statement</span><p>WASHINGTON &ndash; President Trump directed the removal of $50 billion of Canadian-origin goods from the Multiple Award Schedules. See https://ustr.gov/x</p>',
  sourceUrl: "https://ustr.gov/about-us/x",
  sourceType: "market_macro",
  publishedAt: "2026-09-09T20:00:00Z",
  category: "tariffs",
  affectedEntities: ["米国政府", "カナダ", "自動車"],
};

const GOOD_COPY = {
  title_ja: "米国、カナダ製品の一部を政府調達から除外　トランプ大統領の対応をUSTRが声明",
  summary_ja: "米通商代表部（USTR）のグリア代表は、カナダの報復措置に対するトランプ大統領の対応について声明を出しました。カナダ原産品500億ドル相当を政府調達の対象から外すよう指示しています。",
  detail_ja: "米通商代表部のグリア代表は声明で、トランプ大統領の対応を説明しました。\n\n大統領は、カナダ原産品500億ドル相当を、政府調達制度「Multiple Award Schedules」の対象から外すよう指示しました。",
  key_points_ja: ["USTRのグリア代表が声明を発表", "カナダ原産品500億ドル相当を政府調達の対象から除外"],
  sufficient_information: true,
};

function fakeRequester(draft: unknown, fact: unknown, calls: string[] = []): AppCopyRequester {
  return async (step) => {
    calls.push(step);
    return { payload: step === "draft" ? draft : fact, inputTokens: 1000, outputTokens: 500 };
  };
}

test("only items without Japanese title and without Fact-passed Japanese text need copy", () => {
  const base = { title: GREER.title, generated_text: "【重大速報】米国…", generation_fact_status: "failed", app_copy_fact_status: null };
  assert.equal(needsAppCopy(base), true);
  assert.equal(needsAppCopy({ ...base, generation_fact_status: "passed" }), false, "Fact-passed Japanese post exists");
  assert.equal(needsAppCopy({ ...base, title: "自己株式の取得状況に関するお知らせ" }), false, "already Japanese");
  assert.equal(needsAppCopy({ ...base, app_copy_fact_status: "failed" }), false, "one attempt only");
  assert.equal(needsAppCopy({ ...base, app_copy_fact_status: "generating" }), false, "claimed elsewhere");
  assert.equal(needsAppCopy({ ...base, generation_fact_status: "passed", generated_text: "  " }), true, "empty passed text is unusable");
});

test("the prompt source is plain text: markup, entities and URLs removed, capped", () => {
  const text = appCopySourceText(GREER.bodySummary);
  assert.ok(!/[<>]/.test(text) && !text.includes("pageTitle") && !text.includes("&ndash;"), text);
  assert.ok(!text.includes("https://"), text);
  assert.ok(text.includes("$50 billion of Canadian-origin goods"));
  assert.equal(Array.from(appCopySourceText("a".repeat(APP_COPY_SOURCE_MAX + 500))).length, APP_COPY_SOURCE_MAX);
});

test("requests use luna, no storage, strict schemas and only stored source text", () => {
  const draft = appCopyDraftRequestBody(GREER) as Record<string, any>;
  assert.equal(draft.model, APP_COPY_MODEL);
  assert.equal(draft.model, "gpt-5.6-luna");
  assert.equal(draft.store, false);
  assert.equal(draft.text.format.strict, true);
  assert.ok(!("tools" in draft), "no web search tool");
  const input = JSON.parse(draft.input);
  assert.deepEqual(Object.keys(input).sort(), ["affected_entities_reference", "category", "published_at", "source_text", "source_type", "title"]);
  assert.ok(APP_COPY_DRAFT_INSTRUCTIONS.includes("原文に無い数字"));
  assert.ok(APP_COPY_DRAFT_INSTRUCTIONS.includes("投資判断"));
  assert.ok(APP_COPY_FACT_INSTRUCTIONS.includes("単位換算"));
  const copy = parseAppCopyDraft(GOOD_COPY).copy!;
  const fact = appCopyFactRequestBody(GREER, copy) as Record<string, any>;
  assert.equal(fact.model, "gpt-5.6-luna");
  assert.ok(!("tools" in fact));
  assert.ok(JSON.parse(fact.input).detail_ja.includes("500億ドル"));
});

test("a passed Fact check yields passed copy after exactly one generation and one check", async () => {
  const calls: string[] = [];
  const outcome = await generateAppCopy(GREER, fakeRequester(GOOD_COPY, { passed: true, issues: [] }, calls));
  assert.deepEqual(calls, ["draft", "fact"]);
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.calls, 2);
  assert.equal(outcome.copy!.titleJa, GOOD_COPY.title_ja);
  assert.ok(outcome.estimatedCost > 0 && outcome.estimatedCost < 0.01);
});

test("a failed Fact check marks the copy failed (it is stored but never shown)", async () => {
  const outcome = await generateAppCopy(GREER, fakeRequester(GOOD_COPY, { passed: false, issues: ["金額の誤り"] }));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "APP_COPY_FACT_FAILED");
  assert.deepEqual(outcome.issues, ["金額の誤り"]);
  const update = appCopyUpdate(outcome);
  assert.equal(update.app_copy_fact_status, "failed");
});

test("local checks fail the copy before any Fact call", async () => {
  const cases: Array<[Partial<typeof GOOD_COPY>, string]> = [
    [{ title_ja: "US removes Canadian goods" }, "TITLE_NOT_JAPANESE"],
    [{ summary_ja: "詳しくは https://ustr.gov を参照。" }, "CONTAINS_URL"],
    [{ detail_ja: "<p>米国が措置</p>" }, "CONTAINS_MARKUP"],
    [{ title_ja: "【速報】米国がカナダ製品を除外" }, "CONTAINS_NEWS_LABEL"],
    [{ summary_ja: "関連銘柄は買い推奨です。米国が措置を発表しました。" }, "CONTAINS_INVESTMENT_ADVICE"],
    [{ summary_ja: "米国が措置を発表しました📈" }, "CONTAINS_EMOJI"],
    [{ title_ja: "あ".repeat(61) }, "TITLE_TOO_LONG"],
    [{ detail_ja: "あ".repeat(801) }, "DETAIL_TOO_LONG"],
  ];
  for (const [override, issue] of cases) {
    const calls: string[] = [];
    const outcome = await generateAppCopy(GREER, fakeRequester({ ...GOOD_COPY, ...override }, { passed: true, issues: [] }, calls));
    assert.equal(outcome.status, "failed", issue);
    assert.ok(outcome.issues.includes(issue), `${issue}: ${outcome.issues}`);
    assert.deepEqual(calls, ["draft"], "no Fact call after a local failure");
  }
});

test("insufficient information, empty fields and broken payloads fail closed", async () => {
  for (const payload of [
    { ...GOOD_COPY, sufficient_information: false },
    { ...GOOD_COPY, detail_ja: "   " },
    null,
    "not json object",
  ]) {
    const outcome = await generateAppCopy(GREER, fakeRequester(payload, { passed: true, issues: [] }));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.copy === null || outcome.error !== null, true);
  }
});

test("an API error fails closed with a safe code and is never retried", async () => {
  let calls = 0;
  const outcome = await generateAppCopy(GREER, async () => {
    calls += 1;
    throw new Error("APP_COPY_OPENAI_FAILED:500");
  });
  assert.equal(calls, 1);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "APP_COPY_OPENAI_FAILED:500");
});

test("a fact-check verdict other than exactly true fails", async () => {
  for (const verdict of [{ passed: "true", issues: [] }, { issues: [] }, null]) {
    const outcome = await generateAppCopy(GREER, fakeRequester(GOOD_COPY, verdict));
    assert.equal(outcome.status, "failed");
  }
});

test("the update writes only app_* columns", () => {
  const copy: AppCopy = parseAppCopyDraft(GOOD_COPY).copy!;
  const update = appCopyUpdate({
    status: "passed", copy, issues: [], error: null, model: "gpt-5.6-luna",
    calls: 2, inputTokens: 1, outputTokens: 1, estimatedCost: 0,
  }, new Date("2026-09-11T00:00:00Z"));
  for (const key of Object.keys(update)) assert.ok(key.startsWith("app_"), key);
  assert.deepEqual(update.app_key_points_ja, GOOD_COPY.key_points_ja);
  assert.equal(update.app_copy_generated_at, "2026-09-11T00:00:00.000Z");
});

test("clean copy passes the local checks", () => {
  assert.deepEqual(localAppCopyIssues(parseAppCopyDraft(GOOD_COPY).copy!), []);
});
