// H5 #14: real account surfaces, React/RN and identity reads stubbed. No network or auth writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as xWrite from '../src/features/reservations/x-write-view.ts';
import * as signal from '../src/features/reservations/x-reconnect-signal.ts';
import * as accountSecurity from '../src/domain/account-security.ts';
import * as authFlows from '../src/domain/auth-flows.ts';
import * as authRelease from '../src/domain/auth-release-readiness.ts';
import * as legal from '../src/domain/legal-links.ts';

const account = (patch = {}) => ({ id: 'x-one', brandId: 'u_me', platform: 'x', connectionStatus: 'connected', profile: { displayName: 'fixture', handle: '@fixture', voice: { tone: '', language: '', avoid: [] } }, ...patch });
const walk = (node, visit) => { if (Array.isArray(node)) return node.forEach((n) => walk(n, visit)); if (!node || typeof node !== 'object') return; visit(node); walk(node.props?.children, visit); };
const text = (tree) => { const out = []; walk(tree, (n) => { for (const c of [n.props?.children].flat()) if (typeof c === 'string') out.push(c); }); return out.join('\n'); };
const pills = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'Pill') out.push({ label: n.props.children, tone: n.props.tone }); }); return out; };
const linePill = (tree, title) => { let result; walk(tree, (n) => { const c = [n.props?.children].flat(); if (n.type === 'View' && c.some((v) => v?.type === 'Text' && v.props.children === title)) { const p = c.find((v) => v?.type === 'Pill'); if (p) result = { label: p.props.children, tone: p.props.tone }; } }); return result; };
const settle = () => new Promise((resolve) => setImmediate(resolve));
test.beforeEach(() => { signal.clearAllXReconnectRequired(); signal.clearXServiceRestarted('surface-user'); });

async function mount(path, { selected = account(), status = 'ready' } = {}) {
  const slots = []; let cursor = 0; const effects = []; const world = { account: selected, status, authWrites: 0 };
  const slot = (make) => { const i = cursor++; if (!(i in slots)) slots[i] = make(); return i; };
  const react = {
    useState: (value) => { const i = slot(() => value); return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useCallback: (fn) => fn,
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, j) => !Object.is(v, slots[i][j]))) { slots[i] = deps; effects.push(fn); } },
  };
  const stubs = {
    react, 'react/jsx-runtime': { jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), jsxs: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }) },
    'expo-router': { useLocalSearchParams: () => ({ id: world.account?.id }), useRouter: () => ({ push() {} }) },
    'react-native': { Text: 'Text', View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator', Linking: {} },
    '@/constants/theme': { colors: {} }, '@/components/ui': { Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', ActionButton: 'ActionButton', styles: {} },
    '@/features/publish-setting/publish-setting-card': { PublishSettingCard: 'PublishSettingCard' },
    // G4 PR 617's Threads cards (RC #42): mounted as names, never run here.
    '@/features/threads-connect/threads-connect-card': { ThreadsConnectCard: 'ThreadsConnectCard' },
    '@/features/threads-disconnect/threads-disconnect-card': { ThreadsDisconnectCard: 'ThreadsDisconnectCard' },
    '@/features/threads-publish/threads-publish-card': { ThreadsPublishCard: 'ThreadsPublishCard' },
    '@/features/x-connect/use-x-connect': { useXConnect: () => ({ state: 'idle', stateText: '', verifiedHandle: null, connect() { throw new Error('no OAuth'); } }) },
    '@/features/reservations/x-write-view': xWrite,
    '@/features/reservations/x-reconnect-signal': { ...signal, useXReconnectSignal: () => 0 },
    '@/features/personal-workspace/personal-workspace-provider': { usePersonalWorkspace: () => ({ view: { kind: 'ready', workspaceId: 'u_me' } }) },
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: world.account ? [world.account] : [], activeAccount: world.account, selectAccount() {} }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status, reload() {} }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: { user: { id: 'surface-user' } }, readiness: () => ({ usableNow: true }), email: { reset: false }, accountDeletion: 'not_available', linkProvider() { world.authWrites++; throw new Error('no auth write'); }, requestPasswordReset() { world.authWrites++; throw new Error('no auth write'); } }) },
    '@/domain/account-security': accountSecurity, '@/domain/auth-flows': authFlows, '@/domain/auth-release-readiness': authRelease, '@/domain/legal-links': legal,
    '@/lib/legal-config': { LEGAL_LINKS: { privacy: {}, terms: {}, support: {} } },
    '@/lib/supabase': { supabase: { auth: { getUserIdentities: async () => ({ data: { identities: ['x', 'apple', 'google'].map((provider) => ({ provider, identity_id: provider })) }, error: null }) } } },
  };
  const js = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, Promise, __DEV__: false, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } });
  const render = async () => { let tree; for (let i = 0; i < 4; i++) { cursor = 0; tree = mod.exports.default(); effects.splice(0).forEach((fn) => fn()); await settle(); } return tree; };
  return { world, render };
}

