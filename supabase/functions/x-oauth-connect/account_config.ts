import { BrandContextError } from "../_shared/brand/brand_context.ts";

export type OAuthAccountConfig = {
  brandId: "ai_salaryman_lab" | "kabumori";
  socialAccountId: "ai_salaryman_lab_x" | "kabumori_x";
  expectedHandle: "kaishain_ai_lab" | "yume_daka";
  scopes: string;
  publishMode: "dry_run" | "live";
  publishEnabled: boolean;
  beginRpc: string;
  consumeRpc: string;
  completeRpc: string;
  tokenDestination: "vault" | "legacy_store";
};

const AI_LAB: OAuthAccountConfig = {
  brandId: "ai_salaryman_lab",
  socialAccountId: "ai_salaryman_lab_x",
  expectedHandle: "kaishain_ai_lab",
  scopes: "tweet.read users.read offline.access",
  publishMode: "dry_run",
  publishEnabled: false,
  beginRpc: "begin_ai_salaryman_lab_oauth_connection",
  consumeRpc: "consume_ai_salaryman_lab_oauth_state",
  completeRpc: "complete_ai_salaryman_lab_oauth_connection",
  tokenDestination: "vault",
};

const KABUMORI: OAuthAccountConfig = {
  brandId: "kabumori",
  socialAccountId: "kabumori_x",
  expectedHandle: "yume_daka",
  scopes: "tweet.read users.read tweet.write media.write offline.access",
  publishMode: "live",
  publishEnabled: true,
  beginRpc: "begin_kabumori_oauth_recovery",
  consumeRpc: "consume_kabumori_oauth_recovery_state",
  completeRpc: "complete_kabumori_oauth_recovery",
  tokenDestination: "legacy_store",
};

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/u, "").toLowerCase();
}

export function resolveOAuthStartConfig(handle: string): OAuthAccountConfig {
  const normalized = normalizeHandle(handle);
  if (normalized === AI_LAB.expectedHandle) return AI_LAB;
  if (normalized === KABUMORI.expectedHandle) return KABUMORI;
  throw new BrandContextError("OAUTH_HANDLE_NOT_ALLOWED");
}

export function resolveOAuthCallbackConfig(
  socialAccountId: string,
  brandId: string,
): OAuthAccountConfig {
  if (
    socialAccountId === AI_LAB.socialAccountId && brandId === AI_LAB.brandId
  ) return AI_LAB;
  if (
    socialAccountId === KABUMORI.socialAccountId && brandId === KABUMORI.brandId
  ) return KABUMORI;
  throw new BrandContextError("OAUTH_STATE_ACCOUNT_NOT_ALLOWED");
}
