// F4+F5 joint integration of the POSTONA service-end gates G1 / G2 (postona-f4-f5-service-end-g1-g2-joint-integration-
// 20261017): F4 PR236 (ServiceLifecycleProvider, ServiceLifecycleSurface, the end screen's bump, layout, entry points)
// assembled with F5 PR235 (the ServiceEnrollmentGate's epoch refresh) through F5's seam, now connected.
// Everything below is the REAL source, transpiled and rendered together through one hook runtime: the provider, the
// connected seam (lifecycle-epoch.ts re-exporting the provider's hook), the gate, the surface and the end screen; the
// layout is rendered to show where each sits. Only Auth, the end request and PostgREST are synthetic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as enrollmentDomain from '../src/domain/service-enrollment.ts';
import * as account from '../src/domain/account-deletion.ts';
import * as endDomain from '../src/domain/postona-service-end.ts';
import * as notices from '../src/domain/postona-end-notices.ts';
import * as flows from '../src/domain/auth-flows.ts';
import * as recovery from '../src/domain/recovery-binding.ts';
import { fakeServer, flush, loginUuid, sessionOf as gateSessionOf, tokenOf } from './support/enrollment-harness.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(join(root, path), 'utf8');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); walk(n.props?.children, out); } return out; };
const textOf = (n) => [n.props?.children].flat(Infinity).filter((s) => typeof s === 'string').join('');
const ACTIVE = { body: { status: 'active', service: 'x_autopost', started: false, shared_account: false } };
const ENDED = (version) => ({ body: { status: 'reenroll_required', service: 'x_autopost', lifecycle_version: version } });
const ENDED_BODY = { ok: true, outcome: 'ended', providers: { x: 'done', threads: 'local_removed_remote_unverified' }, remote_unverified: ['threads'], x_posts_unconfirmed: 2 };
const sessionOf = (user, login = 1, refresh = 0) => ({ ...gateSessionOf(user, login, refresh), user: { id: `user-${user}`, identities: [{ provider: 'email' }] } });
const contextOf = (user, login) => ({ userId: `user-${user}`, sessionId: loginUuid(user, login) });

/** One hook runtime shared by several component instances (each with its own hooks), and context objects. */
function runtime() {
  let active = null;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    createContext: (value) => { const context = { Provider: { context: null }, current: value }; context.Provider.context = context; return context; },
    useContext: (context) => context.current,
    useState: (...a) => active.useState(...a), useRef: (...a) => active.useRef(...a), useMemo: (...a) => active.useMemo(...a),
    useCallback: (...a) => active.useCallback(...a), useEffect: (...a) => active.useEffect(...a),
  };
  const provide = (tree) => { for (const node of walk(tree)) if (node.type?.context) node.type.context.current = node.props.value; };
  function instance() {
    const slots = []; let cursor = 0; let pending = [];
    const self = {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; const s = slots[i]; return [s.value, (n) => { s.value = typeof n === 'function' ? n(s.value) : n; }]; },
      useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useMemo(factory, deps) { const i = cursor++; if (slots[i] && same(slots[i].deps, deps)) return slots[i].value; slots[i] = { deps, value: factory() }; return slots[i].value; },
      useCallback(callback, deps) { return self.useMemo(() => callback, deps); },
      useEffect(effect, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { const prev = slots[i]; slots[i] = { deps, cleanup: prev?.cleanup }; pending.push({ i, effect }); } },
      render(component, props) {
        const previous = active; active = self; cursor = 0; pending = [];
        let tree;
        try { tree = component(props); } finally { active = previous; }
        provide(tree);
        for (const { i, effect } of pending) { slots[i].cleanup?.(); const c = effect(); slots[i].cleanup = typeof c === 'function' ? c : undefined; }
        return tree;
      },
      unmount() { for (const s of slots) if (s && typeof s.cleanup === 'function') s.cleanup(); },
    };
    return self;
  }
  return { react, instance };
}

