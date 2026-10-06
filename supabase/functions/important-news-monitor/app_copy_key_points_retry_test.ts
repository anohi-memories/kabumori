// APP_COPY_KEY_POINTS_TOO_FEW (2026-09-28/29: JMA eruption warning, Al Jazeera DMZ blast). The parser
// accepts 0 or 2-4 key points and rejects exactly 1, but the prompt said "2-4 when the source supports
// it; no need to fill the count when thin", so a thin source got one point and the copy failed. The
// prompt now states the rule, and a single point gets one draft retry with the count restated.
import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_COPY_DRAFT_INSTRUCTIONS,
  APP_COPY_KEY_POINTS_RETRY_INSTRUCTION,
  appCopyDraftRequestBody,
  type AppCopyRequester,
  type AppCopySource,
  generateAppCopy,
  parseAppCopyDraft,
} from "./app_copy_logic.ts";

const DMZ: AppCopySource = {
  id: "dmz",
  title: "South Korea suspects North Korean mines behind DMZ blast",
  bodySummary: "[単一ソース: Al Jazeera 記事（RSS見出し・本文要約）] 本文冒頭: South Korea's military says an explosion that wounded three soldiers inside the Demilitarized Zone was likely caused by mines believed to have been recently planted by North Korean troops, according to a preliminary joint investigation with the UN Command.",
  sourceUrl: "https://www.aljazeera.com/news/2026/9/28/south-korea-suspects-north-korean-mines-behind-dmz-blast",
  sourceType: "breaking_market",
  publishedAt: "2026-09-28T16:00:00Z",
  category: "geopolitics",
  affectedEntities: ["韓国", "北朝鮮"],
};

const JMA: AppCopySource = {
  id: "jma",
  title: "噴火警報・予報",
  bodySummary: "桜島に噴火警報（火口周辺）を発表。噴火警戒レベル3（入山規制）を継続。",
  sourceUrl: "https://www.data.jma.go.jp/example",
  sourceType: "market_macro",
  publishedAt: "2026-09-28T03:00:00Z",
  category: "disaster",
  affectedEntities: [],
};

const copy = (keyPoints: string[]) => ({
  title_ja: "韓国軍、DMZの爆発は北朝鮮の地雷とみられると発表",
  summary_ja: "非武装地帯（DMZ）で軍人3人が負傷した爆発について、韓国軍は北朝鮮軍が最近設置したとみられる地雷が原因の可能性が高いと発表しました。",
  detail_ja: "韓国軍は、国連軍司令部との暫定的な合同調査の結果を明らかにしました。\n\n爆発では韓国軍の兵士3人が負傷しました。",
  key_points_ja: keyPoints,
  sufficient_information: true,
});

function scripted(drafts: unknown[], fact: unknown = { passed: true, issues: [] }) {
  const calls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  let draftIndex = 0;
  const requester: AppCopyRequester = (step, body) => {
    calls.push(step);
    bodies.push(body as Record<string, unknown>);
    const payload = step === "draft" ? drafts[draftIndex++] : fact;
    return Promise.resolve({ payload, inputTokens: 1000, outputTokens: 300 });
  };
  return { requester, calls, bodies };
}

test("the prompt states the rule the parser enforces: 0 or 2-4 key points, never exactly 1", () => {
  assert.match(APP_COPY_DRAFT_INSTRUCTIONS, /key_points_ja: 0項目、または2〜4項目にします（各80字以内）。1項目だけにはしません。/);
  assert.match(APP_COPY_DRAFT_INSTRUCTIONS, /2つ未満なら、水増しせず空配列にします/);
  assert.equal(parseAppCopyDraft(copy(["一つだけ"])).error, "APP_COPY_KEY_POINTS_TOO_FEW");
  assert.equal(parseAppCopyDraft(copy([])).error, null);
  assert.equal(parseAppCopyDraft(copy(["一つ目", "二つ目"])).error, null);
});

test("replay DMZ: one key point -> one retry with the count restated -> local checks and Fact -> passed", async () => {
  const { requester, calls, bodies } = scripted([
    copy(["北朝鮮の地雷が原因とみられる"]),
    copy(["DMZの爆発で韓国兵3人が負傷", "北朝鮮軍が最近設置したとみられる地雷が原因の可能性が高い"]),
  ]);
  const outcome = await generateAppCopy(DMZ, requester);
  assert.deepEqual(calls, ["draft", "draft", "fact"]);
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.error, null);
  assert.equal(outcome.copy?.keyPointsJa.length, 2);
  assert.equal(outcome.calls, 3);
  assert.equal(bodies[0].instructions, APP_COPY_DRAFT_INSTRUCTIONS);
  assert.equal(bodies[1].instructions, `${APP_COPY_DRAFT_INSTRUCTIONS}\n${APP_COPY_KEY_POINTS_RETRY_INSTRUCTION}`);
});

test("replay JMA (thin source): the retry may return no key points, which is valid", async () => {
  const { requester, calls } = scripted([copy(["噴火警戒レベル3を継続"]), copy([])]);
  const outcome = await generateAppCopy(JMA, requester);
  assert.deepEqual(calls, ["draft", "draft", "fact"]);
  assert.equal(outcome.status, "passed");
  assert.deepEqual(outcome.copy?.keyPointsJa, []);
});

test("only one retry: a second single key point still fails closed without a Fact call", async () => {
  const { requester, calls } = scripted([copy(["一つだけ"]), copy(["まだ一つだけ"])]);
  const outcome = await generateAppCopy(DMZ, requester);
  assert.deepEqual(calls, ["draft", "draft"]);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "APP_COPY_KEY_POINTS_TOO_FEW");
});

test("the retried copy still goes through the local checks and Fact", async () => {
  const withUrl = { ...copy(["要点1", "要点2"]), detail_ja: "詳細は https://example.com を参照。" };
  const local = scripted([copy(["一つだけ"]), withUrl]);
  const localOutcome = await generateAppCopy(DMZ, local.requester);
  assert.deepEqual(local.calls, ["draft", "draft"]);
  assert.equal(localOutcome.error, "APP_COPY_LOCAL_CHECK_FAILED");
  const fact = scripted([copy(["一つだけ"]), copy(["要点1", "要点2"])], { passed: false, issues: ["原文に無い事実"] });
  const factOutcome = await generateAppCopy(DMZ, fact.requester);
  assert.deepEqual(fact.calls, ["draft", "draft", "fact"]);
  assert.equal(factOutcome.error, "APP_COPY_FACT_FAILED");
});

test("other draft failures are never retried", async () => {
  for (const [payload, error] of [
    [{ ...copy([]), sufficient_information: false }, "APP_COPY_INSUFFICIENT_INFORMATION"],
    [{ ...copy(["a", "b"]), title_ja: "" }, "APP_COPY_EMPTY_FIELD"],
    ["not an object", "APP_COPY_INVALID_OUTPUT"],
  ] as const) {
    const { requester, calls } = scripted([payload]);
    const outcome = await generateAppCopy(DMZ, requester);
    assert.deepEqual(calls, ["draft"], error);
    assert.equal(outcome.error, error);
  }
  assert.equal(appCopyDraftRequestBody(DMZ).instructions, APP_COPY_DRAFT_INSTRUCTIONS, "no retry text on a first draft");
});
