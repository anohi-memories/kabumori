// G2 QA (Issue #317, task postona-g2-x-uncertain-account-switch-display-isolation-offline-20261023) -- QA only, no product code.
// The X manual-post's UNRESOLVED attempt (pending / unconfirmed / uncertain / still sending / acknowledged) across a sign-out,
// another person, the same person again, and an account deletion (confirming / done / refused): what the CURRENT person sees
// and can do (display), kept apart from what stays in device storage and in the app process (storage). REAL route + screen +
// model + flow + stores on one visible device storage, MOCK sessions, a scripted future send port, and the REAL AuthProvider's
// deleteAccount (G2 #470 harness). Measured on G1 #468 (45ee9ac3; H1 focused PASS on its own P2 -- not a release PASS).
// Known items stay known: G2-SN5 / RK3 / UC1 (copy), SM4 / SM4-D (storage). Offline; real Auth / deletion / X NOT_VERIFIED.
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

// ---- sign-out -> another person -> the same person again --------------------------------------------------------------
for (const [kind, end] of Object.entries(ENDS)) {
  test(`G2-XI1 ${kind}: A signs out, B signs in -- B sees nothing of A and can post (own new id); A's attempt stays in storage and in the process; A signing in again sees it as ${kind}, with no consent back`, async () => {
    const { p, app, a, device } = await aWithAttempt(end);
    const r1 = p.sends[0].target.targetId;
    await app.auth(null);
    await app.auth(session(UB_ID, T1, 'rig-at-b'));
    assert.deepEqual(showsA(a, r1), NOTHING, 'display: nothing of A on B\'s screen');
    assert.ok(device.data.has(RECORD_KEY(UA_ID)), 'storage: A\'s record stays');
    assert.equal(app.flow.attemptMemory.get(UA_ID)?.text, A_TEXT, 'process: A\'s text stays in memory (not shown)');
    assert.ok(await a.trySend('Bさんの投稿'), 'B can post');
    assert.equal(p.sends.length, 2);
    assert.notEqual(p.sends[1].target.targetId, r1, 'with B\'s own id');
    answerOf(p.sends[1], PUBLISHED);
    await app.sync();
    await app.auth(null);
    await app.auth(session(UA_ID, T2, 'rig-at-a2'));
    assert.equal(a.state().unresolved?.requestId, r1, `A sees A's ${kind} attempt again`);
    assert.equal(a.state().unresolved?.kind, kind === 'unconfirmed' ? 'unconfirmed' : kind);
    assert.equal(a.button('Xに投稿する'), null, 'no consent / nothing sendable restored');
    assert.equal(p.sends.length, 2, 'nothing sent by the switches');
  });
}

test('G2-XI2 (still sending): A\'s send is out, A signs out and B signs in -- B is not shown A\'s "sending" and B\'s own post goes; A\'s answer lands for A only; A back sees A\'s real answer', async () => {
  const { p, app, a } = await aWithAttempt(null);
  const r1 = p.sends[0].target.targetId;
  await app.auth(null);
  await app.auth(session(UB_ID, T1, 'rig-at-b'));
  assert.notEqual(a.state().phase, 'sending', 'B\'s screen is not waiting for A\'s send');
  assert.deepEqual(showsA(a, r1), NOTHING);
  assert.ok(await a.trySend('Bさんの投稿'));
  assert.equal(p.sends.length, 2);
  answerOf(p.sends[0], UNCERTAIN);
  await app.sync();
  assert.deepEqual(showsA(a, r1), NOTHING, 'A\'s answer is not shown to B');
  answerOf(p.sends[1], PUBLISHED);
  await app.sync();
  await app.auth(null);
  await app.auth(session(UA_ID, T2, 'rig-at-a2'));
  assert.deepEqual([a.state().unresolved?.requestId, a.state().unresolved?.kind], [r1, 'uncertain'], 'A sees A\'s real answer');
});

test('G2-XI3 (acknowledged): A presses "I checked X", signs out, B, then A again -- nothing of the attempt anywhere: not on B\'s or A\'s screen, not in storage, not in the process', async () => {
  const { p, app, a, device } = await aWithAttempt(UNCERTAIN);
  const r1 = p.sends[0].target.targetId;
  assert.ok(await ack(a));
  await app.sync();
  await app.auth(null);
  await app.auth(session(UB_ID, T1, 'rig-at-b'));
  assert.deepEqual(showsA(a, r1), NOTHING);
  await app.auth(null);
  await app.auth(session(UA_ID, T2, 'rig-at-a2'));
  assert.deepEqual(showsA(a, r1), NOTHING);
  assert.equal(device.data.has(RECORD_KEY(UA_ID)), false);
  assert.equal(app.flow.attemptMemory.get(UA_ID), null);
});

