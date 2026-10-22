// G2 QA (Issue #317, task postona-g2-pr450-ack-inflight-ui-regression-offline-20261023) -- QA only, no product code.
// G1 PR #450: "Xで確認しました" (acknowledge) takes the same per-user reservation as a send, is refused while a send (or another
// acknowledge) is unfinished or when the screen names an attempt the process no longer knows, and a refused acknowledge brings
// the screen to the attempt as it is now. H1 passed #450 as a FOCUSED source review (POST_ACK_SAME_ID_REASK_OPEN); that is not
// a release PASS and not this UI QA. This file measures #450's crossings that G1's / H1's tests and G2 #430 / #448 do not cover,
// on the REAL route + screen + model + flow + stores with several screens, MOCK sessions, a scripted future send port and a
// key-value store whose removals can be held or fail. Offline; Promise-order mocks only (real AsyncStorage NOT_VERIFIED).
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
const FLOW_URL = new URL('../src/features/manual-publish/manual-publish-flow.ts', import.meta.url);
const FLOW_SOURCE = await readFile(FLOW_URL, 'utf8');
const HAS_SEND_ENTRY_WALL = FLOW_SOURCE.includes("'LOCAL_UNRESOLVED_ATTEMPT'");
const GATE = { todo: 'RELEASE GATE (H1 residual P2): red until a reviewed fix lands' };
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const POSTED = 'Xが投稿を受け付けました';
const T1 = '2026-10-22T08:00:00.000000Z';
const T2 = '2026-10-22T09:30:00.000000Z';
const TEXT = '同じ本文の投稿';
const REAL = { simulated: false, afterFreeze: false };
const session = (id, mark, token = 'rig-at-1') => ({ access_token: token, user: { id, last_sign_in_at: mark } });
const account = (id) => ({ id, brandId: 'A', platform: 'x', profile: { displayName: `name-${id}`, handle: `@${id}`, avatarColor: '#123456' }, connectionStatus: 'connected', postingState: 'active' });

/** Key-value store; `holdNextRead()` makes the next read take its snapshot NOW and deliver it only on `release()`. */
function kv() {
  const data = new Map();
  let hold = null;
  const removeMode = { hold: null, fail: false };
  return {
    data,
    getItem: async (k) => {
      const snapshot = data.has(k) ? data.get(k) : null;
      if (hold === null) return snapshot;
      const gate = hold;
      hold = null;
      gate.taken = true;
      return new Promise((resolve) => { gate.release = () => resolve(snapshot); });
    },
    setItem: async (k, v) => { data.set(k, v); },
    removeItem: async (k) => { if (removeMode.fail) throw new Error('storage down'); if (removeMode.hold) { const g = removeMode.hold; removeMode.hold = null; g.taken = true; await new Promise((r) => { g.release = r; }); } data.delete(k); },
    holdNextRead() { hold = { taken: false, release: null }; return hold; },
    /** The next removal waits until `release()` (an acknowledge in progress); `failRemovals(true)` makes removals throw. */
    holdNextRemove() { removeMode.hold = { taken: false, release: null }; return removeMode.hold; },
    failRemovals(on) { removeMode.fail = on; },
  };
}
function scriptedPort() {
  const sends = [];
  return { sends, port: { checkReadiness: async () => ({ kind: 'ready' }), send: (target) => new Promise((resolve) => { sends.push({ target, resolve }); }) } };
}

