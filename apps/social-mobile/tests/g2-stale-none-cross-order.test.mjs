// G2 QA (Issue #317, task postona-g2-x-uncertain-stale-none-p2-contract-negative-qa-20261022) -- QA only, no product code.
// H1's residual P2 on G1 PR #416 (a send ends uncertain; another screen's OLD "none" read then lets a NEW request id go
// out) -- the crossing orders H1's probe and G1's PR #427 tests do not cover, on the REAL route + screen + model + flow +
// stores with several screens of one app process, MOCK sessions, a scripted future send port and a key-value store whose
// reads can be held after their snapshot was taken. Offline: no network, no X, no token. Promise-order mocks only: real
// React scheduling and real AsyncStorage delivery order are NOT_VERIFIED.
//
// Already covered elsewhere (not repeated): the stale-none repro x uncertain / pending / unavailable / simulated, the
// overwritten shared memory, an old "found" vs a newer memory, the send-entry refusals, no over-block after "published",
// several remounts, another user, a failed late read (H1 #306 REPORT 6316894168; G1 PR #427). This file adds:
//   SN1 a screen that loaded BEFORE the send (no stale read at all) sends a new id after the send ended unresolved;
//   SN2 the stale screen picks ANOTHER X account for its new id;
//   SN3 no over-block after the other proven ends (rejected, refused) and after the user's "I checked X";
//   SN4 sign-out + the same person signing in again turns the stale screen into a new one (the old read lands nowhere);
//   SN5 what the screen shows when the send-entry wall refuses it (observation).
// SN1 and SN2 are RELEASE GATES: marked `todo` so the suite stays usable, but they run and report FAIL on any head
// without a fix (G1 PR #416). A green gate on an unreviewed candidate (G1 PR #427) is not "fixed".
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
    removeItem: async (k) => { data.delete(k); },
    holdNextRead() { hold = { taken: false, release: null }; return hold; },
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

// ---- release gates --------------------------------------------------------------------------------------------------

test('RELEASE GATE G2-SN1: a screen that loaded BEFORE the send (no stale read at all) must not send a NEW id after the send ended uncertain / pending', GATE, async () => {
  for (const end of [UNCERTAIN, PENDING]) {
    const { p, b } = await crossing({ end, bLoadsFirst: true });
    assert.equal(b.state().unresolved, null, `${end.kind}: B was loaded clean before the send (its view is not stale-read)`);
    await b.trySend(TEXT);
    assert.equal(p.sends.length, 1, `${end.kind}: no second request (a new id ${p.sends[1]?.target.targetId ?? ''})`);
    assert.equal(b.posted(), false);
  }
});

test('RELEASE GATE G2-SN2: the stale screen picks ANOTHER X account for its new id -- still no second request while the first attempt is unresolved', GATE, async () => {
  const { p, b } = await crossing({ end: UNCERTAIN });
  await b.trySend(TEXT, 'X_B');
  if (p.sends[1]) assert.equal(p.sends[1].target.connectedAccountId, 'X_B', 'where a second request goes, it goes to the other account');
  assert.equal(p.sends.length, 1, 'no request to another account while the first attempt is unresolved');
});

// ---- no over-block --------------------------------------------------------------------------------------------------

test('G2-SN3: no over-block -- after the other proven ends (rejected, refused) and after the user\'s "I checked X", the stale screen CAN send a new id', async () => {
  for (const end of [{ kind: 'rejected', code: 'X_DUPLICATE', marks: REAL }, { kind: 'refused', code: 'X_NOT_ALLOWED', retryable: false }]) {
    const { p, b } = await crossing({ end });
    assert.ok(await b.trySend(TEXT), `${end.kind}: B is offered a send`);
    assert.equal(p.sends.length, 2, `${end.kind}: a new request`);
    assert.notEqual(p.sends[1].target.targetId, p.sends[0].target.targetId, `${end.kind}: with a new id`);
  }
  // "I checked X": A acknowledges the uncertain attempt, THEN B's old read lands.
  const p = scriptedPort();
  const app = await createApp({ port: p.port });
  await app.auth(session('UA', T1));
  const a = await app.open();
  const hold = app.store.holdNextRead();
  const b = await app.open();
  assert.ok(await a.trySend(TEXT));
  answerOf(p.sends[0], UNCERTAIN);
  await app.sync();
  assert.ok(await a.press('Xで確認しました（この下書きを破棄）'), 'A acknowledges');
  assert.equal(app.flow.attemptMemory.get('UA'), null, 'the attempt is forgotten');
  hold.release();
  await app.sync();
  assert.ok(await b.trySend(TEXT), 'B is offered a send');
  assert.equal(p.sends.length, 2, 'a new request after the user checked X');
});

// ---- sign-out / sign-in ---------------------------------------------------------------------------------------------

