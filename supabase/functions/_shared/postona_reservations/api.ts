/**
 * POSTONA X reservation API — G3 SOURCE CANDIDATE (2026-10-12). Release gate OFF; NOT registered as an Edge
 * Function (there is no index.ts entry point), so nothing in production can reach it.
 *
 * One request = one owner action on the SQL candidate (supabase/candidates/postona_x_reservations/):
 *   create (atomic, idempotent batch) | list | get | reschedule | reconfirm | cancel (CAS on the row revision).
 *
 * Every request is decided fail-closed, in this order:
 *   1. release gate (source constant OFF)          -> 503 NOT_AVAILABLE, nothing else is touched;
 *   2. POST + bounded JSON + strict payload shape   -> 4xx, nothing reaches Auth or the database;
 *   3. bearer token verified LIVE by the injected AuthVerifier (Supabase Auth getUser in a reviewed rollout,
 *      never the JWT lifetime alone)               -> 401; verifier missing or failing -> 503;
 *   4. G5 x_autopost entitlement / lifecycle and G4 verified X account, from the injected PermissionSources
 *      (owner-provided implementations; DEFAULT DENY until they exist) -> 403;
 *   5. the database call as the verified subject (ReservationDb): the SQL function re-checks owner, account,
 *      G5 and G4 inside its own transaction, so a permission lost between 4 and 5 is still refused.
 * The client never sends a user id, brand id, approval mode or role: identity comes only from step 3, and every
 * brand / account binding is read by the database. Errors carry a fixed code, never a database message.
 * A mutation whose outcome is unknown (database unreachable, timeout) answers 503 STORE_UNAVAILABLE: the client
 * must read back before showing anything as saved, and may retry create with the same idempotency key.
 */

export const POSTONA_RESERVATION_API_ENABLED = false as const;

export type ReservationAction = "create" | "list" | "get" | "reschedule" | "reconfirm" | "cancel";
export type ReservationDbFunction =
  | "create_batch"
  | "list_reservations"
  | "get_reservation"
  | "reschedule"
  | "reconfirm"
  | "cancel";

/** postona_x_resv.reservation_view as returned by the database. */
export type ReservationRow = {
  reservation_id: string;
  batch_id: string;
  draft_id: string;
  position: number;
  origin: string;
  mode: string;
  body: string | null;
  scheduled_at: string;
  fixed: boolean;
  status: string;
  revision: number;
  consent_state: string;
};

export type DbResult = { ok: true; rows: ReservationRow[] } | { ok: false; code: string };

/**
 * Runs ONE owner function in ONE transaction as the dedicated API role, with request.jwt.claims set locally to
 * `subject`. Returns POSTONA_RESV_* codes as `{ ok: false, code }`; anything else as code DB_UNAVAILABLE.
 */
export type ReservationDb = {
  call(fn: ReservationDbFunction, args: readonly unknown[], subject: string): Promise<DbResult>;
};

/** Live verification of an access token. Returns the subject (auth.users.id) or null. */
export type AuthVerifier = { verify(accessToken: string): Promise<{ userId: string } | null> };

/** Owner-provided permission decisions (G5 entitlement + lifecycle, G4 verified X account). */
export type PermissionSources = {
  xAutopostAllowed(userId: string): Promise<boolean>;
  xAccountVerified(userId: string, socialAccountId: string): Promise<boolean>;
};

export const AUTH_VERIFIER_NOT_CONNECTED: AuthVerifier = Object.freeze({
  verify: () => Promise.reject(new Error("AUTH_VERIFIER_NOT_CONNECTED")),
});
/** G5 / G4 have not delivered reviewed implementations: everything is denied. */
export const PERMISSIONS_NOT_CONNECTED: PermissionSources = Object.freeze({
  xAutopostAllowed: () => Promise.resolve(false),
  xAccountVerified: () => Promise.resolve(false),
});
export const DB_NOT_CONNECTED: ReservationDb = Object.freeze({
  call: () => Promise.resolve({ ok: false as const, code: "DB_UNAVAILABLE" }),
});

export type ReservationDto = {
  reservationId: string;
  batchId: string;
  draftId: string;
  position: number;
  origin: string;
  mode: string;
  body: string | null;
  scheduledAt: string;
  fixed: boolean;
  status: string;
  revision: number;
  consentState: string;
};

export type ApiRequest = { method: string; authorization: string | null; body: string };
export type ApiResponse = { status: number; body: { ok: true; reservations: ReservationDto[] } | { ok: false; code: string } };

