import { BrandContextError } from "../_shared/brand/brand_context.ts";

export type OAuthTokens = { accessToken: string; refreshToken: string };
export type LegacyTokenProbe =
  | "decryptable"
  | "missing"
  | "not_decryptable_with_current_client_secret";

function serviceHeaders(serviceRoleKey: string): Record<string, string> {
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

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

async function tokenEncryptionKey(clientSecret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(clientSecret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptToken(
  token: string,
  key: CryptoKey,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
  };
}

async function decryptToken(
  ciphertext: string,
  iv: string,
  key: CryptoKey,
): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

export async function readLegacyXTokensStrict({
  supabaseUrl,
  serviceRoleKey,
  clientSecret,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    select:
      "access_token_ciphertext,access_token_iv,refresh_token_ciphertext,refresh_token_iv",
    provider: "eq.x",
    limit: "1",
  });
  const response = await fetchImpl(
    `${supabaseUrl}/rest/v1/oauth_token_store?${params}`,
    {
      headers: serviceHeaders(serviceRoleKey),
    },
  );
  if (!response.ok) {
    throw new BrandContextError("LEGACY_OAUTH_TOKEN_STORE_READ_FAILED");
  }
  const rows = await response.json() as Array<Record<string, string>>;
  if (!rows[0]) throw new BrandContextError("LEGACY_OAUTH_TOKEN_STORE_MISSING");
  try {
    const key = await tokenEncryptionKey(clientSecret);
    const accessToken = await decryptToken(
      rows[0].access_token_ciphertext,
      rows[0].access_token_iv,
      key,
    );
    const refreshToken = await decryptToken(
      rows[0].refresh_token_ciphertext,
      rows[0].refresh_token_iv,
      key,
    );
    if (!accessToken || !refreshToken) throw new Error("empty token");
    return { accessToken, refreshToken };
  } catch {
    throw new BrandContextError("LEGACY_OAUTH_TOKEN_STORE_DECRYPT_FAILED");
  }
}

export async function probeLegacyXTokenStore(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<LegacyTokenProbe> {
  try {
    await readLegacyXTokensStrict(input);
    return "decryptable";
  } catch (error) {
    if (
      error instanceof BrandContextError &&
      error.message === "LEGACY_OAUTH_TOKEN_STORE_MISSING"
    ) {
      return "missing";
    }
    if (
      error instanceof BrandContextError &&
      error.message === "LEGACY_OAUTH_TOKEN_STORE_DECRYPT_FAILED"
    ) {
      return "not_decryptable_with_current_client_secret";
    }
    throw error;
  }
}

export async function saveLegacyXTokens({
  supabaseUrl,
  serviceRoleKey,
  clientSecret,
  tokens,
  expiresIn,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  clientSecret: string;
  tokens: OAuthTokens;
  expiresIn: number | null;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const key = await tokenEncryptionKey(clientSecret);
  const access = await encryptToken(tokens.accessToken, key);
  const refresh = await encryptToken(tokens.refreshToken, key);
  const response = await fetchImpl(
    `${supabaseUrl}/rest/v1/oauth_token_store?on_conflict=provider`,
    {
      method: "POST",
      headers: {
        ...serviceHeaders(serviceRoleKey),
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        provider: "x",
        access_token_ciphertext: access.ciphertext,
        access_token_iv: access.iv,
        refresh_token_ciphertext: refresh.ciphertext,
        refresh_token_iv: refresh.iv,
        expires_at: expiresIn
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!response.ok) {
    throw new BrandContextError("LEGACY_OAUTH_TOKEN_STORE_WRITE_FAILED");
  }
}

export async function refreshXTokensOnly({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
}: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ tokens: OAuthTokens; expiresIn: number | null }> {
  const response = await fetchImpl("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
  if (!response.ok) {
    throw new BrandContextError(
      `X_TOKEN_REFRESH_PROOF_FAILED:${response.status}`,
    );
  }
  const body = await response.json() as Record<string, unknown>;
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new BrandContextError("X_TOKEN_REFRESH_PROOF_INVALID_RESPONSE");
  }
  return {
    tokens: {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token
        ? body.refresh_token
        : refreshToken,
    },
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
  };
}
