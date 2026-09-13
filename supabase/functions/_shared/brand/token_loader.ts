import {
  LEGACY_KABUMORI_BRAND_ID,
  BrandContextError,
  type BrandContext,
} from "./brand_context.ts";
import { loadXTokens, type XTokenState } from "../x_oauth2_post.ts";

export type VaultTokenReference = {
  socialAccountId: string;
  accessTokenSecretRef: string;
  refreshTokenSecretRef: string;
};

export type VaultSecretReader = {
  readSecret(reference: string): Promise<string | null>;
};

/**
 * Phase 2 deliberately keeps the legacy single-account oauth_token_store frozen.
 * The routing boundary is centralized here so Phase 3 can replace only this
 * resolver with a Vault-backed social-account lookup.
 */
export async function loadBrandXTokens({
  context,
  supabaseUrl,
  serviceRoleKey,
  clientSecret,
  fallbackAccessToken,
  fallbackRefreshToken,
  fetchImpl = fetch,
}: {
  context: BrandContext;
  supabaseUrl: string;
  serviceRoleKey: string;
  clientSecret: string;
  fallbackAccessToken: string;
  fallbackRefreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<XTokenState> {
  // Both checks below must resolve before loadXTokens ever runs -- that call is what reads the shared
  // legacy oauth_token_store, so any brand other than the one it was built for (or a misconfigured
  // account) must never reach it. This is Kabumori's only production credential source today; a brand
  // gets its own resolver (loadVaultBackedXTokens) once it is wired into the live dispatch path.
  if (context.brand.id !== LEGACY_KABUMORI_BRAND_ID) {
    throw new BrandContextError("BRAND_TOKEN_RESOLVER_NOT_CONFIGURED");
  }
  if (context.socialAccount?.oauth_client_ref !== "default") {
    throw new BrandContextError("BRAND_OAUTH_CLIENT_NOT_CONFIGURED");
  }
  return loadXTokens(
    supabaseUrl,
    serviceRoleKey,
    clientSecret,
    fallbackAccessToken,
    fallbackRefreshToken,
    fetchImpl,
  );
}

/**
 * Phase 3A's production-shaped boundary. It accepts opaque references only;
 * the caller owns the database/Vault adapter. No Vault query or secret write is
 * made here, which keeps fixtures safe and prevents secret material in logs.
 */
export async function loadVaultBackedXTokens({
  context,
  tokenReference,
  vault,
}: {
  context: BrandContext;
  tokenReference: VaultTokenReference | null;
  vault: VaultSecretReader;
}): Promise<XTokenState> {
  if (!context.socialAccount || !tokenReference) {
    throw new BrandContextError("BRAND_VAULT_TOKEN_NOT_CONFIGURED");
  }
  if (tokenReference.socialAccountId !== context.socialAccount.id) {
    throw new BrandContextError("BRAND_VAULT_ACCOUNT_MISMATCH");
  }
  const [accessToken, refreshToken] = await Promise.all([
    vault.readSecret(tokenReference.accessTokenSecretRef),
    vault.readSecret(tokenReference.refreshTokenSecretRef),
  ]);
  if (!accessToken || !refreshToken) {
    throw new BrandContextError("BRAND_VAULT_TOKEN_NOT_CONFIGURED");
  }
  return { accessToken, refreshToken };
}
