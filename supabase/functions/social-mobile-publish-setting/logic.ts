// SOURCE CANDIDATE. Not deployed; independent review is mandatory before deploy.
//
// Per-account automatic-publishing ON/OFF for the social-mobile app. The one thing this function may
// change is public.social_accounts.publish_enabled of one exact account, by compare-and-set. It makes
// no X API call, reads no Vault plaintext and touches nothing else (no connection state, credentials,
// scheduled posts, logs, content settings, Auth or Cron). Platform JWT verification must stay ON.
//
// Authority: the caller's identity comes only from the Auth server. The account's own brand_id (read
// server-side by exact account id) decides which membership applies; a client-supplied brand id is
// neither accepted nor used. Only owner/admin of that exact brand may switch it.

export type PublishSettingErrorCode =
  | "METHOD_NOT_ALLOWED"
  | "AUTH_REQUIRED"
  | "REQUEST_INVALID"
  | "ACCOUNT_NOT_FOUND"
  | "PUBLISH_CONTROL_FORBIDDEN"
  | "STALE_STATE"
  | "PLATFORM_NOT_SUPPORTED"
  | "BRAND_INACTIVE"
  | "BRAND_PUBLISHING_NOT_LIVE"
  | "CONNECTION_NOT_VERIFIED"
  | "CONNECTION_DEGRADED"
  | "CREDENTIALS_MISSING"
  | "ACCOUNT_BUSY"
  | "PUBLISH_SETTING_UNAVAILABLE";

export class PublishSettingError extends Error {
  constructor(
    readonly code: PublishSettingErrorCode,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "PublishSettingError";
  }
}

/** What the server knows about the exact account. Vault references are reduced to presence booleans. */
export type AccountRow = {
  id: string;
  brand_id: string;
  platform: string;
  connection_status: string;
  platform_user_id: string | null;
  verified_at: string | null;
  last_connection_error_code: string | null;
  publish_enabled: boolean;
  has_access_secret_ref: boolean;
  has_refresh_secret_ref: boolean;
};

export type BrandRow = {
  id: string;
  is_active: boolean;
  publish_mode: string;
};

export type CompareAndSetResult = "updated" | "no_match" | "busy";

export type PublishSettingDeps = {
  /** Verified Auth user for this bearer token, or null if the token is not valid. */
  getUser(token: string): Promise<{ id: string } | null>;
  readAccount(accountId: string): Promise<AccountRow | null>;
  readBrand(brandId: string): Promise<BrandRow | null>;
  /** The caller's own membership role for exactly this brand (read with the caller's JWT), or null. */
  readMembershipRole(token: string, userId: string, brandId: string): Promise<string | null>;
  /**
   * One conditional UPDATE of publish_enabled only: it matches only when the exact account still has
   * `expected`; for enabling it must also still satisfy the readiness conditions.
   */
  compareAndSetPublishEnabled(input: {
    accountId: string;
    brandId: string;
    expected: boolean;
    desired: boolean;
    requireReadiness: boolean;
  }): Promise<CompareAndSetResult>;
};

export const ALLOWED_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
export const VERIFIED_CONNECTION_STATUS = "identity_verified";
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const MAX_BODY_CHARS = 1024;
const BODY_KEYS = ["social_account_id", "desired_enabled", "expected_current_enabled"] as const;

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
};

function respond(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function bearerToken(request: Request): string {
  const match = /^Bearer\s+(.+)$/iu.exec(request.headers.get("Authorization")?.trim() ?? "");
  const token = match?.[1]?.trim();
  if (!token) throw new PublishSettingError("AUTH_REQUIRED", 401);
  return token;
}

export type PublishSettingRequest = {
  socialAccountId: string;
  desiredEnabled: boolean;
  expectedCurrentEnabled: boolean;
};

/** Exactly three fields; anything else (including a client-supplied brand id) is rejected, not ignored. */
export function parsePublishSettingBody(raw: unknown): PublishSettingRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PublishSettingError("REQUEST_INVALID", 400);
  }
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== BODY_KEYS.length || !BODY_KEYS.every((key) => keys.includes(key))) {
    throw new PublishSettingError("REQUEST_INVALID", 400);
  }
  const { social_account_id, desired_enabled, expected_current_enabled } = body;
  if (
    typeof social_account_id !== "string" || !ACCOUNT_ID_PATTERN.test(social_account_id) ||
    typeof desired_enabled !== "boolean" || typeof expected_current_enabled !== "boolean"
  ) {
    throw new PublishSettingError("REQUEST_INVALID", 400);
  }
  return {
    socialAccountId: social_account_id,
    desiredEnabled: desired_enabled,
    expectedCurrentEnabled: expected_current_enabled,
  };
}

