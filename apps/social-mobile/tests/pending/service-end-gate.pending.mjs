// PENDING acceptance specs for the POSTONA service-end gates G1 / G2 (F4 design task
// postona-f4-service-end-auth-gate-g1-g2-design-20261016; design: docs/postona-service-end-gate-g1-g2-design.md).
// NOT part of `npm test` (`node --test tests/*.test.mjs`). Run: `node --test tests/pending/service-end-gate.pending.mjs`.
// The specs marked [SPEC] FAIL on PR221 dcae62c6 (fail-before) and must pass once the owners implement the design;
// the [CONTROL] ones hold before and after. The names of the proposed seams (ServiceLifecycleProvider,
// useServiceLifecycleEpoch, useServiceLifecycle, ServiceLifecycleSurface) are the proposal and may be renamed with the
// spec. Synthetic sessions, transport and screen only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { Buffer } from 'node:buffer';
import ts from 'typescript';
import * as enrollmentModule from '../../src/domain/service-enrollment.ts';
import * as account from '../../src/domain/account-deletion.ts';
import * as endDomain from '../../src/domain/postona-service-end.ts';
import * as notices from '../../src/domain/postona-end-notices.ts';
import * as flows from '../../src/domain/auth-flows.ts';
import * as recovery from '../../src/domain/recovery-binding.ts';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFile(join(root, path), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

// Synthetic unsigned tokens with only the claims the client reads (sub, session_id): person X's login N.
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const loginUuid = (user, login) => `00000000-0000-4000-8000-${String(user.charCodeAt(0)).padStart(6, '0')}${String(login).padStart(6, '0')}`;
const tokenOf = (user, login = 1, refresh = 0) => `${b64url({ alg: 'none' })}.${b64url({ sub: `user-${user}`, session_id: loginUuid(user, login), iat: refresh })}.unsigned`;
const sessionOf = (user, login = 1, refresh = 0) => ({ access_token: tokenOf(user, login, refresh), user: { id: `user-${user}`, identities: [{ provider: 'email' }] } });
const ACTIVE = { body: { status: 'active', service: 'x_autopost', started: true, shared_account: false } };
const ENDED = (version) => ({ body: { status: 'reenroll_required', service: 'x_autopost', lifecycle_version: version } });

/** A fake PostgREST endpoint: records every RPC with the token it carried; answers can be held. */
function fakeServer(answer) {
  const requests = []; const held = [];
  const fetchImpl = (url, init) => {
    const entry = { fn: String(url).split('/rpc/')[1], token: init.headers.Authorization.replace(/^Bearer /u, '') };
    requests.push(entry);
    const reply = answer(entry);
    const respond = (value) => ({ ok: value.ok ?? true, status: value.status ?? 200, json: async () => value.body });
    if (reply === 'hold') return new Promise((resolve) => { held.push({ entry, release: (value) => resolve(respond(value)) }); });
    return Promise.resolve(respond(reply));
  };
  return { requests, held, fetchImpl };
}

/** A hook runtime for ONE component (dependency-tracked effects with cleanups). */
function hooks() {
  const slots = []; let cursor = 0; let pending = [];
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    createContext: (value) => ({ Provider: 'ContextProvider', value }),
    useContext: (context) => context.value,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; const s = slots[i]; return [s.value, (n) => { s.value = typeof n === 'function' ? n(s.value) : n; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo(factory, deps) { const i = cursor++; if (slots[i] && same(slots[i].deps, deps)) return slots[i].value; slots[i] = { deps, value: factory() }; return slots[i].value; },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { const prev = slots[i]; slots[i] = { deps, cleanup: prev?.cleanup }; pending.push({ i, effect }); } },
  };
  return {
    react,
    run(component, props) {
      cursor = 0; pending = [];
      const tree = component(props);
      for (const { i, effect } of pending) { slots[i].cleanup?.(); const c = effect(); slots[i].cleanup = typeof c === 'function' ? c : undefined; }
      return tree;
    },
    unmount() { for (const s of slots) if (s && typeof s.cleanup === 'function') s.cleanup(); },
  };
}
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); walk(n.props?.children, out); } return out; };

