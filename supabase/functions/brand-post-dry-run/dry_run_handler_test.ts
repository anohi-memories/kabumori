import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrandContext, type BrandContext, type BrandOperationalSettings } from "../_shared/brand/brand_context.ts";
import { runBrandPostDryRun } from "../_shared/brand/brand_post_dry_run.ts";
import { fingerprintText } from "../_shared/brand/cross_brand_dedupe.ts";
import { handleBrandPostDryRunRequest, type BrandPostDryRunHandlerDeps } from "./dry_run_handler.ts";

const aiLabSettings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: ["brand_post"],
};

function aiLabContext(publishMode: "dry_run" | "live" | "disabled" = "dry_run", publishEnabled = false): BrandContext {
  return resolveBrandContext(
    { id: "ai_salaryman_lab", display_name: "AIサラリーマン研究所", is_active: publishMode !== "disabled", publish_mode: publishMode, code_profile_key: "ai_salaryman_lab_v1" },
    { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab", publish_enabled: publishEnabled, oauth_client_ref: "default" },
    aiLabSettings,
  );
}

function fixtureFetch(text: string): typeof fetch {
  return async () => Response.json({ output: [{ content: [{ type: "output_text", text }] }], usage: { input_tokens: 100, output_tokens: 60 } });
}

function baseDeps(overrides: Partial<BrandPostDryRunHandlerDeps> = {}): BrandPostDryRunHandlerDeps {
  return {
    loadBrandContext: async ({ brandId }) => {
      if (brandId !== "ai_salaryman_lab") throw new Error("unexpected brandId in test");
      return aiLabContext();
    },
    runBrandPostDryRun: (args) => runBrandPostDryRun({ ...args, fetchImpl: fixtureFetch("AI活用の小さな工夫を紹介します。") }),
    fetchRecentKabumoriFingerprints: async () => [],
    resolveVaultTokenRoutingMetadata: async ({ context }) => ({
      brandId: context.brand.id,
      socialAccountId: context.socialAccount?.id ?? "",
      handle: context.socialAccount?.handle ?? "",
      oauthClientRef: context.socialAccount?.oauth_client_ref ?? "",
      connectionStatus: "identity_verified",
      accessTokenRefPresent: true,
      refreshTokenRefPresent: true,
      tokenSource: "vault_backed_social_account",
      legacyFallbackUsed: false,
    }),
    openAiApiKey: "fixture-only",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "fixture-service-role-key",
    ...overrides,
  };
}

test("happy path: real (fixture-simulated) generation carries brand_id=ai_salaryman_lab, x_write_calls=0, legacy token reads=0", async () => {
  const result = await handleBrandPostDryRunRequest({ brand_id: "ai_salaryman_lab", post_type: "brand_post" }, baseDeps());
  assert.equal(result.status, 200);
  assert.equal(result.body.brand_id, "ai_salaryman_lab");
  assert.equal(result.body.dry_run, true);
  assert.equal(result.body.published, false);
  assert.equal(result.body.x_write_calls, 0);
  assert.equal(result.body.legacy_kabumori_token_reads, 0);
  const generated = result.body.generated as Record<string, unknown>;
  assert.equal(typeof generated.text, "string");
  assert.ok((generated.text as string).length > 0);
  const dedupe = result.body.cross_brand_dedupe as { kabumori_posts_checked: number; result: { blocked: boolean } };
  assert.equal(dedupe.kabumori_posts_checked, 0);
  assert.equal(dedupe.result.blocked, false);
  assert.deepEqual(result.body.publish_gate, { blocked: true, reason: "BRAND_PUBLISH_MODE_DRY_RUN" });
});

test("defaults brand_id to ai_salaryman_lab and post_type to brand_post when omitted", async () => {
  const result = await handleBrandPostDryRunRequest({}, baseDeps());
  assert.equal(result.status, 200);
  assert.equal(result.body.brand_id, "ai_salaryman_lab");
  assert.equal(result.body.post_type, "brand_post");
});

test("refuses any brand_id other than the phase's approved target, before ever calling loadBrandContext", async () => {
  let loadBrandContextCalls = 0;
  const deps = baseDeps({
    loadBrandContext: async () => {
      loadBrandContextCalls += 1;
      return aiLabContext();
    },
  });
  const result = await handleBrandPostDryRunRequest({ brand_id: "kabumori" }, deps);
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "BRAND_POST_DRY_RUN_TARGET_NOT_APPROVED");
  assert.equal(loadBrandContextCalls, 0);
});

