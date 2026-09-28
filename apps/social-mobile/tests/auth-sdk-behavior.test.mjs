// Behavioral tests against the real, locked @supabase/supabase-js with a
// synthetic fetch and in-memory storage. No network, no real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { AUTH_CALLBACK_URL, completeAuthCallback, forgetAuthCallbackOutcomes, parseAuthCallbackUrl } from '../src/domain/auth-flows.ts';
import { createSanitizingStorage, stripProviderCredentials } from '../src/lib/session-storage.ts';

const URL_BASE = 'https://proj.supabase.co';
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;

function memoryStore() {
  const map = new Map();
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: (key) => { map.delete(key); } };
}

function sessionBody(userId, sessionId = 'sess-1') {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: jwt({ sub: userId, session_id: sessionId, exp: now + 3600, aud: 'authenticated', role: 'authenticated' }),
    token_type: 'bearer', expires_in: 3600, expires_at: now + 3600,
    refresh_token: `app-refresh-${userId}`,
    provider_token: 'PROVIDER_ACCESS_SECRET', provider_refresh_token: 'PROVIDER_REFRESH_SECRET',
    user: { id: userId, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-28T00:00:00Z' },
  };
}

/** Synthetic Auth server: records PKCE token exchanges and answers per code. */
function fakeAuth({ answers = {}, delayMs = 0 } = {}) {
  const exchanges = [];
  const verifies = [];
  const fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
      exchanges.push(body);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const answer = answers[body.auth_code];
      if (!answer || answer.error) return Response.json({ code: answer?.error ?? 'bad_code_verifier', msg: 'x' }, { status: 400 });
      if (answer.verifierFor && createHash('sha256').update(body.code_verifier).digest('base64url') !== answer.verifierFor) {
        return Response.json({ code: 'bad_code_verifier', msg: 'x' }, { status: 400 });
      }
      return Response.json(sessionBody(answer.userId));
    }
    if (url.pathname === '/auth/v1/verify') {
      verifies.push(body);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return Response.json(sessionBody('user-otp'));
    }
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    return Response.json({ msg: `unexpected ${url.pathname}` }, { status: 500 });
  };
  return { fetch, exchanges, verifies };
}

function client(store, fetch) {
  return createClient(URL_BASE, 'sb_publishable_test', {
    auth: {
      storage: createSanitizingStorage(store), persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
      flowType: 'pkce', experimental: { appendPkceFlowIdToRedirects: true },
    },
    global: { fetch },
  });
}

async function startOAuth(supabase) {
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true } });
  assert.equal(error, null);
  const authorize = new URL(data.url);
  const redirect = new URL(authorize.searchParams.get('redirect_to'));
  assert.equal(redirect.searchParams.get('sb_flow_id'), data.flowId, 'the flow id round-trips on the redirect');
  return { flowId: data.flowId, challenge: authorize.searchParams.get('code_challenge') };
}

