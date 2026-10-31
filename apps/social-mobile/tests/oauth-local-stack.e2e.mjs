// G4-02 #6 (Issue #561): X / Threads connect from the REAL app hooks through the REAL local Supabase runtime. NOT part of `npm test`: run by
// supabase/tests/postona_g4_oauth_local_stack/run.sh, which starts the stack and sets LS_*.
//   real here   the app hooks / starter / runtimes / disconnect flows, supabase-js, Kong (verify_jwt), the Edge runtime, GoTrue (ES256 JWTs,
//               sessions, sign-out, anonymous, refresh), PostgREST, PostgreSQL 17.6 with the real auth / vault schemas
//   faked       X and Threads (in the Edge twins' transport), the system browser (the person's approval), expo / React hook containers
// The app's function names are routed to the g4ls twins (their headers say what differs); the real entries are called as in source first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import * as threadsDomain from '../src/domain/threads-connect.ts';
import * as disconnectDomain from '../src/domain/threads-disconnect.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';
import * as oauth from '../src/lib/x-oauth-onboarding.ts';

const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} missing (run postona_g4_oauth_local_stack/run.sh)`); return v; };
const API = env('LS_API');
const PUBLISHABLE = env('LS_PUBLISHABLE');
const CALLBACK = 'https://postona.example/callback';  // H5's offline fixture: the registered callback of the twin's configuration
const X_REDIRECT = 'kabumori-social://oauth-callback';
const T = { timeout: 60000 };

// ---- SQL as the local owner (facts, and the labelled SYNTHETIC steps) ------------------------------------------------------------------
const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replaceAll("'", "''")}'`);
function owner(sql) {
  return execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', env('LS_DB_PORT'), '-U', 'postgres', '-d', 'postgres', '-c', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ---- every response the app sees: no provider token may ever reach it -------------------------------------------------------------------
const seen = [];
const routes = { current: '' };
const routed = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const target = url
    .replace('/functions/v1/threads-oauth-connect-user', `/functions/v1/g4ls-threads-connect${routes.current}`)
    .replace('/functions/v1/x-oauth-connect-user', '/functions/v1/g4ls-x-connect')
    .replace('/functions/v1/social-mobile-threads-disconnect', '/functions/v1/g4ls-threads-disconnect');
  const response = await fetch(target, init);
  const text = await response.clone().text();
  seen.push({ url: target, status: response.status, text, body: init.body, headers: init.headers });
  if (process.env.FLOW_DEBUG) console.error(`[flow] ${target} -> ${response.status} ${text.slice(0, 300)}`);
  return response;
};
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } }; };
const newClient = () => createClient(API, PUBLISHABLE, {
  auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage: memory() },
  global: { fetch: routed },
});

// ---- people: real GoTrue sign-up; POSTONA started = G5's own RPC under the person's real claims (SYNTHETIC W0) -----------------------------
const password = `g4ls-${randomUUID()}`;
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
async function person(label, { start = true } = {}) {
  const client = newClient();
  const email = `${label}-${randomUUID().slice(0, 8)}@g4ls.test`;
  const { data, error } = await client.auth.signUp({ email, password });
  assert.equal(error, null, `sign-up ${label}`);
  const userId = data.user.id;
  const claims = claimsOf(data.session.access_token);
  assert.deepEqual([claims.role, claims.is_anonymous, claims.sub], ['authenticated', false, userId], 'real GoTrue claims');
  if (start) {
    const json = JSON.stringify({ sub: userId, role: 'authenticated', session_id: claims.session_id, is_anonymous: false });
    owner(`begin; select set_config('request.jwt.claims', ${lit(json)}, true); select public.start_x_autopost_service();
      update public.brands set code_profile_key = 'social_mobile_user_v1' where id = public.social_mobile_account_deletion_workspace(${lit(userId)}::uuid); commit;`);
  }
  return { label, email, client, userId, session: data.session };
}
const workspace = (p) => `public.social_mobile_account_deletion_workspace(${lit(p.userId)}::uuid)`;
const accountId = (p, platform) => owner(`select coalesce((select id from public.social_accounts where brand_id = ${workspace(p)} and platform = ${lit(platform)}), '')`);
const threadsState = (p) => owner(`select coalesce((select b.oauth_state_id::text from postona_threads_binding.bindings b join public.social_accounts sa on sa.id = b.social_account_id where sa.brand_id = ${workspace(p)}), 'none')`);
const custody = (p) => Number(owner(`select count(*) from public.threads_account_credential_custody c join public.social_accounts sa on sa.id = c.social_account_id where sa.brand_id = ${workspace(p)}`));
const states = (p) => Number(owner(`select count(*) from public.social_account_oauth_states where initiated_by_user_id = ${lit(p.userId)}::uuid`));
const verdict = (platform, p, id) => owner(`select r.verified::text || '|' || coalesce(r.credential_generation, '-') || '|' || r.code
  from postona_g4_credential.${platform}_publish_credential_verdict(${lit(p.userId)}::uuid, ${lit(id)}) r`);
