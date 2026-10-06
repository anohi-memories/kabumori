// Common-account Phase 2 (H1/C1 corrective): X autopost enrollment.
// - the shared logic: strict answers (R5), session-bound transport and cancellation (R4);
// - the real ServiceEnrollmentGate, transpiled and driven through a hook runtime with dependency-tracked
//   effects and cleanups: A-click -> B-switch (R2), delayed A -> switch / sign-out (R4), same-user refresh;
// - source contracts: routing, X/OAuth separation, no direct writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

import * as enrollmentModule from '../src/domain/service-enrollment.ts';

const {
  createEnrollmentGate, createSessionBoundTransport, EnrollmentCancelledError, EnrollmentUnavailableError,
  parseServiceAnswer, reactivateServiceExplicitly, startServiceAutomatically,
} = enrollmentModule;

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(join(root, path), 'utf8');
// Code only: comments may explain what the code does not do.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');

// ---------------------------------------------------------------------------------------------
// R5: only the exact canonical answers are accepted.
const ACTIVE = { status: 'active', service: 'x_autopost', started: true, shared_account: false };

test('R5: the exact active answer is ready; every incomplete or wrong active answer fails closed', () => {
  assert.deepEqual(parseServiceAnswer('x_autopost', ACTIVE), { kind: 'ready', started: true, sharedAccountNotice: false });
  assert.deepEqual(parseServiceAnswer('x_autopost', { ...ACTIVE, shared_account: true }), { kind: 'ready', started: true, sharedAccountNotice: true });
  assert.deepEqual(parseServiceAnswer('x_autopost', { ...ACTIVE, started: false, shared_account: true }), { kind: 'ready', started: false, sharedAccountNotice: false });
  const unknown = { kind: 'blocked', reason: 'UNKNOWN' };
  const { started, ...withoutStarted } = ACTIVE;
  const { shared_account, ...withoutShared } = ACTIVE;
  for (const malformed of [
    withoutStarted, { ...ACTIVE, started: null }, { ...ACTIVE, started: 'true' }, { ...ACTIVE, started: 1 },
    withoutShared, { ...ACTIVE, shared_account: 'false' }, { ...ACTIVE, service: 'kabumori' }, { ...ACTIVE, service: undefined },
    { ...ACTIVE, extra: true }, { ...ACTIVE, status: 'ACTIVE' }, { status: 'active' }, null, [], 'active', 1,
    { status: 'reenroll_required', service: 'x_autopost' }, { status: 'reenroll_required', service: 'x_autopost', lifecycle_version: '3' },
    { status: 'reenroll_required', service: 'x_autopost', lifecycle_version: 0 }, { status: 'reenroll_required', service: 'kabumori', lifecycle_version: 3 },
    { status: 'blocked', reason: 'SOMETHING_NEW' }, { status: 'blocked' }, { status: 'not_registered', service: 'x_autopost' },
  ]) {
    assert.deepEqual(parseServiceAnswer('x_autopost', malformed), unknown, JSON.stringify(malformed));
  }
  assert.deepEqual(parseServiceAnswer('x_autopost', { status: 'reenroll_required', service: 'x_autopost', lifecycle_version: 3 }), { kind: 'reenroll_required', lifecycleVersion: 3 });
  assert.deepEqual(parseServiceAnswer('x_autopost', { status: 'lifecycle_changed', service: 'x_autopost', lifecycle_version: 4 }), { kind: 'reenroll_required', lifecycleVersion: 4 });
  assert.deepEqual(parseServiceAnswer('x_autopost', { status: 'blocked', reason: 'ACCOUNT_DELETION_IN_PROGRESS' }), { kind: 'blocked', reason: 'ACCOUNT_DELETION_IN_PROGRESS' });
});

