import assert from "node:assert/strict";
import test from "node:test";
import { createAiLabTextProvider } from "./ai_lab_post.ts";
import {
  anthropicBody,
  FAKE_ANTHROPIC_KEY,
  fakeEnv,
  jsonResponse,
  recordingFetch,
} from "./test_support.ts";
import { resolveBrandContext } from "../brand/brand_context.ts";
import { generateBrandPost } from "../brand/brand_post_generator.ts";
import { createAiLabScheduledPostGenerator } from "../brand/ai_lab_engagement.ts";
import { collectAiLabEngagementViolations } from "../brand/ai_lab_engagement_guard.ts";

const request = () => ({
  brandId: "ai_salaryman_lab",
  postType: "brand_post",
  instructions: "人格と題材の指示",
  input: "今日のテーマ: ボタンの位置",
  maxOutputTokens: 2000,
});
type MessageBody = {
  model: string;
  max_tokens: number;
  system: string;
  messages: { content: string }[];
  output_config: {
    effort: string;
    format: { type: string; schema: { properties: Record<string, unknown> } };
  };
};
function fixture(
  responder = () =>
    jsonResponse(
      200,
      anthropicBody({
        text: "ボタンの位置で迷ったことはありますか？ #個人開発",
      }),
    ),
) {
  const env = fakeEnv({ AI_LAB_TEXT_API_KEY: FAKE_ANTHROPIC_KEY });
  const recorder = recordingFetch(responder);
  return {
    env,
    recorder,
    provider: createAiLabTextProvider({
      readEnv: env.readEnv,
      fetch: recorder.fetch,
    }),
  };
}

test("AI Lab uses only Opus Messages, low effort and strict JSON; usage/model/cost remain accurate", async () => {
  const { provider, recorder, env } = fixture();
  const result = await provider(request());
  assert.equal(result.model, "claude-opus-5-5");
  assert.ok(result.apiCostUsd > 0);
  assert.ok(result.inputTokens > 0);
  assert.deepEqual(env.reads, ["AI_LAB_TEXT_API_KEY"]);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].url, "https://api.anthropic.com/v1/messages");
  const body = recorder.calls[0].body as MessageBody;
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.output_config.effort, "low");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.max_tokens, 2000);
  assert.equal(body.messages[0].content, request().input);
});

test("other brands/types and invalid output budgets reject before key access and network", async () => {
  for (
    const change of [
      { brandId: "kabumori" },
      { brandId: "social_mobile_user" },
      { postType: "profile_preview" },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 3073 },
    ]
  ) {
    const { provider, recorder, env } = fixture();
    await assert.rejects(provider({ ...request(), ...change }), /AI_LAB_OPUS_/);
    assert.equal(recorder.calls.length, 0);
    assert.equal(env.reads.length, 0);
  }
});

test("one dispatch shares its budget across content retries: fourth call and oversized prompt send nothing", async () => {
  const { provider, recorder } = fixture();
  for (let i = 0; i < 3; i++) await provider(request());
  await assert.rejects(provider(request()), /BUDGET_DENIED/);
  assert.equal(recorder.calls.length, 3);
  const oversized = fixture();
  await assert.rejects(
    oversized.provider({ ...request(), input: "あ".repeat(50000) }),
    /BUDGET_DENIED/,
  );
  assert.equal(oversized.recorder.calls.length, 0);
});

for (const status of [400, 401, 402, 429, 500, 529]) {
  test(`HTTP ${status} never retries or falls back`, async () => {
    const { provider, recorder } = fixture(() =>
      jsonResponse(status, {
        type: "error",
        error: { type: "api_error", message: "synthetic" },
      })
    );
    await assert.rejects(provider(request()), /AI_LAB_OPUS_GENERATION_FAILED/);
    assert.equal(recorder.calls.length, 1);
    assert.ok(
      recorder.calls.every((c) =>
        c.url.startsWith("https://api.anthropic.com/")
      ),
    );
  });
}

