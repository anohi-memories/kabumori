// POSTONA service end: the ServiceEnrollmentGate refreshes on the person's lifecycle epoch (F5, G1; F4/F5 contract
// "design B", docs/postona-service-end-gate-g1-g2-design.md).
//
// The REAL gate is transpiled and driven through a hook runtime (tests/support/enrollment-harness.mjs). The gate's one
// lifecycle input -- `useLifecycleEpoch(userId)` -- is replaced here by a TYPED per-person counter
// (tests/support/lifecycle-signal.ts); the seam itself is connected to F4's provider (the joint F4+F5 assembly is
// proven with the real provider in tests/service-end-g1-g2-integration.test.mjs). What these tests pin:
//   * a signal for the person signed in discards the decided answer in the very next render (the app is closed
//     before any request), asks the server again with the CURRENT login's token, and only the server's answer opens;
//   * a signal for anybody else, a refresh of the same login, sign-out and a new person change nothing / clear it;
//   * late answers of an old epoch, person or login never restore `ready`;
//   * a failed ask stays closed with a manual retry; a refresh never restarts an ended service;
//   * nothing about another service (かぶモリ) is read or written; the signal is never produced by the gate.
// No network, no renderer, no real Auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { fakeServer, flush, gateHarness, sessionOf, tokenOf } from './support/enrollment-harness.mjs';
import { createLifecycleSignal } from './support/lifecycle-signal.ts';
import vm from 'node:vm';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(join(root, path), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');

const ACTIVE = { body: { status: 'active', service: 'x_autopost', started: false, shared_account: false } };
const ENDED = (version) => ({ body: { status: 'reenroll_required', service: 'x_autopost', lifecycle_version: version } });
const FAIL_500 = { ok: false, status: 500, body: { message: 'boom' } };
const ONLY_X_RPCS = new Set(['start_x_autopost_service', 'reactivate_x_autopost_service']);

/** A gate for person A (login 1), open on `active`; returns what the tests drive. */
async function openGate(answer, options = {}) {
  const server = fakeServer(answer);
  const lifecycle = createLifecycleSignal();
  const h = await gateHarness(server, { lifecycle, ...options });
  h.setSession(sessionOf('A', 1));
  await h.settle();
  assert.equal(h.isApp(), true, 'precondition: the app is open for A');
  assert.equal(server.requests.length, 1, 'precondition: one automatic start');
  return { server, lifecycle, h, done() { h.unmount(); h.restore(); } };
}

// ---------------------------------------------------------------------------------------------------- the refresh

test('G1: after A\'s end the signal closes the app in the very next render, then the server\'s answer decides (ended -> closed, re-enroll offered)', async () => {
  let ended = false;
  const { server, lifecycle, h, done } = await openGate(() => (ended ? ENDED(4) : ACTIVE));
  try {
    ended = true;
    lifecycle.bump('user-A');
    h.render();
    assert.equal(h.isApp(), false, 'fail closed at once: the old `ready` is discarded before anything is asked');
    assert.equal(server.requests.length, 1, 'nothing was sent in that render');
    await h.settle();
    assert.equal(server.requests.length, 2, 'exactly one server-authenticated re-ask');
    assert.deepEqual([server.requests[1].fn, server.requests[1].token], ['start_x_autopost_service', tokenOf('A', 1)], 'the automatic start with the CURRENT login\'s token');
    assert.equal(h.isApp(), false, 'the server says ended: the app stays closed');
    assert.ok(h.button('利用登録する'), 'the person is offered the re-enrollment screen');
    assert.equal(server.requests.filter((r) => r.fn === 'reactivate_x_autopost_service').length, 0, 'a refresh never restarts an ended service');
  } finally { done(); }
});

test('G1: while the re-ask is pending the app is not usable; only an `active` answer opens it again, and the signal alone never does', async () => {
  let hold = false;
  const { server, lifecycle, h, done } = await openGate(() => (hold ? 'hold' : ACTIVE));
  try {
    hold = true;
    lifecycle.bump('user-A');
    await h.settle();
    assert.equal(server.held.length, 1, 'the re-ask is in flight');
    assert.equal(h.isApp(), false, 'closed until the server answers');
    await h.settle();
    assert.equal(h.isApp(), false, 'still closed: waiting is not an answer');
    server.held[0].release(ACTIVE);
    await h.settle();
    assert.equal(h.isApp(), true, 'the server\'s `active` answer opens it');
    assert.equal(server.requests.length, 2);
  } finally { done(); }
});

test('G1: any change of the epoch re-asks, in either direction, once per change', async () => {
  const { server, lifecycle, h, done } = await openGate(() => ACTIVE);
  try {
    lifecycle.bump('user-A'); await h.settle();
    lifecycle.bump('user-A'); await h.settle();
    assert.equal(server.requests.length, 3);
    lifecycle.set('user-A', 0); await h.settle();   // a provider that restarted or went backwards is still a different question
    assert.equal(server.requests.length, 4);
    await h.settle(); await h.settle();
    assert.equal(server.requests.length, 4, 'an unchanged epoch asks nothing more, however often the gate renders');
    assert.equal(h.isApp(), true);
  } finally { done(); }
});

test('G1: two signals before the first re-ask answers: only the latest epoch decides, the stale answer cannot open the app', async () => {
  let mode = 'active';
  const { server, lifecycle, h, done } = await openGate(() => (mode === 'hold' ? 'hold' : mode === 'ended' ? ENDED(5) : ACTIVE));
  try {
    mode = 'hold';
    lifecycle.bump('user-A'); await h.settle();       // epoch 1 asks (held)
    lifecycle.bump('user-A'); await h.settle();       // epoch 2 asks (held); epoch 1's request is cancelled
    assert.equal(server.held.length, 2);
    assert.equal(server.held[0].entry.signal.aborted, true, 'the older question was withdrawn');
    server.held[0].release(ACTIVE); await h.settle();   // the older question answers `active` anyway
    assert.equal(h.isApp(), false, 'a stale answer never restores ready');
    server.held[1].release(ENDED(5)); await h.settle();
    assert.equal(h.isApp(), false);
    assert.ok(h.button('利用登録する'));
  } finally { done(); }
});

test('G1: an answer that arrives AFTER its request was cancelled (a transport that ignores abort) is dropped', async () => {
  // a fetch that never rejects on abort and answers later: the late `active` of the old epoch must not open the app
  const requests = []; const releases = [];
  const fetchImpl = (url, init) => {
    const fn = String(url).split('/rpc/')[1];
    requests.push({ fn, token: init.headers.Authorization.replace(/^Bearer /u, ''), signal: init.signal });
    const wait = requests.length >= 2 && requests.length <= 3;
    const respond = (value) => ({ ok: true, status: 200, json: async () => value });
    if (!wait) return Promise.resolve(respond(ACTIVE.body));
    return new Promise((resolveFetch) => releases.push((value) => resolveFetch(respond(value))));
  };
  const lifecycle = createLifecycleSignal();
  const h = await gateHarness({ fetchImpl, requests }, { lifecycle });
  try {
    h.setSession(sessionOf('A', 1)); await h.settle();
    assert.equal(h.isApp(), true);
    lifecycle.bump('user-A'); await h.settle();        // request 2 (held)
    lifecycle.bump('user-A'); await h.settle();        // request 3 (held), request 2 cancelled
    releases[0](ACTIVE.body); await h.settle();          // the cancelled request 2 answers `active` late
    assert.equal(h.isApp(), false, 'the late answer of an old epoch is ignored');
    releases[1](ENDED(2).body); await h.settle();
    assert.equal(h.isApp(), false);
    assert.ok(h.button('利用登録する'));
  } finally { h.unmount(); h.restore(); }
});

// ------------------------------------------------------------------------------- who the signal is for

test('G1 control: a signal for another person sends nothing and changes nothing; a token refresh of the same login is not a signal', async () => {
  const { server, lifecycle, h, done } = await openGate(() => ACTIVE);
  try {
    lifecycle.bump('user-B'); await h.settle();
    lifecycle.bump('user-C'); await h.settle();
    assert.equal(server.requests.length, 1); assert.equal(h.isApp(), true);
    h.setSession(sessionOf('A', 1, 1)); await h.settle();
    assert.equal(server.requests.length, 1, 'a refresh of the same login re-asks nothing');
    assert.equal(h.isApp(), true);
  } finally { done(); }
});

test('G2/S1: the same person\'s NEW login together with a signal: one ask with the NEW login\'s token, closed until its own answer', async () => {
  const { server, lifecycle, h, done } = await openGate((entry) => (entry.token === tokenOf('A', 2) ? 'hold' : ACTIVE));
  try {
    h.setSession(sessionOf('A', 2));
    lifecycle.bump('user-A');
    await h.settle();
    assert.equal(h.isApp(), false, 'A1\'s open state is not A2\'s');
    assert.deepEqual(server.requests.map((r) => r.token), [tokenOf('A', 1), tokenOf('A', 2)], 'the re-ask never uses A1\'s token');
    assert.equal(server.requests.length, 2, 'one ask for the pair (new login, new epoch)');
    server.held[0].release(ENDED(6)); await h.settle();
    assert.equal(h.isApp(), false);
    assert.ok(h.button('利用登録する'));
  } finally { done(); }
});

test('G1: a session that rotates while the old epoch\'s ask is pending: the old login\'s answer cannot open the app for the new login', async () => {
  let holdA1 = false;
  const { server, lifecycle, h, done } = await openGate((entry) => (holdA1 && entry.token === tokenOf('A', 1) ? 'hold' : ACTIVE));
  try {
    holdA1 = true;
    lifecycle.bump('user-A'); await h.settle();           // A1 asks at epoch 1 (held)
    assert.equal(server.held.length, 1);
    h.setSession(sessionOf('A', 2)); await h.settle();    // re-authentication: A2 asks at epoch 1
    assert.equal(h.isApp(), true, 'A2 got its own `active` answer');
    server.held[0].release(ENDED(7)); await h.settle();   // A1's late, different answer
    assert.equal(h.isApp(), true, 'A1\'s late answer changes nothing for A2');
  } finally { done(); }
});

test('G1: sign-out clears the decision; another person on the same device inherits nothing; the first person asks afresh when back', async () => {
  const { server, lifecycle, h, done } = await openGate((entry) => (entry.token === tokenOf('B', 1) ? 'hold' : ACTIVE));
  try {
    lifecycle.bump('user-A'); await h.settle();
    assert.equal(h.isApp(), true);
    h.unmount(); h.clear(); h.setSession(null);           // sign-out: the signed-in tree is gone
    await h.settle();
    assert.equal(h.isApp(), false);
    h.setSession(sessionOf('B', 1)); await h.settle();
    assert.equal(h.isApp(), false, 'B is closed until B\'s own answer; A\'s ready and A\'s epoch mean nothing');
    assert.equal(server.requests.at(-1).token, tokenOf('B', 1));
    server.held[0].release(ACTIVE); await h.settle();
    assert.equal(h.isApp(), true);
    h.unmount(); h.clear(); h.setSession(null); await h.settle();
    h.setSession(sessionOf('A', 3)); await h.settle();
    assert.equal(server.requests.at(-1).token, tokenOf('A', 3), 'A asks afresh with the new login\'s token');
    assert.equal(lifecycle.epochOf('user-A'), 1);
  } finally { done(); }
});

// ----------------------------------------------------------------------------------------- failure and retry

test('G1: a failed re-ask (offline, HTTP 500) keeps the app closed with a manual retry, and nothing is retried by itself', async () => {
  for (const failure of ['offline', FAIL_500]) {
    let mode = 'ok';
    const { server, lifecycle, h, done } = await openGate(() => (mode === 'ok' ? ACTIVE : failure));
    try {
      mode = 'down';
      lifecycle.bump('user-A'); await h.settle(); await h.settle();
      assert.equal(h.isApp(), false, 'a failed ask never leaves the old ready in place');
      const retry = h.button('再読み込み');
      assert.ok(retry, 'the person can retry by hand');
      const before = server.requests.length;
      await flush(); await h.settle();
      assert.equal(server.requests.length, before, 'no automatic retry loop');
      mode = 'ok';
      retry.props.onPress(); await h.settle();
      assert.equal(h.isApp(), true, 'the manual retry asks again and the server\'s answer opens it');
      assert.equal(server.requests.length, before + 1);
    } finally { done(); }
  }
});

test('G1: a failed re-ask for epoch N is not rescued by an old `ready` of epoch N-1, even when the epoch changes again later', async () => {
  let mode = 'ok';
  const { server, lifecycle, h, done } = await openGate(() => (mode === 'ok' ? ACTIVE : FAIL_500));
  try {
    mode = 'down';
    lifecycle.bump('user-A'); await h.settle();
    assert.equal(h.isApp(), false);
    lifecycle.bump('user-A'); await h.settle();
    assert.equal(h.isApp(), false, 'a second failed ask is still closed');
    assert.ok(h.button('再読み込み'));
    assert.ok(server.requests.length >= 3);
  } finally { done(); }
});

// ------------------------------------------------------------------------- no re-enrollment, no other service

test('G1: a refresh never re-enrolls; the explicit click is the only restart, at the version the server just reported, with the current token', async () => {
  let version = 0;
  const { server, lifecycle, h, done } = await openGate((entry) => (entry.fn === 'reactivate_x_autopost_service' || version === 0 ? ACTIVE : ENDED(version)));
  try {
    version = 3;
    lifecycle.bump('user-A'); await h.settle();
    assert.ok(h.button('利用登録する'));
    version = 4;
    lifecycle.bump('user-A'); await h.settle();
    assert.equal(server.requests.filter((r) => r.fn === 'reactivate_x_autopost_service').length, 0, 'two refreshes, zero restarts');
    h.button('利用登録する').props.onPress(); await h.settle();
    const restarts = server.requests.filter((r) => r.fn === 'reactivate_x_autopost_service');
    assert.equal(restarts.length, 1);
    assert.deepEqual([restarts[0].token, restarts[0].body], [tokenOf('A', 1), { p_expected_lifecycle_version: 4 }], 'the version of the LATEST answer');
    assert.equal(h.isApp(), true);
  } finally { done(); }
});

test('G1: a signal while the person\'s restart click is in flight: the restart\'s answer cannot open the app, the re-ask decides', async () => {
  let phase = 'active';
  const { server, lifecycle, h, done } = await openGate((entry) => {
    if (entry.fn === 'reactivate_x_autopost_service') return 'hold';
    return phase === 'active' ? ACTIVE : phase === 'ended' ? ENDED(3) : ENDED(4);
  });
  try {
    phase = 'ended';
    lifecycle.bump('user-A'); await h.settle();
    h.button('利用登録する').props.onPress(); await h.settle();
    assert.equal(server.held.length, 1, 'the person\'s restart is in flight');
    phase = 'ended-again';
    lifecycle.bump('user-A'); await h.settle();           // a signal arrives meanwhile
    assert.equal(server.held[0].entry.signal.aborted, true, 'the restart of the old epoch is withdrawn');
    server.held[0].release(ACTIVE); await h.settle();     // its answer, late
    assert.equal(h.isApp(), false, 'a restart answer of an old epoch never opens the app');
    assert.ok(h.button('利用登録する'), 'the server\'s fresh answer decides: still ended, still offered');
    assert.equal(server.requests.filter((r) => r.fn === 'reactivate_x_autopost_service').length, 1, 'no second restart without a second click');
  } finally { done(); }
});

test('G1: the gate reads and writes only the X service; the other app\'s entitlement is never touched, whatever the epoch does', async () => {
  const { server, lifecycle, h, done } = await openGate(() => ACTIVE);
  try {
    for (let i = 0; i < 3; i += 1) { lifecycle.bump('user-A'); await h.settle(); }
    lifecycle.bump('user-B'); await h.settle();
    assert.ok(server.requests.length >= 4);
    for (const request of server.requests) assert.ok(ONLY_X_RPCS.has(request.fn), `unexpected RPC ${request.fn}`);
  } finally { done(); }
  const gate = code(await read('src/features/service-enrollment/service-enrollment-gate.tsx'));
  assert.doesNotMatch(gate, /kabumori/iu, 'the gate names no other service');
  assert.doesNotMatch(gate, /\.from\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(/u, 'no direct table access');
});

// --------------------------------------------------------------------- remount, the end screen and the mock

test('G1: a React remount of the gate starts closed and asks afresh; no end view is open after a remount', async () => {
  let ended = false;
  const { server, lifecycle, h, done } = await openGate(() => (ended ? ENDED(2) : ACTIVE));
  try {
    ended = true;
    lifecycle.bump('user-A'); await h.settle();
    assert.equal(h.isApp(), false);
    const open = h.link('利用終了・共通IDの管理');
    assert.ok(open, 'the embedded end screen is reachable from the closed gate');
    open.props.onPress(); h.render();
    assert.ok(h.has('AccountDeletionScreen'), 'opened by the person');
    h.unmount(); h.clear();                                   // the gate is destroyed and mounted again
    h.render();
    assert.equal(h.has('AccountDeletionScreen'), false, 'a remounted gate never mounts an open end view');
    assert.equal(h.isApp(), false, 'and it is closed until the server answers');
    await h.settle();
    assert.equal(server.requests.at(-1).fn, 'start_x_autopost_service');
  } finally { done(); }
});

test('G1: a signal does not close the end screen the person has open (their result stays visible)', async () => {
  let ended = false;
  const { lifecycle, h, done } = await openGate(() => (ended ? ENDED(2) : ACTIVE));
  try {
    ended = true;
    lifecycle.bump('user-A'); await h.settle();               // closed gate with the re-enroll screen
    h.link('利用終了・共通IDの管理').props.onPress(); h.render();
    assert.ok(h.has('AccountDeletionScreen'));
    lifecycle.bump('user-A'); await h.settle();
    assert.ok(h.has('AccountDeletionScreen'), 'a further signal re-asks the server but does not tear the screen down');
  } finally { done(); }
});

test('G1: the local mock preview is never gated and ignores the signal', async () => {
  const server = fakeServer(() => ACTIVE);
  const lifecycle = createLifecycleSignal();
  const h = await gateHarness(server, { lifecycle, dataSource: 'mock' });
  try {
    h.setSession(sessionOf('A', 1)); await h.settle();
    lifecycle.bump('user-A'); await h.settle();
    assert.equal(h.isApp(), true);
    assert.equal(server.requests.length, 0, 'the preview talks to nobody');
  } finally { h.unmount(); h.restore(); }
});

// ------------------------------------------------------------------------------------------------ contracts

test('the seam: the gate\'s only lifecycle input is a read of a per-person number, typed, and the gate never produces the signal', async () => {
  // Connected (F5 connection step 2): the seam is exactly F4's per-person epoch hook, re-exported -- nothing else.
  const providerHook = (userId) => (userId === 'user-A' ? 3 : 0);
  const module = { exports: {} };
  const js = ts.transpileModule(await read('src/features/service-enrollment/lifecycle-epoch.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: (name) => {
    assert.equal(name, '@/features/service-lifecycle/service-lifecycle', `the seam imports only F4's provider module, not ${name}`);
    return { useServiceLifecycleEpoch: providerHook };
  } });
  const seam = module.exports;
  assert.equal(typeof seam.useLifecycleEpoch, 'function');
  assert.equal(seam.useLifecycleEpoch('user-A'), 3, 'the gate reads F4\'s per-person number');
  assert.equal(seam.useLifecycleEpoch(null), 0);
  assert.equal(seam.LIFECYCLE_SIGNAL_CONNECTED, true, 'connected to F4\'s ServiceLifecycleProvider (see the status comment in lifecycle-epoch.ts)');
  const gate = code(await read('src/features/service-enrollment/service-enrollment-gate.tsx'));
  assert.match(gate, /import \{ useLifecycleEpoch \} from '@\/features\/service-enrollment\/lifecycle-epoch';/u);
  assert.doesNotMatch(gate, /bump\s*\(/u, 'the gate consumes the epoch; the end surface (F4) alone produces it');
  assert.doesNotMatch(gate, /ServiceLifecycleProvider|service-lifecycle\/service-lifecycle/u, 'no competing or direct F4 import');
  const source = code(await read('src/features/service-enrollment/lifecycle-epoch.ts'));
  assert.doesNotMatch(source, /createContext|useState|useEffect|useRef/u, 'the seam holds no state: it is not a provider');
  const layout = await read('src/app/_layout.tsx');
  assert.match(layout, /<ServiceEnrollmentGate>/u, 'the layout (F4) is untouched by this change');
});

test('every decided state of the gate is tagged with person, login AND epoch', async () => {
  const gate = code(await read('src/features/service-enrollment/service-enrollment-gate.tsx'));
  assert.match(gate, /type Owner = \{ userId: string \| null; loginId: string \| null; epoch: number \};/u);
  assert.match(gate, /owner\.userId === userId && owner\.loginId === loginId && owner\.epoch === epoch/u);
  assert.match(gate, /isOwner\(view, userId, loginId, epoch\)/u);
  assert.match(gate, /\[attempt, selection, userId, loginId, epoch\]/u, 'the automatic effect depends on the epoch');
});
