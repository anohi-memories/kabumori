// The app's copy of the F3 single-post contract (F1, source-only, 2026-10-18). NOTHING here calls the network.
//
// Source of truth (F3, Draft PR #272, head 559b3e54f04a89ffe23ebbf54d71857ad064b1e7, unmerged):
//   supabase/functions/_shared/postona_reservations/single_post_contract.ts   (singlePostRequest / singlePostResultOf)
//   supabase/functions/_shared/postona_reservations/single_post.ts            (the server flow and its rules)
//   docs/postona/x-single-post-m1-20261018.md section 2                       (the contract for this screen)
// The functions below are line-for-line the same decisions as F3's two functions (types adapted to the app).
// `tests/manual-publish-contract-parity.test.mjs` compares them with F3's file as soon as it exists in the tree.
//
//   POST {SUPABASE_URL}/functions/v1/postona-x-single-post       (gate OFF: every call answers 503 NOT_AVAILABLE)
//   Authorization: Bearer <the signed-in person's own access token>   (the person is ONLY the token's user)
//   body (exactly these keys): { socialAccountId, clientRequestId, text, consent: { confirmed: true, contentSha256 } }
//     socialAccountId  the person's own X account id as the server listed it (a selector, never proof)
//     clientRequestId  a lowercase UUID, ONE per attempt; a retry of the same attempt resends the SAME id
//     text             exactly the text shown in the confirmation
//     contentSha256    lowercase hex SHA-256 (UTF-8) of that exact text: the per-action consent "this text, now"
//
// F3 answer -> what the screen may say (the only mapping; see outcomeOfSinglePost):
//   sent{xPostId}    published    the server stored X's post id AND read it back
//   pending          pending      NOT sent yet (busy / in progress): the same id may be retried; it may still be in flight
//   failed{code}     rejected     provably not posted
//   uncertain        uncertain    X may have posted: NEVER resend automatically
//   refused{code}    refused      4xx: nothing was written
//   unavailable      unavailable  503 / transport / malformed: nothing is known; retry with the SAME id
// A mock or local answer is never evidence of a real X post.

import type { ManualPublishOutcome } from './manual-publish-port.ts';

export const SINGLE_POST_FUNCTION = 'postona-x-single-post';

export type SinglePostRequest = Readonly<{
  socialAccountId: string;
  clientRequestId: string;
  text: string;
  consent: Readonly<{ confirmed: true; contentSha256: string }>;
}>;

export function singlePostRequest(input: { socialAccountId: string; clientRequestId: string; text: string; contentSha256: string }): SinglePostRequest {
  return { socialAccountId: input.socialAccountId, clientRequestId: input.clientRequestId, text: input.text, consent: { confirmed: true, contentSha256: input.contentSha256 } };
}

export type SinglePostResult =
  | Readonly<{ kind: 'sent'; reservationId: string; xPostId: string }>
  | Readonly<{ kind: 'pending' | 'failed' | 'uncertain'; reservationId: string; code: string | null }>
  | Readonly<{ kind: 'refused'; code: string; retryable: boolean }>
  | Readonly<{ kind: 'unavailable'; code: string | null }>;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const ACCOUNT_RE = /^[A-Za-z0-9_:-]{1,128}$/u;
export const SHA_RE = /^[0-9a-f]{64}$/u;
export const POST_ID_RE = /^[0-9]{1,30}$/u;
export const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/u;
/** The server refuses a text longer than this (UTF-16 units) before anything else. */
export const SERVER_TEXT_MAX_UNITS = 2000;
const RETRYABLE = new Set(['POSTONA_RESV_SERVICE_BUSY', 'AUTH_REQUIRED', 'POSTONA_RESV_AUTH_REQUIRED']);

export function singlePostResultOf(status: number, body: unknown): SinglePostResult {
  const data = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const code = typeof data.code === 'string' && CODE_RE.test(data.code) ? data.code : null;
  if (status === 200 && data.ok === true && typeof data.reservationId === 'string' && UUID_RE.test(data.reservationId)) {
    if (data.status === 'sent') {
      return typeof data.xPostId === 'string' && POST_ID_RE.test(data.xPostId)
        ? { kind: 'sent', reservationId: data.reservationId, xPostId: data.xPostId }
        : { kind: 'unavailable', code: null };
    }
    if (data.status === 'pending' || data.status === 'failed' || data.status === 'uncertain') return { kind: data.status, reservationId: data.reservationId, code };
    return { kind: 'unavailable', code: null };
  }
  if (status >= 400 && status < 500 && data.ok === false && code) return { kind: 'refused', code, retryable: RETRYABLE.has(code) };
  return { kind: 'unavailable', code: data.ok === false ? code : null };
}

/**
 * The F3 answer for the attempt `targetId` as a port outcome. `sent` is the ONLY road to `published`, and it
 * already requires the stored X post id the server read back. A `failed`/`uncertain` without a code gets a fixed
 * one so the screen always has something stable to show.
 */
export function outcomeOfSinglePost(targetId: string, result: SinglePostResult): ManualPublishOutcome {
  switch (result.kind) {
    case 'sent':
      return { kind: 'published', targetId, providerPostId: result.xPostId };
    case 'pending':
      return { kind: 'pending', targetId, code: result.code };
    case 'failed':
      return { kind: 'rejected', targetId, code: result.code ?? 'FAILED' };
    case 'uncertain':
      return { kind: 'uncertain', targetId, code: result.code ?? 'UNCERTAIN' };
    case 'refused':
      return { kind: 'refused', targetId, code: result.code, retryable: result.retryable };
    default:
      return { kind: 'unavailable', targetId, code: result.code };
  }
}
