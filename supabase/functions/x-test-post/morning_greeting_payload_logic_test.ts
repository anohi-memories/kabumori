import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MORNING_GREETING_PAYLOAD_TEST_MODE,
  MorningGreetingPayloadDryRunError,
  runMorningGreetingPayloadDryRun,
} from "./morning_greeting_payload_logic.ts";
import { selectMorningGreetingTheme } from "./morning_greeting_logic.ts";

const GENERATED_TEXT =
  "おはようございます☀️ いつもの朝からゆっくり始めます。コーヒーでも飲みながら、焦らず自分のペースを整えていけたら十分です。平日の真ん中、やることを詰め込みすぎず、少し肩の力を抜いて進んでいきましょう🌱";

function openAiResponse(date = "2026-09-02"): Response {
  const theme = selectMorningGreetingTheme(date);
  return new Response(JSON.stringify({
    status: "completed",
    output: [{ content: [{ type: "output_text", text: JSON.stringify({
      theme_type: theme.theme_type,
      theme_name: theme.theme_name,
      visual_theme: theme.visual_theme,
      generated_text: GENERATED_TEXT,
    }) }] }],
    usage: { input_tokens: 100, output_tokens: 80 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("existing image builds a safe pre-publish payload with one text API call", async () => {
  const calls: string[] = [];
  const result = await runMorningGreetingPayloadDryRun({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-secret",
    openAiApiKey: "openai-secret",
    now: new Date("2026-09-01T15:30:00Z"),
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://api.openai.com/v1/responses") return openAiResponse();
      assert.match(url, /morning-greeting-assets\/generated\/2026-09-02\.png$/u);
      return new Response(new Uint8Array([137]), { status: 206 });
    },
  });

  assert.equal(result.date_jst, "2026-09-02");
  assert.equal(result.theme, "generic");
  assert.equal(result.theme_name, null);
  assert.equal(result.image_exists, true);
  assert.equal(result.theme_match, true);
  assert.equal(result.payload_ready, true);
  assert.equal(result.openai_text_api_called, 1);
  assert.equal(result.retry_count, 0);
  assert.equal(result.x_api_called, 0);
  assert.equal(result.x_posted, false);
  assert.equal(calls.filter((url) => url.includes("api.openai.com/v1/responses")).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /service-role-secret|openai-secret/u);
});

test("missing image stops safely after one text API call", async () => {
  await assert.rejects(
    () => runMorningGreetingPayloadDryRun({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role-secret",
      openAiApiKey: "openai-secret",
      now: new Date("2026-09-01T15:30:00Z"),
      fetchImpl: async (input) => String(input).includes("api.openai.com")
        ? openAiResponse()
        : new Response("missing", { status: 404 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingPayloadDryRunError);
      assert.equal(error.message, "MORNING_GREETING_IMAGE_NOT_FOUND");
      assert.equal(error.openAiTextApiCalled, 1);
      assert.equal(error.imageExists, false);
      return true;
    },
  );
});

test("theme mismatch stops safely", async () => {
  await assert.rejects(
    () => runMorningGreetingPayloadDryRun({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role-secret",
      openAiApiKey: "openai-secret",
      now: new Date("2026-09-01T15:30:00Z"),
      fetchImpl: async (input) => String(input).includes("api.openai.com")
        ? openAiResponse()
        : new Response(new Uint8Array([137]), { status: 206 }),
      resolveImageTheme: () => selectMorningGreetingTheme("2026-09-01"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingPayloadDryRunError);
      assert.equal(error.message, "MORNING_GREETING_THEME_MISMATCH");
      assert.equal(error.openAiTextApiCalled, 1);
      assert.equal(error.imageExists, true);
      assert.equal(error.themeMatch, false);
      return true;
    },
  );
});

test("text generation failure is not retried and never checks Storage", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => runMorningGreetingPayloadDryRun({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role-secret",
      openAiApiKey: "openai-secret",
      now: new Date("2026-09-01T15:30:00Z"),
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response("failed", { status: 500 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingPayloadDryRunError);
      assert.equal(error.message, "MORNING_GREETING_OPENAI_FAILED:500");
      assert.equal(error.openAiTextApiCalled, 1);
      return true;
    },
  );
  assert.deepEqual(calls, ["https://api.openai.com/v1/responses"]);
});

test("index branches payload dry-run before X auth and dispatcher", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const mode = source.indexOf("isMorningGreetingPayloadTest");
  const branch = source.indexOf("if (isMorningGreetingPayloadTest)");
  const xAuth = source.indexOf("const xAuth: XAuthContext");
  const dispatcher = source.indexOf("await claimDuePost(", xAuth);
  assert.ok(mode >= 0);
  assert.ok(branch > mode);
  assert.ok(xAuth > branch);
  assert.ok(dispatcher > xAuth);
  const branchSource = source.slice(branch, source.indexOf("if (isMorningGreetingImageTest)", branch));
  assert.match(branchSource, /x_api_called: 0/u);
  assert.match(branchSource, /x_posted: false/u);
  assert.doesNotMatch(branchSource, /postToX|claimDuePost|loadXTokens/u);
  assert.equal(MORNING_GREETING_PAYLOAD_TEST_MODE, "test_morning_greeting_payload");
  assert.match(source, /MORNING_GREETING_PAYLOAD_TEST_MODE/u);
});
