import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAiLabClaudeStages } from "./ai_lab_post.ts";
import {
  anthropicBody,
  FAKE_ANTHROPIC_KEY,
  fakeEnv,
  hangUntilAborted,
  jsonResponse,
  recordingFetch,
  type Responder,
} from "./test_support.ts";
import { resolveBrandContext } from "../brand/brand_context.ts";
import { createAiLabScheduledPostGenerator } from "../brand/ai_lab_engagement.ts";
import { dispatchAiLabScheduledBrandPost } from "../brand/ai_lab_scheduled_brand_post.ts";
import { generateBrandPost } from "../brand/brand_post_generator.ts";
import { fingerprintText } from "../brand/cross_brand_dedupe.ts";
import {
  aiLabVoiceRewriteRequest,
  isAllowedAiLabVoiceRewrite,
} from "../brand/ai_lab_voice_rewrite.ts";

const ORIGINAL =
  "通知の表示を2台で比較しています。\nhttps://example.test/notes\n#個人開発";
const EDITED =
  "通知の表示を2台で比較してます。\nhttps://example.test/notes\n#個人開発";
const options = ["通知", "予定", "履歴"];
const providerResponse = (payload: unknown) =>
  jsonResponse(200, anthropicBody(payload));

test("scheduled entry binds both stages in the AI Lab branch and keeps the native 24-hour transport", async () => {
  const source = await readFile(
    new URL("../../x-test-post/index.ts", import.meta.url),
    "utf8",
  );
  const brandBranch = source.slice(
    source.indexOf('if (scheduledPost.post_type === "brand_post") {'),
  );
  const aiLabBranch = brandBranch.slice(
    brandBranch.indexOf("const diaryMarkdown ="),
    brandBranch.indexOf("// Shared market report consumer"),
  );
  assert.match(
    aiLabBranch,
    /const \{ textProvider, rewriteVoice \} = createAiLabClaudeStages\(/u,
  );
  assert.match(
    aiLabBranch,
    /generateBrandPost\(\{ \.\.\.args, textProvider \}\)\),\s+rewriteVoice,/u,
  );
  assert.match(
    aiLabBranch,
    /requestXPost\(accessToken, text, undefined, pollOptions, "manual"\)/u,
  );
  assert.match(
    source,
    /poll: \{ options: pollOptions, duration_minutes: 1440 \}/u,
  );
  assert.equal(source.match(/createAiLabClaudeStages\(/gu)?.length, 1);
});

test("the editor keeps quotation, links, labels, line breaks and question intent exact", () => {
  const quote = "「通知を\n確認しています。\n」と書きました。";
  assert.equal(
    isAllowedAiLabVoiceRewrite(quote, quote.replace("しています", "してます")),
    false,
  );
  const link = "https://example.test/通知を確認しています。";
  assert.equal(
    isAllowedAiLabVoiceRewrite(link, link.replace("しています", "してます")),
    false,
  );
  assert.equal(
    isAllowedAiLabVoiceRewrite("どれを選びますか？", "どれを選びます。"),
    false,
  );
  assert.equal(
    isAllowedAiLabVoiceRewrite(ORIGINAL, EDITED.replace("\n#", "\n\n#")),
    false,
  );
});

function fixture(
  respond: Responder,
  {
    rotation = 0,
    flag = "enabled",
    key = FAKE_ANTHROPIC_KEY,
    publishError,
  }: { rotation?: number; flag?: string; key?: string; publishError?: Error } =
    {},
) {
  const events: string[] = [];
  const recorder = recordingFetch((call, index, init) => {
    events.push(`Claude:${index}`);
    return respond(call, index, init);
  });
  const env = fakeEnv({
    AI_LAB_CLAUDE_TWO_STAGE: flag,
    AI_LAB_TEXT_API_KEY: key,
    ANTHROPIC_API_KEY: "shared-key-must-never-be-used",
  });
  const { textProvider, rewriteVoice } = createAiLabClaudeStages({
    readEnv: env.readEnv,
    fetch: recorder.fetch,
  });
  const context = resolveBrandContext(
    {
      id: "ai_salaryman_lab",
      display_name: "fixture",
      is_active: true,
      publish_mode: "live",
      code_profile_key: "ai_salaryman_lab_v1",
    },
    {
      id: "ai_salaryman_lab_x",
      brand_id: "ai_salaryman_lab",
      platform: "x",
      handle: "kaishain_ai_lab",
      publish_enabled: true,
      oauth_client_ref: "default",
    },
    {
      brand_id: "ai_salaryman_lab",
      fixed_hashtags: [],
      note_url: null,
      image_policy: {},
      enabled_post_types: ["brand_post"],
    },
  );
  const payloads: { text: string; pollOptions?: string[] }[] = [];
  const completedFingerprints: string[] = [];
  let started = false;
  const args: Parameters<typeof dispatchAiLabScheduledBrandPost>[0] = {
    context,
    postType: "brand_post",
    scheduledPostId: "fixture-schedule",
    openAiApiKey: "fixture-only",
    loadRecentFingerprints: () => Promise.resolve([]),
    topic: {
      claim: () => {
        if (started) throw new Error("fixture: topic already started");
        events.push("claim");
        return Promise.resolve({
          claimId: "fixture-claim",
          eventKey: "fixture-event",
          unitKey: "fixture-unit",
          kind: "evergreen",
          topic: "通知と画面表示の確認",
        });
      },
      release: (_claim, reason) => {
        events.push(`release:${reason}`);
        return Promise.resolve("RELEASED");
      },
      startProvider: () => {
        events.push("start X");
        started = true;
        return Promise.resolve(true);
      },
      markAmbiguous: () => {
        events.push("ambiguous X");
        return Promise.resolve("AMBIGUOUS");
      },
      settlePublished: () => {
        events.push("settle");
        return Promise.resolve("PUBLISHED");
      },
    },
    generate: createAiLabScheduledPostGenerator(
      rotation,
      (request) =>
        generateBrandPost({
          ...request,
          textProvider,
          fetchImpl: (input, init) => {
            events.push("OpenAI");
            assert.equal(String(input), "https://api.openai.com/v1/responses");
            assert.equal(
              new Headers(init?.headers).get("authorization"),
              "Bearer fixture-only",
            );
            return Promise.resolve(jsonResponse(200, {
              output: [{ content: [{ type: "output_text", text: ORIGINAL }] }],
            }));
          },
        }),
    ),
    rewriteVoice,
    publishText: (text, pollOptions) => {
      events.push("X");
      payloads.push({ text, pollOptions });
      if (publishError) throw publishError;
      return Promise.resolve({ data: { id: "fixture-post" } });
    },
    completePublishedPost: ({ normalizedTextSha256 }) => {
      events.push("complete");
      completedFingerprints.push(normalizedTextSha256);
      return Promise.resolve({ fingerprintPersisted: true });
    },
  };
  return {
    args,
    events,
    recorder,
    env,
    payloads,
    completedFingerprints,
    textProvider,
    rewriteVoice,
  };
}

for (
  const [mode, rotation, original, edited] of [
    ["regular", 0, ORIGINAL, EDITED],
    [
      "experience",
      2,
      "通知が多いとき、見落としたことがありますか？",
      "通知が多いとき、見落としたことありますか？",
    ],
    [
      "opinion",
      5,
      "予定一覧に通知時刻を出す案、どう思いますか？",
      "予定一覧に通知時刻を出す案、どう思います？",
    ],
    [
      "choices",
      8,
      "最初に開くなら、どれを選びますか？",
      "最初に開くなら、どれを選びます？",
    ],
  ] as const
) {
  test(`Claude stages produce the checked ${mode} payload and fingerprint`, async () => {
    const pollOptions = mode === "choices" ? options : undefined;
    const f = fixture(
      (_call, index) =>
        providerResponse(
          index === 0 && pollOptions
            ? { text: original, poll_options: pollOptions }
            : { text: index === 0 ? original : edited },
        ),
      { rotation },
    );
    const result = await dispatchAiLabScheduledBrandPost(f.args);
    assert.deepEqual(f.events, [
      "claim",
      "Claude:0",
      "Claude:1",
      "start X",
      "X",
      "settle",
      "complete",
    ]);
    assert.deepEqual(f.payloads, [{ text: edited, pollOptions }]);
    assert.deepEqual(f.completedFingerprints, [await fingerprintText(edited)]);
    assert.equal(result.pollCreated, mode === "choices" ? true : undefined);
    assert.equal(result.characterCount, Array.from(edited).length);
    const calls = f.recorder.calls.map(({ url, headers, body }) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.equal(headers.get("x-api-key"), FAKE_ANTHROPIC_KEY);
      return body as { model: string; messages: { content: string }[] };
    });
    assert.deepEqual(calls.map(({ model }) => model), [
      "claude-opus-5-5",
      "claude-opus-5-5",
    ]);
    assert.deepEqual(JSON.parse(calls[1].messages[0].content), {
      original,
      mode,
      lineAlternatives: edited.split("\n").map((line, i) =>
        line === original.split("\n")[i] ? [] : [line]
      ),
    });
    assert.deepEqual(f.env.reads, [
      "AI_LAB_CLAUDE_TWO_STAGE",
      "AI_LAB_TEXT_API_KEY",
      "AI_LAB_TEXT_API_KEY",
    ]);
  });
}

