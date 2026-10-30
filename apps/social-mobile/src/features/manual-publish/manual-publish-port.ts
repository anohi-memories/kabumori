// Send port of the manual X single post (F1, source-only, 2026-10-18).
//
// This file is the ONLY place where a future owner connects the real send. Today nothing is connected:
// `getManualPublishPort()` returns the unconnected port, whose readiness is `not_connected`, so the screen can
// show the input, the preview and the pre-send confirmation but never offers a working send button, and no
// network, Supabase, Edge or SNS call exists anywhere in this feature.
//
// Hand-off to the F3 / G4 / F5 owners (read-only pointers, not implemented here; all are unmerged Drafts):
//   F3  single-post server path        task postona-f3-m1-single-text-post-offline-end-to-end-20261018
//       X publisher (one POST per target) supabase/functions/_shared/postona_reservations/x_publisher.ts  (PR #224)
//         its result kinds map 1:1 onto ManualPublishOutcome below:
//           published             -> { kind: 'published', providerPostId }
//           rejected_before_send  -> { kind: 'rejected', code }     (provably NOT posted)
//           unknown               -> { kind: 'uncertain', code }    (may have posted; never re-sent blindly)
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
//   - `send` carries `target.targetId` as the idempotency key, so a lost response can be reconciled
//     server-side. It never throws for a provider answer; a thrown error is treated as `uncertain`.
//   - Nothing here, and nothing a port returns, may contain a token or other credential.

/**
 * Structurally identical to the provider domain's PublicationTarget / PublishOutcome (the app copy of that model
 * is deliberately imported by no app source yet -- a guard test enforces it -- so the shapes are restated here).
 * `targetId` is the idempotency key of one attempt.
 */
export type ManualPublishTarget = Readonly<{
  targetId: string;
  provider: 'x';
  connectedAccountId: string;
  renderedText: string;
  media: readonly never[];
}>;

/**
 * published: the provider created the post. rejected: it provably did not. uncertain: it may have (lost
 * response, timeout, ambiguous answer) -- needs reconciliation, never a resend.
 */
export type ManualPublishOutcome =
  | Readonly<{ kind: 'published'; targetId: string; providerPostId: string }>
  | Readonly<{ kind: 'rejected'; targetId: string; code: string }>
  | Readonly<{ kind: 'uncertain'; targetId: string; code: string }>;

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
 * called anyway it answers "rejected before send" -- true, because nothing is sent -- and never `published`.
 */
export const UNCONNECTED_MANUAL_PUBLISH_PORT: ManualPublishPort = Object.freeze({
  checkReadiness: (): Promise<PortReadiness> => Promise.resolve({ kind: 'not_connected' }),
  send: (target: ManualPublishTarget): Promise<ManualPublishOutcome> =>
    Promise.resolve({ kind: 'rejected', targetId: target.targetId, code: 'PORT_NOT_CONNECTED' }),
});

/** The single seam an owner replaces when the real path exists. */
export function getManualPublishPort(): ManualPublishPort {
  return UNCONNECTED_MANUAL_PUBLISH_PORT;
}
