// G2 QA (Issue #317, task postona-g2-pr366-auth-session-marker-event-offline-qa-20261020) -- QA only, no product code.
// The REAL route + screen of the manual X post (src/app/manual-publish.tsx, transpiled) and the REAL draft store of
// PR #366, driven by a MOCK sequence of Supabase Auth sessions. Offline: no network, no Auth server, no token, no X.
//
// What is real and what is assumed:
//   - auth-js 2.115.0 (the version in package-lock) only FORWARDS the user object the Auth server returns: a refresh
//     takes `user` from the /token?grant_type=refresh_token answer, a restored session after a restart keeps the user
//     object that was stored, and a restored session is announced as SIGNED_IN. `last_sign_in_at` is an optional
//     field of `User` (a per-user field), while `session_id` is a required claim of the access token (per session).
//   - mockAuth() below ASSUMES the server stamps `last_sign_in_at` on every new sign-in of that user on any device and
//     returns the current value with a refresh. That is NOT verified against the real Auth server (not allowed here).
//
// Naming: "G2-S.." = expected behaviour that holds today. "FINDING G2-SM.." = a gap that holds today: the test passes
// while the gap exists and FAILS once it is fixed (then the owner turns it into a regular test). The last test runs
// mutated copies of the code and requires the "G2-S.." scenarios to catch each mutation (negative controls).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as model from '../src/features/manual-publish/manual-publish-model.ts';
import * as realFlow from '../src/features/manual-publish/manual-publish-flow.ts';
import * as realPort from '../src/features/manual-publish/manual-publish-port.ts';
import * as realStore from '../src/features/manual-publish/manual-publish-store.ts';
import * as realDraft from '../src/features/manual-publish/manual-publish-draft-store.ts';

const ROUTE_SOURCE = await readFile(new URL('../src/app/manual-publish.tsx', import.meta.url), 'utf8');
const DRAFT_URL = new URL('../src/features/manual-publish/manual-publish-draft-store.ts', import.meta.url);
const T0 = Date.parse('2026-10-20T09:00:00Z');
const HOUR = 60 * 60 * 1000;
const DKEY = (userId) => `postona.manual-publish.draft.v1:${userId}`;
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const account = (id, over = {}) => ({
  id, brandId: 'A', platform: 'x', profile: { displayName: `name-${id}`, handle: `@${id}`, avatarColor: '#123456' },
  connectionStatus: 'connected', postingState: 'active', ...over,
});

/** The device storage of the drafts. A held read answers with the value it saw when it was asked, later (ABA). */
function deviceKV() {
  const data = new Map();
  const held = [];
  let hold = false;
  return {
    data,
    hold: (on) => { hold = on; },
    release: () => { while (held.length > 0) held.shift()(); },
    heldCount: () => held.length,
    getItem: (key) => {
      const seen = data.has(key) ? data.get(key) : null;
      return hold ? new Promise((resolve) => held.push(() => resolve(seen))) : Promise.resolve(seen);
    },
    setItem: async (key, value) => { data.set(key, value); },
    removeItem: async (key) => { data.delete(key); },
  };
}

/** MOCK Auth server (see the header): new sign-ins stamp the user's last_sign_in_at, a refresh returns the current one. */
function mockAuth() {
  let t = Date.parse('2026-10-20T08:00:00Z');
  let n = 0;
  const last = new Map();
  const stamp = (id) => { t += 60_000; last.set(id, new Date(t).toISOString()); };
  return {
    /** SIGNED_IN on this device: a new session. */
    signIn(id) { stamp(id); n += 1; return Object.freeze({ access_token: `rig-at-${n}`, session_id: `rig-sid-${n}`, user: Object.freeze({ id, last_sign_in_at: last.get(id) }) }); },
    /** The same person signs in on ANOTHER device: this device's session is untouched until it refreshes. */
    signInElsewhere(id) { stamp(id); },
    /** TOKEN_REFRESHED: same session, new access token, the user object as the server returns it now. */
    refresh(session) { n += 1; return Object.freeze({ ...session, access_token: `rig-at-${n}`, user: Object.freeze({ ...session.user, last_sign_in_at: last.get(session.user.id) }) }); },
    /** A session whose user object has no usable last_sign_in_at (the SDK types it optional). */
    withMark(session, value) {
      const user = { ...session.user };
      if (value === undefined) delete user.last_sign_in_at; else user.last_sign_in_at = value;
      return Object.freeze({ ...session, user: Object.freeze(user) });
    },
  };
}

