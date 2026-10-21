// G2 QA (Issue #317, task postona-g2-auth-callback-outcome-cache-lifecycle-qa-20261021) -- QA only, no product code.
// Follows up G2 #419 observations CB3 (remembered sign-in callback outcomes are never cleared) and CB6 (a sign-out
// during the X connect browser round trip does not stop the exchange). Real locked @supabase/supabase-js with a
// synthetic fetch and in-memory storage; the real use-x-connect hook and auth-client-flows with stubbed modules.
// Offline: no network, no real credentials, no X. Server-side acceptance of a signed-out token is NOT_VERIFIED.
//
// Not repeated here (already covered): flow-id / OTP-type binding of remembered outcomes, cache pressure with
// in-flight exchanges (auth-boundary-regression); duplicate deliveries sharing one exchange, concurrent PKCE flows
// (auth-sdk-behavior); exact callback authority incl. the posting callback at parse level (auth-flows); X state /
// redirect / cancel / transient errors / single flight (x-oauth-callback, x-connect-auth-session); G2 #419 CB1-CB6
// (late return after another sign-in / sign-out, used and expired codes, landing routes, CB5 user switch, CB6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import * as flows from '../src/domain/auth-flows.ts';
import { createSanitizingStorage } from '../src/lib/session-storage.ts';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';
import * as oauth from '../src/lib/x-oauth-onboarding.ts';

const { AUTH_CALLBACK_URL, completeAuthCallback, forgetAuthCallbackOutcomes, parseAuthCallbackUrl } = flows;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const URL_BASE = 'https://proj.supabase.co';
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
function memoryStore() { const map = new Map(); return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } }; }
let sessionSerial = 0;
function sessionBody(userId) {
  const now = Math.floor(Date.now() / 1000);
  const sessionId = `sess-${userId}-${++sessionSerial}`;
  return { access_token: jwt({ sub: userId, session_id: sessionId, exp: now + 3600, aud: 'authenticated', role: 'authenticated' }), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: `rig-refresh-${sessionId}`, user: { id: userId, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-28T00:00:00Z' } };
}
/** Synthetic Auth server: PKCE exchanges answered per code (verifier checked); logout accepted; `down` = network failure. */
function fakeAuth(answers = {}) {
  const exchanges = [];
  const net = { down: false };
  const fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
      exchanges.push(body);
      if (net.down) throw new TypeError('network down');
      const answer = answers[body.auth_code];
      if (!answer || answer.used) return Response.json({ code: 'flow_state_not_found', msg: 'x' }, { status: 400, headers: { 'x-supabase-api-version': '2024-01-01' } });
      if (createHash('sha256').update(body.code_verifier).digest('base64url') !== answer.verifierFor) return Response.json({ code: 'bad_code_verifier', msg: 'x' }, { status: 400, headers: { 'x-supabase-api-version': '2024-01-01' } });
      answer.used = true;
      return Response.json(sessionBody(answer.userId));
    }
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    return Response.json({ msg: `unexpected ${url.pathname}` }, { status: 500 });
  };
  return { fetch, exchanges, net };
}
function client(store, fetch) {
  return createClient(URL_BASE, 'sb_publishable_test', { auth: { storage: createSanitizingStorage(store), persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce', experimental: { appendPkceFlowIdToRedirects: true } }, global: { fetch } });
}
async function startOAuth(supabase) {
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true } });
  assert.equal(error, null);
  return { flowId: data.flowId, challenge: new URL(data.url).searchParams.get('code_challenge') };
}
const linkUrl = (flowId, code) => `${AUTH_CALLBACK_URL}?sb_flow_id=${flowId}&code=${code}`;
const deepLink = (flowId, code) => parseAuthCallbackUrl(linkUrl(flowId, code));
const currentSession = async (supabase) => (await supabase.auth.getSession()).data.session;
const sessionIdOf = (session) => session && JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url')).session_id;
const verifierKeys = (store) => [...store.map.keys()].filter((k) => k.endsWith('code-verifier'));
const AUTH_FAILED = flows.authFlowMessage(null);

