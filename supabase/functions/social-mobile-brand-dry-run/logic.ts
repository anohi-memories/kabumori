import {
  BrandContextError,
  type BrandOperationalSettings,
  type BrandRecord,
  resolveBrandContext,
} from "../_shared/brand/brand_context.ts";
import {
  type BrandPostDraft,
  generateBrandPost,
} from "../_shared/brand/brand_post_generator.ts";
import { resolveBrandCodeProfile } from "../_shared/brand/brand_profiles.ts";
import {
  SOCIAL_MOBILE_USER_DEFAULTS,
  materializeSocialMobilePersonaProfile,
  normalizeSocialMobileContentSettings,
  type SocialMobileContentSettings,
} from "../_shared/brand/social_mobile_content_settings.ts";

const PROFILE_KEY = "social_mobile_user_v1";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type UserScopedBrand = {
  id: string;
  display_name: string;
  is_active: boolean;
  publish_mode: "disabled" | "dry_run" | "live";
  code_profile_key: string;
};
type UserScopedAccount = {
  id: string;
  brand_id: string;
  platform: string;
  handle: string;
  connection_status: string;
};
type PreviewDraft = Pick<BrandPostDraft, "text" | "model" | "characterCount">;
type PreviewGenerator = (input: {
  context: ReturnType<typeof resolveBrandContext>;
  settings: SocialMobileContentSettings;
  openAiApiKey: string;
}) => Promise<PreviewDraft>;

type PersistedSettingsRow = {
  settings?: unknown;
  persona_profile?: unknown;
  persona_provenance?: unknown;
  persona_confirmed?: unknown;
  persona_last_analyzed_at?: unknown;
  persona_last_analyzed_count?: unknown;
};

export class SocialMobilePreviewError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "SocialMobilePreviewError";
  }
}

export type SocialMobilePreviewDependencies = {
  supabaseUrl: string;
  publishableKey: string;
  openAiApiKey: string;
  fetchImpl?: typeof fetch;
  settings?: SocialMobileContentSettings;
  generate?: PreviewGenerator;
};

