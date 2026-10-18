// Adapter: the F3 single-post contract as a ManualPublishPort (F1, source-only, 2026-10-18).
//
// This is CONNECTION PREPARATION, not a connection. The adapter owns no network client: the HTTP call is an
// INJECTED `transport`, so this file can be proven offline with a scripted transport and the screen still gets
// the unconnected port from `getManualPublishPort()`. Nothing in the app creates this adapter yet.
//
// What it guarantees, whatever the transport answers:
//   - a request is built only from a target that carries a lowercase-UUID attempt id, a well-formed account id,
//     a 1..2000 unit text with no media, and the user's explicit consent whose hash is recomputed here from the
//     exact text (a mismatch is refused LOCALLY and nothing is sent);
//   - the attempt id is passed through unchanged: a retry of the same attempt is the same request id;
//   - the answer is classified by `singlePostResultOf` (F3's own rules): `published` only for a stored X post id;
//     `pending` is "not sent yet / in progress", never "uncertain" and never "posted"; `uncertain` is never retried;
//     a thrown transport or an unreadable answer is `unavailable` (nothing known; retry the SAME id), never
//     `published` and never "provably not posted";
//   - the access token goes only to the transport; it is never put into an outcome, a code or a log.
//
// Readiness: F3 has NO preflight endpoint today (the gate answers 503 NOT_AVAILABLE to every call). Until an
// owner supplies `checkReadiness`, the adapter says `not_connected`, so the send stays disabled.

import { sha256Hex as defaultSha256Hex } from './manual-publish-hash.ts';
import type { ManualPublishOutcome, ManualPublishPort, ManualPublishTarget, PortReadiness } from './manual-publish-port.ts';
import { ACCOUNT_RE, SERVER_TEXT_MAX_UNITS, SHA_RE, SINGLE_POST_FUNCTION, UUID_RE, outcomeOfSinglePost, singlePostRequest, singlePostResultOf, type SinglePostRequest } from './single-post-contract.ts';

export type SinglePostCall = Readonly<{ functionName: typeof SINGLE_POST_FUNCTION; accessToken: string; body: SinglePostRequest }>;
/** The one place a real HTTP client would live. It resolves with the HTTP status and the parsed JSON body (or anything). */
export type SinglePostTransport = (call: SinglePostCall) => Promise<Readonly<{ status: number; body: unknown }>>;

export type SinglePostPortDeps = Readonly<{
  transport: SinglePostTransport;
  /** The signed-in person's own access token, or null when there is none. Never logged, never returned. */
  getAccessToken: () => Promise<string | null>;
  /** Server-side readiness for exactly this account. Absent => `not_connected` (no preflight exists in F3 yet). */
  checkReadiness?: (accountId: string) => Promise<PortReadiness>;
  sha256Hex?: (text: string) => string;
}>;

const refuse = (targetId: string, code: string, retryable = false): ManualPublishOutcome => ({ kind: 'refused', targetId, code, retryable });

export function createSinglePostPort(deps: SinglePostPortDeps): ManualPublishPort {
  const sha256Hex = deps.sha256Hex ?? defaultSha256Hex;
  return {
    async checkReadiness(accountId: string): Promise<PortReadiness> {
      if (!deps.checkReadiness) return { kind: 'not_connected' };
      return deps.checkReadiness(accountId);
    },
    async send(target: ManualPublishTarget): Promise<ManualPublishOutcome> {
      const targetId = typeof target?.targetId === 'string' ? target.targetId : '';
      // 1. Local checks. Nothing has been sent when one of these fails.
      if (!UUID_RE.test(targetId)) return refuse(targetId, 'LOCAL_ATTEMPT_ID_INVALID');
      if (
        target.provider !== 'x' ||
        typeof target.connectedAccountId !== 'string' || !ACCOUNT_RE.test(target.connectedAccountId) ||
        typeof target.renderedText !== 'string' || target.renderedText.length === 0 || target.renderedText.length > SERVER_TEXT_MAX_UNITS ||
        !Array.isArray(target.media) || target.media.length !== 0
      ) return refuse(targetId, 'LOCAL_TARGET_INVALID');
      const consent = target.consent;
      if (!consent || consent.confirmed !== true || typeof consent.contentSha256 !== 'string' || !SHA_RE.test(consent.contentSha256)) return refuse(targetId, 'LOCAL_CONSENT_REQUIRED');
      if (consent.contentSha256 !== sha256Hex(target.renderedText)) return refuse(targetId, 'LOCAL_CONSENT_MISMATCH');
      // 2. The person's own token (no token => no request at all).
      let accessToken: string | null;
      try {
        accessToken = await deps.getAccessToken();
      } catch {
        accessToken = null;
      }
      if (typeof accessToken !== 'string' || accessToken === '') return refuse(targetId, 'LOCAL_AUTH_REQUIRED', true);
      // 3. The one request. From here the server may have acted: a failure to learn the answer is `unavailable`.
      const body = singlePostRequest({ socialAccountId: target.connectedAccountId, clientRequestId: targetId, text: target.renderedText, contentSha256: consent.contentSha256 });
      let answer: Awaited<ReturnType<SinglePostTransport>>;
      try {
        answer = await deps.transport({ functionName: SINGLE_POST_FUNCTION, accessToken, body });
      } catch {
        return { kind: 'unavailable', targetId, code: 'TRANSPORT_FAILED' };
      }
      const status = typeof answer?.status === 'number' ? answer.status : 0;
      return outcomeOfSinglePost(targetId, singlePostResultOf(status, answer?.body));
    },
  };
}
