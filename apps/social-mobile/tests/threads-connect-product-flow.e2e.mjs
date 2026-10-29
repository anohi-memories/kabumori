// G4-02 #1 (Issue #561): the Threads connect / disconnect product flow end to end, driven by
// supabase/tests/postona_g4_threads_person_session_run.sh (G4T_APP_FLOW=1, which builds the database and sets FLOW_*).
// REAL: the app hooks use-threads-connect.ts / use-threads-disconnect.ts with their production runners and runtimes
// (threads-connect-starter/runtime, threads-disconnect-runner/runtime), @supabase/supabase-js (functions.invoke), the Edge
// entry threads_connect_entry.ts -> G4's composition -> H5's verifier + runtime -> G4's owner bridge (Deno, 127.0.0.1, see
// supabase/tests/postona_g4_threads_app_flow_edge.ts), the disconnect Edge handler (social-mobile-threads-disconnect), and the
// SQL in PostgreSQL 17 (PR #124, G4 001/002 + G4-42/43, H5 claim SQL, G5 S2-3/S2-2, publish stack + disconnect candidate).
// FAKE: GoTrue (RS256 JWTs signed here; JWKS + /auth/v1/user), Threads, PostgREST for the disconnect RPC (a psql bridge),
// the browser round trip (the person approves at Threads) and the app config (callback + associated domain).
// Not part of `npm test` (*.test.mjs): it needs the runner's database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import * as threadsDomain from '../src/domain/threads-connect.ts';
import * as disconnectDomain from '../src/domain/threads-disconnect.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';

const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} missing (run postona_g4_threads_person_session_run.sh with G4T_APP_FLOW=1)`); return v; };
const PG = { host: env('FLOW_PGHOST'), port: env('FLOW_PGPORT'), user: env('FLOW_PGUSER'), db: env('FLOW_DB') };
const SUPABASE_URL = 'https://flow.supabase.test';
const ANON_KEY = 'sb_publishable_flow_fake_0123456789';

// ---- PostgreSQL (the runner's owner role, local socket) ----------------------------------------------------------------
function psql(sql) {
  try {
    const out = execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db, '-c', sql],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (error) {
    const text = String(error.stderr ?? error.message);
    const m = /ERROR:\s+(.*)/u.exec(text);
    return { ok: false, message: m?.[1]?.trim() ?? text.trim() };
  }
}
const owner = (sql) => { const r = psql(sql); if (!r.ok) throw new Error(r.message); return r.out; };
const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replaceAll("'", "''")}'`);

// ---- GoTrue's keys and JWTs (RS256, verified by the real SDK in the Edge against the JWKS below) ---------------------------
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'flow-key', alg: 'RS256', use: 'sig' };
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
let projectUrl = '';
function jwt(claims) {
  const head = `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'flow-key' })}.${b64url({
    iss: `${projectUrl}auth/v1`, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000), ...claims,
  })}`;
  return `${head}.${sign('sha256', Buffer.from(head), privateKey).toString('base64url')}`;
}
const claimsOf = (bearer) => {
  const token = /^Bearer\s+(.+)$/u.exec(bearer ?? '')?.[1];
  if (!token || token === ANON_KEY) return null;
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { return null; }
};

// The disconnect Edge modules load first: if one cannot load, nothing has been spawned yet.
const disconnectHttp = await import('../../../supabase/functions/social-mobile-threads-disconnect/http.ts');
const disconnectCore = await import('../../../supabase/functions/_shared/social/threads_disconnect.ts');
const publishHttp = await import('../../../supabase/functions/social-mobile-threads-publish/http.ts');