/**
 * One app process: the real route (keyed by user, as in the app) above the real screen, with a minimal hook runtime.
 * A route key change unmounts the old screen and mounts a new one, like React does. `kv` is the device storage and
 * survives an app restart when passed to the next createApp().
 */
async function createApp({ kv = deviceKV(), source = ROUTE_SOURCE, draftModule = realDraft, accounts = [account('X_A'), account('X_B')], clock = { t: T0 } } = {}) {
  const world = { session: null, accounts, status: 'ready' };
  let current = null;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
  const slot = (init) => { const i = current.cursor++; if (!(i in current.slots)) current.slots[i] = init(); return i; };
  const react = {
    useState: (initial) => {
      const inst = current; const i = slot(() => ({ v: typeof initial === 'function' ? initial() : initial }));
      return [inst.slots[i].v, (next) => { inst.slots[i].v = typeof next === 'function' ? next(inst.slots[i].v) : next; }];
    },
    useReducer: (reducer, arg, init) => {
      const inst = current; const i = slot(() => ({ v: init ? init(arg) : arg }));
      return [inst.slots[i].v, (action) => { inst.slots[i].v = reducer(inst.slots[i].v, action); }];
    },
    useRef: (initial) => current.slots[slot(() => ({ current: initial }))],
    useMemo: (factory, deps) => {
      const inst = current; const i = slot(() => ({ deps: undefined, value: undefined, ready: false }));
      if (!inst.slots[i].ready || !sameDeps(inst.slots[i].deps, deps)) { inst.slots[i].value = factory(); inst.slots[i].deps = deps; inst.slots[i].ready = true; }
      return inst.slots[i].value;
    },
    useEffect: (effect, deps) => {
      const inst = current; const i = slot(() => ({ deps: undefined, cleanup: undefined, ran: false }));
      if (!inst.slots[i].ran || !sameDeps(inst.slots[i].deps, deps)) { inst.slots[i].deps = deps; inst.slots[i].ran = true; inst.pending.push({ i, effect }); }
    },
  };
  const jsx = (type, props, key) => ({ type: typeof type === 'function' ? type.name : type, props, key });
  const stubs = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-router': { Link: 'Link', Stack: { Screen: 'StackScreen' } },
    'expo-crypto': { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '@/constants/theme': { colors: new Proxy({}, { get: (_t, name) => String(name) }), spacing: { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: { muted: true } } },
    '@/features/manual-publish/manual-post-preview': { ManualPostPreview: 'ManualPostPreview' },
    '@/features/manual-publish/manual-publish-flow': { ...realFlow, attemptMemory: realFlow.createAttemptMemory() },
    '@/features/manual-publish/manual-publish-model': model,
    '@/features/manual-publish/manual-publish-port': { ...realPort, getManualPublishPort: () => realPort.getManualPublishPort() },
    '@/features/manual-publish/manual-publish-storage': {
      attemptStore: realStore.createAttemptStore(deviceKV()),
      draftStore: draftModule.createDraftStore(kv),
    },
    '@/features/manual-publish/manual-publish-draft-store': draftModule,
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: world.accounts, activeAccount: world.accounts[0] ?? null }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.session }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status, reason: null, snapshot: null }) },
  };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, Promise, Date, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'manual-publish.tsx' });

  const nowFn = () => clock.t; // stable identity, like Date.now
  let screen = null; // { key, inst, tree }
  const unmount = (inst) => { inst.slots.forEach((s) => s?.cleanup?.()); };
  const renderScreen = () => {
    current = screen.inst; current.cursor = 0;
    try { screen.tree = mod.exports.ManualPublishScreen({ ...screen.element.props, now: nowFn }); } finally { current = null; }
  };
  const sync = async () => {
    if (screen === null) return;
    for (let round = 0; round < 20; round += 1) {
      const element = mod.exports.default({});
      if (screen.key !== element.key) { unmount(screen.inst); screen = { key: element.key, inst: { slots: [], cursor: 0, pending: [] } }; }
      screen.element = element;
      renderScreen();
      await settle();
      if (screen.inst.pending.length === 0) { renderScreen(); if (screen.inst.pending.length === 0) break; }
      const batch = screen.inst.pending.splice(0);
      for (const { i, effect } of batch) {
        const s = screen.inst.slots[i];
        s.cleanup?.();
        const cleanup = effect();
        s.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      }
    }
  };
  const find = (type) => {
    const out = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      if (node.type === type) out.push(node);
      walk(node.props?.children);
    };
    walk(screen.tree);
    return out;
  };
  return {
    kv, clock, world,
    /** An Auth event delivered to the provider: the route re-renders with this session (null = SIGNED_OUT). */
    async auth(session) { world.session = session; await sync(); },
    /** Open the manual post screen (a new mount). */
    async open() { screen = { key: Symbol('none'), inst: { slots: [], cursor: 0, pending: [] } }; await sync(); },
    /** Leave it: a callback route replaces it with the home screen (unmount). */
    leave() { if (screen !== null) unmount(screen.inst); screen = null; },
    async type(text) { find('TextInput')[0].props.onChangeText(text); await sync(); },
    async pickAccount(index) { find('Pressable').filter((n) => n.props.accessibilityRole === 'radio')[index].props.onPress(); await sync(); },
    draft: () => screen.inst.slots[0].v.draft,
    accountId: () => screen.inst.slots[0].v.accountId,
    sync,
    record: (userId) => (kv.data.has(DKEY(userId)) ? JSON.parse(kv.data.get(DKEY(userId))) : null),
  };
}