/** The proposed identity-bound lifecycle signal: one counter per person (never a token, never an outcome). */
function lifecycleSignal() {
  const epochs = new Map();
  return { epochs, bump: (userId) => epochs.set(userId, (epochs.get(userId) ?? 0) + 1) };
}

async function gateHarness(server, lifecycle) {
  const h = hooks();
  let session = null;
  const modules = {
    react: h.react,
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
    // Proposed (F4-owned) seam the gate subscribes to.
    '@/features/service-lifecycle/service-lifecycle': {
      useServiceLifecycleEpoch: (userId) => (userId ? lifecycle.epochs.get(userId) ?? 0 : 0),
      useServiceLifecycle: () => ({ openFor: null, open() {}, close() {}, bump: lifecycle.bump }),
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(transpile(await read('src/features/service-enrollment/service-enrollment-gate.tsx')), { module, exports: module.exports, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; } });
  const original = globalThis.fetch; globalThis.fetch = server.fetchImpl;
  const APP = { type: 'APP' };
  let tree = null;
  const render = () => { tree = h.run(module.exports.ServiceEnrollmentGate, { children: APP }); return tree; };
  return {
    setSession(next) { session = next; },
    render,
    async settle() { for (let i = 0; i < 6; i += 1) { await flush(); render(); } return tree; },
    isApp: () => walk(tree).includes(APP) || tree === APP,
    button: (label) => walk(tree).find((n) => n.type === 'ActionButton' && n.props.label === label) ?? null,
    done() { h.unmount(); globalThis.fetch = original; },
  };
}

// ------------------------------------------------------------------------------------ G1: the gate asks again

test('[SPEC G1 / F5 gate] a lifecycle signal for the person signed in makes the gate ask the server again; the answer decides', async () => {
  let ended = false;
  const server = fakeServer(() => (ended ? ENDED(4) : ACTIVE));
  const lifecycle = lifecycleSignal();
  const g = await gateHarness(server, lifecycle);
  try {
    g.setSession(sessionOf('A', 1)); await g.settle();
    assert.equal(g.isApp(), true);
    ended = true;                 // POSTONA ended for A (the end surface saw an answered end of A)
    lifecycle.bump('user-A');
    await g.settle();
    assert.equal(server.requests.length, 2, 'exactly one server-authenticated re-ask');
    assert.deepEqual(server.requests[1], { fn: 'start_x_autopost_service', token: tokenOf('A', 1) }, 'the automatic start with the CURRENT login\'s token (never a restart)');
    assert.equal(g.isApp(), false, 'the server\'s reenroll_required closes the app');
    assert.ok(g.button('利用登録する'), 'the person sees the re-enrollment screen, restarted only by their own click');
  } finally { g.done(); }
});

test('[SPEC G1 / F5 gate] while the re-ask is pending the app is not usable; an `active` answer opens it again', async () => {
  let hold = false;
  const server = fakeServer(() => (hold ? 'hold' : ACTIVE));
  const lifecycle = lifecycleSignal();
  const g = await gateHarness(server, lifecycle);
  try {
    g.setSession(sessionOf('A', 1)); await g.settle();
    hold = true; lifecycle.bump('user-A'); await g.settle();
    assert.equal(server.held.length, 1, 'the re-ask was sent');
    assert.equal(g.isApp(), false, 'the signal alone never keeps the app open (fail closed until the server answers)');
    server.held[0].release(ACTIVE); await g.settle();
    assert.equal(g.isApp(), true, 'only the server\'s answer opens it again');
  } finally { g.done(); }
});

test('[CONTROL G1] a signal for another person, or after sign-out, sends nothing and changes nothing', async () => {
  const server = fakeServer(() => ACTIVE);
  const lifecycle = lifecycleSignal();
  const g = await gateHarness(server, lifecycle);
  try {
    g.setSession(sessionOf('A', 1)); await g.settle();
    lifecycle.bump('user-B'); await g.settle();
    assert.equal(server.requests.length, 1); assert.equal(g.isApp(), true);
    g.setSession(sessionOf('A', 1, 1)); await g.settle();   // a token refresh of the same login
    assert.equal(server.requests.length, 1, 'a refresh is not a lifecycle change');
  } finally { g.done(); }
});

// ------------------------------------------------------------------------------------ G2: the surface outside

test('[SPEC G2 / layout] the service-end surface is hosted OUTSIDE the per-login gate, inside the signed-in root', async () => {
  const layout = await read('src/app/_layout.tsx');
  const provider = layout.indexOf('<ServiceLifecycleProvider>');
  const gateEnd = layout.indexOf('</ServiceEnrollmentGate>');
  const surface = layout.indexOf('<ServiceLifecycleSurface />');
  assert.ok(provider > -1, 'a signed-in root provider for the lifecycle surface and signal');
  assert.ok(provider < layout.indexOf('<ServiceEnrollmentGate>'), 'the provider is above the gate');
  assert.ok(surface > gateEnd, 'the surface is a sibling after the gate, so a new login of the same person does not unmount it');
  assert.ok(layout.indexOf('if (!session) return <AuthScreen />') < provider, 'only signed-in sessions reach it');
  const gate = await read('src/features/service-enrollment/service-enrollment-gate.tsx');
  assert.doesNotMatch(gate, /<AccountDeletionScreen \/>/u, 'the gate opens the surface instead of rendering its own copy');
});

test('[CONTROL G2 / S1 unchanged] a new login of the same person still closes the gated app until its own answer', async () => {
  const server = fakeServer((entry) => (entry.token === tokenOf('A', 2) ? 'hold' : ACTIVE));
  const g = await gateHarness(server, lifecycleSignal());
  try {
    g.setSession(sessionOf('A', 1)); await g.settle();
    assert.equal(g.isApp(), true);
    g.setSession(sessionOf('A', 2)); await g.settle();      // what re-authentication produces
    assert.equal(g.isApp(), false, 'A1\'s open state is not A2\'s (reviewed S1 property, kept)');
    server.held[0].release(ACTIVE); await g.settle();
    assert.equal(g.isApp(), true);
  } finally { g.done(); }
});

test('[SPEC G2 / F4 surface] the surface opened for a person survives that person\'s new login and closes for anyone else', async () => {
  const source = await read('src/features/service-lifecycle/service-lifecycle-surface.tsx');   // fails before: not there yet
  const h = hooks();
  let session = sessionOf('A', 1);
  const state = { openFor: 'user-A', closed: 0 };
  const modules = {
    react: h.react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', Modal: 'Modal' },
    '@/constants/theme': { colors: {}, typography: {} },
    '@/components/ui': { styles: {} },
    '@/providers/auth-provider': { useAuth: () => ({ session }) },
    '@/app/account-deletion': { __esModule: true, default: 'AccountDeletionScreen' },
    '@/features/service-lifecycle/service-lifecycle': { useServiceLifecycle: () => ({ openFor: state.openFor, open(u) { state.openFor = u; }, close() { state.openFor = null; state.closed += 1; }, bump() {} }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(transpile(source), { module, exports: module.exports, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; } });
  const render = () => h.run(module.exports.ServiceLifecycleSurface, {});
  const shows = (tree) => walk(tree).some((n) => n.type === 'AccountDeletionScreen');
  assert.equal(shows(render()), true);
  session = sessionOf('A', 2); render(); await flush();   // re-authentication: a new login of the same person
  assert.equal(shows(render()), true, 'the in-progress end survives the person\'s own new login');
  session = sessionOf('B', 1); render(); await flush();
  assert.equal(shows(render()), false, 'another person never sees it');
  assert.equal(state.openFor, null, 'and it is closed, not merely hidden');
  h.unmount();
});

// ------------------------------------------------------------------------------------ G1: the screen signals

const jwt = (id, sid) => ({ user: { id, identities: [{ provider: 'email' }] }, access_token: `synthetic.${Buffer.from(JSON.stringify({ session_id: sid })).toString('base64url')}.signature` });

async function screenHarness(endAnswer) {
  const h = hooks();
  const ctx = { userId: 'u1', sessionId: 's1' };
  const bound = { ok: true, accountStatus: 'active', lifecycleVersion: 7, services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status: 'active' }], acknowledgementRequired: ['threads'], postonaAvailable: true, deletionInProgress: false, context: ctx };
  const bumps = [];
  const auth = { session: jwt('u1', 's1'), backendAvailable: true, email: { signIn: true }, readiness: () => ({ usableNow: true }),
    reauthenticate: async () => ({ ok: true, context: ctx }), previewPostonaEnd: async () => bound, endPostonaService: async () => endAnswer };
  const modules = {
    react: h.react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    'react-native': Object.fromEntries(['ActivityIndicator', 'Linking', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View', 'Modal'].map((n) => [n, n])),
    '@/constants/theme': { colors: {}, typography: {} }, '@/components/ui': { Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/domain/account-deletion': account, '@/domain/postona-service-end': { ...endDomain, POSTONA_END_SOURCE_ENABLED: true }, '@/domain/postona-end-notices': notices,
    '@/domain/auth-flows': flows, '@/domain/recovery-binding': recovery, '@/domain/legal-links': { LEGAL_LINK_LABELS: {} },
    '@/lib/legal-config': { LEGAL_LINKS: { support: {} } }, '@/providers/auth-provider': { useAuth: () => auth },
    '@/features/service-lifecycle/service-lifecycle': { useServiceLifecycle: () => ({ openFor: 'u1', open() {}, close() {}, bump: (userId) => bumps.push(userId) }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(transpile(await read('src/app/account-deletion.tsx')), { module, exports: module.exports, require: (n) => { assert.ok(Object.hasOwn(modules, n), n); return modules[n]; } });
  const render = () => h.run(module.exports.default, {});
  const texts = (tree) => walk(tree).filter((n) => n.type === 'Text').map((n) => [n.props.children].flat(Infinity).filter((s) => typeof s === 'string').join(''));
  const button = (tree, label) => walk(tree).find((n) => n.type === 'Pressable' && walk(n.props.children).some((c) => c.type === 'Text' && [c.props.children].flat(Infinity).join('').includes(label)));
  async function submitEnd() {
    render(); await flush();
    walk(render()).find((n) => n.type === 'TextInput' && n.props.secureTextEntry).props.onChangeText('synthetic');
    await button(render(), 'で本人確認').props.onPress(); await flush();
    walk(render()).find((n) => n.type === 'TextInput' && !n.props.secureTextEntry).props.onChangeText(endDomain.POSTONA_END_CONFIRM_PHRASE);
    walk(render()).find((n) => n.type === 'Pressable' && n.props.accessibilityRole === 'checkbox').props.onPress();
    assert.equal(bumps.length, 0, 'nothing is signalled before an end was sent');
    await button(render(), 'POSTONAの利用を終了').props.onPress(); await flush();
    return texts(render());
  }
  return { submitEnd, bumps, done: () => h.unmount() };
}

test('[SPEC G1 / F4 screen] an answered end of the person signals exactly that person once; the result stays visible', async () => {
  const ended = endDomain.parseEndResult(200, { ok: true, outcome: 'ended', providers: { x: 'done', threads: 'local_removed_remote_unverified' }, remote_unverified: ['threads'], x_posts_unconfirmed: 2 }, ['threads']);
  for (const answer of [ended, endDomain.endFailure('RESULT_UNCONFIRMED', undefined, { remoteUnverified: ['threads'], xPostsUnconfirmed: 2 })]) {
    const s = await screenHarness(answer);
    const shown = await s.submitEnd();
    assert.deepEqual(s.bumps, ['u1'], `${answer.ok ? 'ended' : answer.code}: one identity-bound signal (the server re-ask decides)`);
    assert.ok(shown.some((line) => line.includes('予約が2件')), 'the person still sees their own warnings');
    s.done();
  }
});
