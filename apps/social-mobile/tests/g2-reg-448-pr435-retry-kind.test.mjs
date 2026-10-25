// G2-46 REGRESSION COPY (Issue #317, task postona-g2-existing-ui-regression-suite-consolidated-repair-20261025) of G2 PR #448
// d44713bc tests/g2-pr435-retry-kind.test.mjs, repaired to run on G1 #497 446a9c39 (the #448 original is NOT changed).
// Repairs are marked "G2-46 repair"; see docs/postona/qa/g2-ui-regression-repair/README.md.
// --- original header ---
// G2 QA (Issue #317, task postona-g2-x-live-retry-kind-qa-head-parity-offline-20261022) -- QA only, no product code.
// G1 PR #435 (a re-ask may start only for an attempt that may be re-asked NOW; a refused re-ask re-syncs the screen to the
// attempt as the process knows it). G2 #430 measured its release gates on #427 (38bf60cd), not on #435 (5a6c51ca); H1 judged
// both CHANGES_REQUIRED. This file (1) pins that evidence-head correspondence, (2) adds only crossings of #435's diff that
// H1's probes and G1's tests do not cover (repeated taps on a refused re-ask, a sign-out / sign-in in between, a stale re-ask
// while ANOTHER send is out, the known "cleared then re-asked" gate measured, not judged), on the REAL route + screen + model +
// flow + stores with several screens, MOCK sessions and a scripted future send port. Offline; Promise-order mocks only.
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


// ---- evidence-head correspondence (recorded 2026-10-22 12:20 JST, read-only from gh / Issue comments) ---------------------
const HEADS = {
  pr427: '38bf60cd215c2005c49facc1d2d47e8cb0131acc', pr435: '5a6c51ca8441c636cec10a451cc7ab5356b823a9', pr435Base: '38bf60cd215c2005c49facc1d2d47e8cb0131acc',
  g2pr430MeasuredOn: '38bf60cd215c2005c49facc1d2d47e8cb0131acc',
  h1On427: 'CHANGES_REQUIRED', h1On435: 'CHANGES_REQUIRED / PREVIOUS_LIVE_RETRY_KIND_P2_FIXED / ACKNOWLEDGE_INFLIGHT_CLEAR_P2_1 / PRODUCTION_NO_GO',
};
test('G2-HP1 (evidence heads): G2 #430 was measured on #427, #435 sits on #427, and H1 refused both -- #430 is not #435 evidence, and no head here is accepted', () => {
  assert.equal(HEADS.g2pr430MeasuredOn, HEADS.pr427);
  assert.notEqual(HEADS.g2pr430MeasuredOn, HEADS.pr435, '#430 did not measure #435');
  assert.equal(HEADS.pr435Base, HEADS.pr427);
  for (const v of [HEADS.h1On427, HEADS.h1On435]) assert.match(v, /CHANGES_REQUIRED/u);
});

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

test('G2-RK1: B\'s stale re-ask (B still shows "pending") after A\'s re-ask ended uncertain -- tapped three times, twice over: no request, B is brought to "uncertain" with no re-ask, the code of the refusal is not shown as an answer', async () => {
  const { p, app, b } = await staleReAsk(UNCERTAIN);
  for (let round = 0; round < 2; round += 1) {
    await reAsk(b, 3);
    await app.sync();
  }
  assert.equal(p.sends.length, 2, 'only A\'s two requests');
  assert.deepEqual(view(b), { phase: 'result', kind: 'uncertain', requestId: p.sends[0].target.targetId });
  assert.equal(b.button(SAME_ID), null, 'no re-ask of an uncertain attempt');
  assert.equal(b.lines().some((l) => l.includes('LOCAL_UNRESOLVED_ATTEMPT')), false, 'the refusal is not shown as if it were the answer');
  assert.equal(app.flow.attemptMemory.get('UA')?.kind, 'uncertain', 'not downgraded');
});

