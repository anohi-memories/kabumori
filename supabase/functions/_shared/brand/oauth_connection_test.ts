import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrandContext } from "./brand_context.ts";
import { assertOAuthCallbackState, hashOAuthState, verifyReadOnlyXIdentity } from "./oauth_connection.ts";

const context = resolveBrandContext(
  { id: "ai_salaryman_lab", display_name: "AIサラリーマン研究所", is_active: true, publish_mode: "dry_run", code_profile_key: "ai_salaryman_lab_v1" },
  { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "ai_salaryman_lab", publish_enabled: false, oauth_client_ref: "default" },
  { brand_id: "ai_salaryman_lab", fixed_hashtags: [], note_url: null, image_policy: {}, enabled_post_types: ["profile_preview"] },
);

test("OAuth callback rejects tampered, expired, and cross-account state before token exchange", async () => {
  const state = "fixture-state";
  const record = { socialAccountId: "ai_salaryman_lab_x", brandId: "ai_salaryman_lab", stateHash: await hashOAuthState(state), codeVerifierVaultSecretId: "00000000-0000-0000-0000-000000000001", redirectUri: "https://example.test/callback", expiresAt: "2030-01-01T00:00:00.000Z", consumedAt: null };
  await assert.doesNotReject(() => assertOAuthCallbackState({ context, state, record }));
  await assert.rejects(() => assertOAuthCallbackState({ context, state: "tampered", record }), { message: "OAUTH_STATE_INVALID" });
  await assert.rejects(() => assertOAuthCallbackState({ context, state, record: { ...record, socialAccountId: "kabumori_x" } }), { message: "OAUTH_STATE_ACCOUNT_MISMATCH" });
  await assert.rejects(() => assertOAuthCallbackState({ context, state, record: { ...record, expiresAt: "2020-01-01T00:00:00.000Z" } }), { message: "OAUTH_STATE_EXPIRED" });
});

test("identity verification calls only read-only users/me and rejects account mismatch", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => { calls.push(String(input)); return Response.json({ data: { id: "expected-user", username: "kaishain_ai_lab" } }); };
  await assert.doesNotReject(() => verifyReadOnlyXIdentity({ accessToken: "fixture-only", expectedPlatformUserId: "expected-user", expectedHandle: "kaishain_ai_lab", fetchImpl }));
  assert.deepEqual(calls, ["https://api.x.com/2/users/me"]);
  await assert.rejects(() => verifyReadOnlyXIdentity({ accessToken: "fixture-only", expectedPlatformUserId: "other", expectedHandle: "kaishain_ai_lab", fetchImpl }), { message: "X_IDENTITY_ACCOUNT_MISMATCH" });
});

// Phase 3C: a first connection has no stored platform user id, so the username is the only thing
// standing between "the account the operator meant" and "whichever X account the browser was logged in to".
test("first connection binds only the registered handle, case-insensitively, and rejects any other logged-in account", async () => {
  const respondAs = (username: unknown): typeof fetch => async () => Response.json({ data: { id: "some-user", username } });
  await assert.doesNotReject(() => verifyReadOnlyXIdentity({ accessToken: "fixture-only", expectedPlatformUserId: null, expectedHandle: "kaishain_ai_lab", fetchImpl: respondAs("Kaishain_AI_Lab") }));
  await assert.doesNotReject(() => verifyReadOnlyXIdentity({ accessToken: "fixture-only", expectedPlatformUserId: null, expectedHandle: "@kaishain_ai_lab", fetchImpl: respondAs("kaishain_ai_lab") }));
  await assert.rejects(() => verifyReadOnlyXIdentity({ accessToken: "fixture-only", expectedPlatformUserId: null, expectedHandle: "kaishain_ai_lab", fetchImpl: respondAs("kabumori") }), { message: "X_IDENTITY_HANDLE_MISMATCH" });
  await assert.rejects(() => verifyReadOnlyXIdentity({ accessToken: "fixture-only", expectedPlatformUserId: null, expectedHandle: "kaishain_ai_lab", fetchImpl: respondAs(undefined) }), { message: "X_IDENTITY_INVALID_RESPONSE" });
});

test("x-oauth-connect requests read-only scopes that include tweet.read (required by users/me) and never posting scopes", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../x-oauth-connect/index.ts", import.meta.url), "utf8");
  assert.match(source, /const SCOPES = "tweet\.read users\.read offline\.access";/u);
  assert.doesNotMatch(source, /tweet\.write|media\.write|like\.write|follows\.write/u);
  assert.match(source, /expectedHandle/u);
});
