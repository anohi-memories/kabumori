import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrandContext, BrandContextError, type BrandOperationalSettings } from "./brand_context.ts";
import { resolveVaultTokenRoutingMetadata } from "./vault_token_routing.ts";

const aiLabSettings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: ["brand_post"],
};

function aiLabContext() {
  return resolveBrandContext(
    { id: "ai_salaryman_lab", display_name: "AIサラリーマン研究所", is_active: true, publish_mode: "dry_run", code_profile_key: "ai_salaryman_lab_v1" },
    { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab", publish_enabled: false, oauth_client_ref: "default" },
    aiLabSettings,
  );
}

test("resolves brand_id -> social_account -> Vault token ref metadata, without ever reading a secret value", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json([{
      id: "ai_salaryman_lab_x",
      handle: "kaishain_ai_lab",
      oauth_client_ref: "default",
      connection_status: "identity_verified",
      vault_access_token_secret_id: "11111111-1111-1111-1111-111111111111",
      vault_refresh_token_secret_id: "22222222-2222-2222-2222-222222222222",
    }]);
  const metadata = await resolveVaultTokenRoutingMetadata({
    context: aiLabContext(),
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "fixture-service-role-key",
    fetchImpl,
  });
  assert.deepEqual(metadata, {
    brandId: "ai_salaryman_lab",
    socialAccountId: "ai_salaryman_lab_x",
    handle: "kaishain_ai_lab",
    oauthClientRef: "default",
    connectionStatus: "identity_verified",
    accessTokenRefPresent: true,
    refreshTokenRefPresent: true,
    tokenSource: "vault_backed_social_account",
    legacyFallbackUsed: false,
  });
});

test("reports refs as not present when the Vault secret id columns are null, without throwing", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json([{
      id: "ai_salaryman_lab_x", handle: "kaishain_ai_lab", oauth_client_ref: "default",
      connection_status: "authorization_pending",
      vault_access_token_secret_id: null, vault_refresh_token_secret_id: null,
    }]);
  const metadata = await resolveVaultTokenRoutingMetadata({
    context: aiLabContext(), supabaseUrl: "https://example.supabase.co", serviceRoleKey: "k", fetchImpl,
  });
  assert.equal(metadata.accessTokenRefPresent, false);
  assert.equal(metadata.refreshTokenRefPresent, false);
  assert.equal(metadata.legacyFallbackUsed, false);
});

test("fails closed when the social account row cannot be found", async () => {
  const fetchImpl: typeof fetch = async () => Response.json([]);
  await assert.rejects(
    () => resolveVaultTokenRoutingMetadata({
      context: aiLabContext(), supabaseUrl: "https://example.supabase.co", serviceRoleKey: "k", fetchImpl,
    }),
    (error: unknown) => error instanceof BrandContextError && error.message === "BRAND_SOCIAL_ACCOUNT_NOT_FOUND",
  );
});

test("fails closed on a non-ok REST response rather than returning partial metadata", async () => {
  const fetchImpl: typeof fetch = async () => new Response("error", { status: 500 });
  await assert.rejects(
    () => resolveVaultTokenRoutingMetadata({
      context: aiLabContext(), supabaseUrl: "https://example.supabase.co", serviceRoleKey: "k", fetchImpl,
    }),
    (error: unknown) => error instanceof BrandContextError && error.message === "BRAND_VAULT_ROUTING_READ_FAILED",
  );
});

test("this module never reads vault.decrypted_secrets or any legacy oauth_token_store, and the returned metadata never carries an actual token value field", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./vault_token_routing.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /vault\.decrypted_secrets|\breadSecret\s*\(|from\s+["'][^"']*oauth_token_store[^"']*["']|\/rest\/v1\/oauth_token_store/u);

  const metadata = await resolveVaultTokenRoutingMetadata({
    context: aiLabContext(),
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "fixture-service-role-key",
    fetchImpl: async () =>
      Response.json([{
        id: "ai_salaryman_lab_x", handle: "kaishain_ai_lab", oauth_client_ref: "default",
        connection_status: "identity_verified",
        vault_access_token_secret_id: "11111111-1111-1111-1111-111111111111",
        vault_refresh_token_secret_id: "22222222-2222-2222-2222-222222222222",
      }]),
  });
  const disallowedKeys = ["accessToken", "refreshToken", "access_token", "refresh_token", "vault_access_token_secret_id", "vault_refresh_token_secret_id"];
  for (const key of disallowedKeys) {
    assert.equal(Object.hasOwn(metadata, key), false, `metadata must not expose raw field "${key}"`);
  }
});
