/**
 * Password recovery is bound to the exact user AND the exact Supabase
 * session that the recovery link created. Any other session (another user,
 * a new sign-in of the same user, sign-out) ends it, and the binding is
 * re-checked immediately before the password is changed. No runtime imports.
 */

export type RecoverySession = { access_token: string; user: { id: string } };
export type RecoveryBinding = { userId: string; sessionId: string } | null;

/** The Supabase session id claim of an access token (decoded only, never trusted for authorization). */
export function sessionIdOf(session: RecoverySession | null | undefined): string | null {
  const payload = session?.access_token.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')));
    return typeof json?.session_id === 'string' && json.session_id ? json.session_id : null;
  } catch {
    return null;
  }
}

export function bindRecovery(session: RecoverySession | null | undefined): RecoveryBinding {
  const sessionId = sessionIdOf(session);
  return session?.user.id && sessionId ? { userId: session.user.id, sessionId } : null;
}

export function recoveryMatches(binding: RecoveryBinding, session: RecoverySession | null | undefined): boolean {
  return binding !== null && !!session && session.user.id === binding.userId && sessionIdOf(session) === binding.sessionId;
}

/** Next binding after an auth event. PASSWORD_RECOVERY starts a new binding; nothing else creates one. */
export function nextRecoveryBinding(binding: RecoveryBinding, event: string, session: RecoverySession | null | undefined): RecoveryBinding {
  if (event === 'PASSWORD_RECOVERY') return bindRecovery(session);
  if (event === 'SIGNED_OUT' || !recoveryMatches(binding, session)) return null;
  return binding;
}