// ---- harness: one app process, several mounted route instances --------------------------------------------------------
async function createApp({ port, routeSource = ROUTE_SOURCE, flowModule = realFlow } = {}) {
  const world = { session: null, accounts: [account('X_A'), account('X_B')], status: 'ready' };
  const flow = { ...flowModule, attemptMemory: flowModule.createAttemptMemory(), inFlightSends: flowModule.createInFlightSends() };
  const store = kv();
  let current = null;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
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
    'react-native': { Platform: { OS: 'android' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-router': { Link: 'Link', Stack: { Screen: 'StackScreen' } },
    'expo-crypto': { randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '@/constants/theme': { colors: new Proxy({}, { get: (_t, name) => String(name) }), spacing: { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: { muted: true } } },
    '@/features/manual-publish/manual-post-preview': { ManualPostPreview: 'ManualPostPreview' },
    '@/features/manual-publish/manual-publish-flow': flow,
    '@/features/manual-publish/manual-publish-model': model,
    '@/features/manual-publish/manual-publish-port': { ...realPort, getManualPublishPort: () => port },
    '@/features/manual-publish/manual-publish-storage': { attemptStore: realStore.createAttemptStore(store), draftStore: realDraft.createDraftStore(kv()) },
    '@/features/manual-publish/manual-publish-draft-store': realDraft,
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: world.accounts, activeAccount: world.accounts[0] ?? null }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.session }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status, reason: null, snapshot: null }) },
  };
  const js = ts.transpileModule(routeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, Promise, Date, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'manual-publish.tsx' });

  const screens = [];
  const newInst = () => ({ slots: [], cursor: 0, pending: [] });
  const unmount = (inst) => { inst.slots.forEach((s) => s?.cleanup?.()); };
  const renderScreen = (screen) => { current = screen.inst; current.cursor = 0; try { screen.tree = mod.exports.ManualPublishScreen({ ...screen.element.props }); } finally { current = null; } };
  const syncOne = async (screen) => {
    for (let round = 0; round < 20; round += 1) {
      const element = mod.exports.default({});
      if (screen.key !== element.key) { unmount(screen.inst); screen.key = element.key; screen.inst = newInst(); screen.generation += 1; }
      screen.element = element;
      renderScreen(screen);
      await settle();
      if (screen.inst.pending.length === 0) { renderScreen(screen); if (screen.inst.pending.length === 0) return; }
      const batch = screen.inst.pending.splice(0);
      for (const { i, effect } of batch) { const s = screen.inst.slots[i]; s.cleanup?.(); const cleanup = effect(); s.cleanup = typeof cleanup === 'function' ? cleanup : undefined; }
    }
  };
  const sync = async () => { for (let pass = 0; pass < 2; pass += 1) for (const screen of screens) await syncOne(screen); };
  const handle = (screen) => {
    const find = (type) => { const out = []; const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (n === null || typeof n !== 'object') return; if (n.type === type) out.push(n); walk(n.props?.children); }; walk(screen.tree); return out; };
    const lines = () => { const out = []; const visit = (node) => { if (Array.isArray(node)) { node.forEach(visit); return; } if (node === null || typeof node !== 'object') return; if (node.props?.label) out.push(node.props.label); const kids = [node.props?.children].flat(Infinity); const own = kids.filter((x) => typeof x === 'string' || typeof x === 'number').join(''); if (own !== '') out.push(own); kids.forEach((x) => { if (x !== null && typeof x === 'object') visit(x); }); }; visit(screen.tree); return out; };
    const h = {
      screen, lines,
      state: () => screen.inst.slots[0].v,
      generation: () => screen.generation,
      button: (label) => find('ActionButton').find((b) => b.props.label === label) ?? null,
      async press(label) { const b = h.button(label); if (!b || b.props.disabled) return false; b.props.onPress(); await sync(); return true; },
      async type(value) { const input = find('TextInput')[0]; assert.ok(input, 'an editor'); input.props.onChangeText(value); await sync(); },
      async pick(accountId) { const radio = find('Pressable').find((n) => n.props.accessibilityRole === 'radio' && n.key === accountId); assert.ok(radio, `account ${accountId}`); radio.props.onPress(); await sync(); },
      async tick() { const box = find('Pressable').find((n) => n.props.accessibilityRole === 'checkbox'); assert.ok(box, 'consent checkbox'); box.props.onPress(); await sync(); },
      /** Type, confirm, consent and press send (twice, like an impatient finger). False if any step is not offered. */
      async trySend(value, accountId = null) {
        if (!find('TextInput')[0]) return false;
        await h.type(value);
        if (accountId !== null) await h.pick(accountId);
        if (!(await h.press('内容を確認する'))) return false;
        if (!find('Pressable').some((n) => n.props.accessibilityRole === 'checkbox')) return false;
        await h.tick();
        const b = h.button('Xに投稿する');
        if (!b || b.props.disabled) return false;
        b.props.onPress(); b.props.onPress();
        await sync();
        return true;
      },
      posted: () => lines().some((l) => l.includes(POSTED)),
    };
    return h;
  };
  return {
    world, store, flow, sync,
    async auth(s) { world.session = s; await sync(); },
    async open() { const screen = { key: Symbol('new'), inst: newInst(), generation: 0, element: null, tree: null }; screens.push(screen); await syncOne(screen); await sync(); return handle(screen); },
    close(h) { const i = screens.indexOf(h.screen); if (i >= 0) { unmount(h.screen.inst); screens.splice(i, 1); } },
  };
}
const answerOf = (send, answer) => send.resolve({ ...answer, targetId: send.target.targetId });

