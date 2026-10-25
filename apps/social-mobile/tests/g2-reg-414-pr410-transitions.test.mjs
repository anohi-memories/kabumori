// G2-46 REGRESSION COPY (Issue #317, task postona-g2-existing-ui-regression-suite-consolidated-repair-20261025) of G2 PR #414
// 7b150a89 tests/g2-pr410-transitions.test.mjs, repaired to run on G1 #497 446a9c39 (the #414 original is NOT changed).
// Repairs are marked "G2-46 repair"; see docs/postona/qa/g2-ui-regression-repair/README.md.
// --- original header ---
// G2 QA (Issue #317, task postona-g2-pr410-uncertain-session-transition-contract-qa-20261021) -- QA only, no product code.
// Cross-conditions of G1 PR #410 (a screen opened while a send is still out takes the send over) with sign-in
// boundaries, on the REAL route + screen + model + flow + stores, MOCK sessions and a scripted future send port.
// Offline: no network, no X, no token. The meaning of the real Auth `last_sign_in_at` is NOT_VERIFIED.
//
// G1's own #410 tests already cover: re-created once or several times by a mark change, every answer kind, an account
// change while waiting, a lost registry, "only a send that is really out", the screen's own send, a text-less attempt.
// G2 #411 covers the single take-over case. This file adds only boundaries those do not: a SIGNED_OUT gap, another person
// in between, a take-over of a same-id RE-ASK, the next request id, and a forced press; plus three AST negative controls.
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
import { sameIdShown } from './g2-reg-copy-contract.mjs';

const ROUTE_SOURCE = await readFile(new URL('../src/app/manual-publish.tsx', import.meta.url), 'utf8');
const FLOW_URL = new URL('../src/features/manual-publish/manual-publish-flow.ts', import.meta.url);
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
// G2-46 repair: the exact old sentence is no longer pinned; `sameIdShown` judges the same-id sentence by meaning (M1-M3).
const POSTED = 'Xが投稿を受け付けました';
const T1 = '2026-10-20T08:00:00.000000Z';
const T2 = '2026-10-20T09:30:00.000000Z';
const T3 = '2026-10-20T10:45:00.000000Z';
const session = (id, mark, token = 'rig-at-1') => ({ access_token: token, user: { id, last_sign_in_at: mark } });
const account = (id) => ({ id, brandId: 'A', platform: 'x', profile: { displayName: `name-${id}`, handle: `@${id}`, avatarColor: '#123456' }, connectionStatus: 'connected', postingState: 'active' });
const REAL = { simulated: false, afterFreeze: false };
function kv() { const data = new Map(); return { data, getItem: async (k) => (data.has(k) ? data.get(k) : null), setItem: async (k, v) => { data.set(k, v); }, removeItem: async (k) => { data.delete(k); } }; }
function scriptedPort() {
  const sends = [];
  return { sends, port: { checkReadiness: async () => ({ kind: 'ready' }), send: (target) => new Promise((resolve) => { sends.push({ target, resolve }); }) } };
}

