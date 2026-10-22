// G2 QA (Issue #317, task postona-g2-pr426-x-oauth-owner-session-failclosed-regression-qa-20261022) -- QA only.
// G4 PR #426 pins the X connect to the person AND Supabase session that started it. G4's own tests drive the hook with a
// synthetic getSession. This file drives the REAL use-x-connect hook with the REAL locked @supabase/supabase-js client
// (auth-js 2.115.0 getSession / signInWithPassword / signOut / refresh / updateUser, functions-js invoke) over a
// synthetic fetch: a fake Auth server that keeps session ids across refreshes like the real one, and fake X connect
// functions. Offline: no network, no real credential, no X. Whether the REAL server accepts an old token is NOT_VERIFIED.
//
// Part R re-states the G2 #419 (CB5, CB6) and #425 (CX1, CX2) scenarios with the SAFE expectation: they fail on main's
// hook (the old, unsafe behaviour #419 recorded) and pass on #426. The #419 / #425 files themselves are not changed.
// Part S adds real-SDK boundaries: an expired token refreshed while the browser is open, a refresh that fails, a change
// of person during the exchange, a password update in a recovery session, and denial / expiry after a change.
// G2_HOOK_SOURCE=<path> runs the same cases against another copy of the hook (used once for main's hook).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';
import * as oauth from '../src/lib/x-oauth-onboarding.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';

const HOOK_SOURCE = await readFile(process.env.G2_HOOK_SOURCE ?? new URL('../src/features/x-connect/use-x-connect.ts', import.meta.url), 'utf8');
const URL_BASE = 'https://proj.supabase.co';
const STORAGE_KEY = 'sb-proj-auth-token';
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

/** Fake Auth + fake X connect functions. Session ids survive refreshes (like GoTrue); sign-in makes a new one. */
function fakeBackend() {
  let serial = 0;
  const sessions = new Map(); // refresh token -> { userId, sessionId, active }
  const functionCalls = [];
  const authCalls = [];
  const hooks = { onCallback: null, callbackAnswer: () => ({ status: 200, body: { success: true, handle: 'rig_handle' } }) };
  const issue = (userId, sessionId) => {
    serial += 1;
    const now = Math.floor(Date.now() / 1000);
    const refresh = `rig-refresh-${serial}`;
    sessions.set(refresh, { userId, sessionId, active: true });
    return {
      access_token: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: userId, session_id: sessionId, exp: now + 3600, aud: 'authenticated', role: 'authenticated', n: serial })}.sig`,
      token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh,
      user: { id: userId, aud: 'authenticated', role: 'authenticated', email: `${userId}@example.test`, app_metadata: {}, user_metadata: {}, created_at: '2026-09-28T00:00:00Z' },
    };
  };
  const json = (body, status = 200) => Response.json(body, { status, headers: { 'x-supabase-api-version': '2024-01-01' } });
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers));
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.pathname.startsWith('/functions/v1/')) {
      const name = url.pathname.slice('/functions/v1/'.length);
      functionCalls.push({ name, authorization: headers.get('authorization'), body });
      if (name === 'x-oauth-connect-user') return Response.json({ authorization_url: 'https://x.com/i/oauth2/authorize' });
      if (hooks.onCallback) await hooks.onCallback();
      const answer = hooks.callbackAnswer();
      return Response.json(answer.body, { status: answer.status });
    }
    authCalls.push(`${init.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const userId = String(body.email).split('@')[0];
      return json(issue(userId, `sess-${userId}-${serial + 1}`));
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const known = sessions.get(body.refresh_token);
      if (!known || !known.active) return json({ code: 'refresh_token_not_found', msg: 'x' }, 400);
      known.active = false; // rotated
      return json(issue(known.userId, known.sessionId));
    }
    if (url.pathname === '/auth/v1/logout') {
      const claims = claimsOf(headers.get('authorization').slice('Bearer '.length));
      for (const s of sessions.values()) if (s.sessionId === claims.session_id) s.active = false;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/auth/v1/user' && init.method === 'PUT') {
      const claims = claimsOf(headers.get('authorization').slice('Bearer '.length));
      return json({ id: claims.sub, aud: 'authenticated', role: 'authenticated', email: `${claims.sub}@example.test`, app_metadata: {}, user_metadata: { password_set: true }, created_at: '2026-09-28T00:00:00Z' });
    }
    return json({ msg: `unexpected ${url.pathname}` }, 500);
  };
  /** Revoke every refresh token of a session (e.g. "sign out everywhere" from another device). */
  const revoke = (sessionId) => { for (const s of sessions.values()) if (s.sessionId === sessionId) s.active = false; };
  return { fetch, functionCalls, authCalls, hooks, revoke };
}

