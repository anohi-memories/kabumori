// Common-account Phase 2 (H1/C1 corrective): X autopost enrollment.
// - the shared logic: strict answers (R5), session-bound transport and cancellation (R4);
// - the real ServiceEnrollmentGate, transpiled and driven through a hook runtime with dependency-tracked
//   effects and cleanups: A-click -> B-switch (R2), delayed A -> switch / sign-out (R4), same-user refresh,
//   a new login of the same person never inheriting the old login's restart or answer (S1), and queued
//   automatic work that is cancelled before it is sent (S2);
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
  loginSessionIdOf, parseServiceAnswer, reactivateServiceExplicitly, startServiceAutomatically,
} = enrollmentModule;

// Synthetic unsigned access tokens with only the claims the client reads (sub, session_id): a person's
// login N, and the same login's token after a refresh. Built at run time; not credentials.
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const loginUuid = (user, login) => `00000000-0000-4000-8000-${String(user.charCodeAt(0)).padStart(6, '0')}${String(login).padStart(6, '0')}`;
const tokenOf = (user, login = 1, refresh = 0) => `${b64url({ alg: 'none' })}.${b64url({ sub: `user-${user}`, session_id: loginUuid(user, login), iat: refresh })}.unsigned`;
const sessionOf = (user, login = 1, refresh = 0) => ({ access_token: tokenOf(user, login, refresh), user: { id: `user-${user}` } });
const contextOf = (user, login = 1, refresh = 0) => ({ userId: `user-${user}`, accessToken: tokenOf(user, login, refresh) });
const flush = () => new Promise((r) => setImmediate(r));

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
  const server = fakeServer((entry) => (entry.token === tokenOf('B') ? { body: ACTIVE } : 'hold'));
  const gate = createEnrollmentGate((context, signal) => startServiceAutomatically(
    createSessionBoundTransport({ url: 'https://f', apiKey: 'k', accessToken: context.accessToken, fetch: server.fetchImpl }), 'x_autopost', signal));
  const a = gate.ensure(contextOf('A'));
  await flush();
  const b = gate.ensure(contextOf('B'));
  await assert.rejects(a, EnrollmentCancelledError);
  assert.equal((await b).kind, 'ready');
  assert.deepEqual(server.requests.map((r) => r.token), [tokenOf('A'), tokenOf('B')], 'A only ever used its own token');
  assert.ok(server.requests[0].signal.aborted);
  const c = gate.ensure(contextOf('A', 2));
  await flush();
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
    hasSignOut: () => find(tree, (n) => n.type === 'SignOutButton') !== null,
    unmount() { for (const slot of slots) if (slot && typeof slot.cleanup === 'function') slot.cleanup(); },
    /** After unmount(): the next render mounts a fresh gate (the module's shared gate survives, as in the app). */
    clear() { slots.length = 0; tree = null; },
    restore() { globalThis.fetch = originalFetch; },
  };
}

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
    assert.deepEqual(restarts.map((r) => [r.token, r.body]), [[tokenOf('A'), { p_expected_lifecycle_version: 3 }]], 'exactly one restart, for A only');
    assert.ok(restarts[0].signal.aborted, 'A\'s pending restart was cancelled by the switch');
    assert.ok(!server.requests.some((r) => r.token === tokenOf('B') && r.fn !== 'start_x_autopost_service'), 'B only gets its automatic start');
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
    assert.deepEqual(server.requests.map((r) => [r.fn, r.token]), [['start_x_autopost_service', tokenOf('A')], ['reactivate_x_autopost_service', tokenOf('A')]]);
    assert.equal(h.isApp(), true);
  } finally { h.unmount(); h.restore(); }
});

