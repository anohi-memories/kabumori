import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildMorningGreetingImageGenerationContext,
  fetchYumeCanonicalReference,
  resolveYumeCanonicalReference,
  YUME_CANONICAL_REFERENCE_BUCKET,
  YUME_CANONICAL_REFERENCE_PATH,
} from "./yume_reference_logic.ts";

test("canonical reference path is fixed and available", () => {
  const reference = resolveYumeCanonicalReference();
  assert.equal(reference.bucket, YUME_CANONICAL_REFERENCE_BUCKET);
  assert.equal(reference.object_path, YUME_CANONICAL_REFERENCE_PATH);
  assert.equal(
    reference.canonical_reference_path,
    "storage://morning-greeting-assets/canonical/yume-reference.png",
  );
});

test("missing canonical path stops safely", () => {
  assert.throws(
    () => resolveYumeCanonicalReference({ objectPath: "" }),
    /YUME_CANONICAL_REFERENCE_PATH_MISSING/,
  );
});

test("visual theme is passed into the later image-generation context", () => {
  const visualTheme = "防災リュック、ヘルメット、懐中電灯、防災用品";
  const context = buildMorningGreetingImageGenerationContext(visualTheme);
  assert.equal(context.visual_theme, visualTheme);
  assert.match(context.image_generation_context, /防災リュック/u);
  assert.match(context.image_generation_context, /canonical reference image/u);
});

test("changing the daily theme never changes the canonical reference", () => {
  const normal = buildMorningGreetingImageGenerationContext("朝の窓辺、コーヒー、観葉植物");
  const christmas = buildMorningGreetingImageGenerationContext("冬服、ツリー、小さな飾り");
  assert.equal(normal.canonical_reference_path, christmas.canonical_reference_path);
  assert.notEqual(normal.visual_theme, christmas.visual_theme);
});

test("a later Edge Function can download the private object with server authorization", async () => {
  let requestedUrl = "";
  let authorization = "";
  const mockFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  };
  const result = await fetchYumeCanonicalReference(
    "https://example.supabase.co",
    "server-secret",
    resolveYumeCanonicalReference(),
    mockFetch,
  );
  assert.equal(
    requestedUrl,
    "https://example.supabase.co/storage/v1/object/morning-greeting-assets/canonical/yume-reference.png",
  );
  assert.equal(authorization, "Bearer server-secret");
  assert.equal(result.contentType, "image/png");
  assert.equal(result.bytes.length, 4);
});

test("an unregistered canonical image stops safely", async () => {
  const notFound: typeof fetch = async () => new Response("", { status: 404 });
  await assert.rejects(
    fetchYumeCanonicalReference(
      "https://example.supabase.co",
      "server-secret",
      resolveYumeCanonicalReference(),
      notFound,
    ),
    /YUME_CANONICAL_REFERENCE_NOT_FOUND/,
  );
});

test("morning_greeting remains excluded from X dispatcher claim", () => {
  const migration = readFileSync(fileURLToPath(new URL(
    "../../migrations/20260901044548_add_morning_greeting_schedule.sql",
    import.meta.url,
  )), "utf8");
  assert.match(migration, /and post_type <> 'morning_greeting'/);
});