// ---- the Threads connect Edge (Deno child, 127.0.0.1) ---------------------------------------------------------------------
const edgeCmd = JSON.parse(env('FLOW_EDGE_CMD'));
const edge = spawn(edgeCmd[0], edgeCmd.slice(1), {
  env: { ...process.env, FLOW_JWK: JSON.stringify(JWK) }, stdio: ['pipe', 'pipe', 'inherit'],
});
// the Deno child never outlives this process, whatever fails: it exits when its stdin (this process) closes
process.on('exit', () => edge.kill());
const listening = await new Promise((resolve, reject) => {
  let out = '';
  edge.stdout.on('data', (chunk) => {
    out += chunk;
    const m = /FLOW_EDGE (\{.*\})/u.exec(out);
    if (m) resolve(JSON.parse(m[1]));
  });
  edge.on('exit', (code) => reject(new Error(`the Edge exited (${code}) before listening`)));
  setTimeout(() => reject(new Error('the Edge did not listen within 60 s')), 60000).unref();
});
test.after(() => edge.kill());
const edgeUrl = `http://127.0.0.1:${listening.port}`;
// H5's offline fixture (the Edge's dummy config): the project whose issuer the JWTs carry, and the registered callback
projectUrl = listening.projectUrl;
const CALLBACK = listening.callback;
const stats = async () => (await realFetch(`${edgeUrl}/stats`)).json();
const threadsCalls = async () => (await stats()).threads;

// ---- the disconnect Edge (REAL handler, in this process) + fake PostgREST + fake GoTrue ----------------------------------------
const realFetch = globalThis.fetch;
const DISCONNECT_ENV = { get: (k) => ({ SUPABASE_URL, SUPABASE_ANON_KEY: ANON_KEY })[k] };
const closedDisconnect = disconnectHttp.createHandler(DISCONNECT_ENV, (...a) => globalThis.fetch(...a));
// the same construction as createHandler's inner handler (the static gate is false in source: tests open it here only)
const openDisconnect = (request) => disconnectCore.handleThreadsDisconnect(request, {
  getUser: publishHttp.createGetUser({ supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY }, (...a) => globalThis.fetch(...a)),
  disconnect: disconnectCore.createThreadsDisconnectRpc({ supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY }, (...a) => globalThis.fetch(...a)),
});
function postgrest(name, args, bearer) {
  if (name !== 'disconnect_threads_account') return Response.json({ code: 'PGRST202', message: 'not in this fixture' }, { status: 404 });
  const claims = claimsOf(bearer);
  const role = claims?.role === 'authenticated' ? 'authenticated' : 'anon';
  const call = `public.${name}(${Object.entries(args ?? {}).map(([k, v]) => `${k} => ${lit(v)}`).join(', ')})`;
  const r = psql(`begin; select set_config('request.jwt.claims', ${lit(claims ? JSON.stringify(claims) : '')}, true) is null; `
    + `set local role ${role}; select coalesce(to_json(${call})::text, 'null'); commit;`);
  if (r.ok) return new Response(r.out.split('\n').pop(), { status: 200, headers: { 'content-type': 'application/json' } });
  return Response.json({ code: 'P0001', message: r.message }, { status: 400 });
}
function gotrueUser(bearer) {
  const claims = claimsOf(bearer);
  if (!claims?.sub || owner(`select count(*) from auth.users where id = ${lit(claims.sub)}::uuid`) !== '1') return Response.json({ msg: 'invalid JWT' }, { status: 401 });
  return Response.json({ id: claims.sub, aud: 'authenticated', role: 'authenticated', is_anonymous: claims.is_anonymous === true });
}

// ---- the app's network: functions/v1 -> the Edges, rest/v1/rpc -> PostgREST, auth/v1/user -> GoTrue ------------------------
const flow = { connectEntry: 'open', disconnectOpen: true };
const sent = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers));
  const bodyText = init.body === undefined ? undefined : String(init.body);
  let response;
  if (url === `${SUPABASE_URL}/functions/v1/threads-oauth-connect-user`) {
    sent.push({ fn: 'connect', action: JSON.parse(bodyText ?? '{}').action });
    response = await realFetch(`${edgeUrl}/${flow.connectEntry}/functions/v1/threads-oauth-connect-user`, { method: init.method ?? 'POST', headers, body: bodyText });
  } else if (url === `${SUPABASE_URL}/functions/v1/social-mobile-threads-disconnect`) {
    sent.push({ fn: 'disconnect' });
    const request = new Request(url, { method: init.method ?? 'POST', headers, body: bodyText });
    response = await (flow.disconnectOpen ? openDisconnect(request) : closedDisconnect(request));
  } else if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) {
    response = postgrest(url.slice(`${SUPABASE_URL}/rest/v1/rpc/`.length).split('?')[0], bodyText ? JSON.parse(bodyText) : {}, headers.get('Authorization'));
  } else if (url === `${SUPABASE_URL}/auth/v1/user`) {
    response = gotrueUser(headers.get('Authorization'));
  } else {
    throw new Error(`unexpected fetch ${url}`);
  }
  if (process.env.FLOW_DEBUG) console.error(`[flow] ${url} -> ${response.status} ${(await response.clone().text()).slice(0, 300)}`);
  return response;
};

