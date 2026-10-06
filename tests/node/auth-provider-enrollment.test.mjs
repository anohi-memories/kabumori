// Common-account Phase 2 (H1/C1 corrective): the real Kabumori AuthProvider, transpiled and driven through a
// hook runtime with dependency-tracked effects and cleanups (the same reproduction style H1 used).
//   R3: refused -> retry pending -> refused gives side effects (serviceSession) no session at any render;
//   R2: an explicit restart is sent once, for the clicking session only, and a switch to B never restarts B;
//   R4: a late answer for A after sign-out / a switch to B never opens the app;
//   S1: with the real lib/auth (and the real shared gate and transport over an intercepted fetch), a new login
//       of the same person never adopts the old login's restart or its answer; a refreshed token of the same
//       login keeps one logical enrollment.
// Run: node --test tests/node/auth-provider-enrollment.test.mjs   (needs the root node_modules for `typescript`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

import * as enrollmentModule from '../../src/lib/service-enrollment.ts';
import * as serviceSessionModule from '../../src/lib/service-session.ts';

function depsEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Synthetic unsigned access tokens with only the claims the client reads (sub, session_id): a person's
// login N, and the same login's token after a refresh. Built at run time; not credentials.
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const loginUuid = (user, login) => `00000000-0000-4000-8000-${String(user.charCodeAt(0)).padStart(6, '0')}${String(login).padStart(6, '0')}`;
const tokenOf = (user, login = 1, refresh = 0) => `${b64url({ alg: 'none' })}.${b64url({ sub: `user-${user}`, session_id: loginUuid(user, login), iat: refresh })}.unsigned`;
const sessionOf = (user, login = 1, refresh = 0) => ({ access_token: tokenOf(user, login, refresh), user: { id: `user-${user}` } });