/** A and B both open for user UA; B's store read is held (snapshot = nothing) unless `bLoadsFirst`. A sends and ends. */
async function crossing({ end, bLoadsFirst = false, opts = {} }) {
  const p = scriptedPort();
  const app = await createApp({ ...opts, port: p.port });
  await app.auth(session('UA', T1));
  const a = await app.open();
  const hold = bLoadsFirst ? null : app.store.holdNextRead();
  const b = await app.open();
  if (hold) assert.equal(hold.taken, true, 'B took its snapshot before A sent');
  assert.ok(await a.trySend(TEXT), 'A sends');
  assert.equal(p.sends.length, 1);
  answerOf(p.sends[0], end);
  await app.sync();
  if (hold) { hold.release(); await app.sync(); }
  return { p, app, a, b };
}
const UNCERTAIN = { kind: 'uncertain', code: 'OFFLINE', marks: REAL };
const PENDING = { kind: 'pending', code: 'X_PENDING', marks: REAL };


// ---- evidence-head correspondence (recorded 2026-10-22 12:20 JST, read-only from gh / Issue comments) ---------------------
const SAME_ID = '同じ内容・同じ送信IDで確認し直す';
/** Re-ask on a screen: the re-ask button, then confirm, consent and send (pressed several times). */
async function reAsk(h, taps = 2) {
  if (!(await h.press(SAME_ID))) return false;
  if (h.button('内容を確認する')) await h.press('内容を確認する');
  try { await h.tick(); } catch { return false; }
  const b = h.button('Xに投稿する');
  if (!b || b.props.disabled) return false;
  for (let i = 0; i < taps; i += 1) b.props.onPress();
  return true;
}
const PUBLISHED = { kind: 'published', providerPostId: '1850000000000000001', marks: REAL };
/** A sends (pending); A and a later-opened B both show the pending attempt; then A re-asks and its re-ask ends as `end`. */
async function staleReAsk(end, opts = {}) {
  const p = scriptedPort();
  const app = await createApp({ ...opts, port: p.port });
  await app.auth(session('UA', T1));
  const a = await app.open();
  assert.ok(await a.trySend(TEXT));
  answerOf(p.sends[0], PENDING);
  await app.sync();
  const b = await app.open();
  assert.equal(b.state().unresolved?.kind, 'pending', 'B shows the pending attempt');
  assert.ok(await reAsk(a), 'A re-asks');
  await app.sync();
  assert.equal(p.sends.length, 2, 'A re-asked with the same id');
  answerOf(p.sends[1], end);
  await app.sync();
  return { p, app, a, b };
}

