import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrandContext, type BrandOperationalSettings } from "./brand_context.ts";
import { runBrandPostDryRun, toScheduledPostPayload } from "./brand_post_dry_run.ts";
import { fingerprintText, type PublishedFingerprint } from "./cross_brand_dedupe.ts";

const aiLabSettings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: ["brand_post"],
};

function aiLabContext(publishMode: "dry_run" | "live" = "dry_run", publishEnabled = false) {
  return resolveBrandContext(
    { id: "ai_salaryman_lab", display_name: "AIサラリーマン研究所", is_active: true, publish_mode: publishMode, code_profile_key: "ai_salaryman_lab_v1" },
    { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab", publish_enabled: publishEnabled, oauth_client_ref: "default" },
    aiLabSettings,
  );
}

function fixtureFetch(text: string): typeof fetch {
  return async () => Response.json({ output: [{ content: [{ type: "output_text", text }] }], usage: { input_tokens: 100, output_tokens: 60 } });
}

test("full dry-run pipeline: generation -> brand_id attribution -> dedupe -> publish gate, with X write calls always 0", async () => {
  const result = await runBrandPostDryRun({
    openAiApiKey: "fixture-only",
    context: aiLabContext(),
    postType: "brand_post",
    fetchImpl: fixtureFetch("AI活用の小さな工夫を紹介します。"),
  });
  assert.equal(result.brandId, "ai_salaryman_lab");
  assert.equal(result.postType, "brand_post");
  assert.equal(result.generated.brandId, "ai_salaryman_lab");
  assert.equal(result.crossBrandDedupe.blocked, false);
  assert.deepEqual(result.publishGate, { blocked: true, reason: "BRAND_PUBLISH_MODE_DRY_RUN" });
  assert.equal(result.xWriteCalls, 0);

  const payload = toScheduledPostPayload(result);
  assert.equal(payload.brand_id, "ai_salaryman_lab");
  assert.equal(payload.post_type, "brand_post");
  assert.equal(payload.generated_text, result.generated.text);
});

test("publish_enabled=false stops the gate even if publish_mode were somehow live, still after a real generation and 0 X writes", async () => {
  const result = await runBrandPostDryRun({
    openAiApiKey: "fixture-only",
    context: aiLabContext("live", false),
    postType: "brand_post",
    fetchImpl: fixtureFetch("AI活用の小さな工夫を紹介します。"),
  });
  assert.deepEqual(result.publishGate, { blocked: true, reason: "BRAND_X_ACCOUNT_DISABLED" });
  assert.equal(result.xWriteCalls, 0);
});

test("an exact cross-brand duplicate is reported as blocked in the dry-run result, without stopping generation itself", async () => {
  const text = "AI活用の小さな工夫を紹介します。";
  const recentFingerprints: PublishedFingerprint[] = [
    { brandId: "kabumori", normalizedTextSha256: await fingerprintText(text), publishedAt: new Date().toISOString() },
  ];
  const result = await runBrandPostDryRun({
    openAiApiKey: "fixture-only", context: aiLabContext(), postType: "brand_post",
    fetchImpl: fixtureFetch(text), recentFingerprints,
  });
  assert.equal(result.crossBrandDedupe.blocked, true);
  if (result.crossBrandDedupe.blocked) {
    assert.equal(result.crossBrandDedupe.reason, "CROSS_BRAND_EXACT_DUPLICATE");
    assert.equal(result.crossBrandDedupe.matchedBrandId, "kabumori");
  }
});

test("a sufficiently different cross-brand text is allowed", async () => {
  const recentFingerprints: PublishedFingerprint[] = [
    { brandId: "kabumori", normalizedTextSha256: await fingerprintText("日経平均は反発しました"), publishedAt: new Date().toISOString() },
  ];
  const result = await runBrandPostDryRun({
    openAiApiKey: "fixture-only", context: aiLabContext(), postType: "brand_post",
    fetchImpl: fixtureFetch("会議の議事録をAIで自動要約する運用を試しています。"), recentFingerprints,
  });
  assert.equal(result.crossBrandDedupe.blocked, false);
});

test("an empty recent-fingerprint window (no follow-up dedupe table wired up yet) never blocks by default", async () => {
  const result = await runBrandPostDryRun({
    openAiApiKey: "fixture-only", context: aiLabContext(), postType: "brand_post",
    fetchImpl: fixtureFetch("何らかの新しい投稿内容。"),
  });
  assert.equal(result.crossBrandDedupe.blocked, false);
});

test("this module never imports the legacy token loader or OAuth module -- the AI Lab dry-run path structurally cannot reach the shared Kabumori token store", async () => {
  const { readFile } = await import("node:fs/promises");
  // Matches actual import statements only (a `from "...token_loader.ts"` / `from "...x_oauth2_post.ts"`
  // specifier, or a bare `loadBrandXTokens`/`loadXTokens` identifier reference) -- not this file's own
  // explanatory comments, which legitimately name those modules to say they are absent.
  const importOrUsagePattern = /from\s+["'][^"']*(token_loader|x_oauth2_post)\.ts["']|\bloadBrandXTokens\s*\(|\bloadXTokens\s*\(/u;
  for (const file of ["brand_post_dry_run.ts", "brand_post_generator.ts"]) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, importOrUsagePattern);
  }
});
