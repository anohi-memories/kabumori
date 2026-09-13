// Phase 3G Section F: consolidated brand/account isolation proof. Most of this is already covered
// per-module elsewhere (dispatch_gate_test.ts, token_loader_test.ts, oauth_connection_test.ts,
// kabumori_recent_fingerprints_test.ts, vault_token_routing_test.ts); this file pulls the specific
// assertions Phase 3G's own task text calls out into one place.
import assert from "node:assert/strict";
import test from "node:test";
import { LEGACY_KABUMORI_BRAND_ID, resolveBrandContext, type BrandOperationalSettings } from "./brand_context.ts";
import { resolveOAuthStartConfig, resolveOAuthCallbackConfig } from "../../x-oauth-connect/account_config.ts";
import { loadBrandXTokens } from "./token_loader.ts";

const aiLabSettings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: [],
};
const kabumoriSettings: BrandOperationalSettings = {
  brand_id: "kabumori", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: [],
};

test("ai_salaryman_lab never resolves to kabumori: distinct id, distinct code profile, distinct social account", () => {
  const aiLab = resolveBrandContext(
    { id: "ai_salaryman_lab", display_name: "AIサラリーマン研究所", is_active: true, publish_mode: "dry_run", code_profile_key: "ai_salaryman_lab_v1" },
    { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab", publish_enabled: false, oauth_client_ref: "default" },
    aiLabSettings,
  );
  assert.notEqual(aiLab.brand.id, LEGACY_KABUMORI_BRAND_ID);
  assert.notEqual(aiLab.codeProfile.key, "kabumori_v1");
  assert.equal(aiLab.socialAccount?.handle, "kaishain_ai_lab");
});

test("Kabumori's internal id remains 'kabumori' and its X handle remains 'yume_daka' in the canonical OAuth account config", () => {
  assert.equal(LEGACY_KABUMORI_BRAND_ID, "kabumori");
  const kabumoriConfig = resolveOAuthStartConfig("yume_daka");
  assert.equal(kabumoriConfig.brandId, "kabumori");
  assert.equal(kabumoriConfig.expectedHandle, "yume_daka");
  assert.equal(kabumoriConfig.socialAccountId, "kabumori_x");

  const aiLabConfig = resolveOAuthStartConfig("kaishain_ai_lab");
  assert.equal(aiLabConfig.brandId, "ai_salaryman_lab");
  assert.equal(aiLabConfig.expectedHandle, "kaishain_ai_lab");

  // Cross-callback lookups must never resolve to the other brand's config.
  assert.equal(resolveOAuthCallbackConfig("kabumori_x", "kabumori").brandId, "kabumori");
  assert.equal(resolveOAuthCallbackConfig("ai_salaryman_lab_x", "ai_salaryman_lab").brandId, "ai_salaryman_lab");
  assert.throws(() => resolveOAuthCallbackConfig("ai_salaryman_lab_x", "kabumori"));
  assert.throws(() => resolveOAuthCallbackConfig("kabumori_x", "ai_salaryman_lab"));
});

test("Mio has no OAuth account config at all -- any handle/account lookup for it is rejected, not silently mapped to another brand", () => {
  assert.throws(() => resolveOAuthStartConfig("mio"));
  assert.throws(() => resolveOAuthCallbackConfig("mio_x", "mio"));
});

test("the AI Lab token route has zero legacy Kabumori token reads: loadBrandXTokens rejects any non-kabumori brand before any fetch", async () => {
  let fetchCalls = 0;
  const aiLab = resolveBrandContext(
    { id: "ai_salaryman_lab", display_name: "AIサラリーマン研究所", is_active: true, publish_mode: "dry_run", code_profile_key: "ai_salaryman_lab_v1" },
    { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab", publish_enabled: false, oauth_client_ref: "default" },
    aiLabSettings,
  );
  await assert.rejects(() =>
    loadBrandXTokens({
      context: aiLab,
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "k",
      clientSecret: "s",
      fallbackAccessToken: "a",
      fallbackRefreshToken: "r",
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("should never be called", { status: 200 });
      },
    })
  );
  assert.equal(fetchCalls, 0);
});

test("the real Kabumori context (default oauth_client_ref) is the only shape that reaches the legacy token store", async () => {
  const kabumori = resolveBrandContext(
    { id: "kabumori", display_name: "かぶモリ", is_active: true, publish_mode: "live", code_profile_key: "kabumori_v1" },
    { id: "kabumori_x", brand_id: "kabumori", platform: "x", handle: "yume_daka", publish_enabled: true, oauth_client_ref: "default" },
    kabumoriSettings,
  );
  let fetchCalls = 0;
  await loadBrandXTokens({
    context: kabumori,
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "k",
    clientSecret: "s",
    fallbackAccessToken: "a",
    fallbackRefreshToken: "r",
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ access_token: "a", refresh_token: "r" });
    },
  });
  assert.equal(fetchCalls, 1);
});
