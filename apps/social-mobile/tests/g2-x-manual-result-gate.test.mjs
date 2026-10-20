// G2 QA (Issue #317, task postona-g2-x-manual-publish-result-gate-offline-qa-20261020) -- QA only, no product code.
// The REAL route + screen of the manual X post (src/app/manual-publish.tsx of G1 PR #366, transpiled) with the REAL
// model / flow / stores, over a MOCK future send port (the build itself uses UNCONNECTED_MANUAL_PUBLISH_PORT, whose
// readiness is not_connected; that case is already pinned by the existing "this build: ..." tests and is only re-checked
// here as a control). Offline: no network, no X, no token; the port is a scripted stand-in.
//
// The existing manual-publish-*.test.mjs suites (F1/G1) already pin almost every result rule (see the README's gap
// table). This file adds only what they do not: the copy of the FIRST send, a change of the signed-in person while a
// send is still out, the chosen account disappearing while a send is out, and what the editor holds after an
// acknowledged "uncertain". "FINDING .." passes while the gap exists and FAILS once fixed.
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
const USER_A = 'UA';
const USER_B = 'UB';
const SAME_ID_LINE = '前回と同じ内容・同じ送信IDで確認します。同じ送信IDは、サーバーが2回送ることはありません。';
const SUCCESS_WORDS = ['Xが投稿を受け付けました', '投稿されました', '投稿しました', '送信しました', '送信済み'];

const account = (id, over = {}) => ({
  id, brandId: 'A', platform: 'x', profile: { displayName: `name-${id}`, handle: `@${id}`, avatarColor: '#123456' },
  connectionStatus: 'connected', postingState: 'active', ...over,
});

function kv() {
  const data = new Map();
  return { data, getItem: async (k) => (data.has(k) ? data.get(k) : null), setItem: async (k, v) => { data.set(k, v); }, removeItem: async (k) => { data.delete(k); } };
}

/** A future, connected port stand-in: readiness is "ready"; every send stays out until the test answers it. */
function scriptedPort() {
  const sends = [];
  return {
    sends,
    port: {
      checkReadiness: async () => ({ kind: 'ready' }),
      send: (target) => new Promise((resolve) => { sends.push({ target, resolve }); }),
    },
  };
}

/** One app process: the real route (keyed by user) above the real screen, with a minimal hook runtime. */
async function createApp({ port, source = ROUTE_SOURCE, accounts = [account('X_A'), account('X_B')] } = {}) {
  const world = { session: null, accounts, status: 'ready' };
  const memory = realFlow.createAttemptMemory();
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
    '@/features/manual-publish/manual-publish-flow': { ...realFlow, attemptMemory: memory },
    '@/features/manual-publish/manual-publish-model': model,
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
  const text = () => {
    const out = [];
    const visit = (node) => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node === null || typeof node !== 'object') return;
      if (node.props?.label) out.push(node.props.label);
      const kids = [node.props?.children].flat(Infinity);
      const own = kids.filter((k) => typeof k === 'string' || typeof k === 'number').join('');
      if (own !== '') out.push(own);
      kids.forEach((k) => { if (k !== null && typeof k === 'object') visit(k); });
    };
    visit(screen.tree);
    return out;
  };
  const api = {
    world, memory, store, sync,
    async signIn(userId) { world.session = userId === null ? null : { user: { id: userId, last_sign_in_at: '2026-10-20T08:00:00.000000Z' } }; await sync(); },
    async open() { screen = { key: Symbol('none'), inst: newInst() }; await sync(); },
    leave() { if (screen) unmount(screen.inst); screen = null; },
    state: () => screen.inst.slots[0].v,
    lines: text,
    button: (label) => find('ActionButton').find((b) => b.props.label === label) ?? null,
    async press(label) { const b = api.button(label); assert.ok(b, `button "${label}" exists`); if (b.props.disabled) return false; b.props.onPress(); await sync(); return true; },
    async type(value) { find('TextInput')[0].props.onChangeText(value); await sync(); },
    async tick() { const box = find('Pressable').find((n) => n.props.accessibilityRole === 'checkbox'); assert.ok(box, 'consent checkbox'); box.props.onPress(); await sync(); },
    /** type -> 内容を確認する -> consent -> Xに投稿する (pressed twice). */
    async sendText(value) {
      await api.type(value);
      assert.ok(await api.press('内容を確認する'));
      await api.tick();
      const go = api.button('Xに投稿する');
      assert.ok(go && !go.props.disabled, 'the send is enabled with a ready port and the consent');
      go.props.onPress();
      go.props.onPress();
      await sync();
    },
    successShown: () => api.lines().some((line) => SUCCESS_WORDS.some((w) => line.includes(w))),
  };
  return api;
}

