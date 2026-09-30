// 2026-09-30: (1) important-news closings no longer steer toward impact/affected-target/market-reaction
// endings without a source basis, and a missing impact closing is not a Voice failure; (2) an app-copy
// Fact failure whose issues are all wording/scope/certainty gets one rewrite, then local checks and Fact.
import assert from "node:assert/strict";
import test from "node:test";
import { kabumoriImportantNewsVoice } from "../_shared/kabumori_voice.ts";
import {
  APP_COPY_DRAFT_INSTRUCTIONS,
  APP_COPY_FACT_RETRY_INSTRUCTION,
  type AppCopyRequester,
  type AppCopySource,
  generateAppCopy,
  isRetryableAppCopyFactFailure,
} from "./app_copy_logic.ts";
import { type GenerationCandidate, importantNewsVoiceLines, requestGenerationStep } from "./post_generation_logic.ts";

// --- (1) Closings -------------------------------------------------------------------------------------

function keyForEnding(ending: string): string {
  for (let i = 0; i < 5000; i += 1) {
    const key = `k${i}`;
    if (kabumoriImportantNewsVoice(key).some((line) => line === `今回の締めの方向性: ${ending}`)) return key;
  }
  throw new Error(`no key for ${ending}`);
}

test("impact endings from the shared guide are replaced; the other endings are kept", () => {
  for (const ending of ["影響を受けうる対象を一言添えて自然に終える", "日本株で見られそうな反応を断定せず添える"]) {
    const lines = importantNewsVoiceLines(keyForEnding(ending));
    assert.ok(!lines.some((line) => line.includes(ending)), ending);
    assert.ok(lines.includes("今回の締めの方向性: 確認できた事実で自然に終える（日本株への影響・影響を受けそうな対象・市場反応は、元情報または確定済みjudgementに直接の根拠がある場合だけ本文で触れる）"));
  }
  for (const ending of ["条件や不確実性を一言だけ残す", "まとめを作らず、確認できた事実で終える"]) {
    assert.ok(importantNewsVoiceLines(keyForEnding(ending)).includes(`今回の締めの方向性: ${ending}`), ending);
  }
});

test("the body line asks for impact only with a direct basis; the shared guide itself is unchanged", () => {
  const key = keyForEnding("日本株で見られそうな反応を断定せず添える");
  const shared = kabumoriImportantNewsVoice(key);
  const local = importantNewsVoiceLines(key);
  assert.ok(shared.some((line) => line.includes("日本株への影響可能性を短い段落で自然につなぎます")), "shared guide untouched");
  assert.ok(shared.includes("今回の締めの方向性: 日本株で見られそうな反応を断定せず添える"), "shared guide untouched");
  assert.ok(local.some((line) => line.includes("日本株への影響可能性は、元情報または確定済みjudgementに直接の根拠がある場合だけ短い段落で自然につなぎます")));
  assert.equal(local.length, shared.length);
});

const CANDIDATE: GenerationCandidate = {
  id: "c", sourceType: "breaking_market", sourceUrl: "https://www.aljazeera.com/news/x", sourceName: "al_jazeera",
  title: "US consumer confidence hits its lowest level since 2014 ahead of midterms", bodySummary: "s",
  companyName: null, companyCode: null, entityKey: null, category: "other_market_moving",
  publishedAt: "2026-09-29T14:00:00.000Z", importance: "important", affectedEntities: [], japanMarketRelevance: "low",
  judgementReason: "r", judgementFactStatus: "passed", status: "ready_for_generation",
};

async function instructions(step: "draft" | "voice", candidate: GenerationCandidate): Promise<string> {
  let body: Record<string, unknown> = {};
  await requestGenerationStep("k", step, candidate, step === "draft" ? undefined : "【速報】本文", (_url, init) => {
    body = JSON.parse(String(init?.body));
    const payload = step === "draft" ? { text: "x", sufficient_information: true, notes: [] } : { passed: true, issues: [] };
    return Promise.resolve(new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 }));
  });
  return String(body.instructions);
}

test("draft and Voice prompts never carry an impact ending, whatever ending the seed picks", async () => {
  for (let i = 0; i < 40; i += 1) {
    const candidate = { ...CANDIDATE, id: `seed-${i}` };
    for (const step of ["draft", "voice"] as const) {
      const text = await instructions(step, candidate);
      assert.doesNotMatch(text, /影響を受けうる対象を一言添えて自然に終える|日本株で見られそうな反応を断定せず添える/, `${step} ${i}`);
    }
  }
});

