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
  assert.equal(needsAppCopy({
    ...base,
    title: "大津波警報を発表",
    forceVerifiedCopy: true,
  }), true, "a market emergency still needs independently Fact-checked app copy");
  assert.equal(needsAppCopy({ ...base, app_copy_fact_status: "failed" }), false, "one attempt only");
  assert.equal(needsAppCopy({ ...base, app_copy_fact_status: "generating" }), false, "claimed elsewhere");
  assert.equal(needsAppCopy({ ...base, generation_fact_status: "passed", generated_text: "  " }), true, "empty passed text is unusable");
  assert.equal(needsAppCopy({ ...base, generation_fact_status: "passed", sourceBackedCopy: true }), true,
    "source-backed V2 may replace a shallow verified post");
  assert.equal(needsAppCopy({ ...base, generation_fact_status: "passed", sourceBackedCopy: false }), false,
    "thin source keeps the verified-post path");
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
  assert.equal(draft.model, "gpt-6-luna");
  assert.equal(draft.store, false);
  assert.equal(draft.text.format.strict, true);
  assert.ok(!("tools" in draft), "no web search tool");
  const input = JSON.parse(draft.input);
  assert.deepEqual(Object.keys(input).sort(), ["affected_entities_reference", "category", "published_at", "source_text", "source_type", "title"]);
  assert.ok(APP_COPY_DRAFT_INSTRUCTIONS.includes("原文に無い数字"));
  assert.ok(APP_COPY_DRAFT_INSTRUCTIONS.includes("投資判断"));
  assert.ok(APP_COPY_FACT_INSTRUCTIONS.includes("単位換算"));
  assert.ok(APP_COPY_DRAFT_INSTRUCTIONS.includes("主体・場所・時刻"));
  assert.ok(APP_COPY_DRAFT_INSTRUCTIONS.includes("市場や株価への影響"));
  const copy = parseAppCopyDraft(GOOD_COPY).copy!;
  const fact = appCopyFactRequestBody(GREER, copy) as Record<string, any>;
  assert.equal(fact.model, "gpt-6-luna");
  assert.ok(!("tools" in fact));
  assert.ok(JSON.parse(fact.input).detail_ja.includes("500億ドル"));
});

const PRODUCER_FIXTURES: Array<{ name: string; source: AppCopySource; copy: Record<string, unknown>; facts: string[] }> = [
  {
    name: "Hormuz tanker",
    source: {
      ...GREER,
      id: "hormuz",
      title: "Tanker hit near Strait of Hormuz, two crew injured",
      bodySummary: "A tanker was struck near the Strait of Hormuz. Two crew members were injured, but the vessel continued underway. Authorities said no closure of the strait or supply disruption had been confirmed.",
    },
    copy: {
      title_ja: "ホルムズ海峡近くでタンカー被弾、乗組員2人が負傷",
      summary_ja: "ホルムズ海峡近くでタンカーが被弾し、乗組員2人が負傷しました。船は航行を続け、海峡封鎖や供給障害は確認されていません。",
      detail_ja: "タンカーはホルムズ海峡の近くで被弾しました。\n\n乗組員2人が負傷した一方、船は航行を続けました。海峡の封鎖や供給障害が確認されたわけではありません。",
      key_points_ja: ["ホルムズ海峡近くでタンカーが被弾", "乗組員2人が負傷", "船は航行を継続", "海峡封鎖や供給障害は未確認"],
      sufficient_information: true,
    },
    facts: ["2人", "航行を続け", "封鎖"],
  },
  {
    name: "North Korea missile",
    source: {
      ...GREER,
      id: "north-korea",
      title: "North Korea fires missile 450 to 600 km toward its EEZ",
      bodySummary: "North Korea launched a missile that flew approximately 450 to 600 kilometers. South Korea assessed that the missile fell within North Korea's exclusive economic zone, while officials reviewed the launch details.",
    },
    copy: {
      title_ja: "北朝鮮がミサイル発射、約450〜600キロ飛翔と韓国軍",
      summary_ja: "北朝鮮がミサイルを発射し、約450〜600キロ飛翔しました。韓国側は北朝鮮の排他的経済水域内に落下したと評価しています。",
      detail_ja: "ミサイルは約450〜600キロ飛翔しました。\n\n韓国側は、落下地点が北朝鮮の排他的経済水域内だったと評価し、発射の詳細を分析しています。",
      key_points_ja: ["北朝鮮がミサイルを発射", "飛翔距離は約450〜600キロ", "北朝鮮のEEZ内への落下と評価"],
      sufficient_information: true,
    },
    facts: ["450〜600", "排他的経済水域", "分析"],
  },
  {
    name: "UN Houthi",
    source: {
      ...GREER,
      id: "un-houthi",
      title: "UN condemns attempted Houthi strike near Riyadh as displacement tops 130,000",
      bodySummary: "The United Nations condemned an attempted Houthi strike near Riyadh. The humanitarian update said more than 130,000 people had been displaced, while the attempted strike itself was not reported as a confirmed hit.",
    },
    copy: {
      title_ja: "国連、リヤド近郊のフーシ派攻撃未遂を非難　避難民は13万人超",
      summary_ja: "国連はリヤド近郊でのフーシ派による攻撃未遂を非難しました。人道状況の報告では、避難民が13万人を超えています。",
      detail_ja: "攻撃はリヤド近郊での未遂とされ、着弾が確認されたわけではありません。\n\n国連の人道状況報告では、避難民は13万人を超えています。",
      key_points_ja: ["国連が攻撃未遂を非難", "場所はリヤド近郊", "避難民が13万人超", "着弾は未確認"],
      sufficient_information: true,
    },
    facts: ["未遂", "リヤド近郊", "13万人", "確認されたわけではありません"],
  },
];