const view = (h) => ({ phase: h.state().phase, kind: h.state().unresolved?.kind ?? null, requestId: h.state().unresolved?.requestId ?? null });
const printer2 = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
function mutate2(source, kind, predicate, replace) {
  const file = ts.createSourceFile('x', source, ts.ScriptTarget.ES2022, true, kind);
  let n = 0;
  const out = ts.transform(file, [(context) => (root) => ts.visitNode(root, function v(node) { if (predicate(node)) { n += 1; return replace(node); } return ts.visitEachChild(node, v, context); })]);
  return { text: printer2.printFile(out.transformed[0]), n };
}
async function importFlow2(text) {
  const fixed = text.replace(/from "(\.[^"]+)"/gu, (_m, rel) => `from "${new URL(rel, FLOW_URL).href}"`).replace(/from '(\.[^']+)'/gu, (_m, rel) => `from '${new URL(rel, FLOW_URL).href}'`);
  const dir = await mkdtemp(join(tmpdir(), 'g2-rk-'));
  try { await writeFile(join(dir, 'flow.mutant.ts'), fixed); return await import(join(dir, 'flow.mutant.ts')); } finally { await rm(dir, { recursive: true, force: true }); }
}
const ACK_LABELS = ['Xで確認しました（この下書きを破棄）', 'Xで確認しました（この記録を破棄）'];
const ackButton = (h) => ACK_LABELS.map((l) => h.button(l)).find(Boolean) ?? null;
async function ack(h, taps = 1) { const b = ackButton(h); if (!b) return false; for (let i = 0; i < taps; i += 1) b.props.onPress(); return true; }
const HAS_ACK_RESERVATION = FLOW_SOURCE.includes('beginAcknowledge(');
const recordOf = (app) => app.store.data.size;

/** A sends; its answer is `end`; B is opened after it (B shows the same attempt). */
async function twoOnOneAttempt(end) {
  const p = scriptedPort();
  const app = await createApp({ port: p.port });
  await app.auth(session('UA', T1));
  const a = await app.open();
  assert.ok(await a.trySend(TEXT));
  answerOf(p.sends[0], end);
  await app.sync();
  const b = await app.open();
  return { p, app, a, b, r1: p.sends[0].target.targetId };
}

test('G2-AK1 (RK3 + ack): A\'s NEW post is out, the stale screen B (still showing the OLD posted attempt) presses "I checked X" -- refused, the out post keeps its memory and record, and B is brought to "sending" for A\'s post and then shows its real answer', async () => {
  const { p, app, a, b } = await staleReAsk(PUBLISHED);
  assert.ok(await a.press('新しい投稿を作る'));
  assert.ok(await a.trySend('Aさんの次の投稿'));
  await reAsk(b, 1);
  await app.sync();
  const r2 = p.sends[2].target.targetId;
  assert.ok(await ack(b, 2), 'B offers "I checked X" and it is pressed twice');
  await app.sync();
  assert.ok(app.flow.inFlightSends.isOut('UA', r2), 'still out');
  assert.equal(app.flow.attemptMemory.get('UA')?.requestId, r2, 'memory of the out post kept');
  assert.equal(recordOf(app), 1, 'its durable record kept');
  assert.deepEqual([b.state().phase, b.state().requestId], ['sending', r2], 'B now waits for A\'s post');
  answerOf(p.sends[2], UNCERTAIN);
  await app.sync();
  assert.deepEqual(view(b), { phase: 'result', kind: 'uncertain', requestId: r2 }, 'and shows its real answer');
  assert.equal(p.sends.length, 3, 'no extra request');
});

test('G2-AK2: two screens showing the same uncertain attempt press "I checked X" at the same moment -- exactly one clear; the other is refused (nothing cleared by it) and can acknowledge again afterwards; no request', async (t) => {
  const { p, app, a, b, r1 } = await twoOnOneAttempt(UNCERTAIN);
  assert.equal(view(b).requestId, r1);
  const removes = [];
  const original = app.store.removeItem;
  app.store.removeItem = async (k) => { removes.push(k); return original(k); };
  assert.ok(await ack(a));
  assert.ok(await ack(b));
  await app.sync();
  assert.equal(removes.length, 1, 'one clear');
  assert.equal(app.flow.attemptMemory.get('UA'), null);
  const bAfter = view(b);
  if (bAfter.requestId !== null) { assert.ok(await ack(b)); await app.sync(); }
  assert.equal(view(b).requestId, null, 'B ends without the attempt');
  assert.equal(p.sends.length, 1);
  t.diagnostic(`B right after the refused second press: ${JSON.stringify(bAfter)}`);
});