for (
  const [name, body] of [
    [
      "incomplete",
      anthropicBody({ text: "途中" }, { stopReason: "max_tokens" }),
    ],
    ["refusal", anthropicBody({ text: "拒否" }, { stopReason: "refusal" })],
    ["bad JSON", anthropicBody(null, { text: "invalid-json" })],
    ["schema violation", anthropicBody({ text: 123 })],
    ["empty text", anthropicBody({ text: " " })],
    [
      "model mismatch",
      anthropicBody({ text: "本文" }, { model: "unexpected-model" }),
    ],
  ] as const
) {
  test(`${name} is rejected after exactly one request`, async () => {
    const { provider, recorder } = fixture(() => jsonResponse(200, body));
    await assert.rejects(provider(request()), /AI_LAB_OPUS_/);
    assert.equal(recorder.calls.length, 1);
  });
}

test("network ambiguity does not retry and missing key makes zero requests", async () => {
  const recorder = recordingFetch(() => {
    throw new TypeError("synthetic connection loss");
  });
  const provider = createAiLabTextProvider({
    readEnv: fakeEnv({ AI_LAB_TEXT_API_KEY: FAKE_ANTHROPIC_KEY }).readEnv,
    fetch: recorder.fetch,
  });
  await assert.rejects(provider(request()), /AI_LAB_OPUS_GENERATION_FAILED/);
  assert.equal(recorder.calls.length, 1);
  const missing = recordingFetch(() => {
    throw new Error("must not send");
  });
  await assert.rejects(
    createAiLabTextProvider({ readEnv: () => undefined, fetch: missing.fetch })(
      request(),
    ),
    /KEY_MISSING/,
  );
  assert.equal(missing.calls.length, 0);
  // Even a working common credential is never used when the brand-specific alias is absent.
  await assert.rejects(
    createAiLabTextProvider({
      readEnv: fakeEnv().readEnv,
      fetch: missing.fetch,
    })(request()),
    /KEY_MISSING/,
  );
  assert.equal(missing.calls.length, 0);
});

test("real AI Lab/generic generator composition preserves all four modes and native poll schema", async () => {
  const context = resolveBrandContext(
    {
      id: "ai_salaryman_lab",
      display_name: "AI Lab",
      is_active: true,
      publish_mode: "dry_run",
      code_profile_key: "ai_salaryman_lab_v1",
    },
    null,
    {
      brand_id: "ai_salaryman_lab",
      fixed_hashtags: [],
      note_url: null,
      image_policy: {},
      enabled_post_types: ["brand_post"],
    },
  );
  for (const index of [0, 2, 5, 8]) {
    const poll = index === 8;
    const payload = poll
      ? {
        text: "何を優先しますか？ #個人開発",
        poll_options: ["新機能", "迷わない操作", "半々"],
      }
      : { text: "ボタンの場所で迷ったことはありますか？ #個人開発" };
    const { provider, recorder } = fixture(() =>
      jsonResponse(200, anthropicBody(payload))
    );
    const generate = createAiLabScheduledPostGenerator(
      index,
      (args) =>
        generateBrandPost({
          ...args,
          textProvider: provider,
          fetchImpl: () => {
            throw new Error("OpenAI fallback forbidden");
          },
        }),
    );
    const draft = await generate({
      openAiApiKey: "unused",
      context,
      postType: "brand_post",
      topicSeed: "ボタンの位置を見直す",
      retryViolations: [],
    });
    assert.equal(draft.model, "claude-opus-5-5");
    assert.equal(draft.text, payload.text);
    assert.deepEqual(collectAiLabEngagementViolations(draft), []);
    const body = recorder.calls[0].body as MessageBody;
    if (poll) {
      assert.deepEqual(
        (draft as { pollOptions?: string[] }).pollOptions,
        payload.poll_options,
      );
      assert.ok(body.output_config.format.schema.properties.poll_options);
    } else if (index === 0) {
      assert.match(body.system, /200〜300文字程度/);
      assert.match(body.system, /近況を補わない/);
    } else {
      assert.match(body.system, /最大120文字/);
    }
  }
});
