// Phase 9 candidate: general (non-admin) social-mobile users connect their own X account.
//
// Unlike x-oauth-connect (a separate, still-service_role-only, hardcoded-2-account admin flow this
// module never imports or touches), every PostgREST call this module makes forwards the CONNECTING
// USER'S OWN bearer JWT -- never the service role key -- so that auth.uid() inside the
// begin/consume/complete_social_mobile_x_oauth_* SECURITY DEFINER RPCs resolves to the real caller and
// every ownership check in this file is backed by a DB-side check, not merely a client-trusted one.
//
// The PKCE code_verifier is generated and held by the mobile client itself (never sent to or stored by
// this database -- see the migration's own architecture note); this module only ever sees it in the one
// /callback request that needs it to complete the X token exchange, and never writes it anywhere.

export type FetchLike = typeof fetch;

export class OAuthConnectUserError extends Error {
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = "OAuthConnectUserError";
    this.status = status;
  }
}

function fail(code: string, status: number): never {
  throw new OAuthConnectUserError(code, status);
}

export async function hashState(state: string): Promise<string> {
  const bytes = new TextEncoder().encode(state);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ResolvedUser = { userId: string };

// Resolves the caller's own identity from their own bearer token (never a service-role bypass, and never
// an admin_users check -- any real, non-anonymous signed-in user may connect their own account).
export async function resolveConnectingUser({
  authorizationHeader,
  supabaseUrl,
  anonKey,
  fetchImpl = fetch,
}: {
  authorizationHeader: string | null;
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: FetchLike;
}): Promise<ResolvedUser> {
  const match = authorizationHeader ? /^Bearer\s+(.+)$/iu.exec(authorizationHeader.trim()) : null;
  const token = match?.[1]?.trim();
  if (!token) fail("SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED", 401);
  let response: Response;
  try {
    response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
  } catch {
    fail("SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED", 401);
  }
  if (!response.ok) fail("SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED", 401);
  let user: unknown;
  try {
    user = await response.json();
  } catch {
    fail("SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED", 401);
  }
  const id = typeof user === "object" && user !== null ? (user as { id?: unknown }).id : null;
  if (typeof id !== "string" || !id) fail("SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED", 401);
  return { userId: id };
}

// Calls a Postgres RPC as the connecting user (forwarding their own JWT), never as service_role.
export async function rpcAsUser({
  supabaseUrl,
  anonKey,
  userAccessToken,
  name,
  body,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  anonKey: string;
  userAccessToken: string;
  name: string;
  body: Record<string, unknown>;
  fetchImpl?: FetchLike;
}): Promise<unknown> {
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${userAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let code = "SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED";
    try {
      const errorBody = await response.json() as { message?: unknown };
      if (typeof errorBody.message === "string" && errorBody.message.length > 0) code = errorBody.message;
    } catch {
      // keep the generic code
    }
    fail(code, response.status === 401 || response.status === 403 ? response.status : 400);
  }
  const text = await response.text();
  return text.trim() === "" ? null : JSON.parse(text);
}

// K2 2026-09-19 fix: this request now carries the RAW client-generated state, not a pre-hashed value.
// The earlier candidate had the mobile client pre-hash state before sending it here, and this function
// then sent that *hash* to X as the OAuth `state` parameter -- X returns whatever it was given completely
// unchanged, so the callback's hashState(request.state) in completeConnection() was hashing the hash a
// second time, and could never match what begin() had stored. The fix: exactly one hash computation
// happens anywhere in this whole flow, right here, from the one raw value the client generates and X
// round-trips unchanged -- X only ever sees and returns the RAW state.
export type StartRequest = { rawState: string; codeChallenge: string; redirectUri: string };
export type StartResult = { authorizationUrl: string; brandId: string; socialAccountId: string };

const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const X_SCOPES = "tweet.read users.read offline.access";

export async function startConnection({
  request,
  userAccessToken,
  supabaseUrl,
  anonKey,
  clientId,
  fetchImpl = fetch,
  now = new Date(),
}: {
  request: StartRequest;
  userAccessToken: string;
  supabaseUrl: string;
  anonKey: string;
  clientId: string;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<StartResult> {
  // 16 bytes of randomness base64url-encoded is at least 22 chars; require a bit more headroom than that
  // as a sanity floor without hardcoding the client's exact encoding.
  if (!request.rawState || request.rawState.length < 16) fail("OAUTH_STATE_INPUT_INVALID", 400);
  if (!request.codeChallenge || !request.redirectUri) fail("OAUTH_STATE_INPUT_INVALID", 400);

  const stateHash = await hashState(request.rawState);
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const rows = await rpcAsUser({
    supabaseUrl, anonKey, userAccessToken, fetchImpl,
    name: "begin_social_mobile_x_oauth_connection",
    body: { p_state_hash: stateHash, p_redirect_uri: request.redirectUri, p_expires_at: expiresAt },
  }) as Array<{ brand_id: string; social_account_id: string }> | { brand_id: string; social_account_id: string } | null;
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.brand_id || !row.social_account_id) fail("SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED", 502);

  const authorize = new URL(X_AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: request.redirectUri,
    scope: X_SCOPES,
    state: request.rawState, // X returns this exact value unchanged; the client also independently
                             // compares it against its own locally-held copy before ever calling back here.
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
  }).toString();

  return { authorizationUrl: authorize.toString(), brandId: row.brand_id, socialAccountId: row.social_account_id };
}

export type CallbackRequest = { code: string; state: string; codeVerifier: string; redirectUri: string };
export type CallbackResult = {
  brandId: string;
  socialAccountId: string;
  handle: string;
  connectionStatus: "identity_verified";
};

const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_IDENTITY_URL = "https://api.x.com/2/users/me";

async function exchangeCodeForTokens({
  code,
  codeVerifier,
  redirectUri,
  clientId,
  clientSecret,
  fetchImpl,
}: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: FetchLike;
}): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await fetchImpl(X_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: clientId,
    }),
  });
  if (!response.ok) fail(`X_TOKEN_EXCHANGE_FAILED:${response.status}`, 502);
  const body = await response.json() as { access_token?: unknown; refresh_token?: unknown };
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    fail("X_TOKEN_EXCHANGE_INVALID_RESPONSE", 502);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

