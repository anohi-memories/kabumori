import assert from 'node:assert/strict';
import test from 'node:test';

import { CORS_HEADERS, createHandler, sha256Hex } from './http.ts';

const env = (values: Record<string, string>) => ({ get: (name: string) => values[name] });
const FULL = { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', X_CLIENT_ID: 'x-id', X_CLIENT_SECRET: 'x-secret' };

test('H2 R6: CORS preflight and CORS headers on every response', async () => {
  const handler = createHandler(env(FULL), async () => { throw new Error('no network in this test'); });
  const preflight = await handler(new Request('https://fn.example/x', {
    method: 'OPTIONS',
    headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, apikey, content-type' },
  }));
  assert.equal(preflight.status, 204);
  for (const [name, value] of Object.entries(CORS_HEADERS)) assert.equal(preflight.headers.get(name), value);
  for (const header of ['authorization', 'apikey', 'content-type']) assert.ok(preflight.headers.get('Access-Control-Allow-Headers')!.includes(header));
  const get = await handler(new Request('https://fn.example/x'));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Access-Control-Allow-Origin'), '*');
  const missing = await createHandler(env({}))(new Request('https://fn.example/x', { method: 'POST', body: '{}' }));
  assert.equal(missing.status, 500);
  assert.equal(missing.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(await missing.json(), { ok: false, error: 'FAILED' });
});

test('routing: preview uses the caller token only; unknown actions refused', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-1', identities: [{ provider: 'email', id: 'user-1' }] });
    if (url.endsWith('/rest/v1/rpc/social_mobile_account_deletion_preview')) return Response.json({ state: 'none', scope: 'social_only', apple_revoked: false });
    return new Response(null, { status: 500 });
  };
  const handler = createHandler(env(FULL), fetchImpl);
  const response = await handler(new Request('https://fn.example/x', { method: 'POST', headers: { Authorization: 'Bearer token-1' }, body: JSON.stringify({ action: 'preview', user_id: 'victim' }) }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(await response.json(), { ok: true, scope: 'social_only', state: 'none', apple_supported: true, apple_code_required: false });
  assert.deepEqual(calls.find((call) => call.url.includes('/rpc/'))?.body, { p_user_id: 'user-1' });
  const unknown = await handler(new Request('https://fn.example/x', { method: 'POST', body: JSON.stringify({ action: 'drop' }) }));
  assert.equal(unknown.status, 400);
});

test('DB error text is reduced to our own fixed codes', async () => {
  const fetchImpl = async (url: string) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-1', identities: [] });
    return Response.json({ message: 'boom secret-ish detail' }, { status: 500 });
  };
  const response = await createHandler(env(FULL), fetchImpl)(new Request('https://fn.example/x', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify({ action: 'preview' }) }));
  assert.deepEqual(await response.json(), { ok: false, error: 'FAILED' });
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
