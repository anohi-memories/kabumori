// Phase 3G: read-only, no-secret proof of the intended live routing --
//   brand_id -> social_account row -> Vault access_token/refresh_token secret REFERENCES.
//
// This module never decrypts a Vault secret and has no code path that could: it only reads
// social_accounts (id, handle, oauth_client_ref, connection_status, and the two Vault secret *id*
// columns, which are opaque uuid references, not the secret values themselves) and reports whether each
// reference is present. It never touches the legacy Kabumori credential table either, so
// legacyFallbackUsed is always `false` by construction, not by runtime check.
import { BrandContextError, type BrandContext } from "./brand_context.ts";

export type VaultTokenRoutingMetadata = {
  brandId: string;
  socialAccountId: string;
  handle: string;
  oauthClientRef: string;
  connectionStatus: string | null;
  accessTokenRefPresent: boolean;
  refreshTokenRefPresent: boolean;
  tokenSource: "vault_backed_social_account";
  legacyFallbackUsed: false;
};

function supabaseHeaders(serviceRoleKey: string): Record<string, string> {
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
}

export async function resolveVaultTokenRoutingMetadata({
  context,
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}: {
  context: BrandContext;
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): Promise<VaultTokenRoutingMetadata> {
  if (!context.socialAccount) {
    throw new BrandContextError("BRAND_SOCIAL_ACCOUNT_NOT_CONFIGURED");
  }
  const params = new URLSearchParams({
    select: "id,handle,oauth_client_ref,connection_status,vault_access_token_secret_id,vault_refresh_token_secret_id",
    id: `eq.${context.socialAccount.id}`,
    brand_id: `eq.${context.brand.id}`,
    limit: "1",
  });
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/social_accounts?${params}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!response.ok) throw new BrandContextError("BRAND_VAULT_ROUTING_READ_FAILED");
  const rows = await response.json() as Array<{
    id: string;
    handle: string;
    oauth_client_ref: string;
    connection_status: string | null;
    vault_access_token_secret_id: string | null;
    vault_refresh_token_secret_id: string | null;
  }>;
  const row = rows[0];
  if (!row) throw new BrandContextError("BRAND_SOCIAL_ACCOUNT_NOT_FOUND");
  if (row.id !== context.socialAccount.id) {
    // Defense-in-depth: the query is already scoped by id+brand_id, so this can only fire if the REST
    // layer itself returned a mismatched row -- fail closed rather than trust an unexpected shape.
    throw new BrandContextError("BRAND_VAULT_ACCOUNT_MISMATCH");
  }

  return {
    brandId: context.brand.id,
    socialAccountId: row.id,
    handle: row.handle,
    oauthClientRef: row.oauth_client_ref,
    connectionStatus: row.connection_status,
    accessTokenRefPresent: typeof row.vault_access_token_secret_id === "string" && row.vault_access_token_secret_id.length > 0,
    refreshTokenRefPresent: typeof row.vault_refresh_token_secret_id === "string" && row.vault_refresh_token_secret_id.length > 0,
    tokenSource: "vault_backed_social_account",
    legacyFallbackUsed: false,
  };
}
