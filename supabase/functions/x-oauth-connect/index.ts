// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { resolveAdminAuthorization } from "../x-test-post/admin_auth_logic.ts";
import { assertOAuthCallbackState, hashOAuthState, verifyReadOnlyXIdentity } from "../_shared/brand/oauth_connection.ts";
import { loadBrandContext, BrandContextError } from "../_shared/brand/brand_context.ts";

const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const SCOPES = "users.read offline.access";
const ACCOUNT_ID = "ai_salaryman_lab_x";
const BRAND_ID = "ai_salaryman_lab";

function json(body: Record<string, unknown>, status = 200) { return Response.json(body, { status }); }
function serviceHeaders(key: string) { return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }; }
function b64url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function challenge(verifier: string) { return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))); }
function randomValue(bytes = 32) { const data = crypto.getRandomValues(new Uint8Array(bytes)); return b64url(data); }
function safeCode(error: unknown) { return error instanceof BrandContextError ? error.message : "X_OAUTH_CONNECTION_FAILED"; }

async function rpc(url: string, key: string, name: string, body: Record<string, unknown>) {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers: serviceHeaders(key), body: JSON.stringify(body) });
  if (!response.ok) throw new BrandContextError("OAUTH_CONNECTION_DB_WRITE_FAILED");
  return await response.json();
}

async function callback(req: Request, url: string, serviceRoleKey: string, clientId: string, clientSecret: string) {
  const query = new URL(req.url).searchParams;
  const state = query.get("state"); const code = query.get("code");
  if (!state || !code || query.get("error")) return json({ success: false, error: "X_OAUTH_CALLBACK_REJECTED" }, 400);
  const stateHash = await hashOAuthState(state);
  const lookup = await fetch(`${url}/rest/v1/social_account_oauth_states?select=social_account_id,brand_id,state_hash,code_verifier_vault_secret_id,redirect_uri,expires_at,consumed_at&state_hash=eq.${stateHash}&limit=1`, { headers: serviceHeaders(serviceRoleKey) });
  const records = lookup.ok ? await lookup.json() : [];
  const context = await loadBrandContext({ supabaseUrl: url, serviceRoleKey, brandId: BRAND_ID });
  await assertOAuthCallbackState({ context, state, record: records[0] ? { socialAccountId: records[0].social_account_id, brandId: records[0].brand_id, stateHash: records[0].state_hash, codeVerifierVaultSecretId: records[0].code_verifier_vault_secret_id, redirectUri: records[0].redirect_uri, expiresAt: records[0].expires_at, consumedAt: records[0].consumed_at } : null });
  const consumed = await rpc(url, serviceRoleKey, "consume_ai_salaryman_lab_oauth_state", { p_state_hash: stateHash }) as Array<{ code_verifier: string; redirect_uri: string; expected_platform_user_id: string | null }>;
  if (!consumed[0]?.code_verifier || !consumed[0]?.redirect_uri) throw new BrandContextError("OAUTH_PKCE_VERIFIER_NOT_CONFIGURED");
  const tokenResponse = await fetch(X_TOKEN_URL, { method: "POST", headers: { Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: consumed[0].redirect_uri, code_verifier: consumed[0].code_verifier, client_id: clientId }) });
  if (!tokenResponse.ok) throw new BrandContextError(`X_TOKEN_EXCHANGE_FAILED:${tokenResponse.status}`);
  const tokens = await tokenResponse.json() as { access_token?: unknown; refresh_token?: unknown };
  if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") throw new BrandContextError("X_TOKEN_EXCHANGE_INVALID_RESPONSE");
  const identity = await verifyReadOnlyXIdentity({ accessToken: tokens.access_token, expectedPlatformUserId: consumed[0].expected_platform_user_id });
  await rpc(url, serviceRoleKey, "complete_ai_salaryman_lab_oauth_connection", { p_access_token: tokens.access_token, p_refresh_token: tokens.refresh_token, p_platform_user_id: identity.platformUserId });
  return json({ success: true, connection_status: "identity_verified", publish_mode: "dry_run", publish_enabled: false });
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
    const dashboardSecretOperator = authorizationHeader === `Bearer ${serviceRoleKey}`;
    const admin = dashboardSecretOperator
      ? { authorized: true, userId: null }
      : await resolveAdminAuthorization({ authorizationHeader, supabaseUrl, anonKey, serviceRoleKey });
    if (!admin.authorized) return json({ error: "OAUTH_CONNECTION_UNAUTHORIZED" }, 403);
    const body = await req.json() as { handle?: unknown };
    if (typeof body.handle !== "string") return json({ error: "AI_LAB_HANDLE_REQUIRED" }, 400);
    const redirectUri = `${supabaseUrl}/functions/v1/x-oauth-connect/callback`;
    const state = randomValue(); const verifier = randomValue(48); const stateHash = await hashOAuthState(state);
    await rpc(supabaseUrl, serviceRoleKey, "begin_ai_salaryman_lab_oauth_connection", { p_handle: body.handle, p_state_hash: stateHash, p_code_verifier: verifier, p_redirect_uri: redirectUri, p_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
    const authorize = new URL(X_AUTHORIZE_URL); authorize.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SCOPES, state, code_challenge: await challenge(verifier), code_challenge_method: "S256" }).toString();
    return json({ authorization_url: authorize.toString(), brand_id: BRAND_ID, social_account_id: ACCOUNT_ID, redirect_uri: redirectUri, scopes: SCOPES, publish_mode: "dry_run", publish_enabled: false });
  } catch (error) { return json({ error: safeCode(error) }, 400); }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/x-oauth-connect' \
    --header 'apiKey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
    --data '{"name":"Functions"}'

*/
