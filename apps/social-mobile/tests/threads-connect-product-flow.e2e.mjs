// G4-02 #1 (Issue #561): the Threads connect / disconnect product flow end to end, driven by
// supabase/tests/postona_g4_threads_person_session_run.sh (G4T_APP_FLOW=1, which builds the database and sets FLOW_*).
// REAL: the app hooks use-threads-connect.ts / use-threads-disconnect.ts with their production runners and runtimes
// (threads-connect-starter/runtime, threads-disconnect-runner/runtime), @supabase/supabase-js (functions.invoke), the Edge
// entry threads_connect_entry.ts -> G4's composition -> H5's verifier + runtime -> G4's owner bridge (Deno, 127.0.0.1, see
// supabase/tests/postona_g4_threads_app_flow_edge.ts), the disconnect Edge handler (social-mobile-threads-disconnect), and the
// SQL in PostgreSQL 17 (PR #124, G4 001/002 + G4-42/43, H5 claim SQL, G5 S2-3/S2-2, publish stack + disconnect candidate).
// FAKE: GoTrue (RS256 JWTs signed here; JWKS + /auth/v1/user), Threads, PostgREST for the disconnect RPC (a psql bridge),
// the browser round trip (the person approves at Threads) and the app config (callback + associated domain).
// G4-02 #11 (scenarios 20-30): after a REAL connect, the app's manual publish hook -> the publish Edge over 127.0.0.1 HTTP ->
// the attested publish / release SQL (+ postona_g4_threads_manual_publish_verdict/001) -> a FAKE Threads publish API that
// counts every write; nothing else is reachable from the Edge (refused and recorded).
// G4-02 #12 (scenarios 31-32): an attempt is bound to the connection it was begun under (+ .../002): a reconnect in the
// middle of a post (at the provider boundary, or racing the release in PostgreSQL) never lets the old attempt write.
// G4-02 #13 (scenario 33): the send onset is the publish release's COMMIT; .../002's send fence refuses a reconnect / re-bind
// while that send is leased, so no old attempt posts after a reconnect committed (H1 #41's order, a race).
// G4-02 #14 (scenario 33, 31 (d)): no clock ends that lease, only a recorded outcome (the server's, or the provider's final
// container status read by reconcile): the database's clock alone ahead, the Edge's clock alone ahead / behind, a stalled
// server the database gave up on (H1 #42's order and its neighbours).
// Not part of `npm test` (*.test.mjs): it needs the runner's database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign, randomUUID, createHmac, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import * as threadsDomain from '../src/domain/threads-connect.ts';
import * as disconnectDomain from '../src/domain/threads-disconnect.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';
import * as publishDomain from '../src/domain/threads-manual-publish.ts';

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
// G4-02 #11: the manual publish Edge's six RPCs (social-mobile-threads-publish/http.ts THREADS_PUBLISH_RPC) join the disconnect one
const POSTGREST_RPCS = new Set(['disconnect_threads_account', ...Object.values(publishHttp.THREADS_PUBLISH_RPC)]);
// a token past its exp is refused as PostgREST / GoTrue refuse it (the SDK verification lives in the connect Edge only)
const expired = (claims) => typeof claims?.exp === 'number' && claims.exp <= Math.floor(Date.now() / 1000);
function postgrest(name, args, bearer) {
  if (!POSTGREST_RPCS.has(name)) return Response.json({ code: 'PGRST202', message: 'not in this fixture' }, { status: 404 });
  const claims = claimsOf(bearer);
  if (expired(claims)) return Response.json({ code: 'PGRST301', message: 'JWT expired' }, { status: 401 });
  const role = claims?.role === 'authenticated' ? 'authenticated' : 'anon';
  const call = `public.${name}(${Object.entries(args ?? {}).map(([k, v]) => `${k} => ${lit(v)}`).join(', ')})`;
  const r = psql(`begin; select set_config('request.jwt.claims', ${lit(claims ? JSON.stringify(claims) : '')}, true) is null; `
    + `set local role ${role}; select coalesce(to_json(${call})::text, 'null'); commit;`);
  if (r.ok) return new Response(r.out.split('\n').pop(), { status: 200, headers: { 'content-type': 'application/json' } });
  return Response.json({ code: 'P0001', message: r.message }, { status: 400 });
}
function gotrueUser(bearer) {
  const claims = claimsOf(bearer);
  if (!claims?.sub || expired(claims) || owner(`select count(*) from auth.users where id = ${lit(claims.sub)}::uuid`) !== '1') return Response.json({ msg: 'invalid JWT' }, { status: 401 });
  return Response.json({ id: claims.sub, aud: 'authenticated', role: 'authenticated', is_anonymous: claims.is_anonymous === true });
}

// ---- the app's network: functions/v1 -> the Edges, rest/v1/rpc -> PostgREST, auth/v1/user -> GoTrue ------------------------
const flow = { connectEntry: 'open', disconnectOpen: true };
// G4-02 #11: the manual publish Edge (a 127.0.0.1 HTTP server further down): its base URL, which entry ('open' | 'closed'),
// and how many app requests to it are still in flight (a screen settles when none is)
const pub = { base: null, entry: 'open', inFlight: 0, clockSkewMs: 0 };
// G4-02 #13: a one-shot hook after a release RPC has COMMITTED and before its answer reaches the publish Edge (H1 #41's order)
const pgApi = { afterRelease: null };
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
  } else if (url === `${SUPABASE_URL}/functions/v1/social-mobile-threads-publish`) {
    sent.push({ fn: 'publish', action: JSON.parse(bodyText ?? '{}').action });
    pub.inFlight += 1;
    try {
      response = await realFetch(`${pub.base}/${pub.entry}/functions/v1/social-mobile-threads-publish`, { method: init.method ?? 'POST', headers, body: bodyText });
    } finally {
      pub.inFlight -= 1;
    }
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
  assert.equal(app.reloads(), 1, 'reconcile: the accounts are re-read (G4-02 #3)');
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
  assert.equal(app.reloads(), 1, 'reconcile: the accounts are re-read (G4-02 #3)');
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
    assert.equal(app.reloads(), 1, 'reconcile: the accounts are re-read (G4-02 #3)');
    assert.equal(binding(E), 'none');
    assert.equal(custody(E), 0);
  } finally {
    owner(`delete from public.brands where id = 'flow_other_e'`);
  }
});

// ---- G4-02 #4: the read-only Threads publish-credential verdict G3's consumer binds to (postona_g4_credential, 001) ----
const verdict = (asker, accountId) => owner(`select r.verified::text || '|' || coalesce(r.credential_generation, '-') || '|' || r.code
  from postona_g4_credential.threads_publish_credential_verdict(${lit(uid(asker))}::uuid, ${lit(accountId)}) r`);
const stateOf = (n) => binding(n).split('|')[1];