test('G2-RK2: a sign-out and the same person signing in again between A\'s uncertain re-ask and B\'s stale view -- B is re-created and shows "uncertain" from the memory; nothing to re-ask, no request', async () => {
  const { p, app, b } = await staleReAsk(UNCERTAIN);
  const before = b.generation();
  await app.auth(null);
  await app.auth(session('UA', T2, 'rig-at-2'));
  assert.ok(b.generation() > before, 'B re-created');
  assert.deepEqual(view(b), { phase: 'result', kind: 'uncertain', requestId: p.sends[0].target.targetId });
  assert.equal(b.button(SAME_ID), null);
  assert.equal(await reAsk(b), false, 'nothing to press');
  assert.equal(p.sends.length, 2);
});

test('OBSERVATION G2-RK3 (P3 display, owner G1, on #435): B\'s stale re-ask of the OLD attempt while A\'s NEW post is out -- refused (no request) by the "send in progress" rule, so #435\'s re-sync does not run: B keeps showing the old attempt as unresolved although it was posted', async () => {
  const { p, app, a, b } = await staleReAsk(PUBLISHED);
  const r1 = p.sends[0].target.targetId;
  assert.equal(app.flow.attemptMemory.get('UA'), null, 'the first attempt was posted and forgotten');
  assert.ok(await a.press('新しい投稿を作る'), 'A starts a new post');
  assert.ok(await a.trySend('Aさんの次の投稿'), 'A sends a new post');
  assert.equal(p.sends.length, 3);
  const r2 = p.sends[2].target.targetId;
  assert.notEqual(r2, r1);
  await reAsk(b, 3);
  await app.sync();
  assert.equal(p.sends.length, 3, 'no request from B');
  const shown = view(b);
  assert.equal(shown.requestId, r1, 'B still shows the OLD attempt');
  assert.notEqual(shown.kind, null, 'as unresolved');
  assert.equal(b.lines().some((l) => l.includes('投稿を受け付けました')), false, 'nothing tells B it was posted');
  // G2-46 repair: the #435-era sentence (with the unverified server promise) is not pinned any more; judged by meaning.
  assert.ok(b.lines().includes('結果を確認できません') && sameIdShown(b.lines()), 'B says the OLD (posted) attempt failed to communicate');
  assert.ok(b.lines().includes('コード: LOCAL_SEND_IN_PROGRESS'));
  answerOf(p.sends[2], UNCERTAIN);
  await app.sync();
  assert.equal(view(b).requestId, r1, 'after A\'s new post ends, B still shows the old attempt');
});

// G2-46 repair: G1 #461 / #468 (acknowledge reservation, post-ack fixes) closed this entrance of the H1 P2: "I checked X" on
// the stale screen no longer removes the memory / record of a post that is still out. Now a regression guard.
test('FIXED H1 P2, the RK3 entrance (regression guard since #468, was KNOWN on #435): from that stale screen of RK3, "Xで確認しました" does NOT remove the record and memory of A\'s NEW post while it is still out', async () => {
  const { p, app, a, b } = await staleReAsk(PUBLISHED);
  assert.ok(await a.press('新しい投稿を作る'));
  assert.ok(await a.trySend('Aさんの次の投稿'));
  await reAsk(b, 1);
  await app.sync();
  const r2 = p.sends[2].target.targetId;
  assert.ok(app.flow.inFlightSends.isOut('UA', r2), 'A\'s new post is out');
  const ack = b.button('Xで確認しました（この下書きを破棄）');
  if (ack) { ack.props.onPress(); await app.sync(); }
  assert.ok(app.flow.inFlightSends.isOut('UA', r2), 'still out');
  assert.equal(app.flow.attemptMemory.get('UA')?.requestId, r2, 'memory of the out post: kept');
  assert.equal(app.store.data.size, 1, 'durable record of the out post: kept');
});

