import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MORNING_GREETING_MANUAL_PUBLISH_MODE,
  MorningGreetingManualPublishError,
  runMorningGreetingManualPublish,
} from "./morning_greeting_publish_logic.ts";
import {
  MorningGreetingPayloadDryRunError,
  type MorningGreetingPayloadDryRunResult,
} from "./morning_greeting_payload_logic.ts";

const TEXT = "おはようございます☕️ 9月の朝ですね。今日も無理なく、ひとつずつ進めていきましょう🌿";
const DATE = "2026-09-02";

function readyPayload(): MorningGreetingPayloadDryRunResult {
  return {
    success: true,
    date_jst: DATE,
    text: TEXT,
    theme: "generic",
    theme_name: null,
    visual_theme: "朝の窓辺、コーヒー、観葉植物、やわらかい朝日",
    image_path: `storage://morning-greeting-assets/generated/${DATE}.png`,
    image_exists: true,
    theme_match: true,
    payload_ready: true,
    openai_text_api_called: 1,
    retry_count: 0,
    x_api_called: 0,
    x_posted: false,
    payload: {
      text: TEXT,
      image_path: `storage://morning-greeting-assets/generated/${DATE}.png`,
      scheduled_date: DATE,
      theme: "generic",
    },
  };
}

test("uploads one image, creates one X post, then records its id", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await runMorningGreetingManualPublish({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-secret",
    openAiApiKey: "openai-secret",
    xAccessToken: "x-secret",
    now: new Date("2026-09-01T15:30:00Z"),
    buildPayload: async () => readyPayload(),
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes(`/published/${DATE}.json`) && !init?.method) {
        return new Response(JSON.stringify({ message: "Object not found" }), { status: 400 });
      }
      if (url.includes("/rest/v1/publish_claims") && init?.method === "POST") {
        return Response.json([{ post_type: "morning_greeting", date_jst: DATE, status: "publishing" }]);
      }
      if (url.includes("/rest/v1/publish_claims") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        assert.equal(body.status, "published");
        assert.equal(body.x_post_id, "987654321");
        return Response.json([{ post_type: "morning_greeting", date_jst: DATE, status: "published" }]);
      }
      if (url.includes("/storage/v1/object/")) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url === "https://api.x.com/2/media/upload") {
        assert.equal(init?.method, "POST");
        assert.ok(init?.body instanceof FormData);
        assert.equal(init.body.get("media_category"), "tweet_image");
        return Response.json({ data: { id: "123456789" } });
      }
      if (url === "https://api.x.com/2/tweets") {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.text, TEXT);
        assert.deepEqual(body.media.media_ids, ["123456789"]);
        assert.equal(body.made_with_ai, true);
        return Response.json({ data: { id: "987654321" } });
      }
      if (url.includes(`/published/${DATE}.json`) && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        assert.equal(body.x_post_id, "987654321");
        assert.equal((init.headers as Record<string, string>)["x-upsert"], "false");
        return new Response(null, { status: 201 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(result.x_posted, true);
  assert.equal(result.x_post_id, "987654321");
  assert.equal(result.image_upload_succeeded, true);
  assert.equal(result.x_api_called, 2);
  assert.equal(result.x_post_api_called, 1);
  assert.equal(result.retry_count, 0);
  assert.equal(calls.filter(({ url }) => url === "https://api.x.com/2/media/upload").length, 1);
  assert.equal(calls.filter(({ url }) => url === "https://api.x.com/2/tweets").length, 1);
  assert.ok(calls.findIndex(({ url }) => url === "https://api.x.com/2/tweets") <
    calls.findIndex(({ url, init }) => url.includes(`/published/${DATE}.json`) && init?.method === "POST"));
  assert.ok(calls.findIndex(({ url, init }) => url.includes("/rest/v1/publish_claims") && init?.method === "POST") <
    calls.findIndex(({ url }) => url === "https://api.x.com/2/media/upload"));
});

test("an existing same-day post skips generation, upload and posting", async () => {
  let payloadCalls = 0;
  let fetchCalls = 0;
  const result = await runMorningGreetingManualPublish({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-secret",
    openAiApiKey: "openai-secret",
    xAccessToken: "x-secret",
    now: new Date("2026-09-01T15:30:00Z"),
    buildPayload: async () => {
      payloadCalls += 1;
      return readyPayload();
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ x_post_id: "existing-post" });
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.already_posted, true);
  assert.equal(result.x_post_id, "existing-post");
  assert.equal(result.x_api_called, 0);
  assert.equal(result.x_posted, false);
  assert.equal(payloadCalls, 0);
  assert.equal(fetchCalls, 1);
});

test("missing image stops before any X API call", async () => {
  await assert.rejects(
    () => runMorningGreetingManualPublish({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-secret",
      openAiApiKey: "openai-secret",
      xAccessToken: "x-secret",
      now: new Date("2026-09-01T15:30:00Z"),
      buildPayload: async () => readyPayload(),
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("/rest/v1/publish_claims") && init?.method === "POST") {
          return Response.json([{ post_type: "morning_greeting", date_jst: DATE, status: "publishing" }]);
        }
        return new Response("missing", { status: 404 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingManualPublishError);
      assert.equal(error.message, "MORNING_GREETING_IMAGE_DOWNLOAD_FAILED:404");
      assert.equal(error.xApiCalled, 0);
      assert.equal(error.xPosted, false);
      return true;
    },
  );
});

test("media upload failure is not retried and never posts text alone", async () => {
  let mediaCalls = 0;
  let postCalls = 0;
  await assert.rejects(
    () => runMorningGreetingManualPublish({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-secret",
      openAiApiKey: "openai-secret",
      xAccessToken: "x-secret",
      now: new Date("2026-09-01T15:30:00Z"),
      buildPayload: async () => readyPayload(),
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes(`/published/${DATE}.json`)) {
          return new Response("Object not found", { status: 400 });
        }
        if (url.includes("/rest/v1/publish_claims") && init?.method === "POST") {
          return Response.json([{ post_type: "morning_greeting", date_jst: DATE, status: "publishing" }]);
        }
        if (url.includes("/rest/v1/publish_claims") && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          assert.equal(body.status, "failed");
          assert.equal(body.error_code, "MORNING_GREETING_MEDIA_UPLOAD_FAILED:403");
          return Response.json([{ post_type: "morning_greeting", date_jst: DATE, status: "failed" }]);
        }
        if (url.includes("/storage/v1/object/")) return new Response(new Uint8Array([1]));
        if (url.includes("/media/upload")) {
          mediaCalls += 1;
          return new Response("denied", { status: 403 });
        }
        if (url.includes("/2/tweets")) postCalls += 1;
        throw new Error(`Unexpected URL: ${url}`);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingManualPublishError);
      assert.equal(error.message, "MORNING_GREETING_MEDIA_UPLOAD_FAILED:403");
      assert.equal(error.xApiCalled, 1);
      assert.equal(error.xPostApiCalled, 0);
      assert.equal(error.xPosted, false);
      return true;
    },
  );
  assert.equal(mediaCalls, 1);
  assert.equal(postCalls, 0);
});

test("4: a lost DB claim race stops before any X API call", async () => {
  let xApiCalls = 0;
  await assert.rejects(
    () => runMorningGreetingManualPublish({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-secret",
      openAiApiKey: "openai-secret",
      xAccessToken: "x-secret",
      now: new Date("2026-09-01T15:30:00Z"),
      buildPayload: async () => readyPayload(),
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes(`/published/${DATE}.json`)) {
          return new Response("Object not found", { status: 400 });
        }
        if (url.includes("/rest/v1/publish_claims") && init?.method === "POST") {
          // Another execution already holds today's claim: ignore-duplicates returns no rows.
          return Response.json([]);
        }
        if (url.includes("/2/media/upload") || url.includes("/2/tweets")) {
          xApiCalls += 1;
          throw new Error("must not be called");
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingManualPublishError);
      assert.equal(error.message, "MORNING_GREETING_PUBLISH_ALREADY_CLAIMED");
      assert.equal(error.xApiCalled, 0);
      assert.equal(error.xPosted, false);
      return true;
    },
  );
  assert.equal(xApiCalls, 0);
});

test("6+7: a length-invalid failure surfaces real retry_count/first_length/retry_length/length_failure_stage, never a hardcoded 0", async () => {
  await assert.rejects(
    () => runMorningGreetingManualPublish({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-secret",
      openAiApiKey: "openai-secret",
      xAccessToken: "x-secret",
      now: new Date("2026-09-01T15:30:00Z"),
      buildPayload: async () => {
        throw new MorningGreetingPayloadDryRunError("MORNING_GREETING_TEXT_LENGTH_INVALID", {
          openAiTextApiCalled: 2,
          imageExists: true,
          themeMatch: true,
          retryCount: 1,
          firstLength: 99,
          retryLength: 200,
          lengthFailureStage: "retry",
        });
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes(`/published/${DATE}.json`)) return new Response("Object not found", { status: 400 });
        if (url.includes("/rest/v1/publish_claims") && init?.method === "POST") {
          return Response.json([{ post_type: "morning_greeting", date_jst: DATE, status: "publishing" }]);
        }
        if (url.includes("/rest/v1/publish_claims") && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          assert.equal(body.status, "failed");
          assert.equal(body.error_code, "MORNING_GREETING_TEXT_LENGTH_INVALID");
          return Response.json([{ post_type: "morning_greeting", date_jst: DATE, status: "failed" }]);
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingManualPublishError);
      assert.equal(error.message, "MORNING_GREETING_TEXT_LENGTH_INVALID");
      assert.equal(error.retryCount, 1);
      assert.equal(error.firstLength, 99);
      assert.equal(error.retryLength, 200);
      assert.equal(error.lengthFailureStage, "retry");
      assert.equal(error.xApiCalled, 0);
      return true;
    },
  );
});

test("a non-length failure carries null length diagnostics instead of a misleading value", async () => {
  await assert.rejects(
    () => runMorningGreetingManualPublish({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-secret",
      openAiApiKey: "openai-secret",
      xAccessToken: "x-secret",
      now: new Date("2026-09-01T15:30:00Z"),
      buildPayload: async () => readyPayload(),
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes(`/published/${DATE}.json`)) return new Response("Object not found", { status: 400 });
        if (url.includes("/rest/v1/publish_claims") && init?.method === "POST") {
          return Response.json([{ post_type: "morning_greeting", date_jst: DATE, status: "publishing" }]);
        }
        if (url.includes("/rest/v1/publish_claims") && init?.method === "PATCH") {
          return Response.json([{ post_type: "morning_greeting", date_jst: DATE, status: "failed" }]);
        }
        return new Response("missing", { status: 404 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingManualPublishError);
      assert.equal(error.message, "MORNING_GREETING_IMAGE_DOWNLOAD_FAILED:404");
      assert.equal(error.retryCount, null);
      assert.equal(error.firstLength, null);
      assert.equal(error.retryLength, null);
      assert.equal(error.lengthFailureStage, null);
      return true;
    },
  );
});

test("manual mode is service-role protected and branches before dispatcher", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const mode = source.indexOf("isMorningGreetingManualPublish");
  const branch = source.indexOf("if (isMorningGreetingManualPublish)");
  const xAuth = source.indexOf("const xAuth: XAuthContext");
  const dispatcher = source.indexOf("await claimDuePost(", xAuth);
  assert.equal(MORNING_GREETING_MANUAL_PUBLISH_MODE, "publish_morning_greeting_manual");
  assert.ok(mode >= 0);
  assert.ok(branch > mode);
  assert.ok(xAuth > branch);
  assert.ok(dispatcher > xAuth);
  const branchSource = source.slice(branch, source.indexOf("if (isMorningGreetingPayloadTest)", branch));
  assert.match(branchSource, /Authorization/u);
  assert.match(branchSource, /serviceRoleKey/u);
  assert.match(branchSource, /runMorningGreetingManualPublish/u);
  assert.doesNotMatch(branchSource, /claimDuePost|postThreadToX/u);
});