// ---- remembered sign-in outcomes: who reads them ---------------------------------------------------------------------

test('G2-CC1 (source map): remembered outcomes have no time limit (only 32 entries, oldest settled dropped first) and are read by exactly two callers -- the in-app browser round trip (always with its own flow id) and the deep-link handler (shows failures only)', async () => {
  const source = await read('src/domain/auth-flows.ts');
  const body = source.slice(source.indexOf('export function completeAuthCallback('), source.indexOf('export function forgetAuthCallbackOutcomes('));
  assert.match(source, /const MAX_REMEMBERED = 32;/u);
  assert.doesNotMatch(body, /\bDate\b|\bnow\(|setTimeout|\bexpir|\bttl\b/iu, 'no time-based expiry');
  assert.match(body, /\[\.\.\.outcomes\]\.find\(\(\[, entry\]\) => !entry\.pending\)/u, 'eviction = first settled entry in insertion order');
  const lib = await read('src/lib/auth-client-flows.ts');
  const provider = await read('src/providers/auth-provider.tsx');
  assert.deepEqual(lib.match(/completeAuthCallback\(callbackClient\(client\), [^;]+;/gu), [
    'completeAuthCallback(callbackClient(client), callback);',
    'completeAuthCallback(callbackClient(client), parseAuthCallbackUrl(outcome.url), { flowId });',
  ], 'deep link (no expectation) + round trip (own flow id)');
  assert.deepEqual(provider.match(/completeAuthCallbackUrl\(client, url\)\.then\(\(result\) => \{\s*[^}]+\}/gu), [
    'completeAuthCallbackUrl(client, url).then((result) => {\n        if (result && !result.ok && !result.cancelled) setError(result.message);\n      }',
  ], 'the deep-link handler only reports failures');
  assert.match(provider, /onAuthStateChange\(\(event, nextSession\) => \{[\s\S]{0,400}?setError\(null\);/u, 'any auth event clears that message');
  assert.match(await read('src/components/auth-screen.tsx'), /backendAvailable && authError \? <View style=\{styles\.notice\}><Text style=\{styles\.noticeText\}>\{authError\}<\/Text><\/View> : null/u, 'it is shown only on the sign-in screen');
});

test('G2-CC2 (real SDK, differential to the stub-client flow-binding test): a stale remembered success fed into a NEW flow (old code + new flow id) is refused without touching the new flow\'s verifier -- the real return of the new flow still signs in its own person', async () => {
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const a = await startOAuth(client(store, fakeAuth().fetch));
  const answers = { codeA: { userId: 'user-a', verifierFor: a.challenge } };
  const server = fakeAuth(answers);
  const supabase = client(store, server.fetch);
  assert.deepEqual(await completeAuthCallback(supabase, deepLink(a.flowId, 'codeA')), { ok: true, userId: 'user-a' });
  await supabase.auth.signOut({ scope: 'local' });
  const b = await startOAuth(supabase); // B starts a new in-app browser sign-in on the same phone
  answers.codeB = { userId: 'user-b', verifierFor: b.challenge };
  // The browser hands back the stale code under the new flow id (re-delivered / forged return).
  const stale = await completeAuthCallback(supabase, deepLink(b.flowId, 'codeA'), { flowId: b.flowId });
  assert.deepEqual(stale, { ok: false, message: flows.authFlowMessage('flow_state_not_found') }, 'refused, never A\'s success');
  assert.equal(server.exchanges.length, 1, 'no exchange for the stale code');
  assert.equal(await currentSession(supabase), null, 'nobody signed in by it');
  assert.equal(verifierKeys(store).length > 0, true, 'B\'s verifier is still there');
  assert.deepEqual(await completeAuthCallback(supabase, deepLink(b.flowId, 'codeB'), { flowId: b.flowId }), { ok: true, userId: 'user-b' }, 'B\'s real return still works');
  assert.equal((await currentSession(supabase))?.user.id, 'user-b');
});

test('G2-CC3: the same person signed in again (a new session) -- re-delivering the old session\'s link returns the remembered success but changes nothing: no exchange, the new session stays', async () => {
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const first = await startOAuth(client(store, fakeAuth().fetch));
  const answers = { code1: { userId: 'user-a', verifierFor: first.challenge } };
  const server = fakeAuth(answers);
  const supabase = client(store, server.fetch);
  await completeAuthCallback(supabase, deepLink(first.flowId, 'code1'), { flowId: first.flowId });
  const oldSession = sessionIdOf(await currentSession(supabase));
  await supabase.auth.signOut({ scope: 'local' });
  const second = await startOAuth(supabase);
  answers.code2 = { userId: 'user-a', verifierFor: second.challenge };
  await completeAuthCallback(supabase, deepLink(second.flowId, 'code2'), { flowId: second.flowId });
  const newSession = sessionIdOf(await currentSession(supabase));
  assert.notEqual(newSession, oldSession);
  const replay = await completeAuthCallback(supabase, deepLink(first.flowId, 'code1'));
  assert.deepEqual(replay, { ok: true, userId: 'user-a' }, 'answered from memory');
  assert.equal(server.exchanges.length, 2, 'no third exchange');
  assert.equal(sessionIdOf(await currentSession(supabase)), newSession, 'the new session is untouched');
});

test('G2-CC4 (cache "expiry" = eviction): after 32 newer outcomes the old success is forgotten; a re-delivery then goes back to the SDK and is refused (verifier already used) -- an honest failure on the sign-in screen, never a success, current session untouched', async () => {
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const a = await startOAuth(client(store, fakeAuth().fetch));
  const server = fakeAuth({ codeA: { userId: 'user-a', verifierFor: a.challenge } });
  const supabase = client(store, server.fetch);
  await completeAuthCallback(supabase, deepLink(a.flowId, 'codeA'), { flowId: a.flowId });
  const session = sessionIdOf(await currentSession(supabase));
  const filler = { auth: { exchangeCodeForSession: async () => ({ data: null, error: { code: 'flow_state_not_found' } }) } };
  for (let i = 0; i < 32; i += 1) await completeAuthCallback(filler, { kind: 'code', code: `filler-${i}`, flowId: 'f'.repeat(32) });
  const again = await completeAuthCallback(supabase, deepLink(a.flowId, 'codeA'));
  assert.equal(again.ok, false, 'not a success');
  assert.equal(again.message, AUTH_FAILED);
  assert.equal(sessionIdOf(await currentSession(supabase)), session, 'A\'s session untouched');
  assert.equal(server.exchanges.length, 1, 'the SDK refuses locally (no verifier) -- nothing sent to the server');
});

test('G2-CC5: repeated sign-out / sign-in cycles (A, B, A, B) with every earlier link re-delivered after each cycle -- no re-delivery ever changes who is signed in or sends a second exchange', async () => {
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const answers = {};
  const server = fakeAuth(answers);
  const supabase = client(store, server.fetch);
  const delivered = [];
  for (const [i, user] of ['user-a', 'user-b', 'user-a', 'user-b'].entries()) {
    const flow = await startOAuth(supabase);
    answers[`code${i}`] = { userId: user, verifierFor: flow.challenge };
    assert.deepEqual(await completeAuthCallback(supabase, deepLink(flow.flowId, `code${i}`), { flowId: flow.flowId }), { ok: true, userId: user });
    delivered.push([flow.flowId, `code${i}`]);
    const now = sessionIdOf(await currentSession(supabase));
    for (const [flowId, code] of delivered) await completeAuthCallback(supabase, deepLink(flowId, code));
    assert.equal(sessionIdOf(await currentSession(supabase)), now, `cycle ${i}: unchanged`);
    assert.equal(server.exchanges.length, i + 1, `cycle ${i}: one exchange per real sign-in`);
    await supabase.auth.signOut({ scope: 'local' });
    for (const [flowId, code] of delivered) await completeAuthCallback(supabase, deepLink(flowId, code));
    assert.equal(await currentSession(supabase), null, `cycle ${i}: still signed out after re-deliveries`);
  }
});

test('OBSERVATION G2-CC6 (fail-closed): a network failure during the exchange is remembered too -- the same link delivered again after the network is back returns the same failure without retrying; the SDK has already dropped that flow\'s verifier, so a retry could not succeed either (the person starts sign-in again)', async () => {
  forgetAuthCallbackOutcomes();
  const store = memoryStore();
  const a = await startOAuth(client(store, fakeAuth().fetch));
  const server = fakeAuth({ codeA: { userId: 'user-a', verifierFor: a.challenge } });
  const supabase = client(store, server.fetch);
  assert.equal(verifierKeys(store).some((k) => k.includes(a.flowId)), true, 'the flow\'s verifier is stored under its id');
  server.net.down = true;
  const first = await completeAuthCallback(supabase, deepLink(a.flowId, 'codeA'));
  assert.equal(first.ok, false);
  server.net.down = false;
  const second = await completeAuthCallback(supabase, deepLink(a.flowId, 'codeA'));
  assert.equal(verifierKeys(store).some((k) => k.includes(a.flowId)), false, 'the SDK dropped this flow\'s verifier after the failed exchange');
  assert.deepEqual(second, first, 'the remembered failure');
  assert.equal(server.exchanges.length, 1, 'no retry');
  assert.equal(await currentSession(supabase), null);
});

test('G2-CC7 (service collision at the deep-link entry, real auth-client-flows + SDK): X connect returns (oauth-callback, with or without an injected sb_flow_id) and X-shaped auth returns (state+code, no flow id) are ignored -- nothing is exchanged and nothing is shown', async () => {
  const sdkCalls = [];
  const fetch = async (input) => { sdkCalls.push(String(typeof input === 'string' ? input : input.url)); return Response.json({}, { status: 500 }); };
  const supabase = client(memoryStore(), fetch);
  const modules = {
    'expo-apple-authentication': {}, 'expo-crypto': {}, 'expo-web-browser': {}, 'react-native': { Platform: { OS: 'android' } },
    '@/domain/auth-flows': flows, '@/lib/x-oauth-onboarding': oauth,
  };
  const mod = { exports: {} };
  vm.runInNewContext(transpile(await read('src/lib/auth-client-flows.ts')), { module: mod, exports: mod.exports, URL, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; } }, { filename: 'auth-client-flows.ts' });
  const flow = 'c'.repeat(32);
  for (const url of [
    'kabumori-social://oauth-callback?state=s&code=x_code',
    `kabumori-social://oauth-callback?sb_flow_id=${flow}&code=x_code`,
    'kabumori-social://auth-callback?state=s&code=x_code',
    'kabumori-social://oauth-callback?error=access_denied&state=s',
  ]) {
    assert.equal(await mod.exports.completeAuthCallbackUrl(supabase, url), null, url);
  }
  assert.deepEqual(sdkCalls, [], 'no Auth request at all');
});

// ---- X connect ordering around sign-out (real hook) ------------------------------------------------------------------

/** The real use-x-connect hook; the browser round trip is held until `finish(type)`; the session and the server's
 * callback answer can be changed meanwhile. */
async function xHook({ callbackAnswer = () => ({ data: { success: true, handle: 'rig_handle_of_a' }, error: null }), source = null } = {}) {
  const slots = [];
  let cursor = 0;
  let round = 0;
  const auth = { session: { access_token: 'rig-jwt-A1', user: { id: 'user-a' } } };
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
    'expo-web-browser': { maybeCompleteAuthSession() {}, openAuthSessionAsync: (_url, redirect) => new Promise((resolve) => { finishBrowser = (type) => resolve(type === 'success' ? { type, url: `${redirect}?state=${requests.at(-1).options.body.state}&code=rig_code` } : { type }); }) },
    '@/features/x-connect/auth-session-options': { xConnectAuthSessionOptions },
    '@/lib/x-oauth-onboarding': oauth,
    '@/providers/auth-provider': { useAuth: () => ({ session: auth.session }) },
    '@/lib/supabase': { supabase: { functions: { invoke: async (name, options) => { requests.push({ name, options: plain(options) }); return name.endsWith('/callback') ? callbackAnswer(options) : { data: { authorization_url: 'https://x.com/i/oauth2/authorize' }, error: null }; } } } },
  };
  const mod = { exports: {} };
  vm.runInNewContext(transpile(source ?? await read('src/features/x-connect/use-x-connect.ts')), { module: mod, exports: mod.exports, URL, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; }, fetch: () => { throw new Error('live network forbidden'); } }, { filename: 'use-x-connect.ts' });
  let connectedCalls = 0;
  const render = () => { cursor = 0; return mod.exports.useXConnect(() => { connectedCalls += 1; }); };
  const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };
  return { auth, requests, render, finish: (type = 'success') => finishBrowser(type), settle, connectedCalls: () => connectedCalls };
}
const httpError = (status) => ({ data: null, error: { name: 'FunctionsHttpError', context: { status } } });

