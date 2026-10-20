// G2 QA (Issue #317, task postona-g2-pr400-x-manual-n2-uncertain-result-regression-qa-20261021) -- QA only, no product code.
// Limited re-QA of G1 PR #400 (N2: demo `mock_preview` data never sends; only dataStatus === 'ready' opens the gate; the
// readiness is asked only for real data) with the REAL route + screen + model + flow + stores, MOCK sessions and a
// scripted future send port. Offline: no network, no X, no token.
//
// G1's seven N2 tests already pin the gate itself (demo with a ready port, every non-ready status, re-ask on demo,
// readiness only for real data). This file adds the cross-over they do not: a send that is OUT when the data stops
// being ready, a true result that must still be shown, the copy of a demo confirmation, and the data-source default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as model from '../src/features/manual-publish/manual-publish-model.ts';
import * as realFlow from '../src/features/manual-publish/manual-publish-flow.ts';
import * as realPort from '../src/features/manual-publish/manual-publish-port.ts';
import * as realStore from '../src/features/manual-publish/manual-publish-store.ts';
import * as realDraft from '../src/features/manual-publish/manual-publish-draft-store.ts';
import { dataSourceMode, initialDataStatusFor } from '../src/data/data-source-mode.ts';

const ROUTE_SOURCE = await readFile(new URL('../src/app/manual-publish.tsx', import.meta.url), 'utf8');
const MODEL_URL = new URL('../src/features/manual-publish/manual-publish-model.ts', import.meta.url);
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const SUCCESS_WORDS = ['Xが投稿を受け付けました', '投稿されました', '投稿しました', '送信しました', '送信済み'];
const READY_LINE = 'サーバーで送信できる状態を確認できました。';
const DEMO_LINE = 'デモ用（ローカルプレビュー）のデータのため、送信できません。';
const NOT_READY_LINE = 'アカウント情報を確認できないため、送信できません。';
const T1 = '2026-10-20T08:00:00.000000Z';
const session = (id) => ({ access_token: 'rig-at-1', user: { id, last_sign_in_at: T1 } });
const account = (id) => ({ id, brandId: 'A', platform: 'x', profile: { displayName: `name-${id}`, handle: `@${id}`, avatarColor: '#123456' }, connectionStatus: 'connected', postingState: 'active' });
function kv() { const data = new Map(); return { data, getItem: async (k) => (data.has(k) ? data.get(k) : null), setItem: async (k, v) => { data.set(k, v); }, removeItem: async (k) => { data.delete(k); } }; }
function scriptedPort() {
  const sends = [];
  const checks = [];
  return { sends, checks, port: { checkReadiness: async (accountId) => { checks.push(accountId); return { kind: 'ready' }; }, send: (target) => new Promise((resolve) => { sends.push({ target, resolve }); }) } };
}

