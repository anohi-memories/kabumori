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
) {
  const requests: { instructions: string; input: string }[] = [];
  const fetchImpl: typeof fetch = (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const text = responses[Math.min(requests.length - 1, responses.length - 1)];
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

test("regular slots send the exact previous prompt; conversation slots preserve the seed and existing voice with distinct guidance", async () => {
  const baseline = capture();
  await baseline.generate({
    ...args(),
    extraInstructions: aiLabDiversityInstructions([]),
  });
  const formatMarkers = {
    experience: "読者自身の経験や工夫",
    opinion: "読者の考えや好み",
    choices: "本文中に2〜4個",
  };
  for (let index = 0; index < 10; index += 1) {
    const fixture = capture();
    await createAiLabScheduledPostGenerator(index, fixture.generate)(args());
    const request = fixture.requests[0];
    assert.equal(request.input, baseline.requests[0].input);
    const mode = aiLabEngagementMode(index);
    if (mode === "regular") {
      assert.deepEqual(request, baseline.requests[0]);
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
    assert.match(request.instructions, /本文中に2〜4個/u);
  }
  assert.notEqual(
    fixture.requests[0].instructions,
    fixture.requests[1].instructions,
  );
  for (const line of aiLabDiversityInstructions(["OPENER_KOJIN_KAIHATSU"])) {
    assert.ok(fixture.requests[1].instructions.includes(line));
  }
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
