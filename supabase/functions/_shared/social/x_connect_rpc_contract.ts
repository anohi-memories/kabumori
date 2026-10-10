// POSTONA X OAuth hardening — the typed boundary between a future X connect Edge Function and the
// candidate v2 database functions (supabase/candidates/postona_x_oauth_hardening_candidate.sql). Pure and
// unwired: nothing imports it, it makes no request, and the v2 RPCs are not granted to anyone. The live
// Edge (x-oauth-connect-user) keeps calling the live RPCs until the reviewed switch
// (docs/postona/x-oauth-hardening-candidate-20261010.md).

export const X_CONNECT_RPC_V2 = Object.freeze({
  begin: "begin_social_mobile_x_oauth_connection_v2",
  consume: "consume_social_mobile_x_oauth_state_v2",
  complete: "complete_social_mobile_x_oauth_connection_v2",
});

/** The live RPCs v2 replaces; revoked from authenticated only in the last step of the switch. */
export const X_CONNECT_RPC_LIVE = Object.freeze({
  begin: "begin_social_mobile_x_oauth_connection",
  consume: "consume_social_mobile_x_oauth_state",
  complete: "complete_social_mobile_x_oauth_connection",
});

/** A state lives at most this long (v2 refuses longer; the live Edge already asks for exactly this). */
export const X_OAUTH_STATE_MAX_TTL_MS = 10 * 60 * 1000;

export class XConnectRpcInputError extends Error {
  constructor(readonly code: "STATE_HASH_INVALID" | "REDIRECT_URI_INVALID" | "EXPIRY_INVALID" | "STATE_ID_INVALID" | "IDENTITY_INVALID" | "TOKEN_INVALID" | "KEY_INVALID") {
    super(code);
    this.name = "XConnectRpcInputError";
  }
}

const STATE_HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A registered app redirect (custom scheme or https), never cleartext http.
const REDIRECT = /^[a-z][a-z0-9+.-]*:\/\/[^#*@\s]+$/;
const X_USER_ID = /^[1-9][0-9]{0,19}$/;
const X_USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const TOKEN = /^[!-~]+$/;

export function beginRpcPayload(input: Readonly<{ stateHash: string; redirectUri: string; expiresAt: Date; now: Date }>):
  Readonly<{ p_state_hash: string; p_redirect_uri: string; p_expires_at: string }> {
  if (!STATE_HASH.test(input.stateHash)) throw new XConnectRpcInputError("STATE_HASH_INVALID");
  if (!REDIRECT.test(input.redirectUri) || input.redirectUri.startsWith("http://") || input.redirectUri.length > 2048) {
    throw new XConnectRpcInputError("REDIRECT_URI_INVALID");
  }
  const ttl = input.expiresAt.getTime() - input.now.getTime();
  if (!(ttl > 0 && ttl <= X_OAUTH_STATE_MAX_TTL_MS)) throw new XConnectRpcInputError("EXPIRY_INVALID");
  return { p_state_hash: input.stateHash, p_redirect_uri: input.redirectUri, p_expires_at: input.expiresAt.toISOString() };
}

export function consumeRpcPayload(stateHash: string): Readonly<{ p_state_hash: string }> {
  if (!STATE_HASH.test(stateHash)) throw new XConnectRpcInputError("STATE_HASH_INVALID");
  return { p_state_hash: stateHash };
}

// --- Server attestation (complete) --------------------------------------------------------------------------

/** Vault secret name v2 reads; the X Edge exchange holds the same key (its own, not the Threads one). */
export const X_CONNECT_ATTESTATION_VAULT_NAME = "postona_x_connect_attestation_v1";
export const X_CONNECT_ATTESTATION_VERSION = "postona-x-connect-v1";

/** What the code exchange and /2/users/me produced, for the state consume returned. */
export type XConnectAttested = Readonly<{
  oauthStateId: string;
  xUserId: string;
  username: string;
  accessToken: string;
  refreshToken: string;
}>;

const validToken = (token: string) => TOKEN.test(token) && token.length >= 16 && token.length <= 4096;

function checkAttested(input: XConnectAttested): void {
  if (!UUID.test(input.oauthStateId)) throw new XConnectRpcInputError("STATE_ID_INVALID");
  if (!X_USER_ID.test(input.xUserId) || !X_USERNAME.test(input.username)) throw new XConnectRpcInputError("IDENTITY_INVALID");
  if (!validToken(input.accessToken) || !validToken(input.refreshToken) || input.accessToken === input.refreshToken) {
    throw new XConnectRpcInputError("TOKEN_INVALID");
  }
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * HMAC-SHA256 (hex) over: version, state id, X user id, username, and the hex SHA-256 of the access and
 * of the refresh token, joined by "\n" — exactly what v2 recomputes. The tokens themselves are never
 * part of the message.
 */
export async function xConnectAttestation(key: string, input: XConnectAttested): Promise<string> {
  if (key.length < 32) throw new XConnectRpcInputError("KEY_INVALID");
  checkAttested(input);
  const encoder = new TextEncoder();
  const sha = async (value: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  const message = [X_CONNECT_ATTESTATION_VERSION, input.oauthStateId, input.xUserId, input.username,
    await sha(input.accessToken), await sha(input.refreshToken)].join("\n");
  const hmacKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(message)));
}

export async function completeRpcPayload(key: string, input: XConnectAttested): Promise<
  Readonly<{
    p_oauth_state_id: string;
    p_platform_user_id: string;
    p_handle: string;
    p_access_token: string;
    p_refresh_token: string;
    p_attestation: string;
  }>
> {
  const attestation = await xConnectAttestation(key, input);
  return {
    p_oauth_state_id: input.oauthStateId,
    p_platform_user_id: input.xUserId,
    p_handle: input.username,
    p_access_token: input.accessToken,
    p_refresh_token: input.refreshToken,
    p_attestation: attestation,
  };
}

/** v2's own refusals (G5's guard adds its ACCOUNT_* / SERVICE_* codes, SQLSTATE 42501). */
export const X_CONNECT_V2_REFUSAL_CODES = Object.freeze([
  "OAUTH_STATE_INPUT_INVALID",
  "OAUTH_STATE_NOT_CONSUMABLE",
  "OAUTH_TOKEN_OR_IDENTITY_INVALID",
  "X_CONNECT_ATTESTATION_UNAVAILABLE",
  "X_CONNECT_ATTESTATION_INVALID",
  "SOCIAL_MOBILE_ACCOUNT_NOT_OWNED",
  "X_ACCOUNT_CONFLICT",
  "X_IDENTITY_ACCOUNT_MISMATCH",
  "X_CREDENTIAL_SHAPE_INVALID",
  "X_ACCOUNT_ALREADY_CONNECTED",
] as const);
