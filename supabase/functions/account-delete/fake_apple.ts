// A mock of Apple's token and revoke endpoints for the account-delete tests (no network, no real
// credential). The token endpoint CONSUMES the single-use code on its first acceptance -- a second
// exchange of the same code is refused with invalid_grant, as Apple does -- and the revoke endpoint can
// apply the revocation and still answer with a gateway error (the H2 rereview R2 counterexample).
import type { AppleConfig } from '../social-mobile-account-delete/apple_revoke.ts';

export const APPLE_SUBJECT = 'apple-subject';

export type ExchangeBehavior =
  | 'ok' | 'invalid_grant' | 'invalid_client' | 'refused_unknown_error' | 'refused_unparsable' | 'server_error' | 'rate_limited'
  | 'throw' | 'hang' | 'no_id_token' | 'wrong_subject' | 'no_token';
export type RevokeBehavior = 'ok' | 'applied_then_502' | 'refused_400' | 'throw' | 'hang';

/** A throwaway P-256 key in PKCS#8 PEM, as Apple issues for Sign in with Apple. Never a real credential. */
export async function fakeAppleConfig(): Promise<AppleConfig> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
  return { teamId: 'FIXTURETEAM', keyId: 'FIXTUREKEY', clientId: 'jp.example.fixture', privateKeyPem: pem };
}

const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');

export function appleServer(options: { exchange?: ExchangeBehavior[]; revoke?: RevokeBehavior[]; onRevoke?: () => void } = {}) {
  const exchange = [...(options.exchange ?? [])];
  const revoke = [...(options.revoke ?? [])];
  const state = {
    exchanges: 0,
    revocations: 0,
    /** Codes Apple has accepted (and so consumed). */
    consumed: new Set<string>(),
    /** Grants Apple actually revoked. */
    revoked: new Set<string>(),
    clientSecrets: [] as string[],
    codesSent: [] as string[],
  };
  const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
  });
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (input === 'https://appleid.apple.com/auth/token') {
      state.exchanges += 1;
      const code = form.get('code') ?? '';
      state.codesSent.push(code);
      state.clientSecrets.push(form.get('client_secret') ?? '');
      if (state.consumed.has(code)) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const behavior = exchange.length ? exchange.shift()! : 'ok';
      switch (behavior) {
        case 'invalid_grant': return Response.json({ error: 'invalid_grant' }, { status: 400 });
        case 'invalid_client': return Response.json({ error: 'invalid_client' }, { status: 401 });
        case 'refused_unknown_error': return Response.json({ error: 'something_new' }, { status: 400 });
        case 'refused_unparsable': return new Response('<html>bad request</html>', { status: 400 });
        case 'server_error': state.consumed.add(code); return new Response('oops', { status: 500 });
        case 'rate_limited': return new Response('slow down', { status: 429 });
        case 'throw': state.consumed.add(code); throw new TypeError('connection reset');
        case 'hang': state.consumed.add(code); return hang(init);
        default: break;
      }
      state.consumed.add(code);
      const idToken = `${b64({ alg: 'RS256' })}.${b64({ sub: behavior === 'wrong_subject' ? 'someone-else' : APPLE_SUBJECT, aud: 'jp.example.fixture' })}.sig`;
      if (behavior === 'no_id_token') return Response.json({ refresh_token: `grant-for-${code}` });
      if (behavior === 'no_token') return Response.json({ id_token: idToken });
      return Response.json({ refresh_token: `grant-for-${code}`, access_token: 'fixture-access', id_token: idToken });
    }
    if (input === 'https://appleid.apple.com/auth/revoke') {
      state.revocations += 1;
      options.onRevoke?.();
      const behavior = revoke.length ? revoke.shift()! : 'ok';
      if (behavior === 'throw') throw new TypeError('connection reset');
      if (behavior === 'hang') return hang(init);
      if (behavior === 'refused_400') return Response.json({ error: 'invalid_request' }, { status: 400 });
      state.revoked.add(form.get('token') ?? '');
      return behavior === 'applied_then_502' ? new Response('bad gateway', { status: 502 }) : new Response(null, { status: 200 });
    }
    return new Response('not apple', { status: 404 });
  };
  return { state, fetchImpl };
}