test('19. the Threads verdict across connect / reconnect / re-bind / expiry / error / disconnect / service end', { timeout: 60000 }, async () => {
  const account = () => threadsAccount(A).id;
  // connected (scenario 14 left A connected): verified, generation = this binding's connect
  assert.equal(verdict(A, account()), `true|g4t1:${stateOf(A)}|VERIFIED`);
  const g1 = verdict(A, account()).split('|')[1];
  // another person; an absent account; D's account (scenario 8: the ABA connect never bound)
  assert.equal(verdict(B, account()), 'false|-|NOT_OWN_WORKSPACE');
  assert.equal(verdict(A, 'sa_000000000000000000000000'), 'false|-|NOT_CONNECTED');
  const d = threadsAccount(D);
  if (d) assert.equal(verdict(D, d.id), 'false|-|NOT_BOUND');
  // no credential material in the answer
  const secret = owner(`select vault_access_token_secret_id::text from public.social_accounts where id = ${lit(account())}`);
  assert.ok(!verdict(A, account()).includes(secret) && !/long[0-9]+abc|short[0-9]+abc/u.test(verdict(A, account())), 'no token / secret id');
  // reconnect (same Threads user): a new generation
  let app = await screen({ session: SESSION_A });
  assert.equal((await connectAs(app, '17841400000004701')).kind, 'verifying');
  const g2 = verdict(A, account()).split('|')[1];
  assert.ok(g2 !== g1 && verdict(A, account()) === `true|g4t1:${stateOf(A)}|VERIFIED`, 'reconnect = new generation');
  // re-bind to another Threads user
  app = await screen({ session: SESSION_A });
  const rebind = await connectAs(app, '17841400000009701');
  console.log(`measured 19 re-bind to another Threads user: ${JSON.stringify(rebind.result ?? rebind.kind)} sql=${(await stats()).lastSqlError}`);
  // a re-bind of the account to another Threads user is refused at completion (the code was spent: reconcile);
  // the verdict keeps answering for the binding that still holds
  assert.deepEqual({ ...rebind.result }, { kind: 'failed', code: 'COMPLETE_OUTCOME_UNKNOWN', reconcile: true });
  assert.equal(verdict(A, account()), `true|${g2}|VERIFIED`, 'a refused re-bind leaves the generation');
  const g3 = verdict(A, account()).split('|')[1];
  // custody expired; a connection error (SYNTHETIC)
  owner(`update public.threads_account_credential_custody set expires_at = now() - interval '1 second' where social_account_id = ${lit(account())}`);
  assert.equal(verdict(A, account()), `false|${g3}|CREDENTIAL_EXPIRED`);
  owner(`update public.threads_account_credential_custody set expires_at = now() + interval '50 days' where social_account_id = ${lit(account())}`);
  owner(`update public.social_accounts set last_connection_error_code = 'THREADS_TEST_ERROR' where id = ${lit(account())}`);
  assert.equal(verdict(A, account()), `false|${g3}|CONNECTION_ERROR`);
  owner(`update public.social_accounts set last_connection_error_code = null where id = ${lit(account())}`);
  assert.equal(verdict(A, account()), `true|${g3}|VERIFIED`);
  // disconnect through the app (the gate scenario 14 opened in this TEST world): the rows are gone
  const gone = account();
  app = await screen({ session: SESSION_A });
  app.setAccounts([{ id: gone, platform: 'threads', connectionStatus: 'connected' }]);
  app.render().disconnect.ask({ id: gone, handle: threadsAccount(A).handle });
  await app.render().disconnect.confirm();
  assert.equal(verdict(A, gone), 'false|-|NOT_CONNECTED');
  // connect again: verified with a generation never seen before
  app = await screen({ session: SESSION_A });
  assert.equal((await connectAs(app, '17841400000004701')).kind, 'verifying');
  const g4 = verdict(A, account()).split('|')[1];
  assert.ok(![g1, g2, g3].includes(g4) && verdict(A, account()).startsWith('true|'), 'never an old generation');
  // the service ends (SYNTHETIC end, as G5 leaves it)
  owner(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = ${lit(uid(A))}::uuid and service_key = 'x_autopost'`);
  assert.equal(verdict(A, account()), `false|${g4}|SERVICE_NOT_ACTIVE`);
});

// ==== G4-02 #11 (Issue #561): connect -> manual publish -> result (confirmed / failed / unknown), end to end ===============
// REAL: the connect flow above; the app hook use-threads-manual-publish.ts (real supabase-js functions.invoke); the publish Edge
// (social-mobile-threads-publish: logic.ts handleThreadsPublish + http.ts createStore / createGetUser, the same construction as
// createHandler's inner handler) served over HTTP on 127.0.0.1; its attested RPCs into the publish + release SQL candidates in
// this PostgreSQL 17 world, which hand out the token the CONNECT stored in (fake) Vault.
// FAKE: the Threads publish API (below: containers, publish, read-back, listing; every write counted), PostgREST (psql bridge),
// GoTrue. Any other host the Edge asks for is refused and recorded (`denied`): no request leaves this process.
const publishLogic = await import('../../../supabase/functions/social-mobile-threads-publish/logic.ts');
const { createServer } = await import('node:http');
const PUBLISH_KEY = 'fake_publish_attestation_key_0123456789abcdef0123456789';
// the release candidate's server attestation key, as the test world's (fake) Vault holds it -- TEST-ONLY value
owner(`insert into vault.secrets (name, secret) values ('postona_threads_publish_attestation_v1', ${lit(PUBLISH_KEY)}) on conflict (name) do nothing`);

const threadsApi = { plan: {}, containers: new Map(), posts: [], writes: [], reads: 0, seq: 18000000000000100n };
const denied = [];
const graphError = (code, status = 400) => Response.json({ error: { message: 'fake refusal', type: 'OAuthException', code } }, { status });
const tokenUser = (token) => /^long([1-9][0-9]{0,31})abcdefghijklmnop$/u.exec(token ?? '')?.[1] ?? null;
const nextId = () => String(threadsApi.seq += 1n);
const permalinkOf = (post) => `https://www.threads.net/@flow_${post.puid.slice(-4)}/post/C${post.id}`;
/** The fake Threads Graph API for publishing: a token is valid only as the connect flow minted it (long<puid>...). */
function fakeThreadsPublish(url, init) {
  const u = new URL(url);
  const isPost = (init.method ?? 'GET') === 'POST';
  const params = isPost ? new URLSearchParams(String(init.body ?? '')) : u.searchParams;
  const who = tokenUser(params.get('access_token'));
  if (!who) return graphError(190);
  const m = /^\/v1\.0\/([1-9][0-9]*)(?:\/(threads|threads_publish))?$/u.exec(u.pathname);
  if (!m) return graphError(100);
  const [, id, edgeName] = m;
  const plan = threadsApi.plan[who] ?? {};
  if (isPost && edgeName === 'threads') {
    threadsApi.writes.push({ kind: 'container', puid: who, path: id });
    if (id !== who) return graphError(10);
    if (plan.container === 'refuse') return graphError(10);
    const containerId = nextId();
    threadsApi.containers.set(containerId, { puid: who, text: params.get('text'), status: plan.status ?? 'FINISHED' });
    return Response.json({ id: containerId });
  }
  if (isPost && edgeName === 'threads_publish') {
    threadsApi.writes.push({ kind: 'publish', puid: who, path: id });
    const container = threadsApi.containers.get(params.get('creation_id') ?? '');
    if (id !== who || !container || container.puid !== who) return graphError(100);
    if (container.status === 'PUBLISHED') return graphError(100);
    const post = { id: nextId(), puid: who, text: container.text, timestamp: new Date().toISOString() };
    container.status = 'PUBLISHED';
    threadsApi.posts.push(post);
    // 'lost': Threads published, but its answer never arrived (a 5xx): the write outcome is unknown to POSTONA
    if (plan.publish === 'lost') return new Response('upstream timeout', { status: 503 });
    return Response.json({ id: post.id });
  }
  threadsApi.reads += 1;
  if (!isPost && edgeName === 'threads') {
    if (id !== who) return graphError(10);
    const mine = threadsApi.posts.filter((p) => p.puid === who).reverse();
    return Response.json({ data: mine.map((p) => ({ id: p.id, text: p.text, permalink: permalinkOf(p), timestamp: p.timestamp })) });
  }
  if (!isPost && !edgeName) {
    const container = threadsApi.containers.get(id);
    if (container && container.puid === who) return Response.json({ id, status: container.status, error_message: null });
    const post = threadsApi.posts.find((p) => p.id === id);
    if (post && post.puid === who) {
      return Response.json({ id, permalink: permalinkOf(post), owner: { id: who }, username: `flow_${who.slice(-4)}`, timestamp: post.timestamp });
    }
  }
  return graphError(100);
}
/** The publish Edge's whole network: PostgREST, GoTrue, the fake Threads API; anything else is refused and recorded. */
const edgeFetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const headers = new Headers(init.headers);
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) {
    const name = url.slice(`${SUPABASE_URL}/rest/v1/rpc/`.length).split('?')[0];
    const args = init.body ? JSON.parse(String(init.body)) : {};
    const response = postgrest(name, args, headers.get('Authorization'));
    const fired = name === 'release_threads_manual_publish_step' ? pgApi.afterRelease?.(args) : null;
    if (fired) { pgApi.afterRelease = null; await fired; }
    return response;
  }
  if (url === `${SUPABASE_URL}/auth/v1/user`) return gotrueUser(headers.get('Authorization'));
  if (url.startsWith('https://graph.threads.net/')) {
    // G4-02 #12: a one-shot hook at the provider boundary (e.g. the person reconnects before Threads answers)
    const fired = threadsApi.before?.(url, init);
    if (fired) { threadsApi.before = null; await fired; }
    return fakeThreadsPublish(url, init);
  }
  denied.push(url);
  throw new TypeError('network refused in this test');
};
const PUBLISH_ENV = { get: (k) => ({ SUPABASE_URL, SUPABASE_ANON_KEY: ANON_KEY, THREADS_PUBLISH_ATTESTATION_KEY: PUBLISH_KEY })[k] };
const publishEntries = {
  // the deployable entry exactly as in source (its static gate THREADS_MANUAL_PUBLISH_PREREQUISITES_MET is false)
  closed: publishHttp.createHandler(PUBLISH_ENV, edgeFetch),
  // createHandler's inner handler, opened in this TEST only (the gate is a source constant)
  open: (request) => publishLogic.handleThreadsPublish(request, {
    getUser: publishHttp.createGetUser({ supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY }, edgeFetch),
    store: publishHttp.createStore({ supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, attestationKey: PUBLISH_KEY }, edgeFetch),
    fetch: edgeFetch,
    sleep: () => Promise.resolve(),
    // G4-02 #13 / #14: the Edge's wall clock (scenario 33 (d) (f) (g) (h) move it, as a stalled server or a jumped clock would)
    now: () => new Date(Date.now() + pub.clockSkewMs),
  }),
};
const PASSED_HEADERS = ['authorization', 'apikey', 'content-type', 'content-length', 'x-client-info'];
const publishServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const entry = /^\/(open|closed)(\/functions\/v1\/social-mobile-threads-publish)$/u.exec(req.url ?? '');
  if (!entry) { res.writeHead(404).end(); return; }
  const headers = new Headers();
  for (const name of PASSED_HEADERS) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
  const request = new Request(`${SUPABASE_URL}${entry[2]}`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
  const response = await publishEntries[entry[1]](request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((resolve) => publishServer.listen(0, '127.0.0.1', resolve));
pub.base = `http://127.0.0.1:${publishServer.address().port}`;
test.after(() => publishServer.close());

/** A direct HTTP call to the publish Edge (another client, a replay, a forged or missing token). */
async function publishCall(body, bearer, entry = 'open') {
  const response = await realFetch(`${pub.base}/${entry}/functions/v1/social-mobile-threads-publish`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

/** One mounted Threads publish card: the REAL hook with the app's supabase client and auth provider. */
async function publishScreen({ session, account, releaseEnabled = true }) {
  const auth = { session };
  const slots = [];
  const effects = [];
  let cursor = 0;
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (...a) => globalThis.fetch(...a) },
  });
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback: (cb) => cb,
    useLayoutEffect: (effect) => effect(),
    // an effect runs after a render whose dependencies changed (React's rule), never on every render
    useEffect(effect, deps) {
      const i = cursor++;
      const prev = slots[i];
      if (!prev || prev.length !== deps.length || deps.some((d, k) => !Object.is(d, prev[k]))) { slots[i] = deps; effects.push(effect); }
    },
  };
  const hook = await loadTs('features/threads-publish/use-threads-manual-publish.ts', {
    react, 'expo-crypto': { randomUUID: () => randomUUID() }, '@/domain/threads-manual-publish': publishDomain,
    '@/lib/supabase': { supabase: client }, '@/providers/auth-provider': { useAuth: () => ({ session: auth.session }) },
  });
  let shown = account;
  const render = () => {
    cursor = 0;
    const card = hook.useThreadsManualPublish(shown, false, { releaseEnabled });
    while (effects.length) effects.shift()();
    return card;
  };
  /** Waits until no request of this app to the publish Edge is in flight (the hook reloads the state after every answer). */
  const settle = async () => {
    render();
    for (let quiet = 0; quiet < 5;) {
      await new Promise((resolve) => setImmediate(resolve));
      quiet = pub.inFlight === 0 ? quiet + 1 : 0;
    }
    return render();
  };
  return { render, settle, show(next) { shown = next; }, signIn(next) { auth.session = next; } };
}
/** The account as the app's repository maps it (supabase-repository.ts: identity_verified -> connected). */
const appAccount = (n) => {
  const row = threadsAccount(n);
  return row && { id: row.id, platform: 'threads', connectionStatus: row.status === 'identity_verified' ? 'connected' : 'needs_attention' };
};
const attemptRow = (id) => owner(`select status || '|' || coalesce(container_id, '-') || '|' || coalesce(provider_post_id, '-') || '|' || coalesce(error_code, '-')
  from public.threads_manual_publish_attempts where id = ${lit(id)}::uuid`);
const writes = (puid, kind) => threadsApi.writes.filter((w) => w.puid === puid && (!kind || w.kind === kind)).length;
const publishSent = (action) => sent.filter((s) => s.fn === 'publish' && (!action || s.action === action)).length;

const F = 4706, G = 4707;
const PUID_F = '17841400000004706';
const SESSION_F = person(F, true);
const SESSION_G = person(G, true);

/** F's card, loaded, with the permission granted through the card (consent -> ready). */
async function readyCard(session = SESSION_F) {
  const card = await publishScreen({ session, account: appAccount(F) });
  let view = await card.settle();
  if (view.context.mode === 'consent_required') {
    await view.setPermission(true);
    view = await card.settle();
  }
  return { card, view };
}

test('20. F connects, allows posting, posts once: hook -> HTTP Edge -> attested SQL -> fake Threads -> published, read back', { timeout: 60000 }, async () => {
  const app = await screen({ session: SESSION_F });
  assert.equal((await connectAs(app, PUID_F)).kind, 'verifying');
  assert.equal(threadsAccount(F).status, 'identity_verified');
  const card = await publishScreen({ session: SESSION_F, account: appAccount(F) });
  let view = await card.settle();
  assert.equal(view.context.mode, 'consent_required', 'nothing is allowed by connecting alone');
  await view.setPermission(true);
  view = await card.settle();
  assert.equal(view.context.mode, 'ready', JSON.stringify(view.message));
  const pinned = view.pin('POSTONAからの最初の投稿です。');
  assert.ok(pinned, 'the text is pinned for the confirmed account and user');
  assert.equal(await view.publish(pinned), true);
  view = await card.settle();
  assert.equal(view.answer.status, 'published', JSON.stringify(view.answer));
  assert.match(view.answer.permalink, /^https:\/\/www\.threads\.net\/@flow_4706\/post\/C[0-9]+$/u);
  const [status, container, post] = attemptRow(view.answer.id).split('|');
  assert.deepEqual([status, container !== '-', post], ['published', true, threadsApi.posts.at(-1).id], 'the database recorded the read-back');
  // exactly one container and one publish, made with the token the CONNECT stored, as F's Threads user, with the pinned text
  assert.deepEqual([writes(PUID_F, 'container'), writes(PUID_F, 'publish')], [1, 1]);
  assert.equal(threadsApi.posts.at(-1).text, 'POSTONAからの最初の投稿です。');
  assert.equal(view.context.mode, 'ready', 'no attempt left open');
  assert.deepEqual(denied, [], 'no request left this process');
});

test('21. two taps and a replay: one attempt, one post; the replayed request is only reported', { timeout: 60000 }, async () => {
  const { card, view } = await readyCard();
  const before = [writes(PUID_F, 'container'), writes(PUID_F, 'publish'), publishSent('publish')];
  const pinned = view.pin('二重送信しないことの確認です。');
  const [first, second] = await Promise.all([view.publish(pinned), view.publish(pinned)]);
  assert.deepEqual([first, second], [true, false], 'the second tap sends nothing while the first is in flight');
  const done = await card.settle();
  assert.equal(done.answer.status, 'published');
  assert.equal(publishSent('publish') - before[2], 1, 'one publish request left the app');
  // the same request again (a client retry, or a captured request replayed by the same person)
  const replay = await publishCall({ action: 'publish', social_account_id: pinned.accountId, idempotency_key: pinned.idempotencyKey, text: pinned.text }, SESSION_F.access_token);
  assert.equal(replay.status, 200);
  assert.deepEqual([replay.json.attempt.id, replay.json.attempt.status, replay.json.attempt.replayed], [done.answer.id, 'published', true]);
  assert.deepEqual([writes(PUID_F, 'container') - before[0], writes(PUID_F, 'publish') - before[1]], [1, 1], 'still one post');
});

test('22. the container is not ready: the attempt stays open (busy), a second post is refused, resume publishes once', { timeout: 60000 }, async () => {
  threadsApi.plan[PUID_F] = { status: 'IN_PROGRESS' };
  const { card, view } = await readyCard();
  const before = writes(PUID_F, 'publish');
  assert.equal(await view.publish(view.pin('準備中のコンテナの確認です。')), true);
  let shown = await card.settle();
  assert.equal(shown.answer.status, 'container_created');
  assert.equal(shown.context.mode, 'busy', 'the card shows the open attempt');
  // a different post while that attempt is open: refused by the database (one open attempt per account), nothing sent
  const other = await publishCall({ action: 'publish', social_account_id: shown.answer.accountId, idempotency_key: randomUUID(), text: '別の投稿' }, SESSION_F.access_token);
  console.log(`measured 22 second post while open: ${other.status} ${JSON.stringify(other.json)}`);
  assert.equal(other.json.success, false);
  assert.equal(writes(PUID_F, 'publish'), before, 'nothing was published');
  for (const c of threadsApi.containers.values()) if (c.status === 'IN_PROGRESS') c.status = 'FINISHED';
  threadsApi.plan[PUID_F] = {};
  await shown.followUp('resume', shown.answer);
  shown = await card.settle();
  assert.equal(shown.answer.status, 'published');
  assert.equal(writes(PUID_F, 'publish') - before, 1);
});

test('23. Threads refuses the container (a definite refusal): failed, nothing published, the card is ready again', { timeout: 60000 }, async () => {
  threadsApi.plan[PUID_F] = { container: 'refuse' };
  const { card, view } = await readyCard();
  const before = writes(PUID_F, 'publish');
  assert.equal(await view.publish(view.pin('拒否される投稿の確認です。')), true);
  const shown = await card.settle();
  threadsApi.plan[PUID_F] = {};
  assert.equal(shown.answer.status, 'failed', JSON.stringify(shown.answer));
  assert.ok(shown.answer.errorCode, 'a fixed reason');
  assert.equal(writes(PUID_F, 'publish'), before);
  assert.equal(shown.context.mode, 'ready');
});

test('24. the publish answer is lost: unknown is kept, never resent; reconcile finds the post read-only', { timeout: 60000 }, async () => {
  threadsApi.plan[PUID_F] = { publish: 'lost' };
  const { card, view } = await readyCard();
  const before = writes(PUID_F, 'publish');
  assert.equal(await view.publish(view.pin('応答が失われた投稿の確認です。')), true);
  let shown = await card.settle();
  threadsApi.plan[PUID_F] = {};
  assert.equal(shown.answer.status, 'uncertain', JSON.stringify(shown.answer));
  assert.equal(shown.context.mode, 'busy', 'an unknown outcome blocks the next post');
  // "resume" never re-runs a step that may have happened
  await shown.followUp('resume', shown.answer);
  shown = await card.settle();
  assert.equal(shown.answer.status, 'uncertain');
  assert.equal(writes(PUID_F, 'publish') - before, 1, 'not resent');
  await shown.followUp('reconcile', shown.answer);
  shown = await card.settle();
  assert.equal(shown.answer.status, 'published', JSON.stringify(shown.answer));
  assert.equal(shown.answer.permalink, permalinkOf(threadsApi.posts.at(-1)));
  assert.equal(writes(PUID_F, 'publish') - before, 1, 'reconcile is read-only');
});

test('25. another person, no token, an expired token, the anon key: refused before any provider call', { timeout: 60000 }, async () => {
  const account = threadsAccount(F).id;
  const before = threadsApi.writes.length;
  const body = { action: 'publish', social_account_id: account, idempotency_key: randomUUID(), text: '他人からの投稿' };
  const asG = await publishCall(body, SESSION_G.access_token);
  const stateAsG = await publishCall({ action: 'account_state', social_account_id: account }, SESSION_G.access_token);
  const none = await publishCall(body, null);
  const stale = await publishCall(body, jwt({ sub: uid(F), session_id: sid(F), is_anonymous: false, exp: Math.floor(Date.now() / 1000) - 60 }));
  const anon = await publishCall(body, ANON_KEY);
  console.log(`measured 25: G ${asG.status} ${asG.json.error}; G state ${stateAsG.status} ${stateAsG.json.error}; none ${none.status} ${none.json.error}; expired ${stale.status} ${stale.json.error}; anon ${anon.status} ${anon.json.error}`);
  assert.deepEqual([asG.json.error, stateAsG.json.error], ['ACCOUNT_NOT_FOUND', 'ACCOUNT_NOT_FOUND'], 'another person cannot tell the account exists');
  assert.deepEqual([none.status, stale.status, anon.status], [401, 401, 401]);
  assert.equal(threadsApi.writes.length, before);
  // G's own card for an account id G does not own: loads nothing usable, sends no post
  const card = await publishScreen({ session: SESSION_G, account: { id: account, platform: 'threads', connectionStatus: 'connected' } });
  const shown = await card.settle();
  assert.equal(shown.context.mode, 'unavailable');
});

test('26. the account is stopped (N1 SYNTHETIC: what a Meta deauthorize would set): refused; the card asks to reconnect', { timeout: 60000 }, async () => {
  const account = threadsAccount(F).id;
  const { view } = await readyCard();
  const pinned = view.pin('停止後の投稿');
  // the table's CHECK allows unconnected / authorization_pending / connected / identity_verified / failed only: PR #648's N1
  // example 'reauth_required' is refused by it (measured below), so the stop N1 can write without a schema change is 'failed'
  const reauth = psql(`update public.social_accounts set connection_status = 'reauth_required' where id = ${lit(account)}`);
  assert.equal(reauth.ok, false);
  assert.match(reauth.message, /social_accounts_connection_status_check/u);
  owner(`update public.social_accounts set connection_status = 'failed', last_connection_error_code = 'THREADS_DEAUTHORIZED' where id = ${lit(account)}`);
  console.log(`measured 26 credential verdict while stopped: ${verdict(F, account)}`);
  assert.ok(verdict(F, account).startsWith('false|'), 'the G4 credential verdict (G3 dispatch) refuses too');
  const before = threadsApi.writes.length;
  // the screen still showed "ready" (stale data): the server refuses
  const refused = await publishCall({ action: 'publish', social_account_id: account, idempotency_key: pinned.idempotencyKey, text: pinned.text }, SESSION_F.access_token);
  console.log(`measured 26 stopped: ${refused.status} ${JSON.stringify(refused.json)}`);
  assert.equal(refused.json.error, 'CONNECTION_NOT_VERIFIED');
  assert.equal(threadsApi.writes.length, before, 'no provider call');
  // the reloaded data maps the stop to "needs attention": the card asks to reconnect and loads nothing
  const card = await publishScreen({ session: SESSION_F, account: appAccount(F) });
  const shown = await card.settle();
  assert.equal(shown.context.mode, 'reconnect');
  // N8: connecting again (the real connect flow) clears the stop, and posting works again
  const app = await screen({ session: SESSION_F });
  assert.equal((await connectAs(app, PUID_F)).kind, 'verifying');
  const row = owner(`select connection_status || '|' || coalesce(last_connection_error_code, '-') from public.social_accounts where id = ${lit(account)}`);
  console.log(`measured 26 after reconnect: ${row}`);
  assert.equal(row, 'identity_verified|-', 'the reconnect overwrote the stop');
  const again = await readyCard();
  assert.equal(await again.view.publish(again.view.pin('再接続後の投稿です。')), true);
  assert.equal((await again.card.settle()).answer.status, 'published');
});

test('27. the stored credential expires (SYNTHETIC) or the service ends: refused, nothing sent', { timeout: 60000 }, async () => {
  const account = threadsAccount(F).id;
  const post = () => publishCall({ action: 'publish', social_account_id: account, idempotency_key: randomUUID(), text: '期限の確認' }, SESSION_F.access_token);
  const before = threadsApi.writes.length;
  owner(`update public.threads_account_credential_custody set expires_at = now() + interval '1 minute' where social_account_id = ${lit(account)}`);
  const expiredCredential = await post();
  owner(`update public.threads_account_credential_custody set expires_at = now() + interval '50 days' where social_account_id = ${lit(account)}`);
  owner(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = ${lit(uid(F))}::uuid and service_key = 'x_autopost'`);
  const ended = await post();
  owner(`update public.service_entitlements set status = 'active', ended_at = null where user_id = ${lit(uid(F))}::uuid and service_key = 'x_autopost'`);
  console.log(`measured 27: expiring credential ${expiredCredential.status} ${expiredCredential.json.error}; service ended ${ended.status} ${ended.json.error}`);
  assert.equal(expiredCredential.json.error, 'CREDENTIALS_EXPIRED');
  assert.equal(ended.json.error, 'SERVICE_NOT_ACTIVE');
  assert.equal(threadsApi.writes.length, before);
});

test('28. disconnect while the outcome is unknown keeps the account; after reconcile it disconnects; nothing old carries over', { timeout: 60000 }, async () => {
  threadsApi.plan[PUID_F] = { publish: 'lost' };
  const { card, view } = await readyCard();
  assert.equal(await view.publish(view.pin('切断前の不確定な投稿です。')), true);
  let shown = await card.settle();
  threadsApi.plan[PUID_F] = {};
  assert.equal(shown.answer.status, 'uncertain');
  const old = threadsAccount(F);
  const app = await screen({ session: SESSION_F });
  app.setAccounts([{ id: old.id, platform: 'threads', connectionStatus: 'connected' }]);
  app.render().disconnect.ask({ id: old.id, handle: old.handle });
  await app.render().disconnect.confirm();
  const stopped = app.render().disconnect.state;
  console.log(`measured 28 disconnect while uncertain: ${JSON.stringify(stopped.result ?? stopped.kind)}`);
  assert.equal(threadsAccount(F)?.id, old.id, 'the account (and the evidence of the unknown post) is kept');
  assert.equal(attemptRow(shown.answer.id).split('|')[0], 'uncertain');
  // the permission was withdrawn by the disconnect: a new post is refused, the unknown one can still be reconciled
  const refused = await publishCall({ action: 'publish', social_account_id: old.id, idempotency_key: randomUUID(), text: '切断中の投稿' }, SESSION_F.access_token);
  assert.equal(refused.json.success, false);
  await shown.followUp('reconcile', shown.answer);
  shown = await card.settle();
  assert.equal(shown.answer.status, 'published');
  const app2 = await screen({ session: SESSION_F });
  app2.setAccounts([{ id: old.id, platform: 'threads', connectionStatus: 'connected' }]);
  app2.render().disconnect.ask({ id: old.id, handle: old.handle });
  await app2.render().disconnect.confirm();
  assert.equal(app2.render().disconnect.state.result?.kind, 'disconnected');
  assert.equal(threadsAccount(F), null);
  const gone = await publishCall({ action: 'publish', social_account_id: old.id, idempotency_key: randomUUID(), text: '切断後の投稿' }, SESSION_F.access_token);
  assert.equal(gone.json.error, 'ACCOUNT_NOT_FOUND');
  // connect again: the account id is deterministic per workspace (PR #124: 'sa_' || md5(workspace || ':threads')), so the same
  // id comes back as a NEW row: no old attempt, no old permission, a new binding generation
  const app3 = await screen({ session: SESSION_F });
  assert.equal((await connectAs(app3, PUID_F)).kind, 'verifying');
  assert.equal(threadsAccount(F).id, old.id, 'the same deterministic id');
  assert.equal(owner(`select count(*) from public.threads_manual_publish_attempts where social_account_id = ${lit(old.id)}`), '0', 'old attempts went with the old row');
  const fresh = await publishScreen({ session: SESSION_F, account: appAccount(F) });
  let card2 = await fresh.settle();
  assert.equal(card2.context.mode, 'consent_required', 'the old permission did not carry over');
  await card2.setPermission(true);
  card2 = await fresh.settle();
  assert.equal(await card2.publish(card2.pin('再接続した新しい行からの投稿です。')), true);
  assert.equal((await fresh.settle()).answer.status, 'published');
});

test('29. the publish entry as in source (static gate closed): 503 for every action over HTTP; the app card sends nothing', { timeout: 60000 }, async () => {
  const account = threadsAccount(F).id;
  const before = [threadsApi.writes.length, threadsApi.reads];
  for (const body of [
    { action: 'publish', social_account_id: account, idempotency_key: randomUUID(), text: 'ゲートの確認' },
    { action: 'account_state', social_account_id: account },
    { action: 'set_permission', social_account_id: account, desired_enabled: true, expected_current_enabled: false },
  ]) {
    const r = await publishCall(body, SESSION_F.access_token, 'closed');
    assert.deepEqual([r.status, r.json], [503, { success: false, error: 'THREADS_PUBLISH_DISABLED' }], body.action);
  }
  assert.deepEqual([threadsApi.writes.length, threadsApi.reads], before);
  // the app as built (THREADS_MANUAL_PUBLISH_UI_ENABLED = false): "in preparation", no request at all
  const sentBefore = publishSent();
  const card = await publishScreen({ session: SESSION_F, account: appAccount(F), releaseEnabled: publishDomain.THREADS_MANUAL_PUBLISH_UI_ENABLED });
  const shown = await card.settle();
  assert.equal(shown.context.mode, 'release_disabled');
  assert.equal(publishSent(), sentBefore);
  assert.equal(await shown.publish({ accountId: account, userId: uid(F), text: 'x', idempotencyKey: randomUUID() }), false);
  assert.equal(publishSent(), sentBefore);
  assert.deepEqual(denied, [], 'no request left this process in any publish scenario');
  console.log(`measured publish totals: containers ${threadsApi.writes.filter((w) => w.kind === 'container').length}, publishes ${threadsApi.writes.filter((w) => w.kind === 'publish').length}, reads ${threadsApi.reads}, posts ${threadsApi.posts.length}, denied ${denied.length}`);
});

// G4-02 #11: a manual post may go out only when G4's credential verdict (the one G3's dispatch binds to) says VERIFIED: the
// same account must not be refused for a scheduled post and accepted for a manual one. Read-backs of a post that may exist
// (confirm / reconcile) stay possible. Fixed by supabase/candidates/postona_g4_threads_manual_publish_verdict/001 (the
// runner installs it after the verdict); without it (G4MP_WITHOUT_VERDICT_GATE=1) cases a-c post and this test fails.
test('30. manual publish agrees with the G4 credential verdict: connection error / no G4 binding / foreign custody refuse', { timeout: 60000 }, async () => {
  const account = threadsAccount(F).id;
  const { card, view } = await readyCard();
  const post = () => publishCall({ action: 'publish', social_account_id: account, idempotency_key: randomUUID(), text: `判定の確認 ${randomUUID().slice(0, 8)}` }, SESSION_F.access_token);
  const outcome = (r) => (r.json.success ? `posted:${r.json.attempt.status}` : r.json.error);
  const results = {};
  // (d) first: an unknown outcome, then a connection error -- the read-only reconcile still settles it
  threadsApi.plan[PUID_F] = { publish: 'lost' };
  assert.equal(await view.publish(view.pin('判定前の不確定な投稿です。')), true);
  let shown = await card.settle();
  threadsApi.plan[PUID_F] = {};
  assert.equal(shown.answer.status, 'uncertain');
  // (a) a connection error on a still identity_verified row (SYNTHETIC: what a refresh failure or N1 could record)
  owner(`update public.social_accounts set last_connection_error_code = 'THREADS_TOKEN_REJECTED' where id = ${lit(account)}`);
  results.verdictA = verdict(F, account).split('|')[2];
  await shown.followUp('reconcile', shown.answer);
  shown = await card.settle();
  results.reconcileA = shown.answer.status;
  results.a = outcome(await post());
  owner(`update public.social_accounts set last_connection_error_code = null where id = ${lit(account)}`);
  // (b) no G4 binding (SYNTHETIC: a row made identity_verified by a path that skipped G4's reviewed connect bridge)
  owner(`create table public.g4mp_binding as select * from postona_threads_binding.bindings where social_account_id = ${lit(account)}; `
    + `delete from postona_threads_binding.bindings where social_account_id = ${lit(account)}`);
  results.verdictB = verdict(F, account).split('|')[2];
  results.b = outcome(await post());
  // (c) custody names another credential than the one the account holds (SYNTHETIC)
  owner(`insert into postona_threads_binding.bindings select * from public.g4mp_binding; drop table public.g4mp_binding`);
  const held = owner(`select vault_access_token_secret_id from public.social_accounts where id = ${lit(account)}`);
  const other = owner(`insert into vault.secrets (secret) values ('another-credential') returning id`);
  owner(`update public.threads_account_credential_custody set vault_secret_id = ${lit(other)}::uuid where social_account_id = ${lit(account)}`);
  results.verdictC = verdict(F, account).split('|')[2];
  results.c = outcome(await post());
  owner(`update public.threads_account_credential_custody set vault_secret_id = ${lit(held)}::uuid where social_account_id = ${lit(account)}`);
  results.verdictAfter = verdict(F, account).split('|')[2];
  console.log(`measured 30: ${JSON.stringify(results)}`);
  // every case a post went out in is settled before asserting, so the next run of the world is not left open
  for (const id of owner(`select coalesce(string_agg(id::text, ' '), '') from public.threads_manual_publish_attempts
      where social_account_id = ${lit(account)} and status not in ('published', 'published_unidentified', 'failed')`).split(' ').filter(Boolean)) {
    await publishCall({ action: 'reconcile', attempt_id: id }, SESSION_F.access_token);
  }
  assert.deepEqual([results.verdictA, results.verdictB, results.verdictC, results.verdictAfter], ['CONNECTION_ERROR', 'NOT_BOUND', 'CREDENTIAL_MISSING', 'VERIFIED']);
  assert.equal(results.reconcileA, 'published', 'a read-back of a post that may exist is not blocked by the error');
  assert.deepEqual([results.a, results.b, results.c], ['CONNECTION_NOT_VERIFIED', 'CONNECTION_NOT_VERIFIED', 'CREDENTIALS_MISSING']);
  assert.equal(outcome(await post()), 'posted:published', 'verified again: posting works');
});

// ---- G4-02 #12 (H1 #40 P2): an attempt writes only under the connection it was begun with ------------------------------------
// supabase/candidates/postona_g4_threads_manual_publish_verdict/002 stores the verdict's credential_generation at begin and
// compares it in every write release (create / check / publish). Without 002 (G4MG_WITHOUT_GENERATION_GATE=1) the old
// attempts below post and scenarios 31-32 fail. The reconnects are REAL (app hook -> connect Edge -> G4 bridge -> SQL), the same
// Threads user: social_account_id and G5's lifecycle_version stay, only G4's generation moves (H1's reproduction).
const has002 = () => owner(`select to_regclass('public.threads_manual_publish_attempt_generations') is not null`) === 't';
const generationOf = (accountId) => verdict(F, accountId).split('|')[1];
const boundGeneration = (id) => (has002()
  ? owner(`select coalesce((select credential_generation from public.threads_manual_publish_attempt_generations where attempt_id = ${lit(id)}::uuid), '-')`)
  : 'no-002');
const bindingOf = (accountId) => owner(`select social_account_id || '|' || lifecycle_version from postona_threads_binding.bindings where social_account_id = ${lit(accountId)}`);
const statusError = (id) => attemptRow(id).split('|').filter((_, i) => i === 0 || i === 3).join('|');
const latestAttempt = (accountId) => owner(`select id from public.threads_manual_publish_attempts where social_account_id = ${lit(accountId)} order by created_at desc limit 1`);
const finishContainers = () => { for (const c of threadsApi.containers.values()) if (c.status === 'IN_PROGRESS') c.status = 'FINISHED'; };
const pathOf = (url) => new URL(url).pathname;
const isContainerRead = (url, init) => (init.method ?? 'GET') === 'GET' && threadsApi.containers.has(pathOf(url).split('/').pop());
const isContainerCreate = (url, init) => init.method === 'POST' && pathOf(url).endsWith('/threads');
/** The release SQL called as the publish SERVER would (its attestation, F's verified claims); optionally held open. */
function releaseAsServerSql(attemptId, step, hold) {
  const issued = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(32).toString('hex');
  const attestation = createHmac('sha256', PUBLISH_KEY)
    .update(['postona-threads-publish-release-v1', uid(F), attemptId, step, String(issued), nonce].join('\n')).digest('hex');
  const claims = JSON.stringify({ sub: uid(F), role: 'authenticated', session_id: sid(F), is_anonymous: false });
  return `begin;\nselect set_config('request.jwt.claims', ${lit(claims)}, true) is null;\n`
    + `select r->>'status' || ':' || coalesce(r->>'code', '-') from public.release_threads_manual_publish_step(${lit(attemptId)}::uuid, ${lit(step)}, ${issued}, ${lit(nonce)}, ${lit(attestation)}) r;\n`
    + (hold ? `select pg_sleep(${hold}), 'g4mg_y';\n` : '') + 'commit;\n';
}
/** F reconnects the SAME Threads user through the real connect path. */
async function reconnectF() {
  const app = await screen({ session: SESSION_F });
  return (await connectAs(app, PUID_F)).kind;
}
/** Every attempt of the account still open is settled read-only, so the next case (and scenario) starts clean. */
async function settleOpen(accountId) {
  for (const id of owner(`select coalesce(string_agg(id::text, ' '), '') from public.threads_manual_publish_attempts
      where social_account_id = ${lit(accountId)} and status not in ('published', 'published_unidentified', 'failed')`).split(' ').filter(Boolean)) {
    await publishCall({ action: 'reconcile', attempt_id: id }, SESSION_F.access_token);
  }
}

test('31. a reconnect in the middle of a post: the old attempt never writes again (container_created / at the provider / reserved); reconcile stays read-only; a new post works', { timeout: 120000 }, async () => {
  const account = threadsAccount(F).id;
  const results = {};
  const lifecycle = bindingOf(account);
  // (a) container_created, then the person reconnects, then resumes
  threadsApi.plan[PUID_F] = { status: 'IN_PROGRESS' };
  let { card, view } = await readyCard();
  assert.equal(await view.publish(view.pin('再接続の前に始めた投稿 a')), true);
  let shown = await card.settle();
  const a = shown.answer;
  results.aOpen = a.status;
  results.aBoundAtBegin = boundGeneration(a.id) === generationOf(account);
  const genBefore = generationOf(account);
  finishContainers();
  threadsApi.plan[PUID_F] = {};
  results.aReconnect = await reconnectF();
  results.aGenerationMoved = generationOf(account) !== genBefore;
  results.aSameAccountAndLifecycle = bindingOf(account) === lifecycle;
  let p0 = writes(PUID_F, 'publish');
  await shown.followUp('resume', a);
  shown = await card.settle();
  results.a = statusError(a.id);
  results.aPublishes = writes(PUID_F, 'publish') - p0;
  await settleOpen(account);
  // (b) H1's race: the reconnect happens while Threads is asked for the container's status (between check and publish)
  ({ card, view } = await readyCard());
  p0 = writes(PUID_F, 'publish');
  threadsApi.before = (url, init) => (isContainerRead(url, init) ? (async () => { results.bReconnect = await reconnectF(); })() : null);
  // the whole post runs in this one request, so the refusal of its publish step IS the answer (no attempt is shown)
  results.bAnswered = await view.publish(view.pin('状態確認の最中に再接続された投稿 b'));
  await card.settle();
  threadsApi.before = null;
  const b = latestAttempt(account);
  results.b = statusError(b);
  results.bPublishes = writes(PUID_F, 'publish') - p0;
  await settleOpen(account);
  // (c) the reconnect happens while the container is being created (creating_container in flight at the provider)
  ({ card, view } = await readyCard());
  const c0 = [writes(PUID_F, 'container'), writes(PUID_F, 'publish')];
  threadsApi.before = (url, init) => (isContainerCreate(url, init) ? (async () => { results.cReconnect = await reconnectF(); })() : null);
  results.cAnswered = await view.publish(view.pin('コンテナ作成の最中に再接続された投稿 c'));
  await card.settle();
  threadsApi.before = null;
  const c = latestAttempt(account);
  results.c = statusError(c);
  results.cWrites = [writes(PUID_F, 'container') - c0[0], writes(PUID_F, 'publish') - c0[1]];
  await settleOpen(account);
  // (d) the outcome is unknown, then the person reconnects: G4-02 #14 -- refused while unknown (a post may still come); reconcile
  //     settles it read-only, never resends; then the reconnect goes through
  threadsApi.plan[PUID_F] = { publish: 'lost' };
  ({ card, view } = await readyCard());
  assert.equal(await view.publish(view.pin('結果不明のあとに再接続した投稿 d')), true);
  shown = await card.settle();
  threadsApi.plan[PUID_F] = {};
  results.dOpen = shown.answer.status;
  const d = shown.answer;
  results.dReconnect = await reconnectResult();
  p0 = writes(PUID_F, 'publish');
  await shown.followUp('reconcile', d);
  shown = await card.settle();
  results.d = statusError(d.id);
  results.dPublishes = writes(PUID_F, 'publish') - p0;
  results.dReconnectAfter = await reconnectF();
  await settleOpen(account);
  // (e) an attempt with no stored generation (SYNTHETIC: begun before 002 was installed): unknown -> no write
  threadsApi.plan[PUID_F] = { status: 'IN_PROGRESS' };
  ({ card, view } = await readyCard());
  assert.equal(await view.publish(view.pin('世代の記録がない投稿 e')), true);
  shown = await card.settle();
  const e = shown.answer;
  if (has002()) owner(`delete from public.threads_manual_publish_attempt_generations where attempt_id = ${lit(e.id)}::uuid`);
  finishContainers();
  threadsApi.plan[PUID_F] = {};
  p0 = writes(PUID_F, 'publish');
  await shown.followUp('resume', e);
  await card.settle();
  results.e = statusError(e.id);
  results.ePublishes = writes(PUID_F, 'publish') - p0;
  await settleOpen(account);
  // (g) reserved through a DIRECT RPC (no Edge): the generation is the server's; a forged attestation writes nothing; the
  //     table is out of every API role's reach; after a reconnect the reserved attempt cannot be driven
  const key = randomUUID();
  const text = `直接RPCで予約した投稿 ${key.slice(0, 8)}`;
  const bearer = `Bearer ${SESSION_F.access_token}`;
  const begun = await postgrest('begin_threads_manual_publish', { p_social_account_id: account, p_idempotency_key: key, p_text: text }, bearer).json();
  const g = begun.attempt?.attempt_id;
  results.gBegun = begun.status;
  results.gBoundAtBegin = boundGeneration(g) === generationOf(account);
  const forged = await postgrest('release_threads_manual_publish_step', {
    p_attempt_id: g, p_step: 'create_container', p_issued_at: Math.floor(Date.now() / 1000), p_nonce: '0'.repeat(64), p_attestation: '0'.repeat(64),
  }, bearer).json();
  results.gForged = `${forged.status}:${forged.code}|${statusError(g)}`;
  const reach = ['anon', 'authenticated', 'service_role'].map((role) => psql(`begin; set local role ${role}; `
    + 'select count(*) from public.threads_manual_publish_attempt_generations; commit;'));
  results.gTableReach = reach.map((r) => (r.ok ? 'READABLE' : r.message.replace(/ for table.*/u, ''))).join(',');
  const w0 = [writes(PUID_F, 'container'), writes(PUID_F, 'publish')];
  results.gReconnect = await reconnectF();
  // the app's retry of the same post replays the reserved attempt; the publish server's own create release then decides
  const replayed = await publishCall({ action: 'publish', social_account_id: account, idempotency_key: key, text }, SESSION_F.access_token);
  results.gReplayed = `${replayed.status}:${replayed.json.error ?? replayed.json.attempt?.status}`;
  results.gServerRelease = statusError(g) === 'reserved|-'
    ? owner(releaseAsServerSql(g, 'create_container', 0)).split('\n').filter((line) => line.includes(':')).join(',')
    : 'not-reserved';
  results.g = statusError(g);
  results.gWrites = [writes(PUID_F, 'container') - w0[0], writes(PUID_F, 'publish') - w0[1]];
  await settleOpen(account);
  // (f) a NEW attempt after the reconnects posts once, bound to the current generation
  ({ card, view } = await readyCard());
  results.fMode = view.context.mode;
  p0 = writes(PUID_F, 'publish');
  if (results.fMode === 'ready') {
    await view.publish(view.pin('再接続のあとの新しい投稿 f'));
    shown = await card.settle();
  }
  const f = latestAttempt(account);
  results.f = statusError(f);
  results.fBound = boundGeneration(f) === generationOf(account);
  results.fPublishes = writes(PUID_F, 'publish') - p0;
  console.log(`measured 31: ${JSON.stringify(results)}`);
  await settleOpen(account);
  assert.deepEqual(denied, [], 'no request left this process');
  assert.deepEqual([results.aOpen, results.aBoundAtBegin, results.aReconnect, results.aGenerationMoved, results.aSameAccountAndLifecycle],
    ['container_created', true, 'verifying', true, true], 'H1 setup: same account and lifecycle, only the generation moved');
  assert.deepEqual([results.a, results.aPublishes], ['failed|AUTHORIZATION_CHANGED', 0], '(a) container_created + reconnect');
  assert.deepEqual([results.bReconnect, results.bAnswered, results.b, results.bPublishes], ['verifying', false, 'failed|AUTHORIZATION_CHANGED', 0], '(b) reconnect at the status read');
  assert.deepEqual([results.cReconnect, results.cAnswered, results.c, results.cWrites], ['verifying', false, 'failed|AUTHORIZATION_CHANGED', [1, 0]], '(c) reconnect while creating');
  assert.deepEqual([results.dOpen, results.dReconnect.startsWith('failed:'), results.d, results.dPublishes, results.dReconnectAfter],
    ['uncertain', true, 'published|-', 0, 'verifying'], `(d) refused while unknown (${results.dReconnect}), settled read-only, then reconnected`);
  assert.deepEqual([results.e, results.ePublishes], ['failed|AUTHORIZATION_CHANGED', 0], '(e) unknown generation');
  assert.deepEqual([results.gBegun, results.gBoundAtBegin, results.gForged], ['reserved', true, 'refused:ATTESTATION_INVALID|reserved|-'], '(g) direct RPC');
  assert.equal(results.gTableReach, 'permission denied,permission denied,permission denied');
  assert.deepEqual([results.gReconnect, results.gReplayed, results.gServerRelease, results.g, results.gWrites], ['verifying', '200:reserved', 'refused:CONNECTION_NOT_VERIFIED', 'failed|AUTHORIZATION_CHANGED', [0, 0]], '(g) reserved + reconnect');
  assert.deepEqual([results.fMode, results.f, results.fBound, results.fPublishes], ['ready', 'published|-', true, 1], '(f) a new attempt posts');
});

test('32. a reconnect racing the release in PostgreSQL: open first -> the release waits, then refuses; release first -> the reconnect waits for it', { timeout: 120000 }, async () => {
  const account = threadsAccount(F).id;
  const results = {};
  /** A second PostgreSQL session (the runner's owner), statements sent one by one from stdin. */
  const session = (sql) => {
    const child = spawn('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db, '-f', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.stdin.end(sql);
    return new Promise((resolve) => child.on('close', (code) => resolve({ code, out: out.trim() })));
  };
  const sleeping = async (tag) => {
    for (let i = 0; i < 400; i += 1) {
      if (owner(`select count(*) from pg_stat_activity where wait_event = 'PgSleep' and strpos(query, ${lit(tag)}) > 0`) !== '0') return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };
  // SYNTHETIC reconnect: the binding write the completion makes (a new connect's state id), without its account lock, so
  // that only the release's own binding lock can order the two
  const rebind = `update postona_threads_binding.bindings set oauth_state_id = gen_random_uuid(), bound_at = now() where social_account_id = ${lit(account)};`;
  const openAttempt = async (label) => {
    threadsApi.plan[PUID_F] = { status: 'IN_PROGRESS' };
    const { card, view } = await readyCard();
    assert.equal(view.context.mode, 'ready', `${label}: ${owner(`select coalesce(string_agg(status, ','), '-') from public.threads_manual_publish_attempts
      where social_account_id = ${lit(account)} and status not in ('published', 'published_unidentified', 'failed')`)}`);
    assert.equal(await view.publish(view.pin(label)), true);
    const shown = await card.settle();
    finishContainers();
    threadsApi.plan[PUID_F] = {};
    return { card, shown };
  };
  // (x) the reconnect's transaction is open first: the release (check, then publish) must wait for it and see its generation
  let { card, shown } = await openAttempt('再接続が先に開いている投稿 x');
  const x = shown.answer;
  let gen0 = generationOf(account);
  let p0 = writes(PUID_F, 'publish');
  const rebinding = session(`begin;\n${rebind}\nselect pg_sleep(2), 'g4mg_x';\ncommit;\n`);
  results.xHeld = await sleeping('g4mg_x');
  let t0 = Date.now();
  await shown.followUp('resume', x);
  await card.settle();
  results.xWaitedMs = Date.now() - t0;
  results.xRebind = (await rebinding).code;
  results.x = statusError(x.id);
  results.xPublishes = writes(PUID_F, 'publish') - p0;
  results.xGenerationMoved = generationOf(account) !== gen0;
  await settleOpen(account);
  // (y) the release commits first (a check release held open 2 s by the server's transaction): the reconnect waits for it
  ({ card, shown } = await openAttempt('リリースが先に開いている投稿 y'));
  const y = shown.answer;
  gen0 = generationOf(account);
  const releasing = session(releaseAsServerSql(y.id, 'check_container', 2));
  results.yHeld = await sleeping('g4mg_y');
  t0 = Date.now();
  const rebound = psql(`set lock_timeout = '5s'; ${rebind}`);
  results.yRebindWaitedMs = Date.now() - t0;
  results.yRebind = rebound.ok;
  results.yRelease = (await releasing).out.split('\n').filter((line) => /^[a-z]+:/u.test(line)).join(',');
  results.yGenerationMoved = generationOf(account) !== gen0;
  p0 = writes(PUID_F, 'publish');
  await shown.followUp('resume', y);
  await card.settle();
  results.y = statusError(y.id);
  results.yPublishes = writes(PUID_F, 'publish') - p0;
  console.log(`measured 32: ${JSON.stringify(results)}`);
  await settleOpen(account);
  assert.deepEqual([results.xHeld, results.xRebind, results.xGenerationMoved], [true, 0, true]);
  assert.deepEqual([results.x, results.xPublishes], ['failed|AUTHORIZATION_CHANGED', 0], '(x) the release waited for the open reconnect and refused');
  assert.ok(results.xWaitedMs >= 800, `(x) the release waited for the reconnect's commit (${results.xWaitedMs} ms)`);
  assert.deepEqual([results.yHeld, results.yRelease, results.yRebind, results.yGenerationMoved], [true, 'released:-', true, true]);
  assert.ok(results.yRebindWaitedMs >= 800, `(y) the reconnect waited for the release's commit (${results.yRebindWaitedMs} ms)`);
  assert.deepEqual([results.y, results.yPublishes], ['failed|AUTHORIZATION_CHANGED', 0], '(y) the next write step refuses');
  assert.deepEqual(denied, [], 'no request left this process');
});

// ---- G4-02 #13 (H1 #41 P2) / #14 (H1 #42 P2): the send onset is the publish release's COMMIT; no clock ends the lease -------
// .../002's send fence (trigger threads_manual_publish_send_fence on postona_threads_binding.bindings) refuses a write that
// moves the account's oauth_state_id while it has an attempt in `publishing` or `uncertain` (#14: a recorded state, no
// clock); the publish server starts the request within THREADS_PUBLISH_SEND_START_WINDOW_MS of asking for the release, on
// its own clocks. Fail-before (the runner): PR #650's 002 (no fence) and #13's 002 (a lease that lapses on the database's
// clock) both let an old attempt post after a reconnect committed, and scenario 33 fails.
async function reconnectResult(puid = PUID_F) {
  const state = await connectAs(await screen({ session: SESSION_F }), puid);
  return state.kind === 'done' ? `${state.result.kind}:${state.result.code}` : state.kind;
}
const bindingRow = (accountId) => owner(`select threads_user_id || '|' || oauth_state_id from postona_threads_binding.bindings where social_account_id = ${lit(accountId)}`);
/** SYNTHETIC: the database's clock is `seconds` ahead of the publish server's for this attempt (its release looks that old). */
const dbClockAhead = (attemptId, seconds) => owner(`update public.threads_manual_publish_attempts set updated_at = updated_at - interval '${seconds} seconds' where id = ${lit(attemptId)}::uuid`);
const containerOf = (attemptId) => threadsApi.containers.get(String(owner(`select container_id from public.threads_manual_publish_attempts where id = ${lit(attemptId)}::uuid`)));

test('33. send onset vs reconnect: a reconnect after the publish release COMMIT waits until that send is recorded or settled by the provider; no clock (database or server, ahead, behind) lets it in earlier; the race in PostgreSQL', { timeout: 180000 }, async () => {
  const account = threadsAccount(F).id;
  const results = {};
  results.start = await reconnectResult(); // a clean, real binding (scenario 32 left a synthetic one)
  const onPublishRelease = (fn) => { pgApi.afterRelease = (args) => (args.p_step === 'publish' ? fn(args) : null); };
  // (a) H1 #41: the publish release COMMITs; before its answer reaches the Edge, the person reconnects the SAME Threads user
  let { card, view } = await readyCard();
  let gen0 = generationOf(account);
  let p0 = writes(PUID_F, 'publish');
  onPublishRelease(async (args) => {
    results.aCommitted = `${statusError(args.p_attempt_id)}|bound=${boundGeneration(args.p_attempt_id) === gen0}|sent=${writes(PUID_F, 'publish') - p0}`;
    results.aReconnect = await reconnectResult();
    results.aMovedBeforeSend = generationOf(account) !== gen0;
    // (c) the same window, a DIFFERENT Threads user: refused and the binding kept. NOTE: measured the same with PR #650's 002
    //     (no fence): the account's existing completion checks refuse another Threads user here, so (c) does not exercise the fence
    const row = bindingRow(account);
    results.cRebind = await reconnectResult('17841400000009706');
    results.cBindingKept = bindingRow(account) === row;
  });
  results.aAnswered = await view.publish(view.pin('送信開始の直後に再接続された投稿 a'));
  await card.settle();
  pgApi.afterRelease = null;
  const a = latestAttempt(account);
  results.a = statusError(a);
  results.aPublishes = writes(PUID_F, 'publish') - p0;
  results.aRetry = await reconnectResult(); // the send is over: the same reconnect now goes through
  results.aMovedAfterRetry = generationOf(account) !== gen0;
  await settleOpen(account);
  // (b) a new attempt under the new connection posts once
  ({ card, view } = await readyCard());
  p0 = writes(PUID_F, 'publish');
  await view.publish(view.pin('再接続のあとの新しい投稿 b'));
  await card.settle();
  const b = latestAttempt(account);
  results.b = statusError(b);
  results.bBound = boundGeneration(b) === generationOf(account);
  results.bPublishes = writes(PUID_F, 'publish') - p0;
  await settleOpen(account);
  // (d) H1 #42: ONLY the database's clock is ahead (SYNTHETIC: the release looks 121 s old to it; the Edge's clocks are
  //     untouched, so its start window allows the send). #13 let the reconnect commit here and the old attempt then posted.
  //     Then the database gives up on the step (reconcile: publishing -> uncertain STEP_INTERRUPTED) while the server is
  //     still about to send: the reconnect is still refused. The send goes out once; its record is refused (the database
  //     already gave up on it); the read-only reconcile finds the post; only then does the reconnect go through.
  ({ card, view } = await readyCard());
  gen0 = generationOf(account);
  p0 = writes(PUID_F, 'publish');
  onPublishRelease(async (args) => {
    dbClockAhead(args.p_attempt_id, 121);
    results.dReconnect = await reconnectResult();
    results.dMovedBeforeSend = generationOf(account) !== gen0;
    const gaveUp = await publishCall({ action: 'reconcile', attempt_id: args.p_attempt_id }, SESSION_F.access_token);
    results.dGaveUp = `${gaveUp.status}|${statusError(args.p_attempt_id)}`;
    results.dReconnectAbandoned = await reconnectResult();
    results.dMovedAbandoned = generationOf(account) !== gen0;
  });
  results.dAnswered = await view.publish(view.pin('データベースの時計だけ進んだ投稿 d'));
  await card.settle();
  pgApi.afterRelease = null;
  const d = latestAttempt(account);
  results.dAfterSend = statusError(d);
  results.dPublishes = writes(PUID_F, 'publish') - p0;
  results.dReconnectUnsettled = await reconnectResult();
  await settleOpen(account);
  results.d = statusError(d);
  results.dReconnectAfter = await reconnectResult();
  results.dMovedAfter = generationOf(account) !== gen0;
  await settleOpen(account);
  // (f) ONLY the Edge's wall clock jumps ahead 121 s while the release is answered: the reconnect is refused (nothing recorded
  //     yet); the Edge sends nothing and records failed STEP_INTERRUPTED; that record ends the lease and the reconnect goes through
  // (h) the Edge's wall clock moves BACK 5 s instead: the same
  for (const [label, skewMs] of [['f', 121000], ['h', -5000]]) {
    ({ card, view } = await readyCard());
    gen0 = generationOf(account);
    p0 = writes(PUID_F, 'publish');
    onPublishRelease(async () => {
      pub.clockSkewMs = skewMs;
      results[`${label}Reconnect`] = await reconnectResult();
      results[`${label}MovedBeforeRecord`] = generationOf(account) !== gen0;
    });
    await view.publish(view.pin(`サーバーの時計だけ動いた投稿 ${label}`));
    await card.settle();
    pgApi.afterRelease = null;
    pub.clockSkewMs = 0;
    const id = latestAttempt(account);
    results[label] = statusError(id);
    results[`${label}Publishes`] = writes(PUID_F, 'publish') - p0;
    results[`${label}ReconnectAfter`] = await reconnectResult();
    results[`${label}MovedAfter`] = generationOf(account) !== gen0;
    await settleOpen(account);
  }
  // (g) stalled AND given up on: the database's clock says 121 s and it gives up on the step, the Edge's clock also jumped
  //     121 s. The Edge sends nothing; its failed record is refused (the database already gave up), so the attempt stays
  //     `uncertain`. Its container is still FINISHED (not published, not expired): reconcile cannot settle it, and the reconnect
  //     stays refused -- the liveness price of a lease no clock can end. When the container reports EXPIRED, reconcile records
  //     failed CONTAINER_EXPIRED and the reconnect goes through. Nothing is ever sent.
  ({ card, view } = await readyCard());
  gen0 = generationOf(account);
  p0 = writes(PUID_F, 'publish');
  onPublishRelease(async (args) => {
    dbClockAhead(args.p_attempt_id, 121);
    await publishCall({ action: 'reconcile', attempt_id: args.p_attempt_id }, SESSION_F.access_token);
    pub.clockSkewMs = 121000;
    results.gReconnect = await reconnectResult();
  });
  await view.publish(view.pin('止まって見放された投稿 g'));
  await card.settle();
  pgApi.afterRelease = null;
  pub.clockSkewMs = 0;
  const g = latestAttempt(account);
  results.gAfterStall = statusError(g);
  await settleOpen(account);
  results.gFinished = `${containerOf(g)?.status}|${statusError(g)}`;
  results.gReconnectFinished = await reconnectResult();
  containerOf(g).status = 'EXPIRED';
  await settleOpen(account);
  results.g = statusError(g);
  results.gPublishes = writes(PUID_F, 'publish') - p0;
  results.gReconnectAfter = await reconnectResult();
  results.gMovedAfter = generationOf(account) !== gen0;
  await settleOpen(account);
  // (e) PostgreSQL: the publish release (the server's, held open 2 s) and a re-bind (the binding write, owner session)
  threadsApi.plan[PUID_F] = { status: 'IN_PROGRESS' };
  ({ card, view } = await readyCard());
  assert.equal(await view.publish(view.pin('リリース中に再バインドされる投稿 e')), true);
  const shown = await card.settle();
  finishContainers();
  threadsApi.plan[PUID_F] = {};
  const e = shown.answer;
  const rowE = bindingRow(account);
  const child = spawn('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db, '-f', '-'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let held = '';
  child.stdout.on('data', (chunk) => { held += chunk; });
  child.stderr.on('data', (chunk) => { held += chunk; });
  child.stdin.end(releaseAsServerSql(e.id, 'publish', 2));
  const releasing = new Promise((resolve) => child.on('close', resolve));
  let waiting = false;
  for (let i = 0; i < 400 && !waiting; i += 1) {
    waiting = owner(`select count(*) from pg_stat_activity where wait_event = 'PgSleep' and strpos(query, 'g4mg_y') > 0`) !== '0';
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  results.eHeld = waiting;
  const t0 = Date.now();
  const rebound = psql(`set lock_timeout = '5s'; update postona_threads_binding.bindings set oauth_state_id = gen_random_uuid(), bound_at = now() where social_account_id = ${lit(account)};`);
  results.eWaitedMs = Date.now() - t0;
  await releasing;
  results.eRelease = held.split('\n').filter((line) => /^[a-z]+:/u.test(line)).join(',');
  results.eRebind = rebound.ok ? 'committed' : rebound.message.replace(/^ERROR: +/u, '').split('\n')[0];
  results.eBindingKept = bindingRow(account) === rowE;
  results.eStatus = statusError(e.id);
  // #14: the database's clock alone (the release looks 121 s old) does not end the lease either
  dbClockAhead(e.id, 121);
  const late = psql(`update postona_threads_binding.bindings set oauth_state_id = gen_random_uuid() where social_account_id = ${lit(account)};`);
  results.eRebindDbClockAhead = late.ok ? 'committed' : late.message.replace(/^ERROR: +/u, '').split('\n')[0];
  // REPEATABLE READ: a snapshot could miss a lease, so a generation-moving write there is refused outright
  const rr = psql(`begin isolation level repeatable read; update postona_threads_binding.bindings set oauth_state_id = gen_random_uuid() where social_account_id = ${lit(account)}; commit;`);
  results.eRepeatableRead = rr.ok ? 'committed' : rr.message.replace(/^ERROR: +/u, '').split('\n')[0];
  // settle (e) read-only: nothing was sent for it; the container expires, the abandoned publish is reconciled
  containerOf(e.id).status = 'EXPIRED';
  await settleOpen(account);
  results.e = statusError(e.id);
  results.eRebindAfter = await reconnectResult();
  console.log(`measured 33: ${JSON.stringify(results)}`);
  const refused = (r) => typeof r === 'string' && r.startsWith('failed:');
  assert.equal(results.start, 'verifying');
  assert.deepEqual([results.aCommitted, results.aAnswered], ['publishing|-|bound=true|sent=0', true], 'H1 #41 setup: the publish release committed, nothing sent yet');
  assert.deepEqual([refused(results.aReconnect), results.aMovedBeforeSend], [true, false], `(a) the reconnect cannot commit during the send (${results.aReconnect})`);
  assert.deepEqual([results.a, results.aPublishes], ['published|-', 1], '(a) the one send that started first, once');
  assert.deepEqual([refused(results.cRebind), results.cBindingKept], [true, true], '(c) another Threads user is refused (by the existing completion checks; not a fence proof)');
  assert.deepEqual([results.aRetry, results.aMovedAfterRetry], ['verifying', true], '(a) after the send the reconnect goes through');
  assert.deepEqual([results.b, results.bBound, results.bPublishes], ['published|-', true, 1], '(b) a new attempt posts under the new connection');
  assert.deepEqual([refused(results.dReconnect), results.dMovedBeforeSend], [true, false], `(d) H1 #42: only the database's clock ahead -- the reconnect is still refused (${results.dReconnect})`);
  assert.ok(results.dGaveUp.split('|')[1] === 'uncertain', `(d) the database gave up on the step (${results.dGaveUp})`);
  assert.deepEqual([refused(results.dReconnectAbandoned), results.dMovedAbandoned], [true, false], `(d) ... and after it gave up, still refused (${results.dReconnectAbandoned})`);
  assert.deepEqual([results.dPublishes, results.dAfterSend.split('|')[0], refused(results.dReconnectUnsettled)], [1, 'uncertain', true], '(d) the one send went out; unsettled, the reconnect is still refused');
  assert.deepEqual([results.d, results.dReconnectAfter, results.dMovedAfter], ['published|-', 'verifying', true], '(d) settled read-only from the provider, then the reconnect');
  for (const label of ['f', 'h']) {
    assert.deepEqual([refused(results[`${label}Reconnect`]), results[`${label}MovedBeforeRecord`]], [true, false], `(${label}) refused until the server records (${results[`${label}Reconnect`]})`);
    assert.deepEqual([results[label], results[`${label}Publishes`], results[`${label}ReconnectAfter`], results[`${label}MovedAfter`]],
      ['failed|STEP_INTERRUPTED', 0, 'verifying', true], `(${label}) only the Edge's clock moved: nothing sent, its record ends the lease`);
  }
  assert.deepEqual([refused(results.gReconnect), results.gAfterStall.split('|')[0], results.gFinished.split('|').slice(0, 2), refused(results.gReconnectFinished)],
    [true, 'uncertain', ['FINISHED', 'uncertain'], true], `(g) given up and unsettled: refused (${results.gFinished})`);
  assert.deepEqual([results.g, results.gPublishes, results.gReconnectAfter, results.gMovedAfter], ['failed|CONTAINER_EXPIRED', 0, 'verifying', true], '(g) the container expired: settled, then the reconnect; nothing sent');
  assert.deepEqual([results.eHeld, results.eRelease, results.eRebind, results.eBindingKept, results.eStatus],
    [true, 'released:-', 'THREADS_BINDING_SEND_IN_PROGRESS', true, 'publishing|-'], '(e) the re-bind waited for the release, then was refused');
  assert.ok(results.eWaitedMs >= 800, `(e) the re-bind waited for the release's commit (${results.eWaitedMs} ms)`);
  assert.equal(results.eRebindDbClockAhead, 'THREADS_BINDING_SEND_IN_PROGRESS', '(e) the database clock alone ends nothing');
  assert.equal(results.eRepeatableRead, 'THREADS_BINDING_SEND_FENCE_ISOLATION');
  assert.deepEqual([results.e, results.eRebindAfter], ['failed|CONTAINER_EXPIRED', 'verifying'], '(e) settled read-only; the reconnect then goes through');
  assert.deepEqual(denied, [], 'no request left this process');
});