function memoryStore() { const map = new Map(); return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } }; }

/** The real hook with the real SDK client; useAuth mirrors the client's auth events (as AuthProvider does). */
async function realHook({ browser = 'success', source = HOOK_SOURCE } = {}) {
  const backend = fakeBackend();
  const store = memoryStore();
  const supabase = createClient(URL_BASE, 'sb_publishable_test', { auth: { storage: store, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce' }, global: { fetch: backend.fetch } });
  const ui = { session: null };
  supabase.auth.onAuthStateChange((_event, session) => { ui.session = session; });
  const slots = [];
  let cursor = 0;
  let round = 0;
  let finishBrowser;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback: (cb) => cb,
  };
  const modules = {
    react,
    'react-native': { Platform: { OS: 'android' } },
    'expo-crypto': { getRandomBytesAsync: async (n) => new Uint8Array(n).fill(++round), digestStringAsync: async (_a, v) => createHash('sha256').update(v).digest('base64'), CryptoDigestAlgorithm: { SHA256: 'SHA256' }, CryptoEncoding: { BASE64: 'BASE64' } },
    'expo-linking': { createURL: () => 'kabumori-social://oauth-callback' },
    'expo-web-browser': {
      maybeCompleteAuthSession() {},
      openAuthSessionAsync: (_url, redirect) => new Promise((resolve) => {
        finishBrowser = (kind = browser) => {
          const state = backend.functionCalls.at(-1).body.state;
          resolve(kind === 'cancel' ? { type: 'cancel' } : kind === 'denied' ? { type: 'success', url: `${redirect}?state=${state}&error=access_denied` } : { type: 'success', url: `${redirect}?state=${state}&code=rig_code` });
        };
      }),
    },
    '@/features/x-connect/auth-session-options': { xConnectAuthSessionOptions },
    '@/domain/recovery-binding': recoveryBinding,
    '@/lib/x-oauth-onboarding': oauth,
    '@/providers/auth-provider': { useAuth: () => ({ session: ui.session }) },
    '@/lib/supabase': { supabase },
  };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, URL, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; } }, { filename: 'use-x-connect.ts' });
  let connected = 0;
  const render = () => { cursor = 0; return mod.exports.useXConnect(() => { connected += 1; }); };
  const signIn = async (userId) => { const { error } = await supabase.auth.signInWithPassword({ email: `${userId}@example.test`, password: 'rig-password' }); assert.equal(error, null); await settle(); render(); };
  const signOut = async () => { await supabase.auth.signOut({ scope: 'local' }); await settle(); render(); };
  const current = async () => (await supabase.auth.getSession()).data.session;
  /** Time passes: the stored access token is now expired, so the next getSession refreshes it. */
  const expireStoredToken = () => { const s = JSON.parse(store.getItem(STORAGE_KEY)); s.expires_at = Math.floor(Date.now() / 1000) - 10; store.setItem(STORAGE_KEY, JSON.stringify(s)); };
  /** Start a connect and wait until the browser is open. Returns { running } (a bare promise would be awaited through). */
  const start = async () => { const running = render().connect(); await settle(); assert.equal(backend.functionCalls.length, 1, 'the start request went out'); return { running }; };
  return { backend, supabase, store, render, signIn, signOut, current, expireStoredToken, start, finish: (kind) => finishBrowser(kind), connected: () => connected, settle };
}
const callbackCalls = (h) => h.backend.functionCalls.filter((c) => c.name === 'x-oauth-connect-user/callback');
const sessionIdOfHeader = (call) => claimsOf(call.authorization.slice('Bearer '.length)).session_id;

// ---- Part R: the earlier G2 scenarios, safe expectation ------------------------------------------------------------

test('R-CB5 (G2 #419): B signs in (real SDK) while A\'s X browser is open -- no exchange, no success, no reload', async () => {
  const h = await realHook();
  await h.signIn('user-a');
  const { running } = await h.start();
  await h.signIn('user-b');
  h.finish();
  await running;
  const now = h.render();
  assert.equal(callbackCalls(h).length, 0, 'no exchange');
  assert.notEqual(now.state, 'connected');
  assert.equal(now.verifiedHandle, null);
  assert.equal(h.connected(), 0);
});