test("flag OFF uses the existing OpenAI path and reads no Anthropic credential", async () => {
  const f = fixture(() => assert.fail("unexpected Claude call"), {
    flag: "off",
  });
  await dispatchAiLabScheduledBrandPost(f.args);
  assert.deepEqual(f.events, [
    "claim",
    "OpenAI",
    "start X",
    "X",
    "settle",
    "complete",
  ]);
  assert.deepEqual(f.env.reads, ["AI_LAB_CLAUDE_TWO_STAGE"]);
  assert.deepEqual(f.payloads, [{ text: ORIGINAL, pollOptions: undefined }]);
});

test("successful review of an already natural draft may leave every line intact", async () => {
  const f = fixture(() => providerResponse({ text: ORIGINAL }));
  await dispatchAiLabScheduledBrandPost(f.args);
  assert.equal(f.recorder.calls.length, 2);
  assert.equal(f.payloads[0].text, ORIGINAL);
});

test("original content and fingerprint guards run before rewrite", async () => {
  const rejected = fixture(() =>
    providerResponse({ text: "個人開発は、通知が多いです。" })
  );
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(rejected.args),
    /CONTENT_DIVERSITY_REJECTED/,
  );
  assert.deepEqual(rejected.events, [
    "claim",
    "Claude:0",
    "Claude:1",
    "Claude:2",
    "release:PRE_X_CONTENT_REJECTED",
  ]);
  for (const [text, calls] of [[ORIGINAL, 1], [EDITED, 2]] as const) {
    const f = fixture((_call, index) =>
      providerResponse({ text: index ? EDITED : ORIGINAL })
    );
    const normalizedTextSha256 = await fingerprintText(text);
    f.args.loadRecentFingerprints = () =>
      Promise.resolve([{
        brandId: "kabumori",
        normalizedTextSha256,
        publishedAt: new Date().toISOString(),
      }]);
    await assert.rejects(
      dispatchAiLabScheduledBrandPost(f.args),
      /CROSS_BRAND_DUPLICATE/,
    );
    assert.equal(f.recorder.calls.length, calls);
    assert.equal(f.events.at(-1), "release:PRE_X_FINGERPRINT_BLOCKED");
    assert.deepEqual(f.payloads, []);
  }
});