// ---- scenarios (each returns what it observed; the tests and the negative controls assert on it) --------------------

async function scenarioTokenRefresh(opts) {
  const auth = mockAuth();
  const app = await createApp(opts);
  const s1 = auth.signIn('UA');
  await app.auth(s1);
  await app.open();
  await app.pickAccount(1);
  await app.type('トークン更新をまたぐ下書き');
  app.leave();
  await app.auth(auth.refresh(s1)); // TOKEN_REFRESHED: new access token, same sign-in
  await app.open();
  return { draft: app.draft(), accountId: app.accountId(), record: app.record('UA') };
}

async function scenarioRelogin(opts, { direct = false } = {}) {
  const auth = mockAuth();
  const app = await createApp(opts);
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type('前のセッションの下書き');
  app.leave();
  if (!direct) await app.auth(null); // SIGNED_OUT
  await app.auth(auth.signIn('UA')); // SIGNED_IN again: a new session
  await app.open();
  return { draft: app.draft(), record: app.record('UA') };
}

async function scenarioUserSwitchWhileOpen(opts) {
  const auth = mockAuth();
  const app = await createApp(opts);
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type('Aさんの下書き');
  await app.auth(auth.signIn('UB')); // SIGNED_IN of another person while the screen is open (no SIGNED_OUT first)
  return { draft: app.draft(), recordA: app.record('UA'), recordB: app.record('UB') };
}

async function scenarioAbaSameUser(opts) {
  const auth = mockAuth();
  const kv = deviceKV();
  const app = await createApp({ ...opts, kv });
  const s1 = auth.signIn('UA');
  await app.auth(s1);
  await app.open();
  await app.type('古いセッションの下書き');
  app.leave();
  kv.hold(true); // the next restore read answers late
  await app.open();
  const heldAtSwitch = kv.heldCount();
  await app.auth(auth.signIn('UA')); // a new sign-in of the same person arrives while that read is still pending
  kv.hold(false);
  kv.release();
  await app.sync();
  await app.sync();
  return { heldAtSwitch, draft: app.draft(), record: app.record('UA') };
}

// ---- G2-S: what must hold ---------------------------------------------------------------------------------------------

test('G2-S1 token-only refresh (MOCK: same last_sign_in_at): the draft and the account come back, nothing is removed', async () => {
  const seen = await scenarioTokenRefresh();
  assert.equal(seen.draft, 'トークン更新をまたぐ下書き');
  assert.equal(seen.accountId, 'X_B');
  assert.equal(seen.record?.text, 'トークン更新をまたぐ下書き');
});

test('G2-S2 sign-out then a new sign-in of the same person: nothing comes back and the old text is removed from the device', async () => {
  const seen = await scenarioRelogin();
  assert.equal(seen.draft, '');
  assert.equal(seen.record, null);
});

test('G2-S3 a new sign-in of the same person without a SIGNED_OUT in between (screen closed): nothing comes back, removed', async () => {
  const seen = await scenarioRelogin(undefined, { direct: true });
  assert.equal(seen.draft, '');
  assert.equal(seen.record, null);
});

