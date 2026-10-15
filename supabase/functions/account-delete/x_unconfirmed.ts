// The X "unconfirmed posts" evidence contract, as the common-account lifecycle consumes it (Phase 10, F5).
//
// F3's saga (PR #204, `social-mobile-account-delete`, J3 V3 R1a) answers a finished X end with the PAIR
//   x_posts_unconfirmed  how many X posts' publish result was never known (the person may have to check X)
//   x_unconfirmed_snapshot  an opaque 64-hex name of that exact evidence set (a SHA-256 over the subject and the
//                           reservation ids), present exactly when the count is
// and keeps the set in its own durable checkpoint until a caller that RECORDED the pair in its own durable state
// acknowledges THAT snapshot:
//   POST /rest/v1/rpc/social_mobile_account_deletion_x_unconfirmed_ack  { p_user_id, p_snapshot }   (service_role)
// A bare count names no set (two different sets of one size are indistinguishable: ABA), so the former count-only call
// clears NOTHING (`snapshot_required`).
//
// A function bundle cannot import another function's source, so the two small mappers are mirrored here; the
// integrated test (supabase/tests/common_account_phase8_integrated_test.ts, I0) holds each equal to F3's own mapper on
// every answer the saga can give.

export const SNAPSHOT_PATTERN = /^[0-9a-f]{64}$/u;

/** How many times one end re-records and re-acknowledges when the saga's set changed under it, before it stops. */
export const ACK_ROUNDS = 3;

/** The pair of one answer. `null` = the saga reported none; 'invalid' = a count without its name, or the reverse. */
export type XUnconfirmedPair = { count: number; snapshot: string };

export function xUnconfirmedPairOf(count: unknown, snapshot: unknown): XUnconfirmedPair | null | 'invalid' {
  if (count === undefined && snapshot === undefined) return null;
  if (!(typeof count === 'number' && Number.isInteger(count) && count > 0)) return 'invalid';
  if (typeof snapshot !== 'string' || !SNAPSHOT_PATTERN.test(snapshot)) return 'invalid';
  return { count, snapshot };
}

/** The ACK arguments: the person and the exact snapshot the caller recorded. Never a bare count. */
export function xUnconfirmedAckArgs(userId: string, snapshot: string): { p_user_id: string; p_snapshot: string } {
  if (!SNAPSHOT_PATTERN.test(snapshot)) throw new Error('X_UNCONFIRMED_SNAPSHOT_INVALID');
  return { p_user_id: userId, p_snapshot: snapshot };
}

export type XUnconfirmedAckOutcome =
  /** that exact set is cleared (replay = it already was; nothing cleared again) */
  | { status: 'acknowledged'; cleared: number; replay: boolean }
  /** the set is not the one recorded: nothing cleared; record the NEW pair first, then acknowledge THAT snapshot.
   *  count 0 + null snapshot = the saga holds nothing any more. */
  | { status: 'snapshot_changed'; count: number; snapshot: string | null }
  /** a deletion of this person is running at the saga: nothing cleared */
  | { status: 'deletion_in_progress' }
  /** the count-only form: it clears nothing */
  | { status: 'snapshot_required' }
  /** anything else: nothing is known to be cleared; the saga keeps over-reporting */
  | { status: 'failed' };

export function xUnconfirmedAckOutcomeOf(body: unknown): XUnconfirmedAckOutcome {
  const data = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : null);
  switch (data.status) {
    case 'acknowledged': {
      const cleared = count(data.cleared);
      return cleared !== null && cleared > 0 && typeof data.replay === 'boolean'
        ? { status: 'acknowledged', cleared, replay: data.replay } : { status: 'failed' };
    }
    case 'snapshot_changed': {
      const current = count(data.x_posts_unconfirmed);
      const snapshot = data.x_unconfirmed_snapshot;
      if (current === 0 && snapshot === null) return { status: 'snapshot_changed', count: 0, snapshot: null };
      return current !== null && current > 0 && typeof snapshot === 'string' && SNAPSHOT_PATTERN.test(snapshot)
        ? { status: 'snapshot_changed', count: current, snapshot } : { status: 'failed' };
    }
    case 'deletion_in_progress': return { status: 'deletion_in_progress' };
    case 'snapshot_required': return { status: 'snapshot_required' };
    default: return { status: 'failed' };
  }
}
