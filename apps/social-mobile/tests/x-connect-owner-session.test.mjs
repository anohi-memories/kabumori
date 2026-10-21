// G4-18 (Issue #319; G2-CB5 / G2-CB6 from G2 #317 6316885227, QA PR #419): the X connect belongs to the person AND the
// Supabase session that started it. The REAL use-x-connect hook runs with synthetic dependencies (no network, no
// provider, no real token: unsigned JWT shapes whose sub / session_id claims are only read). The browser round trip is
// held open until `finish()`, so the signed-in person can change meanwhile, as on a device.
// X_CONNECT_HOOK_SOURCE=<path> runs these cases against another copy of the hook (used once to show the fail-before
// on main's hook); by default the hook in this checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';
import * as oauth from '../src/lib/x-oauth-onboarding.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';

const plain = (value) => JSON.parse(JSON.stringify(value));
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A synthetic app session: user id + session id claim + a token label (a different label = a refreshed token). */
const sessionOf = (userId, sessionId, label = '1') => ({
  access_token: `${b64url({ alg: 'none' })}.${b64url(sessionId ? { sub: userId, session_id: sessionId } : { sub: userId })}.${label}`,
  user: { id: userId },
});
const A = sessionOf('user-a', 'sess-a');
const B = sessionOf('user-b', 'sess-b');
const hookSource = process.env.X_CONNECT_HOOK_SOURCE
  ? await readFile(process.env.X_CONNECT_HOOK_SOURCE, 'utf8')
  : await readFile(new URL('../src/features/x-connect/use-x-connect.ts', import.meta.url), 'utf8');

async function harness({ browser = 'success', duringExchange = null } = {}) {
  const slots = [], requests = [];
  let cursor = 0, round = 0, completed = 0, finishBrowser;
  // `ui` is what the auth provider renders (useAuth); `sdk` is the SDK's stored session (getSession). On a device both
  // follow the same auth events; a case sets them apart only where it says so.
  const auth = { ui: A, sdk: A, error: null, throws: false };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback: (cb) => cb,
  };
  const modules = {
    react,
    'react-native': { Platform: { OS: 'android' } },
    'expo-crypto': {
      getRandomBytesAsync: async (n) => new Uint8Array(n).fill(++round),
      digestStringAsync: async (_a, v) => createHash('sha256').update(v).digest('base64'),
      CryptoDigestAlgorithm: { SHA256: 'SHA256' }, CryptoEncoding: { BASE64: 'BASE64' },
    },
    'expo-linking': { createURL: () => 'kabumori-social://oauth-callback' },
    'expo-web-browser': {
      maybeCompleteAuthSession() {},
      openAuthSessionAsync: (_url, redirect) => new Promise((resolve) => {
        finishBrowser = () => resolve(browser === 'cancel'
          ? { type: 'cancel' }
          : { type: 'success', url: `${redirect}?state=${requests.at(-1).options.body.state}&code=rig_code` });
      }),
    },
    '@/features/x-connect/auth-session-options': { xConnectAuthSessionOptions },
    '@/domain/recovery-binding': recoveryBinding,
    '@/lib/x-oauth-onboarding': oauth,
    '@/providers/auth-provider': { useAuth: () => ({ session: auth.ui }) },
    '@/lib/supabase': { supabase: {
      auth: { getSession: async () => {
        if (auth.throws) throw new Error('storage unavailable');
        return { data: { session: auth.error ? null : auth.sdk }, error: auth.error };
      } },
      functions: { invoke: async (name, options) => {
        requests.push({ name, options: plain(options) });
        if (!name.endsWith('/callback')) return { data: { authorization_url: 'https://x.com/i/oauth2/authorize' }, error: null };
        duringExchange?.(auth);
        return { data: { success: true, handle: 'rig_handle_of_a' }, error: null };
      } },
    } },
  };
  const js = ts.transpileModule(hookSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, URL,
    require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; },
    fetch: () => { throw new Error('live network forbidden'); } }, { filename: 'use-x-connect.ts' });
  const render = () => { cursor = 0; return mod.exports.useXConnect(() => { completed += 1; }); };
  const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
  /** Start a connect and wait until the browser is open (the start request sent). Wrapped: an async function would
   *  otherwise adopt the still-pending connect promise. */
  const open = async () => {
    const running = render().connect();
    await settle();
    return { running };
  };
  return { auth, requests, render, open, settle, finish: () => finishBrowser(), completed: () => completed };
}

const bearer = (request) => request.options.headers.Authorization;

function refusedBeforeExchange(h, label) {
  const now = h.render();
  assert.equal(h.requests.length, 1, `${label}: only the start request; no code exchange`);
  assert.equal(now.state, 'session_changed', `${label}: state`);
  assert.equal(now.verifiedHandle, null, `${label}: no handle shown`);
  assert.equal(h.completed(), 0, `${label}: no onConnected`);
}

test('control: the same person and session throughout -> exchange with that session\'s token, success, one onConnected', async () => {
  const h = await harness();
  const { running } = await h.open();
  h.finish();
  await running;
  assert.deepEqual(h.requests.map((r) => [r.name, bearer(r)]), [
    ['x-oauth-connect-user', `Bearer ${A.access_token}`],
    ['x-oauth-connect-user/callback', `Bearer ${A.access_token}`],
  ]);
  assert.equal(h.render().state, 'connected');
  assert.equal(h.render().verifiedHandle, '@rig_handle_of_a');
  assert.equal(h.completed(), 1);
});