// ---- the REAL hooks, runners and runtimes (TypeScript transpiled, module edges stubbed) --------------------------------
const transpiled = new Map();
async function loadTs(rel, modules) {
  const file = new URL(`../src/${rel}`, import.meta.url);
  if (!transpiled.has(rel)) {
    const source = await readFile(file, 'utf8');
    transpiled.set(rel, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);
  }
  const mod = { exports: {} };
  vm.runInNewContext(transpiled.get(rel), { module: mod, exports: mod.exports, URL, Response, setTimeout, clearTimeout, Promise,
    require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n} in ${rel}`); return modules[n]; } }, { filename: rel });
  return mod.exports;
}
const CONFIGURED = { extra: { threadsConnectCallbackUrl: null }, ios: { associatedDomains: [] } };

/** One mounted screen: the session the auth provider shows (`auth.session`), `approve` = the Threads user the person
 *  approves as (or a function that runs while the person is at Threads and returns that user). */
async function screen({ session, configured = true }) {
  const auth = { session };
  const slots = [];
  let cursor = 0, reloads = 0;
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (...a) => globalThis.fetch(...a) },
  });
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback: (cb) => cb,
    useLayoutEffect: (effect) => effect(),
  };
  const browser = { approve: null, served: 0 };
  const host = CALLBACK && new URL(CALLBACK).hostname;
  const expoConfig = configured
    ? { extra: { threadsConnectCallbackUrl: CALLBACK }, ios: { associatedDomains: [`applinks:${host}`] } }
    : CONFIGURED;
  const supabaseModule = { supabase: client };
  const base = { '@/lib/supabase': supabaseModule, '@/providers/auth-provider': { useAuth: () => ({ session: auth.session }) } };
  const starter = await loadTs('features/threads-connect/threads-connect-starter.ts', {
    '@/domain/threads-connect': threadsDomain, '@/domain/recovery-binding': recoveryBinding,
  });
  const runtime = await loadTs('features/threads-connect/threads-connect-runtime.ts', {
    'expo-constants': { __esModule: true, default: { expoConfig } },
    'expo-linking': { addEventListener: () => ({ remove() {} }) },
    'expo-web-browser': {
      // the person at Threads: approves as `browser.approve` (a puid, or a function run there that returns one)
      openAuthSessionAsync: async (authorizationUrl, redirect) => {
        browser.served += 1;
        const state = new URL(authorizationUrl).searchParams.get('state');
        const puid = typeof browser.approve === 'function' ? await browser.approve() : browser.approve;
        if (puid === null) return { type: 'cancel' };
        return { type: 'success', url: `${redirect}?code=code${puid}x${randomUUID().slice(0, 8).replace(/\D/gu, '1')}${browser.served}&state=${encodeURIComponent(state)}#_` };
      },
      dismissAuthSession() {},
    },
    'react-native': { Platform: { OS: 'ios', Version: '18.0' } },
    '@/domain/threads-connect': threadsDomain,
    '@/features/threads-connect/threads-connect-starter': starter,
    ...base,
  });
  const connectHook = await loadTs('features/threads-connect/use-threads-connect.ts', {
    react, '@/features/threads-connect/threads-connect-runtime': runtime,
    '@/features/threads-connect/threads-connect-starter': starter, ...base,
  });
  const runner = await loadTs('features/threads-disconnect/threads-disconnect-runner.ts', { '@/domain/threads-disconnect': disconnectDomain });
  const disconnectRuntime = await loadTs('features/threads-disconnect/threads-disconnect-runtime.ts', {
    '@/domain/threads-disconnect': disconnectDomain, ...base,
  });
  const disconnectHook = await loadTs('features/threads-disconnect/use-threads-disconnect.ts', {
    react, '@/features/threads-disconnect/threads-disconnect-runner': runner,
    '@/features/threads-disconnect/threads-disconnect-runtime': disconnectRuntime, ...base,
  });
  let accounts = [];
  const render = () => {
    cursor = 0;
    const connect = connectHook.useThreadsConnect({ accounts, reload: () => { reloads += 1; }, releaseEnabled: true });
    const disconnect = disconnectHook.useThreadsDisconnect({ accounts, reload: () => { reloads += 1; }, releaseEnabled: true });
    return { connect, disconnect };
  };
  return {
    render, browser, reloads: () => reloads,
    /** the auth provider now shows `next` (a sign-in, a sign-out, a refreshed token): the screen re-renders */
    signIn(next) { auth.session = next; render(); },
    setAccounts(list) { accounts = list; },
  };
}

