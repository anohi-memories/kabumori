// G2 QA (Issue #317, task postona-g2-a11y-three-findings-regression-product-fix-gate-20261026) -- QA only.
// Acceptance gates for the three Simulator findings of G2 #520 on the manual X post screen (owner G1, G1 #316 21st TASK):
//   G2-A11Y-2  with large text the result screen opens scrolled down: the heading and the "check X" warning are hidden;
//   G2-A11Y-1  while typing several lines the line being typed hides under the keyboard;
//   G2-A11Y-3  a text-size change while the screen is open clips labels until the app is reopened.
// The real check is a Simulator re-run (README). These offline gates only look for ONE of the accepted mechanisms in
// the REAL screen (any of them may be what G1 ships), so they are `todo` (red, not failing the suite) until a G1 fix lands;
// in-test sketch fixes prove each gate can turn green, and an ineffective sketch proves it does not turn green by accident.
// REAL route + screen + model + flow + stores, MOCK sessions, a scripted send port, offline.
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


/** All text a rendered tree shows: string children, labels, and TextInput values. */
function textOf(tree) {
  const out = [];
  const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (n === null || typeof n !== 'object') { if (typeof n === 'string') out.push(n); return; } if (typeof n.props?.label === 'string') out.push(n.props.label); if (typeof n.props?.value === 'string') out.push(n.props.value); walk(n.props?.children); };
  walk(tree);
  return out.join('\n');
}

/** The screen's sentences: the text of every Text / SectionTitle node (button labels and the editor value excluded). */
/** Every node of a type in a rendered tree. */
function findType(tree, type) { const out = []; const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (n === null || typeof n !== 'object') return; if (n.type === type) out.push(n); walk(n.props?.children); }; walk(tree); return out; }
/** Scroll calls the screen made on its ScrollView (through an object ref or a callback ref). */
const scrollCalls = [];
const fakeScrollView = { scrollTo: (a) => scrollCalls.push(['scrollTo', a ?? null]), scrollToEnd: (a) => scrollCalls.push(['scrollToEnd', a ?? null]), scrollResponderScrollNativeHandleToKeyboard: (...a) => scrollCalls.push(['toKeyboard', a.length]), flashScrollIndicators: () => {} };
function attachScrollRef(scroll) { const ref = scroll?.props?.ref; if (!ref) return; if (typeof ref === 'function') ref(fakeScrollView); else if (typeof ref === 'object') ref.current = fakeScrollView; }

function bodyOf(tree) {
  const out = [];
  const own = (n) => [n.props?.children].flat(Infinity).filter((x) => typeof x === 'string' || typeof x === 'number').join('');
  const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (n === null || typeof n !== 'object') return; if ((n.type === 'Text' || n.type === 'SectionTitle') && own(n) !== '') out.push(own(n)); walk(n.props?.children); };
  walk(tree);
  return out;
}