test('G2-SN4: a sign-out and the same person signing in again (a new session) re-create the stale screen -- its old read lands nowhere, and the new screen shows the unresolved attempt, so no new id can go out', async () => {
  const { p, app, b } = await (async () => {
    const p2 = scriptedPort();
    const app2 = await createApp({ port: p2.port });
    await app2.auth(session('UA', T1));
    const a2 = await app2.open();
    const hold = app2.store.holdNextRead();
    const b2 = await app2.open();
    assert.ok(await a2.trySend(TEXT));
    answerOf(p2.sends[0], UNCERTAIN);
    await app2.sync();
    const before = b2.generation();
    await app2.auth(null);
    await app2.auth(session('UA', T2, 'rig-at-2'));
    assert.ok(b2.generation() > before, 'B was re-created by the new session');
    hold.release(); // the old read of the old B
    await app2.sync();
    return { p: p2, app: app2, b: b2 };
  })();
  assert.equal(b.state().unresolved?.kind, 'uncertain', 'the new B shows the unresolved attempt');
  assert.equal(b.state().unresolved?.requestId, p.sends[0].target.targetId);
  await b.trySend(TEXT);
  assert.equal(p.sends.length, 1, 'no new id');
  assert.equal(app.flow.attemptMemory.get('UA')?.requestId, p.sends[0].target.targetId, 'the memory still holds the first attempt');
});

// ---- observation ------------------------------------------------------------------------------------------------------

test('OBSERVATION G2-SN5 (heads with the send-entry wall only): what a screen that loaded before the send shows when the wall refuses its new id', { skip: HAS_SEND_ENTRY_WALL ? false : 'no send-entry wall on this head' }, async () => {
  const { p, b, app } = await crossing({ end: UNCERTAIN, bLoadsFirst: true });
  await b.trySend(TEXT);
  assert.equal(p.sends.length, 1);
  const shown = { phase: b.state().phase, result: b.state().result?.kind ?? null, unresolved: b.state().unresolved?.kind ?? null };
  const memory = app.flow.attemptMemory.get('UA');
  assert.equal(memory?.requestId, p.sends[0].target.targetId, 'the first attempt is untouched');
  assert.equal(memory?.kind, 'uncertain');
  // What the refused screen says: a plain local refusal -- nothing about the earlier attempt that may already be on X.
  assert.deepEqual(shown, { phase: 'result', result: 'refused', unresolved: null });
  const said = b.lines();
  assert.ok(said.includes('コード: LOCAL_UNRESOLVED_ATTEMPT'));
  assert.ok(said.includes('サーバーは何も記録していません。本文は残してあります。'));
  assert.equal(said.some((l) => l.includes('投稿された可能性')), false, 'no word that the earlier attempt may be on X');
  assert.equal(b.button('Xで確認しました（この下書きを破棄）'), null, 'no "I checked X" here');
  // "Back to editing" offers the same new send again; the wall refuses it again (no request, same screen).
  assert.ok(await b.press('編集に戻る'));
  assert.equal(b.state().unresolved, null, 'back in an editor that still knows nothing of the attempt');
  await b.trySend(TEXT);
  assert.equal(p.sends.length, 1, 'refused again, still one request');
  assert.equal(b.state().result?.kind, 'refused');
});

