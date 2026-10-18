/**
 * POSTONA X single manual post ("send now") — F3 SOURCE CANDIDATE (2026-10-18, M1). Release gate OFF; not deployed.
 *
 * One request, decided fail-closed, in this order (nothing new: the reservation schema, its fencing and x_publisher):
 *   1. gate (source constant OFF) -> 503 NOT_AVAILABLE; strict body -> 400; bearer token verified LIVE by Supabase Auth
 *      (AuthVerifier) -> 401; the token's session_id (read only after that verification) is required (T13 checks it);
 *   2. the X publisher must be available (G4's credential source; X_CREDENTIALS_NOT_CONNECTED -> 503 X_NOT_AVAILABLE)
 *      -- nothing is recorded when nothing could be sent;
 *   3. post_now_begin (T13 + owner / G5 / G4 / authority, per-action consent = SHA-256 of the text, idempotent on
 *      clientRequestId): only a newly claimed row is sent; a repeat answers the stored state and never sends again;
 *   4. post_now_check right before the X call (the same fence again + the row's lease);
 *   5. exactly one X create (x_publisher: the stored text, the account's own token); unknown -> uncertain;
 *   6. post_now_finish records the outcome (lease_lost -> uncertain);
 *   7. post_now_get on a SEPARATE connection: 'sent' is answered only when the stored row is published with the X post
 *      id this request received (or, for a repeat, with the stored id). A missing / different id is 'uncertain'.
 * Answer (200): { ok: true, status: 'sent' | 'pending' | 'failed' | 'uncertain', reservationId, xPostId?, code? }.
 *   pending   = not sent (a fence was busy / the lease ran out before the X call): the same clientRequestId may be sent
 *               again and is re-armed; or another request with this id is still in progress.
 *   uncertain = the X outcome is not known (timeout, unknown answer, the result could not be recorded or read back):
 *               NEVER resend automatically; the person checks X.
 * Refusals (4xx / 503) carry fixed codes; nothing was written. No token, text or account id is ever logged.
 */
import type { AuthVerifier } from "./api.ts";
import type { SinglePostDb, SinglePostDbResult, SinglePostSubject } from "./single_post_db.ts";
import type { ReservationPublisher } from "./worker.ts";

export const POSTONA_X_SINGLE_POST_ENABLED = false as const;

export type SinglePostStatus = "sent" | "pending" | "failed" | "uncertain";
export type SinglePostResponse = {
  status: number;
  body: { ok: true; status: SinglePostStatus; reservationId: string; xPostId?: string; code?: string } | { ok: false; code: string };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_RE = /^[A-Za-z0-9_:-]{1,128}$/u;
const SHA_RE = /^[0-9a-f]{64}$/u;
const POST_ID_RE = /^[0-9]{1,30}$/u;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const MAX_BODY_BYTES = 16 * 1024;

const STATUS_BY_CODE: Record<string, number> = {
  POSTONA_RESV_AUTH_REQUIRED: 401,
  POSTONA_RESV_ACCOUNT_NOT_FOUND: 404,
  POSTONA_RESV_BRAND_NOT_ELIGIBLE: 403,
  POSTONA_RESV_SERVICE_NOT_ACTIVE: 403,
  POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED: 403,
  POSTONA_RESV_PUBLISH_AUTHORITY_REVOKED: 403,
  POSTONA_RESV_SERVICE_BUSY: 503,
  POSTONA_RESV_IDEMPOTENCY_CONFLICT: 409,
  POSTONA_RESV_TEXT_INVALID: 422,
  POSTONA_RESV_CONSENT_REQUIRED: 422,
  POSTONA_RESV_REQUEST_INVALID: 422,
};

const fail = (status: number, code: string): SinglePostResponse => ({ status, body: { ok: false, code } });
const done = (status: SinglePostStatus, reservationId: string, extra: { xPostId?: string; code?: string } = {}): SinglePostResponse => ({
  status: 200, body: { ok: true, status, reservationId, ...(extra.xPostId ? { xPostId: extra.xPostId } : {}), ...(extra.code && CODE_RE.test(extra.code) ? { code: extra.code } : {}) },
});

type Input = { socialAccountId: string; clientRequestId: string; text: string; contentSha256: string };

function parseBody(raw: string): Input | null {
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "clientRequestId,consent,socialAccountId,text") return null;
  const consent = v.consent as Record<string, unknown> | null;
  if (typeof consent !== "object" || consent === null || Object.keys(consent).sort().join(",") !== "confirmed,contentSha256" || consent.confirmed !== true) return null;
  if (typeof v.socialAccountId !== "string" || !ACCOUNT_RE.test(v.socialAccountId)) return null;
  if (typeof v.clientRequestId !== "string" || !UUID_RE.test(v.clientRequestId)) return null;
  if (typeof v.text !== "string" || v.text.length === 0 || v.text.length > 2000) return null;
  if (typeof consent.contentSha256 !== "string" || !SHA_RE.test(consent.contentSha256)) return null;
  return { socialAccountId: v.socialAccountId, clientRequestId: v.clientRequestId, text: v.text, contentSha256: consent.contentSha256 };
}

/** The session id of an access token Supabase Auth has ALREADY verified (never used as proof on its own). */
function sessionIdOf(token: string, userId: string): string | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(atob(part.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as Record<string, unknown>;
    return claims.sub === userId && typeof claims.session_id === "string" && UUID_RE.test(claims.session_id) ? claims.session_id : null;
  } catch {
    return null;
  }
}

