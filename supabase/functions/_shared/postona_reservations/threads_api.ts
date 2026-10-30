/**
 * POSTONA Threads reservation API — G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-46). Release gate OFF; registered only as the
 * gated postona-threads-reservations entry, so nothing in production can reach it.
 *
 * One request = one owner action on the Threads SQL candidate (supabase/candidates/postona_threads_reservations/ 007 + 009 + 011):
 *   create  (idempotent on socialAccountId + clientRequestId) | cancel (the caller's own planned row) | receipt (the caller's own row,
 *   found by socialAccountId + clientRequestId: the app's read-back of a create whose answer it did not see).
 *
 * Every request is decided fail-closed, in this order (as the X API, api.ts):
 *   1. release gate (source constant OFF)          -> 503 NOT_AVAILABLE, nothing else is touched;
 *   2. POST + bounded JSON + strict payload shape   -> 4xx, nothing reaches Auth or the database;
 *   3. bearer token verified LIVE by the injected AuthVerifier, and the SAME token's session_id and is_anonymous JSON false
 *      (nonAnonymousSessionOf, shared with api.ts)  -> 401; verifier failing -> 503;
 *   4. create only: the publish permission port (owner-provided; DEFAULT DENY until G5 / G4 deliver) -> 403. cancel and receipt have no
 *      pre-gate: a cancel only stops a send and a receipt reads one's own row, so after the service ended or with the account no longer
 *      verified the person can still read and cancel; the SQL decides with the person session (G5 S2-2) and row ownership;
 *   5. the database call as the verified subject (ThreadsReservationDb): create re-checks account, G5 and G4 (still DENY) inside its own
 *      transaction, so a permission lost between 4 and 5 is still refused.
 * The client never sends a user id, brand id or role: identity comes only from step 3. Errors carry a fixed code, never a database
 * message. A mutation whose outcome is unknown (database unreachable, a malformed answer) answers 503 STORE_UNAVAILABLE: the client must
 * call receipt before showing anything as saved or cancelled, and may retry create with the same clientRequestId.
 */
import { type ApiRequest, AUTH_VERIFIER_NOT_CONNECTED, type AuthVerifier, nonAnonymousSessionOf, type ReservationSubject } from "./api.ts";

export const POSTONA_THREADS_RESERVATION_API_ENABLED = false as const;

export type ThreadsAction = "create" | "cancel" | "receipt";
export type ThreadsDbFunction = "create_reservation" | "cancel_reservation" | "receipt";
export type ThreadsDbResult = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string };
/** Runs one fixed Threads owner function as the verified subject; throws when the outcome is unknown. */
export type ThreadsReservationDb = {
  call(fn: ThreadsDbFunction, args: readonly unknown[], subject: ReservationSubject): Promise<ThreadsDbResult>;
};
/** Owner-provided: may this person create a Threads reservation for this account now (G5 service + G4 verified account)? */
export type ThreadsPermissionSources = { threadsPublishAllowed(userId: string, socialAccountId: string): Promise<boolean> };

export const THREADS_PERMISSIONS_NOT_CONNECTED: ThreadsPermissionSources = Object.freeze({
  threadsPublishAllowed: () => Promise.resolve(false),
});
/**
 * G3-02 #2: no TS pre-check -- create_reservation decides, in its own transaction, with the REAL sources: G5's person session (caller()),
 * fence (brand owner, personal profile, verified account, G4's Threads verdict, publish_enabled = U8) and G5's R1 verdict (g5_r1_bound),
 * each refusal a fixed code. Identity only: this object's method is never asked (it would deny).
 */
export const THREADS_PERMISSIONS_DECIDED_IN_DATABASE: ThreadsPermissionSources = Object.freeze({
  threadsPublishAllowed: () => Promise.resolve(false),
});
export const THREADS_DB_NOT_CONNECTED: ThreadsReservationDb = Object.freeze({
  call: () => Promise.resolve({ ok: false as const, code: "DB_UNAVAILABLE" }),
});