async function createApp({ port, source = ROUTE_SOURCE, modelModule = model, status = 'ready' } = {}) {
  const world = { session: null, accounts: [account('X_A'), account('X_B')], status };
  const store = realStore.createAttemptStore(kv());
  const draftStore = realDraft.createDraftStore(kv());
  let current = null;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
  const slot = (init) => { const i = current.cursor++; if (!(i in current.slots)) current.slots[i] = init(); return i; };
  const react = {
    useState: (initial) => { const inst = current; const i = slot(() => ({ v: typeof initial === 'function' ? initial() : initial })); return [inst.slots[i].v, (next) => { inst.slots[i].v = typeof next === 'function' ? next(inst.slots[i].v) : next; }]; },
    useReducer: (reducer, arg, init) => { const inst = current; const i = slot(() => ({ v: init ? init(arg) : arg })); return [inst.slots[i].v, (action) => { inst.slots[i].v = reducer(inst.slots[i].v, action); }]; },
    useRef: (initial) => current.slots[slot(() => ({ current: initial }))],
    useMemo: (factory, deps) => { const inst = current; const i = slot(() => ({ deps: undefined, value: undefined, ready: false })); if (!inst.slots[i].ready || !sameDeps(inst.slots[i].deps, deps)) { inst.slots[i].value = factory(); inst.slots[i].deps = deps; inst.slots[i].ready = true; } return inst.slots[i].value; },
    useEffect: (effect, deps) => { const inst = current; const i = slot(() => ({ deps: undefined, cleanup: undefined, ran: false })); if (!inst.slots[i].ran || !sameDeps(inst.slots[i].deps, deps)) { inst.slots[i].deps = deps; inst.slots[i].ran = true; inst.pending.push({ i, effect }); } },
  };
  const jsx = (type, props, key) => ({ type: typeof type === 'function' ? type.name : type, props, key });
  let ids = 0;
  const stubs = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-router': { Link: 'Link', Stack: { Screen: 'StackScreen' } },
    'expo-crypto': { randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '@/constants/theme': { colors: new Proxy({}, { get: (_t, name) => String(name) }), spacing: { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: { muted: true } } },
    '@/features/manual-publish/manual-post-preview': { ManualPostPreview: 'ManualPostPreview' },
    '@/features/manual-publish/manual-publish-flow': { ...realFlow, attemptMemory: realFlow.createAttemptMemory() },
    '@/features/manual-publish/manual-publish-model': modelModule,
    '@/features/manual-publish/manual-publish-port': { ...realPort, getManualPublishPort: () => port },
    '@/features/manual-publish/manual-publish-storage': { attemptStore: store, draftStore },
    '@/features/manual-publish/manual-publish-draft-store': realDraft,
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: world.accounts, activeAccount: world.accounts[0] ?? null }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.session }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status, reason: null, snapshot: null }) },
  };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, Promise, Date, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'manual-publish.tsx' });
  let screen = null;
  const newInst = () => ({ slots: [], cursor: 0, pending: [] });
  const unmount = (inst) => { inst.slots.forEach((s) => s?.cleanup?.()); };
  const renderScreen = () => { current = screen.inst; current.cursor = 0; try { screen.tree = mod.exports.ManualPublishScreen({ ...screen.element.props }); } finally { current = null; } };
  const sync = async () => {
    if (screen === null) return;
    for (let round = 0; round < 20; round += 1) {
      const element = mod.exports.default({});
      if (screen.key !== element.key) { unmount(screen.inst); screen = { key: element.key, inst: newInst() }; }
      screen.element = element;
      renderScreen();
      await settle();
      if (screen.inst.pending.length === 0) { renderScreen(); if (screen.inst.pending.length === 0) break; }
      const batch = screen.inst.pending.splice(0);
      for (const { i, effect } of batch) { const s = screen.inst.slots[i]; s.cleanup?.(); const cleanup = effect(); s.cleanup = typeof cleanup === 'function' ? cleanup : undefined; }
    }
  };
  const find = (type) => { const out = []; const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (n === null || typeof n !== 'object') return; if (n.type === type) out.push(n); walk(n.props?.children); }; walk(screen.tree); return out; };
  const lines = () => { const out = []; const visit = (node) => { if (Array.isArray(node)) { node.forEach(visit); return; } if (node === null || typeof node !== 'object') return; if (node.props?.label) out.push(node.props.label); const kids = [node.props?.children].flat(Infinity); const own = kids.filter((k) => typeof k === 'string' || typeof k === 'number').join(''); if (own !== '') out.push(own); kids.forEach((k) => { if (k !== null && typeof k === 'object') visit(k); }); }; visit(screen.tree); return out; };
  const api = {
    world, sync, lines,
    async auth(s) { world.session = s; await sync(); },
    async setStatus(s) { world.status = s; await sync(); },
    async open() { screen = { key: Symbol('none'), inst: newInst() }; await sync(); },
    state: () => screen.inst.slots[0].v,
    button: (label) => find('ActionButton').find((b) => b.props.label === label) ?? null,
    async press(label) { const b = api.button(label); assert.ok(b, `button "${label}" exists`); if (b.props.disabled) return false; b.props.onPress(); await sync(); return true; },
    async type(value) { find('TextInput')[0].props.onChangeText(value); await sync(); },
    async tick() { const box = find('Pressable').find((n) => n.props.accessibilityRole === 'checkbox'); assert.ok(box, 'consent checkbox'); box.props.onPress(); await sync(); },
    successShown: () => lines().some((l) => SUCCESS_WORDS.some((w) => l.includes(w))),
    sendButton: () => api.button('Xに投稿する'),
  };
  return api;
}