test('G2-S4 another person signs in while the screen is open: a fresh screen, nothing of A is shown or written under B; A keeps its own record', async () => {
  const seen = await scenarioUserSwitchWhileOpen();
  assert.equal(seen.draft, '');
  assert.equal(seen.recordA?.text, 'Aさんの下書き');
  assert.ok(seen.recordB === null || !String(seen.recordB.text).includes('Aさん'), 'nothing of A under B');
});

test('G2-S5 app restart with the stored session (INITIAL_SESSION / recovered SIGNED_IN, user object as stored): restored', async () => {
  const auth = mockAuth();
  const first = await createApp();
  const s1 = auth.signIn('UA');
  await first.auth(s1);
  await first.open();
  await first.type('再起動をまたぐ下書き');
  first.leave();
  const second = await createApp({ kv: first.kv }); // a new process, same device storage
  await second.auth(s1); // auth-js 2.115.0 _recoverAndRefresh: a valid stored session is announced as it was stored
  await second.open();
  assert.equal(second.draft(), '再起動をまたぐ下書き');
});

test('G2-S6 ABA: a restore read that answers after a NEW sign-in of the same person is not applied; the record is removed', async () => {
  const seen = await scenarioAbaSameUser();
  assert.equal(seen.heldAtSwitch, 1, 'the restore read was pending when the new sign-in arrived');
  assert.equal(seen.draft, '');
  assert.equal(seen.record, null);
});

test('G2-S7 ABA: a restore read that answers after ANOTHER person signed in (or after sign-out) shows nothing', async () => {
  for (const next of ['other', 'signed-out']) {
    const auth = mockAuth();
    const kv = deviceKV();
    const app = await createApp({ kv });
    await app.auth(auth.signIn('UA'));
    await app.open();
    await app.type('Aさんの古い下書き');
    app.leave();
    kv.hold(true);
    await app.open();
    assert.equal(kv.heldCount(), 1, next);
    await app.auth(next === 'other' ? auth.signIn('UB') : null);
    kv.hold(false);
    kv.release();
    await app.sync();
    await app.sync();
    assert.equal(app.draft(), '', next);
    assert.equal(app.record('UB'), null, next);
  }
});

test('G2-S8 a last_sign_in_at that cannot be a mark (not a string, longer than 64) is never restored -- fail closed', async () => {
  for (const bad of [0, 'x'.repeat(65)]) {
    const auth = mockAuth();
    const app = await createApp();
    const s = auth.withMark(auth.signIn('UA'), bad);
    await app.auth(s);
    await app.open();
    await app.type('壊れた印の下書き');
    app.leave();
    await app.auth(s); // even the SAME session
    await app.open();
    assert.equal(app.draft(), '', String(bad));
  }
});

// ---- FINDINGS (pass while the gap exists) -------------------------------------------------------------------------------

test('FINDING G2-SM1 (P3, owner G1 route / G5 auth): with no last_sign_in_at the mark is "" for every session, so a NEW sign-in of the same person gets the old draft back', async () => {
  for (const missing of [undefined, null, '']) {
    const auth = mockAuth();
    const app = await createApp();
    await app.auth(auth.withMark(auth.signIn('UA'), missing));
    await app.open();
    await app.type('印のない下書き');
    app.leave();
    await app.auth(null);
    await app.auth(auth.withMark(auth.signIn('UA'), missing)); // a new session, still no mark
    await app.open();
    assert.equal(app.draft(), '印のない下書き', `restored across sessions (${String(missing)}): the gap still exists`);
    assert.equal(app.record('UA').sessionMark, '');
  }
});

test('FINDING G2-SM2 (P3, MOCK server semantics): the same person signing in on ANOTHER device makes this device lose its draft at the next refresh / restart', async () => {
  // while the screen stays closed: refresh after the other sign-in
  {
    const auth = mockAuth();
    const app = await createApp();
    const s1 = auth.signIn('UA');
    await app.auth(s1);
    await app.open();
    await app.type('この端末の下書き');
    app.leave();
    auth.signInElsewhere('UA');
    await app.auth(auth.refresh(s1)); // same session on THIS device
    await app.open();
    assert.equal(app.draft(), '', 'discarded although this device never signed out');
    assert.equal(app.record('UA'), null);
  }
  // restart with an expired token: auth-js refreshes during recovery and announces the server's user object
  {
    const auth = mockAuth();
    const first = await createApp();
    const s1 = auth.signIn('UA');
    await first.auth(s1);
    await first.open();
    await first.type('再起動前の下書き');
    first.leave();
    auth.signInElsewhere('UA');
    const second = await createApp({ kv: first.kv });
    await second.auth(auth.refresh(s1));
    await second.open();
    assert.equal(second.draft(), '');
  }
});

