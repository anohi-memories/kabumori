import { hashOAuthState } from "../_shared/brand/oauth_connection.ts";
import { rpc } from "./rpc.ts";

const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";

function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function challenge(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function randomValue(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return b64url(data);
}

export async function createOAuthStartResponse({
  supabaseUrl,
  serviceRoleKey,
  clientId,
  handle,
  brandId,
  socialAccountId,
  scopes,
  beginRpc = "begin_ai_salaryman_lab_oauth_connection",
  includeHandleInRpc = true,
  publishMode = "dry_run",
  publishEnabled = false,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  clientId: string;
  handle: string;
  brandId: string;
  socialAccountId: string;
  scopes: string;
  beginRpc?: string;
  includeHandleInRpc?: boolean;
  publishMode?: "dry_run" | "live";
  publishEnabled?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const redirectUri = `${supabaseUrl}/functions/v1/x-oauth-connect/callback`;
  const state = randomValue();
  const verifier = randomValue(48);
  const stateHash = await hashOAuthState(state);

  await rpc(supabaseUrl, serviceRoleKey, beginRpc, {
    ...(includeHandleInRpc ? { p_handle: handle } : {}),
    p_state_hash: stateHash,
    p_code_verifier: verifier,
    p_redirect_uri: redirectUri,
    p_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  }, fetchImpl);

  const authorize = new URL(X_AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
  }).toString();

  return {
    authorization_url: authorize.toString(),
    brand_id: brandId,
    social_account_id: socialAccountId,
    redirect_uri: redirectUri,
    scopes,
    publish_mode: publishMode,
    publish_enabled: publishEnabled,
  };
}