test('G2-CX1: sign-out, then the X browser is cancelled -- no exchange is sent, nothing is connected', async () => {
  const h = await xHook();
  const running = h.render().connect();
  await h.settle();
  h.auth.session = null;
  h.finish('cancel');
  await running;
  assert.deepEqual(h.requests.map((r) => r.name), ['x-oauth-connect-user']);
  assert.equal(h.render().state, 'cancelled');
  assert.equal(h.connectedCalls(), 0);
});

test('UNKNOWN G2-CX2 (owner G4, server side NOT_VERIFIED): sign-out and the SAME person signs in again while the X browser is open -- the exchange carries the OLD (signed-out) token; if the server refuses it the screen says "安全確認を完了できませんでした" (not connected), if it accepts the screen says connected for the same person', async () => {
  for (const [answer, state, handle, connected] of [
    [() => httpError(401), 'terminal_error', null, 0],
    [() => ({ data: { success: true, handle: 'rig_handle_of_a' }, error: null }), 'connected', '@rig_handle_of_a', 1],
  ]) {
    const h = await xHook({ callbackAnswer: answer });
    const running = h.render().connect();
    await h.settle();
    h.auth.session = null; // signed out (the hook's screen may be gone)
    h.render();
    h.auth.session = { access_token: 'rig-jwt-A2', user: { id: 'user-a' } }; // the same person, a new session
    h.render();
    h.finish();
    await running;
    const now = h.render();
    assert.equal(h.requests[1].options.headers.Authorization, 'Bearer rig-jwt-A1', 'the signed-out session\'s token');
    assert.equal(now.state, state);
    assert.equal(now.verifiedHandle, handle);
    assert.equal(h.connectedCalls(), connected);
  }
});