async function readXIdentity({ accessToken, fetchImpl }: { accessToken: string; fetchImpl: FetchLike }): Promise<{ platformUserId: string; handle: string }> {
  const response = await fetchImpl(X_IDENTITY_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) fail(`X_IDENTITY_READ_FAILED:${response.status}`, 502);
  const body = await response.json() as { data?: { id?: unknown; username?: unknown } };
  const platformUserId = body.data?.id;
  const username = body.data?.username;
  if (typeof platformUserId !== "string" || !platformUserId || typeof username !== "string" || !username) {
    fail("X_IDENTITY_INVALID_RESPONSE", 502);
  }
  return { platformUserId, handle: username };
}

// K2 2026-09-19 fix: consume_social_mobile_x_oauth_state() is now read-only (see the migration's own
// comment) -- it no longer marks the state consumed, so calling it here is safe to repeat on retry. The
// actual, one-time irreversible consumption now happens atomically inside
// complete_social_mobile_x_oauth_connection() itself (keyed by the state row's own id, not a
// client-suppliable social_account_id), at the exact point the flow commits to writing tokens. This means
// a failure at any step BEFORE that RPC call -- redirect mismatch, X token endpoint error, X identity read
// error -- leaves the state fully retryable; only a call that reaches and passes that RPC (success, or a
// concurrent/replayed duplicate racing against it) can ever change its consumed state.
export async function completeConnection({
  request,
  userAccessToken,
  supabaseUrl,
  anonKey,
  clientId,
  clientSecret,
  fetchImpl = fetch,
}: {
  request: CallbackRequest;
  userAccessToken: string;
  supabaseUrl: string;
  anonKey: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
}): Promise<CallbackResult> {
  if (!request.code || !request.state || !request.codeVerifier || !request.redirectUri) {
    fail("OAUTH_CALLBACK_INPUT_INVALID", 400);
  }
  const stateHash = await hashState(request.state);

  const consumed = await rpcAsUser({
    supabaseUrl, anonKey, userAccessToken, fetchImpl,
    name: "consume_social_mobile_x_oauth_state",
    body: { p_state_hash: stateHash },
  }) as Array<{ oauth_state_id: string; redirect_uri: string; brand_id: string; social_account_id: string }>
    | { oauth_state_id: string; redirect_uri: string; brand_id: string; social_account_id: string } | null;
  const state = Array.isArray(consumed) ? consumed[0] : consumed;
  if (!state?.oauth_state_id || !state.social_account_id) fail("OAUTH_STATE_NOT_CONSUMABLE", 400);
  if (state.redirect_uri !== request.redirectUri) fail("OAUTH_STATE_REDIRECT_MISMATCH", 400);

  const tokens = await exchangeCodeForTokens({
    code: request.code, codeVerifier: request.codeVerifier, redirectUri: request.redirectUri,
    clientId, clientSecret, fetchImpl,
  });
  const identity = await readXIdentity({ accessToken: tokens.accessToken, fetchImpl });

  // The single irreversible step: fails closed (OAUTH_STATE_NOT_CONSUMABLE) if this exact state was
  // already consumed by an earlier successful completion, or by a concurrently-racing duplicate.
  await rpcAsUser({
    supabaseUrl, anonKey, userAccessToken, fetchImpl,
    name: "complete_social_mobile_x_oauth_connection",
    body: {
      p_oauth_state_id: state.oauth_state_id,
      p_platform_user_id: identity.platformUserId,
      p_handle: identity.handle,
      p_access_token: tokens.accessToken,
      p_refresh_token: tokens.refreshToken,
    },
  });

  return {
    brandId: state.brand_id,
    socialAccountId: state.social_account_id,
    handle: identity.handle,
    connectionStatus: "identity_verified",
  };
}