test("source-backed producer fixtures preserve additional event facts in detail", async () => {
  for (const fixture of PRODUCER_FIXTURES) {
    const outcome = await generateAppCopy(fixture.source, fakeRequester(fixture.copy, { passed: true, issues: [] }));
    assert.equal(outcome.status, "passed", fixture.name);
    assert.ok(outcome.copy!.detailJa.includes("\n\n"), fixture.name);
    const factInput = JSON.parse(appCopyFactRequestBody(fixture.source, outcome.copy!).input as string);
    for (const fact of fixture.facts) assert.ok(String(factInput.detail_ja).includes(fact), `${fixture.name}: ${fact}`);
  }
});

test("thin sources fail closed instead of padding detail", async () => {
  const source = { ...GREER, id: "thin", title: "Small update", bodySummary: "Officials said an update was issued." };
  const outcome = await generateAppCopy(source, fakeRequester({
    title_ja: "短い更新", summary_ja: "当局が更新を発表しました。", detail_ja: "", key_points_ja: [], sufficient_information: false,
  }, { passed: true, issues: [] }));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "APP_COPY_INSUFFICIENT_INFORMATION");
  assert.equal(outcome.calls, 1);
});

test("a passed Fact check yields passed copy after exactly one generation and one check", async () => {
  const calls: string[] = [];
  const outcome = await generateAppCopy(GREER, fakeRequester(GOOD_COPY, { passed: true, issues: [] }, calls));
  assert.deepEqual(calls, ["draft", "fact"]);
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.calls, 2);
  assert.equal(outcome.copy!.titleJa, GOOD_COPY.title_ja);
  assert.equal(outcome.model, "gpt-6-luna");
  assert.equal(outcome.estimatedCost, 0.0007);
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
    status: "passed", copy, issues: [], error: null, model: "gpt-6-luna",
    calls: 2, inputTokens: 1, outputTokens: 1, estimatedCost: 0,
  }, new Date("2026-09-11T00:00:00Z"));
  for (const key of Object.keys(update)) assert.ok(key.startsWith("app_"), key);
  assert.deepEqual(update.app_key_points_ja, GOOD_COPY.key_points_ja);
  assert.equal(update.app_copy_generated_at, "2026-09-11T00:00:00.000Z");
});

test("clean copy passes the local checks", () => {
  assert.deepEqual(localAppCopyIssues(parseAppCopyDraft(GOOD_COPY).copy!), []);
});
