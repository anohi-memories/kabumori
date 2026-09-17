import assert from "node:assert/strict";
import test from "node:test";
import {
  loadAiLabRecentDedupeFingerprints,
  recordAndCompleteAiLabBrandPost,
} from "./ai_lab_brand_post_store.ts";

test("the live fingerprint preflight fails closed when the persistent fingerprint read fails", async () => {
  await assert.rejects(() =>
    loadAiLabRecentDedupeFingerprints({
      supabaseUrl: "https://example.test",
      serviceRoleKey: "fixture",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (
          url.pathname.endsWith("/published_content_fingerprints")
        ) return new Response("unavailable", { status: 503 });
        return Response.json([]);
      },
    }), { message: "PUBLISHED_FINGERPRINT_READ_FAILED" });
});

test("the post-success completion adapter reports fingerprint failure without including content", async () => {
  let body = "";
  const result = await recordAndCompleteAiLabBrandPost({
    supabaseUrl: "https://example.test",
    serviceRoleKey: "fixture",
    scheduledPostId: "schedule-fixture",
    xPostId: "post-fixture",
    normalizedTextSha256: "a".repeat(64),
    fetchImpl: async (_input, init) => {
      body = String(init?.body);
      return Response.json([{ fingerprint_persisted: false }]);
    },
  });
  assert.deepEqual(result, { fingerprintPersisted: false });
  assert.equal(body.includes("post body"), false);
});
