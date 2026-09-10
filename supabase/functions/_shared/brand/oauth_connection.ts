import { BrandContextError, type BrandContext } from "./brand_context.ts";

export type OAuthStateRecord = {
  socialAccountId: string;
  brandId: string;
  stateHash: string;
  codeVerifierVaultSecretId: string | null;
  redirectUri: string;
  expiresAt: string;
  consumedAt: string | null;
};

export async function hashOAuthState(state: string): Promise<string> {
  const bytes = new TextEncoder().encode(state);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assertOAuthCallbackState({
  context,
  state,
  record,
  now = new Date(),
}: {
  context: BrandContext;
  state: string;
  record: OAuthStateRecord | null;
  now?: Date;
}): Promise<void> {
  if (!record) throw new BrandContextError("OAUTH_STATE_UNKNOWN");
  if (!context.socialAccount || record.socialAccountId !== context.socialAccount.id || record.brandId !== context.brand.id) {
    throw new BrandContextError("OAUTH_STATE_ACCOUNT_MISMATCH");
  }
  if (record.consumedAt) throw new BrandContextError("OAUTH_STATE_ALREADY_CONSUMED");
  if (Date.parse(record.expiresAt) <= now.getTime()) throw new BrandContextError("OAUTH_STATE_EXPIRED");
  if (await hashOAuthState(state) !== record.stateHash) throw new BrandContextError("OAUTH_STATE_INVALID");
  if (!record.codeVerifierVaultSecretId) throw new BrandContextError("OAUTH_PKCE_VERIFIER_NOT_CONFIGURED");
}

export async function verifyReadOnlyXIdentity({
  accessToken,
  expectedPlatformUserId,
  fetchImpl = fetch,
}: {
  accessToken: string;
  expectedPlatformUserId: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{ platformUserId: string }> {
  const response = await fetchImpl("https://api.x.com/2/users/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new BrandContextError(`X_IDENTITY_READ_FAILED:${response.status}`);
  const body = await response.json() as { data?: { id?: unknown } };
  const platformUserId = body.data?.id;
  if (typeof platformUserId !== "string" || !platformUserId) {
    throw new BrandContextError("X_IDENTITY_INVALID_RESPONSE");
  }
  if (expectedPlatformUserId && expectedPlatformUserId !== platformUserId) {
    throw new BrandContextError("X_IDENTITY_ACCOUNT_MISMATCH");
  }
  return { platformUserId };
}
