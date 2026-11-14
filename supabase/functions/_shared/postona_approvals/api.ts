/**
 * POSTONA X post approval + the person's notifications (G3-02 #16 SOURCE CANDIDATE). Not deployed; release gate OFF.
 *
 * The same caller rules as the reservation API (api.ts there): a live Supabase Auth check of the caller's token, the same token's
 * non-anonymous session, then ONE owner function of SQL 018 in one transaction as postona_resv_api. Every permission (person session,
 * brand owner, G5 service and generation, G4 verdict and connection generation) is decided inside that function; nothing here decides one.
 * No provider, push service or token is called or read from here.
 */
import { AUTH_VERIFIER_NOT_CONNECTED, type AuthVerifier, nonAnonymousSessionOf, type ReservationSubject } from "../postona_reservations/api.ts";

export const POSTONA_APPROVAL_API_ENABLED = false as const;

export type ApprovalAction = "submit" | "revise" | "approve" | "reject" | "list" | "get" | "notifications" | "markRead";
export type ApprovalDbFunction =
  | "submit_approval"
  | "revise_approval"
  | "approve_candidate"
  | "reject_candidate"
  | "list_approvals"
  | "get_approval"
  | "list_notifications"
  | "mark_notification_read";

export type ApprovalDbResult = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string };
export type ApprovalDb = {
  call(fn: ApprovalDbFunction, args: readonly unknown[], subject: ReservationSubject): Promise<ApprovalDbResult>;
};
export const APPROVAL_DB_NOT_CONNECTED: ApprovalDb = Object.freeze({
  call: () => Promise.resolve({ ok: false as const, code: "DB_UNAVAILABLE" }),
});

export type CandidateDto = {
  candidateId: string;
  socialAccountId: string;
  body: string;
  contentSha256: string;
  scheduledAt: string;
  state: "pending_approval" | "approved" | "rejected";
  revision: number;
  reservationId: string | null;
  decidedAt: string | null;
  createdAt: string;
};
export type NotificationDto = {
  notificationId: string;
  kind: "approval_requested" | "approval_approved" | "approval_rejected" | "reservation_changed";
  candidateId: string | null;
  reservationId: string | null;
  subjectRevision: number;
  state: string;
  scheduledAt: string | null;
  createdAt: string;
  readAt: string | null;
  /** G3-02 #23: the row's place in the person's stable order (SQL 018 `seq`); pass the last one as `before` for the next, older page. */
  cursor: number;
};

export type ApprovalRequest = { method: string; authorization: string | null; body: string };
export type ApprovalResponse = {
  status: number;
  body:
    | { ok: true; candidates: CandidateDto[] }
    /** `nextCursor` (the `notifications` action only): the `before` of the next page, or null when this page is the last one. */
    | { ok: true; notifications: NotificationDto[]; nextCursor?: number | null }
    | { ok: false; code: string };
};

const MAX_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_RE = /^[A-Za-z0-9_:-]{1,128}$/u;
const SHA_RE = /^[0-9a-f]{64}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/u;
const STATES = ["pending_approval", "approved", "rejected"] as const;
const KINDS = ["approval_requested", "approval_approved", "approval_rejected", "reservation_changed"] as const;