/** The assembled app: provider -> (gate around APP, surface -> end screen), sharing one synthetic Auth. */
async function assemble({ answer = () => ACTIVE, endAnswer = () => endDomain.parseEndResult(200, ENDED_BODY, ['threads']), user = 'A' } = {}) {
  const rt = runtime();
  const jsxRuntime = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'Fragment' };
  const load = (source, modules) => {
    const module = { exports: {} };
    vm.runInNewContext(transpile(source), { module, exports: module.exports, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; } });
    return module.exports;
  };
  const server = fakeServer((entry) => answer(entry));
  const ends = [];
  const auth = {
    session: sessionOf(user, 1), backendAvailable: true, email: { signIn: true }, readiness: () => ({ usableNow: true }),
    rotateOnReauth: false,
    reauthenticate: async () => {
      // Re-authentication signs in again: a new login (session id) of the same person when rotating.
      const id = auth.session.user.id.replace('user-', ''); const login = Number(JSON.parse(Buffer.from(auth.session.access_token.split('.')[1], 'base64url')).session_id.slice(-6));
      if (auth.rotateOnReauth) auth.session = sessionOf(id, login + 1);
      return { ok: true, context: contextOf(id, auth.rotateOnReauth ? login + 1 : login) };
    },
    previewPostonaEnd: async () => {
      const claims = JSON.parse(Buffer.from(auth.session.access_token.split('.')[1], 'base64url'));
      return { ok: true, accountStatus: 'active', lifecycleVersion: 7, services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status: 'active' }], acknowledgementRequired: ['threads'], postonaAvailable: true, deletionInProgress: false, context: { userId: auth.session.user.id, sessionId: claims.session_id } };
    },
    endPostonaService: async (input) => { ends.push(input); const a = endAnswer(input); if (a instanceof Error) throw a; return a; },
  };
  const authModule = { useAuth: () => auth };
  const rn = Object.fromEntries(['ActivityIndicator', 'Linking', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map((n) => [n, n]));
  const lifecycle = load(await read('src/features/service-lifecycle/service-lifecycle.tsx'), { react: rt.react, 'react/jsx-runtime': jsxRuntime, '@/providers/auth-provider': authModule });
  const seam = load(await read('src/features/service-enrollment/lifecycle-epoch.ts'), { '@/features/service-lifecycle/service-lifecycle': lifecycle });
  const screenModule = load(await read('src/app/account-deletion.tsx'), {
    react: rt.react, 'react/jsx-runtime': jsxRuntime, 'react-native': rn,
    '@/constants/theme': { colors: {} }, '@/components/ui': { Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/domain/account-deletion': account, '@/domain/postona-service-end': { ...endDomain, POSTONA_END_SOURCE_ENABLED: true }, '@/domain/postona-end-notices': notices,
    '@/domain/auth-flows': flows, '@/domain/recovery-binding': recovery, '@/domain/legal-links': { LEGAL_LINK_LABELS: {} },
    '@/lib/legal-config': { LEGAL_LINKS: { support: {} } }, '@/providers/auth-provider': authModule, '@/features/service-lifecycle/service-lifecycle': lifecycle,
  });
  const surfaceModule = load(await read('src/features/service-lifecycle/service-lifecycle-surface.tsx'), {
    react: rt.react, 'react/jsx-runtime': jsxRuntime, 'react-native': rn, '@/constants/theme': { colors: {} },
    '@/app/account-deletion': screenModule, '@/features/service-lifecycle/service-lifecycle': lifecycle,
  });
  const gateModule = load(await read('src/features/service-enrollment/service-enrollment-gate.tsx'), {
    react: rt.react, 'react/jsx-runtime': jsxRuntime, 'react-native': rn,
    '@/constants/theme': { colors: {}, typography: {} }, '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/components/sign-out-button': { SignOutButton: 'SignOutButton' }, '@/data/repository-selection': { selectDataSource: () => ({ kind: 'supabase' }) },
    '@/domain/service-enrollment': enrollmentDomain,
    '@/lib/supabase': { getSupabaseConfig: () => ({ ok: true, config: { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' } }) },
    '@/providers/auth-provider': authModule, '@/features/service-enrollment/lifecycle-epoch': seam, '@/features/service-lifecycle/service-lifecycle': lifecycle,
  });
  const originalFetch = globalThis.fetch; globalThis.fetch = server.fetchImpl;
  const APP = { type: 'APP' };
  const provider = rt.instance(); let gate = rt.instance(); const surface = rt.instance();
  let screen = null; let screenKey = null;
  const view = { gate: null, surface: null, screen: null };
  function frame() {
    provider.render(lifecycle.ServiceLifecycleProvider, { children: null });
    view.gate = gate.render(gateModule.ServiceEnrollmentGate, { children: APP });
    view.surface = surface.render(surfaceModule.ServiceLifecycleSurface, {});
    const element = view.surface ? walk(view.surface).find((n) => n.type === screenModule.default) : null;
    if (element && (screen === null || screenKey !== element.key)) { screen?.unmount(); screen = rt.instance(); screenKey = element.key; }
    if (!element && screen) { screen.unmount(); screen = null; screenKey = null; }
    view.screen = screen ? screen.render(screenModule.default, {}) : null;
    return view;
  }
  async function settle(rounds = 8) { for (let i = 0; i < rounds; i += 1) { await flush(); frame(); } return view; }
  const screenText = () => walk(view.screen).filter((n) => n.type === 'Text' || n.type === 'Pill').map(textOf);
  const pressable = (tree, label) => walk(tree).find((n) => n.type === 'Pressable' && walk(n.props.children).some((c) => c.type === 'Text' && textOf(c).includes(label)));
  async function endFlow({ rotate = false } = {}) {
    auth.rotateOnReauth = rotate;
    await settle();
    walk(view.screen).find((n) => n.type === 'TextInput' && n.props.secureTextEntry).props.onChangeText('synthetic');
    frame();
    await pressable(view.screen, 'で本人確認').props.onPress(); await settle();
    walk(view.screen).find((n) => n.type === 'TextInput' && !n.props.secureTextEntry).props.onChangeText(endDomain.POSTONA_END_CONFIRM_PHRASE);
    frame();
    walk(view.screen).find((n) => n.type === 'Pressable' && n.props.accessibilityRole === 'checkbox').props.onPress();
    frame();
    const submit = pressable(view.screen, 'POSTONAの利用を終了');
    assert.ok(submit && !submit.props.disabled, 'the end can be sent');
    return submit.props.onPress();
  }
  frame(); await settle();
  return {
    auth, server, ends, view, frame, settle, endFlow, screenText, pressable, APP, lifecycle,
    api: () => lifecycle.useServiceLifecycle(),
    epoch: (userId) => lifecycle.useServiceLifecycleEpoch(userId),
    isApp: () => view.gate === APP || walk(view.gate).includes(APP),
    gateButton: (label) => walk(view.gate).find((n) => n.type === 'ActionButton' && n.props.label === label) ?? null,
    remountGate() { gate.unmount(); gate = rt.instance(); },
    done() { screen?.unmount(); surface.unmount(); gate.unmount(); provider.unmount(); globalThis.fetch = originalFetch; },
  };
}

// --------------------------------------------------------------------------------------------- G1, assembled

test('G1 assembled: ended -> one bump -> the gate closes at once -> re-asks with the current login -> stays closed on reenroll_required', async () => {
  let ended = false; let hold = false;
  const a = await assemble({ answer: () => (hold ? 'hold' : ended ? ENDED(8) : ACTIVE) });
  try {
    assert.equal(a.isApp(), true, 'precondition: open for A');
    assert.equal(a.api().open('user-A'), true); a.frame();
    assert.ok(a.view.screen, 'the end screen is shown by the surface, outside the gate');
    ended = true; hold = true;
    // (onPress is `() => void submit()`: the end's answer and the bump land on the following turns)
    await a.endFlow(); await a.settle();
    assert.equal(a.epoch('user-A'), 1, 'exactly one bump for the pinned person');
    assert.equal(a.isApp(), false, 'the old ready is discarded at once (fail closed before any answer)');
    assert.equal(a.server.held.length, 1, 'one re-ask is on its way');
    assert.deepEqual({ fn: a.server.held[0].entry.fn, token: a.server.held[0].entry.token }, { fn: 'start_x_autopost_service', token: tokenOf('A', 1) }, 'the automatic start with the CURRENT login\'s token');
    hold = false; a.server.held[0].release(ENDED(8)); await a.settle();
    assert.equal(a.isApp(), false, 'reenroll_required keeps the app closed');
    assert.ok(a.gateButton('利用登録する'), 'the re-enrollment screen; restarted only by the person\'s own click');
    assert.ok(a.view.screen, 'the surface is still open above it');
    assert.ok(a.screenText().some((line) => line.includes('予約が2件')), 'and the person still sees their own result and warnings');
    assert.deepEqual([...new Set(a.server.requests.map((r) => r.fn))], ['start_x_autopost_service'], 'no reactivate (no automatic re-enrollment), nothing about another service (かぶモリ)');
    assert.ok(a.server.requests.every((r) => JSON.stringify(r.body) === '{}'), 'no user id, verdict or token in any body');
  } finally { a.done(); }
});

test('G1 assembled: already_ended also bumps once; not_registered, unconfirmed, refused and thrown answers never do', async () => {
  const already = endDomain.parseEndResult(200, { ...ENDED_BODY, outcome: 'already_ended' }, ['threads']);
  const quiet = [
    endDomain.parseEndResult(200, { ok: true, outcome: 'not_registered' }, ['threads']),
    endDomain.endFailure('RESULT_UNCONFIRMED', undefined, { remoteUnverified: ['threads'], xPostsUnconfirmed: 2 }),
    endDomain.endFailure('WITHDRAW_BLOCKED'),
    new Error('synthetic transport failure'),
  ];
  for (const [answer, bumps] of [[already, 1], ...quiet.map((q) => [q, 0])]) {
    const a = await assemble({ endAnswer: () => answer });
    try {
      a.api().open('user-A'); a.frame();
      await a.endFlow(); await a.settle();
      const label = answer instanceof Error ? 'thrown' : answer.ok ? answer.outcome : answer.code;
      assert.equal(a.ends.length, 1, label);
      assert.equal(a.epoch('user-A'), bumps, `${label}: ${bumps} bump(s)`);
      assert.equal(a.server.requests.length, 1 + bumps, `${label}: ${bumps} re-ask(s)`);
    } finally { a.done(); }
  }
});

test('G1 assembled: a late answer from before the signal never opens the app', async () => {
  let first = true;
  const a = await assemble({ answer: () => (first ? 'hold' : ENDED(9)) });
  try {
    assert.equal(a.isApp(), false); assert.equal(a.server.held.length, 1, 'the first automatic start is still on its way');
    first = false;
    assert.equal(a.api().bump('user-A'), true); await a.settle();
    assert.equal(a.server.requests.length, 2, 'the signal asks again');
    a.server.held[0].release(ACTIVE); await a.settle();   // the pre-signal answer arrives late
    assert.equal(a.isApp(), false, 'the stale `active` never opens it');
    assert.ok(a.gateButton('利用登録する'), 'the current answer (reenroll_required) is what shows');
  } finally { a.done(); }
});

test('G1 assembled: a failed re-ask (500 / offline) stays closed with a manual retry; the retry asks again and never restarts', async () => {
  for (const failure of [{ ok: false, status: 500, body: { message: 'boom' } }, 'offline']) {
    let mode = 'active';
    const a = await assemble({ answer: () => (mode === 'fail' ? failure : mode === 'ended' ? ENDED(5) : ACTIVE) });
    try {
      mode = 'fail'; a.api().bump('user-A'); await a.settle();
      assert.equal(a.isApp(), false, `${failure.status ?? failure}: closed`);
      const retry = a.gateButton('再読み込み'); assert.ok(retry, 'a manual retry is offered');
      mode = 'ended'; retry.props.onPress(); await a.settle();
      assert.equal(a.isApp(), false); assert.ok(a.gateButton('利用登録する'));
      assert.ok(a.server.requests.every((r) => r.fn === 'start_x_autopost_service'), 'never a reactivate');
    } finally { a.done(); }
  }
});

test('G1 assembled: a bump for another person is refused and changes nothing; a gate remount does not open the surface', async () => {
  const a = await assemble();
  try {
    assert.equal(a.api().bump('user-B'), false); await a.settle();
    assert.equal(a.server.requests.length, 1); assert.equal(a.isApp(), true);
    a.remountGate(); await a.settle();
    assert.equal(a.api().openFor, null, 'remounting the gate never mounts the surface');
    assert.equal(a.view.screen, null);
  } finally { a.done(); }
});

// --------------------------------------------------------------------------------------------- G2, assembled

test('G2 assembled: re-authentication rotates the login; the gate closes for the new login (S1) while the surface keeps the flow, which ends on the new login', async () => {
  let ended = false;
  const a = await assemble({ answer: () => (ended ? ENDED(8) : ACTIVE) });
  try {
    a.api().open('user-A'); a.frame();
    await a.settle();
    walk(a.view.screen).find((n) => n.type === 'TextInput' && !n.props.secureTextEntry).props.onChangeText(endDomain.POSTONA_END_CONFIRM_PHRASE);   // typed for login 1
    a.frame();
    const sent = a.endFlow({ rotate: true });
    await sent; await a.settle();
    assert.equal(a.ends.length, 1, 'the end was sent: the flow survived the re-authentication');
    assert.deepEqual(a.ends[0].context, contextOf('A', 2), 'pinned to the NEW login');
    assert.deepEqual(a.ends[0].preview.context, contextOf('A', 2), 'with a preview read for the new login');
    assert.ok(a.server.requests.some((r) => r.token === tokenOf('A', 2)), 'the gate asked for the new login itself (S1)');
    assert.equal(a.epoch('user-A'), 1);
    ended = true;   // (the server's state after the end; the re-ask below reads it)
    a.api().bump('user-A'); await a.settle();
    assert.equal(a.server.requests.at(-1).token, tokenOf('A', 2), 'every re-ask uses the current login');
    assert.equal(a.isApp(), false); assert.ok(a.view.screen, 'the surface stays open with the result');
  } finally { a.done(); }
});

test('G2 assembled: another person or sign-out closes the surface and discards the old person\'s state; a late bump of the old person is refused', async () => {
  const a = await assemble();
  try {
    a.api().open('user-A'); a.frame();
    const stale = a.api();
    a.auth.session = sessionOf('B', 1); await a.settle();
    assert.equal(a.api().openFor, null); assert.equal(a.view.screen, null, 'B never sees A\'s end screen');
    assert.equal(stale.bump('user-A'), false, 'A\'s late signal is refused');
    assert.equal(a.server.requests.at(-1).token, tokenOf('B', 1), 'the gate asks for B itself');
    a.auth.session = sessionOf('A', 3); await a.settle();
    assert.equal(a.api().openFor, null, 'coming back as A does not reopen it');
  } finally { a.done(); }
});

test('G2 assembled: the gate\'s management entry (closed states) opens F4\'s outside surface; the gate draws no end screen of its own (J2 V2 P2-1; was: an embedded copy)', async () => {
  const a = await assemble({ answer: () => ENDED(4) });
  try {
    assert.equal(a.isApp(), false); assert.ok(a.gateButton('利用登録する'));
    const link = walk(a.view.gate).find((n) => n.type === 'Pressable' && textOf(walk(n.props.children).find((c) => c.type === 'Text') ?? {}).includes('利用終了・共通IDの管理'));
    link.props.onPress(); a.frame();
    assert.equal(a.api().openFor, 'user-A', 'the entry asks the provider to open for the person signed in');
    assert.ok(a.view.screen, 'the end screen is drawn by the surface, outside the gate');
    assert.ok(!walk(a.view.gate).some((n) => typeof n.type === 'function'), 'and the gate\'s own tree holds no screen element');
  } finally { a.done(); }
});

// --------------------------------------------------------------------------------------------- routing, rendered

test('routing (rendered): the signed-in root is provider > [gate > data > onboarding > accounts > Stack, surface]', async () => {
  const rt = runtime();
  const jsx = (type, props, key) => ({ type, props, key });
  const named = (name) => Object.defineProperty(function component() { return null; }, 'name', { value: name });
  const parts = Object.fromEntries(['AuthProvider', 'ActiveAccountProvider', 'DataProvider', 'OnboardingGate', 'ServiceEnrollmentGate', 'ServiceLifecycleProvider', 'ServiceLifecycleSurface', 'AuthScreen', 'NewPasswordScreen'].map((n) => [n, named(n)]));
  const Stack = Object.assign(named('Stack'), { Screen: named('StackScreen') });
  const state = { loading: false, session: sessionOf('A', 1), recoveryMode: false };
  const module = { exports: {} };
  vm.runInNewContext(transpile(await read('src/app/_layout.tsx')), { module, exports: module.exports, require: (n) => ({
    'expo-router': { Stack }, 'expo-status-bar': { StatusBar: 'StatusBar' }, 'react-native': { ActivityIndicator: 'ActivityIndicator', Text: 'Text', View: 'View' },
    '@/constants/theme': { colors: {} }, '@/components/auth-screen': { AuthScreen: parts.AuthScreen }, '@/components/new-password-screen': { NewPasswordScreen: parts.NewPasswordScreen },
    '@/providers/auth-provider': { AuthProvider: parts.AuthProvider, useAuth: () => state }, '@/providers/active-account-provider': { ActiveAccountProvider: parts.ActiveAccountProvider },
    '@/providers/data-provider': { DataProvider: parts.DataProvider }, '@/features/onboarding/onboarding-gate': { OnboardingGate: parts.OnboardingGate },
    '@/features/service-enrollment/service-enrollment-gate': { ServiceEnrollmentGate: parts.ServiceEnrollmentGate },
    '@/features/service-lifecycle/service-lifecycle': { ServiceLifecycleProvider: parts.ServiceLifecycleProvider },
    '@/features/service-lifecycle/service-lifecycle-surface': { ServiceLifecycleSurface: parts.ServiceLifecycleSurface },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
  })[n] ?? assert.fail(`unexpected import ${n}`) });
  const rootTree = rt.instance().render(module.exports.default, {});
  const signedIn = walk(rootTree).find((n) => typeof n.type === 'function' && n.type.name === 'SignedInApp');
  assert.ok(signedIn, 'RootLayout renders SignedInApp inside AuthProvider');
  const tree = rt.instance().render(signedIn.type, {});
  assert.equal(tree.type, parts.ServiceLifecycleProvider, 'the provider is the signed-in root');
  const [gate, surface] = [tree.props.children].flat();
  assert.equal(gate.type, parts.ServiceEnrollmentGate); assert.equal(surface.type, parts.ServiceLifecycleSurface, 'the surface is the gate\'s sibling, outside what it remounts');
  const chain = []; let node = gate; while (node && typeof node.type === 'function') { chain.push(node.type.name); node = [node.props.children].flat()[0]; }
  assert.deepEqual(chain, ['ServiceEnrollmentGate', 'DataProvider', 'OnboardingGate', 'ActiveAccountProvider', 'Stack', 'StackScreen'], 'the routes stay inside the gate');
  state.session = null;
  assert.equal(rt.instance().render(signedIn.type, {}).type, parts.AuthScreen, 'signed out: none of it is mounted');
  state.session = sessionOf('A', 1); state.recoveryMode = true;
  assert.equal(rt.instance().render(signedIn.type, {}).type, parts.NewPasswordScreen, 'password recovery: none of it is mounted');
});
