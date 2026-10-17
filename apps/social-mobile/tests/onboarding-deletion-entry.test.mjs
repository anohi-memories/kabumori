// The real onboarding-gate.tsx (transpiled) rendered with stubbed React/RN/data.
// Proves account deletion stays reachable from every unfinished onboarding state,
// without Home, and that the entry opens the service-lifecycle surface (outside the
// enrollment gate) for the person signed in only.
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

async function gateHarness({ input, userId = 'user-1', acknowledged = false, identities = [{ provider: 'email' }] }) {
  const slots = []; let cursor = 0, first = true;
  const effects = [];
  const react = {
    useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useEffect: (effect) => { if (first) effects.push(effect); },
    useCallback: (cb) => cb,
    useMemo: (factory) => factory(),
  };
  const state = { userId, input, identities, opened: [] };
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
    '@/features/x-connect/use-x-connect': { useXConnect: () => ({ state: 'idle', stateText: '', verifiedHandle: null, connect: async () => {} }) },
    '@/lib/supabase': { supabase: {} },
    '@/providers/data-provider': { useDataStatus: () => ({ reload() {} }) },
    // The surface is opened through the lifecycle provider (its own tests cover who it opens for).
    '@/features/service-lifecycle/service-lifecycle': { useServiceLifecycle: () => ({ openFor: null, open: (person) => { state.opened.push(person); return person === state.userId; }, close() {}, bump: () => false }) },
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
  return { render, state, isHome: (tree) => tree === CHILD || tree?.props?.children === CHILD };
}

const entryOf = (tree) => pressables(tree).find((p) => label(p).includes('利用終了・共通IDの管理'));

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

test('the entry opens the service-lifecycle surface for the person signed in, without Home; onboarding stays behind it', async () => {
  const harness = await gateHarness({ input: STATES.connect_x });
  entryOf(harness.render()).props.onPress();
  assert.deepEqual(harness.state.opened, ['user-1']);
  const after = harness.render();
  assert.equal(harness.isHome(after), false);
  let embedded = false;
  walk(after, (n) => { if (n.type === 'AccountDeletionScreen') embedded = true; });
  assert.equal(embedded, false, 'no in-gate copy that a new login (re-authentication) would destroy');
  assert.ok(entryOf(after), 'the entry is still there when the surface is closed');
});

test('the entry always opens for the CURRENT person: after a switch it never opens for the previous one', async () => {
  const harness = await gateHarness({ input: STATES.connect_x, userId: 'user-1' });
  entryOf(harness.render()).props.onPress();
  harness.state.userId = 'user-2';
  entryOf(harness.render()).props.onPress();
  assert.deepEqual(harness.state.opened, ['user-1', 'user-2']);
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
  assert.match(screen, /POSTONA_END_CONFIRM_PHRASE/u, 'typed confirmation unchanged');
  const gate = await readFile(new URL('../src/features/onboarding/onboarding-gate.tsx', import.meta.url), 'utf8');
  assert.equal((gate.match(/<DeletionEntry onOpen=\{openDeletion\} \/>/gu) ?? []).length, 2, 'both non-Home screens carry the entry');
});