test('provider OAuth credentials are never persisted; the app session still restores', async () => {
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const flow = await startOAuth(client(store, fakeAuth().fetch));
  const server = fakeAuth({ answers: { code1: { userId: 'user-a', verifierFor: flow.challenge } } });
  const supabase = client(store, server.fetch);
  const result = await completeAuthCallback(supabase, parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${flow.flowId}&code=code1`), { flowId: flow.flowId });
  assert.deepEqual(result, { ok: true, userId: 'user-a' });
  const persisted = [...store.map.values()].join('\n');
  assert.doesNotMatch(persisted, /PROVIDER_ACCESS_SECRET|PROVIDER_REFRESH_SECRET|provider_token|provider_refresh_token/u);
  assert.match(persisted, /app-refresh-user-a/u, 'the app session itself is persisted');
  // Restore on a fresh client (app relaunch) from the same storage.
  const { data } = await client(store, server.fetch).auth.getSession();
  assert.equal(data.session?.user.id, 'user-a');
  assert.equal(data.session?.provider_token, undefined);
  // React state gets a copy without provider credentials.
  const inMemory = (await supabase.auth.getSession()).data.session;
  const forState = stripProviderCredentials(inMemory);
  assert.equal(forState.provider_token, undefined);
  assert.equal(forState.provider_refresh_token, undefined);
  assert.equal(forState.access_token, inMemory.access_token);
});

test('concurrent PKCE flows: each callback uses its own verifier by flow id; wrong/stale flow ids fail closed', async () => {
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const starter = client(store, fakeAuth().fetch);
  const a = await startOAuth(starter);
  const b = await startOAuth(starter);
  const c = await startOAuth(starter);
  assert.notEqual(a.flowId, b.flowId);
  const server = fakeAuth({ answers: { codeA: { userId: 'user-a', verifierFor: a.challenge }, codeB: { userId: 'user-b', verifierFor: b.challenge }, codeC: { userId: 'user-c', verifierFor: c.challenge } } });
  const supabase = client(store, server.fetch);
  // A completes after B was started: without the flow id the latest (B) verifier would be sent.
  assert.deepEqual(await completeAuthCallback(supabase, parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${a.flowId}&code=codeA`), { flowId: a.flowId }), { ok: true, userId: 'user-a' });
  assert.deepEqual(await completeAuthCallback(supabase, parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${b.flowId}&code=codeB`), { flowId: b.flowId }), { ok: true, userId: 'user-b' });
  // A callback for another flow than the one this caller started: refused before any exchange.
  const before = server.exchanges.length;
  // C is still pending, so without the check it would really be exchanged.
  const mismatch = await completeAuthCallback(supabase, parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${c.flowId}&code=codeC`), { flowId: a.flowId });
  assert.equal(mismatch.ok, false);
  assert.equal(server.exchanges.length, before);
  forgetAuthCallbackOutcomes();
  assert.deepEqual(await completeAuthCallback(supabase, parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${c.flowId}&code=codeC`), { flowId: c.flowId }), { ok: true, userId: 'user-c' }, 'the refused callback did not consume C');
  // Stale flow (verifier already consumed / never existed): no fallback to another verifier.
  const stale = await completeAuthCallback(supabase, parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${a.flowId}&code=codeA2`));
  assert.equal(stale.ok, false);
  assert.ok(server.exchanges.every((body) => body.auth_code !== 'codeA2'), 'no exchange without the flow\'s own verifier');
  // Malformed flow id or code without flow id: not even parsed.
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=bad!&code=c`), { kind: 'invalid' });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?code=c`), { kind: 'invalid' });
});

test('duplicate callback deliveries share the one real exchange and its real result (failure and success)', async () => {
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const flow = await startOAuth(client(store, fakeAuth().fetch));
  // Failure: the server rejects the exchange; both deliveries must fail, exchange once.
  const failing = fakeAuth({ answers: { dupFail: { error: 'bad_code_verifier' } }, delayMs: 30 });
  const url = `${AUTH_CALLBACK_URL}?sb_flow_id=${flow.flowId}&code=dupFail`;
  const [first, second] = await Promise.all([
    completeAuthCallback(client(store, failing.fetch), parseAuthCallbackUrl(url), { flowId: flow.flowId }),
    completeAuthCallback(client(store, failing.fetch), parseAuthCallbackUrl(url)),
  ]);
  assert.equal(first.ok, false);
  assert.deepEqual(second, first);
  assert.equal(failing.exchanges.length, 1);
  // Success: both get the same successful result, exchange once.
  const flow2 = await startOAuth(client(store, fakeAuth().fetch));
  const ok = fakeAuth({ answers: { dupOk: { userId: 'user-a', verifierFor: flow2.challenge } }, delayMs: 30 });
  const url2 = `${AUTH_CALLBACK_URL}?sb_flow_id=${flow2.flowId}&code=dupOk`;
  const results = await Promise.all([1, 2, 3].map(() => completeAuthCallback(client(store, ok.fetch), parseAuthCallbackUrl(url2))));
  assert.ok(results.every((result) => result.ok && result.userId === 'user-a'));
  assert.equal(ok.exchanges.length, 1);
  // Token-hash (e-mail link) path is shared the same way.
  const otp = fakeAuth({ delayMs: 20 });
  const url3 = `${AUTH_CALLBACK_URL}?token_hash=th1&type=signup`;
  const otpResults = await Promise.all([1, 2].map(() => completeAuthCallback(client(memoryStore(), otp.fetch), parseAuthCallbackUrl(url3))));
  assert.deepEqual(otpResults[0], otpResults[1]);
  assert.equal(otp.verifies.length, 1);
});