export type ThreadsReservationDto = { reservationId: string; status: string; created?: boolean };
export type ThreadsReceiptDto = {
  reservationId: string;
  state: "sent" | "failed" | "cancelled" | "pending" | "uncertain";
  providerPostId: string | null;
  outcomeCode: string | null;
  afterFreeze: boolean;
  simulated: boolean;
};
export type ThreadsApiResponse = {
  status: number;
  body: { ok: true; reservation: ThreadsReservationDto } | { ok: true; receipt: ThreadsReceiptDto } | { ok: false; code: string };
};

const MAX_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_RE = /^[A-Za-z0-9_:-]{1,128}$/u;
const SHA_RE = /^[0-9a-f]{64}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/u;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const POST_ID_RE = /^[0-9]{1,40}$/u;
const MAX_TEXT_CHARS = 4000; // the SQL (text_ok) holds the product rule; this only bounds the request
const RECEIPT_STATES: readonly ThreadsReceiptDto["state"][] = ["sent", "failed", "cancelled", "pending", "uncertain"];
const ROW_STATUSES: readonly string[] = ["planned", "claimed", "published", "failed", "uncertain", "cancelled"];

const STATUS_BY_CODE: Record<string, number> = {
  POSTONA_RESV_AUTH_REQUIRED: 401,
  POSTONA_THREADS_RESV_NOT_FOUND: 404,
  POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND: 404,
  POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED: 403,
  POSTONA_THREADS_RESV_PUBLISH_DISABLED: 403,
  POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE: 403,
  POSTONA_RESV_SERVICE_NOT_ACTIVE: 403,
  // The common-account write fence was held by a lifecycle step: retryable, nothing written.
  POSTONA_RESV_SERVICE_BUSY: 503,
  POSTONA_THREADS_RESV_NOT_CANCELLABLE: 409,
  POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT: 409,
  POSTONA_THREADS_RESV_REQUEST_INVALID: 422,
  POSTONA_THREADS_RESV_TEXT_INVALID: 422,
  POSTONA_THREADS_RESV_CONSENT_REQUIRED: 422,
  POSTONA_THREADS_RESV_SCHEDULE_INVALID: 422,
  DB_UNAVAILABLE: 503,
};

const fail = (status: number, code: string): ThreadsApiResponse => ({ status, body: { ok: false, code } });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isIso = (value: unknown): value is string => typeof value === "string" && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
const isAccount = (value: unknown): value is string => typeof value === "string" && ACCOUNT_RE.test(value);
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

type Call = { action: ThreadsAction; fn: ThreadsDbFunction; args: unknown[]; accountId: string | null };

function toCall(input: unknown): Call | null {
  if (!isObject(input) || !onlyKeys(input, ["action", "payload"]) || !isObject(input.payload)) return null;
  const p = input.payload;
  switch (input.action) {
    case "create":
      if (!onlyKeys(p, ["socialAccountId", "clientRequestId", "text", "contentSha256", "scheduledAt"])) return null;
      if (!isAccount(p.socialAccountId) || !isUuid(p.clientRequestId) || !isIso(p.scheduledAt)) return null;
      if (typeof p.text !== "string" || p.text.length === 0 || p.text.length > MAX_TEXT_CHARS) return null;
      if (typeof p.contentSha256 !== "string" || !SHA_RE.test(p.contentSha256)) return null;
      return { action: "create", fn: "create_reservation", args: [p.socialAccountId, p.clientRequestId, p.text, p.contentSha256, p.scheduledAt], accountId: p.socialAccountId };
    case "cancel":
      if (!onlyKeys(p, ["reservationId"]) || !isUuid(p.reservationId)) return null;
      return { action: "cancel", fn: "cancel_reservation", args: [p.reservationId], accountId: null };
    case "receipt":
      if (!onlyKeys(p, ["socialAccountId", "clientRequestId"]) || !isAccount(p.socialAccountId) || !isUuid(p.clientRequestId)) return null;
      return { action: "receipt", fn: "receipt", args: [p.socialAccountId, p.clientRequestId], accountId: null };
    default:
      return null;
  }
}

