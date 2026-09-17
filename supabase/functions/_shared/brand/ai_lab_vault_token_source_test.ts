import assert from "node:assert/strict";
import test from "node:test";
import {
  type BrandOperationalSettings,
  resolveBrandContext,
} from "./brand_context.ts";
import { loadAiLabVaultBackedXTokens } from "./ai_lab_vault_token_source.ts";

const settings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab",
  fixed_hashtags: [],
  note_url: null,
  image_policy: {},
  enabled_post_types: ["brand_post"],
};

function context() {
  return resolveBrandContext(
    {
      id: "ai_salaryman_lab",
      display_name: "fixture",
      is_active: true,
      publish_mode: "live",
      code_profile_key: "ai_salaryman_lab_v1",
    },
    {
      id: "ai_salaryman_lab_x",
      brand_id: "ai_salaryman_lab",
      platform: "x",
      handle: "kaishain_ai_lab",
      publish_enabled: true,
      oauth_client_ref: "default",
    },
    settings,
  );
}

const accountRow = {
  id: "ai_salaryman_lab_x",
  brand_id: "ai_salaryman_lab",
  platform: "x",
  handle: "kaishain_ai_lab",
  publish_enabled: true,
  oauth_client_ref: "default",
  connection_status: "identity_verified",
  vault_access_token_secret_id: "11111111-1111-4111-8111-111111111111",
  vault_refresh_token_secret_id: "22222222-2222-4222-8222-222222222222",
};

test("AI Lab loads only its verified account Vault refs and never requests the legacy token store", async () => {
  const paths: string[] = [];
  const tokens = await loadAiLabVaultBackedXTokens({
    context: context(),
    supabaseUrl: "https://example.test",
    serviceRoleKey: "fixture-only",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith("/social_accounts")) {
        assert.equal(init?.method, undefined);
        return Response.json([accountRow]);
      }
      if (url.pathname.endsWith("/rpc/read_ai_salaryman_lab_x_vault_token")) {
        const body = JSON.parse(String(init?.body)) as {
          p_vault_secret_id: string;
        };
        const token =
          body.p_vault_secret_id === accountRow.vault_access_token_secret_id
            ? "fixture-access-token"
            : "fixture-refresh-token";
        return Response.json([{ token_value: token }]);
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    },
  });

  assert.deepEqual(tokens, {
    accessToken: "fixture-access-token",
    refreshToken: "fixture-refresh-token",
  });
  assert.equal(
    paths.filter((path) => path.endsWith("/social_accounts")).length,
    1,
  );
  assert.equal(
    paths.filter((path) =>
      path.endsWith("/rpc/read_ai_salaryman_lab_x_vault_token")
    ).length,
    2,
  );
  assert.equal(
    paths.some((path) => path.endsWith("/oauth_token_store")),
    false,
  );
});

test("a mismatched X handle fails before any Vault secret RPC", async () => {
  let secretReads = 0;
  await assert.rejects(
    () =>
      loadAiLabVaultBackedXTokens({
        context: context(),
        supabaseUrl: "https://example.test",
        serviceRoleKey: "fixture-only",
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/social_accounts")) {
            return Response.json([{ ...accountRow, handle: "wrong_handle" }]);
          }
          secretReads += 1;
          return Response.json([{ token_value: "should-not-be-read" }]);
        },
      }),
    { message: "AI_LAB_VAULT_ACCOUNT_MISMATCH" },
  );
  assert.equal(secretReads, 0);
});

test("an unverified identity fails closed without reading Vault", async () => {
  let secretReads = 0;
  await assert.rejects(
    () =>
      loadAiLabVaultBackedXTokens({
        context: context(),
        supabaseUrl: "https://example.test",
        serviceRoleKey: "fixture-only",
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/social_accounts")) {
            return Response.json([{
              ...accountRow,
              connection_status: "authorization_pending",
            }]);
          }
          secretReads += 1;
          return Response.json([{ token_value: "should-not-be-read" }]);
        },
      }),
    { message: "AI_LAB_X_IDENTITY_NOT_VERIFIED" },
  );
  assert.equal(secretReads, 0);
});

test("non-AI-Lab context is rejected before any network access", async () => {
  let calls = 0;
  const kabumori = resolveBrandContext(
    {
      id: "kabumori",
      display_name: "fixture",
      is_active: true,
      publish_mode: "live",
      code_profile_key: "kabumori_v1",
    },
    {
      id: "kabumori_x",
      brand_id: "kabumori",
      platform: "x",
      handle: "yume_daka",
      publish_enabled: true,
      oauth_client_ref: "default",
    },
    { ...settings, brand_id: "kabumori", enabled_post_types: ["tip"] },
  );
  await assert.rejects(
    () =>
      loadAiLabVaultBackedXTokens({
        context: kabumori,
        supabaseUrl: "https://example.test",
        serviceRoleKey: "fixture-only",
        fetchImpl: async () => {
          calls += 1;
          return Response.json([]);
        },
      }),
    { message: "AI_LAB_VAULT_ACCOUNT_MISMATCH" },
  );
  assert.equal(calls, 0);
});
