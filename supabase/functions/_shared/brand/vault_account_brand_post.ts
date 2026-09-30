/**
 * Stage 3B: scheduled brand_post publishing for Vault-backed accounts other than
 * AI Lab (which keeps its own reviewed dispatcher) and Kabumori (legacy path).
 *
 * Every gate runs before any generation or X call:
 *   - approved code profile only (today: social_mobile_user_v1); a profile not
 *     reviewed for live publishing fails closed, so neither Kabumori's nor AI
 *     Lab's persona can be reached from here;
 *   - the exact social account resolved for the running post (the database has
 *     already re-derived it from the post's brand) must be the brand's own X
 *     account;
 *   - admin authority: brand live, `brand_post` enabled in brand_settings,
 *     account publish_enabled (assertBrandPublishAllowed);
 *   - publish authority: check_x_account_publish_authority in the database
 *     (explicit per-account enabled window, off/revoked, consent, admin state,
 *     exact account) — called before generation AND again immediately before
 *     the X create, so expiry/revocation stops new posts even while the access
 *     token is still valid. Stage 3A rollout remains the refresh authority only;
 *   - user consent: the brand's own content settings must choose
 *     approvalMode = 'auto_post_preference'. Missing table/row/'manual_review'
 *     never publishes.
 * The text is generated with the user's settings, bounded by a publish length
 * policy, checked against the user's NG words and cross-brand duplicates, then
 * sent once through the caller's exact-account X port and completed by
 * complete_vault_account_brand_post (this account, this post only).
 */
import { type BrandContext, BrandContextError } from "./brand_context.ts";
import { assertBrandPublishAllowed } from "./publish_guard.ts";
import { checkCrossBrandDuplicate, fingerprintText, type PublishedFingerprint } from "./cross_brand_dedupe.ts";
import { type BrandPostDraft, generateBrandPost } from "./brand_post_generator.ts";
import { assertPostWithinLengthPolicy, type PostLengthPolicy } from "./post_length_policy.ts";
import {
  materializeSocialMobilePersonaProfile,
  normalizeSocialMobileContentSettings,
  type SocialMobileContentSettings,
} from "./social_mobile_content_settings.ts";

/** Brands with their own reviewed publish paths; never routed here. */
const SPECIALIZED_BRAND_IDS: ReadonlySet<string> = new Set(["kabumori", "ai_salaryman_lab"]);
/** Code profiles reviewed for live publishing through this path. */
export const VAULT_ACCOUNT_PUBLISH_PROFILES: ReadonlySet<string> = new Set(["social_mobile_user_v1"]);
/** 140 code points keeps an all-Japanese post inside X's 280 weighted-character limit. */
export const VAULT_ACCOUNT_PUBLISH_LENGTH_POLICY: PostLengthPolicy = { mode: "limited", maxChars: 140 };

export class VaultAccountConfirmedPostCompletionError extends Error {
  constructor() {
    super("VAULT_BRAND_POST_CONFIRMED_COMPLETION_UNCONFIRMED");
    this.name = "VaultAccountConfirmedPostCompletionError";
  }
}