/** The one row of a definite answer, shaped for the client; null when the answer is not what the function returns (outcome unknown). */
function toBody(call: Call, rows: Record<string, unknown>[]): ThreadsApiResponse["body"] | null {
  if (rows.length !== 1 || !isObject(rows[0])) return null;
  const row = rows[0];
  if (call.action === "create") {
    if (!isUuid(row.reservation_id) || !ROW_STATUSES.includes(row.status as string) || typeof row.created !== "boolean") return null;
    if (row.created && row.status !== "planned") return null;
    return { ok: true, reservation: { reservationId: row.reservation_id, status: row.status as string, created: row.created } };
  }
  if (call.action === "cancel") {
    if (row.state !== "cancelled") return null;
    return { ok: true, reservation: { reservationId: call.args[0] as string, status: "cancelled" } };
  }
  const state = row.state as ThreadsReceiptDto["state"];
  if (!isUuid(row.reservation_id) || !RECEIPT_STATES.includes(state)) return null;
  if (row.provider_post_id !== null && !(typeof row.provider_post_id === "string" && POST_ID_RE.test(row.provider_post_id))) return null;
  if (row.outcome_code !== null && !(typeof row.outcome_code === "string" && CODE_RE.test(row.outcome_code))) return null;
  if (typeof row.after_freeze !== "boolean" || typeof row.simulated !== "boolean") return null;
  return {
    ok: true,
    receipt: {
      reservationId: row.reservation_id, state, providerPostId: row.provider_post_id as string | null, outcomeCode: row.outcome_code as string | null,
      afterFreeze: row.after_freeze, simulated: row.simulated,
    },
  };
}

export function createThreadsReservationApi(deps: {
  enabled: boolean;
  auth?: AuthVerifier;
  permissions?: ThreadsPermissionSources;
  db?: ThreadsReservationDb;
}): (request: ApiRequest) => Promise<ThreadsApiResponse> {
  const auth = deps.auth ?? AUTH_VERIFIER_NOT_CONNECTED;
  const permissions = deps.permissions ?? THREADS_PERMISSIONS_NOT_CONNECTED;
  const db = deps.db ?? THREADS_DB_NOT_CONNECTED;
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
    let subject: ReservationSubject;
    try {
      const verified = await auth.verify(match[1]);
      if (!verified || !UUID_RE.test(verified.userId)) return fail(401, "AUTH_REQUIRED");
      const session = nonAnonymousSessionOf(match[1], verified.userId);
      if (!session) return fail(401, "AUTH_REQUIRED");
      subject = { userId: verified.userId, sessionId: session, isAnonymous: false };
    } catch {
      return fail(503, "AUTH_UNAVAILABLE");
    }

    if (call.action === "create" && permissions !== THREADS_PERMISSIONS_DECIDED_IN_DATABASE) {
      try {
        if ((await permissions.threadsPublishAllowed(subject.userId, call.accountId as string)) !== true) {
          return fail(403, "POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE");
        }
      } catch {
        return fail(503, "PERMISSION_UNAVAILABLE");
      }
    }

    let result: ThreadsDbResult;
    try {
      result = await db.call(call.fn, call.args, subject);
    } catch {
      return fail(503, "STORE_UNAVAILABLE");
    }
    if (!result.ok) {
      const status = STATUS_BY_CODE[result.code];
      if (status === undefined) return fail(500, "INTERNAL");
      return fail(status, result.code === "DB_UNAVAILABLE" ? "STORE_UNAVAILABLE" : result.code);
    }
    const body = toBody(call, result.rows);
    return body ? { status: 200, body } : fail(503, "STORE_UNAVAILABLE");
  };
}
