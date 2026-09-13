import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrandContext, type BrandContext, type BrandOperationalSettings } from "../_shared/brand/brand_context.ts";
import { runBrandPostDryRun } from "../_shared/brand/brand_post_dry_run.ts";
import { runCrossBrandDedupeProbe } from "../_shared/brand/cross_brand_dedupe_probe.ts";
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
    runCrossBrandDedupeProbe,
    openAiApiKey: "fixture-only",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "fixture-service-role-key",
    ...overrides,
  };
}

test("happy path: real (fixture-simulated) generation carries brand_id=ai_salaryman_lab, x_write_calls=0, legacy token reads=0, dedupe wired", async () => {
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
  const dedupe = result.body.cross_brand_dedupe as Record<string, { blocked: boolean }>;
  assert.equal(dedupe.would_block_on_exact_match.blocked, true);
  assert.equal(dedupe.would_allow_on_distinct_text.blocked, false);
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
    loadBrandContext: async (args) => {
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

test("this module never imports the legacy token loader, OAuth module, or the x-test-post monolith", async () => {
  const { readFile } = await import("node:fs/promises");
  const importOrUsagePattern = /from\s+["'][^"']*(token_loader|x_oauth2_post|x-test-post\/index)\.ts["']|\bloadBrandXTokens\s*\(|\bloadXTokens\s*\(/u;
  for (const file of ["dry_run_handler.ts", "index.ts"]) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, importOrUsagePattern);
  }
});