/** Real data: type, confirm, consent, send (answer kept out). */
async function sendOut() {
  const p = scriptedPort();
  const app = await createApp({ port: p.port });
  await app.auth(session('UA'));
  await app.open();
  await app.type('本物のデータで送る本文');
  assert.ok(await app.press('内容を確認する'));
  await app.tick();
  assert.equal(p.checks.length, 1, 'real data: the readiness is asked once');
  const go = app.sendButton();
  assert.ok(go && !go.props.disabled);
  go.props.onPress();
  await app.sync();
  assert.equal(p.sends.length, 1);
  return { p, app };
}

// ---- a send that is out when the data stops being ready ---------------------------------------------------------------

test('G2-N2a: the data reloads (loading) while a REAL send is out and the answer is "unavailable" -- the same-id re-ask cannot send and asks no readiness while loading; once ready again it sends with the SAME id', async () => {
  const { p, app } = await sendOut();
  await app.setStatus('loading');
  p.sends[0].resolve({ kind: 'unavailable', targetId: p.sends[0].target.targetId, code: 'TRANSPORT_FAILED' });
  await app.sync();
  assert.equal(app.successShown(), false);
  assert.ok(await app.press('同じ内容・同じ送信IDで確認し直す'));
  await app.tick();
  assert.equal(p.checks.length, 1, 'no readiness request while the data is loading');
  assert.equal(app.sendButton().props.disabled, true);
  assert.ok(app.lines().includes(NOT_READY_LINE));
  app.sendButton().props.onPress();
  await app.sync();
  assert.equal(p.sends.length, 1, 'a forced press sends nothing');
  await app.setStatus('ready');
  assert.equal(p.checks.length, 2, 'ready again: asked once more');
  assert.equal(app.sendButton().props.disabled, false);
  app.sendButton().props.onPress();
  await app.sync();
  assert.equal(p.sends.length, 2);
  assert.equal(p.sends[1].target.targetId, p.sends[0].target.targetId, 'the SAME id');
});

test('G2-N2b: a TRUE "published" that arrives while the data is loading (or blocked) is still shown as posted, with its post id', async () => {
  for (const status of ['loading', 'blocked']) {
    const { p, app } = await sendOut();
    await app.setStatus(status);
    p.sends[0].resolve({ kind: 'published', targetId: p.sends[0].target.targetId, providerPostId: '1850000000000000001', marks: { simulated: false, afterFreeze: false } });
    await app.sync();
    const lines = app.lines();
    assert.ok(lines.some((l) => l.includes('Xが投稿を受け付けました')), `${status}: posted`);
    assert.ok(lines.some((l) => l.includes('1850000000000000001')), `${status}: the post id`);
  }
});

// ---- demo data ------------------------------------------------------------------------------------------------------