for (
  const [name, response, reason] of [
    [
      "changed fact",
      () => providerResponse({ text: EDITED.replace("2台", "3台") }),
      /VOICE_REWRITE_REJECTED/,
    ],
    ["invented achievement", () =>
      providerResponse({
        text: EDITED + "\n今日は100人に使ってもらえました。",
      }), /VOICE_REWRITE_REJECTED/],
    ["removed URL", () =>
      providerResponse({
        text: EDITED.replace("https://example.test/notes\n", ""),
      }), /VOICE_REWRITE_REJECTED/],
    [
      "removed tag",
      () => providerResponse({ text: EDITED.replace("#個人開発", "") }),
      /VOICE_REWRITE_REJECTED/,
    ],
    [
      "length violation",
      () => providerResponse({ text: "あ".repeat(121) }),
      /VOICE_REWRITE_REJECTED/,
    ],
    [
      "changed poll options",
      () =>
        providerResponse({
          text: EDITED,
          poll_options: ["別の選択肢", "履歴"],
        }),
      /AI_LAB_OPUS_GENERATION_FAILED/,
    ],
    ["HTTP 429", () =>
      jsonResponse(429, {
        error: { type: "rate_limit_error", message: "fixture" },
      }), /AI_LAB_OPUS_GENERATION_FAILED/],
    ["refusal", () =>
      jsonResponse(
        200,
        anthropicBody({ text: EDITED }, { stopReason: "refusal" }),
      ), /AI_LAB_OPUS_GENERATION_FAILED/],
    [
      "malformed",
      () => jsonResponse(200, anthropicBody(null, { text: "invalid JSON" })),
      /AI_LAB_OPUS_GENERATION_FAILED/,
    ],
    ["unknown response", () => {
      throw new TypeError("fixture disconnect");
    }, /AI_LAB_OPUS_GENERATION_FAILED/],
    [
      "timeout",
      (_call, _index, init) => hangUntilAborted(init),
      /AI_LAB_OPUS_GENERATION_FAILED:TIMEOUT/,
    ],
  ] satisfies [string, Responder, RegExp][]
) {
  test(`rewrite ${name} releases before X with no Claude retry or fallback`, async () => {
    const f = fixture(
      (call, index, init) =>
        index === 0
          ? providerResponse({ text: ORIGINAL, poll_options: options })
          : response(call, index, init),
      { rotation: 8 },
    );
    await assert.rejects(dispatchAiLabScheduledBrandPost(f.args), reason);
    assert.deepEqual(f.events.slice(0, -1), ["claim", "Claude:0", "Claude:1"]);
    assert.match(f.events.at(-1) ?? "", /^release:PRE_X_/u);
    assert.deepEqual(f.payloads, []);
  });
}