test('FINDING G2-SM3 (P3, owner G1): a new sign-in of the same person while the screen stays mounted keeps the open text and re-saves it under the NEW mark', async () => {
  const auth = mockAuth();
  const app = await createApp();
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type('開いたままの下書き');
  const s2 = auth.signIn('UA'); // SIGNED_IN without SIGNED_OUT: the route key (user id) does not change
  await app.auth(s2);
  assert.equal(app.draft(), '開いたままの下書き', 'the screen was not re-created');
  await app.type('開いたままの下書き。'); // one more keystroke
  assert.equal(app.record('UA').sessionMark, s2.user.last_sign_in_at, 'saved under the new session');
  app.leave();
  await app.open();
  assert.equal(app.draft(), '開いたままの下書き。', 'and it comes back in the new session');
});

test('FINDING G2-SM4 (P3, owner G1 / G5): signing out leaves the text on the device, and "24 hours" is only checked when the same person reads it again', async () => {
  const auth = mockAuth();
  const clock = { t: T0 };
  const app = await createApp({ clock });
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type('共有端末に残る本文');
  app.leave();
  await app.auth(null); // SIGNED_OUT
  await app.auth(auth.signIn('UB'));
  await app.open();
  await app.type('Bさん');
  app.leave();
  clock.t += 48 * HOUR;
  await app.open(); // B again, two days later
  assert.equal(app.record('UA')?.text, '共有端末に残る本文', 'A\'s text is still stored in plain text after sign-out and after 48 hours');
});

// ---- negative controls: each mutation must be caught by a G2-S scenario --------------------------------------------------

function mutate(source, from, to) {
  const count = source.split(from).length - 1;
  assert.equal(count, 1, `the mutation target occurs exactly once: ${from.slice(0, 60)}`);
  return source.replace(from, to);
}

async function mutatedDraftModule(from, to) {
  const dir = await mkdtemp(join(tmpdir(), 'g2-draft-mut-'));
  const original = await readFile(DRAFT_URL, 'utf8');
  const absolute = (rel) => new URL(rel, DRAFT_URL).href;
  let text = mutate(original, from, to);
  for (const rel of ['./single-post-contract.ts', './manual-publish-store.ts', '../../domain/types.ts']) text = text.split(`'${rel}'`).join(`'${absolute(rel)}'`);
  const file = join(dir, 'manual-publish-draft-store.mutant.ts');
  await writeFile(file, text);
  try {
    return await import(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('negative controls: route without the per-user key, a constant mark, a restore without its cancel check, and a store that ignores the mark each LEAK the old text in the very scenario that passes unmutated', async () => {
  // Each mutant must run to the end and show the specific leak (not merely throw), and the same scenario on the real
  // code must show none.
  const noKey = { source: mutate(ROUTE_SOURCE, "key={userId ?? 'signed-out'}", 'key="one-screen"') };
  assert.equal((await scenarioUserSwitchWhileOpen(noKey)).draft, 'Aさんの下書き', "no per-user key: B is shown A's text");
  assert.equal((await scenarioUserSwitchWhileOpen()).draft, '');

  const constMark = { source: mutate(ROUTE_SOURCE, "sessionMark={session?.user.last_sign_in_at ?? ''}", "sessionMark={''}") };
  assert.equal((await scenarioRelogin(constMark)).draft, '前のセッションの下書き', 'constant mark: a re-login gets the old draft');
  assert.equal((await scenarioRelogin()).draft, '');

  const noCancel = {
    source: mutate(ROUTE_SOURCE, "if (cancelled || !mountedRef.current) return;\n      if (decision.kind === 'restore')", "if (!mountedRef.current) return;\n      if (decision.kind === 'restore')"),
  };
  assert.equal((await scenarioAbaSameUser(noCancel)).draft, '古いセッションの下書き', 'no cancel check: the late answer of the old session wins');
  assert.equal((await scenarioAbaSameUser()).draft, '');

  const ignoresMark = { draftModule: await mutatedDraftModule("if (record.sessionMark !== now.sessionMark) return { kind: 'discard', reason: 'other_session' };", '') };
  const leaked = await scenarioRelogin(ignoresMark);
  assert.equal(leaked.draft, '前のセッションの下書き', 'store ignores the mark: a re-login gets the old draft');
  assert.equal(leaked.record?.text, '前のセッションの下書き');
});
