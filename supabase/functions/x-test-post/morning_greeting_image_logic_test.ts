import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMorningGreetingImageTestOutputPath,
  buildMorningGreetingImagePrompt,
  generateMorningGreetingImageWithOpenAi,
  MorningGreetingImageTestError,
  OPENAI_MORNING_GREETING_IMAGE_ENDPOINT,
  runMorningGreetingImageTest,
} from "./morning_greeting_image_logic.ts";
import {
  buildMorningGreetingImageGenerationContext,
  resolveYumeCanonicalReference,
} from "./yume_reference_logic.ts";

test("Disaster Prevention Day prompt preserves Yume and changes only theme elements", () => {
  const reference = resolveYumeCanonicalReference();
  const context = buildMorningGreetingImageGenerationContext(
    "防災をテーマにした明るい場面、防災リュック、懐中電灯、保存水、防災用品",
    reference,
  );
  const metadata = buildMorningGreetingImagePrompt({
    date: "2026-09-01",
    themeName: "防災の日",
    reference,
    context,
  });
  assert.equal(metadata.canonical_reference_path, reference.canonical_reference_path);
  assert.equal(metadata.requested_size, "1024x1024");
  assert.match(metadata.prompt, /warm brown eyes/u);
  assert.match(metadata.prompt, /softly wavy brown hair with side-parted bangs/u);
  assert.match(metadata.prompt, /防災リュック/u);
  assert.match(metadata.prompt, /No text anywhere/u);
  assert.match(metadata.prompt, /Avoid: other people, robots, stock-market objects/u);
});

test("generic theme prompt does not add disaster-preparedness props", () => {
  const reference = resolveYumeCanonicalReference();
  const visualTheme = "朝の窓辺、コーヒー、観葉植物、やわらかい朝日";
  const context = buildMorningGreetingImageGenerationContext(visualTheme, reference);
  const metadata = buildMorningGreetingImagePrompt({
    date: "2026-09-02",
    themeName: null,
    reference,
    context,
  });
  assert.equal(metadata.theme_name, null);
  assert.equal(metadata.visual_theme, visualTheme);
  assert.match(metadata.prompt, /通常の自然な朝/u);
  assert.doesNotMatch(metadata.prompt, /防災の日|preparedness backpack|stored water/u);
});

test("reference mismatch stops before image generation", () => {
  const reference = resolveYumeCanonicalReference();
  const context = buildMorningGreetingImageGenerationContext("防災用品", reference);
  assert.throws(
    () => buildMorningGreetingImagePrompt({
      date: "2026-09-01",
      themeName: "防災の日",
      reference: { ...reference, canonical_reference_path: "storage://wrong/reference.png" },
      context,
    }),
    /MORNING_GREETING_IMAGE_REFERENCE_MISMATCH/,
  );
});

test("OpenAI image API path supplies the service-role-fetched canonical image exactly once", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/storage/v1/object/")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    assert.equal(url, OPENAI_MORNING_GREETING_IMAGE_ENDPOINT);
    return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw==" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await generateMorningGreetingImageWithOpenAi({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-test",
    openAiApiKey: "openai-test",
    date: "2026-09-01",
    themeName: "防災の日",
    visualTheme: "防災リュック、懐中電灯、保存水、防災用品、明るい朝",
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer service-role-test");
  assert.equal(calls[1].url, OPENAI_MORNING_GREETING_IMAGE_ENDPOINT);
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer openai-test");
  const form = calls[1].init?.body as FormData;
  assert.equal(form.get("model"), "gpt-image-2");
  assert.equal(form.get("size"), "1024x1024");
  assert.equal(form.get("n"), "1");
  assert.ok(form.get("image") instanceof Blob);
  assert.equal(result.metadata.api_call_count, 1);
  assert.equal(result.metadata.canonical_reference_supplied, true);
});

test("missing OpenAI key stops before Storage or image API calls", async () => {
  let calls = 0;
  await assert.rejects(
    () => generateMorningGreetingImageWithOpenAi({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role-test",
      openAiApiKey: "",
      date: "2026-09-01",
      themeName: "防災の日",
      visualTheme: "防災用品",
      fetchImpl: async () => {
        calls += 1;
        return new Response();
      },
    }),
    /MORNING_GREETING_IMAGE_OPENAI_AUTH_MISSING/,
  );
  assert.equal(calls, 0);
});

test("test mode fetches canonical, calls Images API once, and uploads only under test-output", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (calls.length === 1) {
      assert.match(url, /canonical\/yume-reference\.png$/u);
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    if (url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT) {
      return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw==" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert.match(url, /\/morning-greeting-assets\/test-output\//u);
    assert.doesNotMatch(url, /canonical\/yume-reference\.png/u);
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)["x-upsert"], "false");
    return new Response(JSON.stringify({ Key: "test-output/test.png" }), { status: 200 });
  };

  const result = await runMorningGreetingImageTest({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-test",
    openAiApiKey: "openai-test",
    nowIso: "2026-09-01T00:15:30.123Z",
    fetchImpl,
  });

  assert.equal(calls.length, 3);
  assert.equal(calls.filter((call) => call.url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT).length, 1);
  assert.equal(result.output_storage_path,
    "storage://morning-greeting-assets/test-output/2026-09-01T00-15-30-123Z.png");
  assert.equal(result.image_api_called, 1);
  assert.equal(result.x_api_called, 0);
  assert.equal(result.scheduled_posts_changed, 0);
  assert.equal(result.retry_count, 0);
  assert.equal(result.generation_metadata.canonical_reference_supplied, true);
});

test("canonical fetch failure stops before Images API and upload", async () => {
  let calls = 0;
  await assert.rejects(
    () => runMorningGreetingImageTest({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role-test",
      openAiApiKey: "openai-test",
      fetchImpl: async () => {
        calls += 1;
        return new Response("not found", { status: 404 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingImageTestError);
      assert.equal(error.imageApiCalled, 0);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("Images API failure is not retried and never uploads", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => runMorningGreetingImageTest({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role-test",
      openAiApiKey: "openai-test",
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/storage/v1/object/")) {
          return new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        return new Response("failed", { status: 500 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MorningGreetingImageTestError);
      assert.equal(error.imageApiCalled, 1);
      assert.match(error.message, /OPENAI_FAILED:500/u);
      return true;
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((url) => url === OPENAI_MORNING_GREETING_IMAGE_ENDPOINT).length, 1);
});

test("test output path is deterministic, isolated, and cannot target canonical", () => {
  const path = buildMorningGreetingImageTestOutputPath("2026-09-01T00:15:30.123Z");
  assert.equal(path, "test-output/2026-09-01T00-15-30-123Z.png");
  assert.doesNotMatch(path, /^canonical\//u);
  assert.throws(
    () => buildMorningGreetingImageTestOutputPath("not-a-date"),
    /MORNING_GREETING_IMAGE_TEST_TIME_INVALID/u,
  );
});

test("manual image test mode branches before dispatcher and reports safety counters", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./index.ts", import.meta.url), "utf8")
  );
  const branchStart = source.indexOf("if (isMorningGreetingImageTest)");
  const dispatcherStart = source.indexOf("await claimDuePost(", branchStart);
  assert.ok(branchStart >= 0);
  assert.ok(dispatcherStart > branchStart);
  const branch = source.slice(branchStart, source.indexOf("if (isMorningReportDryRun)", branchStart));
  assert.match(branch, /x_api_called: 0/u);
  assert.match(branch, /scheduled_posts_changed: 0/u);
  assert.doesNotMatch(branch, /postToX|claimDuePost|callRpc|fetch\([^)]*X_API/u);
});
