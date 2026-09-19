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

export function isRetryableOAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { name?: unknown; context?: unknown; status?: unknown };
  const status = typeof record.status === 'number'
    ? record.status
    : typeof record.context === 'object' && record.context !== null &&
        typeof (record.context as { status?: unknown }).status === 'number'
    ? (record.context as { status: number }).status
    : null;
  if (status === 429 || (status !== null && status >= 500)) return true;
  return record.name === 'FunctionsFetchError' || record.name === 'TypeError';
}
