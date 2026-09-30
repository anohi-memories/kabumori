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
import * as deletion from '../src/domain/account-deletion.ts';
import * as onboarding from '../src/domain/onboarding.ts';
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

async function providerHarness({ fetchImpl = null } = {}) {
  const slots = []; let cursor = 0, first = true, subscriber;
  const effects = [];
  const sessionA = session('fixture-a', 'session-a'), sessionB = session('fixture-b', 'session-b');
  let currentSession = null, getSessionImpl = async () => ({ data: { session: currentSession }, error: null });
  const updates = [], signOuts = [], removed = [];
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
    signOut: async (options) => { signOuts.push(options ?? null); currentSession = null; subscriber('SIGNED_OUT', null); return { error: null }; },
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
    '@/domain/auth-flows': flows, '@/domain/recovery-binding': recovery, '@/domain/auth-release-readiness': release, '@/domain/account-deletion': deletion, '@/domain/onboarding': onboarding,
    '@react-native-async-storage/async-storage': { __esModule: true, default: { removeItem: async (key) => { removed.push(key); } } },
  };
  const source = await readFile(new URL('../src/providers/auth-provider.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module, exports: module.exports, process: { env: {} },
    require: (name) => { assert.ok(Object.hasOwn(modules, name), `unexpected import ${name}`); return modules[name]; },
    fetch: async (url, init) => (String(url).endsWith('/auth/v1/settings') || !fetchImpl
      ? { ok: true, json: async () => ({ external: { email: true }, disable_signup: false }) }
      : fetchImpl(String(url), init)),
  }, { filename: 'auth-provider.tsx' });
  const render = () => { cursor = 0; return module.exports.AuthProvider({ children: null }).props.value; };
  render(); first = false; effects.forEach((effect) => effect());
  await new Promise((resolve) => setImmediate(resolve));
  const emit = (event, nextSession) => { currentSession = nextSession; subscriber(event, nextSession); };
  return { render, emit, updates, signOuts, removed, sessionA, sessionB, deferSession: () => {
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

// Objects created inside the vm sandbox belong to another realm.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('account deletion: success only on the server\'s explicit confirmation; pinned to the confirmed user + session', async () => {
  const requests = [];
  const uuid = '11111111-1111-4111-8111-111111111111';
  const answers = [
    { status: 200, body: { ok: true, scope: 'social_and_login', state: 'none', apple_supported: true, apple_code_required: false } },
    { status: 500, body: { ok: false, error: 'X_REVOKE_FAILED' } },
    { status: 200, body: {} },
    { status: 409, body: { ok: false, error: 'DELETION_OPERATOR_REQUIRED' } },
    null,
    { status: 200, body: { ok: true, login_deleted: true } },
  ];
  const harness = await providerHarness({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    const answer = answers.shift();
    if (!answer) throw new Error('network down');
    return { status: answer.status, json: async () => answer.body };
  } });
  const mine = { ...session(uuid, 'session-u'), user: { id: uuid } };
  const context = { userId: uuid, sessionId: 'session-u' };
  harness.emit('SIGNED_IN', mine);
  assert.deepEqual(plain(await harness.render().previewDeletion()), { ok: true, scope: 'social_and_login', state: 'none', appleSupported: true, appleCodeRequired: false });
  for (const expected of ['X_REVOKE_FAILED', 'FAILED', 'DELETION_OPERATOR_REQUIRED', 'FAILED']) {
    assert.deepEqual(plain(await harness.render().deleteAccount({ context, scope: 'social_and_login' })), { ok: false, code: expected });
    assert.deepEqual(harness.signOuts, [], 'no local sign-out without a confirmed deletion');
  }
  // H2 client-context issue: another user, or a new session of the same user, after confirmation.
  const sent = requests.length;
  harness.emit('SIGNED_IN', harness.sessionB);
  assert.deepEqual(plain(await harness.render().deleteAccount({ context, scope: 'social_and_login' })), { ok: false, code: 'SESSION_CHANGED' });
  harness.emit('SIGNED_IN', { ...session(uuid, 'session-u2'), user: { id: uuid } });
  assert.deepEqual(plain(await harness.render().deleteAccount({ context, scope: 'social_and_login' })), { ok: false, code: 'SESSION_CHANGED' });
  assert.equal(requests.length, sent, 'no request is made for a switched session');
  harness.emit('SIGNED_IN', mine);
  assert.equal(harness.render().deletionNotice, null, 'no notice before a confirmed deletion (failures never set one)');
  assert.deepEqual(plain(await harness.render().deleteAccount({ context, scope: 'social_and_login', appleAuthorizationCode: 'apple-code' })), { ok: true, loginDeleted: true, loginKept: false });
  // D2: the sign-in screen states the result (web has no Alert), and it can be dismissed.
  assert.equal(harness.render().deletionNotice, 'アカウントを削除しました。ご利用ありがとうございました。');
  harness.render().dismissDeletionNotice();
  assert.equal(harness.render().deletionNotice, null);
  assert.deepEqual(plain(harness.signOuts), [{ scope: 'local' }], 'local sign-out only after the server confirmed');
  assert.deepEqual(harness.removed, [`social-mobile:onboarding:v1:${uuid}`]);
  assert.equal(harness.render().session, null);
  for (const { url, init } of requests) {
    assert.equal(url, 'https://fixture.supabase.co/functions/v1/social-mobile-account-delete');
    assert.equal(init.headers.Authorization, `Bearer ${mine.access_token}`);
  }
  assert.deepEqual(JSON.parse(requests[0].init.body), { action: 'preview' });
  assert.deepEqual(JSON.parse(requests[1].init.body), { action: 'delete', confirmation: 'DELETE_MY_ACCOUNT', expected_scope: 'social_and_login' });
  assert.deepEqual(JSON.parse(requests.at(-1).init.body), { action: 'delete', confirmation: 'DELETE_MY_ACCOUNT', expected_scope: 'social_and_login', apple_authorization_code: 'apple-code' });
});

test('account deletion is setup-pending unless the build enables it', async () => {
  const harness = await providerHarness();
  assert.equal(harness.render().accountDeletion, 'setup_pending');
});

test('D2: a social-only deletion states that the login and Kabumori data remain; a new sign-in clears the notice', async () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const harness = await providerHarness({ fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, login_deleted: false }) }) });
  harness.emit('SIGNED_IN', { ...session(uuid, 'session-u'), user: { id: uuid } });
  const result = await harness.render().deleteAccount({ context: { userId: uuid, sessionId: 'session-u' }, scope: 'social_only' });
  assert.equal(result.ok, true);
  assert.match(harness.render().deletionNotice, /このアプリのデータを削除しました。ログイン用アカウントと「かぶモリ」のデータは残っています/u);
  harness.emit('SIGNED_IN', harness.sessionB);
  assert.equal(harness.render().deletionNotice, null, 'the next signed-in session ends the notice');
});