test('G2-CB5: B signs in while A\'s browser round trip is open -> no exchange with A\'s token, no success for B, no onConnected', async () => {
  const h = await harness();
  const { running } = await h.open();
  h.auth.ui = B; h.auth.sdk = B; // SIGNED_IN of B; the screen stays mounted
  h.render();
  h.finish();
  await running;
  refusedBeforeExchange(h, 'CB5');
});

test('G2-CB6: A signs out while the browser is open -> no exchange is sent with the signed-out token', async () => {
  const h = await harness();
  const { running } = await h.open();
  h.auth.ui = null; h.auth.sdk = null; // SIGNED_OUT
  h.finish();
  await running;
  refusedBeforeExchange(h, 'CB6');
});

test('A -> B -> A: the same user id with a NEW session is not the session that started -> refused (user id alone is not enough)', async () => {
  const h = await harness();
  const { running } = await h.open();
  h.auth.ui = B; h.auth.sdk = B;
  h.render();
  const again = sessionOf('user-a', 'sess-a2');
  h.auth.ui = again; h.auth.sdk = again;
  h.render();
  h.finish();
  await running;
  refusedBeforeExchange(h, 'A->B->A');
});

test('the same session refreshed its access token while the browser was open -> still the owner; the exchange uses the CURRENT token', async () => {
  const h = await harness();
  const { running } = await h.open();
  const refreshed = sessionOf('user-a', 'sess-a', 'refreshed');
  h.auth.ui = refreshed; h.auth.sdk = refreshed; // TOKEN_REFRESHED: same session_id
  h.finish();
  await running;
  assert.equal(h.requests.length, 2);
  assert.equal(bearer(h.requests[1]), `Bearer ${refreshed.access_token}`);
  assert.notEqual(bearer(h.requests[1]), `Bearer ${A.access_token}`);
  assert.equal(h.render().state, 'connected');
  assert.equal(h.completed(), 1);
});

test('the person changes DURING the exchange -> the exchange was A\'s (A\'s token), but B\'s screen shows no success and nothing reloads', async () => {
  for (const [label, next] of [['B signs in', B], ['sign-out', null], ['A, new session', sessionOf('user-a', 'sess-a3')]]) {
    const h = await harness({ duringExchange: (auth) => { auth.ui = next; auth.sdk = next; } });
    const { running } = await h.open();
    h.finish();
    await running;
    const now = h.render();
    assert.equal(h.requests.length, 2, label);
    assert.equal(bearer(h.requests[1]), `Bearer ${A.access_token}`, `${label}: the exchange carried only the starter's token`);
    assert.equal(now.state, 'session_changed', label);
    assert.equal(now.verifiedHandle, null, label);
    assert.equal(h.completed(), 0, label);
  }
});

test('an unreadable session (getSession error or throw) while the browser is open -> unknown is refused, no exchange', async () => {
  for (const mode of ['error', 'throws']) {
    const h = await harness();
    const { running } = await h.open();
    if (mode === 'error') h.auth.error = { name: 'AuthError', message: 'unreadable' };
    else h.auth.throws = true;
    h.finish();
    await running;
    refusedBeforeExchange(h, mode);
  }
});

test('the start: a screen still showing another person, or a session without a session id, starts nothing', async () => {
  const stale = await harness();
  stale.auth.ui = A; stale.auth.sdk = B; // the stored session is already B's; the rendered screen is A's
  await stale.render().connect();
  assert.equal(stale.requests.length, 0, 'stale screen: no request');
  assert.equal(stale.render().state, 'session_changed');
  const noClaim = await harness();
  const claimless = sessionOf('user-a', null);
  noClaim.auth.ui = claimless; noClaim.auth.sdk = claimless;
  await noClaim.render().connect();
  assert.equal(noClaim.requests.length, 0, 'no session id: no request');
  assert.equal(noClaim.render().state, 'session_changed');
  assert.equal(noClaim.completed() + stale.completed(), 0);
});

test('a cancel at X after the person changed stays a cancel: no exchange, no success', async () => {
  const h = await harness({ browser: 'cancel' });
  const { running } = await h.open();
  h.auth.ui = B; h.auth.sdk = B;
  h.finish();
  await running;
  assert.equal(h.requests.length, 1);
  assert.equal(h.render().state, 'cancelled');
  assert.equal(h.completed(), 0);
});

test('after a refused round trip, B starts B\'s own connect: single flight held, then B\'s exchange carries only B\'s token', async () => {
  const h = await harness();
  const { running: first } = await h.open();
  h.render().connect(); // a second press while A's round trip is open: ignored (single flight)
  await h.settle();
  assert.equal(h.requests.length, 1);
  h.auth.ui = B; h.auth.sdk = B;
  h.finish();
  await first;
  assert.equal(h.render().state, 'session_changed');
  const { running: second } = await h.open();
  h.finish();
  await second;
  assert.deepEqual(h.requests.slice(1).map((r) => [r.name, bearer(r)]), [
    ['x-oauth-connect-user', `Bearer ${B.access_token}`],
    ['x-oauth-connect-user/callback', `Bearer ${B.access_token}`],
  ]);
  assert.equal(h.render().state, 'connected');
  assert.equal(h.completed(), 1);
});

test('nothing about the session is logged or shown: no console use in the hook, and the state text names no token or id', () => {
  if (process.env.X_CONNECT_HOOK_SOURCE) return; // a source check of this checkout only
  const code = hookSource.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
  assert.doesNotMatch(code, /console\.|Sentry|captureException|logger/u);
  const text = 'ログイン中のアカウントが変わったため、この接続は続けられません。必要なら、もう一度お試しください。';
  assert.match(hookSource, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.doesNotMatch(text, /user|sess|token|@/u);
});