// A fake PostgREST endpoint for the real lib/auth: records every RPC with the token it carried; answers can be held.
function fakeServer(answer) {
  const requests = [];
  const held = [];
  const fetchImpl = (url, init) => {
    const entry = { fn: String(url).split('/rpc/')[1], token: init.headers.Authorization.replace(/^Bearer /u, ''), body: JSON.parse(init.body), signal: init.signal };
    requests.push(entry);
    const reply = answer(entry);
    const respond = (value) => ({ ok: true, status: 200, json: async () => value });
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

async function realAuthModule(supabase) {
  const modules = {
    '@supabase/supabase-js': { AuthError: class AuthError extends Error {} },
    'expo-linking': { createURL: () => 'kabumori://reset-password' },
    '@/lib/password-recovery': { RECOVERY_PATH: 'reset-password', resetEmailIssue: () => null },
    '@/lib/push-notifications': { removeThisDevicePushTokenBestEffort: async () => {} },
    '@/lib/service-enrollment': enrollmentModule,
    '@/lib/supabase': { supabase, supabasePublicConfig: { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' } },
  };
  const source = await readFile(new URL('../../src/lib/auth.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports,
    require: (name) => { assert.ok(Object.hasOwn(modules, name), `unexpected import ${name}`); return modules[name]; } });
  return module.exports;
}

async function providerHarness({ initialSession, server = null }) {
  const slots = [];
  let cursor = 0;
  let pending = [];
  const react = {
    createContext: () => ({ Provider: 'Provider' }),
    useContext: () => null,
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[i];
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!slots[i] || !depsEqual(slots[i].deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps, cleanup: previous?.cleanup };
        pending.push({ i, effect });
      }
    },
  };

  // Fake lib/auth: every enrollment request is recorded and answered by the test.
  const prepares = [];
  const reactivations = [];
  let resets = 0;
  const auth = {
    prepareSession: (session) => { const d = deferred(); prepares.push({ session, ...d }); return d.promise; },
    reactivateKabumori: (session, lifecycleVersion) => { const d = deferred(); reactivations.push({ session, lifecycleVersion, ...d }); return d.promise; },
    resetServiceEnrollment: () => { resets += 1; },
  };
  let subscriber = null;
  let currentSession = initialSession;
  const supabaseModule = { supabase: { auth: {
    getSession: async () => ({ data: { session: currentSession }, error: null }),
    onAuthStateChange: (callback) => { subscriber = callback; return { data: { subscription: { unsubscribe() { subscriber = null; } } } }; },
  } } };
  // With a server: the real lib/auth over the real shared gate and transport, its fetch intercepted.
  const realAuth = server ? await realAuthModule(supabaseModule.supabase) : null;
  const originalFetch = globalThis.fetch;
  if (server) globalThis.fetch = server.fetchImpl;
  const modules = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@/lib/auth': realAuth ?? auth,
    '@/lib/service-enrollment': enrollmentModule,
    '@/lib/service-session': serviceSessionModule,
    '@/lib/supabase': supabaseModule,
  };
  const source = await readFile(new URL('../../src/providers/auth-provider.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, setTimeout,
    require: (name) => { assert.ok(Object.hasOwn(modules, name), `unexpected import ${name}`); return modules[name]; } });

  const seen = [];
  let value = null;
  function render() {
    cursor = 0;
    pending = [];
    value = module.exports.AuthProvider({ children: null }).props.value;
    seen.push(value.serviceSession);
    for (const { i, effect } of pending) {
      slots[i].cleanup?.();
      const cleanup = effect();
      slots[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
    return value;
  }
  async function settle() {
    for (let round = 0; round < 6; round += 1) {
      await new Promise((r) => setTimeout(r, 0));
      render();
    }
    return value;
  }
  return {
    prepares, reactivations, seen,
    resets: () => resets,
    render, settle,
    value: () => value,
    emit: async (event, next) => { currentSession = next; subscriber?.(event, next); await settle(); },
    clearSeen: () => { seen.length = 0; },
    restore: () => { realAuth?.resetServiceEnrollment(); globalThis.fetch = originalFetch; },
  };
}

const REFUSED = { kind: 'blocked', reason: 'SERVICE_NOT_READY' };
const READY = { kind: 'ready', started: false, sharedAccountNotice: false };

test('R3: refused -> retry pending -> refused never gives side effects a session; only a positive ready does', async () => {
  const A = sessionOf('A');
  const h = await providerHarness({ initialSession: A });
  h.render();
  await h.settle();
  for (const p of h.prepares) p.resolve(REFUSED);
  await h.settle();
  assert.deepEqual(h.value().serviceAccess, REFUSED);
  assert.equal(h.value().serviceSession, null);

  h.clearSeen();
  h.value().retry();
  await h.settle(); // retry pending: a new prepare is outstanding
  assert.ok(h.prepares.length >= 2);
  assert.equal(h.value().serviceAccess, null);
  assert.equal(h.value().serviceSession, null, 'pending retry: no session for side effects');
  for (const p of h.prepares) p.resolve(REFUSED);
  await h.settle();
  assert.deepEqual(h.value().serviceAccess, REFUSED);
  assert.ok(h.seen.every((s) => s === null), 'refused -> pending -> refused: zero renders exposed a session');

  h.value().retry();
  await h.settle();
  for (const p of h.prepares) p.resolve(READY);
  await h.settle();
  assert.equal(h.value().serviceSession, A, 'only the positive ready opens side effects');
});

test('R2: one click restarts the clicking session once; a switch to B before the answer never restarts B', async () => {
  const A = sessionOf('A');
  const B = sessionOf('B');
  const h = await providerHarness({ initialSession: A });
  h.render();
  await h.settle();
  for (const p of h.prepares) p.resolve({ kind: 'reenroll_required', lifecycleVersion: 3 });
  await h.settle();
  assert.deepEqual(h.value().serviceAccess, { kind: 'reenroll_required', lifecycleVersion: 3 });

  h.value().reenroll();
  h.value().reenroll(); // a second tap before the first settles sends nothing
  assert.equal(h.reactivations.length, 1);
  assert.equal(h.reactivations[0].session, A);
  assert.equal(h.reactivations[0].lifecycleVersion, 3);

  await h.emit('SIGNED_IN', B); // switch before A's answer
  const bPrepares = h.prepares.filter((p) => p.session === B);
  assert.ok(bPrepares.length >= 1, 'B gets its own automatic enrollment');
  for (const p of bPrepares) p.resolve({ kind: 'reenroll_required', lifecycleVersion: 8 });
  await h.settle();
  h.reactivations[0].resolve({ kind: 'ready', started: true, sharedAccountNotice: false }); // A's late answer
  await h.settle();
  assert.equal(h.reactivations.length, 1, 'no restart was ever sent for B');
  assert.ok(h.reactivations.every((r) => r.session === A));
  assert.deepEqual(h.value().serviceAccess, { kind: 'reenroll_required', lifecycleVersion: 8 }, 'B still sees its own restart screen');
  assert.equal(h.value().serviceSession, null);
});

test('R4: a late answer for A after sign-out, or after a switch to B, never opens the app', async () => {
  const A = sessionOf('A');
  const B = sessionOf('B');
  const h = await providerHarness({ initialSession: A });
  h.render();
  await h.settle();
  await h.emit('SIGNED_OUT', null);
  assert.ok(h.resets() >= 1, 'sign-out resets (cancels) the enrollment');
  for (const p of h.prepares) p.resolve(READY);
  await h.settle();
  assert.equal(h.value().session, null);
  assert.equal(h.value().serviceSession, null);

  await h.emit('SIGNED_IN', A);
  await h.emit('SIGNED_IN', B);
  const aPending = h.prepares.filter((p) => p.session === A);
  const bPending = h.prepares.filter((p) => p.session === B);
  for (const p of bPending) p.resolve(REFUSED);
  await h.settle();
  for (const p of aPending) p.resolve(READY); // A's stale ready arrives last
  await h.settle();
  assert.equal(h.value().session, B);
  assert.deepEqual(h.value().serviceAccess, REFUSED);
  assert.equal(h.value().serviceSession, null, 'A\'s stale ready did not open the app for B');
});

test('a cancelled request (superseded) is not shown as a failure', async () => {
  const A = sessionOf('A');
  const h = await providerHarness({ initialSession: A });
  h.render();
  await h.settle();
  for (const p of h.prepares) p.resolve(READY);
  await h.settle();
  h.value().retry();
  await h.settle();
  const latest = h.prepares[h.prepares.length - 1];
  for (const p of h.prepares.slice(0, -1)) p.reject(new enrollmentModule.EnrollmentCancelledError());
  latest.reject(new enrollmentModule.EnrollmentCancelledError());
  await h.settle();
  assert.equal(h.value().profileError, null);
});

// ---------------------------------------------------------------------------------------------
// S1 through the real AuthProvider + the real lib/auth: everything belongs to one login, not merely to the person.
const K_ACTIVE = { status: 'active', service: 'kabumori', started: true, shared_account: false };
const K_ENDED = { status: 'reenroll_required', service: 'kabumori', lifecycle_version: 3 };
const restartsOf = (server) => server.requests.filter((r) => r.fn === 'reactivate_kabumori_service');
const startsOf = (server) => server.requests.filter((r) => r.fn === 'start_kabumori_service');

async function endedThenClicked(server, A1) {
  const h = await providerHarness({ initialSession: A1, server });
  h.render();
  await h.settle();
  assert.deepEqual(h.value().serviceAccess, { kind: 'reenroll_required', lifecycleVersion: 3 });
  h.value().reenroll();
  await h.settle();
  assert.equal(restartsOf(server).length, 1);
  assert.equal(restartsOf(server)[0].token, A1.access_token);
  return h;
}

for (const [label, arrive] of [
  ['a new sign-in A2', async (h, A2) => { await h.emit('SIGNED_IN', A2); }],
  ['sign-out, then a fresh login A2', async (h, A2) => { await h.emit('SIGNED_OUT', null); await h.emit('SIGNED_IN', A2); }],
  ['a recovery link (new login A2)', async (h, A2) => { await h.emit('PASSWORD_RECOVERY', A2); }],
]) {
  test(`S1: A1 clicks restart, ${label} of the same person arrives before the answer: A1's answer never makes A2 ready`, async () => {
    let holdRestart = true;
    const server = fakeServer((entry) => (entry.fn === 'reactivate_kabumori_service' ? (holdRestart ? 'hold' : K_ACTIVE) : K_ENDED));
    const A1 = sessionOf('A', 1);
    const A2 = sessionOf('A', 2);
    const h = await endedThenClicked(server, A1);
    try {
      const restart = restartsOf(server)[0];
      await arrive(h, A2);
      assert.ok(restart.signal.aborted, 'the old login\'s pending restart was cancelled');
      server.held[0].release(K_ACTIVE); // A1's answer arrives anyway
      await h.settle();
      assert.equal(h.value().session, A2);
      assert.equal(h.value().serviceSession, null, 'A2 is not ready on A1\'s answer');
      assert.ok(h.seen.every((s) => s !== A2), 'no render exposed A2 to side effects');
      assert.deepEqual(h.value().serviceAccess, { kind: 'reenroll_required', lifecycleVersion: 3 }, 'A2 is asked itself');
      assert.ok(startsOf(server).some((r) => r.token === A2.access_token), 'A2 got its own automatic start');
      assert.equal(restartsOf(server).length, 1, 'nothing was restarted for A2 without its own click');

      // A2's own confirmation: sent once, with A2's token, and only then ready.
      holdRestart = false;
      h.value().reenroll();
      await h.settle();
      assert.deepEqual(restartsOf(server).map((r) => r.token), [A1.access_token, A2.access_token]);
      assert.equal(h.value().serviceSession, A2);
    } finally { h.restore(); }
  });
}

test('S1: A1\'s answer landing while A2\'s auth event is queued still never makes A2 ready', async () => {
  const server = fakeServer((entry) => (entry.fn === 'reactivate_kabumori_service' ? 'hold' : K_ENDED));
  const A1 = sessionOf('A', 1);
  const A2 = sessionOf('A', 2);
  const h = await endedThenClicked(server, A1);
  try {
    h.clearSeen();
    const settled = h.emit('SIGNED_IN', A2); // the provider handles it on the next task
    server.held[0].release(K_ACTIVE);
    await settled;
    await h.settle();
    assert.equal(h.value().session, A2);
    assert.equal(h.value().serviceSession, null);
    assert.ok(h.seen.every((s) => s !== A2), 'no render exposed A2 to side effects');
    assert.ok(startsOf(server).some((r) => r.token === A2.access_token), 'A2 got its own automatic start');
  } finally { h.restore(); }
});

test('S1 control: a refreshed token of the same login keeps one logical enrollment and the click\'s own answer', async () => {
  const server = fakeServer((entry) => (entry.fn === 'reactivate_kabumori_service' ? 'hold' : K_ENDED));
  const A1 = sessionOf('A', 1);
  const A1refreshed = sessionOf('A', 1, 1);
  const h = await endedThenClicked(server, A1);
  try {
    const restart = restartsOf(server)[0];
    await h.emit('TOKEN_REFRESHED', A1refreshed);
    assert.equal(restart.signal.aborted, false, 'the same login does not cancel its own restart');
    server.held[0].release(K_ACTIVE);
    await h.settle();
    assert.equal(h.value().serviceSession, A1refreshed, 'the clicking login is ready on its own answer');
    assert.equal(startsOf(server).length, 1, 'no second automatic start for a refreshed token');
    assert.equal(restartsOf(server).length, 1);
    await h.emit('TOKEN_REFRESHED', sessionOf('A', 1, 2));
    assert.equal(server.requests.length, 2, 'later refreshes reuse the decided outcome');
    assert.ok(h.value().serviceSession);
  } finally { h.restore(); }
});

test('S1: a session whose login cannot be identified is never enrolled, never ready, and sends nothing', async () => {
  const server = fakeServer(() => K_ACTIVE);
  const odd = { access_token: 'token-A', user: { id: 'user-A' } };
  const h = await providerHarness({ initialSession: odd, server });
  try {
    h.render();
    await h.settle();
    assert.equal(server.requests.length, 0);
    assert.equal(h.value().serviceSession, null);
    assert.deepEqual(h.value().serviceAccess, { kind: 'blocked', reason: 'ACCOUNT_NOT_FOUND' });
  } finally { h.restore(); }
});
