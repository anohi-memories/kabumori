// J2 V2 (PR238 review) -- the two reproduced P2 defects of the ServiceEnrollmentGate, as F5-owned tests.
//
// P2-1  The gate drew its OWN copy of the end / ID-management screen for its closed states. A new login of the same
//       person (re-authentication) that the server answered `active` made the gate return the app and the copy vanished,
//       while F4's outside surface was never opened. Now every management entry of the gate asks F4's EXISTING surface to
//       open (`open(currentUserId)`); the gate draws no screen.
// P2-2  A callback drawn for an older person / login / epoch / request could still be held and called, and sent the
//       reactivate RPC with its old token. Now the handler compares itself with the LATEST question when it runs, before it
//       changes anything or sends anything, and once more at the moment of dispatch.
//
// The real gate (and, for P2-1, F4's real provider, surface and end screen) is transpiled and driven through a hook
// runtime. Auth, the end request and PostgREST are synthetic; no network. These cases were run against the exact PR238
// head (b8e91ea8): the negative ones FAIL there (fail-before) and pass on the fix; the positive controls pass on both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { fakeServer, flush, gateHarness, sessionOf as plainSessionOf, tokenOf } from './support/enrollment-harness.mjs';
import { createLifecycleSignal } from './support/lifecycle-signal.ts';
import { ACTIVE, assemble, ENDED, sessionOf, textOf, walk } from './support/assembled-app.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(join(root, path), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
const MANAGE = '利用終了・共通IDの管理';
const REENROLL = '利用登録する';
const reactivations = (server) => server.requests.filter((r) => r.fn === 'reactivate_x_autopost_service');

// ============================================================================================================ P2-1

const managementLink = (a) => walk(a.view.gate).find((n) => n.type === 'Pressable' && walk(n.props.children).some((c) => c.type === 'Text' && textOf(c).includes(MANAGE)));
const phraseInput = (a) => walk(a.view.screen).find((n) => n.type === 'TextInput' && !n.props.secureTextEntry);

/** The closed states a person can be in when they use the management entry. */
const CLOSED_STATES = {
  'blocked (service suspended)': { answer: () => ({ body: { status: 'blocked', reason: 'SERVICE_SUSPENDED' } }) },
  'error (offline)': { answer: () => 'offline' },
  'ended (re-enrollment offered)': { answer: () => ENDED(4) },
};

for (const [state, { answer }] of Object.entries(CLOSED_STATES)) {
  for (const [after, reply] of [['active', () => ACTIVE], ['ended', () => ENDED(5)], ['error', () => 'offline']]) {
    test(`P2-1: ${state} -> management entry -> the same person's new login answers ${after}: F4's surface stays open`, async () => {
      let mode = 'first';
      const a = await assemble({ answer: (entry) => (mode === 'first' ? answer(entry) : reply(entry)) });
      try {
        assert.equal(a.isApp(), false, 'precondition: the gate is closed');
        managementLink(a).props.onPress(); a.frame(); await a.settle();
        assert.equal(a.api().openFor, 'user-A', 'the entry asks F4\'s surface to open for the person signed in');
        assert.ok(a.view.screen, 'the end screen is drawn by the surface');
        assert.ok(!walk(a.view.gate).some((n) => typeof n.type === 'function'), 'the gate itself draws no screen');
        phraseInput(a).props.onChangeText('typed for login 1'); a.frame();
        mode = 'second';
        a.auth.session = sessionOf('A', 2);            // what re-authentication produces: a new login of the same person
        await a.settle();
        assert.equal(a.api().openFor, 'user-A', `the surface is still open after the new login's ${after} answer`);
        assert.ok(a.view.screen, `the end screen is still visible after ${after}`);
        assert.equal(a.isApp(), after === 'active', 'the gated app follows the server\'s answer for the new login (S1 unchanged)');
        assert.equal(phraseInput(a).props.value, '', 'what was typed for login 1 is invalidated: consent is per login');
      } finally { a.done(); }
    });
  }
}

test('P2-1: another person or sign-out closes the surface that the gate\'s entry opened, and coming back does not reopen it', async () => {
  for (const next of [sessionOf('B', 1), null]) {
    const a = await assemble({ answer: () => ENDED(4) });
    try {
      managementLink(a).props.onPress(); a.frame(); await a.settle();
      assert.ok(a.view.screen);
      a.auth.session = next; await a.settle();
      assert.equal(a.api().openFor, null, next ? 'another person: closed, not merely hidden' : 'sign-out: closed');
      assert.equal(a.view.screen, null);
      a.auth.session = sessionOf('A', 3); await a.settle();
      assert.equal(a.api().openFor, null, 'the first person coming back does not find it reopened');
      assert.equal(a.view.screen, null);
    } finally { a.done(); }
  }
});