test('R4: delayed A start -> switch to B -> release A: no request with B\'s token for A, A cannot open the app for B', async () => {
  const server = fakeServer((entry) => (entry.token === tokenOf('A') ? 'hold' : ENDED(2)));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A'));
    await h.settle();
    h.setSession(sessionOf('B'));
    await h.settle();
    server.held[0]?.release({ body: ACTIVE });
    await h.settle();
    assert.deepEqual(server.requests.map((r) => r.token), [tokenOf('A'), tokenOf('B')]);
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
    h.setSession(sessionOf('A', 1, 1)); // the same login, refreshed token
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
// S1: requests, answers and the open state belong to one login (the token's session id), not merely to the person.
test('S1: the login is the token\'s session id, only for a well-formed token of exactly this person', () => {
  assert.equal(loginSessionIdOf('user-A', tokenOf('A')), loginUuid('A', 1));
  assert.equal(loginSessionIdOf('user-A', tokenOf('A', 1, 5)), loginUuid('A', 1), 'a refreshed token keeps its login');
  assert.equal(loginSessionIdOf('user-A', tokenOf('A', 2)), loginUuid('A', 2), 'a new sign-in is a new login');
  const claims = (payload) => `${b64url({ alg: 'none' })}.${b64url(payload)}.unsigned`;
  for (const token of [
    'token-A', '', tokenOf('A').split('.').slice(0, 2).join('.'), `${tokenOf('A')}.extra`,
    tokenOf('B'), claims({ sub: 'user-A' }), claims({ sub: 'user-A', session_id: null }), claims({ sub: 'user-A', session_id: 7 }),
    claims({ sub: 'user-A', session_id: 'not-a-uuid' }), claims({ sub: 'user-A', session_id: `${loginUuid('A', 1)}0` }),
    claims(['user-A']), claims('user-A'), `${b64url({})}.%%%.unsigned`, `${b64url({})}.${b64url({ sub: 'user-A', session_id: loginUuid('A', 1) })}=.unsigned`,
  ]) assert.equal(loginSessionIdOf('user-A', token), null, token);
  assert.equal(loginSessionIdOf('user-A', claims({ sub: 'user-A', session_id: loginUuid('A', 1), user_metadata: { name: '株森 太郎' } })), loginUuid('A', 1));
});

test('S1: the shared gate shares a pending restart with its own refreshed token only; another login of the same person aborts it', async () => {
  const server = fakeServer((entry) => (entry.fn.startsWith('reactivate') ? 'hold' : { body: ACTIVE }));
  const transport = (context) => createSessionBoundTransport({ url: 'https://f', apiKey: 'k', accessToken: context.accessToken, fetch: server.fetchImpl });
  const gate = createEnrollmentGate((context, signal) => startServiceAutomatically(transport(context), 'x_autopost', signal));
  const explicit = gate.explicit(contextOf('A', 1), (context, signal) => reactivateServiceExplicitly(transport(context), 'x_autopost', 3, signal));
  await flush();
  assert.equal(gate.ensure(contextOf('A', 1, 1)), explicit, 'the same login (refreshed token) shares its own restart');
  const second = gate.ensure(contextOf('A', 2));
  assert.notEqual(second, explicit, 'a new login never adopts the old restart');
  await assert.rejects(explicit, EnrollmentCancelledError);
  assert.ok(server.requests[0].signal.aborted);
  assert.equal((await second).kind, 'ready');
  assert.deepEqual(server.requests.map((r) => [r.fn, r.token]), [['reactivate_x_autopost_service', tokenOf('A', 1)], ['start_x_autopost_service', tokenOf('A', 2)]]);
  assert.deepEqual(await gate.ensure({ userId: 'user-A', accessToken: 'token-A' }), { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' }, 'an unidentified login is never sent');
  assert.equal(server.requests.length, 2);
  gate.reset();
});

for (const [label, arrive] of [
  ['a new sign-in A2 (gate stays mounted)', (h, A2) => { h.setSession(A2); }],
  ['sign-out, then a fresh login A2', (h, A2) => { h.setSession(null); h.unmount(); h.clear(); h.setSession(A2); }],
  ['a recovery link (new login A2; the gate leaves for the password screen and comes back)', (h, A2) => { h.unmount(); h.clear(); h.setSession(A2); }],
]) {
  test(`S1: A1 clicks 「利用登録する」, ${label} before the answer: A1's answer never opens the app for A2`, async () => {
    let holdRestart = true;
    const server = fakeServer((entry) => (entry.fn === 'reactivate_x_autopost_service' ? (holdRestart ? 'hold' : { body: ACTIVE }) : ENDED(3)));
    const h = await gateHarness(server);
    try {
      h.setSession(sessionOf('A', 1));
      await h.settle();
      h.button('利用登録する').props.onPress();
      await h.settle();
      const restart = server.requests.find((r) => r.fn === 'reactivate_x_autopost_service');
      assert.equal(restart.token, tokenOf('A', 1));
      arrive(h, sessionOf('A', 2));
      await h.settle();
      assert.ok(restart.signal.aborted, 'the old login\'s pending restart was cancelled');
      server.held[0].release({ body: ACTIVE }); // A1's answer arrives anyway
      await h.settle();
      assert.equal(h.isApp(), false, 'A1\'s answer does not open the app for A2');
      assert.ok(h.button('利用登録する'), 'A2 is asked itself');
      assert.deepEqual(server.requests.map((r) => [r.fn, r.token]), [
        ['start_x_autopost_service', tokenOf('A', 1)], ['reactivate_x_autopost_service', tokenOf('A', 1)], ['start_x_autopost_service', tokenOf('A', 2)]]);

      // A2's own confirmation: sent once, with A2's token, and only then open.
      holdRestart = false;
      h.button('利用登録する').props.onPress();
      await h.settle();
      assert.deepEqual(server.requests.filter((r) => r.fn === 'reactivate_x_autopost_service').map((r) => r.token), [tokenOf('A', 1), tokenOf('A', 2)]);
      assert.equal(h.isApp(), true);
    } finally { h.unmount(); h.restore(); }
  });
}

test('S1: A1\'s answer landing in the same turn as the new login A2 never opens the app for A2', async () => {
  const server = fakeServer((entry) => (entry.fn === 'reactivate_x_autopost_service' ? 'hold' : ENDED(3)));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A', 1));
    await h.settle();
    h.button('利用登録する').props.onPress();
    await h.settle();
    h.setSession(sessionOf('A', 2));
    h.render(); // A2 committed; its automatic start is still queued
    server.held[0].release({ body: ACTIVE });
    await h.settle();
    assert.equal(h.isApp(), false);
    assert.ok(h.button('利用登録する'), 'A2 is asked itself');
  } finally { h.unmount(); h.restore(); }
});

test('S1: the app opened for login A1 closes for a new login A2 of the same person until A2\'s own answer', async () => {
  const server = fakeServer((entry) => (entry.token === tokenOf('A', 2) ? 'hold' : { body: ACTIVE }));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A', 1));
    await h.settle();
    assert.equal(h.isApp(), true);
    h.setSession(sessionOf('A', 2));
    await h.settle();
    assert.equal(h.isApp(), false, 'A1\'s open state is not A2\'s');
    server.held[0].release({ body: { ...ACTIVE, started: false } });
    await h.settle();
    assert.equal(h.isApp(), true, 'A2 opens on its own answer');
    h.setSession(sessionOf('A', 2, 1));
    await h.settle();
    assert.equal(h.isApp(), true, 'a refresh of A2 keeps it open');
    assert.deepEqual(server.requests.map((r) => r.token), [tokenOf('A', 1), tokenOf('A', 2)], 'no request for the refresh');
  } finally { h.unmount(); h.restore(); }
});

test('S1 control: a refreshed token of the same login keeps the click\'s own pending restart and opens on its answer', async () => {
  const server = fakeServer((entry) => (entry.fn === 'reactivate_x_autopost_service' ? 'hold' : ENDED(3)));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A', 1));
    await h.settle();
    h.button('利用登録する').props.onPress();
    await h.settle();
    h.setSession(sessionOf('A', 1, 1));
    await h.settle();
    const restart = server.requests.find((r) => r.fn === 'reactivate_x_autopost_service');
    assert.equal(restart.signal.aborted, false, 'the same login does not cancel its own restart');
    server.held[0].release({ body: ACTIVE });
    await h.settle();
    assert.equal(h.isApp(), true);
    assert.equal(server.requests.length, 2, 'one automatic start and the one restart; no new start for the refreshed token');
  } finally { h.unmount(); h.restore(); }
});

test('S1: a session whose login cannot be identified sends nothing and stays closed with sign-out reachable', async () => {
  const server = fakeServer(() => ({ body: ACTIVE }));
  const h = await gateHarness(server);
  try {
    h.setSession({ access_token: 'token-A', user: { id: 'user-A' } });
    await h.settle();
    assert.equal(server.requests.length, 0);
    assert.equal(h.isApp(), false);
    assert.ok(h.hasSignOut(), 'the person can sign out and sign in again');
  } finally { h.unmount(); h.restore(); }
});

// ---------------------------------------------------------------------------------------------
// S2: queued automatic work is checked before anything is sent.
test('S2: unmount (sign-out / recovery) before the queued task runs: zero requests, and nothing is left behind', async () => {
  const server = fakeServer(() => ({ body: ACTIVE }));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A'));
    h.render(); // committed: the automatic start is queued
    h.unmount();
    await flush();
    await flush();
    assert.equal(server.requests.length, 0, 'the queued task sent nothing');
    // A later mount of the same login is not served by anything the obsolete task could have created.
    h.clear();
    await h.settle();
    assert.equal(server.requests.length, 1);
    assert.equal(h.isApp(), true);
  } finally { h.unmount(); h.restore(); }
});