// ---- AST mutants -------------------------------------------------------------------------------------------------------
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const f = ts.factory;
function mutate(source, kind, visitorOf) {
  const file = ts.createSourceFile('x', source, ts.ScriptTarget.ES2022, true, kind);
  const counter = { n: 0 };
  const result = ts.transform(file, [(context) => (root) => { const visit = visitorOf(context, counter); return ts.visitNode(root, function v(node) { return visit(node) ?? ts.visitEachChild(node, v, context); }); }]);
  return { text: printer.printFile(result.transformed[0]), n: counter.n };
}
/** The useReducer initializer's take-over branch (`if (out !== null) return createSendingState(...)`, #468) removed. G2-46 repair: re-anchored (#410 had `inFlightSends.isOut(`). */
const withoutTakeOver = (src) => mutate(src, ts.ScriptKind.TSX, (_c, k) => (node) => {
  if (ts.isIfStatement(node) && node.thenStatement.getText().includes('createSendingState(')) { k.n += 1; return f.createEmptyStatement(); }
  return undefined;
});
/** The take-over effect's `.then` callback emptied: the waiting screen never applies the answer. */
const takeOverNeverApplies = (src) => mutate(src, ts.ScriptKind.TSX, (context, k) => (node) => {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.getText() === 'then' && ['waiting', 'takenOver.answer'].includes(node.expression.expression.getText())) { // G2-46 repair: `takenOver.answer` on #468
    k.n += 1;
    return f.updateCallExpression(node, node.expression, node.typeArguments, [f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), f.createBlock([]))]);
  }
  return undefined;
});
/** runSend without `deps.inflight?.begin(userId, requestId)`: nothing is registered as out. */
async function flowWithoutBegin() {
  const { text, n } = mutate(await readFile(FLOW_URL, 'utf8'), ts.ScriptKind.TS, (_c, k) => (node) => {
    // G2-46 repair: on #468 the registration is the block `if (deps.inflight !== undefined) { handle = deps.inflight.begin(..);
    // if (handle === null) return notStarted(..); }` (it was one `deps.inflight?.begin(` statement on #410). Removing only the
    // assignment would refuse every send; the mutant removes the whole block: the send runs, but nothing is registered.
    if (ts.isIfStatement(node) && node.expression.getText() === 'deps.inflight !== undefined' && node.thenStatement.getText().includes('deps.inflight.begin(')) { k.n += 1; return f.createEmptyStatement(); }
    return undefined;
  });
  assert.equal(n, 1, 'exactly one registration block in runSend');
  const fixed = text.replace(/from "(\.[^"]+)"/gu, (_m, rel) => `from "${new URL(rel, FLOW_URL).href}"`).replace(/from '(\.[^']+)'/gu, (_m, rel) => `from '${new URL(rel, FLOW_URL).href}'`);
  const dir = await mkdtemp(join(tmpdir(), 'g2-410-'));
  try { await writeFile(join(dir, 'flow.mutant.ts'), fixed); return await import(join(dir, 'flow.mutant.ts')); } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---- harness ---------------------------------------------------------------------------------------------------------