test('P2-1: a management click drawn for a person who is no longer signed in opens nothing (never a stale identity)', async () => {
  const a = await assemble({ answer: () => ENDED(4) });
  try {
    const stale = managementLink(a).props.onPress;
    a.auth.session = sessionOf('B', 1); await a.settle();
    stale();                                          // the callback drawn for A, called while B is signed in
    a.frame(); await a.settle();
    assert.equal(a.api().openFor, null, 'nothing opens for A, and nothing opens for B either');
    assert.equal(a.view.screen, null);
  } finally { a.done(); }
});

test('P2-1: source contract -- the gate holds no copy of the end screen and no identity of its own for it', async () => {
  const gate = code(await read('src/features/service-enrollment/service-enrollment-gate.tsx'));
  assert.doesNotMatch(gate, /AccountDeletionScreen|account-deletion|deletionOpenFor/u);
  assert.match(gate, /const lifecycle = useServiceLifecycle\(\);/u);
  assert.match(gate, /lifecycle\.open\(signedIn\)/u);
  assert.equal([...gate.matchAll(/利用終了・共通IDの管理/gu)].length, 1, 'one management entry');
});

// ============================================================================================================ P2-2

/** Person A, login 1, epoch 0, ended (`reenroll_required` v3): the closed gate with the re-enroll button. */
async function endedGate(answer = () => ENDED(3)) {
  const server = fakeServer((entry) => answer(entry));
  const lifecycle = createLifecycleSignal();
  const h = await gateHarness(server, { lifecycle });
  h.setSession(plainSessionOf('A', 1)); await h.settle();
  assert.ok(h.button(REENROLL), 'precondition: the re-enroll button is shown');
  return { server, lifecycle, h, done() { h.unmount(); h.restore(); } };
}

test('P2-2: an old callback after the same person\'s epoch moved sends NOTHING (the new question has its own button)', async () => {
  let version = 3;
  const { server, lifecycle, h, done } = await endedGate((entry) => (entry.fn === 'reactivate_x_autopost_service' ? ACTIVE : ENDED(version)));
  try {
    const old = h.button(REENROLL).props.onPress;
    version = 4;
    lifecycle.bump('user-A'); await h.settle();                 // the end surface reported another end; the gate re-asked
    assert.ok(h.button(REENROLL), 'the current question is offered again');
    old(); await flush();
    assert.equal(reactivations(server).length, 0, 'the old callback (epoch 0, version 3) sent no RPC');
    assert.equal(h.isApp(), false, 'and resurrected no ready');
  } finally { done(); }
});

test('P2-2: an old callback after A -> B sends nothing, in particular nothing with A\'s token', async () => {
  const { server, h, done } = await endedGate();
  try {
    const old = h.button(REENROLL).props.onPress;
    h.setSession(plainSessionOf('B', 1)); await h.settle();    // B is signed in and shown B's own question
    assert.ok(h.button(REENROLL));
    old(); await flush();
    assert.equal(reactivations(server).length, 0, 'no RPC at all');
    assert.ok(!server.requests.some((r) => r.token === tokenOf('A', 1) && r.fn !== 'start_x_autopost_service'), 'A\'s token is used only for A\'s own automatic start');
  } finally { done(); }
});

test('P2-2: an old callback after the same person\'s login rotated sends nothing', async () => {
  const { server, h, done } = await endedGate();
  try {
    const old = h.button(REENROLL).props.onPress;
    h.setSession(plainSessionOf('A', 2)); await h.settle();    // re-authentication: a new login of A
    old(); await flush();
    assert.equal(reactivations(server).length, 0);
  } finally { done(); }
});

test('P2-2: a newer request supersedes an older callback of the SAME person, login and epoch', async () => {
  let version = 3;
  const { server, h, done } = await endedGate((entry) => (entry.fn === 'reactivate_x_autopost_service' ? ENDED(5) : ENDED(version)));
  try {
    const older = h.button(REENROLL).props.onPress;             // drawn for request r (version 3)
    older(); await h.settle();                                    // the person's click: one restart; the server still answers ended (v5)
    assert.equal(reactivations(server).length, 1);
    assert.ok(h.button(REENROLL), 'a fresh button for the newer request');
    older(); await flush();
    assert.equal(reactivations(server).length, 1, 'the older callback sends no second restart (its version 3 is no longer the question)');
    h.button(REENROLL).props.onPress(); await h.settle();
    assert.deepEqual(reactivations(server).map((r) => r.body), [{ p_expected_lifecycle_version: 3 }, { p_expected_lifecycle_version: 5 }], 'only the current button restarts, at the version just reported');
  } finally { done(); }
});

