// G2 QA (Issue #317, task postona-g2-draft-sm2-sm3rt-input-loss-offline-20261023) -- QA only, no product code.
// SM2 (a token refresh that carries a NEW last_sign_in_at -- e.g. after the same person signed in on another device -- deletes
// this device's stored draft) and SM3R-T (the same refresh re-creates the OPEN manual-post screen and the typed text is lost),
// with SCREEN LOST, STORAGE LOST and OLD SCREEN BACK kept apart. G2 #411 pinned both on the screen only; this file adds the
// storage side and the orders around them (a save still on its way, a restore still pending, the confirmation step), on the
// latest G1 head #468 (45ee9ac3; H1 focused PASS on its own P2 -- not judged here). REAL route + screen + model + flow + stores
// on one visible device storage, MOCK sessions (the meaning of the real last_sign_in_at on refresh is NOT_VERIFIED). Offline.
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
  const writeHold = { next: null };
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
    setItem: async (k, v) => { if (writeHold.next) { const g = writeHold.next; writeHold.next = null; g.taken = true; await new Promise((r) => { g.release = r; }); } data.set(k, v); },
    /** The next write waits until `release()` (a draft save still on its way to the device). */
    holdNextWrite() { writeHold.next = { taken: false, release: null }; return writeHold.next; },
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
async function createApp({ port, routeSource = ROUTE_SOURCE, flowModule = realFlow, device = null } = {}) {
  const world = { session: null, accounts: [account('X_A'), account('X_B')], status: 'ready' };
  const flow = { ...flowModule, attemptMemory: flowModule.createAttemptMemory(), inFlightSends: flowModule.createInFlightSends() };
  // One device storage for both stores when given (the app's manual-publish-storage.ts uses ONE AsyncStorage for both).
  const store = device ?? kv();
  const drafts = device ?? kv();
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
    '@/features/manual-publish/manual-publish-storage': { attemptStore: realStore.createAttemptStore(store), draftStore: realDraft.createDraftStore(drafts) },
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
    world, store, drafts, flow, sync,
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


// ---- helpers -------------------------------------------------------------------------------------------------------
const DKEY = 'postona.manual-publish.draft.v1:UA';
const stored = (app) => (app.drafts.data.has(DKEY) ? JSON.parse(app.drafts.data.get(DKEY)) : null);
/** A token refresh of the SAME person whose user object now carries a newer last_sign_in_at (MOCK of SM2's premise). */
const refreshWithNewMark = (app) => app.auth(session('UA', T2, 'rig-at-2'));
/** A token refresh that keeps the mark (the ordinary case). */
const refreshSameMark = (app) => app.auth(session('UA', T1, 'rig-at-2'));
async function typing(text = '入力中の本文') {
  const p = scriptedPort();
  const app = await createApp({ port: p.port });
  await app.auth(session('UA', T1));
  const a = await app.open();
  await a.type(text);
  await app.sync();
  assert.equal(stored(app)?.text, text);
  return { p, app, a };
}

// ---- controls first: an ordinary refresh loses nothing ------------------------------------------------------------
test('control G2-SR0: a refresh that keeps the mark loses nothing -- same screen, same text, same stored record', async () => {
  const { app, a } = await typing();
  const gen = a.generation();
  await refreshSameMark(app);
  assert.equal(a.generation(), gen, 'not re-created');
  assert.equal(a.state().draft, '入力中の本文');
  assert.equal(stored(app)?.text, '入力中の本文');
});

// ---- SM3R-T / SM2 with the storage side -------------------------------------------------------------------------------
test('KNOWN SM3R-T + SM2, storage side: a refresh with a new mark re-creates the open screen (SCREEN LOST: the typed text is gone) and the new screen REMOVES the stored draft (STORAGE LOST); nothing old comes back', async () => {
  const { app, a } = await typing();
  const gen = a.generation();
  await refreshWithNewMark(app);
  assert.ok(a.generation() > gen, 're-created');
  assert.equal(a.state().draft, '', 'screen lost');
  assert.equal(stored(app), null, 'storage lost');
  app.close(a);
  const b = await app.open();
  assert.equal(b.state().draft, '', 'and a later visit gets nothing back (no old screen returns)');
});

test('G2-SR1: the refresh arrives while the last keystroke\'s save is still on its way -- the draft store applies writes and removals strictly in order, so the new screen\'s removal waits for that save and then removes it: the old text is never re-created or shown', async (t) => {
  const { app, a } = await typing('最初の本文');
  const hold = app.drafts.holdNextWrite();
  await a.type('最初の本文と追記');
  assert.equal(hold.taken, true, 'the save of the new text is on its way');
  await refreshWithNewMark(app);
  assert.equal(a.state().draft, '');
  const afterRemove = stored(app);
  hold.release();
  await app.sync();
  const afterLate = stored(app);
  t.diagnostic(`after the new screen's removal: ${JSON.stringify(afterRemove)} / after the late save: ${JSON.stringify(afterLate)}`);
  assert.equal(afterRemove?.text, '最初の本文', 'while the save is held, the removal waits behind it');
  assert.equal(afterLate, null, 'the save lands, then the queued removal runs: nothing is left');
  assert.equal(a.state().draft, '', 'not shown');
  app.close(a);
  const b = await app.open();
  assert.equal(b.state().draft, '', 'the next visit gets nothing');
});

test('G2-SR2: the refresh arrives while the screen\'s restore read is still pending -- the old screen\'s read is not applied to the new screen; the new screen discards the old-mark draft and removes it', async () => {
  const { app, a } = await typing('前回の本文');
  app.close(a);
  const hold = app.drafts.holdNextRead();
  const b = await app.open();
  assert.equal(hold.taken, true);
  await refreshWithNewMark(app);
  hold.release();
  await app.sync();
  assert.equal(b.state().draft, '', 'nothing of the old session on the new screen');
  assert.equal(stored(app), null);
});

test('G2-SR3: the refresh arrives in the confirmation step with consent ticked -- the re-created screen is an empty editor with no consent and nothing sendable (the confirmation is lost with the text)', async () => {
  const { app, a } = await typing('確認中の本文');
  assert.ok(await a.press('内容を確認する'));
  await a.tick();
  assert.ok(a.button('Xに投稿する') && !a.button('Xに投稿する').props.disabled, 'sendable before');
  await refreshWithNewMark(app);
  assert.equal(a.state().phase, 'editing');
  assert.equal(a.state().draft, '');
  assert.equal(a.button('Xに投稿する'), null, 'nothing sendable');
  assert.equal(stored(app), null);
});

// ---- release gates (todo, red while the known items are open) -------------------------------------------------------
test('RELEASE GATE SM3R-T (KNOWN, P3, owner G1/G5): a refresh of the same person on THIS device does not lose the open text', { todo: 'KNOWN SM3R-T: red until fixed' }, async () => {
  const { app, a } = await typing();
  await refreshWithNewMark(app);
  assert.equal(a.state().draft, '入力中の本文');
});

test('RELEASE GATE SM2 (KNOWN, P3, owner G5 mark / G1): a refresh caused by a sign-in elsewhere does not delete this device\'s stored draft', { todo: 'KNOWN SM2: red until fixed' }, async () => {
  const { app, a } = await typing();
  app.close(a);
  await refreshWithNewMark(app);
  const b = await app.open();
  assert.equal(b.state().draft, '入力中の本文');
  assert.equal(stored(app)?.text, '入力中の本文');
});

// ---- negative control: why the mark cannot simply be dropped -------------------------------------------------------
test('negative control: keying the screen by the user only (no mark) turns the SM3R-T gate green -- but then a NEW sign-in of the same person (no sign-out in between) keeps the old session\'s open text (SM3 comes back). The mark itself must change meaning (per session, e.g. session_id), not be dropped', async () => {
  const keyLine = "return <ManualPublishScreen key={userId === null ? 'signed-out' : `${userId}:${sessionMark}`} userId={userId} sessionMark={sessionMark} />;";
  assert.equal(ROUTE_SOURCE.split(keyLine).length, 2, 'the route key line');
  const userOnly = ROUTE_SOURCE.replace(keyLine, "return <ManualPublishScreen key={userId === null ? 'signed-out' : userId} userId={userId} sessionMark={sessionMark} />;");
  const p = scriptedPort();
  const app = await createApp({ port: p.port, routeSource: userOnly });
  await app.auth(session('UA', T1));
  const a = await app.open();
  await a.type('入力中の本文');
  await refreshWithNewMark(app);
  assert.equal(a.state().draft, '入力中の本文', 'mutant: the refresh keeps the text (the SM3R-T gate would pass)');
  // A later NEW sign-in of the same person without a sign-out reaches the screen as exactly the same kind of input.
  await app.auth(session('UA', '2026-10-22T11:00:00.000000Z', 'rig-at-3'));
  assert.equal(a.state().draft, '入力中の本文', 'mutant: the old session\'s open text is carried into the new sign-in (SM3 returns)');
});
