// G1 TASK 44: mounts the real approval and notification screens with their real hooks, the real approval client and the real env hook;
// React / RN / expo-router are stubbed. The fetch underneath is the caller's: a scripted G3 stand-in (approvals.test.mjs) or the real
// local Edge twin (local-stack/approvals.e2e.mjs). Not a test file itself.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as approvalClient from '../src/features/approvals/approval-client.ts';
import * as approvalView from '../src/features/approvals/approval-view.ts';
import * as reservationView from '../src/features/reservations/reservation-view.ts';

const transpile = async (rel) => ts.transpileModule(await readFile(new URL(rel, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const ENV_JS = await transpile('../src/features/approvals/use-approval-env.ts');
const APPROVALS_JS = await transpile('../src/features/approvals/use-approvals.ts');
const NOTIFICATIONS_JS = await transpile('../src/features/approvals/use-approval-notifications.ts');
const APPROVALS_SCREEN_JS = await transpile('../src/app/approvals/index.tsx');
const NOTIFICATIONS_SCREEN_JS = await transpile('../src/app/notifications/index.tsx');
function load(js, stubs) {
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, Promise, Date, setTimeout, clearTimeout, AbortController, URL, fetch: (...a) => globalThis.fetch(...a), require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } });
  return mod.exports;
}
export const walk = (node, visit) => { if (Array.isArray(node)) return node.forEach((n) => walk(n, visit)); if (!node || typeof node !== 'object') return; visit(node); walk(node.props?.children, visit); };
export const texts = (tree) => { const out = []; walk(tree, (n) => { for (const c of [n.props?.children].flat()) if (typeof c === 'string') out.push(c); if (n.props?.title) out.push(n.props.title); if (n.props?.detail) out.push(n.props.detail); }); return out; };
export const has = (tree, fragment) => texts(tree).some((t) => t.includes(fragment));
export const button = (tree, label) => { let found; walk(tree, (n) => { if (!found && n.type === 'ActionButton' && n.props.label === label) found = n.props; }); return found; };
export const field = (tree, label) => { let found; walk(tree, (n) => { if (n.type === 'TextInput' && n.props.accessibilityLabel === label) found = n.props; }); return found; };
export const pressables = (tree, prefix) => { const out = []; walk(tree, (n) => { if (n.type === 'Pressable' && String(n.props.accessibilityLabel ?? '').startsWith(prefix)) out.push(n.props); }); return out; };
export const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };

/**
 * `world` is read on every render: session ({ token, userId } or null), workspace view, account, status, gate, endpoint, params.
 * `fetch` (in world) is what the client sends through.
 */
export async function mountApprovals(initial) {
  const slots = []; let cursor = 0; const effects = [];
  const react = {
    useState: (init) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (init) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: init }; return slots[i]; },
    useMemo: (fn, deps) => { const i = cursor++; const prev = slots[i]; if (!prev || deps.some((d, j) => !Object.is(d, prev.deps[j]))) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect: (fn, deps) => { const i = cursor++; const prev = slots[i]; if (!prev || deps.some((d, j) => !Object.is(d, prev.deps[j]))) { prev?.cleanup?.(); slots[i] = { deps }; effects.push([i, fn]); } },
  };
  const world = { gate: true, status: 'ready', refocus: 0, ids: 0, pushes: [], params: {}, endpoint: { functionName: 'postona-x-approvals', allowLoopbackHttpForTests: false }, config: { ok: true, config: { url: 'https://proj.example.test', publishableKey: 'sb_publishable_testkey01' } }, ...initial };
  globalThis.fetch = (...a) => world.fetch(...a);
  const supabase = { auth: { getSession: async () => ({ data: { session: world.session ? { access_token: world.session.token, user: { id: world.session.userId } } : null }, error: null }) } };
  const env = load(ENV_JS, {
    react,
    '@/features/personal-workspace/personal-workspace-provider': { usePersonalWorkspace: () => ({ view: world.workspace, retry() {} }) },
    '@/features/reservations/use-refocus-count': { useRefocusCount: () => world.refocus },
    '@/lib/supabase': { supabase, getSupabaseConfig: () => world.config },
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: world.account ? [world.account] : [], activeAccount: world.account, selectAccount() {} }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.session ? { access_token: world.session.token, user: { id: world.session.userId } } : null }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status }) },
    './approval-client': approvalClient,
    './approval-gate': { get POSTONA_APPROVAL_UI_ENABLED() { return world.gate; }, get APPROVAL_ENDPOINT() { return world.endpoint; } },
    './approval-view': approvalView,
  });
  const crypto = { randomUUID: () => (world.uuid ? world.uuid() : `00000000-0000-4000-8000-${String(++world.ids).padStart(12, '0')}`), CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digestStringAsync: async (_a, text) => createHash('sha256').update(text, 'utf8').digest('hex') };
  const hookStubs = { 'expo-crypto': crypto, react, '@/features/reservations/reservation-view': reservationView, './approval-client': approvalClient, './approval-view': approvalView, './use-approval-env': env };
  const approvals = load(APPROVALS_JS, hookStubs);
  const notifications = load(NOTIFICATIONS_JS, hookStubs);
  const jsx = (type, props) => ({ type: typeof type === 'function' ? type.name : type, props });
  const screenStubs = {
    'expo-router': { useLocalSearchParams: () => world.params, useRouter: () => ({ push: (to) => world.pushes.push(to) }) },
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    '@/constants/theme': { colors: {} },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', EmptyState: 'EmptyState', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/features/approvals/approval-view': approvalView,
    '@/features/approvals/use-approvals': approvals,
    '@/features/approvals/use-approval-notifications': notifications,
    '@/features/reservations/reservation-view': reservationView,
  };
  const screens = { approvals: load(APPROVALS_SCREEN_JS, screenStubs).default, notifications: load(NOTIFICATIONS_SCREEN_JS, screenStubs).default };
  let current = initial.screen ?? 'approvals';
  const frames = [];
  const once = () => { cursor = 0; const tree = screens[current](); frames.push(tree); return tree; };
  const wait = initial.wait ?? settle;
  const render = async (times = 5) => { for (let i = 0; i < times; i++) { once(); for (const [i2, fn] of effects.splice(0)) { const c = fn(); slots[i2].cleanup = typeof c === 'function' ? c : null; } await wait(); } return once(); };
  const press = async (label) => { const b = button(once(), label); assert.ok(b, `button ${label}`); assert.notEqual(b.disabled, true, `${label} enabled`); b.onPress(); return render(); };
  const type = async (label, text) => { const f = field(once(), label); assert.ok(f, `field ${label}`); f.onChangeText(text); return render(1); };
  const open = async (prefix, index = 0) => { const p = pressables(once(), prefix)[index]; assert.ok(p, `pressable ${prefix}`); p.onPress(); return render(); };
  /** Switch to the other screen: a fresh mount of it, as a navigation does (the stack keeps the other one, its slots are separate here). */
  const show = async (name) => { current = name; slots.length = 0; effects.length = 0; return render(); };
  return { world, render, once, press, type, open, show, frames, slots };
}
export const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
export const uuid = () => randomUUID();
