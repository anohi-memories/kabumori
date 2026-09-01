import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildMorningGreetingGeneratedPath,
  MorningGreetingImageWorkflowError,
  resolveJstDate,
  runMorningGreetingImageWorkflow,
} from "./morning-greeting-image.ts";
import { OPENAI_MORNING_GREETING_IMAGE_ENDPOINT } from
  "../supabase/functions/x-test-post/morning_greeting_image_logic.ts";

const SUPABASE_URL = "https://example.supabase.co";

function pngResponse(): Response {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

test("successful run fetches canonical, calls image edit once, and stores generated date path", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await runMorningGreetingImageWorkflow({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test",
    openAiApiKey: "openai-test",
    date: "2026-09-01",
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (calls.length === 1) {
        assert.match(url, /generated\/2026-09-01\.png$/u);
        assert.equal(init?.method, undefined);
        return new Response("missing", { status: 404 });
      }
      if (url.endsWith("canonical/yume-reference.png")) return pngResponse();
      if (url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT) {
        const form = init?.body as FormData;
        assert.equal(form.get("model"), "gpt-image-2");
        assert.ok(form.get("image") instanceof Blob);
        assert.match(String(form.get("prompt")), /warm brown eyes/u);
        assert.match(String(form.get("prompt")), /softly wavy brown hair with side-parted bangs/u);
        assert.match(String(form.get("prompt")), /防災/u);
        return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw==" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      assert.match(url, /generated\/2026-09-01\.png$/u);
      assert.doesNotMatch(url, /canonical\/yume-reference\.png$/u);
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>)["x-upsert"], "false");
      return new Response("stored", { status: 200 });
    },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.output_storage_path,
    "storage://morning-greeting-assets/generated/2026-09-01.png");
  assert.equal(result.image_api_called, 1);
  assert.equal(result.retry_count, 0);
  assert.equal(result.x_api_called, 0);
  assert.equal(result.scheduled_posts_changed, 0);
  assert.equal(calls.filter((call) => call.url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT).length, 1);
});

test("canonical fetch failure stops before image API and upload", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => runMorningGreetingImageWorkflow({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: "service-role-test",
      openAiApiKey: "openai-test",
      date: "2026-09-01",
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        return new Response("missing", { status: 404 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingImageWorkflowError);
      assert.equal(error.imageApiCalled, 0);
      assert.match(error.message, /YUME_CANONICAL_REFERENCE_NOT_FOUND/u);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("existing same-day object skips generation and performs no write", async () => {
  const calls: string[] = [];
  const result = await runMorningGreetingImageWorkflow({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test",
    openAiApiKey: "openai-test",
    date: "2026-09-01",
    fetchImpl: async (input) => {
      calls.push(String(input));
      return new Response(new Uint8Array([137]), { status: 206 });
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.image_api_called, 0);
  assert.equal(calls.length, 1);
});

test("OpenAI failure is not retried and output is not uploaded", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => runMorningGreetingImageWorkflow({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: "service-role-test",
      openAiApiKey: "openai-test",
      date: "2026-09-01",
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (calls.length === 1) return new Response("missing", { status: 404 });
        if (url.endsWith("canonical/yume-reference.png")) return pngResponse();
        return new Response("failed", { status: 500 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingImageWorkflowError);
      assert.equal(error.imageApiCalled, 1);
      assert.match(error.message, /OPENAI_FAILED:500/u);
      return true;
    },
  );
  assert.equal(calls.filter((url) => url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT).length, 1);
  assert.equal(calls.length, 3);
});

test("generated path is date-scoped and cannot overwrite canonical", () => {
  assert.equal(buildMorningGreetingGeneratedPath("2026-09-01"), "generated/2026-09-01.png");
  assert.throws(() => buildMorningGreetingGeneratedPath("2026-02-30"), /DATE_INVALID/u);
  assert.notEqual(buildMorningGreetingGeneratedPath("2026-09-01"), "canonical/yume-reference.png");
});

test("default date uses Asia Tokyo calendar date", () => {
  assert.equal(resolveJstDate(new Date("2026-08-31T23:30:00Z")), "2026-09-01");
});

test("workflow is manual-only and injects only the required secrets", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/morning-greeting-image.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^\s*schedule:/mu);
  assert.match(workflow, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/u);
  assert.match(workflow, /SUPABASE_URL: \$\{\{ secrets\.SUPABASE_URL \}\}/u);
  assert.match(workflow, /SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/u);
  assert.match(workflow, /timeout-minutes: 30/u);
  assert.match(workflow, /node --experimental-strip-types scripts\/morning-greeting-image\.ts/u);
  assert.doesNotMatch(workflow, /X_API|scheduled_posts|dispatcher/u);
});
