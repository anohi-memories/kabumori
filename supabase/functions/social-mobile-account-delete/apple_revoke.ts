// Sign in with Apple grant revocation for account deletion (App Review
// 5.1.1(v)). SOURCE CANDIDATE. The native ID-token sign-in never stores an
// Apple refresh token, so the app sends a fresh authorization code from a
// native re-authentication; it is exchanged here and the resulting token is
// revoked. The private key never leaves the server and nothing is logged.

export type AppleConfig = { teamId: string; keyId: string; clientId: string; privateKeyPem: string };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const APPLE = 'https://appleid.apple.com';

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const encodeJson = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

async function importKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/gu, '').replace(/\s+/gu, '');
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** ES256 client secret JWT, valid for five minutes. */
export async function appleClientSecret(config: AppleConfig, nowSeconds: number): Promise<string> {
  const header = encodeJson({ alg: 'ES256', kid: config.keyId, typ: 'JWT' });
  const payload = encodeJson({ iss: config.teamId, iat: nowSeconds, exp: nowSeconds + 300, aud: APPLE, sub: config.clientId });
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await importKey(config.privateKeyPem), new TextEncoder().encode(input));
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

export function appleConfigFrom(get: (name: string) => string | undefined): AppleConfig | null {
  const teamId = get('APPLE_TEAM_ID')?.trim();
  const keyId = get('APPLE_KEY_ID')?.trim();
  const clientId = get('APPLE_CLIENT_ID')?.trim();
  const privateKeyPem = get('APPLE_PRIVATE_KEY')?.trim();
  return teamId && keyId && clientId && privateKeyPem ? { teamId, keyId, clientId, privateKeyPem } : null;
}

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

/**
 * Exchanges the authorization code and revokes the grant; true only when Apple
 * confirmed both. The code must belong to one of the user's own Apple
 * identities (the id_token Apple returns directly over TLS names the subject);
 * otherwise nothing is revoked.
 */
export async function revokeAppleGrant(
  config: AppleConfig, authorizationCode: string, expectedSubjects: readonly string[], nowSeconds: number, fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const clientSecret = await appleClientSecret(config, nowSeconds);
  const form = (fields: Record<string, string>) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const exchanged = await fetchImpl(`${APPLE}/auth/token`, form({ grant_type: 'authorization_code', code: authorizationCode, client_id: config.clientId, client_secret: clientSecret }));
  if (!exchanged.ok) return false;
  const tokens = await exchanged.json().catch(() => null) as { refresh_token?: unknown; access_token?: unknown; id_token?: unknown } | null;
  const subject = idTokenSubject(tokens?.id_token);
  if (!subject || !expectedSubjects.includes(subject)) return false;
  const [token, hint] = typeof tokens?.refresh_token === 'string' ? [tokens.refresh_token, 'refresh_token']
    : typeof tokens?.access_token === 'string' ? [tokens.access_token, 'access_token']
    : [null, null];
  if (!token || !hint) return false;
  const revoked = await fetchImpl(`${APPLE}/auth/revoke`, form({ client_id: config.clientId, client_secret: clientSecret, token, token_type_hint: hint }));
  return revoked.ok;
}
