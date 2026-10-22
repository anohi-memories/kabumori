// G4-22 (Issue #319): the X connect authorization boundary between the app and the server, as a composed contract test
// with NO external connection. The REAL client hook (use-x-connect.ts, G4-18 / PR #426) talks to the REAL server logic
// (supabase/functions/x-oauth-connect-user/oauth_logic.ts) through a stand-in of index.ts; only these are fakes:
//   * Auth:      /auth/v1/user answers the subject while the token's session is live, 403 session_not_found otherwise
//                (the behavior auth-js 2.115.0 documents; real Supabase Auth is NOT_VERIFIED here);
//   * PostgREST: checks only the JWT (sub, exp) -- NOT the session -- and runs an in-memory MODEL of the live X RPCs
//                (begin / consume / complete of 20260919120000 + 20260922003101), whose conditions are pinned to the SQL
//                text by the "model is pinned" test below (if the SQL changes, that test fails and the model must follow);
//   * X:         one-time codes bound to the PKCE challenge, a token endpoint and users/me.
// Groups:
//   CURRENT  -- what the code guarantees today (must pass);
//   FUTURE   -- B1..B4 of G4-20 / G4-21 (PR #437 / #440), not implemented: node:test `todo`, they run and are EXPECTED to
//               fail today; a todo is not a pass. Issue #131 (B3 / v2) stays deferred by the user.
// X_CONNECT_HOOK_SOURCE=<file> runs the composed client cases against another copy of the hook (fail-before on main).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';
import * as oauth from '../src/lib/x-oauth-onboarding.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';

const repo = (path) => new URL(`../../../${path}`, import.meta.url);
const read = (path) => readFile(repo(path), 'utf8');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const claimsOf = (token) => { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return null; } };
const SUPABASE = 'https://fake.supabase.invalid';
const REDIRECT = 'kabumori-social://oauth-callback';

// The real server logic, executed in its own context (no Deno, no network: every call gets the fake fetch).
const serverSource = await read('supabase/functions/x-oauth-connect-user/oauth_logic.ts');
const server = (() => {
  const mod = { exports: {} };
  vm.runInNewContext(transpile(serverSource), { module: mod, exports: mod.exports, crypto: webcrypto, TextEncoder, URL, URLSearchParams, btoa,
    fetch: () => { throw new Error('live network forbidden'); } }, { filename: 'oauth_logic.ts' });
  return mod.exports;
})();
const hookSource = process.env.X_CONNECT_HOOK_SOURCE
  ? await readFile(process.env.X_CONNECT_HOOK_SOURCE, 'utf8')
  : await read('apps/social-mobile/src/features/x-connect/use-x-connect.ts');