/** Fixed code -> HTTP status. Anything not listed is an internal failure (500) with no detail. */
const STATUS_BY_CODE: Record<string, number> = {
  POSTONA_RESV_AUTH_REQUIRED: 401,
  POSTONA_RESV_ACCOUNT_NOT_FOUND: 404,
  POSTONA_RESV_NOT_FOUND: 404,
  POSTONA_RESV_BRAND_NOT_ELIGIBLE: 403,
  POSTONA_RESV_SERVICE_NOT_ACTIVE: 403,
  POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED: 403,
  POSTONA_RESV_SERVICE_BUSY: 503,
  POSTONA_RESV_STALE_REVISION: 409,
  POSTONA_RESV_IDEMPOTENCY_CONFLICT: 409,
  POSTONA_RESV_SLOT_CONFLICT: 409,
  POSTONA_RESV_DAILY_CAPACITY: 409,
  POSTONA_RESV_MONTHLY_CAPACITY: 409,
  POSTONA_RESV_APPROVAL_NOT_PENDING: 409,
  POSTONA_RESV_APPROVAL_GENERATION_CHANGED: 409,
  POSTONA_RESV_APPROVAL_CAPACITY: 409,
  POSTONA_RESV_REQUEST_INVALID: 422,
  POSTONA_RESV_ITEM_INVALID: 422,
  POSTONA_RESV_TIME_OUT_OF_RANGE: 422,
  POSTONA_RESV_TEXT_INVALID: 422,
  POSTONA_RESV_CONSENT_REQUIRED: 422,
  DB_UNAVAILABLE: 503,
};

const fail = (status: number, code: string): ApprovalResponse => ({ status, body: { ok: false, code } });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const isIso = (value: unknown): value is string => typeof value === "string" && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);
const isBody = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2000;
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));

type Call = { fn: ApprovalDbFunction; args: unknown[]; result: "candidates" | "notifications"; page?: number };

/** Strict request shape -> one database call. Returns null when anything is off. */
function toCall(input: unknown): Call | null {
  if (!isObject(input) || typeof input.action !== "string" || !onlyKeys(input, ["action", "payload"])) return null;
  const p = input.payload;
  if (!isObject(p)) return null;
  switch (input.action as ApprovalAction) {
    case "submit":
      if (!onlyKeys(p, ["socialAccountId", "clientRequestId", "body", "scheduledAt"])) return null;
      if (typeof p.socialAccountId !== "string" || !ACCOUNT_RE.test(p.socialAccountId) || !isUuid(p.clientRequestId) || !isBody(p.body) || !isIso(p.scheduledAt)) return null;
      return { fn: "submit_approval", args: [p.socialAccountId, p.clientRequestId, p.body, p.scheduledAt], result: "candidates" };
    case "revise":
      if (!onlyKeys(p, ["candidateId", "expectedRevision", "body", "scheduledAt"])) return null;
      if (!isUuid(p.candidateId) || !isInt(p.expectedRevision, 1, 100000) || !isBody(p.body) || !isIso(p.scheduledAt)) return null;
      return { fn: "revise_approval", args: [p.candidateId, p.expectedRevision, p.body, p.scheduledAt], result: "candidates" };
    case "approve":
      if (!onlyKeys(p, ["candidateId", "expectedRevision", "contentSha256"])) return null;
      if (!isUuid(p.candidateId) || !isInt(p.expectedRevision, 1, 100000) || typeof p.contentSha256 !== "string" || !SHA_RE.test(p.contentSha256)) return null;
      return { fn: "approve_candidate", args: [p.candidateId, p.expectedRevision, p.contentSha256], result: "candidates" };
    case "reject":
      if (!onlyKeys(p, ["candidateId", "expectedRevision"]) || !isUuid(p.candidateId) || !isInt(p.expectedRevision, 1, 100000)) return null;
      return { fn: "reject_candidate", args: [p.candidateId, p.expectedRevision], result: "candidates" };
    case "list":
      if (!onlyKeys(p, ["socialAccountId"]) || typeof p.socialAccountId !== "string" || !ACCOUNT_RE.test(p.socialAccountId)) return null;
      return { fn: "list_approvals", args: [p.socialAccountId], result: "candidates" };
    case "get":
      if (!onlyKeys(p, ["candidateId"]) || !isUuid(p.candidateId)) return null;
      return { fn: "get_approval", args: [p.candidateId], result: "candidates" };
    case "notifications": {
      // G3-02 #23: `before` = a cursor from an earlier page (a positive safe integer); without it, the first page as before
      if (!onlyKeys(p, ["limit", "before"]) || (p.limit !== undefined && !isInt(p.limit, 1, 100))) return null;
      if (p.before !== undefined && !isInt(p.before, 1, Number.MAX_SAFE_INTEGER)) return null;
      const limit = (p.limit ?? 50) as number;
      return { fn: "list_notifications", args: [limit, p.before ?? null], result: "notifications", page: limit };
    }
    case "markRead":
      if (!onlyKeys(p, ["notificationId"]) || !isUuid(p.notificationId)) return null;
      return { fn: "mark_notification_read", args: [p.notificationId], result: "notifications" };
    default:
      return null;
  }
}