test('G2-AK3: while an acknowledge is still clearing (removal held), another screen\'s same-id re-ask does not go out (that screen offers no new post while the attempt is known); after it finishes, a new post can go', async () => {
  const { p, app, a, b } = await twoOnOneAttempt(PENDING);
  const gate = app.store.holdNextRemove();
  assert.ok(await ack(a));
  await app.sync();
  assert.equal(gate.taken, true, 'the clear is in progress');
  await reAsk(b, 2);
  await app.sync();
  assert.equal(p.sends.length, 1, 'the same-id re-ask did not go out');
  gate.release();
  await app.sync();
  assert.equal(app.flow.attemptMemory.get('UA'), null, 'acknowledged');
  assert.equal(recordOf(app), 0);
  const c = await app.open();
  assert.ok(await c.trySend('次の投稿'), 'a new post is offered');
  await app.sync();
  assert.equal(p.sends.length, 2, 'and goes out with a new id');
  assert.notEqual(p.sends[1].target.targetId, p.sends[0].target.targetId);
});

test('G2-AK4: the removal FAILS -- nothing is cleared, the screen says so, the reservation is released (a later acknowledge works)', async () => {
  const { p, app, a } = await twoOnOneAttempt(UNCERTAIN);
  app.store.failRemovals(true);
  assert.ok(await ack(a));
  await app.sync();
  assert.equal(app.flow.attemptMemory.get('UA')?.kind, 'uncertain', 'memory kept');
  assert.equal(recordOf(app), 1, 'record kept');
  assert.notEqual(view(a).requestId, null, 'still shows the attempt');
  assert.equal(app.flow.inFlightSends.takeOver('UA'), null);
  app.store.failRemovals(false);
  assert.ok(await ack(a));
  await app.sync();
  assert.equal(app.flow.attemptMemory.get('UA'), null, 'the next acknowledge clears');
  assert.equal(p.sends.length, 1);
});

test('G2-AK5: sign-out and the same person signing in again while an acknowledge is still clearing -- the new screen shows the attempt until the clear ends; the clear of the old screen still finishes cleanly; nothing is sent', async (t) => {
  const { p, app, a } = await twoOnOneAttempt(UNCERTAIN);
  const gate = app.store.holdNextRemove();
  assert.ok(await ack(a));
  await app.sync();
  await app.auth(null);
  await app.auth(session('UA', T2, 'rig-at-2'));
  assert.equal(view(a).kind, 'uncertain', 'the re-created screen shows the attempt while the clear is still running');
  gate.release();
  await app.sync();
  assert.equal(app.flow.attemptMemory.get('UA'), null, 'the clear finished');
  assert.equal(recordOf(app), 0);
  assert.equal(p.sends.length, 1);
  t.diagnostic(`re-created screen after the clear: ${JSON.stringify(view(a))}`);
});

test('G2-AK6: a stale "I checked X" for the OLD attempt while the process knows a NEWER unresolved one (not out) -- refused as stale, the newer one is kept and shown', async () => {
  const { p, app, a, b, r1 } = await twoOnOneAttempt(UNCERTAIN);
  assert.ok(await ack(a));
  await app.sync();
  assert.ok(await a.trySend('Aさんの次の投稿'));
  answerOf(p.sends[1], UNCERTAIN);
  await app.sync();
  const r2 = p.sends[1].target.targetId;
  assert.equal(view(b).requestId, r1, 'B still shows the old one');
  assert.ok(await ack(b));
  await app.sync();
  assert.equal(app.flow.attemptMemory.get('UA')?.requestId, r2, 'the newer attempt is kept');
  assert.equal(recordOf(app), 1);
  assert.equal(view(b).requestId, r2, 'B is brought to it');
});

test('KNOWN (H1 #306 POST_ACK_SAME_ID_REASK_OPEN, G1 next TASK, not a new finding): after A acknowledged, B\'s stale same-id re-ask still goes out -- measured', async () => {
  const { p, app, a, b, r1 } = await twoOnOneAttempt(PENDING);
  assert.ok(await ack(a));
  await app.sync();
  assert.equal(app.flow.attemptMemory.get('UA'), null);
  await reAsk(b, 1);
  await app.sync();
  assert.equal(p.sends.length, 2, 'a second request');
  assert.equal(p.sends[1].target.targetId, r1, 'with the same id');
});

