/**
 * TEST FIXTURE -- NOT an Edge Function and imported by no product code (supabase/functions/ never imports from
 * supabase/candidates/). G3 Issue #318 TASK 3/50, 2026-10-19. It fixes the HTTP contract the future person-facing
 * Threads reservation Edge must keep, over candidate 007 (PR #339), with the caller's identity given as a MOCK verdict
 * (no JWT signature check, no managed Auth here: G5 owns the real verifier and the Threads entitlement).
 *
 *   POST, Authorization: Bearer <the person's own token>, JSON body (exactly one of):
 *     { op: "create",  socialAccountId, clientRequestId, text, scheduledAt, consent: { confirmed: true, contentSha256 } }
 *     { op: "cancel",  reservationId }
 *     { op: "receipt", socialAccountId, clientRequestId }                    (text-free)
 *   Answers (never a token, never the text, never another person's data):
 *     200 create  { ok, reservationId, status, created }   (created:false = the same request again; nothing new)
 *     200 cancel  { ok, status: "cancelled" }
 *     200 receipt { ok, reservationId, state, xPostId?, code?, simulated, afterFreeze }  -- state: pending | sent |
 *                 failed | uncertain | cancelled; simulated is false only for a real-transport record
 *     401 AUTH_REQUIRED | 403 ACCOUNT_NOT_VERIFIED / PUBLISH_DISABLED / SERVICE_NOT_ACTIVE | 404 NOT_FOUND
 *     409 IDEMPOTENCY_CONFLICT / NOT_CANCELLABLE | 422 REQUEST_INVALID / TEXT_INVALID / CONSENT_REQUIRED /
 *     SCHEDULE_INVALID | 503 OUTCOME_UNKNOWN (the store may have written: repeat with the SAME clientRequestId) |
 *     503 NOT_AVAILABLE (gate OFF) / AUTH_UNAVAILABLE / STORE_UNAVAILABLE
 *   receipt: one constant 404 RECEIPT_NOT_FOUND for another person's id, another account and an unknown id (no
 *   existence oracle); it never writes, re-arms or sends.
 */

export const THREADS_RESERVATION_HTTP_FIXTURE = true as const;

export type VerifiedCaller = { userId: string; sessionId: string };
export type StoreAnswer = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string };
/** One fixed 007 function, one transaction, as postona_resv_api with this caller. THROWS when the outcome is unknown. */
export type ThreadsReservationStore = {
  call(fn: "create" | "cancel" | "receipt", args: readonly unknown[], caller: VerifiedCaller): Promise<StoreAnswer>;
};
export type ThreadsReservationHttpDeps = {
  enabled: boolean;
  /** MOCK verdict of the caller's token (the real verifier is G5's): null = not signed in. Throws = unavailable. */
  verify(token: string): Promise<VerifiedCaller | null>;
  store: ThreadsReservationStore;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_RE = /^[a-z][a-z0-9_]{1,80}$/u;
const SHA_RE = /^[0-9a-f]{64}$/u;
const POST_ID_RE = /^[1-9][0-9]{0,31}$/u;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/u;
const MAX_BODY_BYTES = 16 * 1024;

const STATUS_BY_CODE: Record<string, [number, string]> = {
  POSTONA_RESV_AUTH_REQUIRED: [401, "AUTH_REQUIRED"],
  POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND: [404, "NOT_FOUND"],
  POSTONA_THREADS_RESV_NOT_FOUND: [404, "NOT_FOUND"],
  POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED: [403, "ACCOUNT_NOT_VERIFIED"],
  POSTONA_THREADS_RESV_PUBLISH_DISABLED: [403, "PUBLISH_DISABLED"],
  POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE: [403, "SERVICE_NOT_ACTIVE"],
  POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT: [409, "IDEMPOTENCY_CONFLICT"],
  POSTONA_THREADS_RESV_NOT_CANCELLABLE: [409, "NOT_CANCELLABLE"],
  POSTONA_THREADS_RESV_REQUEST_INVALID: [422, "REQUEST_INVALID"],
  POSTONA_THREADS_RESV_TEXT_INVALID: [422, "TEXT_INVALID"],
  POSTONA_THREADS_RESV_CONSENT_REQUIRED: [422, "CONSENT_REQUIRED"],
  POSTONA_THREADS_RESV_SCHEDULE_INVALID: [422, "SCHEDULE_INVALID"],
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, code: string) => json(status, { ok: false, code });
const RECEIPT_NOT_FOUND = () => fail(404, "RECEIPT_NOT_FOUND");

type Parsed =
  | { op: "create"; socialAccountId: string; clientRequestId: string; text: string; scheduledAt: string; contentSha256: string }
  | { op: "cancel"; reservationId: string }
  | { op: "receipt"; socialAccountId: string; clientRequestId: string };

function keys(v: Record<string, unknown>) {
  return Object.keys(v).sort().join(",");
}

function parse(raw: string): Parsed | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.op === "create") {
    if (keys(v) !== "clientRequestId,consent,op,scheduledAt,socialAccountId,text") return null;
    const c = v.consent as Record<string, unknown> | null;
    if (typeof c !== "object" || c === null || Array.isArray(c) || keys(c) !== "confirmed,contentSha256" || c.confirmed !== true) return null;
    if (typeof v.socialAccountId !== "string" || !ACCOUNT_RE.test(v.socialAccountId)) return null;
    if (typeof v.clientRequestId !== "string" || !UUID_RE.test(v.clientRequestId)) return null;
    if (typeof v.text !== "string" || v.text.length === 0 || v.text.length > 2000) return null;
    if (typeof v.scheduledAt !== "string" || !ISO_RE.test(v.scheduledAt) || Number.isNaN(Date.parse(v.scheduledAt))) return null;
    if (typeof c.contentSha256 !== "string" || !SHA_RE.test(c.contentSha256)) return null;
    return { op: "create", socialAccountId: v.socialAccountId, clientRequestId: v.clientRequestId, text: v.text, scheduledAt: v.scheduledAt, contentSha256: c.contentSha256 };
  }
  if (v.op === "cancel") {
    if (keys(v) !== "op,reservationId" || typeof v.reservationId !== "string" || !UUID_RE.test(v.reservationId)) return null;
    return { op: "cancel", reservationId: v.reservationId };
  }
  if (v.op === "receipt") {
    if (keys(v) !== "clientRequestId,op,socialAccountId") return null;
    if (typeof v.socialAccountId !== "string" || !ACCOUNT_RE.test(v.socialAccountId)) return null;
    if (typeof v.clientRequestId !== "string" || !UUID_RE.test(v.clientRequestId)) return null;
    return { op: "receipt", socialAccountId: v.socialAccountId, clientRequestId: v.clientRequestId };
  }
  return null;
}