test("refuses to generate when the brand is not actually in the expected dry_run/publish_enabled=false state, without calling OpenAI", async () => {
  let generationCalls = 0;
  const deps = baseDeps({
    loadBrandContext: async () => aiLabContext("live", false),
    runBrandPostDryRun: async (args) => {
      generationCalls += 1;
      return runBrandPostDryRun({ ...args, fetchImpl: fixtureFetch("x") });
    },
  });
  const result = await handleBrandPostDryRunRequest({}, deps);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "BRAND_NOT_IN_EXPECTED_DRY_RUN_STATE");
  assert.equal(generationCalls, 0);
});

test("refuses to generate when publish_enabled=true even if publish_mode is still dry_run, without calling OpenAI", async () => {
  let generationCalls = 0;
  const deps = baseDeps({
    loadBrandContext: async () => aiLabContext("dry_run", true),
    runBrandPostDryRun: async (args) => {
      generationCalls += 1;
      return runBrandPostDryRun({ ...args, fetchImpl: fixtureFetch("x") });
    },
  });
  const result = await handleBrandPostDryRunRequest({}, deps);
  assert.equal(result.status, 409);
  assert.equal(generationCalls, 0);
});

test("a loadBrandContext failure (e.g. brand row not found) fails closed with a 404 and no generation attempt", async () => {
  let generationCalls = 0;
  const deps = baseDeps({
    loadBrandContext: async () => {
      const { BrandContextError } = await import("../_shared/brand/brand_context.ts");
      throw new BrandContextError("BRAND_NOT_FOUND");
    },
    runBrandPostDryRun: async (args) => {
      generationCalls += 1;
      return runBrandPostDryRun({ ...args, fetchImpl: fixtureFetch("x") });
    },
  });
  const result = await handleBrandPostDryRunRequest({}, deps);
  assert.equal(result.status, 404);
  assert.equal(result.body.error, "BRAND_NOT_FOUND");
  assert.equal(generationCalls, 0);
});

test("a generation failure (e.g. OpenAI non-2xx) fails closed with a 502, never returning a fabricated draft", async () => {
  const deps = baseDeps({
    runBrandPostDryRun: (args) => runBrandPostDryRun({ ...args, fetchImpl: async () => new Response("rate limited", { status: 429 }) }),
  });
  const result = await handleBrandPostDryRunRequest({}, deps);
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "BRAND_POST_GENERATION_FAILED:429");
});

test("Phase 3G: a known published Kabumori post's real fingerprint is read and reflected, and an AI Lab candidate identical after normalization to it blocks as a cross-brand duplicate", async () => {
  const kabumoriRealText = "日経平均は本日、前日比で反発しました。";
  const deps = baseDeps({
    // The candidate AI Lab text below is engineered to normalize identically to a real, already-
    // published Kabumori post -- proving the block path fires against genuinely real (fixture-sourced)
    // data, not a synthetic self-reference.
    runBrandPostDryRun: (args) => runBrandPostDryRun({ ...args, fetchImpl: fixtureFetch(kabumoriRealText) }),
    fetchRecentKabumoriFingerprints: async () => [
      { brandId: "kabumori", normalizedTextSha256: await fingerprintText(kabumoriRealText), publishedAt: "2026-09-10T09:00:00.000Z" },
    ],
  });
  const result = await handleBrandPostDryRunRequest({}, deps);
  assert.equal(result.status, 200);
  const dedupe = result.body.cross_brand_dedupe as { kabumori_posts_checked: number; result: Record<string, unknown> };
  assert.equal(dedupe.kabumori_posts_checked, 1);
  assert.equal(dedupe.result.blocked, true);
  assert.equal(dedupe.result.reason, "CROSS_BRAND_EXACT_DUPLICATE");
  assert.equal(dedupe.result.matchedBrandId, "kabumori");
});

