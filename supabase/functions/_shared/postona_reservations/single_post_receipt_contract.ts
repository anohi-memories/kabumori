/**
 * PROPOSED read-only receipt for the POSTONA X single post (F3 SOURCE CANDIDATE, 2026-10-19). CONTRACT ONLY: no server,
 * no RPC, no Edge route exists for it. The types and the parser below state what the app may rely on once the owner
 * (F3: the postona_x_resv schema and the postona-x-single-post Edge) implements it in a separately approved TASK.
 *
 * Why: after an app restart the app (F1 PR #283) keeps only { accountId, requestId, contentSha256, kind } -- never the
 * text. Today the only way to learn the result of that attempt is to repeat post_now_begin with the SAME text (its hash
 * must match), because the existing reads do not fit:
 *   - post_now_readback(reservation_id) needs the reservation id (the app does not keep it) and has no Edge route;
 *   - get_reservation / list_reservations return the BODY, no X post id / outcome / marks, and go through
 *     assert_account_access (G4 verified, G5 active) -- so a person whose service ended cannot read a result at all.
 *
 * Proposed request (POST, never GET: nothing in a URL):
 *   POST {SUPABASE_URL}/functions/v1/postona-x-single-post-receipt   Authorization: Bearer <the person's own token>
 *   body exactly: { socialAccountId, clientRequestId }                (no text, no hash)
 * Proposed answers (the same shapes as the send, so singlePostResultOf decides them):
 *   200 { ok: true, status: sent | pending | failed | uncertain, reservationId, xPostId?, code?, simulated, afterFreeze }
 *   404 { ok: false, code: 'POSTONA_RESV_RECEIPT_NOT_FOUND' }   no row for (caller, account, clientRequestId)
 *   401 AUTH_REQUIRED / POSTONA_RESV_AUTH_REQUIRED; 503 unavailable; nothing else.
 * Server rules the implementation must keep (to be proven by the owner's tests; restated in
 * docs/postona/x-single-post-m1-ui-receipt-credential-contract-20261019.md):
 *   R1 read only: never writes, never re-arms, never sends, never turns a claimed row into anything (an expired claim is
 *      answered 'uncertain' LEASE_EXPIRED WITHOUT writing; a live claim is 'pending' IN_PROGRESS);
 *   R2 bound to the verified caller: another person's id, another account or an unknown id all answer the same 404 (no
 *      oracle); the session must be live (T13's session check) but an ended service / unverified X account does NOT
 *      hide the person's own result (F5 to confirm, see the doc);
 *   R3 never returns the text, its hash, a token or the lease;
 *   R4 marks as the send: simulated is false only for a stored real-X transport; afterFreeze as recorded;
 *   R5 404 means "this id was never begun": post_now_begin commits the row before any X call, so no X post exists under
 *      this id -- but a begin may still be in flight, so the app may only retry with the SAME id, never a new one.
 */
import { singlePostResultOf, type SinglePostResult } from "./single_post_contract.ts";

export const SINGLE_POST_RECEIPT_FUNCTION = "postona-x-single-post-receipt";
export const RECEIPT_NOT_FOUND = "POSTONA_RESV_RECEIPT_NOT_FOUND";

export type SinglePostReceiptRequest = { socialAccountId: string; clientRequestId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_RE = /^[A-Za-z0-9_:-]{1,128}$/u;

/** The request body, or null when the ids are not in the server's shape (nothing is sent then). */
export function singlePostReceiptRequest(input: { socialAccountId: string; clientRequestId: string }): SinglePostReceiptRequest | null {
  if (typeof input?.socialAccountId !== "string" || !ACCOUNT_RE.test(input.socialAccountId)) return null;
  if (typeof input?.clientRequestId !== "string" || !UUID_RE.test(input.clientRequestId)) return null;
  return { socialAccountId: input.socialAccountId, clientRequestId: input.clientRequestId };
}

export type SinglePostReceipt =
  | Exclude<SinglePostResult, { kind: "refused" }>
  | { kind: "refused"; code: string; retryable: boolean }
  | { kind: "not_found" };

/** The receipt answer as the app may read it. Only the exact 404 code is "not found"; anything unclear is unavailable. */
export function singlePostReceiptOf(status: number, body: unknown): SinglePostReceipt {
  const data = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (status === 404 && data.ok === false && data.code === RECEIPT_NOT_FOUND) return { kind: "not_found" };
  if (status === 404) return { kind: "unavailable", code: null };
  const result = singlePostResultOf(status, body);
  // A receipt never answers a business refusal other than sign-in: any other 4xx is not a trustworthy answer.
  if (result.kind === "refused" && !result.retryable) return { kind: "unavailable", code: null };
  return result;
}

/** What the app may do next with an unresolved attempt, given its receipt (the only allowed moves). */
/** A simulated `sent` proves nothing about X (as F1 PR #288 keeps it): it stays unresolved like `uncertain`. */
export type ReceiptNextStep = "show_posted" | "retry_same_id" | "keep_unresolved_check_x" | "show_not_posted" | "sign_in" | "ask_again_later";

export function receiptNextStep(receipt: SinglePostReceipt): ReceiptNextStep {
  switch (receipt.kind) {
    case "sent":
      return receipt.simulated ? "keep_unresolved_check_x" : "show_posted";
    case "failed":
      return "show_not_posted";
    case "pending":
    case "not_found":
      return "retry_same_id";
    case "uncertain":
      return "keep_unresolved_check_x";
    case "refused":
      return receipt.retryable ? "sign_in" : "ask_again_later";
    default:
      return "ask_again_later";
  }
}