// ---- people (the runner's world: fixture_login, a live auth session, POSTONA started or not) --------------------------------
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sid = (n, k = 1) => `${String(k).padStart(8, '0')}-0000-4000-9000-${String(n).padStart(12, '0')}`;
const sessionOf = (n, k = 1, extra = {}) => ({
  access_token: jwt({ sub: uid(n), session_id: sid(n, k), is_anonymous: false, ...extra }),
  user: { id: uid(n) },
});
function person(n, start) {
  owner(`begin; select public.fixture_login(${lit(uid(n))}::uuid); insert into auth.sessions(id, user_id) values (${lit(sid(n))}::uuid, ${lit(uid(n))}::uuid);`
    + (start ? ` select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: uid(n), role: 'authenticated', session_id: sid(n), is_anonymous: false }))}, true);`
      + ' select public.start_x_autopost_service();' : '') + ' commit;');
  return sessionOf(n);
}
function newSession(n, k) {
  owner(`insert into auth.sessions(id, user_id) values (${lit(sid(n, k))}::uuid, ${lit(uid(n))}::uuid)`);
  return sessionOf(n, k);
}
const workspace = (n) => `public.social_mobile_account_deletion_workspace(${lit(uid(n))}::uuid)`;
const threadsAccount = (n) => {
  const row = owner(`select coalesce((select id || '|' || connection_status || '|' || coalesce(handle, '-') from public.social_accounts
    where brand_id = ${workspace(n)} and platform = 'threads'), 'none')`);
  if (row === 'none') return null;
  const [id, status, handle] = row.split('|');
  return { id, status, handle };
};
const binding = (n) => owner(`select coalesce((select b.threads_user_id || '|' || b.oauth_state_id from postona_threads_binding.bindings b
  join public.social_accounts sa on sa.id = b.social_account_id where sa.brand_id = ${workspace(n)}), 'none')`);
const states = (n) => Number(owner(`select count(*) from public.social_account_oauth_states where initiated_by_user_id = ${lit(uid(n))}::uuid`));
const custody = (n) => Number(owner(`select count(*) from public.threads_account_credential_custody c join public.social_accounts sa on sa.id = c.social_account_id
  where sa.brand_id = ${workspace(n)}`));
const callbacksSent = () => sent.filter((s) => s.fn === 'connect' && s.action === 'callback').length;

const A = 4701, B = 4702, C = 4703, D = 4704, E = 4705;
const SESSION_A = person(A, true);
const SESSION_B = person(B, true);
const SESSION_C = person(C, false);
person(D, true);
person(E, true);

async function connectAs(app, puid) {
  app.browser.approve = puid;
  await app.render().connect.connect();
  return app.render().connect.state;
}

// ---- scenarios ------------------------------------------------------------------------------------------------------------
test('1. A connects: hook -> SDK -> Edge entry -> G4 composition -> H5 runtime -> G4 bridge -> SQL; the screen verifies it', { timeout: 60000 }, async () => {
  const app = await screen({ session: SESSION_A });
  const state = await connectAs(app, '17841400000004701');
  assert.equal(state.kind, 'verifying', JSON.stringify(state));
  const account = threadsAccount(A);
  assert.equal(state.accountId, account.id);
  assert.equal(app.reloads(), 1, 'the shared account data is reloaded once');
  assert.match(binding(A), /^17841400000004701\|/u, 'G4 binding written by the entry');
  assert.equal(custody(A), 1, 'custody written in the same connect transaction (connect proof)');
  assert.equal(app.render().connect.verified, false, 'not "connected" before the reloaded data says so');
  app.setAccounts([{ id: account.id, platform: 'threads', connectionStatus: 'connected' }]);
  assert.equal(app.render().connect.verified, true);
});