const iso = (value: unknown): string => new Date(value as string).toISOString();
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
const idOrNull = (value: unknown): string | null => (isUuid(value) ? value : null);

/** Only these fields leave the API; a row the function did not shape this way is an internal failure. */
function toCandidate(row: Record<string, unknown>): CandidateDto | null {
  if (!isUuid(row.candidate_id) || typeof row.body !== "string" || typeof row.content_sha256 !== "string" || !Number.isInteger(row.revision)) return null;
  if (!(STATES as readonly unknown[]).includes(row.state) || typeof row.social_account_id !== "string") return null;
  return {
    candidateId: row.candidate_id,
    socialAccountId: row.social_account_id,
    body: row.body,
    contentSha256: row.content_sha256,
    scheduledAt: iso(row.scheduled_at),
    state: row.state as CandidateDto["state"],
    revision: row.revision as number,
    reservationId: idOrNull(row.reservation_id),
    decidedAt: isoOrNull(row.decided_at),
    createdAt: iso(row.created_at),
  };
}

function toNotification(row: Record<string, unknown>): NotificationDto | null {
  if (!isUuid(row.notification_id) || !(KINDS as readonly unknown[]).includes(row.kind) || !Number.isInteger(row.subject_revision) || typeof row.state !== "string") return null;
  if (!isInt(row.cursor, 1, Number.MAX_SAFE_INTEGER)) return null;
  return {
    notificationId: row.notification_id,
    kind: row.kind as NotificationDto["kind"],
    candidateId: idOrNull(row.candidate_id),
    reservationId: idOrNull(row.reservation_id),
    subjectRevision: row.subject_revision as number,
    state: row.state,
    scheduledAt: isoOrNull(row.scheduled_at),
    createdAt: iso(row.created_at),
    readAt: isoOrNull(row.read_at),
    cursor: row.cursor as number,
  };
}

export function createApprovalApi(deps: { enabled: boolean; auth?: AuthVerifier; db?: ApprovalDb }): (request: ApprovalRequest) => Promise<ApprovalResponse> {
  const auth = deps.auth ?? AUTH_VERIFIER_NOT_CONNECTED;
  const db = deps.db ?? APPROVAL_DB_NOT_CONNECTED;
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

    let result: ApprovalDbResult;
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
    if (call.result === "candidates") {
      const rows = result.rows.map(toCandidate);
      if (rows.some((row) => row === null)) return fail(500, "INTERNAL");
      return { status: 200, body: { ok: true, candidates: rows as CandidateDto[] } };
    }
    const rows = result.rows.map(toNotification);
    if (rows.some((row) => row === null)) return fail(500, "INTERNAL");
    const notifications = rows as NotificationDto[];
    if (call.page === undefined) return { status: 200, body: { ok: true, notifications } };
    // a page must come back newest first, strictly below `before`, at most `limit` rows; anything else is not a page we can continue from
    const before = call.args[1] as number | null;
    if (notifications.length > call.page
        || notifications.some((n, i) => (before !== null && n.cursor >= before) || (i > 0 && n.cursor >= notifications[i - 1].cursor))) {
      return fail(500, "INTERNAL");
    }
    const nextCursor = notifications.length === call.page ? notifications[notifications.length - 1].cursor : null;
    return { status: 200, body: { ok: true, notifications, nextCursor } };
  };
}
