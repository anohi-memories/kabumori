// Sign in with Apple grant revocation for the common-account deletion, with an outcome that never calls an
// uncertain result a failure (PR112 H2 rereview R2). SOURCE CANDIDATE -- not deployed.
//
// The X module's revokeAppleGrant (social-mobile-account-delete/apple_revoke.ts, not edited here) answers a
// boolean: a gateway 502 after Apple already revoked the grant, or a timeout after Apple consumed the
// single-use authorization code, both read "false" there. A deletion must not treat that as "nothing
// happened" and exchange the code again. This adapter reuses that module's client-secret signing and
// answers one of:
//   succeeded            Apple confirmed the revocation (2xx).
//   definitively_failed  nothing reached Apple, or Apple refused the token request itself with an OAuth
//                        error (RFC 6749 section 5.2): the code was not exchanged by this call, so a new
//                        code may be used.
//   unknown              everything else once a request was sent: a transport failure or timeout, a
//                        5xx / 429 / unrecognised answer, and any failure after Apple accepted the code
//                        (it is consumed from then on). The caller keeps its durable intent and asks for
//                        reconciliation; it never sends the code again.
// Nothing is logged; no code, token, subject or key leaves this function.
import { appleClientSecret, type AppleConfig } from '../social-mobile-account-delete/apple_revoke.ts';

export type AppleRevocationOutcome = 'succeeded' | 'definitively_failed' | 'unknown';
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const APPLE = 'https://appleid.apple.com';
/** OAuth 2.0 token-endpoint errors (RFC 6749 section 5.2): the request was refused as such. */
const REFUSED_TOKEN_REQUEST = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope']);
export const APPLE_REQUEST_TIMEOUT_MS = 10_000;

function idTokenSubject(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(atob(part.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
    return typeof claims?.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

async function discard(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

/**
 * Exchanges the authorization code and revokes the resulting grant. The code must belong to one of the
 * person's own Apple identities (the id_token Apple returns over TLS names the subject); otherwise nothing
 * is revoked -- and since Apple has then consumed the code, the outcome is unknown, not a failure.
 */
export async function revokeAppleGrantOutcome(
  config: AppleConfig,
  authorizationCode: string,
  expectedSubjects: readonly string[],
  nowSeconds: number,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = APPLE_REQUEST_TIMEOUT_MS,
): Promise<AppleRevocationOutcome> {
  let clientSecret: string;
  try {
    clientSecret = await appleClientSecret(config, nowSeconds);
  } catch {
    return 'definitively_failed'; // nothing was sent
  }
  const form = (fields: Record<string, string>): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let exchanged: Response;
  try {
    exchanged = await fetchImpl(`${APPLE}/auth/token`, form({
      grant_type: 'authorization_code', code: authorizationCode, client_id: config.clientId, client_secret: clientSecret,
    }));
  } catch {
    return 'unknown'; // sent, answer lost: the code may have been consumed
  }
  if (!exchanged.ok) {
    if (exchanged.status === 400 || exchanged.status === 401) {
      const refusal = await exchanged.json().catch(() => null) as { error?: unknown } | null;
      if (typeof refusal?.error === 'string' && REFUSED_TOKEN_REQUEST.has(refusal.error)) return 'definitively_failed';
      return 'unknown';
    }
    await discard(exchanged);
    return 'unknown';
  }

  // From here Apple has accepted, and consumed, the code: only a confirmed revocation is a success.
  const tokens = await exchanged.json().catch(() => null) as { refresh_token?: unknown; access_token?: unknown; id_token?: unknown } | null;
  const subject = idTokenSubject(tokens?.id_token);
  if (!subject || !expectedSubjects.includes(subject)) return 'unknown';
  const [token, hint] = typeof tokens?.refresh_token === 'string' && tokens.refresh_token ? [tokens.refresh_token, 'refresh_token']
    : typeof tokens?.access_token === 'string' && tokens.access_token ? [tokens.access_token, 'access_token']
    : [null, null];
  if (!token || !hint) return 'unknown';

  let revoked: Response;
  try {
    revoked = await fetchImpl(`${APPLE}/auth/revoke`, form({ client_id: config.clientId, client_secret: clientSecret, token, token_type_hint: hint }));
  } catch {
    return 'unknown';
  }
  await discard(revoked);
  return revoked.ok ? 'succeeded' : 'unknown';
}
