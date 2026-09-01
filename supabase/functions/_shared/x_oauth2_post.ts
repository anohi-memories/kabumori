const X_API_URL = "https://api.x.com/2/tweets";
const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";

export type XTokenState = { accessToken: string; refreshToken: string };
export type XAuthContext = {
  tokens: XTokenState;
  clientId: string;
  clientSecret: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  refreshExecuted: boolean;
};

export type XPostOutcome = {
  id: string;
  body: unknown;
  httpStatus: number;
  refreshExecuted: boolean;
};

export class XPostError extends Error {
  httpStatus: number | null;

  constructor(code: string, httpStatus: number | null = null) {
    super(code);
    this.name = "XPostError";
    this.httpStatus = httpStatus;
  }
}

function supabaseHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function tokenEncryptionKey(clientSecret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientSecret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptToken(token: string, key: CryptoKey): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

async function decryptToken(ciphertext: string, iv: string, key: CryptoKey): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

export async function loadXTokens(
  supabaseUrl: string,
  serviceRoleKey: string,
  clientSecret: string,
  fallbackAccessToken: string,
  fallbackRefreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<XTokenState> {
  const params = new URLSearchParams({
    select: "access_token_ciphertext,access_token_iv,refresh_token_ciphertext,refresh_token_iv",
    provider: "eq.x",
    limit: "1",
  });
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/oauth_token_store?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!response.ok) throw new XPostError("OAUTH_TOKEN_STORE_READ_FAILED");
  const rows = await response.json() as Array<Record<string, string>>;
  if (!rows[0]) return { accessToken: fallbackAccessToken, refreshToken: fallbackRefreshToken };
  try {
    const key = await tokenEncryptionKey(clientSecret);
    return {
      accessToken: await decryptToken(rows[0].access_token_ciphertext, rows[0].access_token_iv, key),
      refreshToken: await decryptToken(rows[0].refresh_token_ciphertext, rows[0].refresh_token_iv, key),
    };
  } catch {
    console.error("Stored OAuth tokens could not be decrypted; using server secrets");
    return { accessToken: fallbackAccessToken, refreshToken: fallbackRefreshToken };
  }
}

async function saveXTokens(
  auth: XAuthContext,
  tokens: XTokenState,
  expiresIn: number | null,
  fetchImpl: typeof fetch,
): Promise<void> {
  const key = await tokenEncryptionKey(auth.clientSecret);
  const access = await encryptToken(tokens.accessToken, key);
  const refresh = await encryptToken(tokens.refreshToken, key);
  const response = await fetchImpl(`${auth.supabaseUrl}/rest/v1/oauth_token_store?on_conflict=provider`, {
    method: "POST",
    headers: { ...supabaseHeaders(auth.serviceRoleKey), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      provider: "x",
      access_token_ciphertext: access.ciphertext,
      access_token_iv: access.iv,
      refresh_token_ciphertext: refresh.ciphertext,
      refresh_token_iv: refresh.iv,
      expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) throw new XPostError("OAUTH_TOKEN_STORE_WRITE_FAILED");
}

async function refreshXTokens(auth: XAuthContext, fetchImpl: typeof fetch): Promise<void> {
  const credentials = btoa(`${auth.clientId}:${auth.clientSecret}`);
  const response = await fetchImpl(X_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.tokens.refreshToken,
      client_id: auth.clientId,
    }),
  });
  if (!response.ok) {
    console.error("X OAuth token refresh failed", { status: response.status });
    throw new XPostError(`X_TOKEN_REFRESH_FAILED:${response.status}`, response.status);
  }
  const body = await response.json() as Record<string, unknown>;
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new XPostError("X_TOKEN_REFRESH_INVALID_RESPONSE");
  }
  const tokens = {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token
      ? body.refresh_token
      : auth.tokens.refreshToken,
  };
  await saveXTokens(
    auth,
    tokens,
    typeof body.expires_in === "number" ? body.expires_in : null,
    fetchImpl,
  );
  auth.tokens = tokens;
  auth.refreshExecuted = true;
}

async function requestXPost(
  accessToken: string,
  text: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(X_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const responseText = await response.text();
  let body: unknown;
  try { body = JSON.parse(responseText); }
  catch { body = { error: "X API returned a non-JSON response" }; }
  return { status: response.status, body };
}

function getXPostId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const data = (result as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function postToXWithRefresh(
  auth: XAuthContext,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<XPostOutcome> {
  let result = await requestXPost(auth.tokens.accessToken, text, fetchImpl);
  if (result.status === 401) {
    if (auth.refreshExecuted) throw new XPostError("X_REQUEST_FAILED:401", 401);
    await refreshXTokens(auth, fetchImpl);
    result = await requestXPost(auth.tokens.accessToken, text, fetchImpl);
  }
  if (result.status < 200 || result.status >= 300) {
    console.error("X API request failed", { status: result.status });
    throw new XPostError(`X_REQUEST_FAILED:${result.status}`, result.status);
  }
  const id = getXPostId(result.body);
  if (!id) throw new XPostError("X_RESPONSE_MISSING_POST_ID", result.status);
  return { id, body: result.body, httpStatus: result.status, refreshExecuted: auth.refreshExecuted };
}
