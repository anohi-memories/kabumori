import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrandContext, type BrandOperationalSettings } from "./brand_context.ts";
import { generateBrandPost } from "./brand_post_generator.ts";

const aiLabSettings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: ["brand_post"],
};
const kabumoriSettings: BrandOperationalSettings = {
  brand_id: "kabumori", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: [],
};

function aiLabContext(publishMode: "disabled" | "dry_run" | "live" = "dry_run") {
  return resolveBrandContext(
    { id: "ai_salaryman_lab", display_name: "AIサラリーマン研究所", is_active: publishMode !== "disabled", publish_mode: publishMode, code_profile_key: "ai_salaryman_lab_v1" },
    { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab", publish_enabled: false, oauth_client_ref: "default" },
    aiLabSettings,
  );
}

function kabumoriContext() {
  return resolveBrandContext(
    { id: "kabumori", display_name: "かぶモリ", is_active: true, publish_mode: "live", code_profile_key: "kabumori_v1" },
    { id: "kabumori_x", brand_id: "kabumori", platform: "x", handle: "yume_daka", publish_enabled: true, oauth_client_ref: "default" },
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
      output: [{ content: [{ type: "output_text", text: "AIツールで議事録を自動要約すると、確認作業がぐっと楽になります。" }] }],
      usage: { input_tokens: 150, output_tokens: 90 },
    });
  };
  const draft = await generateBrandPost({
    openAiApiKey: "fixture-only", context: aiLabContext(), postType: "brand_post", fetchImpl,
  });
  assert.equal(draft.brandId, "ai_salaryman_lab");
  assert.equal(draft.postType, "brand_post");
  assert.match(draft.text, /議事録/u);
  assert.equal(draft.model, "gpt-5.6-luna");
  assert.equal(draft.inputTokens, 150);
  assert.equal(draft.outputTokens, 90);
  assert.ok(draft.apiCostUsd > 0);
  assert.match(capturedInstructions, /未確認の人物像、実績、勤務先、投資経験は作らないでください/u);
  // The instructions legitimately *mention* Kabumori in the negative ("don't use Kabumori's voice/tags")
  // -- what must never appear is the generated text itself carrying Kabumori's actual voice/hashtags.
  assert.doesNotMatch(draft.text, /かぶモリ|#日本株|#日経平均|#株式投資/u);
});

test("AI Lab output never carries Kabumori's fixed hashtags because its own settings have none configured", async () => {
  const draft = await generateBrandPost({
    openAiApiKey: "fixture-only", context: aiLabContext(), postType: "brand_post",
    fetchImpl: fixtureOpenAiResponse("今日のAI活用メモです。"),
  });
  assert.doesNotMatch(draft.text, /#かぶモリ|#日本株|#日経平均|#株式投資/u);
});

test("the same generator instructs Kabumori's own fixed hashtags when given a Kabumori-shaped context, proving no brand is special-cased", async () => {
  let capturedInstructions = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedInstructions = String(JSON.parse(String(init?.body)).instructions);
    return Response.json({ output: [{ content: [{ type: "output_text", text: "本日のまとめです。" }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const kabumoriWithHashtags = resolveBrandContext(
    { id: "kabumori", display_name: "かぶモリ", is_active: true, publish_mode: "live", code_profile_key: "kabumori_v1" },
    { id: "kabumori_x", brand_id: "kabumori", platform: "x", handle: "yume_daka", publish_enabled: true, oauth_client_ref: "default" },
    { brand_id: "kabumori", fixed_hashtags: ["#日本株"], note_url: null, image_policy: {}, enabled_post_types: [] },
  );
  await generateBrandPost({ openAiApiKey: "fixture-only", context: kabumoriWithHashtags, postType: "tip", fetchImpl });
  assert.match(capturedInstructions, /#日本株/u);
});

test("a disabled brand is rejected before any OpenAI call, and an unsupported post_type is rejected after context checks but still before use", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls += 1; return fixtureOpenAiResponse("x")(new Request("https://example.test")); };
  await assert.rejects(
    () => generateBrandPost({ openAiApiKey: "fixture-only", context: aiLabContext("disabled"), postType: "brand_post", fetchImpl }),
    { message: "BRAND_DISABLED" },
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () => generateBrandPost({ openAiApiKey: "fixture-only", context: aiLabContext(), postType: "not_a_real_post_type", fetchImpl }),
    { message: "BRAND_POST_TYPE_UNSUPPORTED" },
  );
  assert.equal(calls, 0);
});

test("live publish_mode is also allowed to generate (generation and the X-write gate are independent checks)", async () => {
  const draft = await generateBrandPost({
    openAiApiKey: "fixture-only", context: aiLabContext("live"), postType: "brand_post",
    fetchImpl: fixtureOpenAiResponse("本日のAI活用メモです。"),
  });
  assert.equal(draft.brandId, "ai_salaryman_lab");
});

test("a non-2xx OpenAI response or empty output text fails closed with a distinct code, never returning a draft", async () => {
  await assert.rejects(
    () => generateBrandPost({
      openAiApiKey: "fixture-only", context: aiLabContext(), postType: "brand_post",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    }),
    { message: "BRAND_POST_GENERATION_FAILED:429" },
  );
  await assert.rejects(
    () => generateBrandPost({
      openAiApiKey: "fixture-only", context: aiLabContext(), postType: "brand_post",
      fetchImpl: async () => Response.json({ output: [] }),
    }),
    { message: "BRAND_POST_EMPTY_OUTPUT" },
  );
});