test('G2-N2c: demo data, ready port: up to the confirmation and the consent nothing claims a post or a server-side "ready" -- the demo reason is shown, the port is never asked', async () => {
  const p = scriptedPort();
  const app = await createApp({ port: p.port, status: 'mock_preview' });
  await app.auth(session('UA'));
  await app.open();
  await app.type('デモで書いた本文');
  assert.ok(await app.press('内容を確認する'));
  await app.tick();
  const lines = app.lines();
  assert.ok(lines.includes(DEMO_LINE));
  assert.ok(!lines.includes(READY_LINE), 'never "サーバーで送信できる状態を確認できました"');
  assert.equal(app.successShown(), false);
  assert.equal(app.sendButton().props.disabled, true);
  assert.deepEqual([p.checks.length, p.sends.length], [0, 0]);
});

test('OBSERVATION G2-N2-ENV (owner of the app / release config): EXPO_PUBLIC_DATA_SOURCE unset or empty selects the DEMO data -- a build that only forgets it shows demo accounts to a real signed-in person (sending stays impossible since #400)', () => {
  for (const value of [undefined, '', '  ']) {
    assert.equal(dataSourceMode(value), 'mock', JSON.stringify(value));
    assert.equal(initialDataStatusFor(dataSourceMode(value)), 'mock_preview');
  }
  assert.equal(dataSourceMode('supabase'), 'supabase');
  assert.equal(dataSourceMode('Supabase'), 'invalid', 'a typo is blocked, not demo');
});

// ---- negative controls -----------------------------------------------------------------------------------------------

test('negative controls: the pre-#400 gate lets demo data say "ready" and send; asking the readiness without the data check asks it while loading', async () => {
  const once = (src, from, to) => { assert.equal(src.split(from).length - 1, 1, `target once: ${from.slice(0, 60)}`); return src.replace(from, to); };
  // 1. the old gate (demo passes): a mutated copy of the model, imports pointed back at the originals
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  let text = await readFile(MODEL_URL, 'utf8');
  text = once(text, "  if (input.dataStatus === 'mock_preview') return block('demo_data');\n  if (input.dataStatus !== 'ready') return block('data_not_ready');", "  if (input.dataStatus !== 'ready' && input.dataStatus !== 'mock_preview') return block('data_not_ready');");
  text = text.replace(/from '(\.[^']+)'/gu, (_m, rel) => `from '${new URL(rel, MODEL_URL).href}'`);
  const dir = await mkdtemp(join(tmpdir(), 'g2-n2-mut-'));
  let oldModel;
  try { await writeFile(join(dir, 'model.mutant.ts'), text); oldModel = await import(join(dir, 'model.mutant.ts')); } finally { await rm(dir, { recursive: true, force: true }); }
  const oldReadiness = once(ROUTE_SOURCE, "if (state.phase !== 'confirming' || state.accountId === null || dataStatus !== 'ready') return undefined;", "if (state.phase !== 'confirming' || state.accountId === null) return undefined;");
  {
    const p = scriptedPort();
    const app = await createApp({ port: p.port, status: 'mock_preview', modelModule: oldModel, source: oldReadiness });
    await app.auth(session('UA'));
    await app.open();
    await app.type('デモで書いた本文');
    await app.press('内容を確認する');
    await app.tick();
    assert.ok(app.lines().includes(READY_LINE), 'mutant: demo data says "ready"');
    assert.equal(app.sendButton().props.disabled, false, 'mutant: and can send');
  }
  // 2. the readiness effect without the data check: asked while loading (G2-N2a catches it)
  {
    const p = scriptedPort();
    const app = await createApp({ port: p.port, source: oldReadiness });
    await app.auth(session('UA'));
    await app.open();
    await app.type('本物のデータで送る本文');
    await app.press('内容を確認する');
    await app.tick();
    app.sendButton().props.onPress();
    await app.sync();
    await app.setStatus('loading');
    p.sends[0].resolve({ kind: 'unavailable', targetId: p.sends[0].target.targetId, code: 'TRANSPORT_FAILED' });
    await app.sync();
    await app.press('同じ内容・同じ送信IDで確認し直す');
    await app.tick();
    assert.equal(p.checks.length, 2, 'mutant: the readiness is asked while the data is loading');
  }
});