test('2. A reconnects: a new state replaces the binding; still one account and one custody row', { timeout: 60000 }, async () => {
  const before = binding(A);
  const app = await screen({ session: SESSION_A });
  const state = await connectAs(app, '17841400000004701');
  assert.equal(state.kind, 'verifying', JSON.stringify(state));
  assert.notEqual(binding(A), before);
  assert.match(binding(A), /^17841400000004701\|/u);
  assert.equal(custody(A), 1);
});

test('3. the token is refreshed while A is at Threads (same session): connected with the refreshed token', { timeout: 60000 }, async () => {
  const app = await screen({ session: SESSION_A });
  const refreshed = { access_token: jwt({ sub: uid(A), session_id: sid(A), is_anonymous: false, iat: Math.floor(Date.now() / 1000) + 5 }), user: { id: uid(A) } };
  assert.notEqual(refreshed.access_token, SESSION_A.access_token);
  const state = await connectAs(app, async () => { app.signIn(refreshed); return '17841400000004701'; });
  assert.equal(state.kind, 'verifying', JSON.stringify(state));
});

test('4. B signs in while A is at Threads: nothing is forwarded (SESSION_CHANGED), nothing reloaded', { timeout: 60000 }, async () => {
  const app = await screen({ session: SESSION_A });
  const before = { cb: callbacksSent(), binding: binding(A) };
  const state = await connectAs(app, async () => { app.signIn(SESSION_B); return '17841400000004701'; });
  assert.equal(state.kind, 'done');
  assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'SESSION_CHANGED', reconcile: false });
  assert.equal(callbacksSent(), before.cb, 'no callback was sent');
  assert.equal(binding(A), before.binding);
  assert.equal(app.reloads(), 0);
});

test('5. A -> B -> A (a NEW session of A): refused in the app before the code is forwarded (G4-49 pin)', { timeout: 60000 }, async () => {
  const app = await screen({ session: SESSION_A });
  const again = newSession(A, 2);
  const before = callbacksSent();
  const state = await connectAs(app, async () => { app.signIn(SESSION_B); app.signIn(again); return '17841400000004701'; });
  assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'SESSION_CHANGED', reconcile: false });
  assert.equal(callbacksSent(), before);
});

test('6. an anonymous session: refused at start by the actor verifier; no state, Threads never called', { timeout: 60000 }, async () => {
  const anon = { access_token: jwt({ sub: uid(A), session_id: sid(A), is_anonymous: true }), user: { id: uid(A) } };
  const app = await screen({ session: anon });
  const before = { states: states(A), threads: await threadsCalls() };
  const state = await connectAs(app, '17841400000004701');
  // H5's runtime answers every start failure with one code (the verifier's AUTH_REQUIRED is not exposed)
  assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'START_REFUSED', reconcile: false });
  assert.equal(app.browser.served, 0, 'the browser never opened');
  assert.equal(states(A), before.states);
  assert.equal(await threadsCalls(), before.threads);
});

test('7. C has not started POSTONA: refused at start (G5 lifecycle via the G4 bridge); no state, no browser', { timeout: 60000 }, async () => {
  const app = await screen({ session: SESSION_C });
  const state = await connectAs(app, '17841400000004703');
  assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'START_REFUSED', reconcile: false });
  assert.equal(app.browser.served, 0);
  assert.equal(states(C), 0);
  assert.equal(binding(C), 'none');
  assert.equal((await stats()).lastSqlError, 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'refused by the G5 lifecycle check');
});