// ---- control: this build ---------------------------------------------------------------------------------------------

test('control (this build): with the unconnected port nothing is sent and nothing says it was -- the send button stays disabled even after the consent', async () => {
  let sends = 0;
  const port = { ...realPort.UNCONNECTED_MANUAL_PUBLISH_PORT, send: async (t) => { sends += 1; return realPort.UNCONNECTED_MANUAL_PUBLISH_PORT.send(t); } };
  assert.equal(realPort.getManualPublishPort(), realPort.UNCONNECTED_MANUAL_PUBLISH_PORT, 'the build still returns the unconnected port');
  const app = await createApp({ port });
  await app.signIn(USER_A);
  await app.open();
  await app.type('未接続の確認');
  await app.press('内容を確認する');
  await app.tick();
  const go = app.button('Xに投稿する');
  assert.equal(go.props.disabled, true);
  go.props.onPress();
  await app.sync();
  assert.equal(sends, 0);
  assert.equal(app.successShown(), false);
});

// ---- new conditions -------------------------------------------------------------------------------------------------

test('FINDING G2-X1 (P3, owner G1): during the FIRST send of a new text the confirmation already says "前回と同じ内容・同じ送信IDで確認します" -- there was no earlier attempt', async () => {
  const p = scriptedPort();
  const app = await createApp({ port: p.port });
  await app.signIn(USER_A);
  await app.open();
  await app.sendText('はじめての投稿');
  assert.equal(p.sends.length, 1, 'one send, the answer is still out');
  assert.equal(app.state().phase, 'sending');
  assert.ok(app.lines().includes(SAME_ID_LINE), 'the "same as last time" line is shown for a first send');
});

test('G2-X2: another person signs in while A\'s send is still out -- B gets a fresh screen with nothing of A, and A\'s late "published" never reaches B', async () => {
  const p = scriptedPort();
  const app = await createApp({ port: p.port });
  await app.signIn(USER_A);
  await app.open();
  await app.sendText('Aさんの投稿');
  assert.equal(p.sends.length, 1);
  await app.signIn(USER_B); // the route re-creates the screen for B
  assert.equal(app.state().draft, '');
  assert.equal(app.state().unresolved, null, "B does not inherit A's attempt");
  assert.ok(!app.lines().includes(SAME_ID_LINE));
  p.sends[0].resolve({ kind: 'published', targetId: p.sends[0].target.targetId, providerPostId: '1850000000000000001', marks: { simulated: false, afterFreeze: false } });
  await app.sync();
  await app.sync();
  assert.equal(app.successShown(), false, "A's result is not shown to B");
  assert.equal(app.memory.get(USER_A), null, "A's attempt ended (proven) and is forgotten for A");
  assert.equal(p.sends.length, 1);
});

