import {
  resolveBrandCodeProfile,
  type BrandCodeProfile,
} from "./brand_profiles.ts";

export const LEGACY_KABUMORI_BRAND_ID = "kabumori";

export type BrandPublishMode = "disabled" | "dry_run" | "live";

export type BrandRecord = {
  id: string;
  display_name: string;
  is_active: boolean;
  publish_mode: BrandPublishMode;
  code_profile_key: string;
};

export type SocialAccountRecord = {
  id: string;
  brand_id: string;
  platform: "x";
  handle: string;
  publish_enabled: boolean;
  oauth_client_ref: string;
  platform_user_id?: string | null;
};

export type BrandOperationalSettings = {
  brand_id: string;
  fixed_hashtags: string[];
  note_url: string | null;
  image_policy: Record<string, unknown>;
  enabled_post_types: string[];
};

export type BrandContext = {
  brand: BrandRecord;
  socialAccount: SocialAccountRecord | null;
  codeProfile: BrandCodeProfile;
  operationalSettings: BrandOperationalSettings;
};

export class BrandContextError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "BrandContextError";
  }
}

export function brandIdFromScheduledRow(value: unknown): string {
  // Rows written before Phase 2 do not carry brand_id in a stale PostgREST
  // schema cache. Treat those rows as the one existing Kabumori brand.
  return typeof value === "string" && value.length > 0
    ? value
    : LEGACY_KABUMORI_BRAND_ID;
}

export function resolveBrandContext(
  brand: BrandRecord | null,
  socialAccount: SocialAccountRecord | null,
  operationalSettings: BrandOperationalSettings | null,
): BrandContext {
  if (!brand) throw new BrandContextError("BRAND_NOT_FOUND");
  const profile = resolveBrandCodeProfile(brand.code_profile_key);
  if (!profile) throw new BrandContextError("BRAND_CODE_PROFILE_NOT_FOUND");
  if (socialAccount && socialAccount.brand_id !== brand.id) {
    throw new BrandContextError("BRAND_SOCIAL_ACCOUNT_MISMATCH");
  }
  if (!operationalSettings || operationalSettings.brand_id !== brand.id) {
    throw new BrandContextError("BRAND_SETTINGS_NOT_FOUND");
  }
  return { brand, socialAccount, codeProfile: profile, operationalSettings };
}

function supabaseHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

export async function loadBrandContext({
  supabaseUrl,
  serviceRoleKey,
  brandId,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandId: string;
  fetchImpl?: typeof fetch;
}): Promise<BrandContext> {
  const brandParams = new URLSearchParams({
    select: "id,display_name,is_active,publish_mode,code_profile_key",
    id: `eq.${brandId}`,
    limit: "1",
  });
  const brandResponse = await fetchImpl(`${supabaseUrl}/rest/v1/brands?${brandParams}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!brandResponse.ok) throw new BrandContextError("BRAND_CONTEXT_READ_FAILED");
  const brands = await brandResponse.json() as BrandRecord[];
  const brand = brands[0] ?? null;
  if (!brand) throw new BrandContextError("BRAND_NOT_FOUND");

  const accountParams = new URLSearchParams({
    select: "id,brand_id,platform,handle,publish_enabled,oauth_client_ref,platform_user_id",
    brand_id: `eq.${brand.id}`,
    platform: "eq.x",
    limit: "1",
  });
  const accountResponse = await fetchImpl(`${supabaseUrl}/rest/v1/social_accounts?${accountParams}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!accountResponse.ok) throw new BrandContextError("BRAND_SOCIAL_ACCOUNT_READ_FAILED");
  const accounts = await accountResponse.json() as SocialAccountRecord[];
  const settingsParams = new URLSearchParams({
    select: "brand_id,fixed_hashtags,note_url,image_policy,enabled_post_types",
    brand_id: `eq.${brand.id}`,
    limit: "1",
  });
  const settingsResponse = await fetchImpl(`${supabaseUrl}/rest/v1/brand_settings?${settingsParams}`, {
    headers: supabaseHeaders(serviceRoleKey),
  });
  if (!settingsResponse.ok) throw new BrandContextError("BRAND_SETTINGS_READ_FAILED");
  const settings = await settingsResponse.json() as BrandOperationalSettings[];
  return resolveBrandContext(brand, accounts[0] ?? null, settings[0] ?? null);
}