// G2-46 repair: G1 #468 (stale re-ask fails closed after the attempt ended elsewhere) closed this gate: B's stale re-ask of
// a POSTED attempt is no longer sent again. Now a regression guard (the server's same-id handling stays NOT_VERIFIED).
test('FIXED gate (regression guard since #468, was KNOWN on #435): A\'s re-ask ends POSTED -- B\'s stale re-ask of the same id is NOT sent again, and B drops that attempt with the "settled on another screen" note', async () => {
  const { p, app, b } = await staleReAsk(PUBLISHED);
  await reAsk(b, 2);
  await app.sync();
  assert.equal(p.sends.length, 2, 'no third request');
  assert.deepEqual(view(b), { phase: 'editing', kind: null, requestId: null }, 'B drops the attempt that ended elsewhere');
  assert.ok(b.lines().some((l) => l.includes('別の画面で確認済み')), 'and says it was settled on another screen');
});

// ---- negative controls (AST) -----------------------------------------------------------------------------------------
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
const HAS_KIND_CHECK = FLOW_SOURCE.includes('!mayRetryAttempt(unresolved)');

test('negative controls (heads with #435\'s kind check): (1) without "may be re-asked NOW", RK1 sees a second same-id request after uncertain; (2) without the screen re-sync, RK1 shows the refusal code as the answer', { skip: HAS_KIND_CHECK ? false : 'no kind check on this head' }, async () => {
  const f2 = ts.factory;
  const one = mutate2(FLOW_SOURCE, ts.ScriptKind.TS, (n) => ts.isPrefixUnaryExpression(n) && n.getText() === '!mayRetryAttempt(unresolved)', () => f2.createFalse());
  assert.equal(one.n, 1);
  {
    const { p, app, b } = await staleReAsk(UNCERTAIN, { flowModule: await importFlow2(one.text) });
    await reAsk(b, 1);
    await app.sync();
    assert.equal(p.sends.length, 3, 'mutant 1: a same-id request after uncertain');
  }
  // G2-46 repair: on #468 the re-sync is `if (retry && code === UNRESOLVED_REFUSAL_CODE && ...)` (a `current` declaration on
  // #435); the mutant makes that condition false, so the refusal is shown as if it were the answer.
  const two = mutate2(ROUTE_SOURCE, ts.ScriptKind.TSX, (n) => ts.isIfStatement(n) && n.expression.getText().includes('code === UNRESOLVED_REFUSAL_CODE'), (n) => f2.updateIfStatement(n, f2.createFalse(), n.thenStatement, n.elseStatement));
  assert.equal(two.n, 1);
  {
    const { p, app, b } = await staleReAsk(UNCERTAIN, { routeSource: two.text });
    await reAsk(b, 1);
    await app.sync();
    assert.equal(p.sends.length, 2, 'still no request');
    assert.ok(b.lines().some((l) => l.includes('LOCAL_UNRESOLVED_ATTEMPT')), 'mutant 2: the refusal code is shown (RK1 fails)');
  }
});

test('negative control (re-anchored G2 #430 NC1 on #435): #435 names the refusal code as a constant, so #430\'s anchor no longer matches -- here the same wall is found by its condition and removed, and a screen loaded before the send again sends a NEW id after uncertain (SN1 turns red)', { skip: HAS_KIND_CHECK ? false : 'no kind check on this head' }, async () => {
  assert.equal(FLOW_SOURCE.includes("notStarted('LOCAL_UNRESOLVED_ATTEMPT')"), false, '#430\'s anchor text is gone on this head');
  const wall = mutate2(FLOW_SOURCE, ts.ScriptKind.TS, (n) => ts.isIfStatement(n) && n.expression.getText().includes('!mayRetryAttempt(unresolved)'), () => ts.factory.createEmptyStatement());
  assert.equal(wall.n, 1, 'exactly one wall');
  const flowModule = await importFlow2(wall.text);
  const p = scriptedPort();
  const app = await createApp({ port: p.port, flowModule });
  await app.auth(session('UA', T1));
  const a = await app.open();
  const b = await app.open();
  assert.ok(await a.trySend(TEXT));
  answerOf(p.sends[0], UNCERTAIN);
  await app.sync();
  await b.trySend(TEXT);
  assert.equal(p.sends.length, 2, 'mutant: a new id goes out');
});