test('S2: sign-out before the queued task runs (session gone while mounted): zero requests', async () => {
  const server = fakeServer(() => ({ body: ACTIVE }));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A'));
    h.render();
    h.setSession(null);
    h.render();
    await h.settle();
    assert.equal(server.requests.length, 0);
  } finally { h.unmount(); h.restore(); }
});

for (const [label, next] of [['another person', sessionOf('B')], ['another login of the same person', sessionOf('A', 2)]]) {
  test(`S2: superseded by ${label} before the queued task runs: the obsolete task sends nothing`, async () => {
    const server = fakeServer(() => ({ body: ACTIVE }));
    const h = await gateHarness(server);
    try {
      h.setSession(sessionOf('A', 1));
      h.render();
      h.setSession(next);
      h.render();
      await h.settle();
      assert.deepEqual(server.requests.map((r) => r.token), [next.access_token], 'only the current login was sent');
      assert.equal(h.isApp(), true);
    } finally { h.unmount(); h.restore(); }
  });
}

test('S2 control: a normal mount sends exactly one automatic start and opens', async () => {
  const server = fakeServer(() => ({ body: ACTIVE }));
  const h = await gateHarness(server);
  try {
    h.setSession(sessionOf('A'));
    await h.settle();
    await h.settle();
    assert.deepEqual(server.requests.map((r) => [r.fn, r.token]), [['start_x_autopost_service', tokenOf('A')]]);
    assert.equal(h.isApp(), true);
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
