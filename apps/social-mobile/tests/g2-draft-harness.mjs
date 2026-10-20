// G2 QA helper (not a test file): the REAL manual-post route + screen (src/app/manual-publish.tsx, transpiled) and the
// REAL draft store of PR #366, under a MOCK sequence of Supabase sessions, a fake clock and a device storage that logs
// and can delay every read. Same approach as g2-draft-session-boundary.test.mjs (PR #380), extended for G2 gen 11.
// Offline: no network, no Auth server, no token, no X. All values are dummies.
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

export { realDraft };
export const ROUTE_SOURCE = await readFile(new URL('../src/app/manual-publish.tsx', import.meta.url), 'utf8');
export const DRAFT_URL = new URL('../src/features/manual-publish/manual-publish-draft-store.ts', import.meta.url);
export const T0 = Date.parse('2026-10-20T09:00:00Z');
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DKEY = (userId) => `postona.manual-publish.draft.v1:${userId}`;
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

export const account = (id, over = {}) => ({
  id, brandId: 'A', platform: 'x', profile: { displayName: `name-${id}`, handle: `@${id}`, avatarColor: '#123456' },
  connectionStatus: 'connected', postingState: 'active', ...over,
});

/**
 * The device storage of the drafts. Every call is logged as [op, key]. While `hold` is on, a read answers later with
 * the value it saw when it was asked; `releaseOne()` answers the oldest held read.
 */
export function deviceKV() {
  const data = new Map();
  const held = [];
  const log = [];
  let hold = false;
  return {
    data, log,
    hold: (on) => { hold = on; },
    releaseOne: () => { held.shift()?.(); },
    release: () => { while (held.length > 0) held.shift()(); },
    heldCount: () => held.length,
    getItem: (key) => {
      log.push(['get', key]);
      const seen = data.has(key) ? data.get(key) : null;
      return hold ? new Promise((resolve) => held.push(() => resolve(seen))) : Promise.resolve(seen);
    },
    setItem: async (key, value) => { log.push(['set', key]); data.set(key, value); },
    removeItem: async (key) => { log.push(['remove', key]); data.delete(key); },
  };
}

/** MOCK Auth server (NOT the real one): a new sign-in stamps last_sign_in_at, a refresh returns the current value. */
export function mockAuth() {
  let t = Date.parse('2026-10-20T08:00:00Z');
  let n = 0;
  const last = new Map();
  const stamp = (id) => { t += 60_000; last.set(id, new Date(t).toISOString()); };
  return {
    signIn(id) { stamp(id); n += 1; return Object.freeze({ access_token: `rig-at-${n}`, user: Object.freeze({ id, last_sign_in_at: last.get(id) }) }); },
    refresh(session) { n += 1; return Object.freeze({ ...session, access_token: `rig-at-${n}`, user: Object.freeze({ ...session.user, last_sign_in_at: last.get(session.user.id) }) }); },
  };
}