test('G2-CX3: whatever the server answers to an exchange sent after sign-out (401, 403, 400, 503, success:false, empty handle), the screen never says connected and the reload never runs', async () => {
  for (const answer of [httpError(401), httpError(403), httpError(400), httpError(503), { data: { success: false }, error: null }, { data: { success: true, handle: '' }, error: null }]) {
    const h = await xHook({ callbackAnswer: () => answer });
    const running = h.render().connect();
    await h.settle();
    h.auth.session = null;
    h.finish();
    await running;
    const now = h.render();
    assert.notEqual(now.state, 'connected', JSON.stringify(answer));
    assert.equal(now.verifiedHandle, null);
    assert.equal(h.connectedCalls(), 0);
  }
});

// ---- negative controls (AST) ------------------------------------------------------------------------------------------

function mutate(source, fileName, predicate, replace) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let hits = 0;
  const out = ts.transform(file, [(context) => (root) => ts.visitNode(root, function visit(node) {
    if (predicate(node)) { hits += 1; return replace(node); }
    return ts.visitEachChild(node, visit, context);
  })]);
  assert.equal(hits, 1, `${fileName}: exactly one match`);
  return ts.createPrinter().printFile(out.transformed[0]);
}
function loadFlows(source) {
  const mod = { exports: {} };
  vm.runInNewContext(transpile(source), { module: mod, exports: mod.exports, require: () => ({}), URL, URLSearchParams, Promise });
  return mod.exports;
}