const MAX_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_RE = /^[A-Za-z0-9_:-]{1,128}$/u;
const DRAFT_RE = /^[A-Za-z0-9:_-]{1,80}$/u;
const SHA_RE = /^[0-9a-f]{64}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/u;
const MODES = ["manual_exact", "manual_random_batch", "manual_interval", "ai_flexible"] as const;

/** Fixed code -> HTTP status. Anything not listed is an internal failure (500) with no detail. */
const STATUS_BY_CODE: Record<string, number> = {
  POSTONA_RESV_AUTH_REQUIRED: 401,
  POSTONA_RESV_ACCOUNT_NOT_FOUND: 404,
  POSTONA_RESV_NOT_FOUND: 404,
  POSTONA_RESV_BRAND_NOT_ELIGIBLE: 403,
  POSTONA_RESV_SERVICE_NOT_ACTIVE: 403,
  POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED: 403,
  POSTONA_RESV_AI_NOT_OPTED_IN: 403,
  POSTONA_RESV_STALE_REVISION: 409,
  POSTONA_RESV_IDEMPOTENCY_CONFLICT: 409,
  POSTONA_RESV_SLOT_CONFLICT: 409,
  POSTONA_RESV_DAILY_CAPACITY: 409,
  POSTONA_RESV_MONTHLY_CAPACITY: 409,
  POSTONA_RESV_CANCEL_TOO_LATE: 409,
  POSTONA_RESV_NOT_PLANNED: 409,
  POSTONA_RESV_ALREADY_FINAL: 409,
  POSTONA_RESV_REQUEST_INVALID: 422,
  POSTONA_RESV_ITEM_INVALID: 422,
  POSTONA_RESV_TIME_OUT_OF_RANGE: 422,
  POSTONA_RESV_OUTSIDE_BAND: 422,
  POSTONA_RESV_BAND_REQUIRED: 422,
  POSTONA_RESV_TEXT_INVALID: 422,
  POSTONA_RESV_CONSENT_REQUIRED: 422,
  POSTONA_RESV_AI_TEXT_NOT_ALLOWED: 422,
  POSTONA_RESV_INTERVAL_INVALID: 422,
  POSTONA_RESV_INTERVAL_MISMATCH: 422,
  DB_UNAVAILABLE: 503,
};

const fail = (status: number, code: string): ApiResponse => ({ status, body: { ok: false, code } });

type Call = { fn: ReservationDbFunction; args: unknown[]; accountId: string | null };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const isIso = (value: unknown): value is string => typeof value === "string" && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));

function validItem(item: unknown, mode: string): boolean {
  if (!isObject(item) || !onlyKeys(item, ["draft_id", "scheduled_at", "body", "consent", "slot"])) return false;
  if (typeof item.draft_id !== "string" || !DRAFT_RE.test(item.draft_id) || !isIso(item.scheduled_at)) return false;
  if (item.slot !== undefined && !isInt(item.slot, 0, 49)) return false;
  if (mode === "ai_flexible") return item.body === undefined && item.consent === undefined;
  if (typeof item.body !== "string" || item.body.length === 0 || item.body.length > 2000) return false;
  const consent = item.consent;
  return isObject(consent) && onlyKeys(consent, ["confirmed", "content_sha256"]) && consent.confirmed === true
    && typeof consent.content_sha256 === "string" && SHA_RE.test(consent.content_sha256);
}