/** The fake world: Auth sessions, the PostgREST model of the live X RPCs, and X. */
function world() {
  const now = () => Date.now();
  const sessions = new Map(); // session_id -> { sub, live }
  let tokenSerial = 0;
  const issue = (sub, sessionId) => {
    if (sessionId) sessions.set(sessionId, { sub, live: true });
    const claims = sessionId ? { sub, session_id: sessionId, role: 'authenticated', exp: Math.floor(now() / 1000) + 3600 }
      : { sub, role: 'authenticated', exp: Math.floor(now() / 1000) + 3600 };
    return { access_token: `${b64url({ alg: 'none' })}.${b64url(claims)}.t${++tokenSerial}`, user: { id: sub } };
  };
  const signOut = (session) => { const s = sessions.get(claimsOf(session.access_token).session_id); if (s) s.live = false; };
  const db = { states: [], accounts: new Map(), entitlement: new Map(), rpcCalls: [] };
  const x = { codes: new Map(), tokenCalls: 0, failTokenOnce: 0, duringTokenExchange: null, identities: new Map() };

  // The live RPC conditions (pinned to the SQL text by the "model is pinned" test).
  const rpc = {
    begin_social_mobile_x_oauth_connection(sub, body) {
      if (!sub) throw new Error('SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED');
      if (!/^[0-9a-f]{64}$/u.test(body.p_state_hash) || new Date(body.p_expires_at).getTime() <= now()) throw new Error('OAUTH_STATE_INPUT_INVALID');
      if (!db.accounts.has(sub)) db.accounts.set(sub, { id: `sa_x_${sub.replace(/-/gu, '')}`, brand_id: `ws_${sub.replace(/-/gu, '')}`, owner: sub, platform_user_id: null, handle: 'pending', status: 'unconnected', vault: 0 });
      const account = db.accounts.get(sub);
      db.states.push({ id: `st-${db.states.length + 1}`, hash: body.p_state_hash, initiated_by: sub, brand_id: account.brand_id, social_account_id: account.id,
        redirect_uri: body.p_redirect_uri, expires_at: new Date(body.p_expires_at).getTime(), consumed: false });
      return [{ brand_id: account.brand_id, social_account_id: account.id }];
    },
    consume_social_mobile_x_oauth_state(sub, body) {
      if (!sub) throw new Error('SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED');
      const s = db.states.find((row) => row.hash === body.p_state_hash);
      if (!s || s.initiated_by !== sub || s.consumed || s.expires_at <= now()) throw new Error('OAUTH_STATE_NOT_CONSUMABLE');
      return [{ oauth_state_id: s.id, redirect_uri: s.redirect_uri, brand_id: s.brand_id, social_account_id: s.social_account_id }];
    },
    complete_social_mobile_x_oauth_connection(sub, body) { // one statement: all or nothing
      if (!sub) throw new Error('SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED');
      if (!body.p_access_token || !body.p_refresh_token || !body.p_platform_user_id) throw new Error('OAUTH_TOKEN_OR_IDENTITY_INVALID');
      const s = db.states.find((row) => row.id === body.p_oauth_state_id && row.initiated_by === sub && !row.consumed && row.expires_at > now());
      if (!s) throw new Error('OAUTH_STATE_NOT_CONSUMABLE');
      const account = [...db.accounts.values()].find((a) => a.id === s.social_account_id && a.owner === sub);
      if (!account) throw new Error('SOCIAL_MOBILE_ACCOUNT_NOT_OWNED');
      if (account.platform_user_id && account.platform_user_id !== body.p_platform_user_id) throw new Error('X_IDENTITY_ACCOUNT_MISMATCH');
      if ([...db.accounts.values()].some((a) => a !== account && a.platform_user_id === body.p_platform_user_id)) throw new Error('X_ACCOUNT_ALREADY_CONNECTED');
      s.consumed = true;
      Object.assign(account, { platform_user_id: body.p_platform_user_id, handle: body.p_handle.toLowerCase(), status: 'identity_verified', vault: account.vault + 2 });
      return null;
    },
  };

  /** The one fetch every server call gets. */
  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    const bearer = (init.headers?.Authorization ?? '').replace(/^Bearer\s+/u, '');
    if (url.origin === SUPABASE && url.pathname === '/auth/v1/user') {
      const c = claimsOf(bearer);
      const s = c?.session_id ? sessions.get(c.session_id) : null;
      if (!c || !s || !s.live || s.sub !== c.sub || c.exp * 1000 <= now()) return Response.json({ error_code: 'session_not_found' }, { status: 403 });
      return Response.json({ id: c.sub });
    }
    if (url.origin === SUPABASE && url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.slice('/rest/v1/rpc/'.length);
      const c = claimsOf(bearer);
      const sub = c && c.exp * 1000 > now() ? c.sub : null; // PostgREST: signature + exp only, never the session
      db.rpcCalls.push(name);
      try {
        const out = rpc[name](sub, JSON.parse(init.body));
        return new Response(out === null ? '' : JSON.stringify(out), { status: 200 });
      } catch (error) {
        return Response.json({ message: error.message }, { status: 400 });
      }
    }
    if (url.href === 'https://api.x.com/2/oauth2/token') {
      x.tokenCalls += 1;
      await x.duringTokenExchange?.();
      if (x.failTokenOnce > 0) { x.failTokenOnce -= 1; return new Response('unavailable', { status: 503 }); }
      const form = new URLSearchParams(String(init.body));
      const code = x.codes.get(form.get('code'));
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (!code || code.used || code.challenge !== challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      code.used = true;
      x.identities.set(`xat_${form.get('code')}`, code.identity);
      return Response.json({ access_token: `xat_${form.get('code')}`, refresh_token: `xrt_${form.get('code')}` });
    }
    if (url.href === 'https://api.x.com/2/users/me') {
      const identity = x.identities.get(bearer);
      return identity ? Response.json({ data: identity }) : new Response('', { status: 401 });
    }
    throw new Error(`unexpected request ${url.href}`);
  }

  /** index.ts as it is (resolveConnectingUser first, then the route), pinned by the "model is pinned" test. */
  async function edge(name, { body, headers }) {
    const env = { supabaseUrl: SUPABASE, anonKey: 'anon', clientId: 'fake_client', clientSecret: 'fake_secret' };
    const authorizationHeader = headers?.Authorization ?? null;
    const userAccessToken = /^Bearer\s+(.+)$/iu.exec(authorizationHeader ?? '')?.[1];
    const failure = (status, code) => ({ data: null, error: { name: 'FunctionsHttpError', message: code, context: { status } } });
    if (!userAccessToken) return failure(401, 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED');
    try {
      await server.resolveConnectingUser({ authorizationHeader, supabaseUrl: SUPABASE, anonKey: 'anon', fetchImpl });
      if (name.endsWith('/callback')) {
        const r = await server.completeConnection({ request: { code: body.code, state: body.state, codeVerifier: body.code_verifier, redirectUri: body.redirect_uri },
          userAccessToken, ...env, fetchImpl });
        return { data: { success: true, brand_id: r.brandId, social_account_id: r.socialAccountId, handle: r.handle, connection_status: r.connectionStatus }, error: null };
      }
      const r = await server.startConnection({ request: { rawState: body.state, codeChallenge: body.code_challenge, redirectUri: body.redirect_uri },
        userAccessToken, ...env, fetchImpl });
      return { data: { authorization_url: r.authorizationUrl, brand_id: r.brandId, social_account_id: r.socialAccountId }, error: null };
    } catch (error) {
      return error?.name === 'OAuthConnectUserError' ? failure(error.status, error.message) : failure(500, 'SOCIAL_MOBILE_OAUTH_CONNECTION_FAILED');
    }
  }
  return { sessions, issue, signOut, db, x, fetchImpl, edge, rpc };
}

/** The real hook on top of the world. The browser authorizes at X as `identity` and is held open until finish(). */
function client(w, { identity = { id: '1001', username: 'alice_x' }, browser = 'success' } = {}) {
  const slots = [], invokes = [];
  let cursor = 0, round = 0, completed = 0, finishBrowser = null;
  const device = { ui: null, sdk: null };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback: (cb) => cb,
  };
  let codeSerial = 0;
  const modules = {
    react,
    'react-native': { Platform: { OS: 'android' } },
    'expo-crypto': {
      getRandomBytesAsync: async (n) => new Uint8Array(n).fill(++round),
      digestStringAsync: async (_a, v) => createHash('sha256').update(v).digest('base64'),
      CryptoDigestAlgorithm: { SHA256: 'SHA256' }, CryptoEncoding: { BASE64: 'BASE64' },
    },
    'expo-linking': { createURL: () => REDIRECT },
    'expo-web-browser': {
      maybeCompleteAuthSession() {},
      openAuthSessionAsync: (authorizationUrl, redirect) => new Promise((resolve) => {
        finishBrowser = () => {
          if (browser === 'cancel') return resolve({ type: 'cancel' });
          const u = new URL(authorizationUrl);
          const code = `code${++codeSerial}_${round}`;
          w.x.codes.set(code, { challenge: u.searchParams.get('code_challenge'), identity, used: false });
          resolve({ type: 'success', url: `${redirect}?state=${u.searchParams.get('state')}&code=${code}` });
        };
      }),
    },
    '@/features/x-connect/auth-session-options': { xConnectAuthSessionOptions },
    '@/domain/recovery-binding': recoveryBinding,
    '@/lib/x-oauth-onboarding': oauth,
    '@/providers/auth-provider': { useAuth: () => ({ session: device.ui }) },
    '@/lib/supabase': { supabase: {
      auth: { getSession: async () => ({ data: { session: device.sdk }, error: null }) },
      functions: { invoke: async (name, options) => { invokes.push({ name, bearer: options.headers.Authorization }); return w.edge(name, options); } },
    } },
  };
  const mod = { exports: {} };
  vm.runInNewContext(transpile(hookSource), { module: mod, exports: mod.exports, URL,
    require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; },
    fetch: () => { throw new Error('live network forbidden'); } }, { filename: 'use-x-connect.ts' });
  const render = () => { cursor = 0; return mod.exports.useXConnect(() => { completed += 1; }); };
  const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r)); };
  const signIn = (session) => { device.ui = session; device.sdk = session; };
  return {
    device, invokes, render, settle, signIn, completed: () => completed,
    /** Start a connect; resolves once the browser is open. Wrapped (an async function would adopt the pending promise). */
    async open() { const running = render().connect(); await settle(); return { running }; },
    finish: () => finishBrowser(),
  };
}