const first = (result: SinglePostDbResult) => (result.ok ? result.rows[0] ?? null : null);

export function createSinglePostHandler(deps: { enabled: boolean; auth: AuthVerifier; db: SinglePostDb; readDb?: SinglePostDb; publisher: ReservationPublisher }) {
  const readDb = deps.readDb ?? deps.db;
  return async (request: { method: string; authorization: string | null; body: string }): Promise<SinglePostResponse> => {
    if (deps.enabled !== true) return fail(503, "NOT_AVAILABLE");
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED");
    const input = parseBody(request.body);
    if (!input) return fail(400, "REQUEST_INVALID");
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,4096})$/u.exec(request.authorization ?? "");
    if (!match) return fail(401, "AUTH_REQUIRED");
    let subject: SinglePostSubject;
    try {
      const verified = await deps.auth.verify(match[1]);
      if (!verified || !UUID_RE.test(verified.userId)) return fail(401, "AUTH_REQUIRED");
      const sessionId = sessionIdOf(match[1], verified.userId);
      if (!sessionId) return fail(401, "AUTH_REQUIRED");
      subject = { userId: verified.userId, sessionId };
    } catch {
      return fail(503, "AUTH_UNAVAILABLE");
    }
    if (deps.publisher.available !== true) return fail(503, "X_NOT_AVAILABLE");

    // 3. begin
    let begun: SinglePostDbResult;
    try {
      begun = await deps.db.call("begin", [input.socialAccountId, input.clientRequestId, input.text, input.contentSha256], subject);
    } catch {
      return fail(503, "STORE_UNAVAILABLE"); // unknown: the client repeats with the same clientRequestId (never a second send)
    }
    if (!begun.ok) {
      const status = STATUS_BY_CODE[begun.code];
      return status === undefined ? fail(500, "INTERNAL") : fail(status, begun.code);
    }
    const row = first(begun);
    const reservationId = typeof row?.reservation_id === "string" && UUID_RE.test(row.reservation_id) ? row.reservation_id : null;
    if (!row || !reservationId) return fail(500, "INTERNAL");
    const readBack = async (expectedPostId: string | null): Promise<SinglePostResponse> => {
      let got: SinglePostDbResult;
      try {
        got = await readDb.call("get", [reservationId], subject);
      } catch {
        return done("uncertain", reservationId, { code: "READBACK_UNAVAILABLE" });
      }
      const stored = first(got);
      if (!got.ok || !stored) return done("uncertain", reservationId, { code: "READBACK_UNAVAILABLE" });
      const state = stored.state;
      const postId = typeof stored.provider_post_id === "string" && POST_ID_RE.test(stored.provider_post_id) ? stored.provider_post_id : null;
      const code = typeof stored.outcome_code === "string" ? stored.outcome_code : undefined;
      if (state === "sent") {
        if (!postId || (expectedPostId !== null && postId !== expectedPostId)) return done("uncertain", reservationId, { code: "READBACK_MISMATCH" });
        return done("sent", reservationId, { xPostId: postId });
      }
      if (state === "failed" || state === "uncertain" || state === "pending") return done(state, reservationId, { code });
      return done("uncertain", reservationId, { code: "READBACK_UNKNOWN" });
    };
    if (row.state !== "claimed") {
      if (row.state === "in_progress") return done("pending", reservationId, { code: "IN_PROGRESS" });
      return readBack(null); // a repeat: the stored state, never a second send
    }
    const lease = typeof row.lease_token === "string" && UUID_RE.test(row.lease_token) ? row.lease_token : null;
    if (!lease) return fail(500, "INTERNAL");

    // 4. right before the X call
    let verdict: unknown;
    try {
      const checked = await deps.db.call("check", [reservationId, lease], subject);
      verdict = checked.ok ? first(checked)?.answer : null;
    } catch {
      verdict = null;
    }
    if (verdict !== "OK") return readBack(null); // RELEASED -> pending, NOT_PUBLISHABLE -> failed, unreadable -> as stored

    // 5. exactly one X create
    let result: Awaited<ReturnType<ReservationPublisher["publish"]>>;
    try {
      result = await deps.publisher.publish(input.socialAccountId, input.text);
    } catch {
      result = { kind: "unknown", code: "PUBLISHER_THREW" };
    }
    if (result.kind === "published" && !POST_ID_RE.test(result.providerPostId)) result = { kind: "unknown", code: "PROVIDER_POST_ID_INVALID" };

    // 6. record the outcome (any failure here leaves the row to the lease fence: 'uncertain', never resent)
    const args = result.kind === "published" ? [reservationId, lease, "published", result.providerPostId, null]
      : result.kind === "rejected_before_send" ? [reservationId, lease, "failed_before_send", null, CODE_RE.test(result.code) ? result.code : "REJECTED_BEFORE_SEND"]
      : [reservationId, lease, "uncertain", null, CODE_RE.test(result.code) ? result.code : "OUTCOME_UNKNOWN"];
    let recorded: unknown = null;
    try {
      const finished = await deps.db.call("finish", args, subject);
      recorded = finished.ok ? first(finished)?.answer : null;
    } catch {
      recorded = null;
    }
    if (result.kind === "published" && recorded !== "published") return done("uncertain", reservationId, { code: "RESULT_NOT_RECORDED" });

    // 7. independent read-back
    return readBack(result.kind === "published" ? result.providerPostId : null);
  };
}
