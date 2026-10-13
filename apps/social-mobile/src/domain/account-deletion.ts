/** Shared context helpers. The legacy login-deleting POSTONA route is retired. */
export type ReauthMethod = 'email' | 'x' | 'google' | 'apple';
export type DeletionContext = { userId: string; sessionId: string };
export type DeletionAvailability = 'available' | 'setup_pending';
/** Compatibility only: no old environment flag can reopen the retired route. */
export function deletionAvailability(_input: { enabledFlag?: string; backendAvailable: boolean }): DeletionAvailability {
  return 'setup_pending';
}
export function sameDeletionContext(expected: DeletionContext | null, current: { userId: string | null; sessionId: string | null }): boolean {
  return expected !== null && Boolean(expected.userId && expected.sessionId) && current.userId === expected.userId && current.sessionId === expected.sessionId;
}
export function reauthMethods(linkedProviders: readonly string[], usable: (method: ReauthMethod) => boolean): ReauthMethod[] {
  return (['email', 'x', 'google', 'apple'] as const).filter((method) => linkedProviders.includes(method) && usable(method));
}
export function deletionNeedsFreshReauth(code: string): boolean {
  return ['AUTH_REQUIRED', 'REAUTH_REQUIRED', 'SESSION_CHANGED', 'LIFECYCLE_CHANGED', 'REMOTE_UNVERIFIED_ACK_REQUIRED', 'ACKNOWLEDGEMENT_INVALID'].includes(code);
}
