import { type BrandContext, BrandContextError } from "./brand_context.ts";
import { loadVaultBackedXTokens } from "./token_loader.ts";
import type { AiLabVaultTokenReference } from "./ai_lab_token_refresh.ts";

type SocialAccountVaultRow = {
  id?: unknown;
  brand_id?: unknown;
  platform?: unknown;
  handle?: unknown;
  publish_enabled?: unknown;
  oauth_client_ref?: unknown;
  connection_status?: unknown;
  vault_access_token_secret_id?: unknown;
  vault_refresh_token_secret_id?: unknown;
};

export type AiLabVaultTokenBundle = {
  tokens: { accessToken: string; refreshToken: string };
  tokenReference: AiLabVaultTokenReference;
};

function serviceHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function assertAiLabAccountContext(context: BrandContext): void {
  const account = context.socialAccount;
  if (
    context.brand.id !== "ai_salaryman_lab" ||
    !account ||
    account.id !== "ai_salaryman_lab_x" ||
    account.brand_id !== "ai_salaryman_lab" ||
    account.platform !== "x" ||
    account.handle !== "kaishain_ai_lab" ||
    account.oauth_client_ref !== "default"
  ) {
    throw new BrandContextError("AI_LAB_VAULT_ACCOUNT_MISMATCH");
  }
}

/** Loads AI Lab credentials only from the two Vault refs on its identity-verified social account. */
export async function loadAiLabVaultBackedXTokenBundle({
  context,
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}: {
  context: BrandContext;
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): Promise<AiLabVaultTokenBundle> {
  assertAiLabAccountContext(context);

  const params = new URLSearchParams({
    select:
      "id,brand_id,platform,handle,publish_enabled,oauth_client_ref,connection_status,vault_access_token_secret_id,vault_refresh_token_secret_id",
    id: "eq.ai_salaryman_lab_x",
    brand_id: "eq.ai_salaryman_lab",
    platform: "eq.x",
    limit: "1",
  });
  const response = await fetchImpl(
    `${supabaseUrl}/rest/v1/social_accounts?${params}`,
    { headers: serviceHeaders(serviceRoleKey) },
  );
  if (!response.ok) {
    throw new BrandContextError("AI_LAB_VAULT_ROUTING_READ_FAILED");
  }

  let rows: SocialAccountVaultRow[];
  try {
    rows = await response.json() as SocialAccountVaultRow[];
  } catch {
    throw new BrandContextError("AI_LAB_VAULT_ROUTING_READ_FAILED");
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (
    !row ||
    row.id !== "ai_salaryman_lab_x" ||
    row.brand_id !== "ai_salaryman_lab" ||
    row.platform !== "x" ||
    row.handle !== "kaishain_ai_lab" ||
    row.oauth_client_ref !== "default"
  ) {
    throw new BrandContextError("AI_LAB_VAULT_ACCOUNT_MISMATCH");
  }
  if (row.connection_status !== "identity_verified") {
    throw new BrandContextError("AI_LAB_X_IDENTITY_NOT_VERIFIED");
  }
  if (row.publish_enabled !== true) {
    throw new BrandContextError("BRAND_X_ACCOUNT_DISABLED");
  }

  const accessTokenSecretRef = row.vault_access_token_secret_id;
  const refreshTokenSecretRef = row.vault_refresh_token_secret_id;
  if (
    typeof accessTokenSecretRef !== "string" ||
    typeof refreshTokenSecretRef !== "string" ||
    !/^[0-9a-f-]{36}$/iu.test(accessTokenSecretRef) ||
    !/^[0-9a-f-]{36}$/iu.test(refreshTokenSecretRef)
  ) {
    throw new BrandContextError("BRAND_VAULT_TOKEN_NOT_CONFIGURED");
  }

  const tokenReference: AiLabVaultTokenReference = {
    socialAccountId: row.id as string,
    accessTokenSecretRef,
    refreshTokenSecretRef,
  };
  const tokens = await loadVaultBackedXTokens({
    context,
    tokenReference,
    vault: {
      async readSecret(reference) {
        let secretResponse: Response;
        try {
          secretResponse = await fetchImpl(
            `${supabaseUrl}/rest/v1/rpc/read_ai_salaryman_lab_x_vault_token`,
            {
              method: "POST",
              headers: serviceHeaders(serviceRoleKey),
              body: JSON.stringify({ p_vault_secret_id: reference }),
            },
          );
        } catch {
          throw new BrandContextError("AI_LAB_VAULT_SECRET_READ_FAILED");
        }
        if (!secretResponse.ok) {
          throw new BrandContextError("AI_LAB_VAULT_SECRET_READ_FAILED");
        }
        let payload: unknown;
        try {
          payload = await secretResponse.json();
        } catch {
          throw new BrandContextError("AI_LAB_VAULT_SECRET_READ_FAILED");
        }
        const secretRow = Array.isArray(payload) ? payload[0] : payload;
        if (typeof secretRow !== "object" || secretRow === null) return null;
        const value = (secretRow as Record<string, unknown>).token_value;
        return typeof value === "string" && value.length > 0 ? value : null;
      },
    },
  });
  return { tokens, tokenReference };
}

export async function loadAiLabVaultBackedXTokens(args: {
  context: BrandContext;
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; refreshToken: string }> {
  const bundle = await loadAiLabVaultBackedXTokenBundle(args);
  return bundle.tokens;
}