test("draft forbids unsupported impact in closing and body; Voice never fails a post only for lacking one", async () => {
  const draft = await instructions("draft", CANDIDATE);
  assert.match(draft, /日本株への影響、影響を受けそうな対象、市場反応は、元情報または確定済みjudgementに直接の根拠がない場合、締めにも本文にも追加しません/);
  const voice = await instructions("voice", CANDIDATE);
  assert.match(voice, /日本株への影響、影響を受けそうな対象、市場反応に触れた締めがないこと、または『今回の締めの方向性』と締め方が違うことだけを理由にfailedにしません/);
});

// --- (2) App-copy Fact retry ------------------------------------------------------------------------

const MILEI: AppCopySource = {
  id: "milei",
  title: "Argentina’s Milei threatens legal action over Falklands oil project",
  bodySummary: "Argentinian President Javier Milei has threatened the British government with legal action unless it stops an oil project off the disputed Falkland Islands. Milei gave the United Kingdom a two-week ultimatum, saying it must halt all work on the Sea Lion oil project or Argentina will ask the International Tribunal for the Law of the Sea to order a stop to the project.",
  sourceUrl: "https://www.aljazeera.com/news/2026/9/29/milei",
  sourceType: "breaking_market", publishedAt: "2026-09-29T09:00:00Z", category: "geopolitics", affectedEntities: ["アルゼンチン", "英国"],
};
const MILEI_ISSUES = [
  "「法的措置を求める」は、原文の「裁判所に事業停止を命じるよう求める」より広い表現です。",
  "titleの「油田計画の停止を英国に要求」は、原文の見出しにある法的措置の威嚇が抜けています。",
];
const MILEI_COPY = {
  title_ja: "ミレイ大統領、フォークランド沖油田計画の停止を英国に要求",
  summary_ja: "アルゼンチンのミレイ大統領は、英国がフォークランド諸島沖のSea Lion油田プロジェクトを停止しなければ、国際海洋法裁判所に法的措置を求めると警告しました。英国には2週間の期限を示しています。",
  detail_ja: "ミレイ大統領は月曜夜、英国に対しSea Lion油田プロジェクトの全作業を停止するよう要求しました。",
  key_points_ja: ["ミレイ大統領は事業を「資源の違法な略奪」と呼びました。", "アルゼンチンはフォークランド諸島の主権を主張しています。"],
  sufficient_information: true,
};
const MILEI_FIXED = {
  ...MILEI_COPY,
  title_ja: "ミレイ大統領、フォークランド沖油田で英国に法的措置を警告",
  summary_ja: "アルゼンチンのミレイ大統領は、英国がフォークランド諸島沖のSea Lion油田プロジェクトを停止しなければ、国際海洋法裁判所に計画の停止を命じるよう求めると警告しました。英国には2週間の期限を示しています。",
};

const ASIA: AppCopySource = {
  id: "asia",
  title: "Asian benchmarks mostly rise despite ongoing worries about the Iran war",
  bodySummary: "Japan’s Nikkei 225 rose 1.3% to 66,318.81 in Wednesday morning trading, with SoftBank Group and Japanese chip-related stocks including Renesas Electronics and Rohm gaining amid optimism over artificial intelligence and semiconductors.",
  sourceUrl: "https://apnews.com/article/asia-markets", sourceType: "breaking_market", publishedAt: "2026-09-30T02:00:00Z", category: "other_market_moving", affectedEntities: [],
};
const ASIA_ISSUES = ["タイトルが「アジアの主要株価指数の大半が上昇」という原文の主題を、日経平均だけに狭めています。"];
const ASIA_COPY = {
  title_ja: "日経平均が午前取引で1.3％上昇",
  summary_ja: "水曜日午前の取引で、日経平均株価は1.3％高の66,318.81となった。ソフトバンクグループや半導体関連株が上昇した。",
  detail_ja: "ソフトバンクグループのほか、ルネサスエレクトロニクスやロームなどの日本の半導体関連株が上昇した。",
  key_points_ja: [],
  sufficient_information: true,
};
const ASIA_FIXED = { ...ASIA_COPY, title_ja: "アジアの主要株価指数がおおむね上昇、日経平均は1.3％高" };

function scripted(drafts: unknown[], facts: unknown[]) {
  const calls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  let d = 0;
  let f = 0;
  const requester: AppCopyRequester = (step, body) => {
    calls.push(step);
    bodies.push(body as Record<string, unknown>);
    const payload = step === "draft" ? drafts[d++] : facts[f++];
    return Promise.resolve({ payload, inputTokens: 1000, outputTokens: 300 });
  };
  return { requester, calls, bodies };
}

