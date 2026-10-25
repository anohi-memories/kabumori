export type OAuthReturn =
  | { kind: 'success'; code: string; state: string }
  | { kind: 'cancelled' };

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function base64ToBase64Url(value: string): string {
  return value.replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

export function parseOAuthReturn(
  callbackUrl: string,
  redirectUri: string,
  expectedState: string,
): OAuthReturn {
  let callback: URL;
  let redirect: URL;
  try {
    callback = new URL(callbackUrl);
    redirect = new URL(redirectUri);
  } catch {
    throw new Error('OAUTH_CALLBACK_URL_INVALID');
  }

  if (
    callback.protocol !== redirect.protocol ||
    callback.hostname !== redirect.hostname ||
    callback.port !== redirect.port ||
    callback.pathname !== redirect.pathname
  ) {
    throw new Error('OAUTH_CALLBACK_REDIRECT_MISMATCH');
  }

  const state = callback.searchParams.get('state');
  if (!state || state !== expectedState) throw new Error('OAUTH_STATE_MISMATCH');

  const providerError = callback.searchParams.get('error');
  if (providerError === 'access_denied') return { kind: 'cancelled' };
  if (providerError) throw new Error('OAUTH_PROVIDER_RETURNED_ERROR');

  const code = callback.searchParams.get('code');
  if (!code) throw new Error('OAUTH_CALLBACK_CODE_MISSING');
  return { kind: 'success', code, state };
}

function httpStatusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { context?: unknown; status?: unknown };
  return typeof record.status === 'number'
    ? record.status
    : typeof record.context === 'object' && record.context !== null &&
        typeof (record.context as { status?: unknown }).status === 'number'
    ? (record.context as { status: number }).status
    : null;
}

export function isRetryableOAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { name?: unknown };
  const status = httpStatusOf(error);
  if (status === 429 || (status !== null && status >= 500)) return true;
  return record.name === 'FunctionsFetchError' || record.name === 'TypeError';
}

/**
 * What the person can do after a failed connect / disconnect (x-oauth-connect-user's statuses, G4-41):
 * retry the same thing, sign in again (401), stop because the workspace cannot take an X connection yet (409),
 * or start over (everything else).
 */
export type XConnectFailure = 'retryable' | 'session_required' | 'workspace_blocked' | 'restart';

export function classifyXConnectFailure(error: unknown): XConnectFailure {
  if (isRetryableOAuthError(error)) return 'retryable';
  const status = httpStatusOf(error);
  if (status === 401) return 'session_required';
  if (status === 409) return 'workspace_blocked';
  return 'restart';
}

// disconnect_social_mobile_x_connection is called as an RPC (no Edge in between), so it is classified by the RPC's own code
// (the same code sets as x-oauth-connect-user's rpcRefusalStatus) and PostgREST's status.
const SESSION_REFUSALS = new Set(['SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED', 'SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE']);
const WORKSPACE_REFUSALS = new Set([
  'OWN_WORKSPACE_CONFLICT',
  'WORKSPACE_OWNER_UNKNOWN',
  'WORKSPACE_VERDICT_UNKNOWN',
  'OWNER_EPOCH_UNAVAILABLE',
]);

export function classifyXDisconnectFailure(code: string, status: number): XConnectFailure {
  if (status === 429 || status >= 500) return 'retryable';
  if (status === 401 || SESSION_REFUSALS.has(code)) return 'session_required';
  if (WORKSPACE_REFUSALS.has(code)) return 'workspace_blocked';
  return 'restart';
}
