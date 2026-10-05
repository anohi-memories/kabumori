// SOURCE CANDIDATE. Not deployed; independent review is mandatory before deploy.
//
// Per-account automatic-publishing ON/OFF for the social-mobile app.
//
// This function decides nothing about who may switch what. It checks the request shape, confirms the
// bearer token with the Auth server, and then makes ONE call: the database function
// public.set_social_account_publish_enabled, with the CALLER'S OWN JWT. Inside that single transaction
// the database identifies the caller (auth.uid()), locks the account, its brand and the caller's current
// membership, and changes social_accounts.publish_enabled only if everything still holds
// (supabase/migrations/20261003090000_social_mobile_publish_permission_boundary.sql). There is no
// service-role key in this function, no table access, no second read after the decision, no X API call.
// Platform JWT verification must stay ON.

export type PublishSettingBlockedReason =
  | "PLATFORM_NOT_SUPPORTED"
  | "BRAND_INACTIVE"
  | "BRAND_PUBLISHING_NOT_LIVE"
  | "CONNECTION_NOT_VERIFIED"
  | "CONNECTION_DEGRADED"
  | "CREDENTIALS_MISSING"
  | "CREDENTIALS_INVALID";

export type PublishSettingErrorCode =
  | "METHOD_NOT_ALLOWED"
  | "AUTH_REQUIRED"
  | "REQUEST_INVALID"
  | "ACCOUNT_NOT_FOUND"
  | "PUBLISH_CONTROL_FORBIDDEN"
  | "STALE_STATE"
  | "ACCOUNT_BUSY"
  | "PUBLISH_SETTING_UNAVAILABLE"
  | PublishSettingBlockedReason;

export const BLOCKED_REASONS: ReadonlySet<string> = new Set<PublishSettingBlockedReason>([
  "PLATFORM_NOT_SUPPORTED",
  "BRAND_INACTIVE",
  "BRAND_PUBLISHING_NOT_LIVE",
  "CONNECTION_NOT_VERIFIED",
  "CONNECTION_DEGRADED",
  "CREDENTIALS_MISSING",
  "CREDENTIALS_INVALID",
]);

/** Blocked reasons for which reconnecting the X account is the way forward. */
const RECONNECT_REASONS: ReadonlySet<string> = new Set<PublishSettingBlockedReason>([
  "CONNECTION_NOT_VERIFIED",
  "CONNECTION_DEGRADED",
  "CREDENTIALS_MISSING",
  "CREDENTIALS_INVALID",
]);

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

export type PublishSettingRequest = {
  socialAccountId: string;
  desiredEnabled: boolean;
  expectedCurrentEnabled: boolean;
};

/** The database function's bounded answer (already shape-checked by the HTTP layer). */
export type PublishSettingDecision =
  | { status: "updated" | "unchanged" | "stale"; publishEnabled: boolean }
  | { status: "blocked"; reason: PublishSettingBlockedReason }
  | { status: "not_found" | "forbidden" | "busy" | "auth_required" | "invalid" };

export type PublishSettingDeps = {
  /** Verified Auth user for this bearer token, or null if the token is not valid. */
  getUser(token: string): Promise<{ id: string } | null>;
  /**
   * The one transactional decision, made by the database for the bearer of `token`. This function never
   * passes a user id or a brand id: the database derives both.
   */
  decide(token: string, request: PublishSettingRequest): Promise<PublishSettingDecision>;
};

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
/** Bytes, enforced while reading: the body is never buffered beyond this. */
export const MAX_BODY_BYTES = 512;
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

const invalid = () => new PublishSettingError("REQUEST_INVALID", 400);

function bearerToken(request: Request): string {
  const match = /^Bearer\s+(.+)$/iu.exec(request.headers.get("Authorization")?.trim() ?? "");
  const token = match?.[1]?.trim();
  if (!token) throw new PublishSettingError("AUTH_REQUIRED", 401);
  return token;
}

