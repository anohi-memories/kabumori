// Common-account Phase 2 (H1/C1 corrective): the real Kabumori AuthProvider, transpiled and driven through a
// hook runtime with dependency-tracked effects and cleanups (the same reproduction style H1 used).
//   R3: refused -> retry pending -> refused gives side effects (serviceSession) no session at any render;
//   R2: an explicit restart is sent once, for the clicking session only, and a switch to B never restarts B;
//   R4: a late answer for A after sign-out / a switch to B never opens the app.
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

const sessionOf = (user) => ({ access_token: `token-${user}`, user: { id: `user-${user}` } });

async function providerHarness({ initialSession }) {
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
  const modules = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@/lib/auth': auth,
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
