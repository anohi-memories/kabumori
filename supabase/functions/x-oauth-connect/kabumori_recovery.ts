import { BrandContextError } from "../_shared/brand/brand_context.ts";
import { verifyReadOnlyXIdentity } from "../_shared/brand/oauth_connection.ts";
import {
  type OAuthTokens,
  readLegacyXTokensStrict,
  refreshXTokensOnly,
  saveLegacyXTokens,
} from "./legacy_token_store.ts";

export async function runKabumoriRefreshOnlyProof({
  supabaseUrl,
  serviceRoleKey,
  clientId,
  clientSecret,
  initialTokens,
  expectedPlatformUserId,
  expectedHandle,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  clientId: string;
  clientSecret: string;
  initialTokens: OAuthTokens;
  expectedPlatformUserId: string;
  expectedHandle: string;
  fetchImpl?: typeof fetch;
}): Promise<
  {
    platformUserId: string;
    tokenEndpoint2xx: true;
    savedAndReloaded: true;
    identityVerified: true;
  }
> {
  const refreshed = await refreshXTokensOnly({
    clientId,
    clientSecret,
    refreshToken: initialTokens.refreshToken,
    fetchImpl,
  });

  const refreshedIdentity = await verifyReadOnlyXIdentity({
    accessToken: refreshed.tokens.accessToken,
    expectedPlatformUserId,
    expectedHandle,
    fetchImpl,
  });

  await saveLegacyXTokens({
    supabaseUrl,
    serviceRoleKey,
    clientSecret,
    tokens: refreshed.tokens,
    expiresIn: refreshed.expiresIn,
    fetchImpl,
  });

  const reloadedTokens = await readLegacyXTokensStrict({
    supabaseUrl,
    serviceRoleKey,
    clientSecret,
    fetchImpl,
  });
  const reloadedIdentity = await verifyReadOnlyXIdentity({
    accessToken: reloadedTokens.accessToken,
    expectedPlatformUserId,
    expectedHandle,
    fetchImpl,
  });

  if (refreshedIdentity.platformUserId !== reloadedIdentity.platformUserId) {
    throw new BrandContextError("X_IDENTITY_ACCOUNT_MISMATCH");
  }

  return {
    platformUserId: reloadedIdentity.platformUserId,
    tokenEndpoint2xx: true,
    savedAndReloaded: true,
    identityVerified: true,
  };
}