test('G2-X3: the chosen account disappears while the send is out and the answer is "pending" / "unavailable" -- the same-id retry is not offered for a missing account and nothing is sent again', async () => {
  for (const answer of [{ kind: 'pending', code: 'BUSY' }, { kind: 'unavailable', code: 'TRANSPORT_FAILED' }]) {
    const p = scriptedPort();
    const app = await createApp({ port: p.port });
    await app.signIn(USER_A);
    await app.open();
    await app.sendText('消えるアカウントへの投稿');
    app.world.accounts = [account('X_B')]; // X_A is gone from the list (removed / another workspace)
    await app.sync();
    p.sends[0].resolve({ ...answer, targetId: p.sends[0].target.targetId });
    await app.sync();
    await app.sync();
    assert.equal(app.successShown(), false, answer.kind);
    // Observed path (2026-10-20): the same-id retry IS offered and opens the confirmation, but the send there stays
    // disabled for the missing account, and a forced press is refused -- fail closed, just not explained up front.
    assert.ok(await app.press('同じ内容・同じ送信IDで確認し直す'), `${answer.kind}: the retry is offered`);
    assert.equal(app.state().phase, 'confirming');
    await app.tick();
    const go = app.button('Xに投稿する');
    assert.equal(go.props.disabled, true, `${answer.kind}: the send stays disabled for the missing account`);
    go.props.onPress();
    await app.sync();
    assert.equal(p.sends.length, 1, `${answer.kind}: nothing is sent again for a missing account`);
    assert.ok(p.sends.every((s) => s.target.connectedAccountId === 'X_A'), 'never re-pointed to another account');
  }
});

test('G2-X4: after an "uncertain" answer and the explicit "Xで確認しました", the editor is EMPTY (no old text to re-send by mistake), and a new send gets a NEW id', async () => {
  const p = scriptedPort();
  const app = await createApp({ port: p.port });
  await app.signIn(USER_A);
  await app.open();
  await app.sendText('結果が分からない投稿');
  p.sends[0].resolve({ kind: 'uncertain', targetId: p.sends[0].target.targetId, code: 'X_TIMEOUT', marks: { simulated: false, afterFreeze: false } });
  await app.sync();
  assert.equal(app.button('同じ内容・同じ送信IDで確認し直す'), null, 'no retry for uncertain');
  assert.ok(await app.press('Xで確認しました（この下書きを破棄）'));
  assert.equal(app.state().phase, 'editing');
  assert.equal(app.state().draft, '', 'the uncertain text is not put back (contrast: Threads G2-T1)');
  await app.sendText('結果が分からない投稿'); // typed again on purpose
  assert.equal(p.sends.length, 2);
  assert.notEqual(p.sends[0].target.targetId, p.sends[1].target.targetId);
});

// ---- negative controls -----------------------------------------------------------------------------------------------

test('negative controls: a route without the per-user key lets B see A\'s send; showing the same-id line only on a retry flips G2-X1', async () => {
  const once = (src, from, to) => { assert.equal(src.split(from).length - 1, 1, `target once: ${from.slice(0, 50)}`); return src.replace(from, to); };
  // 1. no per-user key: B is shown A's screen (still sending, with A's text)
  {
    const p = scriptedPort();
    const app = await createApp({ port: p.port, source: once(ROUTE_SOURCE, "key={userId ?? 'signed-out'}", 'key="one-screen"') });
    await app.signIn(USER_A);
    await app.open();
    await app.sendText('Aさんの投稿');
    await app.signIn(USER_B);
    assert.equal(app.state().draft, 'Aさんの投稿', 'mutant: B sees what A sent');
  }
  // 2. a fix sketch: the line only when this is a retry of an unresolved attempt
  {
    const p = scriptedPort();
    const sketch = once(ROUTE_SOURCE, '{state.unresolved !== null ? (\n                <Text style={styles.muted}>前回と同じ内容', "{state.unresolved !== null && state.unresolved.kind !== 'in_flight' ? (\n                <Text style={styles.muted}>前回と同じ内容");
    const app = await createApp({ port: p.port, source: sketch });
    await app.signIn(USER_A);
    await app.open();
    await app.sendText('はじめての投稿');
    assert.ok(!app.lines().includes(SAME_ID_LINE), 'with the sketch the first send does not claim "same as last time" (G2-X1 flips)');
  }
});