test("Phase 3G: a sufficiently distinct AI Lab candidate is allowed even against a real recent Kabumori fingerprint window", async () => {
  const deps = baseDeps({
    fetchRecentKabumoriFingerprints: async () => [
      { brandId: "kabumori", normalizedTextSha256: await fingerprintText("日経平均は本日、前日比で反発しました。"), publishedAt: "2026-09-10T09:00:00.000Z" },
    ],
  });
  const result = await handleBrandPostDryRunRequest({}, deps);
  assert.equal(result.status, 200);
  const dedupe = result.body.cross_brand_dedupe as { kabumori_posts_checked: number; result: { blocked: boolean } };
  assert.equal(dedupe.kabumori_posts_checked, 1);
  assert.equal(dedupe.result.blocked, false);
});

test("Phase 3G: a real-data repository failure fails safe (empty window) and never blocks or aborts AI Lab's own generation", async () => {
  const deps = baseDeps({
    fetchRecentKabumoriFingerprints: async () => [],
  });
  const result = await handleBrandPostDryRunRequest({}, deps);
  assert.equal(result.status, 200);
  const dedupe = result.body.cross_brand_dedupe as { kabumori_posts_checked: number; result: { blocked: boolean } };
  assert.equal(dedupe.kabumori_posts_checked, 0);
  assert.equal(dedupe.result.blocked, false);
});

test("Phase 3G: reflects Vault token routing metadata (brand/account matched, refs present, legacy fallback used=false) without exposing secret values", async () => {
  const result = await handleBrandPostDryRunRequest({}, baseDeps());
  assert.equal(result.status, 200);
  const routing = result.body.vault_token_routing as Record<string, unknown>;
  assert.equal(routing.brandId, "ai_salaryman_lab");
  assert.equal(routing.socialAccountId, "ai_salaryman_lab_x");
  assert.equal(routing.handle, "kaishain_ai_lab");
  assert.equal(routing.accessTokenRefPresent, true);
  assert.equal(routing.refreshTokenRefPresent, true);
  assert.equal(routing.tokenSource, "vault_backed_social_account");
  assert.equal(routing.legacyFallbackUsed, false);
  assert.equal(Object.hasOwn(routing, "accessToken"), false);
  assert.equal(Object.hasOwn(routing, "refreshToken"), false);
});

test("Phase 3G: a Vault token routing lookup failure is reported as its own field and never hides an otherwise-successful generation result", async () => {
  const deps = baseDeps({
    resolveVaultTokenRoutingMetadata: async () => {
      throw new (await import("../_shared/brand/brand_context.ts")).BrandContextError("BRAND_SOCIAL_ACCOUNT_NOT_FOUND");
    },
  });
  const result = await handleBrandPostDryRunRequest({}, deps);
  assert.equal(result.status, 200);
  assert.equal(typeof (result.body.generated as Record<string, unknown>).text, "string");
  assert.deepEqual(result.body.vault_token_routing, { error: "BRAND_SOCIAL_ACCOUNT_NOT_FOUND" });
});

test("this module never imports the legacy token loader, OAuth module, or the x-test-post monolith", async () => {
  const { readFile } = await import("node:fs/promises");
  const importOrUsagePattern = /from\s+["'][^"']*(token_loader|x_oauth2_post|x-test-post\/index)\.ts["']|\bloadBrandXTokens\s*\(|\bloadXTokens\s*\(/u;
  for (const file of ["dry_run_handler.ts", "index.ts"]) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, importOrUsagePattern);
  }
});