test("retry classification: wording/scope/headline/certainty issues only", () => {
  assert.equal(isRetryableAppCopyFactFailure(MILEI_ISSUES), true);
  assert.equal(isRetryableAppCopyFactFailure(ASIA_ISSUES), true);
  assert.equal(isRetryableAppCopyFactFailure(["summaryが原文の確度を強めすぎています。"]), true);
  for (const issue of [
    "数値の誤り：1.3％ではなく1.4％",
    "金額が原文と異なる（500億ドル→50億ドル）",
    "日付の誤り：月曜ではなく火曜",
    "人物の取り違え：ミレイではなくカプート",
    "企業名が原文と異なる",
    "固有名詞の表記が原文より狭い",
    "事実の取り違えがあり主題が狭い",
    "原文にない背景説明の追加",
    "主題に原文にない事実を追加しています",
  ]) {
    assert.equal(isRetryableAppCopyFactFailure([issue]), false, issue);
  }
  assert.equal(isRetryableAppCopyFactFailure([...ASIA_ISSUES, "数値の誤り"]), false, "all issues must be safe");
  assert.equal(isRetryableAppCopyFactFailure([]), false);
  assert.equal(isRetryableAppCopyFactFailure(["不明確な表現"]), false, "unrecognised issue is not retried");
});

for (const [name, source, copy, issues, fixed] of [
  ["Milei / Falklands", MILEI, MILEI_COPY, MILEI_ISSUES, MILEI_FIXED],
  ["Asian benchmarks", ASIA, ASIA_COPY, ASIA_ISSUES, ASIA_FIXED],
] as const) {
  test(`replay ${name}: Fact failed -> one rewrite with the issues -> local checks -> Fact passed`, async () => {
    const { requester, calls, bodies } = scripted([copy, fixed], [{ passed: false, issues }, { passed: true, issues: [] }]);
    const outcome = await generateAppCopy(source, requester);
    assert.deepEqual(calls, ["draft", "fact", "draft", "fact"]);
    assert.equal(outcome.status, "passed");
    assert.equal(outcome.error, null);
    assert.equal(outcome.copy?.titleJa, fixed.title_ja);
    assert.equal(outcome.calls, 4);
    const rewrite = bodies[2];
    assert.equal(rewrite.instructions, `${APP_COPY_DRAFT_INSTRUCTIONS}\n${APP_COPY_FACT_RETRY_INSTRUCTION}`);
    const input = JSON.parse(String(rewrite.input));
    assert.deepEqual(input.fact_issues, issues);
    assert.equal(input.previous_copy.title_ja, copy.title_ja);
    assert.equal(input.title, source.title);
  });
}

test("only one Fact rewrite: a second Fact failure stays failed", async () => {
  const { requester, calls } = scripted([MILEI_COPY, MILEI_COPY], [{ passed: false, issues: MILEI_ISSUES }, { passed: false, issues: MILEI_ISSUES }]);
  const outcome = await generateAppCopy(MILEI, requester);
  assert.deepEqual(calls, ["draft", "fact", "draft", "fact"]);
  assert.equal(outcome.error, "APP_COPY_FACT_FAILED");
});

test("the rewrite goes through the local checks before Fact", async () => {
  const withUrl = { ...MILEI_FIXED, detail_ja: "詳細は https://example.com を参照。" };
  const { requester, calls } = scripted([MILEI_COPY, withUrl], [{ passed: false, issues: MILEI_ISSUES }]);
  const outcome = await generateAppCopy(MILEI, requester);
  assert.deepEqual(calls, ["draft", "fact", "draft"]);
  assert.equal(outcome.error, "APP_COPY_LOCAL_CHECK_FAILED");
  const tooFew = scripted([MILEI_COPY, { ...MILEI_FIXED, key_points_ja: ["一つだけ"] }], [{ passed: false, issues: MILEI_ISSUES }]);
  const tooFewOutcome = await generateAppCopy(MILEI, tooFew.requester);
  assert.deepEqual(tooFew.calls, ["draft", "fact", "draft"], "no further key-point retry inside the Fact rewrite");
  assert.equal(tooFewOutcome.error, "APP_COPY_KEY_POINTS_TOO_FEW");
});

test("hard Fact issues are never rewritten", async () => {
  const { requester, calls } = scripted([ASIA_COPY], [{ passed: false, issues: ["数値の誤り：1.3％ではなく1.4％"] }]);
  const outcome = await generateAppCopy(ASIA, requester);
  assert.deepEqual(calls, ["draft", "fact"]);
  assert.equal(outcome.error, "APP_COPY_FACT_FAILED");
});
