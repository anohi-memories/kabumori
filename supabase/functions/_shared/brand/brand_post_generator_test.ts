import assert from "node:assert/strict";
import test from "node:test";
import {
  type BrandOperationalSettings,
  resolveBrandContext,
} from "./brand_context.ts";
import { generateBrandPost } from "./brand_post_generator.ts";
import { UNLIMITED_POST_LENGTH } from "./post_length_policy.ts";

const aiLabSettings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab",
  fixed_hashtags: [],
  note_url: null,
  image_policy: {},
  enabled_post_types: ["brand_post"],
};
const kabumoriSettings: BrandOperationalSettings = {
  brand_id: "kabumori",
  fixed_hashtags: [],
  note_url: null,
  image_policy: {},
  enabled_post_types: [],
};

function aiLabContext(
  publishMode: "disabled" | "dry_run" | "live" = "dry_run",
) {
  return resolveBrandContext(
    {
      id: "ai_salaryman_lab",
      display_name: "AIサラリーマン研究所",
      is_active: publishMode !== "disabled",
      publish_mode: publishMode,
      code_profile_key: "ai_salaryman_lab_v1",
    },
    {
      id: "ai_salaryman_lab_x",
      brand_id: "ai_salaryman_lab",
      platform: "x",
      handle: "kaishain_ai_lab",
      publish_enabled: false,
      oauth_client_ref: "default",
    },
    aiLabSettings,
  );
}

function kabumoriContext() {
  return resolveBrandContext(
    {
      id: "kabumori",
      display_name: "かぶモリ",
      is_active: true,
      publish_mode: "live",
      code_profile_key: "kabumori_v1",
    },
    {
      id: "kabumori_x",
      brand_id: "kabumori",
      platform: "x",
      handle: "yume_daka",
      publish_enabled: true,
      oauth_client_ref: "default",
    },
    kabumoriSettings,
  );
}