test('8. ABA: D\'s service ends and restarts while D is at Threads (SYNTHETIC lifecycle_version +2): nothing bound, reconcile', { timeout: 60000 }, async () => {
  const app = await screen({ session: sessionOf(D) });
  const state = await connectAs(app, async () => {
    owner(`update public.common_accounts set lifecycle_version = lifecycle_version + 2 where user_id = ${lit(uid(D))}::uuid`);
    return '17841400000004704';
  });
  assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'COMPLETE_OUTCOME_UNKNOWN', reconcile: true });
  assert.equal(binding(D), 'none');
  assert.equal(custody(D), 0);
  assert.equal((await stats()).lastSqlError, 'THREADS_BINDING_SERVICE_GENERATION_CHANGED', 'refused by the G4 entry generation check');
});

test('9. Threads refuses the code: a fixed failure, nothing bound', { timeout: 60000 }, async () => {
  const app = await screen({ session: sessionOf(E) });
  const state = await connectAs(app, '0');
  assert.equal(state.kind, 'done');
  // the code was sent to Threads before it refused, so the runtime cannot rule out a grant: reconcile
  assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'EXCHANGE_OUTCOME_UNCERTAIN', reconcile: true });
  assert.equal(binding(E), 'none');
});

test('10. the person cancels at Threads: canceled, nothing forwarded', { timeout: 60000 }, async () => {
  const app = await screen({ session: sessionOf(E) });
  const before = callbacksSent();
  const state = await connectAs(app, null);
  assert.deepEqual({ ...state.result }, { kind: 'canceled' });
  assert.equal(callbacksSent(), before);
});

test('11. the entry as in source (static gate closed): THREADS_CONNECT_DISABLED, no browser', { timeout: 60000 }, async () => {
  flow.connectEntry = 'closed';
  try {
    const app = await screen({ session: SESSION_A });
    const state = await connectAs(app, '17841400000004701');
    assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'THREADS_CONNECT_DISABLED', reconcile: false });
    assert.equal(app.browser.served, 0);
  } finally {
    flow.connectEntry = 'open';
  }
});

test('12. no callback configured in this build: unavailable before any request', { timeout: 60000 }, async () => {
  const app = await screen({ session: SESSION_A, configured: false });
  const before = sent.length;
  const state = await connectAs(app, '17841400000004701');
  assert.deepEqual({ ...state.result }, { kind: 'unavailable', code: 'CALLBACK_NOT_CONFIGURED' });
  assert.equal(sent.length, before);
});

test('13. disconnect with the server gates as in source: DISCONNECT refused, nothing removed', { timeout: 60000 }, async () => {
  const account = threadsAccount(A);
  const app = await screen({ session: SESSION_A });
  app.setAccounts([{ id: account.id, platform: 'threads', connectionStatus: 'connected' }]);
  flow.disconnectOpen = false;
  try {
    app.render().disconnect.ask({ id: account.id, handle: account.handle });
    await app.render().disconnect.confirm();
  } finally {
    flow.disconnectOpen = true;
  }
  const state = app.render().disconnect.state;
  assert.equal(state.kind, 'done', JSON.stringify(state));
  assert.equal(state.result.kind, 'failed');
  assert.equal(state.result.code, 'THREADS_DISCONNECT_DISABLED', JSON.stringify(state.result));
  assert.match(binding(A), /^17841400000004701\|/u);
  assert.equal(custody(A), 1);
});

test('14. disconnect (gates opened in this TEST world only), then reconnect through the G4 bridge', { timeout: 60000 }, async () => {
  owner("create or replace function public.threads_disconnect_gate_open() returns boolean language sql immutable set search_path = '' as $$ select true $$");
  const account = threadsAccount(A);
  const app = await screen({ session: SESSION_A });
  app.setAccounts([{ id: account.id, platform: 'threads', connectionStatus: 'connected' }]);
  app.render().disconnect.ask({ id: account.id, handle: account.handle });
  await app.render().disconnect.confirm();
  const state = app.render().disconnect.state;
  assert.equal(state.kind, 'verifying', JSON.stringify(state));
  assert.equal(state.result.kind, 'disconnected');
  assert.equal(custody(A), 0, 'local credentials removed');
  // the disconnect RPC deletes the account row; the binding and the custody row go with it (ON DELETE CASCADE)
  assert.equal(threadsAccount(A), null, 'account row removed');
  assert.equal(owner(`select count(*) from postona_threads_binding.bindings where threads_user_id = '17841400000004701'`), '0', 'binding removed');
  const again = await screen({ session: SESSION_A });
  const reconnected = await connectAs(again, '17841400000004701');
  assert.equal(reconnected.kind, 'verifying', JSON.stringify(reconnected));
  assert.match(binding(A), /^17841400000004701\|/u);
  assert.equal(custody(A), 1);
});