/** Strict request shape -> one database call. Returns null when anything is off. */
function toCall(input: unknown): Call | null {
  if (!isObject(input) || typeof input.action !== "string") return null;
  const p = input.payload;
  if (!isObject(p)) return null;
  switch (input.action as ReservationAction) {
    case "create": {
      if (!onlyKeys(p, ["socialAccountId", "clientBatchId", "revision", "mode", "band", "items"])) return null;
      if (typeof p.socialAccountId !== "string" || !ACCOUNT_RE.test(p.socialAccountId)) return null;
      if (typeof p.clientBatchId !== "string" || !UUID_RE.test(p.clientBatchId) || !isInt(p.revision, 1, 1000)) return null;
      if (typeof p.mode !== "string" || !(MODES as readonly string[]).includes(p.mode)) return null;
      if (p.band !== null && !isObject(p.band)) return null;
      if (!Array.isArray(p.items) || p.items.length < 1 || p.items.length > 50) return null;
      if (!p.items.every((item) => validItem(item, p.mode as string))) return null;
      return { fn: "create_batch", args: [p.socialAccountId, p.clientBatchId, p.revision, p.mode, p.band, p.items], accountId: p.socialAccountId };
    }
    case "list":
      if (!onlyKeys(p, ["socialAccountId"]) || typeof p.socialAccountId !== "string" || !ACCOUNT_RE.test(p.socialAccountId)) return null;
      return { fn: "list_reservations", args: [p.socialAccountId], accountId: p.socialAccountId };
    case "get":
      if (!onlyKeys(p, ["reservationId"]) || typeof p.reservationId !== "string" || !UUID_RE.test(p.reservationId)) return null;
      return { fn: "get_reservation", args: [p.reservationId], accountId: null };
    case "reschedule":
      if (!onlyKeys(p, ["reservationId", "expectedRevision", "scheduledAt"])) return null;
      if (typeof p.reservationId !== "string" || !UUID_RE.test(p.reservationId) || !isInt(p.expectedRevision, 1, 100000) || !isIso(p.scheduledAt)) return null;
      return { fn: "reschedule", args: [p.reservationId, p.expectedRevision, p.scheduledAt], accountId: null };
    case "reconfirm":
      if (!onlyKeys(p, ["reservationId", "expectedRevision", "contentSha256"])) return null;
      if (typeof p.reservationId !== "string" || !UUID_RE.test(p.reservationId) || !isInt(p.expectedRevision, 1, 100000)) return null;
      if (typeof p.contentSha256 !== "string" || !SHA_RE.test(p.contentSha256)) return null;
      return { fn: "reconfirm", args: [p.reservationId, p.expectedRevision, p.contentSha256], accountId: null };
    case "cancel":
      if (!onlyKeys(p, ["reservationId", "expectedRevision"])) return null;
      if (typeof p.reservationId !== "string" || !UUID_RE.test(p.reservationId) || !isInt(p.expectedRevision, 1, 100000)) return null;
      return { fn: "cancel", args: [p.reservationId, p.expectedRevision], accountId: null };
    default:
      return null;
  }
}

function toDto(row: ReservationRow): ReservationDto {
  return {
    reservationId: row.reservation_id,
    batchId: row.batch_id,
    draftId: row.draft_id,
    position: row.position,
    origin: row.origin,
    mode: row.mode,
    body: row.body,
    scheduledAt: new Date(row.scheduled_at).toISOString(),
    fixed: row.fixed,
    status: row.status,
    revision: row.revision,
    consentState: row.consent_state,
  };
}

export function createReservationApi(deps: {
  enabled: boolean;
  auth?: AuthVerifier;
  permissions?: PermissionSources;
  db?: ReservationDb;
}): (request: ApiRequest) => Promise<ApiResponse> {
  const auth = deps.auth ?? AUTH_VERIFIER_NOT_CONNECTED;
  const permissions = deps.permissions ?? PERMISSIONS_NOT_CONNECTED;
  const db = deps.db ?? DB_NOT_CONNECTED;
  return async (request) => {
    if (deps.enabled !== true) return fail(503, "NOT_AVAILABLE");
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED");
    if (new TextEncoder().encode(request.body).length > MAX_BODY_BYTES) return fail(413, "REQUEST_TOO_LARGE");
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body);
    } catch {
      return fail(400, "REQUEST_INVALID");
    }
    const call = toCall(parsed);
    if (!call) return fail(400, "REQUEST_INVALID");

    const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,4096})$/u.exec(request.authorization ?? "");
    if (!match) return fail(401, "AUTH_REQUIRED");
    let userId: string;
    try {
      const verified = await auth.verify(match[1]);
      if (!verified || !UUID_RE.test(verified.userId)) return fail(401, "AUTH_REQUIRED");
      userId = verified.userId;
    } catch {
      return fail(503, "AUTH_UNAVAILABLE");
    }

    try {
      if ((await permissions.xAutopostAllowed(userId)) !== true) return fail(403, "POSTONA_RESV_SERVICE_NOT_ACTIVE");
      if (call.accountId !== null && (await permissions.xAccountVerified(userId, call.accountId)) !== true) {
        return fail(403, "POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED");
      }
    } catch {
      return fail(503, "PERMISSION_UNAVAILABLE");
    }

    let result: DbResult;
    try {
      result = await db.call(call.fn, call.args, userId);
    } catch {
      return fail(503, "STORE_UNAVAILABLE");
    }
    if (!result.ok) {
      const status = STATUS_BY_CODE[result.code];
      if (status === undefined) return fail(500, "INTERNAL");
      return fail(status, result.code === "DB_UNAVAILABLE" ? "STORE_UNAVAILABLE" : result.code);
    }
    return { status: 200, body: { ok: true, reservations: result.rows.map(toDto) } };
  };
}
