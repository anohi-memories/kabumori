// G4-48 (Issue #319): the X connect product flow end to end, driven by supabase/tests/postona_g4_x_oauth_app_flow_run.sh (which
// builds the database and sets FLOW_*). REAL: the app hook use-x-connect.ts, @supabase/supabase-js, the Edge handler
// x-oauth-connect-user/index.ts (+ oauth_logic.ts) and the SQL in PostgreSQL. FAKE: X, GoTrue's /auth/v1/user, PostgREST (a psql
// bridge) and the browser round trip (the person approves at X). Unsigned JWT shapes carry the claims; no network, no real token.
// Not part of `npm test` (*.test.mjs): it needs the runner's database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';
import * as oauth from '../src/lib/x-oauth-onboarding.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';

const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} missing (run postona_g4_x_oauth_app_flow_run.sh)`); return v; };
const MODE = env('FLOW_MODE');  // 'main' | 'g4' | 'g4p'
const PG = { host: env('FLOW_PGHOST'), port: env('FLOW_PGPORT'), user: env('FLOW_PGUSER'), db: env('FLOW_PGDATABASE') };
const [A, B, C, SA, SB, SC] = ['FLOW_A', 'FLOW_B', 'FLOW_C', 'FLOW_SA', 'FLOW_SB', 'FLOW_SC'].map(env);
const SUPABASE_URL = 'https://flow.supabase.test';
const ANON_KEY = 'sb_publishable_flow_fake_0123456789';
const REDIRECT = 'kabumori-social://oauth-callback';

// ---- PostgreSQL ------------------------------------------------------------------------------------------------------------
function psql(sql) {
  try {
    const out = execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
      '-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db, '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (error) {
    const text = String(error.stderr ?? error.message);
    const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/u.exec(text);
    return { ok: false, sqlstate: m?.[1] ?? 'XX000', message: m?.[2]?.trim() ?? text.trim() };
  }
}
const owner = (sql) => { const r = psql(sql); if (!r.ok) throw new Error(`${r.sqlstate} ${r.message}`); return r.out; };
const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replaceAll("'", "''")}'`);
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.fake`;
const claimsOf = (bearer) => {
  const token = /^Bearer\s+(.+)$/u.exec(bearer ?? '')?.[1];
  if (!token || token === ANON_KEY) return null;
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { return null; }
};

// ---- fake PostgREST: POST /rest/v1/rpc/<fn>, named arguments, the caller's claims, SQLSTATE -> HTTP ---------------------
const returnsSet = new Map();
function postgrest(name, args, bearer) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(name)) return Response.json({ message: 'bad name' }, { status: 404 });
  if (!returnsSet.has(name)) {
    returnsSet.set(name, owner(`select coalesce((select p.proretset from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = ${lit(name)} limit 1)::text, 'missing')`));
  }
  const kind = returnsSet.get(name);
  if (kind === 'missing') return Response.json({ code: 'PGRST202', message: `Could not find the function public.${name}` }, { status: 404 });
  const claims = claimsOf(bearer);
  const role = claims?.role === 'authenticated' ? 'authenticated' : 'anon';
  const call = `public.${name}(${Object.entries(args ?? {}).map(([k, v]) => `${k} => ${lit(v)}`).join(', ')})`;
  const body = kind === 'true' ? `select coalesce(json_agg(t), '[]'::json)::text from ${call} t` : `select coalesce(to_json(${call})::text, 'null')`;
  const r = psql(`begin; select set_config('request.jwt.claims', ${lit(claims ? JSON.stringify(claims) : '')}, true) is null; `
    + `set local role ${role}; ${body}; commit;`);
  if (r.ok) return new Response(r.out.split('\n').pop(), { status: 200, headers: { 'content-type': 'application/json' } });
  const status = r.sqlstate === '42501' ? (role === 'authenticated' ? 403 : 401) : r.sqlstate === '42883' ? 404 : 400;
  return Response.json({ code: r.sqlstate, message: r.message, details: null, hint: null }, { status });
}
// ---- fake GoTrue (/auth/v1/user) and fake X ---------------------------------------------------------------------------------
function gotrueUser(bearer) {
  const claims = claimsOf(bearer);
  if (!claims?.sub || owner(`select count(*) from auth.users where id = ${lit(claims.sub)}::uuid`) !== '1') {
    return Response.json({ msg: 'invalid JWT' }, { status: 401 });
  }
  return Response.json({ id: claims.sub, email: `${claims.sub}@flow.test` });
}
const X_ID = { value: 'x_g4ta' };
let tokenRound = 0;
function x(url) {
  if (url === 'https://api.x.com/2/oauth2/token') { tokenRound += 1; return Response.json({ access_token: `fakeXat_${tokenRound}`, refresh_token: `fakeXrt_${tokenRound}` }); }
  if (url === 'https://api.x.com/2/users/me') return Response.json({ data: { id: X_ID.value, username: 'flow_user' } });
  throw new Error(`unexpected X call ${url}`);
}

// ---- the REAL Edge handler, run in Node with a minimal Deno stand-in --------------------------------------------------------
const EDGE_ENV = { SUPABASE_URL, SUPABASE_ANON_KEY: ANON_KEY, X_CLIENT_ID: 'flow-x-client', X_CLIENT_SECRET: 'flow-x-secret' };
let edge = null;
globalThis.Deno = { serve: (handler) => { edge = handler; }, env: { get: (k) => EDGE_ENV[k] } };
const requests = [];
const route = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers));
  const bodyText = init.body === undefined ? undefined : String(init.body);
  requests.push({ url, authorization: headers.get('Authorization') });
  if (url.startsWith(`${SUPABASE_URL}/functions/v1/x-oauth-connect-user`)) {
    return edge(new Request(url, { method: init.method ?? 'POST', headers, body: bodyText }));
  }
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) {
    return postgrest(url.slice(`${SUPABASE_URL}/rest/v1/rpc/`.length).split('?')[0], bodyText ? JSON.parse(bodyText) : {}, headers.get('Authorization'));
  }
  if (url === `${SUPABASE_URL}/auth/v1/user`) return gotrueUser(headers.get('Authorization'));
  if (url.startsWith('https://api.x.com/')) return x(url);
  throw new Error(`unexpected fetch ${url}`);
};
// FLOW_DEBUG=1 prints every answer (status and body) of the fakes and the Edge
globalThis.fetch = async (input, init = {}) => {
  const response = await route(input, init);
  if (process.env.FLOW_DEBUG) {
    const url = typeof input === 'string' ? input : input.url;
    console.error(`[flow] ${url} -> ${response.status} ${(await response.clone().text()).slice(0, 300)}`);
  }
  return response;
};
await import(env('FLOW_EDGE'));
assert.equal(typeof edge, 'function', 'the Edge registered its handler');

// ---- the REAL hook, the REAL SDK ---------------------------------------------------------------------------------------------
const sessionOf = (userId, sessionId, extra = {}) => ({
  access_token: jwt({ sub: userId, role: 'authenticated', session_id: sessionId, is_anonymous: false, ...extra }),
  user: { id: userId },
});
const hookSource = await readFile(new URL('../src/features/x-connect/use-x-connect.ts', import.meta.url), 'utf8');
const hookJs = ts.transpileModule(hookSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

/** ui: the session the screen shows; script: what each auth.getSession() read answers (the last repeats);
 *  duringBrowser: runs while the person is at X (e.g. another person signs in). */
function app({ ui, script, duringBrowser = null }) {
  const slots = [];
  let cursor = 0, reloads = 0, reads = 0;
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (...a) => globalThis.fetch(...a) },
  });
  client.auth.getSession = async () => {
    const session = script[Math.min(reads, script.length - 1)];
    reads += 1;
    return { data: { session }, error: null };
  };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback: (cb) => cb,
  };
  const modules = {
    react,
    'react-native': { Platform: { OS: 'android' } },
    'expo-crypto': {
      getRandomBytesAsync: async (n) => new Uint8Array(randomBytes(n)),
      digestStringAsync: async (_a, v) => createHash('sha256').update(v).digest('base64'),
      CryptoDigestAlgorithm: { SHA256: 'SHA256' }, CryptoEncoding: { BASE64: 'BASE64' },
    },
    'expo-linking': { createURL: () => REDIRECT },
    'expo-web-browser': {
      maybeCompleteAuthSession() {},
      // the person approves at X: X redirects back with the same state and a code
      openAuthSessionAsync: async (authorizationUrl, redirect) => {
        await duringBrowser?.();
        const state = new URL(authorizationUrl).searchParams.get('state');
        return { type: 'success', url: `${redirect}?state=${encodeURIComponent(state)}&code=flow_code` };
      },
    },
    '@/features/x-connect/auth-session-options': { xConnectAuthSessionOptions },
    '@/domain/recovery-binding': recoveryBinding,
    '@/lib/x-oauth-onboarding': oauth,
    '@/providers/auth-provider': { useAuth: () => ({ session: ui }) },
    '@/lib/supabase': { supabase: client },
  };
  const mod = { exports: {} };
  vm.runInNewContext(hookJs, { module: mod, exports: mod.exports, URL,
    require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; } }, { filename: 'use-x-connect.ts' });
  const render = () => { cursor = 0; return mod.exports.useXConnect(() => { reloads += 1; }); };
  return { render, reloads: () => reloads };
}

const wsOf = (u) => `u_${createHash('md5').update(u).digest('hex').slice(0, 24)}`;
const account = (u) => owner(`select coalesce((select connection_status || '/' || coalesce(platform_user_id, '-') from public.social_accounts
  where brand_id = ${lit(wsOf(u))} and platform = 'x'), 'none')`);
const SESSION_A = sessionOf(A, SA);
const SESSION_B = sessionOf(B, SB);
const SESSION_C = sessionOf(C, SC);
const G4 = MODE === 'g4' || MODE === 'g4p';  // g4p: G4 X 001-005 on G5's personal MVP profile (G4-02 #5)
const PERSONAL = MODE === 'g4p';

test(`[${MODE}] A connects: start -> X -> callback -> connected, account verified`, async () => {
  const a = app({ ui: SESSION_A, script: [SESSION_A] });
  await a.render().connect();
  const now = a.render();
  assert.equal(now.state, 'connected', now.stateText);
  assert.equal(now.verifiedHandle, '@flow_user');
  assert.equal(a.reloads(), 1);
  assert.equal(account(A), 'identity_verified/x_g4ta');
});

test(`[${MODE}] A reconnects (a second round trip) -> connected again`, async () => {
  const a = app({ ui: SESSION_A, script: [SESSION_A] });
  await a.render().connect();
  assert.equal(a.render().state, 'connected');
});

test(`[${MODE}] C has no POSTONA service: ${G4 ? 'refused before X, the screen says it cannot connect yet' : 'GAP: connects anyway (main has no T13)'}`, async () => {
  X_ID.value = 'x_g4tc';  // the X user id the fixture already gave C's account
  const c = app({ ui: SESSION_C, script: [SESSION_C] });
  const before = requests.filter((r) => r.url.startsWith('https://api.x.com/')).length;
  await c.render().connect();
  X_ID.value = 'x_g4ta';
  if (G4) {
    assert.equal(c.render().state, 'workspace_blocked', c.render().stateText);
    assert.equal(requests.filter((r) => r.url.startsWith('https://api.x.com/')).length, before, 'X was never called');
  } else {
    assert.equal(c.render().state, 'connected', 'main lets a person without POSTONA connect X (G5-44 GAP G4-1)');
  }
});

test(`[${MODE}] an anonymous session: ${G4 ? 'sign in again (401)' : 'GAP: main lets it begin'}`, async () => {
  const anon = sessionOf(A, SA, { is_anonymous: true });
  const a = app({ ui: anon, script: [anon] });
  await a.render().connect();
  if (G4) assert.equal(a.render().state, 'session_required', a.render().stateText);
  else assert.notEqual(a.render().state, 'session_required', 'main has no anonymous rule');
});

test(`[${MODE}] another person signs in while A is at X: no exchange, no success, nothing reloaded`, async () => {
  // getSession reads: the hook's start check (A), the SDK's own read for the start request (A), the check before the exchange (B)
  const a = app({ ui: SESSION_A, script: [SESSION_A, SESSION_A, SESSION_B] });
  const callbacksBefore = requests.filter((r) => r.url.endsWith('/x-oauth-connect-user/callback')).length;
  await a.render().connect();
  assert.equal(a.render().state, 'session_changed');
  assert.equal(a.reloads(), 0);
  assert.equal(requests.filter((r) => r.url.endsWith('/x-oauth-connect-user/callback')).length, callbacksBefore, 'no exchange was sent');
});

test(`[${MODE}] A disconnects: ${G4 ? 'unconnected, one reload; then reconnects' : 'GAP: main has no disconnect RPC (the screen says start over)'}`, async () => {
  const a = app({ ui: SESSION_A, script: [SESSION_A] });
  await a.render().disconnect();
  if (G4) {
    assert.equal(a.render().state, 'disconnected', a.render().stateText);
    assert.equal(a.reloads(), 1);
    assert.equal(account(A), 'unconnected/x_g4ta');
    const again = app({ ui: SESSION_A, script: [SESSION_A] });
    await again.render().connect();
    assert.equal(again.render().state, 'connected');
    assert.equal(account(A), 'identity_verified/x_g4ta');
  } else {
    assert.equal(a.render().state, 'terminal_error');
    assert.equal(account(A), 'identity_verified/x_g4ta');
  }
});

test(`[${MODE}] A's service ends and restarts while A is at X (SYNTHETIC lifecycle_version + 2): ${PERSONAL ? 'refused at the callback (g5pv generation moved)' : 'connects (only the personal profile binds the service generation)'}`, async () => {
  const before = account(A);
  const a = app({ ui: SESSION_A, script: [SESSION_A], duringBrowser: () => {
    owner(`update public.common_accounts set lifecycle_version = lifecycle_version + 2 where user_id = ${lit(A)}::uuid`);
  } });
  await a.render().connect();
  console.log(`measured [${MODE}] service ABA during X: ${a.render().state} account=${account(A)}`);
  if (PERSONAL) {
    // the callback's complete refuses (the recorded g5pv generation moved); the screen says start over, nothing is written
    assert.equal(a.render().state, 'terminal_error', a.render().stateText);
    assert.equal(a.reloads(), 0);
    assert.equal(account(A), before, 'nothing written');
  } else {
    assert.equal(a.render().state, 'connected', a.render().stateText);
  }
});

test(`[${MODE}] A's service is being ended: ${G4 ? 'cannot connect (409)' : 'GAP: main connects anyway'}`, async () => {
  owner(`set role service_role; select public.begin_service_deletion(${lit(A)}::uuid, 'x_autopost'); reset role;`);
  const a = app({ ui: SESSION_A, script: [SESSION_A] });
  await a.render().connect();
  assert.equal(a.render().state, G4 ? 'workspace_blocked' : 'connected', a.render().stateText);
});