test('R-CB6 (G2 #419): A signs out (real SDK) while the browser is open -- no exchange with the signed-out token', async () => {
  const h = await realHook();
  await h.signIn('user-a');
  const { running } = await h.start();
  await h.signOut();
  h.finish();
  await running;
  assert.equal(callbackCalls(h).length, 0);
  assert.equal(h.connected(), 0);
});

test('R-CX1 (G2 #425): sign-out, then the browser is cancelled -- a cancel stays a cancel, no exchange', async () => {
  const h = await realHook();
  await h.signIn('user-a');
  const { running } = await h.start();
  await h.signOut();
  h.finish('cancel');
  await running;
  assert.equal(callbackCalls(h).length, 0);
  assert.equal(h.render().state, 'cancelled');
});

test('R-CX2 (G2 #425, was UNKNOWN): sign-out and the SAME person signs in again (a new session id) -- no exchange with either token, not connected', async () => {
  const h = await realHook();
  await h.signIn('user-a');
  const first = (await h.current()).access_token;
  const { running } = await h.start();
  await h.signOut();
  await h.signIn('user-a');
  assert.notEqual(claimsOf((await h.current()).access_token).session_id, claimsOf(first).session_id, 'a new session of the same person');
  h.finish();
  await running;
  assert.equal(callbackCalls(h).length, 0, 'neither the old nor the new session exchanges a code started by the old one');
  assert.equal(h.render().state, 'session_changed');
  assert.equal(h.connected(), 0);
});

// ---- Part S: real-SDK boundaries -------------------------------------------------------------------------------------

test('G2-OS1 (legitimate): the access token EXPIRES while the browser is open -- the real getSession refreshes it (same session id), the exchange carries the NEW token and the connect succeeds', async () => {
  const h = await realHook();
  await h.signIn('user-a');
  const startToken = (await h.current()).access_token;
  const { running } = await h.start();
  h.expireStoredToken();
  h.finish();
  await running;
  const [call] = callbackCalls(h);
  assert.ok(call, 'the exchange was sent');
  assert.equal(sessionIdOfHeader(call), claimsOf(startToken).session_id, 'same session');
  assert.notEqual(call.authorization, `Bearer ${startToken}`, 'not the expired token');
  assert.ok(h.backend.authCalls.some((c) => c.includes('grant_type=refresh_token')), 'refreshed by the SDK');
  assert.equal(h.render().state, 'connected');
  assert.equal(h.connected(), 1);
});

test('G2-OS2: the token expires while the browser is open AND the session was ended elsewhere ("sign out everywhere") -- the refresh fails, nothing is exchanged, not connected', async () => {
  const h = await realHook();
  await h.signIn('user-a');
  const sessionId = claimsOf((await h.current()).access_token).session_id;
  const { running } = await h.start();
  h.backend.revoke(sessionId);
  h.expireStoredToken();
  h.finish();
  await running;
  assert.equal(callbackCalls(h).length, 0, 'no exchange with a token the server no longer refreshes');
  assert.notEqual(h.render().state, 'connected');
  assert.equal(h.connected(), 0);
});

test('G2-OS3: the person or session changes DURING the exchange (real SDK, inside the server round trip) -- B / sign-out / a new session of A get no success and no reload; a refresh of the same session keeps the success', async () => {
  for (const [label, during, expectConnected] of [
    ['B signs in', (h) => h.signIn('user-b'), false],
    ['sign-out', (h) => h.signOut(), false],
    ['A again, new session', async (h) => { await h.signOut(); await h.signIn('user-a'); }, false],
    ['same session refreshed', async (h) => { h.expireStoredToken(); await h.current(); }, true],
  ]) {
    const h = await realHook();
    await h.signIn('user-a');
    const { running } = await h.start();
    h.backend.hooks.onCallback = () => during(h);
    h.finish();
    await running;
    const now = h.render();
    assert.equal(callbackCalls(h).length, 1, `${label}: the exchange itself was sent by A's session`);
    assert.equal(now.state === 'connected', expectConnected, `${label}: state ${now.state}`);
    assert.equal(now.verifiedHandle !== null, expectConnected, `${label}: handle`);
    assert.equal(h.connected(), expectConnected ? 1 : 0, `${label}: reload`);
  }
});