// ---- G4-02 #2: the G5 authorization profile (FLOW_PROFILE: "full" = PR #303 owner epoch, "personal" = G5's MVP, g5pv) ----
const PROFILE = env('FLOW_PROFILE');

test('15. the bridge pinned to the OTHER G5 profile than the database: refused at start, nothing recorded, Threads never called', { timeout: 60000 }, async () => {
  const app = await screen({ session: sessionOf(E) });
  const before = { states: states(E), threads: await threadsCalls() };
  flow.connectEntry = 'mismatch';
  let state;
  try {
    state = await connectAs(app, '17841400000004705');
  } finally {
    flow.connectEntry = 'open';
  }
  assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'START_REFUSED', reconcile: false });
  assert.equal(app.browser.served, 0);
  assert.equal(states(E), before.states, 'the begin rolled back with the refused record');
  assert.equal(await threadsCalls(), before.threads);
  // the other profile's SQL does not exist in this database: the full bridge reads F5's owner epoch; the personal one calls
  // the g5pv record_state_generation(uuid, uuid, bigint)
  assert.equal((await stats()).lastSqlError, PROFILE === 'personal'
    ? 'function private.account_lifecycle_brand_owner_epoch(text) does not exist'
    : 'function postona_threads_binding.record_state_generation(uuid, uuid, bigint) does not exist');
});

test('16. no G5 profile configured: the composition is not built (unavailable), no browser', { timeout: 60000 }, async () => {
  const app = await screen({ session: sessionOf(E) });
  flow.connectEntry = 'unpinned';
  let state;
  try {
    state = await connectAs(app, '17841400000004705');
  } finally {
    flow.connectEntry = 'open';
  }
  assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'THREADS_CONNECT_RUNTIME_UNAVAILABLE', reconcile: false });
  assert.equal(app.browser.served, 0);
});

const otherBrandOfE = `insert into public.brands (id, display_name) values ('flow_other_e', 'Another');
  insert into public.brand_memberships (brand_id, user_id, role) values ('flow_other_e', ${lit(uid(E))}::uuid, 'owner')`;

test('17. E already owns another brand: PR #124\'s begin refuses (both profiles); no state, no browser', { timeout: 60000 }, async () => {
  owner(otherBrandOfE);
  try {
    const app = await screen({ session: sessionOf(E) });
    const state = await connectAs(app, '17841400000004705');
    assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'START_REFUSED', reconcile: false });
    assert.equal(app.browser.served, 0);
    assert.equal((await stats()).lastSqlError, 'SOCIAL_MOBILE_WORKSPACE_CONFLICT');
    assert.equal(binding(E), 'none');
  } finally {
    owner(`delete from public.brands where id = 'flow_other_e'`);
  }
});

test('18. E comes to own another brand while at Threads: refused at the callback, nothing bound', { timeout: 60000 }, async () => {
  try {
    const app = await screen({ session: sessionOf(E) });
    const state = await connectAs(app, async () => { owner(otherBrandOfE); return '17841400000004705'; });
    assert.equal(state.kind, 'done', JSON.stringify(state));
    console.log(`measured 18 (${PROFILE}): ${JSON.stringify(state.result)} sql=${(await stats()).lastSqlError}`);
    // PR #124's complete does not see it; G4's entry does: personal = G5's MV (S2-3 inside), full = G4-42's S2-3 recheck
    assert.deepEqual({ ...state.result }, { kind: 'failed', code: 'COMPLETE_OUTCOME_UNKNOWN', reconcile: true });
    assert.equal((await stats()).lastSqlError, 'OWN_WORKSPACE_CONFLICT');
    assert.equal(binding(E), 'none');
    assert.equal(custody(E), 0);
  } finally {
    owner(`delete from public.brands where id = 'flow_other_e'`);
  }
});