async function createApp({ port, source = ROUTE_SOURCE, flowModule = realFlow } = {}) {
  const world = { session: null, accounts: [account('X_A'), account('X_B')], status: 'ready' };
  // A fresh registry per app when the head has one (#410); heads before #410 have none and run as they are.
  const flow = { ...flowModule, attemptMemory: flowModule.createAttemptMemory(), ...(flowModule.createInFlightSends ? { inFlightSends: flowModule.createInFlightSends() } : {}) };
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
    'react-native': { Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-router': { Link: 'Link', Stack: { Screen: 'StackScreen' } },
    'expo-crypto': { randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '@/constants/theme': { colors: new Proxy({}, { get: (_t, name) => String(name) }), spacing: { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: { muted: true } } },
    '@/features/manual-publish/manual-post-preview': { ManualPostPreview: 'ManualPostPreview' },
    '@/features/manual-publish/manual-publish-flow': flow,
    '@/features/manual-publish/manual-publish-model': model,
    '@/features/manual-publish/manual-publish-port': { ...realPort, getManualPublishPort: () => port },
    '@/features/manual-publish/manual-publish-storage': { attemptStore: realStore.createAttemptStore(kv()), draftStore: realDraft.createDraftStore(kv()) },
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
  const lines = () => { const out = []; const visit = (node) => { if (Array.isArray(node)) { node.forEach(visit); return; } if (node === null || typeof node !== 'object') return; if (node.props?.label) out.push(node.props.label); const kids = [node.props?.children].flat(Infinity); const own = kids.filter((x) => typeof x === 'string' || typeof x === 'number').join(''); if (own !== '') out.push(own); kids.forEach((x) => { if (x !== null && typeof x === 'object') visit(x); }); }; visit(screen.tree); return out; };
  const api = {
    world, sync, lines,
    async auth(s) { world.session = s; await sync(); },
    async open() { screen = { key: Symbol('none'), inst: newInst() }; await sync(); },
    state: () => screen.inst.slots[0].v,
    button: (label) => find('ActionButton').find((b) => b.props.label === label) ?? null,
    async press(label) { const b = api.button(label); assert.ok(b, `button "${label}" exists`); if (b.props.disabled) return false; b.props.onPress(); await sync(); return true; },
    async type(value) { find('TextInput')[0].props.onChangeText(value); await sync(); },
    async tick() { const box = find('Pressable').find((n) => n.props.accessibilityRole === 'checkbox'); assert.ok(box, 'consent checkbox'); box.props.onPress(); await sync(); },
    async sendText(value) { await api.type(value); assert.ok(await api.press('内容を確認する')); await api.tick(); const b = api.button('Xに投稿する'); assert.ok(b && !b.props.disabled, 'send enabled'); b.props.onPress(); b.props.onPress(); await sync(); },
    posted: () => lines().some((l) => l.includes(POSTED)),
    reAsk: () => api.button('同じ内容・同じ送信IDで確認し直す'),
  };
  return api;
}

// ---- scenarios -------------------------------------------------------------------------------------------------------

/** A sends; SIGNED_OUT; A signs in again (new mark) while the request is still out; then the answer arrives. */
async function signOutGap(answer, opts = {}) {
  const p = scriptedPort();
  const app = await createApp({ ...opts, port: p.port });
  await app.auth(session('UA', T1));
  await app.open();
  await app.sendText('ログアウトをまたぐ送信');
  await app.auth(null);
  const signedOut = { phase: app.state().phase, draft: app.state().draft, unresolved: app.state().unresolved };
  await app.auth(session('UA', T2, 'rig-at-2'));
  const back = { phase: app.state().phase, reAsk: app.reAsk() !== null, unconfirmed: app.lines().some((l) => l.includes('通信できず')) };
  p.sends[0].resolve({ ...answer, targetId: p.sends[0].target.targetId });
  await app.sync();
  await app.sync();
  return { p, app, signedOut, back };
}

// ---- tests -----------------------------------------------------------------------------------------------------------

test('G2-410-1: a SIGNED_OUT gap while the request is out -- the signed-out screen shows nothing; the same person signing back in (new mark) gets "sending" (no verdict, no re-ask), then the real answer', async () => {
  const { p, app, signedOut, back } = await signOutGap({ kind: 'published', providerPostId: '1850000000000000001', marks: REAL });
  assert.deepEqual([signedOut.draft, signedOut.unresolved], ['', null], 'signed out: nothing of the send');
  assert.deepEqual(back, { phase: 'sending', reAsk: false, unconfirmed: false });
  assert.ok(app.posted());
  assert.equal(p.sends.length, 1);
});

test('G2-410-2: another person signs in while A\'s request is out and A\'s answer arrives meanwhile -- B never sees it; when A signs in again, A sees only what the answer left (posted -> a clean editor; uncertain -> uncertain, no re-ask)', async () => {
  for (const [answer, expectA] of [[{ kind: 'published', providerPostId: '1850000000000000001', marks: REAL }, 'editing'], [{ kind: 'uncertain', code: 'X_TIMEOUT', marks: REAL }, 'result']]) {
    const p = scriptedPort();
    const app = await createApp({ port: p.port });
    await app.auth(session('UA', T1));
    await app.open();
    await app.sendText('Aさんの送信');
    await app.auth(session('UB', T1));
    assert.deepEqual([app.state().phase, app.state().draft, app.state().unresolved], ['editing', '', null], `${answer.kind}: B starts clean`);
    p.sends[0].resolve({ ...answer, targetId: p.sends[0].target.targetId });
    await app.sync();
    assert.equal(app.posted(), false, `${answer.kind}: B is not told`);
    assert.equal(app.state().unresolved, null);
    await app.auth(null);
    await app.auth(session('UA', T3, 'rig-at-3'));
    assert.equal(app.state().phase, expectA, `${answer.kind}: A afterwards`);
    if (answer.kind === 'uncertain') { assert.equal(app.state().unresolved?.kind, 'uncertain'); assert.equal(app.reAsk(), null); }
    assert.equal(app.posted(), false, 'nothing claims a post that A did not see confirmed on this screen');
    assert.equal(p.sends.length, 1);
  }
});

// G2-46 repair: G1 #468 (P2-2) fixed G2-410-3 -- a take-over of a RE-ASK says it is a re-ask -- so the FINDING is now a
// regression guard, with both halves (the starting screen AND the take-over screen) checked by meaning.
test('FIXED G2-410-3 (regression guard since #468 P2-2, was FINDING on #410): a take-over of a same-id RE-ASK keeps explaining the same id (retrying), and the real answer of the re-ask reaches it', async () => {
  const p = scriptedPort();
  const app = await createApp({ port: p.port });
  await app.auth(session('UA', T1));
  await app.open();
  await app.sendText('再送をまたぐ送信');
  p.sends[0].resolve({ kind: 'unavailable', targetId: p.sends[0].target.targetId, code: 'TRANSPORT_FAILED' });
  await app.sync();
  assert.ok(await app.press('同じ内容・同じ送信IDで確認し直す'));
  await app.tick();
  app.button('Xに投稿する').props.onPress();
  await app.sync();
  assert.equal(p.sends.length, 2);
  assert.equal(p.sends[1].target.targetId, p.sends[0].target.targetId, 'the re-ask is the same id');
  assert.ok(sameIdShown(app.lines()), 'the starting screen explains the same id while the re-ask is out');
  await app.auth(session('UA', T2, 'rig-at-2')); // re-created while the re-ask is out
  assert.equal(app.state().phase, 'sending', 'taken over');
  assert.equal(app.state().retrying, true, 'taken over as a re-ask');
  assert.ok(sameIdShown(app.lines()), 'the take-over screen still explains the same id');
  p.sends[1].resolve({ kind: 'published', targetId: p.sends[1].target.targetId, providerPostId: '1850000000000000001', marks: REAL });
  await app.sync();
  assert.ok(app.posted(), 'the real answer of the re-ask reaches the take-over screen');
  assert.equal(p.sends.length, 2);
});

test('G2-410-4: after a taken-over send ends as posted, the next post gets a NEW request id', async () => {
  const { p, app } = await signOutGap({ kind: 'published', providerPostId: '1850000000000000001', marks: REAL });
  assert.ok(await app.press('新しい投稿を作る'));
  await app.sendText('次の投稿');
  assert.equal(p.sends.length, 2);
  assert.notEqual(p.sends[1].target.targetId, p.sends[0].target.targetId);
});

test('G2-410-5: a forced press of the send button on the take-over screen sends nothing (the gate says "sending")', async () => {
  const p = scriptedPort();
  const app = await createApp({ port: p.port });
  await app.auth(session('UA', T1));
  await app.open();
  await app.sendText('二度押し');
  await app.auth(session('UA', T2, 'rig-at-2'));
  const busy = app.button('送信中…');
  assert.ok(busy && busy.props.disabled);
  busy.props.onPress();
  busy.props.onPress();
  await app.sync();
  assert.equal(p.sends.length, 1);
});

// ---- negative controls (AST) -------------------------------------------------------------------------------------------

test('negative controls: without the take-over branch, without registering the send, or with a take-over that never applies the answer, the SIGNED_OUT-gap scenario shows the regression', async () => {
  const noTakeOver = withoutTakeOver(ROUTE_SOURCE);
  assert.equal(noTakeOver.n, 1, 'exactly one take-over branch');
  const a = await signOutGap({ kind: 'published', providerPostId: '1850000000000000001', marks: REAL }, { source: noTakeOver.text });
  assert.notEqual(a.back.phase, 'sending', 'mutant 1: not taken over');
  assert.ok(a.back.reAsk || a.back.unconfirmed, 'mutant 1: a verdict / re-ask before the answer');

  const b = await signOutGap({ kind: 'published', providerPostId: '1850000000000000001', marks: REAL }, { flowModule: await flowWithoutBegin() });
  assert.notEqual(b.back.phase, 'sending', 'mutant 2: nothing registered, nothing taken over');

  const neverApplies = takeOverNeverApplies(ROUTE_SOURCE);
  assert.equal(neverApplies.n, 1, 'exactly one take-over answer .then');
  const c = await signOutGap({ kind: 'published', providerPostId: '1850000000000000001', marks: REAL }, { source: neverApplies.text });
  assert.equal(c.back.phase, 'sending');
  assert.equal(c.app.posted(), false, 'mutant 3: the answer never reaches the take-over screen');
});
