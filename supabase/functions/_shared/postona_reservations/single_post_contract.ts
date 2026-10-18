/**
 * The send port of the POSTONA X single manual post, for the app (F1 owns the screen; F3 SOURCE CANDIDATE, 2026-10-18).
 *
 *   POST {SUPABASE_URL}/functions/v1/postona-x-single-post      (gate OFF: every call answers 503 NOT_AVAILABLE)
 *   Authorization: Bearer <the signed-in person's own access token>   (the person is ONLY the token's user)
 *   body (exactly these keys): singlePostRequest(...) =
 *     { socialAccountId, clientRequestId, text, consent: { confirmed: true, contentSha256 } }
 *       socialAccountId  the person's own X account id as the server listed it (a selector, never proof)
 *       clientRequestId  a fresh UUID per tap; resend the SAME id on a retry (the server never sends twice)
 *       text             exactly the text shown in the confirmation
 *       contentSha256    hex SHA-256 of that exact text: the per-action consent ("this text, now")
 * singlePostResultOf(status, body):
 *   sent{xPostId}  the server stored X's post id and read it back            -> show as posted
 *   pending        not sent yet (busy / in progress): retry with the same id -> show "not posted yet"
 *   failed{code}   provably not posted (X refused, permission changed)       -> show the reason
 *   uncertain      the X outcome is unknown: NEVER resend automatically       -> ask the person to check X
 *   refused{code, retryable}  4xx: nothing was written (sign-in, service, account, consent, text)
 *   unavailable    503 / transport / anything malformed: nothing is known to be sent -> retry with the same id
 * Every sent / pending / failed / uncertain result also carries (M1-F1 / M1-F3, 006):
 *   simulated     true unless the server says the stored result came from the real X transport (a missing mark is
 *                 true): a simulated "sent" is a test result, never shown as a real post
 *   afterFreeze   true when the server recorded the result while the workspace / service was no longer active (a post
 *                 already in flight when the person was frozen or the service ended): show it as posted, flagged
 * A mock / local answer is never evidence of a real X post.
 */
export const SINGLE_POST_FUNCTION = "postona-x-single-post";

export type SinglePostRequest = { socialAccountId: string; clientRequestId: string; text: string; consent: { confirmed: true; contentSha256: string } };

export function singlePostRequest(input: { socialAccountId: string; clientRequestId: string; text: string; contentSha256: string }): SinglePostRequest {
  return { socialAccountId: input.socialAccountId, clientRequestId: input.clientRequestId, text: input.text, consent: { confirmed: true, contentSha256: input.contentSha256 } };
}

export type SinglePostMarks = { simulated: boolean; afterFreeze: boolean };
export type SinglePostResult =
  | ({ kind: "sent"; reservationId: string; xPostId: string } & SinglePostMarks)
  | ({ kind: "pending" | "failed" | "uncertain"; reservationId: string; code: string | null } & SinglePostMarks)
  | { kind: "refused"; code: string; retryable: boolean }
  | { kind: "unavailable"; code: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const POST_ID_RE = /^[0-9]{1,30}$/u;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const RETRYABLE = new Set(["POSTONA_RESV_SERVICE_BUSY", "AUTH_REQUIRED", "POSTONA_RESV_AUTH_REQUIRED"]);

export function singlePostResultOf(status: number, body: unknown): SinglePostResult {
  const data = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const code = typeof data.code === "string" && CODE_RE.test(data.code) ? data.code : null;
  if (status === 200 && data.ok === true && typeof data.reservationId === "string" && UUID_RE.test(data.reservationId)) {
    const marks: SinglePostMarks = { simulated: data.simulated !== false, afterFreeze: data.afterFreeze === true };
    if (data.status === "sent") {
      return typeof data.xPostId === "string" && POST_ID_RE.test(data.xPostId) ? { kind: "sent", reservationId: data.reservationId, xPostId: data.xPostId, ...marks } : { kind: "unavailable", code: null };
    }
    if (data.status === "pending" || data.status === "failed" || data.status === "uncertain") return { kind: data.status, reservationId: data.reservationId, code, ...marks };
    return { kind: "unavailable", code: null };
  }
  if (status >= 400 && status < 500 && data.ok === false && code) return { kind: "refused", code, retryable: RETRYABLE.has(code) };
  return { kind: "unavailable", code: data.ok === false ? code : null };
}