test('H5-14 P2 detail cold start: a stored X connection is unverified, never green proof', async () => {
  const h = await mount('../src/app/accounts/[id].tsx'); const tree = await h.render();
  assert.ok(pills(tree).some((p) => p.label === xWrite.X_CONNECTION_UNVERIFIED_LABEL && p.tone === 'warning'));
  assert.ok(!pills(tree).some((p) => p.label === '接続済み' && p.tone === 'success'));
});

test('H5-14 P2 login methods: posting X is unverified, authenticated login links stay linked', async () => {
  const h = await mount('../src/app/login-methods.tsx'); const tree = await h.render();
  assert.deepEqual(linePill(tree, '投稿用のX接続'), { label: xWrite.X_CONNECTION_UNVERIFIED_LABEL, tone: 'warning' });
  assert.deepEqual(linePill(tree, 'Xでログイン'), { label: '利用中', tone: 'success' });
  assert.equal(pills(tree).filter((p) => p.label === '利用中' && p.tone === 'success').length, 4, 'X + Apple + Google login rows and the separate X-login line');
  assert.equal(h.world.authWrites, 0);
});

test('H5-14 P2 surface states: reconnect, explicit disconnect, unknown, preview and non-X keep their meanings', async () => {
  for (const [connectionStatus, expected] of [['not_connected', '未接続'], ['needs_attention', '要再接続'], [undefined, '確認できません'], ['mystery', '確認できません']]) {
    for (const path of ['../src/app/accounts/[id].tsx', '../src/app/login-methods.tsx']) {
      const h = await mount(path, { selected: account({ connectionStatus }) }); const tree = await h.render();
      assert.ok(pills(tree).some((p) => p.label === expected && p.tone !== 'success'), `${path}: ${connectionStatus}`);
    }
  }
  signal.markXReconnectRequired('x-one');
  const detail = await mount('../src/app/accounts/[id].tsx'); const login = await mount('../src/app/login-methods.tsx');
  assert.ok(pills(await detail.render()).some((p) => p.label === '再接続が必要'));
  assert.equal(linePill(await login.render(), '投稿用のX接続').label, '再接続が必要');
  signal.clearAllXReconnectRequired();
  signal.markXServiceRestarted('surface-user');
  assert.ok(pills(await detail.render()).some((p) => p.label === '要確認'));
  assert.equal(linePill(await login.render(), '投稿用のX接続').label, '要確認');
  signal.clearXServiceRestarted('surface-user');
  for (const options of [{ status: 'mock_preview' }, { selected: account({ platform: 'threads' }) }]) {
    const h = await mount('../src/app/accounts/[id].tsx', options); assert.ok(pills(await h.render()).some((p) => p.label === '接続済み' && p.tone === 'success'));
  }
  const loading = await mount('../src/app/login-methods.tsx', { status: 'loading' });
  assert.equal(linePill(await loading.render(), '投稿用のX接続').label, '確認できません');
  const previewLogin = await mount('../src/app/login-methods.tsx', { status: 'mock_preview' });
  assert.equal(linePill(await previewLogin.render(), '投稿用のX接続').label, '確認できません', 'a demo is not a real authenticated posting connection');
});

test('RC #42 G4 PR 617 + H5 #633 on the account screens: Threads keeps its cards, X keeps the unverified display', async () => {
  const kinds = (tree) => { const out = []; walk(tree, (n) => { if (typeof n.type === 'string' && n.type.startsWith('Threads')) out.push(n.type); }); return out; };
  let tree = await (await mount('../src/app/accounts/[id].tsx', { selected: account({ id: 'th-one', platform: 'threads', connectionStatus: 'not_connected' }) })).render();
  assert.deepEqual(kinds(tree), ['ThreadsPublishCard', 'ThreadsConnectCard']);
  tree = await (await mount('../src/app/accounts/[id].tsx', { selected: account({ id: 'th-one', platform: 'threads' }) })).render();
  assert.deepEqual(kinds(tree), ['ThreadsPublishCard'], 'a connected Threads account is not offered a connect');
  tree = await (await mount('../src/app/accounts/[id].tsx')).render();
  assert.deepEqual(kinds(tree), [], 'no Threads card on an X account');
  assert.ok(pills(tree).some((p) => p.label === xWrite.X_CONNECTION_UNVERIFIED_LABEL && p.tone === 'warning'));
  tree = await (await mount('../src/app/accounts/index.tsx')).render();
  assert.deepEqual(kinds(tree), ['ThreadsConnectCard', 'ThreadsDisconnectCard'], 'the list keeps G4\'s Threads connect and disconnect');
  assert.match(text(tree), /現在の接続は未確認/u);
});

test('H5-14 mutation accounts_unverified_line: the list explains what is not verified', async () => {
  const h = await mount('../src/app/accounts/index.tsx');
  const shown = text(await h.render());
  assert.match(shown, /現在の接続は未確認/u);
  assert.match(shown, /その操作時にサーバーが判断/u);
});
