// Kabumori's view of the common-account enrollment of the current session. The app (and its side
// effects: push-token registration, notification routing) opens only on a positive, settled "ready" for
// the exact current person and login -- never merely because no error is known yet (pending, retrying,
// refused or failed states give no session to side effects), and never because another login of the same
// person was ready. `sessionId` is the login's id taken from its access token (loginSessionIdOf); a token
// refresh keeps it, a new sign-in changes it.
import type { EnrollmentOutcome } from './service-enrollment';

/** A decided enrollment that is not "ready": the app must not open for this session. */
export type ServiceAccess = Exclude<EnrollmentOutcome, { kind: 'ready' }>;

export type ServiceState =
  | { phase: 'signed_out' }
  | { phase: 'pending'; userId: string; sessionId: string | null; request: number }
  | { phase: 'ready'; userId: string; sessionId: string | null; request: number }
  | { phase: 'refused'; userId: string; sessionId: string | null; request: number; access: ServiceAccess }
  | { phase: 'failed'; userId: string; sessionId: string | null; request: number; message: string };

/**
 * The session that may drive Kabumori and its side effects, or null. `sessionId` is the current session's
 * login; a login that cannot be identified (null) is never ready.
 */
export function serviceReadySession<S extends { user: { id: string } }>(
  session: S | null,
  sessionId: string | null,
  loading: boolean,
  state: ServiceState,
): S | null {
  if (!session || sessionId === null || loading) return null;
  return state.phase === 'ready' && state.userId === session.user.id && state.sessionId === sessionId ? session : null;
}

export function serviceAccessOf(state: ServiceState): ServiceAccess | null {
  return state.phase === 'refused' ? state.access : null;
}

export function serviceFailureOf(state: ServiceState): string | null {
  return state.phase === 'failed' ? state.message : null;
}