async function readBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;.*)?$/iu.test(contentType.trim())) {
    throw new PublishSettingError("REQUEST_INVALID", 400);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new PublishSettingError("REQUEST_INVALID", 400);
  }
  if (text.length === 0 || text.length > MAX_BODY_CHARS) throw new PublishSettingError("REQUEST_INVALID", 400);
  try {
    return JSON.parse(text);
  } catch {
    throw new PublishSettingError("REQUEST_INVALID", 400);
  }
}

/**
 * Turning publishing ON lets future scheduled work really post, so it is checked against everything the
 * posting pipeline itself requires. A failure returns a bounded code (never credential details); the
 * connection/credential codes also say a reconnect is the way forward. Turning OFF never reaches here.
 */
export function enablePrerequisiteFailure(account: AccountRow, brand: BrandRow | null): PublishSettingError | null {
  if (account.platform !== "x") return new PublishSettingError("PLATFORM_NOT_SUPPORTED", 409);
  if (!brand || brand.id !== account.brand_id || brand.is_active !== true) {
    return new PublishSettingError("BRAND_INACTIVE", 409);
  }
  if (brand.publish_mode !== "live") return new PublishSettingError("BRAND_PUBLISHING_NOT_LIVE", 409);
  if (
    account.connection_status !== VERIFIED_CONNECTION_STATUS || !account.platform_user_id || !account.verified_at
  ) {
    return new PublishSettingError("CONNECTION_NOT_VERIFIED", 409, { reconnect_recommended: true });
  }
  if (!account.has_access_secret_ref || !account.has_refresh_secret_ref) {
    return new PublishSettingError("CREDENTIALS_MISSING", 409, { reconnect_recommended: true });
  }
  if (account.last_connection_error_code) {
    return new PublishSettingError("CONNECTION_DEGRADED", 409, { reconnect_recommended: true });
  }
  return null;
}

export async function handlePublishSetting(request: Request, deps: PublishSettingDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return respond({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const token = bearerToken(request);
    const user = await deps.getUser(token);
    if (!user || !user.id) throw new PublishSettingError("AUTH_REQUIRED", 401);
    const input = parsePublishSettingBody(await readBody(request));

    // A missing account and an account of a brand the caller does not belong to look identical, so the
    // response does not reveal which account ids exist.
    const account = await deps.readAccount(input.socialAccountId);
    if (!account) throw new PublishSettingError("ACCOUNT_NOT_FOUND", 404);
    const role = await deps.readMembershipRole(token, user.id, account.brand_id);
    if (role === null) throw new PublishSettingError("ACCOUNT_NOT_FOUND", 404);
    if (!ALLOWED_ROLES.has(role)) throw new PublishSettingError("PUBLISH_CONTROL_FORBIDDEN", 403);

    // Stale-state protection first: the person confirmed a change against what they saw.
    if (account.publish_enabled !== input.expectedCurrentEnabled) {
      throw new PublishSettingError("STALE_STATE", 409, { current_enabled: account.publish_enabled });
    }
    // Same state requested: nothing to write, answered deterministically.
    if (input.desiredEnabled === account.publish_enabled) {
      return respond({
        success: true,
        status: "unchanged",
        account: { id: account.id, publish_enabled: account.publish_enabled },
      }, 200);
    }

    if (input.desiredEnabled) {
      const brand = await deps.readBrand(account.brand_id);
      const failure = enablePrerequisiteFailure(account, brand);
      if (failure) throw failure;
    }

    const result = await deps.compareAndSetPublishEnabled({
      accountId: account.id,
      brandId: account.brand_id,
      expected: input.expectedCurrentEnabled,
      desired: input.desiredEnabled,
      requireReadiness: input.desiredEnabled,
    });
    if (result === "busy") throw new PublishSettingError("ACCOUNT_BUSY", 409);
    if (result === "no_match") {
      // Zero rows is never success: re-read to say what changed underneath.
      const latest = await deps.readAccount(account.id);
      if (!latest) throw new PublishSettingError("ACCOUNT_NOT_FOUND", 404);
      if (latest.publish_enabled !== input.expectedCurrentEnabled) {
        throw new PublishSettingError("STALE_STATE", 409, { current_enabled: latest.publish_enabled });
      }
      // Same state as expected but still no match: when enabling, the readiness conditions that are
      // part of the write no longer hold (e.g. the connection just failed); when disabling there is
      // no such condition, so this is unexpected and reported as unavailable, never as success.
      if (!input.desiredEnabled) throw new PublishSettingError("PUBLISH_SETTING_UNAVAILABLE", 503);
      throw new PublishSettingError("CONNECTION_NOT_VERIFIED", 409, { reconnect_recommended: true });
    }
    return respond({
      success: true,
      status: "updated",
      account: { id: account.id, publish_enabled: input.desiredEnabled },
    }, 200);
  } catch (error) {
    if (error instanceof PublishSettingError) {
      return respond({ success: false, error: error.code, ...error.extra }, error.status);
    }
    return respond({ success: false, error: "PUBLISH_SETTING_UNAVAILABLE" }, 503);
  }
}
