// H1 focused acceptance regressions. Exact app source, synthetic sessions only.
// No live Auth/OAuth requests, provider credentials, or database calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as flows from '../src/domain/auth-flows.ts';
import * as recovery from '../src/domain/recovery-binding.ts';
import * as release from '../src/domain/auth-release-readiness.ts';
import * as storage from '../src/lib/session-storage.ts';

const flowA = 'a'.repeat(32), flowB = 'b'.repeat(32);
const callbackClient = (complete) => ({ auth: { exchangeCodeForSession: complete, verifyOtp: complete } });
const success = (userId = 'fixture-a') => ({ data: { session: { user: { id: userId } } }, error: null });

test('remembered code outcome cannot authenticate the same code under a different flow ID', async () => {
  flows.forgetAuthCallbackOutcomes();
  let calls = 0;
  const client = callbackClient(async () => { calls++; return success(); });
  assert.equal((await flows.completeAuthCallback(client, { kind: 'code', code: 'fixture-code', flowId: flowA }, { flowId: flowA })).ok, true);
  const result = await flows.completeAuthCallback(client, { kind: 'code', code: 'fixture-code', flowId: flowB }, { flowId: flowB });
  assert.equal(result.ok, false, 'a mismatched flow must not borrow the cached successful outcome');
  assert.equal(calls, 1, 'a conflicting replay must not consume another flow verifier');
});

test('remembered token-hash outcome is bound to its OTP type and flow', async () => {
  flows.forgetAuthCallbackOutcomes();
  let calls = 0;
  const client = callbackClient(async () => { calls++; return success(); });
  const original = { kind: 'token_hash', tokenHash: 'fixture-hash', type: 'signup', flowId: flowA };
  assert.equal((await flows.completeAuthCallback(client, original)).ok, true);
  for (const callback of [{ ...original, type: 'recovery' }, { ...original, flowId: flowB }]) {
    assert.equal((await flows.completeAuthCallback(client, callback)).ok, false);
  }
  assert.equal(calls, 1);
});

test('callback cache pressure never evicts an in-flight credential and exchanges it twice', async () => {
  flows.forgetAuthCallbackOutcomes();
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const calls = new Map();
  const client = callbackClient(async (code) => { calls.set(code, (calls.get(code) ?? 0) + 1); return pending; });
  const callbacks = Array.from({ length: 33 }, (_, index) => ({ kind: 'code', code: `pressure-${index}`, flowId: flowA }));
  const results = callbacks.map((callback) => flows.completeAuthCallback(client, callback));
  const duplicate = flows.completeAuthCallback(client, callbacks[0]);
  assert.equal(calls.get('pressure-0'), 1);
  finish(success());
  const firstResult = await results[0];
  assert.deepEqual(await duplicate, firstResult);
  await Promise.all(results);
});

test('authenticated linking refuses non-authorize paths even on expected provider hosts', () => {
  const redirect = encodeURIComponent('https://fixture.supabase.co/auth/v1/callback');
  for (const [provider, host] of [['x', 'x.com'], ['google', 'accounts.google.com'], ['apple', 'appleid.apple.com']]) {
    assert.equal(flows.isAllowedLinkUrl(`https://${host}/home?redirect_uri=${redirect}`, provider, 'fixture.supabase.co'), false);
  }
});

function session(userId, sessionId) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId })).toString('base64url');
  return { access_token: `synthetic.${payload}.signature`, user: { id: userId } };
}