/** The parsed object must have exactly the three fields with exactly these types. */
export function parsePublishSettingBody(raw: unknown): PublishSettingRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid();
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== BODY_KEYS.length || !BODY_KEYS.every((key) => Object.hasOwn(body, key))) throw invalid();
  const { social_account_id, desired_enabled, expected_current_enabled } = body;
  if (
    typeof social_account_id !== "string" || !ACCOUNT_ID_PATTERN.test(social_account_id) ||
    typeof desired_enabled !== "boolean" || typeof expected_current_enabled !== "boolean"
  ) {
    throw invalid();
  }
  return {
    socialAccountId: social_account_id,
    desiredEnabled: desired_enabled,
    expectedCurrentEnabled: expected_current_enabled,
  };
}

/**
 * The raw JSON text must be unambiguous too. JSON.parse keeps the LAST of two duplicate keys, so
 * `{"desired_enabled":false,"desired_enabled":true,...}` would parse to ON. A valid body needs no
 * escape and contains exactly four strings (three keys and the account id, which cannot contain a
 * quote): no backslash and exactly eight double quotes means no key can occur twice, under any spelling.
 */
export function parsePublishSettingText(text: string): PublishSettingRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid();
  }
  const parsed = parsePublishSettingBody(raw);
  if (text.includes("\\") || (text.match(/"/gu)?.length ?? 0) !== 8) throw invalid();
  return parsed;
}

/** Reads at most MAX_BODY_BYTES; a longer body is refused without being read to the end. */
async function readBodyText(request: Request): Promise<string> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;.*)?$/iu.test(contentType.trim())) throw invalid();
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d{1,9}$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw invalid();
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw invalid();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PublishSettingError) throw error;
    throw invalid();
  }
  if (total === 0) throw invalid();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid();
  }
}

const unavailable = () => new PublishSettingError("PUBLISH_SETTING_UNAVAILABLE", 503);

export async function handlePublishSetting(request: Request, deps: PublishSettingDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return respond({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const token = bearerToken(request);
    const user = await deps.getUser(token);
    if (!user || !user.id) throw new PublishSettingError("AUTH_REQUIRED", 401);
    const input = parsePublishSettingText(await readBodyText(request));

    const decision = await deps.decide(token, input);
    switch (decision.status) {
      case "updated":
      case "unchanged":
        // Success only when the database confirms exactly the requested value.
        if (decision.publishEnabled !== input.desiredEnabled) throw unavailable();
        return respond({
          success: true,
          status: decision.status,
          account: { id: input.socialAccountId, publish_enabled: decision.publishEnabled },
        }, 200);
      case "stale":
        // Only a current owner/admin of the account's brand ever gets this (and the value with it).
        if (decision.publishEnabled === input.expectedCurrentEnabled) throw unavailable();
        throw new PublishSettingError("STALE_STATE", 409, { current_enabled: decision.publishEnabled });
      case "blocked":
        throw new PublishSettingError(
          decision.reason,
          409,
          RECONNECT_REASONS.has(decision.reason) ? { reconnect_recommended: true } : {},
        );
      case "not_found":
        // A missing account and one the caller has no membership for are the same answer.
        throw new PublishSettingError("ACCOUNT_NOT_FOUND", 404);
      case "forbidden":
        throw new PublishSettingError("PUBLISH_CONTROL_FORBIDDEN", 403);
      case "busy":
        throw new PublishSettingError("ACCOUNT_BUSY", 409);
      case "auth_required":
        throw new PublishSettingError("AUTH_REQUIRED", 401);
      case "invalid":
        throw invalid();
      default:
        throw unavailable();
    }
  } catch (error) {
    if (error instanceof PublishSettingError) {
      return respond({ success: false, error: error.code, ...error.extra }, error.status);
    }
    return respond({ success: false, error: "PUBLISH_SETTING_UNAVAILABLE" }, 503);
  }
}