test('P2-2 positive: the current owner\'s click restarts exactly once, a second click while it is in flight sends nothing, and the answer opens the app', async () => {
  const { server, h, done } = await endedGate((entry) => (entry.fn === 'reactivate_x_autopost_service' ? 'hold' : ENDED(3)));
  try {
    const press = h.button(REENROLL).props.onPress;
    press(); press(); await flush();
    assert.equal(reactivations(server).length, 1, 'no double click');
    assert.deepEqual([reactivations(server)[0].token, reactivations(server)[0].body], [tokenOf('A', 1), { p_expected_lifecycle_version: 3 }]);
    server.held[0].release(ACTIVE); await h.settle();
    assert.equal(h.isApp(), true, 'the server\'s answer opens it');
  } finally { done(); }
});

test('P2-2: after a successful re-enrollment the callback that sent it is spent: calling it again sends nothing and closes nothing', async () => {
  const { server, h, done } = await endedGate((entry) => (entry.fn === 'reactivate_x_autopost_service' ? ACTIVE : ENDED(3)));
  try {
    const press = h.button(REENROLL).props.onPress;
    press(); await h.settle();
    assert.equal(h.isApp(), true);
    press(); await h.settle();
    assert.equal(reactivations(server).length, 1, 'no second restart');
    assert.equal(h.isApp(), true, 'and no stale view replaced the ready one');
  } finally { done(); }
});

test('P2-2: the stale-callback rule also covers the retry and the notice acknowledgement', async () => {
  // retry (error view of A) called after B is signed in must not cancel or re-ask anything for B
  let who = 'error';
  const server = fakeServer((entry) => (entry.token === tokenOf('B', 1) ? 'hold' : who === 'error' ? 'offline' : ACTIVE));
  const lifecycle = createLifecycleSignal();
  const h = await gateHarness(server, { lifecycle });
  try {
    h.setSession(plainSessionOf('A', 1)); await h.settle();
    const oldRetry = h.button('再読み込み').props.onPress;
    h.setSession(plainSessionOf('B', 1)); await h.settle();     // B's ask is held
    const before = server.requests.length;
    oldRetry(); await h.settle();
    assert.equal(server.requests.length, before, 'A\'s retry asked nothing and did not disturb B\'s pending ask');
    assert.equal(server.held[0].entry.signal.aborted, false, 'B\'s request is still alive');
  } finally { h.unmount(); h.restore(); }
  // notice acknowledgement: A's "はじめる" button must not acknowledge B's one-time notice
  const noticeServer = fakeServer(() => ({ body: { status: 'active', service: 'x_autopost', started: true, shared_account: true } }));
  const h2 = await gateHarness(noticeServer, { lifecycle: createLifecycleSignal() });
  try {
    h2.setSession(plainSessionOf('A', 1)); await h2.settle();
    const oldAck = h2.button('はじめる').props.onPress;
    h2.setSession(plainSessionOf('B', 1)); await h2.settle();
    assert.ok(h2.button('はじめる'), 'B has their own notice');
    oldAck(); await h2.settle();
    assert.equal(h2.isApp(), false, 'A\'s old button did not acknowledge B\'s notice');
    h2.button('はじめる').props.onPress(); await h2.settle();
    assert.equal(h2.isApp(), true, 'B\'s own button does');
  } finally { h2.unmount(); h2.restore(); }
});

test('P2-2: the first thing the click does is the comparison; nothing is changed by a stale one', async () => {
  const gate = code(await read('src/features/service-enrollment/service-enrollment-gate.tsx'));
  const reenroll = gate.slice(gate.indexOf('const reenroll = useCallback'), gate.indexOf("if (selection.kind === 'mock') return <>"));
  const compare = reenroll.indexOf('if (!isCurrentQuestion(clicked, shown)) return;');
  assert.ok(compare > -1);
  for (const effect of ['++request.current', 'explicitInFlight.current = true', 'setView(', 'enrollment', 'transportFor']) {
    assert.ok(reenroll.indexOf(effect) > compare, `${effect} comes after the comparison`);
  }
  assert.match(reenroll, /if \(mine !== request\.current \|\| !isOwner\(currentOwner\.current, clicked\.userId, clicked\.loginId, clicked\.epoch\)\) throw new EnrollmentCancelledError\(\);\s*return reactivateServiceExplicitly/u, 'and again at dispatch');
});
