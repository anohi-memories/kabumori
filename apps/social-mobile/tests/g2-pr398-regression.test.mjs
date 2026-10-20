// G2 QA (Issue #317, task postona-g2-pr398-draft-session-retry-label-regression-qa-20261021) -- QA only, no product code.
// Limited re-QA of G1 PR #398 (SM1 / SM3 / N1 = G2-X1) with the REAL route + screen + model + flow + stores, MOCK Supabase
// sessions and a scripted future send port. Offline: no network, no X, no token.
//
// The flips of G2's own FINDINGs (#380 SM1/SM3, #394 X1) and G1's nine new tests are run separately (see the README);
// this file adds what neither covers now that the route key includes the session mark:
//   - normal paths that must survive the new key (a refresh that keeps the mark, a real re-ask after a restart);
//   - FINDING G2-SM3R: a refresh that CHANGES the mark (MOCK of G2-SM2: the same person signed in on another device)
//     now re-creates the OPEN screen -- what is lost, and that nothing is sent twice;
//   - negative controls rebuilt for the new route source.
// "FINDING .." passes while the gap exists and FAILS once fixed.
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

const ROUTE_SOURCE = await readFile(new URL('../src/app/manual-publish.tsx', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const SAME_ID_LINE = '前回と同じ内容・同じ送信IDで確認します。同じ送信IDは、サーバーが2回送ることはありません。';
const DKEY = (u) => `postona.manual-publish.draft.v1:${u}`;
const T1 = '2026-10-20T08:00:00.000000Z';
const T2 = '2026-10-20T09:30:00.000000Z';
const session = (id, mark, token = 'rig-at-1') => ({ access_token: token, user: { id, last_sign_in_at: mark } });

const account = (id) => ({ id, brandId: 'A', platform: 'x', profile: { displayName: `name-${id}`, handle: `@${id}`, avatarColor: '#123456' }, connectionStatus: 'connected', postingState: 'active' });
function kv() {
  const data = new Map();
  return { data, getItem: async (k) => (data.has(k) ? data.get(k) : null), setItem: async (k, v) => { data.set(k, v); }, removeItem: async (k) => { data.delete(k); } };
}
function scriptedPort() {
  const sends = [];
  return { sends, port: { checkReadiness: async () => ({ kind: 'ready' }), send: (target) => new Promise((resolve) => { sends.push({ target, resolve }); }) } };
}

/** One app process (route keyed as in the source under test) over shared device storage. */
async function createApp({ port, source = ROUTE_SOURCE, draftKv = kv(), attemptKv = kv(), memory = realFlow.createAttemptMemory() } = {}) {
  const world = { session: null, accounts: [account('X_A'), account('X_B')], status: 'ready' };
  const store = realStore.createAttemptStore(attemptKv);
  const draftStore = realDraft.createDraftStore(draftKv);
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
    '@/features/manual-publish/manual-publish-flow': { ...realFlow, attemptMemory: memory },
    '@/features/manual-publish/manual-publish-model': model,
    '@/features/manual-publish/manual-publish-port': { ...realPort, getManualPublishPort: () => port ?? realPort.UNCONNECTED_MANUAL_PUBLISH_PORT },
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
  let instances = 0;
  const newInst = () => { instances += 1; return { slots: [], cursor: 0, pending: [] }; };
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
    world, memory, draftKv, attemptKv, sync, lines,
    instances: () => instances,
    async auth(s) { world.session = s; await sync(); },
    async open() { screen = { key: Symbol('none'), inst: newInst() }; await sync(); },
    leave() { if (screen) unmount(screen.inst); screen = null; },
    state: () => screen.inst.slots[0].v,
    button: (label) => find('ActionButton').find((b) => b.props.label === label) ?? null,
    async press(label) { const b = api.button(label); assert.ok(b, `button "${label}" exists`); if (b.props.disabled) return false; b.props.onPress(); await sync(); return true; },
    async type(value) { find('TextInput')[0].props.onChangeText(value); await sync(); },
    async tick() { const box = find('Pressable').find((n) => n.props.accessibilityRole === 'checkbox'); assert.ok(box, 'consent checkbox'); box.props.onPress(); await sync(); },
    async confirmAndTick(value) { if (value !== undefined) await api.type(value); assert.ok(await api.press('内容を確認する')); await api.tick(); },
    async go() { const b = api.button('Xに投稿する'); assert.ok(b && !b.props.disabled, 'send enabled'); b.props.onPress(); b.props.onPress(); await sync(); },
    record: (u) => (draftKv.data.has(DKEY(u)) ? JSON.parse(draftKv.data.get(DKEY(u))) : null),
  };
  return api;
}

// ---- normal paths that must survive the session-keyed route ------------------------------------------------------------

test('G2-R1: a token refresh that KEEPS the mark does not re-create the open screen -- the text and the chosen account stay, the record keeps its mark, and it comes back after leaving', async () => {
  const app = await createApp();
  await app.auth(session('UA', T1, 'rig-at-1'));
  await app.open();
  await app.type('更新をまたぐ下書き');
  const before = app.instances();
  await app.auth(session('UA', T1, 'rig-at-2')); // TOKEN_REFRESHED, same last_sign_in_at
  assert.equal(app.instances(), before, 'the same screen instance');
  assert.equal(app.state().draft, '更新をまたぐ下書き');
  assert.equal(app.record('UA')?.sessionMark, T1);
  app.leave();
  await app.open();
  assert.equal(app.state().draft, '更新をまたぐ下書き');
});

test('G2-R2: a real re-ask after an app restart (pending attempt, text typed again) shows "same content, same id" while confirming and while sending, and reuses the stored id -- a first send of the next text does not', async () => {
  const p = scriptedPort();
  const draftKv = kv();
  const attemptKv = kv();
  const first = await createApp({ port: p.port, draftKv, attemptKv });
  await first.auth(session('UA', T1));
  await first.open();
  await first.confirmAndTick('再起動をまたぐ送信');
  await first.go();
  p.sends[0].resolve({ kind: 'pending', targetId: p.sends[0].target.targetId, code: 'BUSY' });
  await first.sync();
  first.leave();
  const second = await createApp({ port: p.port, draftKv, attemptKv }); // a new process, same device storage
  await second.auth(session('UA', T1));
  await second.open();
  assert.ok(await second.press('前回と同じ本文を入力して確認し直す'));
  await second.type('再起動をまたぐ送信');
  assert.ok(second.lines().includes(SAME_ID_LINE), 'confirming a re-ask: shown');
  await second.tick();
  await second.go();
  assert.equal(second.state().phase, 'sending');
  assert.ok(second.lines().includes(SAME_ID_LINE), 'sending a re-ask: shown');
  assert.equal(p.sends.length, 2);
  assert.equal(p.sends[1].target.targetId, p.sends[0].target.targetId, 'the same id');
  p.sends[1].resolve({ kind: 'published', targetId: p.sends[1].target.targetId, providerPostId: '1850000000000000001', marks: { simulated: false, afterFreeze: false } });
  await second.sync();
  assert.ok(await second.press('新しい投稿を作る'));
  await second.confirmAndTick('次の投稿');
  await second.go();
  assert.equal(second.state().phase, 'sending');
  assert.ok(!second.lines().includes(SAME_ID_LINE), 'a first send of the next text: not shown');
});

// ---- the new key and a refresh that CHANGES the mark ------------------------------------------------------------------

test('FINDING G2-SM3R (P3, owner G1 / G5; MOCK of G2-SM2): a refresh whose user carries a NEW last_sign_in_at re-creates the open screen -- the typed text is gone at once and its record is discarded on the next look', async () => {
  const app = await createApp();
  await app.auth(session('UA', T1, 'rig-at-1'));
  await app.open();
  await app.type('入力中の本文');
  const before = app.instances();
  await app.auth(session('UA', T2, 'rig-at-2')); // TOKEN_REFRESHED after the same person signed in on another device (MOCK)
  assert.equal(app.instances(), before + 1, 're-created');
  assert.equal(app.state().draft, '', 'the text on screen is gone');
  assert.equal(app.record('UA'), null, 'and the record (old mark) was discarded by the new screen');
});

test('G2-SM3R-C: the same change while confirming drops the confirmation and the consent (nothing can be sent with them)', async () => {
  const app = await createApp({ port: scriptedPort().port });
  await app.auth(session('UA', T1));
  await app.open();
  await app.confirmAndTick('確認中の本文');
  assert.equal(app.state().phase, 'confirming');
  await app.auth(session('UA', T2, 'rig-at-2'));
  assert.equal(app.state().phase, 'editing');
  assert.equal(app.state().consent, null);
  assert.equal(app.button('Xに投稿する'), null);
});

test('G2-SM3R-S: the same change WHILE a send is out -- the new screen shows the attempt as unresolved, never as sent, and a retry re-uses the SAME id (no second post)', async () => {
  const p = scriptedPort();
  const app = await createApp({ port: p.port });
  await app.auth(session('UA', T1));
  await app.open();
  await app.confirmAndTick('送信中の本文');
  await app.go();
  assert.equal(p.sends.length, 1);
  await app.auth(session('UA', T2, 'rig-at-2'));
  // Observed (2026-10-21): the new screen starts from the remembered in_flight attempt and shows it as "unconfirmed"
  // ("通信できず、投稿されたかどうか分かりません") although the first request is still out, and it offers the same-id re-ask.
  assert.equal(app.state().phase, 'result');
  assert.equal(app.state().unresolved?.kind, 'unconfirmed');
  assert.equal(app.state().unresolved.requestId, p.sends[0].target.targetId);
  assert.ok(await app.press('同じ内容・同じ送信IDで確認し直す'), 'the same-id re-ask is offered while the first request is still out');
  await app.tick();
  await app.go();
  assert.equal(p.sends.length, 2, 'a second, concurrent request ...');
  assert.equal(p.sends[1].target.targetId, p.sends[0].target.targetId, '... with the SAME id (the server answers one id once; real server NOT_VERIFIED)');
  p.sends[0].resolve({ kind: 'unavailable', targetId: p.sends[0].target.targetId, code: 'TRANSPORT_FAILED' });
  await app.sync();
  assert.ok(!app.lines().some((l) => l.includes('Xが投稿を受け付けました')), 'nothing claims a post');
});

// ---- negative controls (rebuilt for the #398 route source) ------------------------------------------------------------

test('negative controls: a route keyed by the user only brings SM3 back (text survives a new sign-in), and the old same-id condition brings G2-X1 back (a first send says "same id")', async () => {
  const once = (src, from, to) => { assert.equal(src.split(from).length - 1, 1, `target once: ${from.slice(0, 60)}`); return src.replace(from, to); };
  const userOnly = once(ROUTE_SOURCE, "key={userId === null ? 'signed-out' : `${userId}:${sessionMark}`}", "key={userId === null ? 'signed-out' : userId}");
  const a = await createApp({ source: userOnly });
  await a.auth(session('UA', T1));
  await a.open();
  await a.type('入力中の本文');
  await a.auth(session('UA', T2, 'rig-at-2'));
  assert.equal(a.state().draft, '入力中の本文', 'mutant: the text is carried into the new session (SM3)');

  const oldLine = once(ROUTE_SOURCE, "{(state.phase === 'confirming' && state.unresolved !== null) || (state.phase === 'sending' && state.retrying) ? (", '{state.unresolved !== null ? (');
  const p = scriptedPort();
  const b = await createApp({ source: oldLine, port: p.port });
  await b.auth(session('UA', T1));
  await b.open();
  await b.confirmAndTick('はじめての投稿');
  await b.go();
  assert.ok(b.lines().includes(SAME_ID_LINE), 'mutant: a first send says "same id" again (X1)');
});