function respond(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function bearerToken(request: Request): string {
  const match = /^Bearer\s+(.+)$/iu.exec(
    request.headers.get("Authorization")?.trim() ?? "",
  );
  if (!match?.[1]?.trim()) {
    throw new SocialMobilePreviewError("AUTH_REQUIRED", 401);
  }
  return match[1].trim();
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restUrl(
  supabaseUrl: string,
  table: string,
  filters: Record<string, string>,
): string {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl);
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function getUser(
  token: string,
  deps: SocialMobilePreviewDependencies,
  fetchImpl: typeof fetch,
): Promise<{ id: string }> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${deps.supabaseUrl.replace(/\/$/u, "")}/auth/v1/user`,
      {
        method: "GET",
        headers: {
          apikey: deps.publishableKey,
          Authorization: `Bearer ${token}`,
        },
      },
    );
  } catch {
    throw new SocialMobilePreviewError("AUTH_VERIFICATION_UNAVAILABLE", 503);
  }
  const body = await readJson(response);
  if (
    !response.ok || !isRecord(body) || typeof body.id !== "string" || !body.id
  ) {
    throw new SocialMobilePreviewError("AUTH_REQUIRED", 401);
  }
  return { id: body.id };
}

async function readRows<T>(
  table: string,
  filters: Record<string, string>,
  token: string,
  deps: SocialMobilePreviewDependencies,
  fetchImpl: typeof fetch,
): Promise<T[]> {
  let response: Response;
  try {
    response = await fetchImpl(restUrl(deps.supabaseUrl, table, filters), {
      method: "GET",
      headers: {
        apikey: deps.publishableKey,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch {
    throw new SocialMobilePreviewError("WORKSPACE_READ_UNAVAILABLE", 503);
  }
  const body = await readJson(response);
  if (!response.ok || !Array.isArray(body)) {
    throw new SocialMobilePreviewError("WORKSPACE_READ_UNAVAILABLE", 503);
  }
  return body as T[];
}

async function readOptionalPersistedSettings(
  brandId: string,
  token: string,
  deps: SocialMobilePreviewDependencies,
  fetchImpl: typeof fetch,
): Promise<SocialMobileContentSettings> {
  let response: Response;
  try {
    response = await fetchImpl(restUrl(deps.supabaseUrl, "social_mobile_content_settings", {
      select: "settings,persona_profile,persona_provenance,persona_confirmed,persona_last_analyzed_at,persona_last_analyzed_count",
      brand_id: `eq.${brandId}`,
      limit: "1",
    }), {
      method: "GET",
      headers: {
        apikey: deps.publishableKey,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch {
    // Phase 12 default behavior remains safe if the candidate table is not yet deployed.
    return SOCIAL_MOBILE_USER_DEFAULTS;
  }
  if (response.status === 404 || response.status === 406) return SOCIAL_MOBILE_USER_DEFAULTS;
  const body = await readJson(response);
  if (!response.ok) {
    // A missing table/column is an expected pre-rollout state; other failures fail closed.
    if (response.status === 400 && typeof body === "object" && body !== null) {
      const message = String((body as { message?: unknown }).message ?? "");
      if (/relation|column|does not exist/iu.test(message)) return SOCIAL_MOBILE_USER_DEFAULTS;
    }
    throw new SocialMobilePreviewError("CONTENT_SETTINGS_READ_UNAVAILABLE", 503);
  }
  const row = Array.isArray(body) ? body[0] as PersistedSettingsRow | undefined : undefined;
  if (!row) return SOCIAL_MOBILE_USER_DEFAULTS;
  const settings = normalizeSocialMobileContentSettings(row.settings);
  const persona = materializeSocialMobilePersonaProfile(row.persona_profile, {
    provenance: row.persona_provenance,
    confirmed: row.persona_confirmed,
    analyzedAt: row.persona_last_analyzed_at,
    analyzedCount: row.persona_last_analyzed_count,
  });
  return persona ? { ...settings, personaProfile: persona } : settings;
}

function parseRequestedBrandId(body: unknown): string | null {
  if (!isRecord(body)) {
    throw new SocialMobilePreviewError("REQUEST_BODY_INVALID", 400);
  }
  if (
    body.brand_id === undefined || body.brand_id === null ||
    body.brand_id === ""
  ) return null;
  if (typeof body.brand_id !== "string" || body.brand_id.length > 80) {
    throw new SocialMobilePreviewError("REQUEST_BODY_INVALID", 400);
  }
  return body.brand_id;
}

async function defaultGenerate(
  { context, settings, openAiApiKey }: Parameters<PreviewGenerator>[0],
): Promise<PreviewDraft> {
  const draft = await generateBrandPost({
    openAiApiKey,
    context,
    postType: "brand_post",
    generationPurpose: "social_mobile_preview",
    contentSettings: settings,
  });
  return {
    text: draft.text,
    model: draft.model,
    characterCount: draft.characterCount,
  };
}

/** A user-JWT-only, read-only preview path. It deliberately has no schedule, token, or publish adapter. */
export async function handleSocialMobileBrandDryRun(
  request: Request,
  deps: SocialMobilePreviewDependencies,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return respond({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    if (!deps.supabaseUrl || !deps.publishableKey) {
      throw new SocialMobilePreviewError(
        "PREVIEW_CONFIGURATION_UNAVAILABLE",
        503,
      );
    }
    const token = bearerToken(request);
    const fetchImpl = deps.fetchImpl ?? fetch;
    const user = await getUser(token, deps, fetchImpl);
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      throw new SocialMobilePreviewError("REQUEST_BODY_INVALID", 400);
    }
    const requestedBrandId = parseRequestedBrandId(input);

    // The user ID is obtained only from a verified Auth user, and the self-membership RLS policy is
    // applied with that same user's JWT. A client-supplied brand_id is a selector, never authority.
    const memberships = await readRows<{ brand_id?: unknown; role?: unknown }>(
      "brand_memberships",
      {
        select: "brand_id,role",
        user_id: `eq.${user.id}`,
        role: "eq.owner",
      },
      token,
      deps,
      fetchImpl,
    );
    const ownedBrandIds = [
      ...new Set(
        memberships.flatMap((row) =>
          typeof row.brand_id === "string" && row.role === "owner"
            ? [row.brand_id]
            : []
        ),
      ),
    ];
    if (requestedBrandId) {
      if (!ownedBrandIds.includes(requestedBrandId)) {
        throw new SocialMobilePreviewError("OWNED_WORKSPACE_NOT_FOUND", 404);
      }
    } else if (ownedBrandIds.length !== 1) {
      throw new SocialMobilePreviewError(
        ownedBrandIds.length === 0
          ? "OWNED_WORKSPACE_NOT_FOUND"
          : "WORKSPACE_SELECTION_REQUIRED",
        ownedBrandIds.length === 0 ? 404 : 409,
      );
    }
    const brandId = requestedBrandId ?? ownedBrandIds[0];

    const brands = await readRows<UserScopedBrand>(
      "brands",
      {
        select: "id,display_name,is_active,publish_mode,code_profile_key",
        id: `eq.${brandId}`,
        limit: "1",
      },
      token,
      deps,
      fetchImpl,
    );
    const brandRow = brands[0];
    if (!brandRow || brandRow.id !== brandId) {
      throw new SocialMobilePreviewError("OWNED_WORKSPACE_NOT_FOUND", 404);
    }
    if (
      brandRow.code_profile_key !== PROFILE_KEY ||
      !resolveBrandCodeProfile(brandRow.code_profile_key)
    ) {
      throw new SocialMobilePreviewError(
        "SOCIAL_MOBILE_PROFILE_NOT_CONFIGURED",
        409,
      );
    }

    const accounts = await readRows<UserScopedAccount>(
      "social_accounts",
      {
        select: "id,brand_id,platform,handle,connection_status",
        brand_id: `eq.${brandId}`,
        platform: "eq.x",
        limit: "2",
      },
      token,
      deps,
      fetchImpl,
    );
    const connectedAccounts = accounts.filter((account) =>
      account.brand_id === brandId && account.platform === "x" &&
      account.connection_status === "identity_verified" &&
      typeof account.handle === "string" && account.handle.trim().length > 0
    );
    if (connectedAccounts.length !== 1 || accounts.length !== 1) {
      throw new SocialMobilePreviewError(
        "SOCIAL_MOBILE_X_ACCOUNT_NOT_CONFIGURED",
        409,
      );
    }

    if (
      typeof brandRow.display_name !== "string" ||
      typeof brandRow.is_active !== "boolean" ||
      !["disabled", "dry_run", "live"].includes(brandRow.publish_mode)
    ) {
      throw new SocialMobilePreviewError("OWNED_WORKSPACE_NOT_CONFIGURED", 409);
    }
    const brand: BrandRecord = {
      id: brandRow.id,
      display_name: brandRow.display_name.trim() || "My Workspace",
      is_active: brandRow.is_active,
      publish_mode: brandRow.publish_mode,
      code_profile_key: brandRow.code_profile_key,
    };
    // brand_settings is an admin-owned operational table. A user preview uses explicit conservative
    // code defaults instead of bypassing its RLS or reading another workspace's settings.
    const operationalSettings: BrandOperationalSettings = {
      brand_id: brandId,
      fixed_hashtags: [],
      note_url: null,
      image_policy: { mode: "none" },
      enabled_post_types: ["brand_post"],
    };
    const context = resolveBrandContext(brand, null, operationalSettings);
    const settings = deps.settings ?? await readOptionalPersistedSettings(brandId, token, deps, fetchImpl);
    const generate = deps.generate ?? defaultGenerate;
    let draft: PreviewDraft;
    try {
      if (!deps.openAiApiKey && !deps.generate) {
        throw new SocialMobilePreviewError(
          "PREVIEW_GENERATION_UNAVAILABLE",
          503,
        );
      }
      draft = await generate({
        context,
        settings,
        openAiApiKey: deps.openAiApiKey,
      });
    } catch (error) {
      if (error instanceof SocialMobilePreviewError) throw error;
      throw new SocialMobilePreviewError("PREVIEW_GENERATION_FAILED", 502);
    }
    if (!draft.text.trim()) {
      throw new SocialMobilePreviewError("PREVIEW_GENERATION_FAILED", 502);
    }

    return respond({
      success: true,
      status: "preview_ready",
      preview_only: true,
      workspace: { brand_id: brand.id, display_name: brand.display_name },
      connected_account: {
        platform: "x",
        handle: `@${connectedAccounts[0].handle.replace(/^@/u, "")}`,
      },
      draft: {
        text: draft.text,
        model: draft.model,
        character_count: draft.characterCount,
      },
      planning_defaults: {
        frequency_target_per_week: settings.frequencyTargetPerWeek,
        approval_mode: settings.approvalMode,
        live_publishing_enabled: false,
        generation_window: settings.generationWindow,
      },
      publish_attempted: false,
      x_api_called: false,
      scheduled_post_created: false,
    });
  } catch (error) {
    if (error instanceof SocialMobilePreviewError) {
      return respond({
        success: false,
        status: error.status === 404 || error.status === 409
          ? "not_configured"
          : "generation_error",
        error: error.code,
      }, error.status);
    }
    if (error instanceof BrandContextError) {
      return respond({
        success: false,
        status: "not_configured",
        error: "SOCIAL_MOBILE_PROFILE_NOT_CONFIGURED",
      }, 409);
    }
    return respond({
      success: false,
      status: "generation_error",
      error: "PREVIEW_REQUEST_FAILED",
    }, 500);
  }
}