// ---------------------------------------------------------------------------------------------
// A fake PostgREST endpoint: records every RPC with the token it carried; answers can be held.
function fakeServer(answer) {
  const requests = [];
  const held = [];
  const fetchImpl = (url, init) => {
    const fn = String(url).split('/rpc/')[1];
    const token = init.headers.Authorization.replace(/^Bearer /u, '');
    const entry = { fn, token, body: JSON.parse(init.body), signal: init.signal };
    requests.push(entry);
    const reply = answer(entry);
    const respond = (value) => ({ ok: value.ok ?? true, status: value.status ?? 200, json: async () => value.body });
    if (reply === 'hold') {
      return new Promise((resolve, reject) => {
        held.push({ entry, release: (value) => resolve(respond(value)) });
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return Promise.resolve(respond(reply));
  };
  return { requests, held, fetchImpl };
}

test('R4: the transport sends the token it was created with, to the exact RPC, and nothing once cancelled', async () => {
  const server = fakeServer(() => ({ body: ACTIVE }));
  const transport = createSessionBoundTransport({ url: 'https://fixture.supabase.co/', apiKey: 'sb_publishable_fixture', accessToken: 'token-A', fetch: server.fetchImpl });
  assert.deepEqual(await startServiceAutomatically(transport, 'x_autopost', new AbortController().signal), { kind: 'ready', started: true, sharedAccountNotice: false });
  assert.deepEqual(server.requests.map((r) => [r.fn, r.token, r.body]), [['start_x_autopost_service', 'token-A', {}]]);
  await reactivateServiceExplicitly(transport, 'x_autopost', 7, new AbortController().signal);
  assert.deepEqual(server.requests[1].body, { p_expected_lifecycle_version: 7 });
  assert.equal(server.requests[1].fn, 'reactivate_x_autopost_service');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(startServiceAutomatically(transport, 'x_autopost', aborted.signal), EnrollmentCancelledError);
  assert.equal(server.requests.length, 2, 'a cancelled request is never sent');
});

test('R4: transient failures are retryable, a removed login is blocked', async () => {
  const offline = createSessionBoundTransport({ url: 'https://f', apiKey: 'k', accessToken: 't', fetch: () => Promise.reject(new TypeError('Network request failed')) });
  await assert.rejects(startServiceAutomatically(offline, 'x_autopost', new AbortController().signal), EnrollmentUnavailableError);
  const gone = createSessionBoundTransport({ url: 'https://f', apiKey: 'k', accessToken: 't',
    fetch: async () => ({ ok: false, status: 403, json: async () => ({ code: '42501', message: 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND' }) }) });
  assert.deepEqual(await startServiceAutomatically(gone, 'x_autopost', new AbortController().signal), { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' });
  const server500 = createSessionBoundTransport({ url: 'https://f', apiKey: 'k', accessToken: 't', fetch: async () => ({ ok: false, status: 500, json: async () => { throw new Error('html'); } }) });
  await assert.rejects(startServiceAutomatically(server500, 'x_autopost', new AbortController().signal), EnrollmentUnavailableError);
});

test('R4: a pending request of A is cancelled when B starts or on sign-out, and never carries B\'s token', async () => {
  const server = fakeServer((entry) => (entry.token.startsWith('token-A') ? 'hold' : { body: ACTIVE }));
  const gate = createEnrollmentGate((context, signal) => startServiceAutomatically(
    createSessionBoundTransport({ url: 'https://f', apiKey: 'k', accessToken: context.accessToken, fetch: server.fetchImpl }), 'x_autopost', signal));
  const a = gate.ensure({ userId: 'user-A', accessToken: 'token-A' });
  await new Promise((r) => setImmediate(r));
  const b = gate.ensure({ userId: 'user-B', accessToken: 'token-B' });
  await assert.rejects(a, EnrollmentCancelledError);
  assert.equal((await b).kind, 'ready');
  assert.deepEqual(server.requests.map((r) => r.token), ['token-A', 'token-B'], 'A only ever used its own token');
  assert.ok(server.requests[0].signal.aborted);
  const c = gate.ensure({ userId: 'user-A', accessToken: 'token-A2' });
  await new Promise((r) => setImmediate(r));
  gate.reset(); // sign-out while pending
  await assert.rejects(c, EnrollmentCancelledError);
  assert.equal(server.requests.length, 3);
});

// ---------------------------------------------------------------------------------------------
// The real gate, transpiled, with a hook runtime that tracks effect dependencies and cleanups.
function depsEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

async function gateHarness(server) {
  const slots = [];
  let cursor = 0;
  let pending = [];
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[i];
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo(factory, deps) {
      const i = cursor++;
      if (slots[i] && depsEqual(slots[i].deps, deps)) return slots[i].value;
      slots[i] = { deps, value: factory() };
      return slots[i].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!slots[i] || !depsEqual(slots[i].deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps, cleanup: previous?.cleanup };
        pending.push({ i, effect });
      }
    },
  };
  let session = null;
  const modules = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    '@/constants/theme': { colors: {}, typography: {} },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/components/sign-out-button': { SignOutButton: 'SignOutButton' },
    '@/data/repository-selection': { selectDataSource: () => ({ kind: 'supabase' }) },
    '@/domain/service-enrollment': enrollmentModule,
    '@/lib/supabase': { getSupabaseConfig: () => ({ ok: true, config: { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' } }) },
    '@/providers/auth-provider': { useAuth: () => ({ session }) },
    '@/app/account-deletion': { __esModule: true, default: 'AccountDeletionScreen' },
  };
  const source = await read('src/features/service-enrollment/service-enrollment-gate.tsx');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: (name) => { assert.ok(Object.hasOwn(modules, name), `unexpected import ${name}`); return modules[name]; } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = server.fetchImpl;
  const CHILDREN = { type: 'APP' };
  let tree = null;
  function render() {
    cursor = 0;
    pending = [];
    tree = module.exports.ServiceEnrollmentGate({ children: CHILDREN });
    for (const { i, effect } of pending) {
      slots[i].cleanup?.();
      const cleanup = effect();
      slots[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
    return tree;
  }
  async function settle() {
    for (let round = 0; round < 5; round += 1) {
      await new Promise((r) => setImmediate(r));
      render();
    }
    return tree;
  }
  function find(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const child of node) { const hit = find(child, predicate); if (hit) return hit; } return null; }
    if (predicate(node)) return node;
    return find(node.props?.children, predicate);
  }
  return {
    CHILDREN,
    setSession(next) { session = next; },
    render, settle,
    isApp: () => tree === CHILDREN || find(tree, (n) => n === CHILDREN) !== null || tree?.props?.children === CHILDREN,
    button: (label) => find(tree, (n) => n.type === 'ActionButton' && n.props.label === label),
    unmount() { for (const slot of slots) if (slot && typeof slot.cleanup === 'function') slot.cleanup(); },
    restore() { globalThis.fetch = originalFetch; },
  };
}

const sessionOf = (user) => ({ access_token: `token-${user}`, user: { id: `user-${user}` } });
const ENDED = (version) => ({ body: { status: 'reenroll_required', service: 'x_autopost', lifecycle_version: version } });

test('R2: A clicks 「利用登録する」, then the session switches to B: no restart is ever sent for B', async () => {
  const server = fakeServer((entry) => (entry.fn === 'reactivate_x_autopost_service' ? 'hold' : ENDED(3)));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A'));
    await h.settle();
    const button = h.button('利用登録する');
    assert.ok(button, 'A sees the restart screen');
    button.props.onPress();
    button.props.onPress(); // a second tap sends nothing
    h.setSession(sessionOf('B'));
    await h.settle();
    const restarts = server.requests.filter((r) => r.fn === 'reactivate_x_autopost_service');
    assert.deepEqual(restarts.map((r) => [r.token, r.body]), [['token-A', { p_expected_lifecycle_version: 3 }]], 'exactly one restart, for A only');
    assert.ok(restarts[0].signal.aborted, 'A\'s pending restart was cancelled by the switch');
    assert.ok(!server.requests.some((r) => r.token === 'token-B' && r.fn !== 'start_x_autopost_service'), 'B only gets its automatic start');
    assert.ok(h.button('利用登録する'), 'B sees its own restart screen; nothing was restarted for B');
    assert.equal(h.isApp(), false);
  } finally { h.unmount(); h.restore(); }
});

test('R2 control: switching A -> B without a click sends no restart at all', async () => {
  const server = fakeServer(() => ENDED(3));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A'));
    await h.settle();
    h.setSession(sessionOf('B'));
    await h.settle();
    assert.equal(server.requests.filter((r) => r.fn === 'reactivate_x_autopost_service').length, 0);
  } finally { h.unmount(); h.restore(); }
});

test('R2: a click restarts exactly the clicking person, once, and opens the app for them', async () => {
  const server = fakeServer((entry) => (entry.fn === 'reactivate_x_autopost_service'
    ? { body: { status: 'active', service: 'x_autopost', started: true, shared_account: false } } : ENDED(5)));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A'));
    await h.settle();
    h.button('利用登録する').props.onPress();
    await h.settle();
    assert.deepEqual(server.requests.map((r) => [r.fn, r.token]), [['start_x_autopost_service', 'token-A'], ['reactivate_x_autopost_service', 'token-A']]);
    assert.equal(h.isApp(), true);
  } finally { h.unmount(); h.restore(); }
});

test('R4: delayed A start -> switch to B -> release A: no request with B\'s token for A, A cannot open the app for B', async () => {
  const server = fakeServer((entry) => (entry.token === 'token-A' ? 'hold' : ENDED(2)));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A'));
    await h.settle();
    h.setSession(sessionOf('B'));
    await h.settle();
    server.held[0]?.release({ body: ACTIVE });
    await h.settle();
    assert.deepEqual(server.requests.map((r) => r.token), ['token-A', 'token-B']);
    assert.ok(server.requests[0].signal.aborted);
    assert.equal(h.isApp(), false, 'B (ended) is not opened by A\'s late answer');
  } finally { h.unmount(); h.restore(); }
});

test('R4: sign-out (unmount) while A is pending cancels it and sends nothing more', async () => {
  const server = fakeServer(() => 'hold');
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A'));
    await h.settle();
    h.unmount();
    assert.equal(server.requests.length, 1);
    assert.ok(server.requests[0].signal.aborted);
  } finally { h.restore(); }
});

test('same person, refreshed token: one logical enrollment, no second start', async () => {
  const server = fakeServer(() => ({ body: ACTIVE }));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A'));
    await h.settle();
    assert.equal(h.isApp(), true);
    h.setSession({ access_token: 'token-A-refreshed', user: { id: 'user-A' } });
    await h.settle();
    assert.equal(server.requests.length, 1);
    assert.equal(h.isApp(), true);
  } finally { h.unmount(); h.restore(); }
});

test('malformed active answer keeps the app closed (R5 through the gate)', async () => {
  const server = fakeServer(() => ({ body: { status: 'active', service: 'x_autopost' } }));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A'));
    await h.settle();
    assert.equal(h.isApp(), false);
    assert.ok(h.button('再読み込み'), 'fails closed to the retryable UNKNOWN view');
  } finally { h.unmount(); h.restore(); }
});

// ---------------------------------------------------------------------------------------------
test('the X logic is the same reviewed logic as Kabumori\'s (only the 5-line header differs)', async () => {
  const x = await read('src/domain/service-enrollment.ts');
  const kabumori = await readFile(join(root, '../../src/lib/service-enrollment.ts'), 'utf8');
  const body = (text) => text.split('\n').slice(5).join('\n');
  assert.equal(body(x), body(kabumori));
});

test('enrollment only calls the reviewed X RPCs over the session-bound transport; no posting authorization, credentials or publish enablement', async () => {
  const gate = code(await read('src/features/service-enrollment/service-enrollment-gate.tsx'));
  const domain = code(await read('src/domain/service-enrollment.ts'));
  assert.match(gate, /startServiceAutomatically\(transportFor\(context\), 'x_autopost', signal\)/u);
  assert.match(gate, /reactivateServiceExplicitly\(transportFor\(context\), 'x_autopost', lifecycleVersion, signal\)/u);
  assert.doesNotMatch(gate, /from '@\/lib\/supabase';[\s\S]*\bsupabase\b\./u, 'no shared client in the gate');
  assert.doesNotMatch(gate, /\bsupabase\.(rpc|from)\(/u);
  for (const text of [gate, domain]) {
    assert.doesNotMatch(text, /functions\.invoke|x-oauth|oauth_state|publish_enabled|publish-setting|publishSetting|vault|brand_memberships|from\('brands'\)|social_accounts/iu);
    assert.doesNotMatch(text, /\.(insert|update|upsert|delete)\(/u, 'no direct client write');
    assert.doesNotMatch(text, /email/iu, 'no e-mail based matching or merge');
    assert.doesNotMatch(text, /console\.|AsyncStorage|SecureStore/u, 'the token is never logged or stored');
  }
  // The shared module knows both services' RPC names; the X gate only ever asks for 'x_autopost'.
  assert.doesNotMatch(gate, /'kabumori'|start_kabumori_service|reactivate_kabumori_service/u, 'X never enrolls the other app');
  assert.equal([...gate.matchAll(/'x_autopost'/gu)].length, 2, 'automatic start and explicit restart, both for x_autopost');
  const auth = await read('src/providers/auth-provider.tsx');
  assert.doesNotMatch(auth, /\.rpc\(|start_x_autopost_service/u, 'login itself still calls no RPC');
});

test('routing: auth, then service enrollment, then data and onboarding; mock preview is not gated; sign-out and deletion stay reachable', async () => {
  const layout = await read('src/app/_layout.tsx');
  const auth = layout.indexOf('if (!session) return <AuthScreen />');
  const recovery = layout.indexOf('if (recoveryMode) return <NewPasswordScreen />');
  const enrollment = layout.indexOf('<ServiceEnrollmentGate>');
  const data = layout.indexOf('<DataProvider>');
  const onboarding = layout.indexOf('<OnboardingGate>');
  assert.ok(auth > -1 && recovery > auth && enrollment > recovery && data > enrollment && onboarding > data);
  assert.match(layout, /<\/DataProvider><\/ServiceEnrollmentGate>/u);
  const gate = await read('src/features/service-enrollment/service-enrollment-gate.tsx');
  assert.match(gate, /if \(selection\.kind === 'mock'\) return <>\{children\}<\/>;/u);
  assert.match(gate, /<SignOutButton \/>/u);
  assert.match(gate, /<AccountDeletionScreen \/>/u);
  assert.match(gate, /useEffect\(\(\) => \(\) => enrollment\.reset\(\), \[\]\)/u, 'leaving the signed-in tree cancels and forgets');
});
