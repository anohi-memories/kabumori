import assert from 'node:assert/strict';
import test from 'node:test';

import { appleClientSecret, appleConfigFrom, revokeAppleGrant, type AppleConfig } from './apple_revoke.ts';

async function fixtureConfig(): Promise<{ config: AppleConfig; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
  return { config: { teamId: 'TEAMFIXTURE', keyId: 'KEYFIXTURE', clientId: 'jp.example.fixture', privateKeyPem: pem }, publicKey: pair.publicKey };
}

const idToken = (sub: string) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/u, '')}.s`;
const decode = (part: string) => JSON.parse(atob(part.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));

test('client secret is a valid ES256 JWT for the configured team/key/client, five minutes', async () => {
  const { config, publicKey } = await fixtureConfig();
  const secret = await appleClientSecret(config, 1000);
  const [header, payload, signature] = secret.split('.');
  assert.deepEqual(decode(header), { alg: 'ES256', kid: 'KEYFIXTURE', typ: 'JWT' });
  assert.deepEqual(decode(payload), { iss: 'TEAMFIXTURE', iat: 1000, exp: 1300, aud: 'https://appleid.apple.com', sub: 'jp.example.fixture' });
  const raw = Uint8Array.from(atob(signature.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(signature.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, raw, new TextEncoder().encode(`${header}.${payload}`)));
});

test('exchange then revoke the refresh token; any Apple failure is a failure', async () => {
  const { config } = await fixtureConfig();
  const calls: { url: string; form: URLSearchParams }[] = [];
  const fetchOk = async (url: string, init?: RequestInit) => {
    calls.push({ url, form: new URLSearchParams(String(init?.body)) });
    return url.endsWith('/auth/token') ? Response.json({ refresh_token: 'FAKE_APPLE_REFRESH', access_token: 'FAKE_APPLE_ACCESS', id_token: idToken('apple-sub-1') }) : new Response(null, { status: 200 });
  };
  assert.equal(await revokeAppleGrant(config, 'code-1', ['apple-sub-1'], 1000, fetchOk), true);
  assert.equal(calls[0].url, 'https://appleid.apple.com/auth/token');
  assert.equal(calls[0].form.get('grant_type'), 'authorization_code');
  assert.equal(calls[0].form.get('code'), 'code-1');
  assert.equal(calls[1].url, 'https://appleid.apple.com/auth/revoke');
  assert.equal(calls[1].form.get('token'), 'FAKE_APPLE_REFRESH');
  assert.equal(calls[1].form.get('token_type_hint'), 'refresh_token');
  assert.equal(calls[1].form.get('client_id'), 'jp.example.fixture');

  const exchangeFails = async () => new Response('{}', { status: 400 });
  assert.equal(await revokeAppleGrant(config, 'bad', ['apple-sub-1'], 1000, exchangeFails), false);
  const noToken = async () => Response.json({ id_token: idToken('apple-sub-1') });
  assert.equal(await revokeAppleGrant(config, 'c', ['apple-sub-1'], 1000, noToken), false);
  const revokeFails = async (url: string) => url.endsWith('/auth/token') ? Response.json({ access_token: 'A', id_token: idToken('apple-sub-1') }) : new Response(null, { status: 500 });
  assert.equal(await revokeAppleGrant(config, 'c', ['apple-sub-1'], 1000, revokeFails), false);
});

test('a code for another Apple ID (or without an id_token) is never revoked', async () => {
  const { config } = await fixtureConfig();
  for (const body of [{ refresh_token: 'R', id_token: idToken('someone-else') }, { refresh_token: 'R' }, { refresh_token: 'R', id_token: 'garbage' }]) {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => { urls.push(url); return url.endsWith('/auth/token') ? Response.json(body) : new Response(null, { status: 200 }); };
    assert.equal(await revokeAppleGrant(config, 'code', ['apple-sub-1'], 1000, fetchImpl), false);
    assert.deepEqual(urls, ['https://appleid.apple.com/auth/token'], 'no revoke call');
  }
});

test('config: all four values or unavailable', () => {
  const env: Record<string, string> = { APPLE_TEAM_ID: 't', APPLE_KEY_ID: 'k', APPLE_CLIENT_ID: 'c', APPLE_PRIVATE_KEY: 'p' };
  assert.ok(appleConfigFrom((name) => env[name]));
  for (const missing of Object.keys(env)) {
    assert.equal(appleConfigFrom((name) => (name === missing ? '  ' : env[name])), null, missing);
  }
});