function xPostIdFrom(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const data = (response as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function assertWithinPublishLength(text: string): number {
  try {
    return assertPostWithinLengthPolicy(VAULT_ACCOUNT_PUBLISH_LENGTH_POLICY, text);
  } catch (error) {
    if (error instanceof Error && error.message === "POST_LENGTH_LIMIT_EXCEEDED") {
      throw new BrandContextError("VAULT_BRAND_POST_LENGTH_LIMIT_EXCEEDED");
    }
    throw error;
  }
}

export async function dispatchVaultAccountScheduledBrandPost({
  context,
  postType,
  scheduledPostId,
  socialAccountId,
  openAiApiKey,
  checkPublishAuthority,
  loadContentSettings,
  loadRecentFingerprints,
  publishText,
  completePublishedPost,
  generate = generateBrandPost,
}: {
  context: BrandContext;
  postType: string;
  scheduledPostId: string;
  /** The exact account the X port was bound to for this running post. */
  socialAccountId: string;
  openAiApiKey: string;
  /** check_x_account_publish_authority for this post/account/brand; throws a fixed code when not allowed. */
  checkPublishAuthority: () => Promise<void>;
  loadContentSettings: () => Promise<SocialMobileContentSettings | null>;
  loadRecentFingerprints: () => Promise<PublishedFingerprint[]>;
  publishText: (text: string) => Promise<unknown>;
  completePublishedPost: (args: {
    scheduledPostId: string;
    socialAccountId: string;
    xPostId: string;
    normalizedTextSha256: string;
  }) => Promise<{ fingerprintPersisted: boolean }>;
  generate?: (args: {
    openAiApiKey: string;
    context: BrandContext;
    postType: string;
    contentSettings?: SocialMobileContentSettings;
  }) => Promise<BrandPostDraft>;
}): Promise<{
  brandId: string;
  socialAccountId: string;
  postType: "brand_post";
  characterCount: number;
  xPostId: string;
  fingerprintPersisted: boolean;
}> {
  if (SPECIALIZED_BRAND_IDS.has(context.brand.id)) {
    throw new BrandContextError("VAULT_BRAND_POST_BRAND_NOT_ELIGIBLE");
  }
  if (!VAULT_ACCOUNT_PUBLISH_PROFILES.has(context.codeProfile.key) || context.brand.code_profile_key !== context.codeProfile.key) {
    throw new BrandContextError("VAULT_BRAND_POST_PROFILE_NOT_APPROVED");
  }
  const account = context.socialAccount;
  if (!account || !socialAccountId || account.id !== socialAccountId || account.brand_id !== context.brand.id
      || account.platform !== "x") {
    throw new BrandContextError("VAULT_BRAND_POST_ACCOUNT_MISMATCH");
  }
  if (postType !== "brand_post" || !context.operationalSettings.enabled_post_types.includes("brand_post")) {
    throw new BrandContextError("VAULT_BRAND_POST_TYPE_NOT_ENABLED");
  }
  assertBrandPublishAllowed(context);
  // Publish authority before any generation cost.
  await checkPublishAuthority();

  const settings = await loadContentSettings();
  if (!settings || settings.approvalMode !== "auto_post_preference") {
    throw new BrandContextError("SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED");
  }

  const recentFingerprints = await loadRecentFingerprints();
  const publishContext: BrandContext = {
    ...context,
    codeProfile: { ...context.codeProfile, postLengthPolicy: VAULT_ACCOUNT_PUBLISH_LENGTH_POLICY },
  };
  const draft = await generate({ openAiApiKey, context: publishContext, postType, contentSettings: settings });
  if (draft.brandId !== context.brand.id || draft.postType !== "brand_post") {
    throw new BrandContextError("VAULT_BRAND_POST_GENERATION_CONTEXT_MISMATCH");
  }
  const characterCount = assertWithinPublishLength(draft.text);
  const lowered = draft.text.toLowerCase();
  if (settings.optionalNgWords.some((word) => word.trim() && lowered.includes(word.trim().toLowerCase()))) {
    throw new BrandContextError("VAULT_BRAND_POST_NG_WORD");
  }
  const duplicate = await checkCrossBrandDuplicate({
    brandId: context.brand.id,
    candidateText: draft.text,
    recentFingerprints,
  });
  if (duplicate.blocked) throw new BrandContextError("VAULT_BRAND_POST_CROSS_BRAND_DUPLICATE");

  const normalizedTextSha256 = await fingerprintText(draft.text);
  // Re-check publish authority immediately before the one X create: an expiry,
  // revocation, consent withdrawal or admin disable committed during generation
  // stops the post here. No transform may follow the final checks.
  await checkPublishAuthority();
  assertWithinPublishLength(draft.text);
  const xResponse = await publishText(draft.text);
  const xPostId = xPostIdFrom(xResponse);
  if (!xPostId) throw new Error("X_RESPONSE_MISSING_POST_ID");

  let completion: { fingerprintPersisted: boolean };
  try {
    completion = await completePublishedPost({ scheduledPostId, socialAccountId, xPostId, normalizedTextSha256 });
  } catch {
    // The X write is confirmed: never let the caller fail (and later replay) the row.
    throw new VaultAccountConfirmedPostCompletionError();
  }
  return {
    brandId: context.brand.id,
    socialAccountId,
    postType: "brand_post",
    characterCount,
    xPostId,
    fingerprintPersisted: completion.fingerprintPersisted,
  };
}

// --- PostgREST adapters -----------------------------------------------------------

function serviceHeaders(serviceRoleKey: string): Record<string, string> {
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, Accept: "application/json" };
}

/**
 * The brand's own content settings, read server-side. Returns null (= no
 * consent) when the table is not deployed or the brand has no row.
 */
export async function loadSocialMobileContentSettingsForPublish({
  supabaseUrl,
  serviceRoleKey,
  brandId,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandId: string;
  fetchImpl?: typeof fetch;
}): Promise<SocialMobileContentSettings | null> {
  const params = new URLSearchParams({
    select: "brand_id,settings,persona_profile,persona_provenance,persona_confirmed,persona_last_analyzed_at,persona_last_analyzed_count",
    brand_id: `eq.${brandId}`,
    limit: "1",
  });
  let response: Response;
  try {
    response = await fetchImpl(`${supabaseUrl.replace(/\/$/u, "")}/rest/v1/social_mobile_content_settings?${params}`, {
      headers: serviceHeaders(serviceRoleKey),
      redirect: "manual",
    });
  } catch {
    throw new BrandContextError("CONTENT_SETTINGS_READ_FAILED");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch { /* classified below */ }
  if (!response.ok) {
    const message = String((body as { message?: unknown } | null)?.message ?? "");
    if (response.status === 404 || (response.status === 400 && /relation|does not exist/iu.test(message))) return null;
    throw new BrandContextError("CONTENT_SETTINGS_READ_FAILED");
  }
  const row = Array.isArray(body) ? body[0] as Record<string, unknown> | undefined : undefined;
  if (!row) return null;
  if (row.brand_id !== brandId) throw new BrandContextError("CONTENT_SETTINGS_READ_FAILED");
  const settings = normalizeSocialMobileContentSettings(row.settings);
  const persona = materializeSocialMobilePersonaProfile(row.persona_profile, {
    provenance: row.persona_provenance,
    confirmed: row.persona_confirmed,
    analyzedAt: row.persona_last_analyzed_at,
    analyzedCount: row.persona_last_analyzed_count,
  });
  return persona ? { ...settings, personaProfile: persona } : settings;
}

export async function completeVaultAccountBrandPost({
  supabaseUrl,
  serviceRoleKey,
  scheduledPostId,
  socialAccountId,
  xPostId,
  normalizedTextSha256,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  scheduledPostId: string;
  socialAccountId: string;
  xPostId: string;
  normalizedTextSha256: string;
  fetchImpl?: typeof fetch;
}): Promise<{ fingerprintPersisted: boolean }> {
  const response = await fetchImpl(`${supabaseUrl.replace(/\/$/u, "")}/rest/v1/rpc/complete_vault_account_brand_post`, {
    method: "POST",
    headers: { ...serviceHeaders(serviceRoleKey), "Content-Type": "application/json" },
    redirect: "manual",
    body: JSON.stringify({
      p_scheduled_post_id: scheduledPostId,
      p_social_account_id: socialAccountId,
      p_x_post_id: xPostId,
      p_normalized_text_sha256: normalizedTextSha256,
    }),
  });
  if (!response.ok) throw new BrandContextError("VAULT_BRAND_POST_COMPLETION_RPC_FAILED");
  const payload = await response.json() as unknown;
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (typeof row !== "object" || row === null
      || typeof (row as Record<string, unknown>).fingerprint_persisted !== "boolean") {
    throw new BrandContextError("VAULT_BRAND_POST_COMPLETION_RPC_INVALID_RESPONSE");
  }
  return { fingerprintPersisted: (row as { fingerprint_persisted: boolean }).fingerprint_persisted };
}

/** check_x_account_publish_authority(post, account, brand): resolves only on 'allowed'. */
export async function checkVaultAccountPublishAuthority({
  supabaseUrl,
  serviceRoleKey,
  scheduledPostId,
  socialAccountId,
  brandId,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  scheduledPostId: string;
  socialAccountId: string;
  brandId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${supabaseUrl.replace(/\/$/u, "")}/rest/v1/rpc/check_x_account_publish_authority`, {
      method: "POST",
      headers: { ...serviceHeaders(serviceRoleKey), "Content-Type": "application/json" },
      redirect: "manual",
      body: JSON.stringify({ p_scheduled_post_id: scheduledPostId, p_social_account_id: socialAccountId, p_brand_id: brandId }),
    });
  } catch {
    throw new BrandContextError("VAULT_PUBLISH_AUTHORITY_UNAVAILABLE");
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch { /* classified below */ }
  if (!response.ok) {
    const message = (payload as { message?: unknown } | null)?.message;
    throw new BrandContextError(typeof message === "string" && /^[A-Z][A-Z0-9_]{1,99}$/u.test(message) ? message : "VAULT_PUBLISH_AUTHORITY_UNAVAILABLE");
  }
  if (payload !== "allowed") throw new BrandContextError("VAULT_PUBLISH_AUTHORITY_UNAVAILABLE");
}