const endService = (p) => owner(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = ${lit(p.userId)}::uuid and service_key = 'x_autopost'`);
const moveGeneration = (p) => owner(`update public.common_accounts set lifecycle_version = lifecycle_version + 2 where user_id = ${lit(p.userId)}::uuid`);
const noProviderToken = () => assert.ok(!seen.some((s) => /fakeX[ar]t|short[0-9]+abc|long[0-9]+abc/u.test(s.text)), 'no provider token ever reached the app');

// ---- the REAL hooks (TypeScript transpiled; only module edges are stubbed) ---------------------------------------------------------------
const transpiled = new Map();
async function loadTs(rel, modules, extra = {}) {
  if (!transpiled.has(rel)) {
    const source = await readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8');
    transpiled.set(rel, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);
  }
  const mod = { exports: {} };
  vm.runInNewContext(transpiled.get(rel), { module: mod, exports: mod.exports, URL, Response, setTimeout, clearTimeout, Promise, ...extra,
    require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n} in ${rel}`); return modules[n]; } }, { filename: rel });
  return mod.exports;
}
const hookRuntime = (slots, cursor) => ({
  useState(initial) { const i = cursor.n++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
  useRef(initial) { const i = cursor.n++; return slots[i] ??= { current: initial }; },
  useCallback: (cb) => cb,
  useLayoutEffect: (effect) => effect(),
});

/** Threads screen: `approve` = the Threads user the person approves as (a function runs at Threads and returns one; null = cancel). */
async function threadsScreen(p, session = p.session) {
  const auth = { session };
  const slots = [], cursor = { n: 0 };
  let reloads = 0, accounts = [];
  const react = hookRuntime(slots, cursor);
  const browser = { approve: null, served: 0, returned: null };
  const host = new URL(CALLBACK).hostname;
  const expoConfig = { extra: { threadsConnectCallbackUrl: CALLBACK }, ios: { associatedDomains: [`applinks:${host}`] } };
  const base = { '@/lib/supabase': { supabase: p.client }, '@/providers/auth-provider': { useAuth: () => ({ session: auth.session }) } };
  const starter = await loadTs('features/threads-connect/threads-connect-starter.ts', { '@/domain/threads-connect': threadsDomain, '@/domain/recovery-binding': recoveryBinding });
  const runtime = await loadTs('features/threads-connect/threads-connect-runtime.ts', {
    'expo-constants': { __esModule: true, default: { expoConfig } },
    'expo-linking': { addEventListener: () => ({ remove() {} }) },
    'expo-web-browser': {
      openAuthSessionAsync: async (authorizationUrl, redirect) => {
        browser.served += 1;
        const state = new URL(authorizationUrl).searchParams.get('state');
        const puid = typeof browser.approve === 'function' ? await browser.approve() : browser.approve;
        if (puid === null) return { type: 'cancel' };
        browser.returned = `${redirect}?code=code${puid}x${browser.served}${Date.now() % 100000}&state=${encodeURIComponent(state)}#_`;
        return { type: 'success', url: browser.returned };
      },
      dismissAuthSession() {},
    },
    'react-native': { Platform: { OS: 'ios', Version: '18.0' } },
    '@/domain/threads-connect': threadsDomain,
    '@/features/threads-connect/threads-connect-starter': starter,
    ...base,
  });
  const connectHook = await loadTs('features/threads-connect/use-threads-connect.ts', {
    react, '@/features/threads-connect/threads-connect-runtime': runtime, '@/features/threads-connect/threads-connect-starter': starter, ...base,
  });
  const runner = await loadTs('features/threads-disconnect/threads-disconnect-runner.ts', { '@/domain/threads-disconnect': disconnectDomain });
  const disconnectRuntime = await loadTs('features/threads-disconnect/threads-disconnect-runtime.ts', { '@/domain/threads-disconnect': disconnectDomain, ...base });
  const disconnectHook = await loadTs('features/threads-disconnect/use-threads-disconnect.ts', {
    react, '@/features/threads-disconnect/threads-disconnect-runner': runner, '@/features/threads-disconnect/threads-disconnect-runtime': disconnectRuntime, ...base,
  });
  const render = () => {
    cursor.n = 0;
    return {
      connect: connectHook.useThreadsConnect({ accounts, reload: () => { reloads += 1; }, releaseEnabled: true }),
      disconnect: disconnectHook.useThreadsDisconnect({ accounts, reload: () => { reloads += 1; }, releaseEnabled: true }),
    };
  };
  return { render, browser, reloads: () => reloads, signIn(next) { auth.session = next; render(); }, setAccounts(list) { accounts = list; } };
}
async function connectThreads(screen, approve) {
  screen.browser.approve = approve;
  await screen.render().connect.connect();
  return screen.render().connect.state;
}

/** X screen: the REAL use-x-connect. `code` = what X returns for the approval (x<id>x<n>, or xfail). */
const xHook = ts.transpileModule(await readFile(new URL('../src/features/x-connect/use-x-connect.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function xScreen(p, session = p.session, { code, during = null } = {}) {
  const slots = [], cursor = { n: 0 };
  let reloads = 0;
  const modules = {
    react: hookRuntime(slots, cursor),
    'react-native': { Platform: { OS: 'android' } },
    'expo-crypto': {
      getRandomBytesAsync: async (n) => new Uint8Array(randomBytes(n)),
      digestStringAsync: async (_a, v) => createHash('sha256').update(v).digest('base64'),
      CryptoDigestAlgorithm: { SHA256: 'SHA256' }, CryptoEncoding: { BASE64: 'BASE64' },
    },
    'expo-linking': { createURL: () => X_REDIRECT },
    'expo-web-browser': {
      maybeCompleteAuthSession() {},
      openAuthSessionAsync: async (authorizationUrl, redirect) => {
        await during?.();
        const state = new URL(authorizationUrl).searchParams.get('state');
        return { type: 'success', url: `${redirect}?state=${encodeURIComponent(state)}&code=${code}` };
      },
    },
    '@/features/x-connect/auth-session-options': { xConnectAuthSessionOptions },
    '@/domain/recovery-binding': recoveryBinding,
    '@/lib/x-oauth-onboarding': oauth,
    '@/providers/auth-provider': { useAuth: () => ({ session }) },
    '@/lib/supabase': { supabase: p.client },
  };
  const mod = { exports: {} };
  vm.runInNewContext(xHook, { module: mod, exports: mod.exports, URL, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; } }, { filename: 'use-x-connect.ts' });
  const render = () => { cursor.n = 0; return mod.exports.useXConnect(() => { reloads += 1; }); };
  return { render, reloads: () => reloads };
}
let xSerial = 0;
const xCode = (id) => `x${id}x${++xSerial}`;

const post = (fn, body, token) => fetch(`${API}/functions/v1/${fn}`, {
  method: 'POST',
  headers: { apikey: PUBLISHABLE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(20000),
});
const answer = async (r) => `${r.status} ${(await r.json()).error ?? ''}`.trim();

// ---- the real entries, as in source ----------------------------------------------------------------------------------------------------
test('R1. the real entries as in source: Threads connect and disconnect closed (503); the gateway refuses no apikey / a tampered JWT', T, async () => {
  assert.equal(await answer(await post('threads-oauth-connect-user', { action: 'start' })), '503 THREADS_CONNECT_DISABLED');
  const closed = await post('social-mobile-threads-disconnect', {});
  assert.equal(closed.status, 503);
  await closed.body?.cancel();
  const a = await person('r1');
  const bad = await fetch(`${API}/functions/v1/x-oauth-connect-user/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
  assert.equal(bad.status, 401, 'no apikey / no token at the gateway');
  await bad.body?.cancel();
  const tampered = `${a.session.access_token.slice(0, -4)}AAAA`;
  const r = await post('g4ls-threads-connect', { action: 'start' }, tampered);
  assert.equal(r.status, 401, 'a tampered signature');
  await r.body?.cancel();
});

test('R2. the deployed shape loads: the entry\'s REAL default loader + the function\'s deno.json on the real Edge runtime; refused before any network', T, async () => {
  assert.equal(await answer(await post('g4ls-threads-connect/default', { action: 'start' })), '401 AUTH_REQUIRED');
});

// ---- Threads ----------------------------------------------------------------------------------------------------------------------------
const threadsPeople = {};
test('T1. connect: hook -> supabase-js -> Kong -> Edge -> real GoTrue / JWKS -> H5 -> G4 bridge -> real SQL + real Vault; verified, the person reads it back', T, async () => {
  const a = threadsPeople.a = await person('ta');
  const screen = await threadsScreen(a);
  const state = await connectThreads(screen, '17841400000006001');
  assert.equal(state.kind, 'verifying', JSON.stringify(state));
  assert.equal(screen.reloads(), 1);
  assert.equal(custody(a), 1);
  assert.equal(verdict('threads', a, state.accountId), `true|g4t1:${threadsState(a)}|VERIFIED`);
  // the data the screen reloads: the person's own row through real PostgREST and RLS
  const { data, error } = await a.client.from('social_accounts').select('id, platform, connection_status').eq('id', state.accountId);
  console.log(`measured T1 own account read: ${JSON.stringify(error ? error.code : (data ?? []).map((r) => r.connection_status))}`);
  assert.equal(error, null);
  assert.deepEqual(data.map((r) => r.connection_status), ['identity_verified']);
  noProviderToken();
});

test('T2. reconnect and a real token refresh while at Threads (same session): connected, a new generation', T, async () => {
  const a = threadsPeople.a;
  const before = threadsState(a);
  const screen = await threadsScreen(a);
  const state = await connectThreads(screen, async () => {
    const { data, error } = await a.client.auth.refreshSession();
    assert.equal(error, null);
    assert.equal(claimsOf(data.session.access_token).session_id, claimsOf(a.session.access_token).session_id, 'same session');
    a.session = data.session;
    screen.signIn(data.session);
    return '17841400000006001';
  });
  assert.equal(state.kind, 'verifying', JSON.stringify(state));
  assert.notEqual(threadsState(a), before);
  assert.equal(custody(a), 1);
});

test('T3. B signs in while A is at Threads, and A -> B -> A (a NEW real session): nothing is forwarded', T, async () => {
  const a = await person('t3a'), b = await person('t3b');
  for (const during of [
    async (screen) => { screen.signIn(b.session); },
    async (screen) => {
      const again = await a.client.auth.signInWithPassword({ email: a.email, password });
      assert.notEqual(claimsOf(again.data.session.access_token).session_id, claimsOf(a.session.access_token).session_id);
      screen.signIn(again.data.session);
    },
  ]) {
    const screen = await threadsScreen(a);
    const callbacks = seen.filter((s) => String(s.body).includes('"callback"')).length;
    const state = await connectThreads(screen, async () => { await during(screen); return '17841400000006003'; });
    assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'SESSION_CHANGED', reconcile: false });
    assert.equal(seen.filter((s) => String(s.body).includes('"callback"')).length, callbacks);
    assert.equal(threadsState(a), 'none');
  }
});

test('T4. a real anonymous session, a signed-out session, not started: refused at start; no state, no browser', T, async () => {
  const anonClient = newClient();
  const anon = await anonClient.auth.signInAnonymously();
  assert.equal(claimsOf(anon.data.session.access_token).is_anonymous, true);
  const anonPerson = { client: anonClient, userId: anon.data.user.id, session: anon.data.session };
  let screen = await threadsScreen(anonPerson);
  assert.deepEqual({ ...(await connectThreads(screen, '1')).result }, { kind: 'failed', code: 'START_REFUSED', reconcile: false });
  assert.equal(screen.browser.served, 0);
  assert.equal(states(anonPerson), 0);

  const out = await person('t4out');
  const oldSession = out.session;
  await out.client.auth.signOut();
  const r = await post('g4ls-threads-connect', { action: 'start' }, oldSession.access_token);
  assert.equal(await answer(r), '409 START_REFUSED', 'a signed-out session: the JWT still verifies, the session row is gone');
  assert.equal(states(out), 0);

  const c = await person('t4c', { start: false });
  screen = await threadsScreen(c);
  assert.deepEqual({ ...(await connectThreads(screen, '2')).result }, { kind: 'failed', code: 'START_REFUSED', reconcile: false });
  assert.equal(states(c), 0);
});

test('T5. the service generation moves (end + restart) or the service ends while at Threads; Threads refuses the code; cancel: nothing bound', T, async () => {
  const aba = await person('t5aba');
  let screen = await threadsScreen(aba);
  let state = await connectThreads(screen, async () => { moveGeneration(aba); return '17841400000006051'; });
  assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'COMPLETE_OUTCOME_UNKNOWN', reconcile: true });
  assert.equal(screen.reloads(), 1, 'reconcile: re-read');
  assert.equal(threadsState(aba), 'none');
  assert.equal(custody(aba), 0);

  const ended = await person('t5end');
  screen = await threadsScreen(ended);
  state = await connectThreads(screen, async () => { endService(ended); return '17841400000006052'; });
  assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'CALLBACK_REFUSED', reconcile: false });
  assert.equal(threadsState(ended), 'none');

  const refused = await person('t5ref');
  screen = await threadsScreen(refused);
  state = await connectThreads(screen, '0');
  assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'EXCHANGE_OUTCOME_UNCERTAIN', reconcile: true });
  assert.equal(threadsState(refused), 'none');

  const cancel = await person('t5can');
  screen = await threadsScreen(cancel);
  state = await connectThreads(screen, null);
  assert.deepEqual({ ...state.result }, { kind: 'canceled' });
  assert.equal(threadsState(cancel), 'none');
});

test('T6. the same callback twice at once: exactly one connects, the other is refused before the code exchange', T, async () => {
  const a = await person('t6');
  const started = await (await post('g4ls-threads-connect', { action: 'start' }, a.session.access_token)).json();
  const state = new URL(started.authorization_url).searchParams.get('state');
  const url = `${CALLBACK}?code=code17841400000006006x1&state=${state}#_`;
  const both = await Promise.all([1, 2].map(() => post('g4ls-threads-connect', { action: 'callback', callback_url: url }, a.session.access_token).then(answer)));
  console.log(`measured T6 same callback twice: ${JSON.stringify(both.sort())}`);
  assert.deepEqual(both.sort(), ['200', '409 CALLBACK_REFUSED']);
  assert.equal(custody(a), 1);
});

test('T7. no profile, or the full profile at the product entry: unavailable, no browser, no state', T, async () => {
  const a = await person('t7');
  for (const route of ['/unpinned', '/full']) {
    routes.current = route;
    try {
      const screen = await threadsScreen(a);
      const state = await connectThreads(screen, '1');
      assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'THREADS_CONNECT_RUNTIME_UNAVAILABLE', reconcile: false }, route);
      assert.equal(screen.browser.served, 0);
    } finally {
      routes.current = '';
    }
  }
  assert.equal(states(a), 0);
});

test('T8. disconnect through the app (the SQL gate opened in this TEST world only): rows gone, verdict NOT_CONNECTED; connect again = a new generation', T, async () => {
  owner("create or replace function public.threads_disconnect_gate_open() returns boolean language sql immutable set search_path = '' as $$ select true $$");
  const a = threadsPeople.a;
  const id = accountId(a, 'threads');
  const old = threadsState(a);
  const handle = owner(`select handle from public.social_accounts where id = ${lit(id)}`);
  let screen = await threadsScreen(a);
  screen.setAccounts([{ id, platform: 'threads', connectionStatus: 'connected' }]);
  screen.render().disconnect.ask({ id, handle });
  await screen.render().disconnect.confirm();
  assert.equal(screen.render().disconnect.state.kind, 'verifying', JSON.stringify(screen.render().disconnect.state));
  assert.equal(accountId(a, 'threads'), '');
  assert.equal(custody(a), 0);
  assert.equal(verdict('threads', a, id), 'false|-|NOT_CONNECTED');
  screen = await threadsScreen(a);
  assert.equal((await connectThreads(screen, '17841400000006001')).kind, 'verifying');
  assert.notEqual(threadsState(a), old);
  assert.ok(verdict('threads', a, accountId(a, 'threads')).startsWith('true|g4t1:'));
  noProviderToken();
});

// ---- X ----------------------------------------------------------------------------------------------------------------------------------
const xPeople = {};
test('X1. connect through the real X entry, real GoTrue / PostgREST with the person\'s JWT, real SQL + Vault; verified; reconnect = a new generation', T, async () => {
  const a = xPeople.a = await person('xa');
  let screen = xScreen(a, a.session, { code: xCode(7001) });
  await screen.render().connect();
  assert.equal(screen.render().state, 'connected', screen.render().stateText);
  assert.equal(screen.reloads(), 1);
  const id = accountId(a, 'x');
  const first = verdict('x', a, id);
  assert.match(first, /^true\|g4x1:[0-9]+\|VERIFIED$/u);
  screen = xScreen(a, a.session, { code: xCode(7001) });
  await screen.render().connect();
  assert.equal(screen.render().state, 'connected', screen.render().stateText);
  assert.notEqual(verdict('x', a, id), first);
  noProviderToken();
});

test('X2. a real anonymous session: sign in again; not started: blocked; both before X', T, async () => {
  const anonClient = newClient();
  const anon = await anonClient.auth.signInAnonymously();
  let screen = xScreen({ client: anonClient }, anon.data.session, { code: xCode(1) });
  await screen.render().connect();
  assert.equal(screen.render().state, 'session_required', screen.render().stateText);
  const c = await person('x2c', { start: false });
  screen = xScreen(c, c.session, { code: xCode(2) });
  await screen.render().connect();
  assert.equal(screen.render().state, 'workspace_blocked', screen.render().stateText);
  assert.equal(states(c), 0);
});

test('X3. B signs in on the same device while A is at X (real GoTrue): no exchange, no success, nothing reloaded', T, async () => {
  const a = await person('x3a'), b = await person('x3b');
  const before = seen.filter((s) => s.url.endsWith('/callback')).length;
  const screen = xScreen(a, a.session, { code: xCode(3), during: async () => {
    const { error } = await a.client.auth.signInWithPassword({ email: b.email, password });
    assert.equal(error, null);
  } });
  await screen.render().connect();
  assert.equal(screen.render().state, 'session_changed');
  assert.equal(screen.reloads(), 0);
  assert.equal(seen.filter((s) => s.url.endsWith('/callback')).length, before);
});

test('X4. a real token refresh while at X (same session): connected', T, async () => {
  const a = await person('x4');
  const screen = xScreen(a, a.session, { code: xCode(7004), during: async () => {
    const { error } = await a.client.auth.refreshSession();
    assert.equal(error, null);
  } });
  await screen.render().connect();
  assert.equal(screen.render().state, 'connected', screen.render().stateText);
});

test('X5. the generation moves or the service ends while at X; X refuses the code: refused, nothing connected', T, async () => {
  const aba = await person('x5aba');
  let screen = xScreen(aba, aba.session, { code: xCode(7051), during: () => moveGeneration(aba) });
  await screen.render().connect();
  assert.equal(screen.render().state, 'terminal_error', screen.render().stateText);
  assert.equal(screen.reloads(), 0, 'a definite refusal changes nothing');
  assert.notEqual(owner(`select coalesce((select connection_status from public.social_accounts where id = ${lit(accountId(aba, 'x'))}), 'none')`), 'identity_verified');

  const ended = await person('x5end');
  screen = xScreen(ended, ended.session, { code: xCode(7052), during: () => endService(ended) });
  await screen.render().connect();
  console.log(`measured X5 service ended while at X: ${screen.render().state}`);
  assert.equal(screen.render().state, 'workspace_blocked', screen.render().stateText);

  const refused = await person('x5ref');
  screen = xScreen(refused, refused.session, { code: 'xfail' });
  await screen.render().connect();
  console.log(`measured X5 X refuses the code: ${screen.render().state}`);
  assert.notEqual(screen.render().state, 'connected');
  assert.notEqual(owner(`select coalesce((select connection_status from public.social_accounts where id = ${lit(accountId(refused, 'x'))}), 'none')`), 'identity_verified');
});

test('X6. a replay of the same callback request: refused, the generation unchanged', T, async () => {
  const a = await person('x6');
  const screen = xScreen(a, a.session, { code: xCode(7006) });
  await screen.render().connect();
  assert.equal(screen.render().state, 'connected', screen.render().stateText);
  const sent = seen.filter((s) => s.url.endsWith('/g4ls-x-connect/callback')).at(-1);
  const id = accountId(a, 'x');
  const before = verdict('x', a, id);
  const replay = await fetch(sent.url, { method: 'POST', headers: sent.headers, body: sent.body });
  const text = await replay.text();
  console.log(`measured X6 replay: ${replay.status} ${text.slice(0, 80)}`);
  assert.notEqual(replay.status, 200);
  assert.equal(verdict('x', a, id), before);
});

test('X7. disconnect through the real RPC (its gate opened in this TEST world): DISCONNECTED, then connect again = a new generation', T, async () => {
  const a = xPeople.a;
  const id = accountId(a, 'x');
  const before = verdict('x', a, id);
  let screen = xScreen(a, a.session, { code: xCode(7001) });
  await screen.render().disconnect();
  assert.equal(screen.render().state, 'disconnected', screen.render().stateText);
  assert.equal(screen.reloads(), 1);
  const after = verdict('x', a, id);
  assert.match(after, /^false\|g4x1:[0-9]+\|DISCONNECTED$/u);
  assert.notEqual(after.split('|')[1], before.split('|')[1]);
  screen = xScreen(a, a.session, { code: xCode(7001) });
  await screen.render().connect();
  assert.equal(screen.render().state, 'connected', screen.render().stateText);
  assert.ok(verdict('x', a, id).startsWith('true|'));
  noProviderToken();
});

// ---- G4-02 #7: the X entry and the database's own profile answer --------------------------------------------------------------------------
const xCalls = async () => (await (await fetch(`${API}/functions/v1/g4ls-x-connect/__x_calls`, { headers: { apikey: PUBLISHABLE }, signal: AbortSignal.timeout(20000) })).json()).calls;
const rest = (fn, token) => fetch(`${API}/rest/v1/rpc/${fn}`, {
  method: 'POST', headers: { apikey: PUBLISHABLE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: '{}', signal: AbortSignal.timeout(20000),
});
const reloadSchema = () => owner("notify pgrst, 'reload schema'");

test('X8. the fence through real PostgREST: a person gets "personal"; no JWT is refused; a tampered JWT is refused', T, async () => {
  const a = await person('x8');
  const yes = await rest('postona_x_connect_profile_v1', a.session.access_token);
  assert.deepEqual([yes.status, await yes.json()], [200, 'personal']);
  const anon = await rest('postona_x_connect_profile_v1');
  assert.ok([401, 403, 404].includes(anon.status), `the anon role has no EXECUTE: ${anon.status}`);
  await anon.body?.cancel();
  const bad = await rest('postona_x_connect_profile_v1', `${a.session.access_token.slice(0, -4)}AAAA`);
  assert.equal(bad.status, 401);
  await bad.body?.cancel();
});

// Each row makes this real database not the personal build (real SQL, undone after the case); the entry must refuse with no X call and no write.
const mismatches = [
  ['F5 owner epoch present (the real PR #303 function name)', "create function private.account_lifecycle_brand_owner_epoch(text) returns bigint language sql as 'select 1::bigint'",
    'drop function private.account_lifecycle_brand_owner_epoch(text)'],
  ['the fence not installed (a full or a bare database: PostgREST 404)', 'alter function public.postona_x_connect_profile_v1() rename to postona_x_connect_profile_gone',
    'alter function public.postona_x_connect_profile_gone() rename to postona_x_connect_profile_v1'],
];
for (const [index, [label, breakIt, undo]] of mismatches.entries()) {
  const xId = 7090 + index;  // one X user per person: X refuses the same X user on a second account
  test(`X9. mismatch: ${label}: refused at start and at the callback; no X call, no state, no credential; correct again = connects`, T, async () => {
    const a = await person('x9');
    // positive control in the same worker: a connect reaches the fake X
    const before = await xCalls();
    let screen = xScreen(a, a.session, { code: xCode(xId) });
    await screen.render().connect();
    assert.equal(screen.render().state, 'connected', screen.render().stateText);
    const afterGood = await xCalls();
    assert.ok(afterGood > before, 'the counter sees a good connect');
    const id = accountId(a, 'x');
    const generation = verdict('x', a, id);
    const credential = () => owner(`select vault_access_token_secret_id::text || '|' || (select updated_at::text from vault.secrets where id = vault_access_token_secret_id) from public.social_accounts where id = ${lit(id)}`);
    const secret = credential();
    const stateCount = states(a);
    // at start
    owner(breakIt); reloadSchema();
    try {
      await new Promise((r) => setTimeout(r, 1500));
      screen = xScreen(a, a.session, { code: xCode(xId) });
      await screen.render().connect();
      assert.equal(screen.render().state, 'retryable_error', screen.render().stateText);
      assert.equal(screen.reloads(), 0);
      assert.equal(states(a), stateCount, 'no state');
      const direct = await post('g4ls-x-connect', { state: 's', code_challenge: 'c', redirect_uri: X_REDIRECT }, a.session.access_token);
      assert.equal(await answer(direct), '503 X_CONNECT_PROFILE_MISMATCH');
    } finally {
      owner(undo); reloadSchema();
      await new Promise((r) => setTimeout(r, 1500));
    }
    // at the callback: the start passed, the database changes while the person is at X
    let broke = false;
    screen = xScreen(a, a.session, { code: xCode(xId), during: async () => {
      owner(breakIt); reloadSchema(); broke = true;
      await new Promise((r) => setTimeout(r, 1500));
    } });
    try {
      await screen.render().connect();
      assert.ok(broke);
      assert.equal(screen.render().state, 'retryable_error', screen.render().stateText);
    } finally {
      owner(undo); reloadSchema();
      await new Promise((r) => setTimeout(r, 1500));
    }
    assert.equal(await xCalls(), afterGood, 'no call reached X');
    assert.equal(credential(), secret, 'the credential was not written');
    assert.match(verdict('x', a, id), /^false\|g4x1:[0-9]+\|CONNECT_PENDING$/u, 'only the open begin of the callback case remains');
    assert.equal(verdict('x', a, id).split('|')[1], generation.split('|')[1], 'the generation did not move');
    // correct again
    screen = xScreen(a, a.session, { code: xCode(xId) });
    await screen.render().connect();
    assert.equal(screen.render().state, 'connected', screen.render().stateText);
    assert.ok(verdict('x', a, id).startsWith('true|'));
    noProviderToken();
  });
}

test('X10. on a mismatched database, disconnect stays possible (it reaches no provider), and it never exchanges or stores anything', T, async () => {
  const a = await person('x10');
  let screen = xScreen(a, a.session, { code: xCode(7010) });
  await screen.render().connect();
  assert.equal(screen.render().state, 'connected', screen.render().stateText);
  const calls = await xCalls();
  const [, breakIt, undo] = mismatches[0];
  owner(breakIt);
  try {
    screen = xScreen(a, a.session, { code: xCode(7010) });
    await screen.render().disconnect();
    console.log(`measured X10 disconnect on a mismatched database: ${screen.render().state}`);
    assert.equal(screen.render().state, 'disconnected', screen.render().stateText);
    assert.equal(await xCalls(), calls, 'no provider call');
  } finally {
    owner(undo);
  }
});