async function providerHarness() {
  const slots = []; let cursor = 0, first = true, subscriber;
  const effects = [];
  const sessionA = session('fixture-a', 'session-a'), sessionB = session('fixture-b', 'session-b');
  let currentSession = null, getSessionImpl = async () => ({ data: { session: currentSession }, error: null });
  const updates = [];
  const react = {
    createContext: () => ({ Provider: {} }),
    useState: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect: (effect) => { if (first) effects.push(effect); },
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
  };
  const client = { auth: {
    getSession: () => getSessionImpl(),
    onAuthStateChange: (callback) => { subscriber = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    updateUser: async () => { updates.push(currentSession?.user.id); return { error: null }; },
    signOut: async () => { currentSession = null; subscriber('SIGNED_OUT', null); return { error: null }; },
  } };
  const modules = {
    react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    'expo-constants': { default: { expoConfig: {} } },
    'react-native': { Platform: { OS: 'ios' } },
    'expo-linking': { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) },
    '@/lib/supabase': { supabase: client,
      getSupabaseConfig: () => ({ ok: true, config: { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' } }),
      getSupabaseHost: () => 'fixture.supabase.co' },
    '@/lib/auth-errors': { signInErrorMessage: () => 'fixed error' },
    '@/lib/session-storage': storage,
    '@/lib/auth-client-flows': { completeAuthCallbackUrl: async () => null, isNativeAppleAvailable: async () => false },
    '@/domain/auth-flows': flows, '@/domain/recovery-binding': recovery, '@/domain/auth-release-readiness': release,
  };
  const source = await readFile(new URL('../src/providers/auth-provider.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module, exports: module.exports, process: { env: {} },
    require: (name) => { assert.ok(Object.hasOwn(modules, name), `unexpected import ${name}`); return modules[name]; },
    fetch: async () => ({ ok: true, json: async () => ({ external: { email: true }, disable_signup: false }) }),
  }, { filename: 'auth-provider.tsx' });
  const render = () => { cursor = 0; return module.exports.AuthProvider({ children: null }).props.value; };
  render(); first = false; effects.forEach((effect) => effect());
  await new Promise((resolve) => setImmediate(resolve));
  const emit = (event, nextSession) => { currentSession = nextSession; subscriber(event, nextSession); };
  return { render, emit, updates, sessionA, sessionB, deferSession: () => {
    let resolve;
    getSessionImpl = () => new Promise((done) => { resolve = done; });
    return (nextSession) => resolve({ data: { session: nextSession }, error: null });
  } };
}

test('password action for recovery A cannot retarget to a newer recovery B while getSession awaits', async () => {
  const harness = await providerHarness();
  harness.emit('PASSWORD_RECOVERY', harness.sessionA);
  const finish = harness.deferSession();
  const savingA = harness.render().completePasswordRecovery('synthetic-password', 'synthetic-password');
  harness.emit('PASSWORD_RECOVERY', harness.sessionB);
  finish(harness.sessionB);
  const result = await savingA;
  assert.equal(result.ok, false, 'the action must retain its starting recovery context');
  assert.deepEqual(harness.updates, []);
  assert.equal(harness.render().recoveryMode, true, 'rejecting A must not discard the newer valid B context');
});

test('exact recovery user/session completes; sign-in switch and restart cannot recover without a link', async () => {
  const harness = await providerHarness();
  assert.equal((await harness.render().completePasswordRecovery('synthetic-password', 'synthetic-password')).ok, false);
  harness.emit('PASSWORD_RECOVERY', { ...harness.sessionA, provider_token: 'synthetic-provider-access', provider_refresh_token: 'synthetic-provider-refresh' });
  assert.equal(harness.render().session.provider_token, undefined, 'provider credential must not reach React context');
  assert.equal(harness.render().session.provider_refresh_token, undefined);
  assert.equal((await harness.render().completePasswordRecovery('synthetic-password', 'synthetic-password')).ok, true);
  assert.deepEqual(harness.updates, ['fixture-a']);
  harness.emit('PASSWORD_RECOVERY', harness.sessionA);
  harness.emit('SIGNED_IN', harness.sessionB);
  assert.equal(harness.render().recoveryMode, false);
  assert.equal((await harness.render().completePasswordRecovery('synthetic-password', 'synthetic-password')).ok, false);
  assert.deepEqual(harness.updates, ['fixture-a']);
});
