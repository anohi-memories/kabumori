import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrandContext, type BrandOperationalSettings } from "./brand_context.ts";
import { loadBrandXTokens } from "./token_loader.ts";

// This is the one function the live x-test-post dispatch loop actually calls for every scheduled post
// (index.ts, right after claim_due_post and before any post_type branch). It is the only thing standing
// between a claimed row for some brand and the shared legacy oauth_token_store -- so for
// multibrand-phase3d-dry-run-routing-safety, proving it never reaches that store for a non-Kabumori
// brand is the single most safety-critical assertion in this task.

const kabumoriSettings: BrandOperationalSettings = {
  brand_id: "kabumori", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: [],
};
const aiLabSettings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: [],
};

function kabumoriContext(oauthClientRef = "default") {
  return resolveBrandContext(
    { id: "kabumori", display_name: "かぶモリ", is_active: true, publish_mode: "live", code_profile_key: "kabumori_v1" },
    { id: "kabumori_x", brand_id: "kabumori", platform: "x", handle: "yume_daka", publish_enabled: true, oauth_client_ref: oauthClientRef },
    kabumoriSettings,
  );
}

function aiLabContext() {
  return resolveBrandContext(
    { id: "ai_salaryman_lab", display_name: "AIサラリーマン研究所", is_active: true, publish_mode: "dry_run", code_profile_key: "ai_salaryman_lab_v1" },
    { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab", publish_enabled: false, oauth_client_ref: "default" },
    aiLabSettings,
  );
}

function countingFetch(): { fetchImpl: typeof fetch; calls: number[] } {
  const calls = { count: 0 };
  const fetchImpl: typeof fetch = async () => {
    calls.count += 1;
    return Response.json([]);
  };
  return { fetchImpl, calls: calls as unknown as number[] };
}

test("a non-Kabumori brand is rejected before the legacy oauth_token_store is ever fetched", async () => {
  const { fetchImpl, calls } = countingFetch();
  await assert.rejects(
    () => loadBrandXTokens({
      context: aiLabContext(),
      supabaseUrl: "https://example.test",
      serviceRoleKey: "fixture-only",
      clientSecret: "fixture-only",
      fallbackAccessToken: "fixture-only",
      fallbackRefreshToken: "fixture-only",
      fetchImpl,
    }),
    { message: "BRAND_TOKEN_RESOLVER_NOT_CONFIGURED" },
  );
  assert.equal((calls as unknown as { count: number }).count, 0);
});

test("a Kabumori account pointed at a non-default OAuth client is rejected before any fetch", async () => {
  const { fetchImpl, calls } = countingFetch();
  await assert.rejects(
    () => loadBrandXTokens({
      context: kabumoriContext("some_other_app"),
      supabaseUrl: "https://example.test",
      serviceRoleKey: "fixture-only",
      clientSecret: "fixture-only",
      fallbackAccessToken: "fixture-only",
      fallbackRefreshToken: "fixture-only",
      fetchImpl,
    }),
    { message: "BRAND_OAUTH_CLIENT_NOT_CONFIGURED" },
  );
  assert.equal((calls as unknown as { count: number }).count, 0);
});

test("the real Kabumori/default context is the only shape that reaches the legacy token store", async () => {
  const { fetchImpl, calls } = countingFetch();
  const tokens = await loadBrandXTokens({
    context: kabumoriContext(),
    supabaseUrl: "https://example.test",
    serviceRoleKey: "fixture-only",
    clientSecret: "fixture-only",
    fallbackAccessToken: "fallback-access",
    fallbackRefreshToken: "fallback-refresh",
    fetchImpl,
  });
  assert.equal((calls as unknown as { count: number }).count, 1);
  // countingFetch returns an empty row set, so loadXTokens falls back to the supplied secrets --
  // this only proves the call reached loadXTokens, not anything about real token contents.
  assert.deepEqual(tokens, { accessToken: "fallback-access", refreshToken: "fallback-refresh" });
});