const accountOf = (w, sub) => w.db.accounts.get(sub);
const callbacks = (c) => c.invokes.filter((i) => i.name.endsWith('/callback'));

// ---------------------------------------------------------------------------------------------------------------------
// The model is pinned to the source it stands in for.
test('model is pinned: the live SQL checks the person (initiated_by = auth.uid()) and never a session; index.ts resolves the user once, first', async () => {
  const sql = await read('supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql');
  const consume = sql.slice(sql.indexOf('create or replace function public.consume_social_mobile_x_oauth_state'), sql.indexOf('create or replace function public.complete_social_mobile_x_oauth_connection'));
  const complete = sql.slice(sql.indexOf('create or replace function public.complete_social_mobile_x_oauth_connection'), sql.indexOf('-- Called with the connecting user'));
  assert.match(consume, /v_state\.initiated_by_user_id is distinct from v_user_id/u);
  assert.match(consume, /v_state\.consumed_at is not null or v_state\.expires_at <= now\(\)/u);
  assert.match(complete, /and initiated_by_user_id = v_user_id\s+and consumed_at is null\s+and expires_at > now\(\)/u);
  assert.match(complete, /bm\.user_id = v_user_id and bm\.role = 'owner'/u);
  assert.match(complete, /X_IDENTITY_ACCOUNT_MISMATCH/u);
  assert.match(complete, /X_ACCOUNT_ALREADY_CONNECTED/u);
  for (const body of [consume, complete]) assert.doesNotMatch(body, /session|account_lifecycle_assert|attestation|hmac/iu, 'no session / lifecycle / attestation check today');
  assert.match(sql, /grant execute on function public\.complete_social_mobile_x_oauth_connection\(uuid, text, text, text, text\) to authenticated;/u, 'B3 premise: complete is granted to authenticated');
  const index = await read('supabase/functions/x-oauth-connect-user/index.ts');
  assert.ok(index.indexOf('await resolveConnectingUser(') < index.indexOf('path.endsWith("/callback")'), 'the user is resolved before routing');
  assert.equal(index.match(/resolveConnectingUser\(/gu).length, 1, 'resolved once per request');
  const logic = serverSource;
  const order = ['name: "consume_social_mobile_x_oauth_state"', 'exchangeCodeForTokens({', 'readXIdentity({ accessToken', 'name: "complete_social_mobile_x_oauth_connection"'].map((s) => logic.indexOf(s, logic.indexOf('export async function completeConnection')));
  assert.ok(order.every((p, i) => p > 0 && (i === 0 || p > order[i - 1])), `callback order consume -> X exchange -> identity -> complete: ${order}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// CURRENT: composed client (PR #426 hook) + server -- what holds today.
test('CURRENT 1: the same person and session -> X exchanged once, the account bound to that person, the handle shown, one onConnected', async () => {
  const w = world(); const c = client(w); const a = w.issue('user-a', 'sess-a'); c.signIn(a);
  const { running } = await c.open(); c.finish(); await running;
  assert.equal(c.render().state, 'connected');
  assert.equal(c.render().verifiedHandle, '@alice_x');
  assert.equal(c.completed(), 1);
  assert.equal(w.x.tokenCalls, 1);
  assert.deepEqual([accountOf(w, 'user-a').platform_user_id, accountOf(w, 'user-a').status], ['1001', 'identity_verified']);
});

test('CURRENT 2 (G2-CB5): B signs in while the browser is open -> no callback sent, X never called, nothing bound for anyone, no success', async () => {
  const w = world(); const c = client(w); c.signIn(w.issue('user-a', 'sess-a'));
  const { running } = await c.open();
  c.signIn(w.issue('user-b', 'sess-b')); c.render();
  c.finish(); await running;
  assert.equal(callbacks(c).length, 0);
  assert.equal(w.x.tokenCalls, 0);
  assert.equal(c.render().state, 'session_changed');
  assert.equal(c.completed(), 0);
  assert.equal(accountOf(w, 'user-a').platform_user_id, null);
  assert.equal(accountOf(w, 'user-b'), undefined);
  assert.equal(w.db.states[0].consumed, false);
});

test('CURRENT 3 (G2-CB6): A signs out while the browser is open -> no callback sent, X never called', async () => {
  const w = world(); const c = client(w); const a = w.issue('user-a', 'sess-a'); c.signIn(a);
  const { running } = await c.open();
  w.signOut(a); c.signIn(null);
  c.finish(); await running;
  assert.equal(callbacks(c).length, 0);
  assert.equal(w.x.tokenCalls, 0);
  assert.equal(c.render().state, 'session_changed');
});

test('CURRENT 4: A -> B -> A on the device (A\'s NEW session) -> the client refuses; X never called', async () => {
  const w = world(); const c = client(w); const a = w.issue('user-a', 'sess-a'); c.signIn(a);
  const { running } = await c.open();
  w.signOut(a); c.signIn(w.issue('user-b', 'sess-b')); c.render(); c.signIn(w.issue('user-a', 'sess-a2')); c.render();
  c.finish(); await running;
  assert.equal(callbacks(c).length, 0);
  assert.equal(w.x.tokenCalls, 0);
  assert.equal(c.render().state, 'session_changed');
});

test('CURRENT 5: the same session refreshed its token while the browser was open -> the callback carries the refreshed token, the server accepts it', async () => {
  const w = world(); const c = client(w); const a = w.issue('user-a', 'sess-a'); c.signIn(a);
  const { running } = await c.open();
  const refreshed = w.issue('user-a', 'sess-a'); c.signIn(refreshed);
  c.finish(); await running;
  assert.equal(callbacks(c)[0].bearer, `Bearer ${refreshed.access_token}`);
  assert.equal(c.render().state, 'connected');
  assert.equal(accountOf(w, 'user-a').platform_user_id, '1001');
});

test('CURRENT 6: the same callback twice at once (server), both past consume -> X refuses the second exchange of the one-time code; exactly one completion', async () => {
  const w = world(); const a = w.issue('user-a', 'sess-a');
  const start = await w.edge('x-oauth-connect-user', { headers: { Authorization: `Bearer ${a.access_token}` }, body: { state: 'r'.repeat(32), code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), redirect_uri: REDIRECT } });
  assert.equal(start.error, null);
  w.x.codes.set('dup_code', { challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), identity: { id: '1001', username: 'alice_x' }, used: false });
  const body = { code: 'dup_code', state: 'r'.repeat(32), code_verifier: 'v'.repeat(43), redirect_uri: REDIRECT };
  // Both requests reach the X exchange before either goes on (both passed the read-only consume).
  let release; const bothArrived = new Promise((r) => { release = r; });
  w.x.duringTokenExchange = async () => { if (w.x.tokenCalls === 2) release(); await bothArrived; };
  const both = await Promise.all([1, 2].map(() => w.edge('x-oauth-connect-user/callback', { headers: { Authorization: `Bearer ${a.access_token}` }, body })));
  assert.equal(both.filter((r) => r.error === null).length, 1);
  assert.equal(both.find((r) => r.error)?.error.message, 'X_TOKEN_EXCHANGE_FAILED:400');
  assert.equal(w.x.tokenCalls, 2, 'both reached X; the one-time code made the second fail');
  assert.equal(w.db.states.filter((s) => s.consumed).length, 1);
  assert.equal(accountOf(w, 'user-a').vault, 2, 'credentials written once');
});

test('CURRENT 7: a transient X failure is retryable; nothing is consumed or bound; a fresh connect then succeeds', async () => {
  const w = world(); const c = client(w); c.signIn(w.issue('user-a', 'sess-a'));
  w.x.failTokenOnce = 1;
  let r = await c.open(); c.finish(); await r.running;
  assert.equal(c.render().state, 'retryable_error'); // the Edge reports X's 5xx as a 502 (X_TOKEN_EXCHANGE_FAILED:503): retryable
  assert.equal(c.render().verifiedHandle, null);
  assert.equal(c.completed(), 0);
  assert.equal(w.db.states[0].consumed, false);
  assert.equal(accountOf(w, 'user-a').platform_user_id, null);
  r = await c.open(); c.finish(); await r.running;
  assert.equal(c.render().state, 'connected');
  assert.equal(c.completed(), 1);
});

test('CURRENT 8: an X account already bound to another person -> refused as a whole (state not consumed), no success, no token in what the app shows', async () => {
  const w = world();
  const other = client(w, { identity: { id: '1001', username: 'alice_x' } }); other.signIn(w.issue('user-c', 'sess-c'));
  let r = await other.open(); other.finish(); await r.running;
  assert.equal(other.render().state, 'connected');
  const c = client(w, { identity: { id: '1001', username: 'alice_x' } }); c.signIn(w.issue('user-a', 'sess-a'));
  r = await c.open(); c.finish(); await r.running;
  const now = c.render();
  assert.equal(now.state, 'terminal_error');
  assert.equal(now.verifiedHandle, null);
  assert.equal(c.completed(), 0);
  assert.equal(w.db.states.find((s) => s.initiated_by === 'user-a').consumed, false);
  assert.doesNotMatch(now.stateText, /xat_|xrt_|code|eyJ|sess-/u);
});

// CURRENT: server alone.
test('CURRENT 9 (server): B\'s token on A\'s state -> consume refuses, X never called (no cross-person binding)', async () => {
  const w = world(); const a = w.issue('user-a', 'sess-a'); const b = w.issue('user-b', 'sess-b');
  const challenge = createHash('sha256').update('v'.repeat(43)).digest('base64url');
  await w.edge('x-oauth-connect-user', { headers: { Authorization: `Bearer ${a.access_token}` }, body: { state: 's'.repeat(32), code_challenge: challenge, redirect_uri: REDIRECT } });
  w.x.codes.set('code_b', { challenge, identity: { id: '2002', username: 'bob_x' }, used: false });
  const r = await w.edge('x-oauth-connect-user/callback', { headers: { Authorization: `Bearer ${b.access_token}` }, body: { code: 'code_b', state: 's'.repeat(32), code_verifier: 'v'.repeat(43), redirect_uri: REDIRECT } });
  assert.equal(r.error.message, 'OAUTH_STATE_NOT_CONSUMABLE');
  assert.equal(w.x.tokenCalls, 0);
  assert.equal(w.db.states[0].consumed, false);
});

test('CURRENT 10 (server): a signed-out session\'s token -> /auth/v1/user refuses (401) before any RPC or X call', async () => {
  const w = world(); const a = w.issue('user-a', 'sess-a');
  w.signOut(a);
  const r = await w.edge('x-oauth-connect-user/callback', { headers: { Authorization: `Bearer ${a.access_token}` }, body: { code: 'c', state: 's'.repeat(32), code_verifier: 'v'.repeat(43), redirect_uri: REDIRECT } });
  assert.equal(r.error.context.status, 401);
  assert.equal(w.db.rpcCalls.length, 0);
  assert.equal(w.x.tokenCalls, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// FUTURE: B1..B4 (G4-20 PR #437, G4-21 PR #440). Not implemented -> todo (run, expected to fail today; not a pass).
async function startAs(w, session, state, identity = { id: '1001', username: 'alice_x' }) {
  const challenge = createHash('sha256').update('v'.repeat(43)).digest('base64url');
  const start = await w.edge('x-oauth-connect-user', { headers: { Authorization: `Bearer ${session.access_token}` }, body: { state, code_challenge: challenge, redirect_uri: REDIRECT } });
  assert.equal(start.error, null, 'start');
  w.x.codes.set(`code_${state.slice(0, 4)}`, { challenge, identity, used: false });
  return { code: `code_${state.slice(0, 4)}`, state, code_verifier: 'v'.repeat(43), redirect_uri: REDIRECT };
}

test('FUTURE B1: a state begun in A\'s session is refused when completed from A\'s NEW session (state bound to session_id)', { todo: 'B1 not implemented: the state is bound to the person only (G4-21 S1, PR #440)' }, async () => {
  const w = world(); const a1 = w.issue('user-a', 'sess-a');
  const body = await startAs(w, a1, 'b1'.repeat(16));
  w.signOut(a1); const a2 = w.issue('user-a', 'sess-a2');
  const r = await w.edge('x-oauth-connect-user/callback', { headers: { Authorization: `Bearer ${a2.access_token}` }, body });
  assert.ok(r.error, 'refused');
  assert.equal(w.x.tokenCalls, 0, 'before the X exchange');
});

test('FUTURE B2: a sign-out landing after /auth/v1/user but before complete is refused at complete (session re-checked in the transaction)', { todo: 'B2 not implemented: no session re-check at complete (G4-21 S2: G5 T13; lock policy asked of G5, #320 6331312443)' }, async () => {
  const w = world(); const a = w.issue('user-a', 'sess-a');
  const body = await startAs(w, a, 'b2'.repeat(16));
  w.x.duringTokenExchange = async () => { w.signOut(a); };
  const r = await w.edge('x-oauth-connect-user/callback', { headers: { Authorization: `Bearer ${a.access_token}` }, body });
  assert.ok(r.error, 'refused');
  assert.equal(accountOf(w, 'user-a').platform_user_id, null, 'nothing bound');
  assert.equal(w.db.states[0].consumed, false, 'state not consumed');
});

test('FUTURE B3: a direct PostgREST complete with an X id the caller never exchanged is refused (attestation / no authenticated EXECUTE)', { todo: 'B3 not implemented: Issue #131 / PR #126 v2 deferred by the user (do not restart without approval)' }, async () => {
  const w = world(); const p = w.issue('user-p', 'sess-p');
  await startAs(w, p, 'b3'.repeat(16));
  const state = w.db.states[0];
  const response = await w.fetchImpl(`${SUPABASE}/rest/v1/rpc/complete_social_mobile_x_oauth_connection`, { method: 'POST', headers: { Authorization: `Bearer ${p.access_token}` },
    body: JSON.stringify({ p_oauth_state_id: state.id, p_platform_user_id: '9999', p_handle: 'victim_x', p_access_token: 'forged', p_refresh_token: 'forged' }) });
  assert.notEqual(response.status, 200, 'refused');
  assert.notEqual(accountOf(w, 'user-p').platform_user_id, '9999', 'no squatted id');
});

test('FUTURE B4: a person whose POSTONA service is not active is refused before the code is spent with X (T13 + G5 R1 before the exchange)', { todo: 'B4 not implemented: no lifecycle / owner re-check before the exchange (PR #353 / #355, MERGE_NO_GO; G4-21 S4)' }, async () => {
  const w = world(); const a = w.issue('user-a', 'sess-a');
  w.db.entitlement.set('user-a', 'ended'); // the live RPCs never read it today
  const body = await startAs(w, a, 'b4'.repeat(16));
  const r = await w.edge('x-oauth-connect-user/callback', { headers: { Authorization: `Bearer ${a.access_token}` }, body });
  assert.ok(r.error, 'refused');
  assert.equal(w.x.tokenCalls, 0, 'the code is not spent');
});
