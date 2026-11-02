// The real onboarding-gate.tsx (transpiled) rendered with stubbed React/RN/data.
// Proves account deletion stays reachable from every unfinished onboarding state,
// without Home, and that the deletion view is per user and truthful.
import * as xSignal from '../src/features/reservations/x-reconnect-signal.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as onboarding from '../src/domain/onboarding.ts';
import * as flows from '../src/domain/auth-flows.ts';

const account = (connectionStatus, extra = {}) => ({ id: 'sa_1', brandId: 'u_1', handle: 'h', connectionStatus, lastConnectionErrorCode: null, ...extra });
const loaded = (over) => ({ kind: 'loaded', brandIds: ['u_1'], xAccounts: [account('identity_verified')], settings: 'not_saved', settingsDeferred: false, ...over });

const STATES = {
  loading: { kind: 'loading' },
  error: { kind: 'error', reason: 'x' },
  connect_x: loaded({ brandIds: [], xAccounts: [] }),
  connect_x_resume: loaded({ xAccounts: [account('connected')] }),
  reconnect_x: loaded({ xAccounts: [account('failed')] }),
  ambiguous: loaded({ brandIds: ['u_1', 'u_2'] }),
  settings: loaded({}),
};

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node);
  // Expand plain function components (the gate's own helpers); their output is part of the screen.
  if (typeof node.fn === 'function' && !['Screen', 'Card'].includes(node.type)) {
    try { walk(node.fn(node.props ?? {}), visit); } catch { /* hooks-using components are not expanded */ }
  }
  walk(node.props?.children, visit);
};
const texts = (tree) => { const out = []; walk(tree, (n) => { if (['Text', 'ActionText', 'SectionTitle'].includes(n.type)) out.push([n.props.children].flat().filter((c) => typeof c === 'string').join('')); }); return out; };
const pressables = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'Pressable' && typeof n.props.onPress === 'function') out.push(n); }); return out; };
const label = (node) => texts(node).join('');

