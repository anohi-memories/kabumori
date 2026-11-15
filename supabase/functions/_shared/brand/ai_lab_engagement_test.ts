import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrandContext } from "./brand_context.ts";
import { generateBrandPost } from "./brand_post_generator.ts";
import { aiLabDiversityInstructions } from "./ai_lab_theme_guard.ts";
import { dispatchAiLabScheduledBrandPost } from "./ai_lab_scheduled_brand_post.ts";
import {
  aiLabEngagementMode,
  createAiLabScheduledPostGenerator,
} from "./ai_lab_engagement.ts";
import {
  type AiLabEngagementDraft,
  collectAiLabEngagementViolations,
} from "./ai_lab_engagement_guard.ts";

function context(brandId = "ai_salaryman_lab") {
  return resolveBrandContext(
    {
      id: brandId,
      display_name: "fixture",
      is_active: true,
      publish_mode: "live",
      code_profile_key: brandId === "ai_salaryman_lab"
        ? "ai_salaryman_lab_v1"
        : "social_mobile_user_v1",
    },
    {
      id: `${brandId}_x`,
      brand_id: brandId,
      platform: "x",
      handle: brandId === "ai_salaryman_lab" ? "kaishain_ai_lab" : "fixture",
      publish_enabled: true,
      oauth_client_ref: "default",
    },
    {
      brand_id: brandId,
      fixed_hashtags: [],
      note_url: null,
      image_policy: {},
      enabled_post_types: ["brand_post"],
    },
  );
}

const seed = "開発する機能を一つに絞る判断について";
const args = () => ({
  openAiApiKey: "fixture-only",
  context: context(),
  postType: "brand_post",
  topicSeed: seed,
  retryViolations: [],
});

function capture(
  responses = ["作る機能を選ぶとき、何を一番大切にしていますか？"],
  rawOutput = false,
) {
  const requests: {
    instructions: string;
    input: string;
    text?: { format: { type: string; strict: boolean } };
  }[] = [];
  const fetchImpl: typeof fetch = (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const output =
      responses[Math.min(requests.length - 1, responses.length - 1)];
    const text = requests.at(-1)?.text?.format && !rawOutput
      ? JSON.stringify({
        text: output,
        poll_options: ["使いやすさ", "作りやすさ", "楽しさ"],
      })
      : output;
    return Promise.resolve(Response.json({
      output: [{ content: [{ type: "output_text", text }] }],
    }));
  };
  const generate: typeof generateBrandPost = (input) =>
    generateBrandPost({ ...input, fetchImpl });
  return { requests, generate };
}