/** One app process: the real route (keyed by user, as in the app) above the real screen, with a minimal hook runtime. */
export async function createApp({ kv = deviceKV(), source = ROUTE_SOURCE, draftModule = realDraft, accounts = [account('X_A'), account('X_B')], clock = { t: T0 } } = {}) {
  const world = { session: null, accounts, status: 'ready' };
  let current = null;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
  const slot = (init) => { const i = current.cursor++; if (!(i in current.slots)) current.slots[i] = init(); return i; };
  const react = {
    useState: (initial) => {
      const inst = current; const i = slot(() => ({ v: typeof initial === 'function' ? initial() : initial }));
      return [inst.slots[i].v, (next) => { inst.slots[i].v = typeof next === 'function' ? next(inst.slots[i].v) : next; }];
    },
    useReducer: (reducer, arg, init) => {
      const inst = current; const i = slot(() => ({ v: init ? init(arg) : arg }));
      return [inst.slots[i].v, (action) => { inst.slots[i].v = reducer(inst.slots[i].v, action); }];
    },
    useRef: (initial) => current.slots[slot(() => ({ current: initial }))],
    useMemo: (factory, deps) => {
      const inst = current; const i = slot(() => ({ deps: undefined, value: undefined, ready: false }));
      if (!inst.slots[i].ready || !sameDeps(inst.slots[i].deps, deps)) { inst.slots[i].value = factory(); inst.slots[i].deps = deps; inst.slots[i].ready = true; }
      return inst.slots[i].value;
    },
    useEffect: (effect, deps) => {
      const inst = current; const i = slot(() => ({ deps: undefined, cleanup: undefined, ran: false }));
      if (!inst.slots[i].ran || !sameDeps(inst.slots[i].deps, deps)) { inst.slots[i].deps = deps; inst.slots[i].ran = true; inst.pending.push({ i, effect }); }
    },
  };
  const jsx = (type, props, key) => ({ type: typeof type === 'function' ? type.name : type, props, key });
  const stubs = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-router': { Link: 'Link', Stack: { Screen: 'StackScreen' } },
    'expo-crypto': { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '@/constants/theme': { colors: new Proxy({}, { get: (_t, name) => String(name) }), spacing: { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: { muted: true } } },
    '@/features/manual-publish/manual-post-preview': { ManualPostPreview: 'ManualPostPreview' },
    '@/features/manual-publish/manual-publish-flow': { ...realFlow, attemptMemory: realFlow.createAttemptMemory() },
    '@/features/manual-publish/manual-publish-model': model,
    '@/features/manual-publish/manual-publish-port': { ...realPort, getManualPublishPort: () => realPort.getManualPublishPort() },
    '@/features/manual-publish/manual-publish-storage': {
      attemptStore: realStore.createAttemptStore(deviceKV()),
      draftStore: draftModule.createDraftStore(kv),
    },
    '@/features/manual-publish/manual-publish-draft-store': draftModule,
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: world.accounts, activeAccount: world.accounts[0] ?? null }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.session }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status, reason: null, snapshot: null }) },
  };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, Promise, Date, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'manual-publish.tsx' });

  const nowFn = () => clock.t; // stable identity, like Date.now
  let screen = null;
  const newInst = () => ({ slots: [], cursor: 0, pending: [] });
  const unmount = (inst) => { inst.slots.forEach((s) => s?.cleanup?.()); };
  const renderScreen = () => {
    current = screen.inst; current.cursor = 0;
    try { screen.tree = mod.exports.ManualPublishScreen({ ...screen.element.props, now: nowFn }); } finally { current = null; }
  };
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
      for (const { i, effect } of batch) {
        const s = screen.inst.slots[i];
        s.cleanup?.();
        const cleanup = effect();
        s.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      }
    }
  };
  const find = (type) => {
    const out = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      if (node.type === type) out.push(node);
      walk(node.props?.children);
    };
    walk(screen.tree);
    return out;
  };
  return {
    kv, clock, world,
    async auth(session) { world.session = session; await sync(); },
    async open() { screen = { key: Symbol('none'), inst: newInst() }; await sync(); },
    leave() { if (screen !== null) unmount(screen.inst); screen = null; },
    async type(text) { find('TextInput')[0].props.onChangeText(text); await sync(); },
    async pickAccount(index) { find('Pressable').filter((n) => n.props.accessibilityRole === 'radio')[index].props.onPress(); await sync(); },
    draft: () => screen.inst.slots[0].v.draft,
    accountId: () => screen.inst.slots[0].v.accountId,
    sync,
    record: (userId) => (kv.data.has(DKEY(userId)) ? JSON.parse(kv.data.get(DKEY(userId))) : null),
  };
}

/** Replace exactly one occurrence (asserted), so a mutation can never silently hit another copy. */
export function mutate(source, from, to) {
  const count = source.split(from).length - 1;
  assert.equal(count, 1, `the mutation target occurs exactly once: ${from.slice(0, 60)}`);
  return source.replace(from, to);
}

/** A mutated copy of the real draft store, written to a temp dir with its imports pointed back at the originals. */
export async function mutatedDraftModule(from, to) {
  const dir = await mkdtemp(join(tmpdir(), 'g2-draft-mut-'));
  const original = await readFile(DRAFT_URL, 'utf8');
  let text = mutate(original, from, to);
  for (const rel of ['./single-post-contract.ts', './manual-publish-store.ts', '../../domain/types.ts']) text = text.split(`'${rel}'`).join(`'${new URL(rel, DRAFT_URL).href}'`);
  const file = join(dir, 'manual-publish-draft-store.mutant.ts');
  await writeFile(file, text);
  try {
    return await import(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