async function gateHarness({ input, userId = 'user-1', acknowledged = false, identities = [{ provider: 'email' }], connectState = 'idle' }) {
  const slots = []; let cursor = 0, first = true;
  const effects = [];
  const react = {
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useEffect: (effect) => { if (first) effects.push(effect); },
    useCallback: (cb) => cb,
    useMemo: (factory) => factory(),
  };
  const state = { userId, input, identities, connectState };
  const stubs = {
    react, 'react/jsx-runtime': { jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, fn: type, props }), jsxs: (type, props) => ({ type: typeof type === 'function' ? type.name : type, fn: type, props }) },
    '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: async () => null, setItem: async () => {} } },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    '@/constants/theme': { colors: { primary: 'p', border: 'b', muted: 'm' }, typography: { caption: {}, title: {} } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: {}, button: {}, buttonPressed: {}, buttonText: {} } },
    '@/components/sign-out-button': { SignOutButton: () => null },
    '@/data/repository-selection': { selectDataSource: () => ({ kind: 'supabase' }) },
    '@/data/onboarding-repository': { SupabaseOnboardingRepository: class { async read() { return { userId: state.userId, input: state.input }; } } },
    '@/domain/onboarding': onboarding,
    '@/domain/auth-flows': flows,
    '@/providers/auth-provider': { useAuth: () => ({ session: { user: { id: state.userId, identities: state.identities } } }) },
    '@/features/reservations/x-reconnect-signal': xSignal,
    '@/features/x-connect/use-x-connect': { useXConnect: () => ({ state: state.connectState ?? 'idle', stateText: '', verifiedHandle: null, connect: async () => {} }) },
    '@/lib/supabase': { supabase: {} },
    '@/providers/data-provider': { useDataStatus: () => ({ reload() {} }) },
    // The deletion screen is stubbed to prove WHICH component is shown; it never needs Home providers.
    '@/app/account-deletion': { __esModule: true, default: function AccountDeletionScreen() { return null; } },
  };
  const source = await readFile(new URL('../src/features/onboarding/onboarding-gate.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'onboarding-gate.tsx' });
  const CHILD = { type: 'HomeMarker', props: {} };
  const render = () => { cursor = 0; return module.exports.OnboardingGate({ children: CHILD }); };
  render(); first = false; effects.forEach((effect) => effect());
  await new Promise((resolve) => setImmediate(resolve));
  if (acknowledged) state.acknowledged = true;
  const reload = async () => { effects.forEach((effect) => effect()); await new Promise((resolve) => setImmediate(resolve)); };
  return { render, state, reload, isHome: (tree) => tree === CHILD || tree?.props?.children === CHILD };
}

const entryOf = (tree) => pressables(tree).find((p) => label(p).includes('アカウントの削除について'));

test('every unfinished onboarding state exposes the deletion entry (never Home)', async () => {
  for (const [name, input] of Object.entries(STATES)) {
    const harness = await gateHarness({ input });
    const tree = harness.render();
    assert.equal(harness.isHome(tree), false, name);
    assert.ok(entryOf(tree), `${name}: deletion entry present`);
    assert.ok(pressables(tree).length >= 1);
  }
});

test('the new-account notice also exposes the entry', async () => {
  const harness = await gateHarness({ input: loaded({ brandIds: [], xAccounts: [] }), identities: [{ provider: 'x' }] });
  const tree = harness.render();
  assert.ok(texts(tree).some((t) => t.includes('新しいアカウントを作成しました')), 'notice shown');
  assert.ok(entryOf(tree), 'entry on the notice screen');
});

test('the entry opens the deletion screen without Home, and 戻る returns to onboarding', async () => {
  const harness = await gateHarness({ input: STATES.connect_x });
  entryOf(harness.render()).props.onPress();
  const open = harness.render();
  assert.equal(harness.isHome(open), false);
  let shown = false;
  walk(open, (n) => { if (n.type === 'AccountDeletionScreen') shown = true; });
  assert.ok(shown, 'account deletion screen rendered');
  const back = pressables(open).find((p) => label(p).includes('戻る'));
  assert.ok(back);
  back.props.onPress();
  const again = harness.render();
  let stillShown = false;
  walk(again, (n) => { if (n.type === 'AccountDeletionScreen') stillShown = true; });
  assert.equal(stillShown, false);
  assert.ok(entryOf(again));
});

test('the deletion view is per user: another user never inherits it', async () => {
  const harness = await gateHarness({ input: STATES.connect_x, userId: 'user-1' });
  entryOf(harness.render()).props.onPress();
  harness.state.userId = 'user-2';
  const tree = harness.render();
  let shown = false;
  walk(tree, (n) => { if (n.type === 'AccountDeletionScreen') shown = true; });
  assert.equal(shown, false, 'user-2 does not see user-1\'s deletion view');
});

test('finished onboarding still renders the app (the entry lives in the route/account area)', async () => {
  const harness = await gateHarness({ input: loaded({ settingsDeferred: true }) });
  assert.equal(harness.isHome(harness.render()), true);
});

test('the deletion screen needs no Home providers, so it works before Home and keeps its guards', async () => {
  const screen = await readFile(new URL('../src/app/account-deletion.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(screen, /data-provider|active-account-provider|useDataStatus|useActiveAccount/u);
  assert.match(screen, /accountDeletion !== 'available'|!enabled/u, 'feature-off state stays truthful');
  assert.match(screen, /sameDeletionContext/u, 'session pinning unchanged');
  assert.match(screen, /reauthenticate\(/u, 'recent-auth unchanged');
  assert.match(screen, /ACCOUNT_DELETION_CONFIRM_PHRASE/u, 'typed confirmation unchanged');
  const gate = await readFile(new URL('../src/features/onboarding/onboarding-gate.tsx', import.meta.url), 'utf8');
  assert.equal((gate.match(/<DeletionEntry onOpen=\{openDeletion\} \/>/gu) ?? []).length, 2, 'both non-Home screens carry the entry');
});

const openApp = (tree) => { let found = null; walk(tree, (n) => { if (n.type === 'ActionButton' && n.props.label === '接続せずにアプリを開く') found = n; }); return found; };

test('T35 connection steps of an existing account offer the app; the choice is this user\'s and goes away with another; a first connection and the other steps never offer it', async () => {
  for (const status of ['disconnected', 'failed', 'authorization_pending']) {
    const h = await gateHarness({ input: loaded({ xAccounts: [account(status)] }) });
    assert.equal(h.isHome(h.render()), false, status);
    const button = openApp(h.render());
    assert.ok(button, status);
    button.props.onPress();
    assert.equal(h.isHome(h.render()), true, `${status}: the app opens`);
    h.state.userId = 'user-2';
    assert.equal(h.isHome(h.render()), false, 'another person, still loading');
    await h.reload();
    const other = h.render();
    assert.ok(openApp(other), 'another person, loaded: the same step');
    assert.equal(h.isHome(other), false, 'another person does not inherit the choice');
  }
  for (const name of ['connect_x', 'settings']) {
    const h = await gateHarness({ input: STATES[name] });
    assert.equal(openApp(h.render()), null, name);
  }
});

test('T37 a connect from the connection step answers a refusal and a restart, like the accounts screen; another state does not', async () => {
  xSignal.markXReconnectRequired('acc');
  xSignal.markXServiceRestarted('user-1');
  let h = await gateHarness({ input: loaded({ xAccounts: [account('unconnected')] }) });
  assert.equal(xSignal.isXServiceRestarted('user-1'), true, 'idle');
  assert.equal(xSignal.isXReconnectRequired('acc'), true);
  h = await gateHarness({ input: loaded({ xAccounts: [account('unconnected')] }), connectState: 'connected' });
  assert.equal(xSignal.isXServiceRestarted('user-1'), false);
  assert.equal(xSignal.isXReconnectedAfterRestart('user-1'), true);
  assert.equal(xSignal.isXReconnectRequired('acc'), false);
  assert.ok(h);
});

test('T36 measured on the real runtime: a real disconnect leaves unconnected; the step does not say a connection was left unfinished, and the app can be opened', async () => {
  const h = await gateHarness({ input: loaded({ xAccounts: [account('unconnected')] }) });
  const tree = h.render();
  assert.ok(texts(tree).some((t) => t.includes('現在接続されていません')));
  assert.equal(texts(tree).some((t) => t.includes('完了していません')), false);
  assert.ok(openApp(tree));
});

test('T35 measured on iOS 27: the gate clears the status bar; the login form makes room for the keyboard', async () => {
  const gate = await readFile(new URL('../src/features/onboarding/onboarding-gate.tsx', import.meta.url), 'utf8');
  assert.equal(gate.match(/<ScrollView contentInsetAdjustmentBehavior="always"/gu)?.length, 2);
  const login = await readFile(new URL('../src/components/auth-screen.tsx', import.meta.url), 'utf8');
  assert.match(login, /<ScrollView automaticallyAdjustKeyboardInsets/u);
  assert.doesNotMatch(login, /KeyboardAvoidingView/u, 'not both: they push the form twice');
});
