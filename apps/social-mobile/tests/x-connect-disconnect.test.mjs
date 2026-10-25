// G4-42 (Issue #319): the REAL use-x-connect hook's disconnect() and its connect failure states, with synthetic
// dependencies only (no network, no provider, no real token). Same technique as x-connect-owner-session.test.mjs (G4-18).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import vm from 'node:vm';
import ts from 'typescript';
import { xConnectAuthSessionOptions } from '../src/features/x-connect/auth-session-options.ts';
import * as oauth from '../src/lib/x-oauth-onboarding.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const sessionOf = (userId, sessionId) => ({
  access_token: `${b64url({ alg: 'none' })}.${b64url({ sub: userId, session_id: sessionId })}.1`,
  user: { id: userId },
});
const A = sessionOf('user-a', 'sess-a');
const B = sessionOf('user-b', 'sess-b');
const hookSource = await readFile(new URL('../src/features/x-connect/use-x-connect.ts', import.meta.url), 'utf8');

/** rpcAnswer: what supabase.rpc answers ({ error, status }); startError: what the Edge start answers. */
function harness({ rpcAnswer = { error: null, status: 200 }, startError = null } = {}) {
  const slots = [], rpcs = [];
  let cursor = 0, completed = 0;
  const auth = { ui: A, sdk: A, throws: false };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback: (cb) => cb,
  };
  const modules = {
    react,
    'react-native': { Platform: { OS: 'android' } },
    'expo-crypto': {
      getRandomBytesAsync: async (n) => new Uint8Array(n).fill(7),
      digestStringAsync: async () => 'ZGlnZXN0',
      CryptoDigestAlgorithm: { SHA256: 'SHA256' }, CryptoEncoding: { BASE64: 'BASE64' },
    },
    'expo-linking': { createURL: () => 'kabumori-social://oauth-callback' },
    'expo-web-browser': { maybeCompleteAuthSession() {}, openAuthSessionAsync: async () => ({ type: 'cancel' }) },
    '@/features/x-connect/auth-session-options': { xConnectAuthSessionOptions },
    '@/domain/recovery-binding': recoveryBinding,
    '@/lib/x-oauth-onboarding': oauth,
    '@/providers/auth-provider': { useAuth: () => ({ session: auth.ui }) },
    '@/lib/supabase': { supabase: {
      auth: { getSession: async () => {
        if (auth.throws) throw new Error('storage unavailable');
        return { data: { session: auth.sdk }, error: null };
      } },
      functions: { invoke: async () => (startError
        ? { data: null, error: startError }
        : { data: { authorization_url: 'https://x.com/i/oauth2/authorize' }, error: null }) },
      rpc: async (name, args) => { rpcs.push({ name, args }); return { data: null, ...rpcAnswer }; },
    } },
  };
  const js = ts.transpileModule(hookSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, URL,
    require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; },
    fetch: () => { throw new Error('live network forbidden'); } }, { filename: 'use-x-connect.ts' });
  const render = () => { cursor = 0; return mod.exports.useXConnect(() => { completed += 1; }); };
  return { auth, rpcs, render, completed: () => completed };
}

test('disconnect: the signed-in person -> one RPC call without arguments, disconnected, one reload', async () => {
  const h = harness();
  await h.render().disconnect();
  assert.deepEqual(h.rpcs, [{ name: 'disconnect_social_mobile_x_connection', args: undefined }]);
  assert.equal(h.render().state, 'disconnected');
  assert.equal(h.completed(), 1);
});

test('disconnect: a screen still showing another person, or an unreadable session, disconnects nothing', async () => {
  const stale = harness();
  stale.auth.sdk = B;
  await stale.render().disconnect();
  assert.equal(stale.rpcs.length, 0);
  assert.equal(stale.render().state, 'session_changed');
  assert.equal(stale.completed(), 0);
  const unreadable = harness();
  unreadable.auth.throws = true;
  await unreadable.render().disconnect();
  assert.equal(unreadable.rpcs.length, 0);
  assert.equal(unreadable.render().state, 'session_changed');
});

test('disconnect: server refusals map to what the person can do, and never reload', async () => {
  for (const [message, status, want] of [
    ['SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE', 400, 'session_required'],
    ['OWN_WORKSPACE_CONFLICT', 400, 'workspace_blocked'],
    ['X_DISCONNECT_NOT_ENABLED', 400, 'terminal_error'],
    ['X_CONNECTION_NOT_FOUND', 400, 'terminal_error'],
    ['upstream', 503, 'retryable_error'],
  ]) {
    const h = harness({ rpcAnswer: { error: { message }, status } });
    await h.render().disconnect();
    assert.equal(h.render().state, want, message);
    assert.equal(h.completed(), 0, message);
  }
});

test('connect: the Edge start refusal statuses (G4-41) reach the screen as their states', async () => {
  for (const [status, want] of [[401, 'session_required'], [409, 'workspace_blocked'], [400, 'terminal_error'], [503, 'retryable_error']]) {
    const h = harness({ startError: { name: 'FunctionsHttpError', context: { status } } });
    await h.render().connect();
    assert.equal(h.render().state, want, String(status));
    assert.equal(h.completed(), 0, String(status));
  }
});

test('every state has text, and the new texts name no token, id or code', () => {
  const h = harness();
  const text = h.render().stateText;
  assert.equal(typeof text, 'string');
  const js = ts.transpileModule(hookSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  for (const state of ['session_changed', 'session_required', 'workspace_blocked', 'disconnecting', 'disconnected']) {
    assert.match(js, new RegExp(`${state}: '`), state);
  }
  assert.doesNotMatch(hookSource, /console\./u);
});
