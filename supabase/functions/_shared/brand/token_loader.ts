import {
  LEGACY_KABUMORI_BRAND_ID,
  BrandContextError,
  type BrandContext,
} from "./brand_context.ts";
import { loadXTokens, type XTokenState } from "../x_oauth2_post.ts";

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
}: {
  context: BrandContext;
  supabaseUrl: string;
  serviceRoleKey: string;
  clientSecret: string;
  fallbackAccessToken: string;
  fallbackRefreshToken: string;
}): Promise<XTokenState> {
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
  );
}