async function readBounded(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(MAX_BODY_BYTES + 1)));
  return bytes.byteLength > MAX_BODY_BYTES ? null : new TextDecoder().decode(bytes);
}

export function createThreadsReservationHttpFixture(deps: ThreadsReservationHttpDeps) {
  return async (request: Request): Promise<Response> => {
    if (deps.enabled !== true) return fail(503, "NOT_AVAILABLE");
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED");
    const raw = await readBounded(request);
    if (raw === null) return fail(413, "REQUEST_TOO_LARGE");
    const input = parse(raw);
    if (!input) return fail(400, "REQUEST_INVALID");
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,4096})$/u.exec(request.headers.get("authorization") ?? "");
    if (!match) return fail(401, "AUTH_REQUIRED");
    let caller: VerifiedCaller | null;
    try {
      caller = await deps.verify(match[1]);
    } catch {
      return fail(503, "AUTH_UNAVAILABLE");
    }
    if (!caller || !UUID_RE.test(caller.userId) || !UUID_RE.test(caller.sessionId)) {
      return fail(401, "AUTH_REQUIRED");
    }

    if (input.op === "receipt") {
      let answer: StoreAnswer;
      try {
        answer = await deps.store.call("receipt", [input.socialAccountId, input.clientRequestId], caller);
      } catch {
        return fail(503, "RECEIPT_UNAVAILABLE");
      }
      const row = answer.ok ? answer.rows[0] : null;
      if (!answer.ok || !row || typeof row.reservation_id !== "string" || !UUID_RE.test(row.reservation_id)) {
        // Another person's id, another account, an unknown id, a refusal: one answer (no existence oracle).
        if (!answer.ok && answer.code === "POSTONA_RESV_AUTH_REQUIRED") return fail(401, "AUTH_REQUIRED");
        return answer.ok || answer.code === "POSTONA_THREADS_RESV_NOT_FOUND" ? RECEIPT_NOT_FOUND() : fail(503, "RECEIPT_UNAVAILABLE");
      }
      const state = ["pending", "sent", "failed", "uncertain", "cancelled"].includes(String(row.state)) ? String(row.state) : "uncertain";
      const postId = typeof row.provider_post_id === "string" && POST_ID_RE.test(row.provider_post_id) ? row.provider_post_id : null;
      if (state === "sent" && !postId) return json(200, { ok: true, reservationId: row.reservation_id, state: "uncertain", code: "RECEIPT_POST_ID_MISSING", simulated: true, afterFreeze: row.after_freeze === true });
      return json(200, {
        ok: true, reservationId: row.reservation_id, state, ...(postId ? { xPostId: postId } : {}),
        ...(typeof row.outcome_code === "string" && CODE_RE.test(row.outcome_code) ? { code: row.outcome_code } : {}),
        simulated: row.simulated !== false, afterFreeze: row.after_freeze === true,
      });
    }

    const [fn, args] = input.op === "create"
      ? ["create" as const, [input.socialAccountId, input.clientRequestId, input.text, input.contentSha256, input.scheduledAt]]
      : ["cancel" as const, [input.reservationId]];
    let answer: StoreAnswer;
    try {
      answer = await deps.store.call(fn, args, caller);
    } catch {
      // The store may have committed: the person repeats the SAME request (create is idempotent on clientRequestId).
      return fail(503, "OUTCOME_UNKNOWN");
    }
    if (!answer.ok) {
      const mapped = STATUS_BY_CODE[answer.code];
      return mapped ? fail(mapped[0], mapped[1]) : fail(503, "STORE_UNAVAILABLE");
    }
    const row = answer.rows[0];
    if (input.op === "cancel") return row?.answer === "cancelled" ? json(200, { ok: true, status: "cancelled" }) : fail(503, "OUTCOME_UNKNOWN");
    if (!row || typeof row.reservation_id !== "string" || !UUID_RE.test(row.reservation_id) || typeof row.created !== "boolean") return fail(503, "OUTCOME_UNKNOWN");
    return json(200, { ok: true, reservationId: row.reservation_id, status: String(row.status), created: row.created });
  };
}