// ---- harness: one app process, several mounted route instances --------------------------------------------------------
async function createApp({ port, routeSource = ROUTE_SOURCE, flowModule = realFlow, device = null } = {}) {
  const world = { session: null, accounts: [account('X_A'), account('X_B')], status: 'ready', fontScale: 1 };
  const flow = { ...flowModule, attemptMemory: flowModule.createAttemptMemory(), inFlightSends: flowModule.createInFlightSends() };
  // One device storage for both stores when given (the app's manual-publish-storage.ts uses ONE AsyncStorage for both).
  const store = device ?? kv();
  const drafts = device ?? kv();
  // The app's ONE store instances (manual-publish-storage.ts exports singletons), exposed so a clean-up can go through them.
  const attemptStore = realStore.createAttemptStore(store);
  const draftStore = realDraft.createDraftStore(drafts);
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
    'react-native': { Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View', Keyboard: { dismiss: () => {} },
      // (G2 gen49) the system text size, for a fix that follows it: changed by app.setFontScale().
      useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: world.fontScale }), PixelRatio: { getFontScale: () => world.fontScale, get: () => 3 } },
    'expo-router': { Link: 'Link', Stack: { Screen: 'StackScreen' } },
    'expo-crypto': { randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '@/constants/theme': { colors: new Proxy({}, { get: (_t, name) => String(name) }), spacing: { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: { muted: true } } },
    '@/features/manual-publish/manual-post-preview': { ManualPostPreview: 'ManualPostPreview' },
    '@/features/manual-publish/manual-publish-flow': flow,
    '@/features/manual-publish/manual-publish-model': model,
    '@/features/manual-publish/manual-publish-port': { ...realPort, getManualPublishPort: () => port },
    '@/features/manual-publish/manual-publish-storage': { attemptStore, draftStore },
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
  const renderScreen = (screen) => { current = screen.inst; current.cursor = 0; try { screen.tree = mod.exports.ManualPublishScreen({ ...screen.element.props }); } finally { current = null; } const scroll = findType(screen.tree, 'ScrollView')[0] ?? null; frames.push({ user: screen.element.props.userId ?? null, text: textOf(screen.tree), body: bodyOf(screen.tree), phase: screen.inst.slots[0]?.v?.phase ?? null, scrollKey: scroll?.key ?? null, scroll }); attachScrollRef(scroll); };
  /** Every rendered frame: whose screen it was and all the text it showed (labels and values included). */
  const frames = [];
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
    world, store, drafts, flow, sync, attemptStore, draftStore, frames,
    async auth(s) { world.session = s; await sync(); },
    async setFontScale(v) { world.fontScale = v; await sync(); },
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


// ---- the REAL AuthProvider over the same device storage ------------------------------------------------------------
import { createClient } from '@supabase/supabase-js';
import { Buffer } from 'node:buffer';
import * as accountDeletion from '../src/domain/account-deletion.ts';
import * as onboarding from '../src/domain/onboarding.ts';
import * as authFlows from '../src/domain/auth-flows.ts';
import * as releaseReadiness from '../src/domain/auth-release-readiness.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';
import * as authErrors from '../src/lib/auth-errors.ts';
import * as sessionStorage from '../src/lib/session-storage.ts';

const PROVIDER_SOURCE = await readFile(new URL('../src/providers/auth-provider.tsx', import.meta.url), 'utf8');
const URL_BASE = 'https://proj.supabase.co';
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const DRAFT_KEY = (u) => `postona.manual-publish.draft.v1:${u}`;
const RECORD_KEY = (u) => `postona.manual-publish.unresolved.v1:${u}`;

/** Fake Auth (password sign-in issues a session_id per sign-in) + fake deletion function; every request is logged. */
function fakeServer({ deletion = () => ({ status: 200, body: { ok: true, login_deleted: true } }) } = {}) {
  let serial = 0;
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push(`${init.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/auth/v1/token') {
      const body = JSON.parse(init.body);
      const userId = String(body.email).split('@')[0];
      serial += 1;
      const now = Math.floor(Date.now() / 1000);
      return Response.json({ access_token: `${b64({ alg: 'HS256' })}.${b64({ sub: userId, session_id: `sess-${userId}-${serial}`, exp: now + 3600 })}.sig`, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: `rig-r-${serial}`, user: { id: userId, aud: 'authenticated', role: 'authenticated', email: `${userId}@example.test`, app_metadata: {}, user_metadata: {}, created_at: '2026-09-28T00:00:00Z' } });
    }
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    if (url.pathname === '/auth/v1/settings') return Response.json({ external: {}, disable_signup: false, mailer_autoconfirm: false });
    if (url.pathname === `/functions/v1/${accountDeletion.ACCOUNT_DELETION_FUNCTION}`) { const a = deletion(); return Response.json(a.body, { status: a.status }); }
    return Response.json({}, { status: 500 });
  };
  return { fetch, calls };
}

/** The real AuthProvider with a small hook runtime. `device` is the app's ONE AsyncStorage. Returns its live context value. */
async function authProvider({ device, server = fakeServer(), source = PROVIDER_SOURCE } = {}) {
  const authStore = new Map();
  const supabase = createClient(URL_BASE, 'sb_publishable_test', { auth: { storage: { getItem: (k) => authStore.get(k) ?? null, setItem: (k, v) => { authStore.set(k, v); }, removeItem: (k) => { authStore.delete(k); } }, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: server.fetch } });
  const slots = [];
  let cursor = 0;
  let pending = [];
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    createContext: () => ({ Provider: 'AuthContextProvider' }),
    useContext: () => null,
    useState: (init) => { const i = cursor++; if (!(i in slots)) slots[i] = { v: typeof init === 'function' ? init() : init }; return [slots[i].v, (n) => { slots[i].v = typeof n === 'function' ? n(slots[i].v) : n; }]; },
    useRef: (init) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: init }; return slots[i]; },
    useMemo: (f, d) => { const i = cursor++; if (!(i in slots) || !same(slots[i].d, d)) slots[i] = { d, v: f() }; return slots[i].v; },
    useCallback: (f, d) => { const i = cursor++; if (!(i in slots) || !same(slots[i].d, d)) slots[i] = { d, v: f }; return slots[i].v; },
    useEffect: (e, d) => { const i = cursor++; if (!(i in slots) || !same(slots[i].d, d)) { const old = slots[i]; slots[i] = { d, cleanup: old?.cleanup }; pending.push(i); slots[i].effect = e; } },
  };
  const jsx = (type, props) => ({ type, props });
  const asyncStorage = { getItem: (k) => device.getItem(k), setItem: (k, v) => device.setItem(k, v), removeItem: (k) => device.removeItem(k) };
  const modules = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'expo-constants': { default: { expoConfig: { scheme: 'kabumori-social', ios: { usesAppleSignIn: true }, plugins: [] } }, __esModule: true },
    'expo-linking': { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) },
    'react-native': { Platform: { OS: 'android' } },
    '@/lib/supabase': { supabase, getSupabaseConfig: () => ({ ok: true, config: { url: URL_BASE, publishableKey: 'sb_publishable_test' } }), getSupabaseHost: () => 'proj.supabase.co' },
    '@/lib/auth-errors': authErrors, '@/lib/session-storage': sessionStorage,
    '@react-native-async-storage/async-storage': { default: asyncStorage, __esModule: true },
    '@/lib/auth-client-flows': { completeAuthCallbackUrl: async () => null, isNativeAppleAvailable: async () => false, linkAppleNative: async () => ({ ok: false }), linkOAuthProvider: async () => ({ ok: false }), reauthWithAppleNative: async () => ({ ok: false }), reauthWithOAuthProvider: async () => ({ ok: false }), signInWithAppleNative: async () => ({ ok: false }), signInWithOAuthProvider: async () => ({ ok: false }) },
    '@/domain/account-deletion': accountDeletion, '@/domain/onboarding': onboarding, '@/domain/auth-flows': authFlows,
    '@/domain/auth-release-readiness': releaseReadiness, '@/domain/recovery-binding': recoveryBinding,
  };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, URL, Response, Promise, process: { env: {} }, fetch: server.fetch, atob, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; } }, { filename: 'auth-provider.tsx' });
  let value = null;
  const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
  const render = async () => {
    for (let round = 0; round < 10; round += 1) {
      cursor = 0; pending = [];
      value = mod.exports.AuthProvider({ children: null }).props.value;
      if (pending.length === 0) break;
      for (const i of pending) { slots[i].cleanup?.(); const c = slots[i].effect(); slots[i].cleanup = typeof c === 'function' ? c : undefined; }
      await settle();
    }
    await settle(); cursor = 0; value = mod.exports.AuthProvider({ children: null }).props.value;
    return value;
  };
  await render();
  return {
    server, supabase, render, get value() { return value; },
    async signIn(userId) { await supabase.auth.signInWithPassword({ email: `${userId}@example.test`, password: 'rig-password' }); await settle(); return render(); },
  };
}
const keysOf = (device) => [...device.data.keys()].sort();
async function seed(device, userId) {
  await device.setItem(DRAFT_KEY(userId), JSON.stringify({ v: 1, accountId: 'X_A', text: `${userId}の書きかけ`, sessionMark: 'mark-1', savedAt: Date.now() - 48 * 3600_000 }));
  await device.setItem(RECORD_KEY(userId), '{"v":1}');
  await device.setItem(onboarding.onboardingStorageKey(userId), '{"done":true}');
}
const contextOf = (value) => ({ userId: value.session.user.id, sessionId: recoveryBinding.sessionIdOf(value.session) });

const UA_ID = '00000000-0000-4000-8000-0000000000a1';
const UB_ID = '00000000-0000-4000-8000-0000000000b2';

// ---- helpers ---------------------------------------------------------------------------------------------------------
const A_TEXT = 'Aさんの結果不明の投稿';
const ENDS = { pending: PENDING, unconfirmed: { kind: 'unavailable', code: 'X_TIMEOUT' }, uncertain: UNCERTAIN };
/** A's unresolved attempt of kind `end` (or still out when end === null), on one device storage. */
async function aWithAttempt(end, device = kv()) {
  const p = scriptedPort();
  const app = await createApp({ port: p.port, device });
  await app.auth(session(UA_ID, T1));
  const a = await app.open();
  assert.ok(await a.trySend(A_TEXT));
  if (end) { answerOf(p.sends[0], end); await app.sync(); }
  return { p, app, a, device };
}
/** What a screen shows of A: any of A's text, A's attempt, A's result or A's actions. */
function showsA(h, aRequestId) {
  const st = h.state();
  return {
    text: h.lines().some((l) => l.includes(A_TEXT)) || st.draft === A_TEXT,
    attempt: st.unresolved?.requestId === aRequestId || st.requestId === aRequestId,
    result: st.result != null,
    ack: Boolean(ackButton(h)),
    reAsk: Boolean(h.button(SAME_ID)),
  };
}
const NOTHING = { text: false, attempt: false, result: false, ack: false, reAsk: false };



// ---- helpers -----------------------------------------------------------------------------------------------------------
const A_DRAFT = 'Aさんの書きかけの下書き';
const SIM_POST_ID = '1850000000000000999';
const framesOf = (app, user) => app.frames.filter((f) => f.user === user);
const leaks = (frames, needles) => frames.filter((f) => needles.some((n) => f.text.includes(n)));


// ---- the three acceptance conditions (any accepted mechanism) -----------------------------------------------------------
const GATE_PENDING = { todo: 'G1 FIX PENDING (G1 #316 21st TASK): red until a reviewed G1 fix lands; then re-run the Simulator check' };
const UNCONFIRMED = { kind: 'unavailable', code: 'X_TIMEOUT' };
const flat = (style) => Object.assign({}, ...[style].flat(Infinity).filter((x) => x && typeof x === 'object'));
const scrollsToTop = (call) => call[0] === 'scrollTo' && (call[1] === null || (typeof call[1] === 'object' && (call[1].y ?? 0) === 0));

/** G2-A11Y-2: entering the result starts at the top -- the ScrollView is re-created (new key) or scrolled to y = 0. */
async function resultStartsAtTop(opts = {}) {
  scrollCalls.length = 0;
  const p = scriptedPort();
  const app = await createApp({ ...opts, port: p.port });
  await app.auth(session(UA_ID, T1));
  const a = await app.open();
  assert.ok(await a.trySend(TEXT));
  const confirming = app.frames.filter((f) => f.phase === 'confirming').at(-1);
  const before = scrollCalls.length;
  answerOf(p.sends[0], UNCONFIRMED);
  await app.sync();
  const result = app.frames.find((f) => f.phase === 'result');
  assert.ok(confirming && result, 'both phases were rendered');
  const remounted = result.scrollKey !== confirming.scrollKey;
  const scrolled = scrollCalls.slice(before).some(scrollsToTop);
  return { ok: remounted || scrolled, remounted, scrolled, calls: scrollCalls.slice(before) };
}

/** G2-A11Y-1: the line being typed stays visible -- the body input is bounded and scrolls inside, or its growth scrolls the page. */
async function typedLineFollowed(opts = {}) {
  scrollCalls.length = 0;
  const app = await createApp({ ...opts, port: scriptedPort().port });
  await app.auth(session(UA_ID, T1));
  const a = await app.open();
  await a.type('1行目\n2\n3\n4\n5行目');
  const input = findType(a.screen.tree, 'TextInput').find((n) => n.props.accessibilityLabel === '投稿の本文');
  assert.ok(input, 'the body input');
  const style = flat(input.props.style);
  const bounded = Number.isFinite(style.maxHeight) && input.props.scrollEnabled !== false;
  let follows = false;
  if (typeof input.props.onContentSizeChange === 'function') {
    const before = scrollCalls.length;
    input.props.onContentSizeChange({ nativeEvent: { contentSize: { width: 300, height: 400 } } });
    await app.sync();
    follows = scrollCalls.length > before;
  }
  return { ok: bounded || follows, bounded, follows, maxHeight: style.maxHeight ?? null };
}

/** G2-A11Y-3: a text-size change while the screen is open re-lays it out (new ScrollView key), or every text is capped. */
async function followsTextSizeChange(opts = {}) {
  const app = await createApp({ ...opts, port: scriptedPort().port });
  await app.auth(session(UA_ID, T1));
  const a = await app.open();
  await a.type('本文');
  const keyBefore = app.frames.at(-1).scrollKey;
  await app.setFontScale(3.1);
  const tree = a.screen.tree;
  const keyAfter = app.frames.at(-1).scrollKey;
  const nodes = ['Text', 'TextInput', 'ActionButton', 'SectionTitle'].flatMap((t) => findType(tree, t));
  const capped = nodes.length > 0 && nodes.every((n) => Number.isFinite(n.props.maxFontSizeMultiplier));
  return { ok: keyBefore !== keyAfter || capped, relaid: keyBefore !== keyAfter, capped, uncapped: nodes.filter((n) => !Number.isFinite(n.props.maxFontSizeMultiplier)).length };
}

test('GATE G2-A11Y-2 (P2 candidate): with any text size, the result screen after a send starts at its top (heading + "check X" warning first, not the discard button)', GATE_PENDING, async (t) => {
  const r = await resultStartsAtTop();
  t.diagnostic(`A11Y-2 on this head: ${JSON.stringify({ remounted: r.remounted, scrolled: r.scrolled, calls: r.calls })}`);
  assert.ok(r.ok);
});

test('GATE G2-A11Y-1 (P3): while several lines are typed, the line being typed stays visible above the keyboard', GATE_PENDING, async (t) => {
  const r = await typedLineFollowed();
  t.diagnostic(`A11Y-1 on this head: ${JSON.stringify(r)}`);
  assert.ok(r.ok);
});

test('GATE G2-A11Y-3 (P3): a text-size change while the screen is open re-lays the screen out (no clipped labels)', GATE_PENDING, async (t) => {
  const r = await followsTextSizeChange();
  t.diagnostic(`A11Y-3 on this head: ${JSON.stringify(r)}`);
  assert.ok(r.ok);
});

// ---- sketches (in-test memory only, not product code): each gate CAN turn green, and an ineffective fix stays red ------
const HOOK_ANCHOR = '  const mountedRef = useRef(true);\n';
const SCROLL_ANCHOR = '      <ScrollView\n';
const INPUT_ANCHOR = "style={{ minHeight: 140, borderColor: colors.border";
const IMPORT_ANCHOR = "import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';";
const ANCHORS_PRESENT = [HOOK_ANCHOR, SCROLL_ANCHOR, INPUT_ANCHOR, IMPORT_ANCHOR].every((x) => ROUTE_SOURCE.split(x).length === 2);
const SKETCH = { skip: ANCHORS_PRESENT ? false : 'the screen changed (a G1 fix?): sketches are for the pre-fix head only' };
const sketch = (...pairs) => pairs.reduce((src, [from, to]) => { assert.equal(src.split(from).length, 2, `anchor once: ${from.slice(0, 30)}`); return src.replace(from, to); }, ROUTE_SOURCE);

test('sketch A11Y-2 (a) scroll to the top when the phase changes -> the gate turns green', SKETCH, async () => {
  const routeSource = sketch([HOOK_ANCHOR, `${HOOK_ANCHOR}  const g2ScrollRef = useRef(null);\n  useEffect(() => { g2ScrollRef.current?.scrollTo({ y: 0, animated: false }); }, [state.phase]);\n`], [SCROLL_ANCHOR, '      <ScrollView\n        ref={g2ScrollRef}\n']);
  const r = await resultStartsAtTop({ routeSource });
  assert.ok(r.ok && r.scrolled);
});

test('sketch A11Y-2 (b) re-create the ScrollView per phase group -> the gate turns green', SKETCH, async () => {
  const routeSource = sketch([SCROLL_ANCHOR, "      <ScrollView\n        key={state.phase === 'result' ? 'g2-result' : 'g2-form'}\n"]);
  const r = await resultStartsAtTop({ routeSource });
  assert.ok(r.ok && r.remounted);
});

test('sketch A11Y-2 negative: a scroll that does not go to the top keeps the gate red', SKETCH, async () => {
  const routeSource = sketch([HOOK_ANCHOR, `${HOOK_ANCHOR}  const g2ScrollRef = useRef(null);\n  useEffect(() => { g2ScrollRef.current?.scrollTo({ y: 500, animated: false }); }, [state.phase]);\n`], [SCROLL_ANCHOR, '      <ScrollView\n        ref={g2ScrollRef}\n']);
  const r = await resultStartsAtTop({ routeSource });
  assert.equal(r.ok, false);
});

test('sketch A11Y-1 (a) a bounded body input that scrolls inside -> the gate turns green', SKETCH, async () => {
  const routeSource = sketch([INPUT_ANCHOR, `scrollEnabled\n                ${INPUT_ANCHOR.replace('minHeight: 140,', 'minHeight: 140, maxHeight: 220,')}`]);
  assert.ok((await typedLineFollowed({ routeSource })).ok);
});

test('sketch A11Y-1 (b) the input growth scrolls the page -> the gate turns green', SKETCH, async () => {
  const routeSource = sketch([HOOK_ANCHOR, `${HOOK_ANCHOR}  const g2ScrollRef = useRef(null);\n`], [SCROLL_ANCHOR, '      <ScrollView\n        ref={g2ScrollRef}\n'], [INPUT_ANCHOR, `onContentSizeChange={() => g2ScrollRef.current?.scrollToEnd({ animated: true })}\n                ${INPUT_ANCHOR}`]);
  const r = await typedLineFollowed({ routeSource });
  assert.ok(r.ok && r.follows);
});

test('sketch A11Y-1 negative: a maximum height with scrolling turned off keeps the gate red', SKETCH, async () => {
  const routeSource = sketch([INPUT_ANCHOR, `scrollEnabled={false}\n                ${INPUT_ANCHOR.replace('minHeight: 140,', 'minHeight: 140, maxHeight: 220,')}`]);
  assert.equal((await typedLineFollowed({ routeSource })).ok, false);
});

test('sketch A11Y-3 (a) re-create the ScrollView when the text size changes -> the gate turns green', SKETCH, async () => {
  const routeSource = sketch([IMPORT_ANCHOR, IMPORT_ANCHOR.replace('View }', 'View, useWindowDimensions }')], [HOOK_ANCHOR, `${HOOK_ANCHOR}  const { fontScale: g2FontScale } = useWindowDimensions();\n`], [SCROLL_ANCHOR, '      <ScrollView\n        key={`g2-fs-${g2FontScale}`}\n']);
  const r = await followsTextSizeChange({ routeSource });
  assert.ok(r.ok && r.relaid);
});

test('sketch A11Y-3 negative: reading the text size without using it keeps the gate red', SKETCH, async () => {
  const routeSource = sketch([IMPORT_ANCHOR, IMPORT_ANCHOR.replace('View }', 'View, useWindowDimensions }')], [HOOK_ANCHOR, `${HOOK_ANCHOR}  const { fontScale: g2FontScale } = useWindowDimensions(); void g2FontScale;\n`]);
  assert.equal((await followsTextSizeChange({ routeSource })).ok, false);
});
