// G2 QA (Issue #317, task postona-g2-android-auth-callback-reentry-negative-qa-20261021) -- QA only, no product code.
// Sign-in (auth-callback) and X connect (oauth-callback) returns across sign-out / another person, on the REAL locked
// @supabase/supabase-js with a synthetic fetch and in-memory storage, and on the REAL use-x-connect hook with stubbed
// modules. Offline: no network, no real credentials, no X. Android device behaviour (singleTask re-delivery, a
// relaunched activity keeping its launch intent) is NOT_VERIFIED; only the JS paths both platforms share are run.
//
// Existing tests (auth-flows, auth-boundary-regression, auth-sdk-behavior, x-oauth-callback, x-connect-auth-session,
// G2 #361/#362) already cover: exact callback authority, duplicates/conflicts/missing flow id, concurrent PKCE flows,
// shared duplicate exchanges, recovery binding, X state/redirect/code checks, X cancel/denial, single-flight press,
// Android App Link filters and intent forms. This file adds only the sign-out / other-person cross-overs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { AUTH_CALLBACK_URL, completeAuthCallback, forgetAuthCallbackOutcomes, parseAuthCallbackUrl } from '../src/domain/auth-flows.ts';
import { createSanitizingStorage } from '../src/lib/session-storage.ts';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';
import * as oauth from '../src/lib/x-oauth-onboarding.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const URL_BASE = 'https://proj.supabase.co';
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
function memoryStore() { const map = new Map(); return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } }; }
function sessionBody(userId) {
  const now = Math.floor(Date.now() / 1000);
  return { access_token: jwt({ sub: userId, session_id: `sess-${userId}`, exp: now + 3600, aud: 'authenticated', role: 'authenticated' }), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: `rig-refresh-${userId}`, user: { id: userId, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-28T00:00:00Z' } };
}
/** Synthetic Auth server: PKCE exchanges answered per code (verifier checked); logout accepted. */
function fakeAuth(answers = {}) {
  const exchanges = [];
  const fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
      exchanges.push(body);
      const answer = answers[body.auth_code];
      // Auth API 2024-01-01 error shape: string code + version header (without the header auth-js reads only error_code).
      if (answer?.expired) return Response.json({ code: 'flow_state_expired', msg: 'x' }, { status: 400, headers: { 'x-supabase-api-version': '2024-01-01' } });
      if (!answer || answer.used) return Response.json({ code: 'flow_state_not_found', msg: 'x' }, { status: 400 });
      if (createHash('sha256').update(body.code_verifier).digest('base64url') !== answer.verifierFor) return Response.json({ code: 'bad_code_verifier', msg: 'x' }, { status: 400 });
      answer.used = true;
      return Response.json(sessionBody(answer.userId));
    }
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    return Response.json({ msg: `unexpected ${url.pathname}` }, { status: 500 });
  };
  return { fetch, exchanges };
}
function client(store, fetch) {
  return createClient(URL_BASE, 'sb_publishable_test', { auth: { storage: createSanitizingStorage(store), persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce', experimental: { appendPkceFlowIdToRedirects: true } }, global: { fetch } });
}
async function startOAuth(supabase) {
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true } });
  assert.equal(error, null);
  return { flowId: data.flowId, challenge: new URL(data.url).searchParams.get('code_challenge') };
}
const deepLink = (flowId, code) => parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${flowId}&code=${code}`);

// ---- sign-in returns (real SDK) ---------------------------------------------------------------------------------------

test('OBSERVATION G2-CB1 (sign-in owner to confirm; by design of PKCE links): a late return of A\'s sign-in flow after B signed in on the same phone still exchanges with A\'s stored verifier and replaces B with A, without asking', async () => {
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const a = await startOAuth(client(store, fakeAuth().fetch)); // A starts, e.g. an e-mail / OAuth link that comes back later
  const b = await startOAuth(client(store, fakeAuth().fetch));
  const server = fakeAuth({ codeA: { userId: 'user-a', verifierFor: a.challenge }, codeB: { userId: 'user-b', verifierFor: b.challenge } });
  const supabase = client(store, server.fetch);
  assert.deepEqual(await completeAuthCallback(supabase, deepLink(b.flowId, 'codeB'), { flowId: b.flowId }), { ok: true, userId: 'user-b' });
  // The OS delivers A's return later through the deep-link path (AuthProvider: no expected flow id).
  assert.deepEqual(await completeAuthCallback(supabase, deepLink(a.flowId, 'codeA')), { ok: true, userId: 'user-a' }, 'A\'s verifier survived B\'s sign-in');
  assert.equal((await supabase.auth.getSession()).data.session?.user.id, 'user-a', 'A is now the signed-in person');
});

test('G2-CB1-S: a late return of A\'s sign-in flow after a sign-out is refused -- sign-out (auth-js 2.115.0 _removeSession -> removeAllPKCEVerifiers) drops every stored verifier, so nobody is signed in by it', async () => {
  const sdk = await readFile(new URL('../node_modules/@supabase/auth-js/dist/main/GoTrueClient.js', import.meta.url), 'utf8');
  assert.match(sdk, /async _removeSession\(\) \{[\s\S]{0,900}?removeAllPKCEVerifiers\)\(this\.storage, this\.storageKey\)/u, 'the locked SDK clears verifiers on sign-out');
  for (const scope of ['local', 'global']) {
    forgetAuthCallbackOutcomes();
    const store = memoryStore();
    const a = await startOAuth(client(store, fakeAuth().fetch));
    const b = await startOAuth(client(store, fakeAuth().fetch));
    const server = fakeAuth({ codeA: { userId: 'user-a', verifierFor: a.challenge }, codeB: { userId: 'user-b', verifierFor: b.challenge } });
    const supabase = client(store, server.fetch);
    await completeAuthCallback(supabase, deepLink(b.flowId, 'codeB'), { flowId: b.flowId });
    await supabase.auth.signOut({ scope });
    assert.equal([...store.map.keys()].filter((k) => k.endsWith('code-verifier')).length, 0, `${scope}: no verifier left`);
    const late = await completeAuthCallback(supabase, deepLink(a.flowId, 'codeA'));
    assert.equal(late.ok, false, `${scope}: refused`);
    assert.equal(server.exchanges.length, 1, `${scope}: no exchange was even sent for A`);
    assert.equal((await supabase.auth.getSession()).data.session, null, `${scope}: still signed out`);
  }
});

test('G2-CB2: a return whose code was already used (e.g. a relaunch re-delivering the launch link in a new process) is never a success -- it is refused, with no session change', async () => {
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const a = await startOAuth(client(store, fakeAuth().fetch));
  const server = fakeAuth({ codeA: { userId: 'user-a', verifierFor: a.challenge } });
  const supabase = client(store, server.fetch);
  assert.deepEqual(await completeAuthCallback(supabase, deepLink(a.flowId, 'codeA'), { flowId: a.flowId }), { ok: true, userId: 'user-a' });
  await supabase.auth.signOut({ scope: 'local' });
  forgetAuthCallbackOutcomes(); // a new process: nothing remembered
  const again = await completeAuthCallback(client(store, server.fetch), deepLink(a.flowId, 'codeA'));
  assert.equal(again.ok, false, 'not a success');
  assert.equal((await client(store, server.fetch).auth.getSession()).data.session, null, 'still signed out');
});

test('G2-CB2-E: an expired sign-in return is refused with the expiry message, nobody is signed in, and a second delivery of it stays refused', async () => {
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const a = await startOAuth(client(store, fakeAuth().fetch));
  const server = fakeAuth({ codeA: { userId: 'user-a', verifierFor: a.challenge, expired: true } });
  const supabase = client(store, server.fetch);
  for (const delivery of ['first', 'second']) {
    const result = await completeAuthCallback(supabase, deepLink(a.flowId, 'codeA'));
    assert.deepEqual(result, { ok: false, message: 'ログインの有効期限が切れました。もう一度お試しください。' }, delivery);
    assert.equal((await supabase.auth.getSession()).data.session, null, delivery);
  }
});

test('OBSERVATION G2-CB3 (sign-in owner to confirm): forgetAuthCallbackOutcomes() ("e.g. on sign-out") is called by no product code -- after a sign-out a re-delivered earlier success is answered from memory (no new exchange, no UI effect: the deep-link handler only shows failures)', async () => {
  const provider = await read('src/providers/auth-provider.tsx');
  const flows = await read('src/lib/auth-client-flows.ts');
  assert.doesNotMatch(provider + flows, /forgetAuthCallbackOutcomes/u, 'no product caller');
  assert.match(provider, /if \(result && !result\.ok && !result\.cancelled\) setError\(result\.message\);/u, 'the deep-link handler acts on failures only');
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const a = await startOAuth(client(store, fakeAuth().fetch));
  const server = fakeAuth({ codeA: { userId: 'user-a', verifierFor: a.challenge } });
  const supabase = client(store, server.fetch);
  await completeAuthCallback(supabase, deepLink(a.flowId, 'codeA'), { flowId: a.flowId });
  await supabase.auth.signOut({ scope: 'local' });
  const replay = await completeAuthCallback(supabase, deepLink(a.flowId, 'codeA'));
  assert.deepEqual(replay, { ok: true, userId: 'user-a' }, 'answered from memory');
  assert.equal(server.exchanges.length, 1, 'no second exchange');
  assert.equal((await supabase.auth.getSession()).data.session, null, 'and nobody was signed in by it');
});

test('G2-CB4: both landing routes only go home -- they read no URL, parameter or session (a wrong or forged link cannot produce a success screen there)', async () => {
  for (const route of ['src/app/auth-callback.tsx', 'src/app/oauth-callback.tsx']) {
    const src = (await read(route)).replace(/\/\*[\s\S]*?\*\//gu, '');
    assert.match(src, /return <Redirect href="\/" \/>;/u, route);
    assert.doesNotMatch(src, /useLocalSearchParams|useGlobalSearchParams|usePathname|useURL|Linking|useAuth|searchParams|parse/u, route);
  }
});

// ---- X connect across a change of person (real hook) -----------------------------------------------------------------

/** The real use-x-connect hook; the browser round trip is held until `finish()`; the session can be changed meanwhile. */
async function xHook() {
  const slots = [];
  let cursor = 0;
  let round = 0;
  const auth = { session: { access_token: 'rig-jwt-A', user: { id: 'user-a' } } };
  const requests = [];
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
    'expo-web-browser': { maybeCompleteAuthSession() {}, openAuthSessionAsync: (_url, redirect) => new Promise((resolve) => { finishBrowser = () => resolve({ type: 'success', url: `${redirect}?state=${requests.at(-1).options.body.state}&code=rig_code` }); }) },
    '@/features/x-connect/auth-session-options': { xConnectAuthSessionOptions },
    '@/lib/x-oauth-onboarding': oauth,
    '@/providers/auth-provider': { useAuth: () => ({ session: auth.session }) },
    '@/lib/supabase': { supabase: { functions: { invoke: async (name, options) => { requests.push({ name, options: plain(options) }); return name.endsWith('/callback') ? { data: { success: true, handle: 'rig_handle_of_a' }, error: null } : { data: { authorization_url: 'https://x.com/i/oauth2/authorize' }, error: null }; } } } },
  };
  const js = ts.transpileModule(await read('src/features/x-connect/use-x-connect.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, URL, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; }, fetch: () => { throw new Error('live network forbidden'); } }, { filename: 'use-x-connect.ts' });
  let connectedCalls = 0;
  const render = () => { cursor = 0; return mod.exports.useXConnect(() => { connectedCalls += 1; }); };
  const tick = () => new Promise((r) => setImmediate(r));
  return { auth, requests, render, finish: () => finishBrowser(), tick, connectedCalls: () => connectedCalls };
}

test('FINDING G2-CB5 (P3, owner of the X connect screen / G4 server): another person signs in while A\'s X browser round trip is open -- the exchange still runs with A\'s token, and the still-mounted screen then tells B "Xアカウントを接続しました @A\'s handle"', async () => {
  const h = await xHook();
  const first = h.render();
  const running = first.connect();
  for (let i = 0; i < 6; i += 1) await h.tick();
  assert.equal(h.requests.length, 1, 'the start request went out as A');
  h.auth.session = { access_token: 'rig-jwt-B', user: { id: 'user-b' } }; // SIGNED_IN of B; the root layout stays mounted
  h.render();
  h.finish();
  await running;
  const now = h.render();
  assert.equal(h.requests[1].options.headers.Authorization, 'Bearer rig-jwt-A', 'the callback exchange used A\'s token');
  assert.equal(now.state, 'connected');
  assert.equal(now.verifiedHandle, '@rig_handle_of_a');
  assert.equal(h.auth.session.user.id, 'user-b', 'while B is the signed-in person');
  assert.equal(h.connectedCalls(), 1, 'and onConnected (a data reload for B) ran');
});

test('OBSERVATION G2-CB6 (owner G4 server / NOT_VERIFIED): a sign-out while A\'s X browser round trip is open does not stop it -- the app still sends the callback exchange with A\'s (signed-out) token; whether the server accepts it is not verified', async () => {
  const h = await xHook();
  const running = h.render().connect();
  for (let i = 0; i < 6; i += 1) await h.tick();
  h.auth.session = null; // SIGNED_OUT: the root layout shows the sign-in screen (the hook's screen is gone)
  h.finish();
  await running;
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].name, 'x-oauth-connect-user/callback');
  assert.equal(h.requests[1].options.headers.Authorization, 'Bearer rig-jwt-A');
});

// ---- negative controls (AST) ------------------------------------------------------------------------------------------

test('negative controls: a landing route that reads the link, and a callback completion that turns a refused code into a success, are each caught', async () => {
  // 1. auth-callback that reads a parameter: G2-CB4's pattern check fails on it
  const route = await read('src/app/auth-callback.tsx');
  const mutated = route.replace("import { Redirect } from 'expo-router';", "import { Redirect, useLocalSearchParams } from 'expo-router';").replace('  return <Redirect href="/" />;', '  const { code } = useLocalSearchParams();\n  return <Redirect href={`/?c=${code}`} />;');
  assert.notEqual(mutated, route);
  assert.match(mutated.replace(/\/\*[\s\S]*?\*\//gu, ''), /useLocalSearchParams/u, 'mutant: caught by G2-CB4');
  // 2. a completion that reports any server error as success: G2-CB2 sees ok:true on a used code
  const printer = ts.createPrinter();
  const source = await read('src/domain/auth-flows.ts');
  const file = ts.createSourceFile('auth-flows.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let n = 0;
  const out = ts.transform(file, [(context) => (root) => ts.visitNode(root, function v(node) {
    if (ts.isIfStatement(node) && node.expression.getText() === 'error' && node.thenStatement.getText().includes('authFlowMessage(errorCodeOf(error))')) {
      n += 1;
      return ts.factory.updateIfStatement(node, node.expression, ts.factory.createReturnStatement(ts.factory.createObjectLiteralExpression([ts.factory.createPropertyAssignment('ok', ts.factory.createTrue()), ts.factory.createPropertyAssignment('userId', ts.factory.createNull())])), undefined);
    }
    return ts.visitEachChild(node, v, context);
  })]);
  assert.equal(n, 1, 'exactly one server-error branch in the exchange');
  const js = ts.transpileModule(printer.printFile(out.transformed[0]), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, require: () => ({}), URL, URLSearchParams, Promise });
  const store = memoryStore();
  const a = await startOAuth(client(store, fakeAuth().fetch));
  const server = fakeAuth({ codeA: { userId: 'user-a', verifierFor: a.challenge, used: true } }); // the code is already used
  const result = await mod.exports.completeAuthCallback(client(store, server.fetch), mod.exports.parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${a.flowId}&code=codeA`));
  assert.equal(result.ok, true, 'mutant: a refused code reported as success (G2-CB2 would fail on it)');
});