test('G2-OS4 (recovery session): a password update in the recovery session keeps the session id -- the connect continues; a fresh sign-in after it is a new session -- refused', async () => {
  for (const [label, during, expect] of [
    ['password updated (real updateUser)', async (h) => { const { error } = await h.supabase.auth.updateUser({ password: 'rig-new-password' }); assert.equal(error, null); await h.settle(); h.render(); }, 'connected'],
    ['updated, then signed in again', async (h) => { await h.supabase.auth.updateUser({ password: 'rig-new-password' }); await h.signOut(); await h.signIn('user-a'); }, 'session_changed'],
  ]) {
    const h = await realHook();
    await h.signIn('user-a'); // stands for the recovery session (a session of user-a with its own session id)
    const { running } = await h.start();
    await during(h);
    h.finish();
    await running;
    assert.equal(h.render().state, expect, label);
    assert.equal(callbackCalls(h).length, expect === 'connected' ? 1 : 0, label);
  }
});

test('G2-OS5: denial at X after the person changed stays a cancel (no exchange); an expired-state answer from the server for the same session is an error, never a success', async () => {
  {
    const h = await realHook();
    await h.signIn('user-a');
    const { running } = await h.start();
    await h.signIn('user-b');
    h.finish('denied');
    await running;
    assert.equal(callbackCalls(h).length, 0);
    assert.equal(h.render().state, 'cancelled');
  }
  for (const status of [400, 401]) {
    const h = await realHook();
    await h.signIn('user-a');
    h.backend.hooks.callbackAnswer = () => ({ status, body: { error: 'oauth_state_expired' } });
    const { running } = await h.start();
    h.finish();
    await running;
    const now = h.render();
    assert.equal(callbackCalls(h).length, 1);
    assert.equal(now.state, 'terminal_error', `${status}`);
    assert.equal(h.connected(), 0);
  }
});

// ---- negative controls (AST on this hook) ----------------------------------------------------------------------------
function mutateHook(predicate, replace) {
  const file = ts.createSourceFile('use-x-connect.ts', HOOK_SOURCE, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let n = 0;
  const out = ts.transform(file, [(context) => (root) => ts.visitNode(root, function v(node) { if (predicate(node)) { n += 1; return replace(node); } return ts.visitEachChild(node, v, context); })]);
  return { text: ts.createPrinter().printFile(out.transformed[0]), n };
}

test('negative controls (heads with the owner checks): each removed check is caught -- the exchange-time check (R-CB5 sees an exchange), the success-time check (G2-OS3 sees a success for B), the current token (G2-OS1 sees the expired token)', { skip: HOOK_SOURCE.includes('isConnectOwner(') ? false : 'no owner checks on this head' }, async () => {
  const f = ts.factory;
  const cases = [
    ['exchange-time check removed', (n) => ts.isIfStatement(n) && n.expression.getText() === '!isConnectOwner(owner, exchangeSession)', () => f.createEmptyStatement(), 'R-CB5'],
    ['success-time check removed', (n) => ts.isIfStatement(n) && n.expression.getText() === '!isConnectOwner(owner, await currentSession())', () => f.createEmptyStatement(), 'G2-OS3'],
    ['exchange uses the start token', (n) => ts.isPropertyAccessExpression(n) && n.getText() === 'exchangeSession.access_token', () => f.createPropertyAccessExpression(f.createIdentifier('startSession'), 'access_token'), 'G2-OS1'],
  ];
  for (const [label, predicate, replace, caughtBy] of cases) {
    const { text, n } = mutateHook(predicate, replace);
    assert.equal(n, 1, `${label}: exactly one match`);
    const results = await runAgainst(text);
    assert.equal(results[caughtBy], false, `${label}: ${caughtBy} fails on the mutant`);
  }
});

/** Runs R-CB5, G2-OS1 and the "B signs in" case of G2-OS3 against a hook source; true = the safe expectation held. */
async function runAgainst(source) {
  const make = async () => {
    const h = await realHook({ source });
    await h.signIn('user-a');
    return h;
  };
  const out = {};
  { const h = await make(); const { running } = await h.start(); await h.signIn('user-b'); h.finish(); await running; out['R-CB5'] = callbackCalls(h).length === 0; }
  { const h = await make(); const t = (await h.current()).access_token; const { running } = await h.start(); h.expireStoredToken(); h.finish(); await running; const [c] = callbackCalls(h); out['G2-OS1'] = !!c && c.authorization !== `Bearer ${t}` && h.render().state === 'connected'; }
  { const h = await make(); const { running } = await h.start(); h.backend.hooks.onCallback = () => h.signIn('user-b'); h.finish(); await running; out['G2-OS3'] = h.render().state !== 'connected' && h.connected() === 0; }
  return out;
}