test("third original attempt still leaves exactly one rewrite; additional calls are blocked", async () => {
  const f = fixture((_call, index) =>
    providerResponse({
      text: index < 2
        ? "個人開発は、通知が多いです。"
        : index === 2
        ? ORIGINAL
        : EDITED,
    })
  );
  await dispatchAiLabScheduledBrandPost(f.args);
  assert.equal(f.recorder.calls.length, 4);
  assert.equal(f.payloads.length, 1);
  await assert.rejects(
    f.args.generate!({
      context: f.args.context,
      postType: "brand_post",
      openAiApiKey: "fixture",
      topicSeed: "通知",
      retryViolations: [],
    }),
    /BUDGET_DENIED/,
  );
  assert.equal(f.recorder.calls.length, 4);
});

test("rewrite stage has its own one-call limit even with remaining shared capacity", async () => {
  const f = fixture((_call, index) =>
    providerResponse({ text: index ? EDITED : ORIGINAL })
  );
  await dispatchAiLabScheduledBrandPost(f.args);
  await assert.rejects(
    f.rewriteVoice!(aiLabVoiceRewriteRequest({
      brandId: "ai_salaryman_lab",
      postType: "brand_post",
      text: ORIGINAL,
    })),
    /BUDGET_DENIED/,
  );
  assert.equal(f.recorder.calls.length, 2);
});

test("other brand, missing dedicated key and oversized estimated spend never send", async () => {
  const f = fixture(() => assert.fail("unexpected Claude call"));
  const request = {
    brandId: "ai_salaryman_lab",
    postType: "brand_post",
    instructions: "fixture",
    input: "あ".repeat(50000),
    maxOutputTokens: 2000,
  };
  await assert.rejects(
    f.textProvider!({ ...request, brandId: "kabumori" }),
    /SCOPE_MISMATCH/,
  );
  await assert.rejects(f.textProvider!(request), /BUDGET_DENIED/);
  assert.equal(f.recorder.calls.length, 0);
  const missing = fixture(() => assert.fail("unexpected Claude call"), {
    key: "",
  });
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(missing.args),
    /KEY_MISSING/,
  );
  assert.deepEqual(missing.env.reads, [
    "AI_LAB_CLAUDE_TWO_STAGE",
    "AI_LAB_TEXT_API_KEY",
  ]);
  assert.deepEqual(missing.payloads, []);
});

test("ambiguous X write keeps the claim and does not replay either Claude stage or X", async () => {
  const f = fixture(
    (_call, index) => providerResponse({ text: index ? EDITED : ORIGINAL }),
    {
      publishError: new TypeError("fixture X disconnect"),
    },
  );
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(f.args),
    /fixture X disconnect/,
  );
  await assert.rejects(
    dispatchAiLabScheduledBrandPost(f.args),
    /topic already started/,
  );
  assert.deepEqual(f.events, [
    "claim",
    "Claude:0",
    "Claude:1",
    "start X",
    "X",
    "ambiguous X",
  ]);
  assert.equal(f.payloads.length, 1);
  assert.deepEqual(f.completedFingerprints, []);
});
