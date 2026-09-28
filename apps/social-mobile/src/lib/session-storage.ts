/**
 * Storage policy for the Supabase client (no runtime imports):
 * - persisted: the Supabase app session (access/refresh token of the app login,
 *   needed for session restore) and PKCE verifier slots/index;
 * - never persisted: OAuth provider credentials (`provider_token`,
 *   `provider_refresh_token`) that Supabase may include in a session. They are
 *   stripped on every write, and from anything put into React state.
 * Posting X credentials never reach the client at all (Vault, server side).
 */

export type KeyValueStore = {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
};

const PROVIDER_FIELDS = ['provider_token', 'provider_refresh_token'] as const;

/** A copy without provider credentials (top level and a nested currentSession). */
export function stripProviderCredentials<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of PROVIDER_FIELDS) delete copy[field];
  if (typeof copy.currentSession === 'object' && copy.currentSession !== null) copy.currentSession = stripProviderCredentials(copy.currentSession);
  return copy as T;
}

/** Stored values that are JSON objects lose provider credentials; everything else is unchanged. */
export function sanitizeStoredValue(value: string): string {
  if (!value.includes('provider_')) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return value;
    return JSON.stringify(stripProviderCredentials(parsed));
  } catch {
    return value;
  }
}

export function createSanitizingStorage(backing: KeyValueStore): KeyValueStore {
  return {
    getItem: (key) => backing.getItem(key),
    setItem: (key, value) => backing.setItem(key, sanitizeStoredValue(value)),
    removeItem: (key) => backing.removeItem(key),
  };
}
