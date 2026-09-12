// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { resolveAdminAuthorization } from "../x-test-post/admin_auth_logic.ts";
import { assertOAuthCallbackState, hashOAuthState, verifyReadOnlyXIdentity } from "../_shared/brand/oauth_connection.ts";
import { loadBrandContext, BrandContextError } from "../_shared/brand/brand_context.ts";
import { rpc } from "./rpc.ts";
import { createOAuthStartResponse } from "./start_logic.ts";
import { resolveOAuthCallbackConfig, resolveOAuthStartConfig } from "./account_config.ts";
import { probeLegacyXTokenStore } from "./legacy_token_store.ts";
import { runKabumoriRefreshOnlyProof } from "./kabumori_recovery.ts";

const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";

function json(body: Record<string, unknown>, status = 200) { return Response.json(body, { status }); }
function serviceHeaders(key: string) { return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }; }
function safeCode(error: unknown) { return error instanceof BrandContextError ? error.message : "X_OAUTH_CONNECTION_FAILED"; }

async function callback(req: Request, url: string, serviceRoleKey: string, clientId: string, clientSecret: string) {
  const query = new URL(req.url).searchParams;
  const state = query.get("state"); const code = query.get("code");
  if (!state || !code || query.get("error")) return json({ success: false, error: "X_OAUTH_CALLBACK_REJECTED" }, 400);
  const stateHash = await hashOAuthState(state);
  const lookup = await fetch(`${url}/rest/v1/social_account_oauth_states?select=social_account_id,brand_id,state_hash,code_verifier_vault_secret_id,redirect_uri,expires_at,consumed_at&state_hash=eq.${stateHash}&limit=1`, { headers: serviceHeaders(serviceRoleKey) });
  const records = lookup.ok ? await lookup.json() : [];
  const record = records[0];
  if (!record) throw new BrandContextError("OAUTH_STATE_UNKNOWN");
  const config = resolveOAuthCallbackConfig(record.social_account_id, record.brand_id);
  const context = await loadBrandContext({ supabaseUrl: url, serviceRoleKey, brandId: config.brandId });
  await assertOAuthCallbackState({ context, state, record: { socialAccountId: record.social_account_id, brandId: record.brand_id, stateHash: record.state_hash, codeVerifierVaultSecretId: record.code_verifier_vault_secret_id, redirectUri: record.redirect_uri, expiresAt: record.expires_at, consumedAt: record.consumed_at } });
  const consumed = await rpc(url, serviceRoleKey, config.consumeRpc, { p_state_hash: stateHash }) as Array<{ code_verifier: string; redirect_uri: string; expected_platform_user_id: string | null }>;
  if (!consumed[0]?.code_verifier || !consumed[0]?.redirect_uri) throw new BrandContextError("OAUTH_PKCE_VERIFIER_NOT_CONFIGURED");
  const tokenResponse = await fetch(X_TOKEN_URL, { method: "POST", headers: { Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: consumed[0].redirect_uri, code_verifier: consumed[0].code_verifier, client_id: clientId }) });
  if (!tokenResponse.ok) throw new BrandContextError(`X_TOKEN_EXCHANGE_FAILED:${tokenResponse.status}`);
  const tokens = await tokenResponse.json() as { access_token?: unknown; refresh_token?: unknown };
  if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") throw new BrandContextError("X_TOKEN_EXCHANGE_INVALID_RESPONSE");
  const expectedHandle = context.socialAccount?.handle;
  if (!expectedHandle || expectedHandle.replace(/^@/u, "").toLowerCase() !== config.expectedHandle) {
    throw new BrandContextError("OAUTH_EXPECTED_HANDLE_NOT_CONFIGURED");
  }
  const identity = await verifyReadOnlyXIdentity({ accessToken: tokens.access_token, expectedPlatformUserId: consumed[0].expected_platform_user_id, expectedHandle });
  if (config.tokenDestination === "vault") {
    await rpc(url, serviceRoleKey, config.completeRpc, { p_access_token: tokens.access_token, p_refresh_token: tokens.refresh_token, p_platform_user_id: identity.platformUserId });
    return json({ success: true, connection_status: "identity_verified", publish_mode: config.publishMode, publish_enabled: config.publishEnabled });
  }
  const proof = await runKabumoriRefreshOnlyProof({
    supabaseUrl: url,
    serviceRoleKey,
    clientId,
    clientSecret,
    initialTokens: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
    expectedPlatformUserId: identity.platformUserId,
    expectedHandle,
  });
  await rpc(url, serviceRoleKey, config.completeRpc, { p_platform_user_id: proof.platformUserId });
  return json({
    success: true,
    connection_status: "identity_verified",
    publish_mode: config.publishMode,
    publish_enabled: config.publishEnabled,
    refresh_only_proof: {
      token_endpoint_2xx: proof.tokenEndpoint2xx,
      saved_and_reloaded: proof.savedAndReloaded,
      identity_verified: proof.identityVerified,
      x_post_api_calls: 0,
      media_upload_api_calls: 0,
    },
  });
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL"); const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); const anonKey = Deno.env.get("SUPABASE_ANON_KEY"); const clientId = Deno.env.get("X_CLIENT_ID"); const clientSecret = Deno.env.get("X_CLIENT_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !anonKey || !clientId || !clientSecret) return json({ error: "REQUIRED_SERVER_SECRET_MISSING" }, 500);
  try {
    if (req.method === "GET" && new URL(req.url).pathname.endsWith("/callback")) return await callback(req, supabaseUrl, serviceRoleKey, clientId, clientSecret);
    if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    // This is intentionally limited to this POST start branch. Supabase's
    // Dashboard injects its secret key without revealing it to the operator;
    // callback, token exchange, identity reads, and every other Function path
    // never use this bypass. Ordinary clients retain admin_users JWT checks.
    const authorizationHeader = req.headers.get("Authorization");
    // The Dashboard test console supplies the project secret key as `apikey`.
    // Accept it only in this POST-start branch; never in callback handling.
    const dashboardSecretOperator = authorizationHeader === `Bearer ${serviceRoleKey}` ||
      req.headers.get("apikey") === serviceRoleKey;
    const admin = dashboardSecretOperator
      ? { authorized: true, userId: null }
      : await resolveAdminAuthorization({ authorizationHeader, supabaseUrl, anonKey, serviceRoleKey });
    if (!admin.authorized) return json({ error: "OAUTH_CONNECTION_UNAUTHORIZED" }, 403);
    const body = await req.json() as { handle?: unknown };
    if (typeof body.handle !== "string") return json({ error: "OAUTH_HANDLE_REQUIRED" }, 400);
    const config = resolveOAuthStartConfig(body.handle);
    const legacyTokenStoreStatus = config.tokenDestination === "legacy_store"
      ? await probeLegacyXTokenStore({ supabaseUrl, serviceRoleKey, clientSecret })
      : null;
    const response = await createOAuthStartResponse({
      supabaseUrl,
      serviceRoleKey,
      clientId,
      handle: body.handle,
      brandId: config.brandId,
      socialAccountId: config.socialAccountId,
      scopes: config.scopes,
      beginRpc: config.beginRpc,
      includeHandleInRpc: config.tokenDestination === "vault",
      publishMode: config.publishMode,
      publishEnabled: config.publishEnabled,
    });
    return json({
      ...response,
      ...(legacyTokenStoreStatus ? { legacy_token_store_status: legacyTokenStoreStatus } : {}),
    });
  } catch (error) { return json({ error: safeCode(error) }, 400); }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/x-oauth-connect' \
    --header 'apiKey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
    --data '{"name":"Functions"}'

*/
