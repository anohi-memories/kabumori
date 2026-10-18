// Send port of the manual X single post (F1, source-only, 2026-10-18).
//
// This file is the ONLY place where a future owner connects the real send. Today nothing is connected:
// `getManualPublishPort()` returns the unconnected port, whose readiness is `not_connected`, so the screen can
// show the input, the preview and the pre-send confirmation but never offers a working send button, and no
// network, Supabase, Edge or SNS call exists anywhere in this feature.
//
// The shape of the real send is the F3 contract (Draft PR #272, supabase/functions/_shared/postona_reservations/
// single_post_contract.ts and docs/postona/x-single-post-m1-20261018.md section 2). `single-post-contract.ts`
// restates it for the app, and `single-post-port.ts` is an adapter that turns it into this port with an INJECTED
// transport (no network client lives in this feature). Other unmerged owners:
//   G4  X credential / verified identity  supabase/functions/_shared/postona_reservations/x_credential_contract.ts
//       (PR #257, `XPostingCredentialSource`; Issue #131 is deferred by the owner, so `available` is false today)
//   F5  active POSTONA entitlement + T13 + publish-enabled guard
//       supabase/candidates/postona_x_publish_entitlement/ (PR #182),
//       supabase/candidates/postona_x_oauth_t13_guard/ (PR #257),
//       supabase/candidates/postona_x_publish_enabled_t13_guard/ (PR #262)
//
// What a connected port must guarantee (the screen relies on it and re-checks nothing it cannot know):
//   - `checkReadiness` is answered by the SERVER chain (JWT -> POSTONA entitlement active -> account owner ->
//     T13 -> publish enabled), for exactly the account asked about. The screen never derives readiness from
//     `SocialAccount.connectionStatus`, which is a cached display value.
//   - `send` carries `target.targetId` as the idempotency key (the server's `clientRequestId`): a retry of the
//     SAME attempt resends the SAME id, so the server never sends twice. It also carries the user's explicit,
//     per-action consent bound to the exact text (`consent.contentSha256`). It never throws for a provider
//     answer; a thrown error is treated as `uncertain`.
//   - Nothing here, and nothing a port returns, may contain a token or other credential.

/** The user's explicit consent for THIS text, now: set only by the confirmation checkbox, bound to the text's hash. */
export type ManualPublishConsent = Readonly<{ confirmed: true; contentSha256: string }>;

/**
 * Structurally the provider domain's publication target plus the per-action consent (the app copy of that
 * model is deliberately imported by no app source yet -- a guard test enforces it -- so the shapes are
 * restated here). `targetId` is the idempotency key of one attempt and must be a lowercase UUID.
 */
export type ManualPublishTarget = Readonly<{
  targetId: string;
  provider: 'x';
  connectedAccountId: string;
  renderedText: string;
  media: readonly never[];
  consent: ManualPublishConsent;
}>;

/**
 * How the server says a stored result came to be (F3 PR #278, M1-F1 / M1-F3). Missing marks are NOT "real":
 *   simulated    only `false` means "the server recorded this from the real X transport". Anything else (true,
 *                a missing mark, a malformed one) is a test result -- a simulated `published` is never shown as a
 *                real post.
 *   afterFreeze  only `true` means "recorded after the workspace / service was no longer active" (a post that was
 *                already in flight when the person was frozen). It never turns an unknown result into a success.
 */
export type ResultMarks = Readonly<{ simulated: boolean; afterFreeze: boolean }>;

/**
 * What the port tells the screen about one send. Mirrors the F3 answer kinds:
 *   published    the server stored X's post id and read it back          (F3 sent)
 *   pending      NOT sent yet (busy / in progress): retry the SAME id      (F3 pending)
 *   rejected     provably not posted                                       (F3 failed)
 *   refused      a 4xx: nothing was written                                (F3 refused)
 *   uncertain    X may have posted: never resend automatically             (F3 uncertain)
 *   unavailable  503 / transport / malformed: nothing known; retry the SAME id (F3 unavailable)
 */
export type ManualPublishOutcome =
  | Readonly<{ kind: 'published'; targetId: string; providerPostId: string; marks?: ResultMarks }>
  | Readonly<{ kind: 'pending'; targetId: string; code: string | null; marks?: ResultMarks }>
  | Readonly<{ kind: 'rejected'; targetId: string; code: string; marks?: ResultMarks }>
  | Readonly<{ kind: 'refused'; targetId: string; code: string; retryable: boolean }>
  | Readonly<{ kind: 'uncertain'; targetId: string; code: string; marks?: ResultMarks }>
  | Readonly<{ kind: 'unavailable'; targetId: string; code: string | null }>;

/** A readiness answer older than this is not trusted any more; the screen asks again before sending. */
export const READINESS_MAX_AGE_MS = 60_000;

export type PortReadiness =
  | Readonly<{ kind: 'not_connected' }>
  | Readonly<{ kind: 'unavailable'; code: string }>
  | Readonly<{ kind: 'ready' }>;

/** The answer is bound to the exact account that was asked about and to the time it was received. */
export type ReadinessRecord = Readonly<{ accountId: string; checkedAt: number; result: PortReadiness }>;

export interface ManualPublishPort {
  checkReadiness(accountId: string): Promise<PortReadiness>;
  send(target: ManualPublishTarget): Promise<ManualPublishOutcome>;
}

/**
 * The port of this build. `send` is never reachable through the screen (the gate refuses first); if it were
 * called anyway it answers "refused, nothing written" -- true, because nothing is sent -- and never `published`.
 */
export const UNCONNECTED_MANUAL_PUBLISH_PORT: ManualPublishPort = Object.freeze({
  checkReadiness: (): Promise<PortReadiness> => Promise.resolve({ kind: 'not_connected' }),
  send: (target: ManualPublishTarget): Promise<ManualPublishOutcome> =>
    Promise.resolve({ kind: 'refused', targetId: target.targetId, code: 'PORT_NOT_CONNECTED', retryable: false }),
});

/** The single seam an owner replaces when the real path exists. */
export function getManualPublishPort(): ManualPublishPort {
  return UNCONNECTED_MANUAL_PUBLISH_PORT;
}
