// F3 (2026-10-13): the common-account entitlement refusal of check_x_account_publish_authority stops the REAL
// Stage 3B worker at both checks -- before generation and immediately before the X create. The SQL decision is
// proven in supabase/candidates/postona_x_publish_entitlement/run.sh; this file proves the worker obeys it.
// Fake callbacks are async by contract even when they do not await.
// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import test from "node:test";
import type { BrandContext } from "./brand_context.ts";
import { SOCIAL_MOBILE_USER_CODE_PROFILE } from "./brand_profiles.ts";
import { SOCIAL_MOBILE_USER_DEFAULTS } from "./social_mobile_content_settings.ts";
import { checkVaultAccountPublishAuthority, dispatchVaultAccountScheduledBrandPost } from "./vault_account_brand_post.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("REAL_FETCH_FORBIDDEN_IN_TESTS"); }) as typeof fetch;
addEventListener("unload", () => { globalThis.fetch = realFetch; });

const context: BrandContext = {
  brand: { id: "u_pilot", display_name: "pilot", is_active: true, publish_mode: "live", code_profile_key: "social_mobile_user_v1" },
  socialAccount: { id: "sa_pilot", brand_id: "u_pilot", platform: "x", handle: "pilot", publish_enabled: true, oauth_client_ref: "default" },
  codeProfile: SOCIAL_MOBILE_USER_CODE_PROFILE,
  operationalSettings: { brand_id: "u_pilot", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: ["brand_post"] },
};

function worker(authority: string[]) {
  const answers = [...authority];
  const calls: string[] = [];
  return {
    calls,
    run: () => dispatchVaultAccountScheduledBrandPost({
      context,
      postType: "brand_post",
      scheduledPostId: "post_1",
      socialAccountId: "sa_pilot",
      openAiApiKey: "sk-test-not-real",
      checkPublishAuthority: async () => {
        calls.push("authority");
        const answer = answers.shift() ?? "UNEXPECTED_EXTRA_CHECK";
        if (answer !== "allowed") throw new Error(answer);
      },
      loadContentSettings: async () => { calls.push("settings"); return { ...SOCIAL_MOBILE_USER_DEFAULTS, approvalMode: "auto_post_preference" }; },
      loadRecentFingerprints: async () => { calls.push("fingerprints"); return []; },
      generate: async (args) => {
        calls.push("generate");
        const text = "毎朝5分だけ机を片付けると、仕事の始まりが少し軽くなります。";
        return { brandId: args.context.brand.id, postType: args.postType, text, model: "m", inputTokens: 1, outputTokens: 1, apiCostUsd: 0, characterCount: Array.from(text).length };
      },
      publishText: async () => { calls.push("publish"); return { data: { id: "1234567890" } }; },
      completePublishedPost: async () => { calls.push("complete"); return { fingerprintPersisted: true }; },
    }),
  };
}

test("service already ended / frozen at the first check: no settings read, no generation, no X call", async () => {
  for (const code of ["VAULT_PUBLISH_SERVICE_NOT_ACTIVE", "VAULT_PUBLISH_SERVICE_BUSY"]) {
    const w = worker([code]);
    await assert.rejects(w.run(), (e: unknown) => e instanceof Error && e.message === code);
    assert.deepEqual(w.calls, ["authority"], code);
  }
});

test("service ended DURING generation: the pre-create re-check stops the X create (generated once, never sent)", async () => {
  const w = worker(["allowed", "VAULT_PUBLISH_SERVICE_NOT_ACTIVE"]);
  await assert.rejects(w.run(), (e: unknown) => e instanceof Error && e.message === "VAULT_PUBLISH_SERVICE_NOT_ACTIVE");
  assert.deepEqual(w.calls, ["authority", "settings", "fingerprints", "generate", "authority"]);
});

test("active service: both checks pass and exactly one X create happens (unchanged behaviour)", async () => {
  const w = worker(["allowed", "allowed"]);
  const result = await w.run();
  assert.equal(result.xPostId, "1234567890");
  assert.deepEqual(w.calls, ["authority", "settings", "fingerprints", "generate", "authority", "publish", "complete"]);
});

test("adapter: the database's entitlement refusals reach the worker as their fixed codes; nothing else passes", async () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const call = (fetchImpl: typeof fetch) => checkVaultAccountPublishAuthority({
    supabaseUrl: "https://e.supabase.co", serviceRoleKey: "service-key-not-real", scheduledPostId: "p", socialAccountId: "sa_pilot", brandId: "u_pilot", fetchImpl,
  });
  for (const code of ["VAULT_PUBLISH_SERVICE_NOT_ACTIVE", "VAULT_PUBLISH_SERVICE_BUSY"]) {
    await assert.rejects(call(answer(400, { code: "P0001", message: code, details: "SERVICE_NOT_ACTIVE" })), (e: unknown) => e instanceof Error && e.message === code);
  }
  await assert.rejects(call(answer(200, "denied")), (e: unknown) => e instanceof Error && e.message === "VAULT_PUBLISH_AUTHORITY_UNAVAILABLE");
  await call(answer(200, "allowed"));
});