// ---- account deletion -----------------------------------------------------------------------------------------------
test('G2-XI4 (deletion done): A deletes the account with an uncertain attempt -- B then sees nothing of A and can post; STORAGE: A\'s attempt record stays on the device (known SM4-D) and A\'s post text stays in the app process until restart (same family, recorded)', async () => {
  const { p, app, a, device } = await aWithAttempt(UNCERTAIN);
  const r1 = p.sends[0].target.targetId;
  const auth = await authProvider({ device });
  await auth.signIn(UA_ID);
  const outcome = await auth.value.deleteAccount({ context: contextOf(auth.value), scope: 'social_and_login' });
  assert.equal(outcome.ok, true);
  await app.auth(null);
  await app.auth(session(UB_ID, T1, 'rig-at-b'));
  assert.deepEqual(showsA(a, r1), NOTHING, 'display: nothing of A');
  assert.ok(await a.trySend('Bさんの投稿'), 'B can post');
  assert.ok(device.data.has(RECORD_KEY(UA_ID)), 'storage: A\'s attempt record remains (SM4-D)');
  assert.equal(app.flow.attemptMemory.get(UA_ID)?.text, A_TEXT, 'process: A\'s text remains in memory');
});

test('G2-XI5 (deletion while A\'s send is out): the deletion completes, then A\'s answer lands -- B never sees it; STORAGE: the answer is still recorded for the deleted A (an uncertain record written AFTER the deletion)', async () => {
  const { p, app, a, device } = await aWithAttempt(null);
  const r1 = p.sends[0].target.targetId;
  const auth = await authProvider({ device });
  await auth.signIn(UA_ID);
  assert.equal((await auth.value.deleteAccount({ context: contextOf(auth.value), scope: 'social_and_login' })).ok, true);
  await app.auth(null);
  await app.auth(session(UB_ID, T1, 'rig-at-b'));
  device.data.delete(RECORD_KEY(UA_ID)); // even if a clean-up had removed it at the deletion ...
  answerOf(p.sends[0], UNCERTAIN);
  await app.sync();
  assert.deepEqual(showsA(a, r1), NOTHING, 'display: B is not told');
  assert.ok(device.data.has(RECORD_KEY(UA_ID)), '... the late answer writes A\'s record again');
  assert.equal(JSON.parse(device.data.get(RECORD_KEY(UA_ID))).kind, 'uncertain');
});

test('G2-XI6 (deletion refused while A\'s send is out, e.g. PUBLISH_IN_FLIGHT): A stays signed in, A\'s screen keeps waiting and then shows the real answer; nothing is removed', async () => {
  const { p, app, a, device } = await aWithAttempt(null);
  const r1 = p.sends[0].target.targetId;
  const auth = await authProvider({ device, server: fakeServer({ deletion: () => ({ status: 409, body: { ok: false, error: 'PUBLISH_IN_FLIGHT' } }) }) });
  await auth.signIn(UA_ID);
  const outcome = await auth.value.deleteAccount({ context: contextOf(auth.value), scope: 'social_only' });
  assert.equal(outcome.ok, false);
  assert.equal(a.state().phase, 'sending', 'A still waits');
  answerOf(p.sends[0], UNCERTAIN);
  await app.sync();
  assert.deepEqual([a.state().unresolved?.requestId, a.state().unresolved?.kind], [r1, 'uncertain']);
  assert.ok(device.data.has(RECORD_KEY(UA_ID)));
});

// ---- negative controls --------------------------------------------------------------------------------------------
test('negative controls: (1) a memory that is NOT per person makes B see A\'s attempt after the switch (XI1 fails); (2) a route that keeps one screen across people shows A\'s result to B (XI1 fails)', async () => {
  {
    const shared = realFlow.createAttemptMemory();
    // Every other operation of the real memory (#468 added `version`) is kept; only `get` ignores whose attempt it is.
    const flowModule = { ...realFlow, createAttemptMemory: () => ({ ...shared, get: (u) => (u === null ? null : shared.get(UA_ID) ?? shared.get(u)) }) };
    const p = scriptedPort();
    const app = await createApp({ port: p.port, flowModule });
    await app.auth(session(UA_ID, T1));
    const a = await app.open();
    assert.ok(await a.trySend(A_TEXT));
    answerOf(p.sends[0], UNCERTAIN);
    await app.sync();
    await app.auth(null);
    await app.auth(session(UB_ID, T1, 'rig-at-b'));
    assert.equal(showsA(a, p.sends[0].target.targetId).attempt, true, 'mutant 1: B is shown A\'s attempt');
  }
  {
    const keyLine = "return <ManualPublishScreen key={userId === null ? 'signed-out' : `${userId}:${sessionMark}`} userId={userId} sessionMark={sessionMark} />;";
    assert.equal(ROUTE_SOURCE.split(keyLine).length, 2);
    const p = scriptedPort();
    const app = await createApp({ port: p.port, routeSource: ROUTE_SOURCE.replace(keyLine, "return <ManualPublishScreen key=\"one\" userId={userId} sessionMark={sessionMark} />;") });
    await app.auth(session(UA_ID, T1));
    const a = await app.open();
    assert.ok(await a.trySend(A_TEXT));
    answerOf(p.sends[0], UNCERTAIN);
    await app.sync();
    await app.auth(session(UB_ID, T1, 'rig-at-b'));
    assert.equal(showsA(a, p.sends[0].target.targetId).result, true, 'mutant 2: B is shown A\'s result');
  }
});