test("every ten consecutive schedule ordinals have seven regular slots and one of each conversation format", () => {
  for (const start of [0, 1, 7, 9, 10, 97, 1000]) {
    const modes = Array.from(
      { length: 10 },
      (_, offset) => aiLabEngagementMode(start + offset),
    );
    assert.equal(modes.filter((mode) => mode === "regular").length, 7);
    for (const mode of ["experience", "opinion", "choices"]) {
      assert.equal(modes.filter((value) => value === mode).length, 1);
    }
  }
  for (const invalid of [-1, 0.3, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(aiLabEngagementMode(invalid), "regular");
  }
});

test("regular slots add concise truthful guidance; conversation slots preserve seed and voice with distinct guidance", async () => {
  const baseline = capture();
  await baseline.generate({
    ...args(),
    extraInstructions: aiLabDiversityInstructions([]),
  });
  const formatMarkers = {
    experience: "読者自身の経験や工夫",
    opinion: "読者の考えや好み",
    choices: "タップして回答できる2〜4個",
  };
  for (let index = 0; index < 10; index += 1) {
    const fixture = capture();
    await createAiLabScheduledPostGenerator(index, fixture.generate)(args());
    const request = fixture.requests[0];
    assert.equal(request.input, baseline.requests[0].input);
    const mode = aiLabEngagementMode(index);
    if (mode === "regular") {
      assert.equal(request.input, baseline.requests[0].input);
      assert.match(request.instructions, /200〜300文字程度/u);
      assert.match(request.instructions, /未提供の体験・最近の考えの変化・習慣・近況を補わない/u);
      assert.match(request.instructions, /毎回きれいな教訓で締めたりしない/u);
      assert.ok(request.instructions.includes(context().codeProfile.voiceInstructions.join("\n")));
    } else {
      assert.ok(request.instructions.includes(formatMarkers[mode]));
      assert.ok(
        request.instructions.includes(
          context().codeProfile.voiceInstructions.join("\n"),
        ),
      );
      assert.match(
        request.instructions,
        /最初から読者が自分の経験や考えを話せる構成/u,
      );
      assert.match(
        request.instructions,
        /本人の体験・進捗・失敗・実績を作らず/u,
      );
      assert.match(request.instructions, /反応を煽ったりしない/u);
    }
  }
});

test("content-diversity retries keep the selected format and topic while receiving the rejection feedback", async () => {
  const fixture = capture();
  const generate = createAiLabScheduledPostGenerator(8, fixture.generate);
  await generate(args());
  await generate({ ...args(), retryViolations: ["OPENER_KOJIN_KAIHATSU"] });
  for (const request of fixture.requests) {
    assert.equal(request.input, `今日のテーマ: ${seed}`);
    assert.match(request.instructions, /タップして回答できる2〜4個/u);
  }
  assert.notEqual(
    fixture.requests[0].instructions,
    fixture.requests[1].instructions,
  );
  for (const line of aiLabDiversityInstructions(["OPENER_KOJIN_KAIHATSU"])) {
    assert.ok(fixture.requests[1].instructions.includes(line));
  }
});

function scheduledFixture(fixture: ReturnType<typeof capture>, index: number) {
  const sent: { text: string; pollOptions?: string[] }[] = [];
  const released: string[] = [];
  let providerStarts = 0;
  const claim = {
    claimId: "fixture",
    kind: "evergreen" as const,
    eventKey: "evergreen-2",
    unitKey: "evergreen-2",
    topic: seed,
  };
  const dispatch = () =>
    dispatchAiLabScheduledBrandPost({
      ...args(),
      scheduledPostId: "schedule-fixture",
      topic: {
        claim: () => Promise.resolve(claim),
        startProvider: () => {
          providerStarts += 1;
          return Promise.resolve(true);
        },
        release: (_claim, reason) => {
          released.push(reason);
          return Promise.resolve("RELEASED");
        },
        markAmbiguous: () => Promise.resolve("AMBIGUOUS"),
        settlePublished: () => Promise.resolve("PUBLISHED"),
      },
      generate: createAiLabScheduledPostGenerator(index, fixture.generate),
      loadRecentFingerprints: () => Promise.resolve([]),
      publishText: (text, pollOptions) => {
        sent.push({ text, pollOptions });
        return Promise.resolve({ data: { id: "fixture-poll-id" } });
      },
      completePublishedPost: () =>
        Promise.resolve({ fingerprintPersisted: true }),
    });
  return { dispatch, sent, released, providerStarts: () => providerStarts };
}

test("poll generation requests strict structured output and dispatches a short question plus separate native poll options", async () => {
  const question = "作る機能を選ぶなら、何を一番重視しますか？ #個人開発";
  const fixture = capture([question]);
  const run = scheduledFixture(fixture, 8);
  const result = await run.dispatch();
  assert.deepEqual(run.sent, [{
    text: question,
    pollOptions: ["使いやすさ", "作りやすさ", "楽しさ"],
  }]);
  assert.equal(result.pollCreated, true);
  assert.equal(result.characterCount, Array.from(question).length);
  assert.equal(fixture.requests[0].text?.format.type, "json_schema");
  assert.equal(fixture.requests[0].text?.format.strict, true);
  assert.match(fixture.requests[0].instructions, /JSON schema/u);
  assert.match(fixture.requests[0].instructions, /最大120文字/u);
  assert.doesNotMatch(run.sent[0].text, /poll_options|"text"|^[ABC]\./mu);
});

test("all conversation modes retry an oversized draft without truncation; regular slots retain their unlimited length", async () => {
  for (const index of [2, 5, 8]) {
    const fixture = capture([
      "あ".repeat(121),
      "機能を絞るとき、何を優先しますか？",
    ]);
    const run = scheduledFixture(fixture, index);
    await run.dispatch();
    assert.equal(fixture.requests.length, 2);
    assert.equal(run.sent.length, 1);
    assert.equal(run.sent[0].text, "機能を絞るとき、何を優先しますか？");
    assert.match(
      fixture.requests[1].instructions,
      /直前の案は長さ・行数または投票形式/u,
    );
  }
  const fixture = capture(["あ".repeat(300)]);
  const run = scheduledFixture(fixture, 0);
  const result = await run.dispatch();
  assert.equal(run.sent[0].text.length, 300);
  assert.equal(run.sent[0].pollOptions, undefined);
  assert.equal(result.pollCreated, undefined);
});

test("oversized or over-four-line conversation drafts exhaust three attempts and never start the provider", async () => {
  for (const text of ["あ".repeat(121), "一行\n\n二行\n\n三行"]) {
    const fixture = capture([text]);
    const run = scheduledFixture(fixture, 2);
    await assert.rejects(run.dispatch, {
      message: "AI_LAB_CONTENT_DIVERSITY_REJECTED",
    });
    assert.equal(fixture.requests.length, 3);
    assert.equal(run.providerStarts(), 0);
    assert.deepEqual(run.sent, []);
    assert.deepEqual(run.released, ["PRE_X_CONTENT_REJECTED"]);
  }
});

test("native poll validation rejects bad option counts, empty/long/duplicate/control-character labels and inline menus before X", async () => {
  for (
    const options of [
      ["一択"],
      ["1", "2", "3", "4", "5"],
      ["", "有効"],
      ["あ".repeat(26), "短い"],
      ["Ａ", "A"],
      ["Yes", "yes"],
      [" 前後空白 ", "なし"],
      ["改\n行", "なし"],
    ]
  ) {
    const fixture = capture([
      JSON.stringify({ text: "どれを優先しますか？", poll_options: options }),
    ], true);
    const run = scheduledFixture(fixture, 8);
    await assert.rejects(run.dispatch, {
      message: "AI_LAB_CONTENT_DIVERSITY_REJECTED",
    });
    assert.equal(fixture.requests.length, 3);
    assert.equal(run.providerStarts(), 0);
    assert.deepEqual(run.sent, []);
  }
  const fixture = capture([
    JSON.stringify({
      text: "どれ？\nA. 速さ\nB. 楽しさ",
      poll_options: ["速さ", "楽しさ"],
    }),
  ], true);
  const run = scheduledFixture(fixture, 8);
  await assert.rejects(run.dispatch, {
    message: "AI_LAB_CONTENT_DIVERSITY_REJECTED",
  });
  assert.deepEqual(run.sent, []);
});

test("malformed poll JSON never becomes plain text: it is retried within the same topic or stopped", async () => {
  const good = JSON.stringify({
    text: "何を優先しますか？",
    poll_options: ["速さ", "楽しさ"],
  });
  for (
    const bad of [
      "JSONではない",
      "null",
      "[]",
      JSON.stringify({ text: "不完全" }),
      JSON.stringify({ text: "", poll_options: ["A", "B"] }),
      JSON.stringify({ text: "問い", poll_options: [1, 2] }),
      JSON.stringify({ text: "問い", poll_options: ["A", "B"], extra: true }),
    ]
  ) {
    const fixture = capture([bad, good], true);
    const run = scheduledFixture(fixture, 8);
    await run.dispatch();
    assert.equal(fixture.requests.length, 2);
    assert.ok(
      fixture.requests.every((request) =>
        request.input === `今日のテーマ: ${seed}`
      ),
    );
    assert.deepEqual(run.sent, [{
      text: "何を優先しますか？",
      pollOptions: ["速さ", "楽しさ"],
    }]);
  }
  const fixture = capture(["不正JSON"], true);
  const run = scheduledFixture(fixture, 8);
  await assert.rejects(run.dispatch, {
    message: "AI_LAB_CONTENT_DIVERSITY_REJECTED",
  });
  assert.equal(fixture.requests.length, 3);
  assert.equal(run.providerStarts(), 0);
  assert.deepEqual(run.sent, []);
});

test("the short-post boundary counts Unicode code points and all line endings, and forbids polls outside the poll slot", async () => {
  const fixture = capture(["あ".repeat(119) + "😀"]);
  const generated = await createAiLabScheduledPostGenerator(
    2,
    fixture.generate,
  )(args());
  assert.deepEqual(collectAiLabEngagementViolations(generated), []);
  assert.deepEqual(
    collectAiLabEngagementViolations({
      ...generated,
      text: "1\r\n2\r\n3\r\n4",
    }),
    [],
  );
  assert.deepEqual(
    collectAiLabEngagementViolations({ ...generated, text: "1\r2\r3\r4\r5" }),
    ["ENGAGEMENT_TOO_MANY_LINES"],
  );
  assert.deepEqual(
    collectAiLabEngagementViolations({
      ...generated,
      engagementMode: "regular",
      pollOptions: ["A", "B"],
    }),
    ["POLL_UNEXPECTED_OPTIONS"],
  );
  assert.deepEqual(
    collectAiLabEngagementViolations(
      {
        ...generated,
        engagementMode: "invalid",
      } as unknown as AiLabEngagementDraft,
    ),
    ["ENGAGEMENT_INVALID_MODE"],
  );
});

test("the AI Lab adapter rejects a different brand before making a generation request", () => {
  const fixture = capture();
  assert.throws(
    () =>
      createAiLabScheduledPostGenerator(2, fixture.generate)({
        ...args(),
        context: context("another-brand"),
      }),
    { message: "AI_LAB_ENGAGEMENT_BRAND_MISMATCH" },
  );
  assert.equal(fixture.requests.length, 0);
});

test("the existing dispatcher retries a rejected opening with the same conversation format and publishes only the accepted draft", async () => {
  const accepted = "作る機能を選ぶとき、何を一番大切にしていますか？";
  const fixture = capture(["個人開発は、機能を選ぶところから。", accepted]);
  const sent: string[] = [];
  const claim = {
    claimId: "fixture",
    kind: "evergreen" as const,
    eventKey: "evergreen-2",
    unitKey: "evergreen-2",
    topic: seed,
  };
  const result = await dispatchAiLabScheduledBrandPost({
    ...args(),
    scheduledPostId: "schedule-fixture",
    topic: {
      claim: () => Promise.resolve(claim),
      startProvider: () => Promise.resolve(true),
      release: () => Promise.resolve("RELEASED"),
      markAmbiguous: () => Promise.resolve("AMBIGUOUS"),
      settlePublished: () => Promise.resolve("PUBLISHED"),
    },
    generate: createAiLabScheduledPostGenerator(5, fixture.generate),
    loadRecentFingerprints: () => Promise.resolve([]),
    publishText: (text) => {
      sent.push(text);
      return Promise.resolve({ data: { id: "fixture-x-id" } });
    },
    completePublishedPost: () =>
      Promise.resolve({ fingerprintPersisted: true }),
  });
  assert.equal(fixture.requests.length, 2);
  assert.ok(
    fixture.requests.every((request) =>
      request.instructions.includes("読者の考えや好み")
    ),
  );
  assert.deepEqual(sent, [accepted]);
  assert.equal(result.xPostId, "fixture-x-id");
});