function fixtureOpenAiResponse(text: string): typeof fetch {
  return async () =>
    Response.json({
      output: [{ content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 120, output_tokens: 80 },
    });
}

test("generates real AI Lab content using only its own voice instructions, and records usage/cost", async () => {
  let capturedInstructions = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedInstructions = String(JSON.parse(String(init?.body)).instructions);
    return Response.json({
      output: [{
        content: [{
          type: "output_text",
          text:
            "AIツールで議事録を自動要約すると、確認作業がぐっと楽になります。",
        }],
      }],
      usage: { input_tokens: 150, output_tokens: 90 },
    });
  };
  const draft = await generateBrandPost({
    openAiApiKey: "fixture-only",
    context: aiLabContext(),
    postType: "brand_post",
    fetchImpl,
  });
  assert.equal(draft.brandId, "ai_salaryman_lab");
  assert.equal(draft.postType, "brand_post");
  assert.match(draft.text, /議事録/u);
  assert.equal(draft.model, "gpt-5.6-luna");
  assert.equal(draft.inputTokens, 150);
  assert.equal(draft.outputTokens, 90);
  assert.ok(draft.apiCostUsd > 0);
  assert.match(
    capturedInstructions,
    /未確認の人物像、実績、勤務先、投資経験、具体的な収益額・成果は作らないでください/u,
  );
  // The instructions legitimately *mention* Kabumori in the negative ("don't use Kabumori's voice/tags")
  // -- what must never appear is the generated text itself carrying Kabumori's actual voice/hashtags.
  assert.doesNotMatch(draft.text, /かぶモリ|#日本株|#日経平均|#株式投資/u);
});

test("AI Lab output never carries Kabumori's fixed hashtags because its own settings have none configured", async () => {
  const draft = await generateBrandPost({
    openAiApiKey: "fixture-only",
    context: aiLabContext(),
    postType: "brand_post",
    fetchImpl: fixtureOpenAiResponse("今日のAI活用メモです。"),
  });
  assert.doesNotMatch(draft.text, /#かぶモリ|#日本株|#日経平均|#株式投資/u);
});

test("the same generator instructs Kabumori's own fixed hashtags when given a Kabumori-shaped context, proving no brand is special-cased", async () => {
  let capturedInstructions = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedInstructions = String(JSON.parse(String(init?.body)).instructions);
    return Response.json({
      output: [{
        content: [{ type: "output_text", text: "本日のまとめです。" }],
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  const kabumoriWithHashtags = resolveBrandContext(
    {
      id: "kabumori",
      display_name: "かぶモリ",
      is_active: true,
      publish_mode: "live",
      code_profile_key: "kabumori_v1",
    },
    {
      id: "kabumori_x",
      brand_id: "kabumori",
      platform: "x",
      handle: "yume_daka",
      publish_enabled: true,
      oauth_client_ref: "default",
    },
    {
      brand_id: "kabumori",
      fixed_hashtags: ["#日本株"],
      note_url: null,
      image_policy: {},
      enabled_post_types: [],
    },
  );
  await generateBrandPost({
    openAiApiKey: "fixture-only",
    context: kabumoriWithHashtags,
    postType: "tip",
    fetchImpl,
  });
  assert.match(capturedInstructions, /#日本株/u);
  assert.match(capturedInstructions, /200〜400文字程度/u);
  assert.doesNotMatch(capturedInstructions, /文字数上限は設定されていません/u);
});

test("a disabled brand is rejected before any OpenAI call, and an unsupported post_type is rejected after context checks but still before use", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return fixtureOpenAiResponse("x")(new Request("https://example.test"));
  };
  await assert.rejects(
    () =>
      generateBrandPost({
        openAiApiKey: "fixture-only",
        context: aiLabContext("disabled"),
        postType: "brand_post",
        fetchImpl,
      }),
    { message: "BRAND_DISABLED" },
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () =>
      generateBrandPost({
        openAiApiKey: "fixture-only",
        context: aiLabContext(),
        postType: "not_a_real_post_type",
        fetchImpl,
      }),
    { message: "BRAND_POST_TYPE_UNSUPPORTED" },
  );
  assert.equal(calls, 0);
});

test("live publish_mode is also allowed to generate (generation and the X-write gate are independent checks)", async () => {
  const draft = await generateBrandPost({
    openAiApiKey: "fixture-only",
    context: aiLabContext("live"),
    postType: "brand_post",
    fetchImpl: fixtureOpenAiResponse("本日のAI活用メモです。"),
  });
  assert.equal(draft.brandId, "ai_salaryman_lab");
});

test("AI Lab generation prompts for 280 code points and fails closed when the model returns 281", async () => {
  let capturedInstructions = "";
  await assert.rejects(() =>
    generateBrandPost({
      openAiApiKey: "fixture-only",
      context: aiLabContext(),
      postType: "brand_post",
      fetchImpl: async (_input, init) => {
        capturedInstructions = String(
          JSON.parse(String(init?.body)).instructions,
        );
        return fixtureOpenAiResponse("あ".repeat(281))(
          new Request("https://example.test"),
        );
      },
    }), { message: "BRAND_POST_LENGTH_LIMIT_EXCEEDED" });
  assert.match(capturedInstructions, /280文字以内/u);
});

test("the generic unlimited mode is explicit and preserves generation for longer content", async () => {
  const context = aiLabContext();
  context.codeProfile = {
    ...context.codeProfile,
    postLengthPolicy: UNLIMITED_POST_LENGTH,
  };
  const draft = await generateBrandPost({
    openAiApiKey: "fixture-only",
    context,
    postType: "brand_post",
    fetchImpl: fixtureOpenAiResponse("長文。".repeat(200)),
  });
  assert.equal(draft.characterCount, 600);
});

test("Kabumori profile has no implicit 280-character limit", async () => {
  const draft = await generateBrandPost({
    openAiApiKey: "fixture-only",
    context: kabumoriContext(),
    postType: "tip",
    fetchImpl: fixtureOpenAiResponse("株の話。".repeat(100)),
  });
  assert.equal(draft.characterCount, 400);
});

test("a non-2xx OpenAI response or empty output text fails closed with a distinct code, never returning a draft", async () => {
  await assert.rejects(
    () =>
      generateBrandPost({
        openAiApiKey: "fixture-only",
        context: aiLabContext(),
        postType: "brand_post",
        fetchImpl: async () => new Response("rate limited", { status: 429 }),
      }),
    { message: "BRAND_POST_GENERATION_FAILED:429" },
  );
  await assert.rejects(
    () =>
      generateBrandPost({
        openAiApiKey: "fixture-only",
        context: aiLabContext(),
        postType: "brand_post",
        fetchImpl: async () => Response.json({ output: [] }),
      }),
    { message: "BRAND_POST_EMPTY_OUTPUT" },
  );
});

test("social-mobile preview can generate only with its generic profile while leaving the workspace disabled", async () => {
  const context = resolveBrandContext(
    {
      id: "user_workspace",
      display_name: "My Workspace",
      is_active: false,
      publish_mode: "disabled",
      code_profile_key: "social_mobile_user_v1",
    },
    null,
    {
      brand_id: "user_workspace",
      fixed_hashtags: [],
      note_url: null,
      image_policy: { mode: "none" },
      enabled_post_types: ["brand_post"],
    },
  );
  let capturedBody: Record<string, unknown> | null = null;
  const draft = await generateBrandPost({
    openAiApiKey: "fixture-only",
    context,
    postType: "brand_post",
    generationPurpose: "social_mobile_preview",
    contentSettings: {
      preferredTone: "親しみやすい",
      locale: "ja-JP",
      themes: ["仕事の小さな工夫"],
      objective: "役立つ気づき",
      frequencyTargetPerWeek: 3,
      approvalMode: "manual_review",
      generationWindow: {
        timezone: "Asia/Tokyo",
        startLocal: "09:00",
        endLocal: "24:00",
        defaultGenerationLocal: "17:00",
        generationDayOffset: -1,
      },
      optionalNgWords: ["絶対儲かる"],
      notes: "",
      livePublishingEnabled: false,
    },
    fetchImpl: async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return fixtureOpenAiResponse("小さな工夫を試してみませんか。")(
        new Request("https://example.test"),
      );
    },
  });
  assert.equal(draft.brandId, "user_workspace");
  assert.match(
    String(capturedBody?.input),
    /日々の生活や仕事に役立つ小さな工夫/u,
  );
  assert.match(
    String(capturedBody?.instructions),
    /希望するトーン: 親しみやすい/u,
  );
  assert.match(String(capturedBody?.instructions), /避ける語句: 絶対儲かる/u);
  assert.equal(context.brand.is_active, false);
  assert.equal(context.brand.publish_mode, "disabled");
  await assert.rejects(() =>
    generateBrandPost({
      openAiApiKey: "fixture-only",
      context,
      postType: "brand_post",
      fetchImpl: fixtureOpenAiResponse("not allowed"),
    }), { message: "BRAND_DISABLED" });
});

test("social-mobile preview purpose rejects other brands instead of falling back to another profile", async () => {
  let calls = 0;
  await assert.rejects(() =>
    generateBrandPost({
      openAiApiKey: "fixture-only",
      context: aiLabContext(),
      postType: "brand_post",
      generationPurpose: "social_mobile_preview",
      fetchImpl: async () => {
        calls += 1;
        return fixtureOpenAiResponse("not allowed")(
          new Request("https://example.test"),
        );
      },
    }), { message: "SOCIAL_MOBILE_PREVIEW_PROFILE_REQUIRED" });
  assert.equal(calls, 0);
});