// ---- negative controls (AST on #450) ---------------------------------------------------------------------------------
test('negative controls (heads with the acknowledge reservation): (1) no reservation -> AK1 clears the out post; (2) no stale check -> AK6 clears the newer attempt; (3) the screen ignores a refused acknowledge -> AK1 does not take over', { skip: HAS_ACK_RESERVATION ? false : 'no acknowledge reservation on this head' }, async () => {
  const f = ts.factory;
  const noReservation = mutate2(FLOW_SOURCE, ts.ScriptKind.TS, (n) => ts.isIfStatement(n) && n.expression.getText() === 'handle === null' && n.thenStatement.getText().includes("reason: 'in_progress'"), () => f.createEmptyStatement());
  assert.equal(noReservation.n, 1);
  {
    const flowModule = await importFlow2(noReservation.text);
    const p = scriptedPort();
    const app = await createApp({ port: p.port, flowModule });
    await app.auth(session('UA', T1));
    const a = await app.open();
    assert.ok(await a.trySend(TEXT));
    answerOf(p.sends[0], PENDING);
    await app.sync();
    const b = await app.open();
    await reAsk(a, 1);
    await app.sync();
    assert.ok(await ack(b));
    await app.sync();
    assert.equal(recordOf(app), 0, 'mutant 1: the out post\'s record is gone');
  }
  const noStale = mutate2(FLOW_SOURCE, ts.ScriptKind.TS, (n) => ts.isIfStatement(n) && n.thenStatement.getText().includes("reason: 'stale'"), () => f.createEmptyStatement());
  assert.equal(noStale.n, 1);
  {
    const flowModule = await importFlow2(noStale.text);
    const p = scriptedPort();
    const app = await createApp({ port: p.port, flowModule });
    await app.auth(session('UA', T1));
    const a = await app.open();
    assert.ok(await a.trySend(TEXT));
    answerOf(p.sends[0], UNCERTAIN);
    await app.sync();
    const b = await app.open();
    assert.ok(await ack(a));
    await app.sync();
    assert.ok(await a.trySend('Aさんの次の投稿'));
    answerOf(p.sends[1], UNCERTAIN);
    await app.sync();
    assert.ok(await ack(b));
    await app.sync();
    assert.equal(app.flow.attemptMemory.get('UA'), null, 'mutant 2: the newer attempt is cleared by the old screen');
  }
  const noAdopt = mutate2(ROUTE_SOURCE, ts.ScriptKind.TSX, (n) => ts.isIfStatement(n) && n.expression.getText() === "result.kind === 'refused'", () => f.createEmptyStatement());
  assert.equal(noAdopt.n, 1);
  {
    const { p, app, a, b } = await staleReAsk(PUBLISHED, { routeSource: noAdopt.text });
    assert.ok(await a.press('新しい投稿を作る'));
    assert.ok(await a.trySend('Aさんの次の投稿'));
    assert.ok(await ack(b));
    await app.sync();
    assert.notEqual(b.state().phase, 'sending', 'mutant 3: B does not take over A\'s out post');
    assert.equal(p.sends.length, 3);
  }
});

test('KNOWN entrance (same root as POST_ACK_SAME_ID_REASK_OPEN, not a new finding): a PENDING attempt acknowledged while the person signs out and in -- the re-created screen keeps showing it with the same-id re-ask after the clear, and that re-ask goes out', async (t) => {
  const { p, app, a, r1 } = await twoOnOneAttempt(PENDING);
  const gate = app.store.holdNextRemove();
  assert.ok(await ack(a));
  await app.sync();
  await app.auth(null);
  await app.auth(session('UA', T2, 'rig-at-2'));
  gate.release();
  await app.sync();
  assert.equal(app.flow.attemptMemory.get('UA'), null, 'cleared');
  t.diagnostic(`re-created screen after the clear: ${JSON.stringify(view(a))}`);
  assert.equal(view(a).requestId, r1, 'still shows the acknowledged attempt');
  assert.ok(a.button(SAME_ID), 'with the same-id re-ask');
  await reAsk(a, 1);
  await app.sync();
  assert.equal(p.sends.length, 2);
  assert.equal(p.sends[1].target.targetId, r1);
});