// ---- negative controls (AST) ------------------------------------------------------------------------------------------
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const f = ts.factory;
function mutate(source, kind, predicate, replace) {
  const file = ts.createSourceFile('x', source, ts.ScriptTarget.ES2022, true, kind);
  let n = 0;
  const result = ts.transform(file, [(context) => (root) => ts.visitNode(root, function v(node) { if (predicate(node)) { n += 1; return replace(node); } return ts.visitEachChild(node, v, context); })]);
  return { text: printer.printFile(result.transformed[0]), n };
}
async function importFlow(text) {
  const fixed = text.replace(/from "(\.[^"]+)"/gu, (_m, rel) => `from "${new URL(rel, FLOW_URL).href}"`).replace(/from '(\.[^']+)'/gu, (_m, rel) => `from '${new URL(rel, FLOW_URL).href}'`);
  const dir = await mkdtemp(join(tmpdir(), 'g2-sn-'));
  try { await writeFile(join(dir, 'flow.mutant.ts'), fixed); return await import(join(dir, 'flow.mutant.ts')); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('negative control NC1 (heads with the send-entry wall): without the wall, the gates turn red again (SN1 and SN2 each see a second request)', { skip: HAS_SEND_ENTRY_WALL ? false : 'no send-entry wall on this head (nothing to remove)' }, async () => {
  const { text, n } = mutate(FLOW_SOURCE, ts.ScriptKind.TS, (node) => ts.isIfStatement(node) && node.thenStatement.getText().includes("'LOCAL_UNRESOLVED_ATTEMPT'"), () => f.createEmptyStatement());
  assert.equal(n, 1, 'exactly one wall');
  const flowModule = await importFlow(text);
  const one = await crossing({ end: UNCERTAIN, bLoadsFirst: true, opts: { flowModule } });
  await one.b.trySend(TEXT);
  assert.equal(one.p.sends.length, 2, 'mutant: SN1 sees a new id');
  const two = await crossing({ end: UNCERTAIN, opts: { flowModule } });
  await two.b.trySend(TEXT, 'X_B');
  const reconciles = FLOW_SOURCE.includes('export function reconcileLoadedRead(');
  // With the screen-side reconcile still in place, the stale screen shows the attempt and offers no new send (second wall).
  assert.equal(two.p.sends.length, reconciles ? 1 : 2, 'mutant: SN2 relies on the screen-side reconcile alone');
});

test('negative control NC2: a proven end that keeps the attempt (memory.clear dropped from the proven-end branch) over-blocks on heads with the wall (SN3 turns red), and changes nothing on heads without', async () => {
  const { text, n } = mutate(FLOW_SOURCE, ts.ScriptKind.TS, (node) => ts.isExpressionStatement(node) && node.expression.getText() === 'deps.memory.clear(userId)' && node.parent?.parent && ts.isIfStatement(node.parent.parent) && node.parent.parent.expression.getText().includes("result.kind === 'sent'"), () => f.createExpressionStatement(f.createIdentifier('void 0')));
  assert.equal(n, 1, 'exactly one proven-end clear');
  const flowModule = await importFlow(text);
  const { p, b } = await crossing({ end: { kind: 'rejected', code: 'X_DUPLICATE', marks: REAL }, opts: { flowModule } });
  await b.trySend(TEXT);
  assert.equal(p.sends.length, HAS_SEND_ENTRY_WALL ? 1 : 2, HAS_SEND_ENTRY_WALL ? 'mutant: over-block (SN3 fails)' : 'no wall: the mutant is invisible to SN3 on this head');
});

/** The stale-read path of a session change: the route keeps ONE screen across sessions (key fixed) and/or the store-load
 * effect no longer ignores a read it cancelled. */
function staleRoute({ fixedKey, ignoreCancel }) {
  let text = ROUTE_SOURCE;
  if (fixedKey) {
    const r = mutate(text, ts.ScriptKind.TSX, (node) => ts.isJsxAttribute(node) && node.name.getText() === 'key' && node.parent?.parent?.tagName?.getText() === 'ManualPublishScreen', (node) => f.updateJsxAttribute(node, node.name, f.createStringLiteral('fixed')));
    assert.equal(r.n, 1, 'exactly one route key');
    text = r.text;
  }
  if (ignoreCancel) {
    const insideLoad = (node) => { for (let p = node.parent; p; p = p.parent) if (ts.isCallExpression(p) && p.expression.getText().startsWith('loadPersistedAttempt(')) return true; return false; };
    const r = mutate(text, ts.ScriptKind.TSX, (node) => ts.isIfStatement(node) && node.expression.getText() === 'cancelled || !mountedRef.current' && insideLoad(node), (node) => f.updateIfStatement(node, f.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, f.createPropertyAccessExpression(f.createIdentifier('mountedRef'), 'current')), node.thenStatement, node.elseStatement));
    assert.equal(r.n, 1, 'exactly one cancelled check in the store load');
    text = r.text;
  }
  return text;
}
async function signOutInWithStaleRead(routeSource) {
  const p = scriptedPort();
  const app = await createApp({ port: p.port, routeSource });
  await app.auth(session('UA', T1));
  const a = await app.open();
  const hold = app.store.holdNextRead();
  const b = await app.open();
  assert.ok(await a.trySend(TEXT));
  answerOf(p.sends[0], UNCERTAIN);
  await app.sync();
  await app.auth(null);
  await app.auth(session('UA', T2, 'rig-at-2'));
  hold.release();
  await app.sync();
  await b.trySend(TEXT);
  return p.sends.length;
}

test('negative control NC3: an "uncertain" answer treated as a proven end (memory and record cleared) turns SN4 red on every head; removing the session defences one or two at a time does NOT (layered: re-created screen, cancelled read ignored, and a read applied only while loading)', async () => {
  const { text, n } = mutate(FLOW_SOURCE, ts.ScriptKind.TS, (node) => ts.isIfStatement(node) && node.expression.getText() === "result.kind === 'sent' || result.kind === 'failed' || result.kind === 'refused'", (node) => f.updateIfStatement(node, f.createTrue(), node.thenStatement, node.elseStatement));
  assert.equal(n, 1, 'exactly one proven-end condition');
  const flowModule = await importFlow(text);
  const p = scriptedPort();
  const app = await createApp({ port: p.port, flowModule });
  await app.auth(session('UA', T1));
  const a = await app.open();
  const hold = app.store.holdNextRead();
  const b = await app.open();
  assert.ok(await a.trySend(TEXT));
  answerOf(p.sends[0], UNCERTAIN);
  await app.sync();
  await app.auth(null);
  await app.auth(session('UA', T2, 'rig-at-2'));
  hold.release();
  await app.sync();
  await b.trySend(TEXT);
  assert.equal(p.sends.length, 2, 'mutant: a new id goes out (SN4 fails)');
  // The session defences, measured (not a detection claim): each alone, and both together, still stop the new id.
  assert.equal(await signOutInWithStaleRead(staleRoute({ fixedKey: true, ignoreCancel: false })), 1, 'key fixed only');
  assert.equal(await signOutInWithStaleRead(staleRoute({ fixedKey: false, ignoreCancel: true })), 1, 'cancelled read applied only');
  assert.equal(await signOutInWithStaleRead(staleRoute({ fixedKey: true, ignoreCancel: true })), 1, 'both');
});