test('negative controls: (1) remembered outcomes shared across flows, (2) a failed exchange turned into a success, (3) the X hook ignoring a cancel -- each is caught by the matching check above', async () => {
  const source = await read('src/domain/auth-flows.ts');
  const f = ts.factory;
  // (1) existing.context === context -> true: G2-CC2's stale code under a new flow borrows A's success.
  const shared = loadFlows(mutate(source, 'auth-flows.ts', (n) => ts.isConditionalExpression(n) && n.condition.getText() === 'existing.context === context', (n) => f.updateConditionalExpression(n, f.createTrue(), n.questionToken, n.whenTrue, n.colonToken, n.whenFalse)));
  {
    const store = memoryStore();
    const a = await startOAuth(client(store, fakeAuth().fetch));
    const supabase = client(store, fakeAuth({ codeA: { userId: 'user-a', verifierFor: a.challenge } }).fetch);
    await shared.completeAuthCallback(supabase, shared.parseAuthCallbackUrl(linkUrl(a.flowId, 'codeA')));
    const b = await startOAuth(supabase);
    const stale = await shared.completeAuthCallback(supabase, shared.parseAuthCallbackUrl(linkUrl(b.flowId, 'codeA')), { flowId: b.flowId });
    assert.equal(stale.ok, true, 'mutant 1: the stale success leaks into the new flow (G2-CC2 fails)');
  }
  // (2) `if (error) return { ok: false, ... }` -> ok: true: G2-CC4's evicted re-delivery reports a success.
  const lying = loadFlows(mutate(source, 'auth-flows.ts', (n) => ts.isIfStatement(n) && n.expression.getText() === 'error' && n.thenStatement.getText().includes('authFlowMessage(errorCodeOf(error))'), (n) => f.updateIfStatement(n, n.expression, f.createReturnStatement(f.createObjectLiteralExpression([f.createPropertyAssignment('ok', f.createTrue()), f.createPropertyAssignment('userId', f.createNull())])), undefined)));
  {
    const store = memoryStore();
    const a = await startOAuth(client(store, fakeAuth().fetch));
    const supabase = client(store, fakeAuth({ codeA: { userId: 'user-a', verifierFor: a.challenge, used: true } }).fetch);
    assert.equal((await lying.completeAuthCallback(supabase, lying.parseAuthCallbackUrl(linkUrl(a.flowId, 'codeA')))).ok, true, 'mutant 2: a refused return reported as success (G2-CC4 fails)');
  }
  // (3) the X hook without its browser-cancel branch: G2-CX1 sees no exchange only because of that branch.
  const hook = await read('src/features/x-connect/use-x-connect.ts');
  const noCancel = mutate(hook, 'use-x-connect.ts', (n) => ts.isIfStatement(n) && n.expression.getText() === "browserResult.type === 'cancel' || browserResult.type === 'dismiss'", () => f.createEmptyStatement());
  const h = await xHook({ source: noCancel });
  const running = h.render().connect();
  await h.settle();
  h.auth.session = null;
  h.finish('cancel');
  await running;
  assert.equal(h.render().state, 'retryable_error', 'mutant 3: a cancel is no longer "cancelled" (G2-CX1 fails)');
});
