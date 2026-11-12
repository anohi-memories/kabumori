// G1 TASK 46: mounts the REAL ended-service history (hook + component) with the REAL approval client; React / RN are stubbed. The fetch
// underneath is the caller's: a scripted G3 stand-in (ended-history.test.mjs) or the real local Edge twin (local-stack/approvals.e2e.mjs).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as approvalClient from '../src/features/approvals/approval-client.ts';
import * as approvalView from '../src/features/approvals/approval-view.ts';
import * as reservationView from '../src/features/reservations/reservation-view.ts';
import { settle, walk } from './approvals-harness.mjs';

const transpile = async (rel) => ts.transpileModule(await readFile(new URL(rel, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const HOOK_JS = await transpile('../src/features/approvals/use-ended-history.ts');
const VIEW_JS = await transpile('../src/features/approvals/ended-history.tsx');
function load(js, stubs) {
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, Promise, Set, globalThis, setTimeout, clearTimeout, AbortController, URL, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } });
  return mod.exports;
}

/** `world`: gate, userId (the gate's person), session ({ token, userId } or null), endpoint, config, fetch, wait. */
export async function mountEndedHistory(initial) {
  const slots = []; let cursor = 0; const effects = [];
  const react = {
    useState: (init) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (init) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: init }; return slots[i]; },
    useMemo: (fn, deps) => { const i = cursor++; const prev = slots[i]; if (!prev || deps.some((d, j) => !Object.is(d, prev.deps[j]))) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect: (fn, deps) => { const i = cursor++; const prev = slots[i]; if (!prev || deps.some((d, j) => !Object.is(d, prev.deps[j]))) { prev?.cleanup?.(); slots[i] = { deps }; effects.push([i, fn]); } },
  };
  const world = { gate: true, userId: 'person-a', session: { token: 'jwt-a', userId: 'person-a' }, endpoint: { functionName: 'postona-x-approvals', allowLoopbackHttpForTests: false }, config: { ok: true, config: { url: 'https://proj.example.test', publishableKey: 'sb_publishable_testkey01' } }, ...initial };
  globalThis.fetch = (...a) => world.fetch(...a);
  const supabase = { auth: { getSession: async () => ({ data: { session: world.session ? { access_token: world.session.token, user: { id: world.session.userId } } : null }, error: null }) } };
  const hook = load(HOOK_JS, {
    react,
    '@/lib/supabase': { supabase, getSupabaseConfig: () => world.config },
    './approval-client': approvalClient,
    './approval-gate': { get POSTONA_APPROVAL_UI_ENABLED() { return world.gate; }, get APPROVAL_ENDPOINT() { return world.endpoint; } },
    './approval-view': approvalView,
  });
  const jsx = (type, props) => ({ type: typeof type === 'function' ? type.name : type, props });
  const component = load(VIEW_JS, {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Text: 'Text', View: 'View' },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', SectionTitle: 'SectionTitle', styles: {} },
    '@/features/reservations/reservation-view': reservationView,
    './approval-view': approvalView,
    './use-ended-history': hook,
  });
  const once = () => { cursor = 0; return component.EndedHistory({ userId: world.userId }); };
  const frames = [];
  const wait = world.wait ?? settle;
  const render = async (times = 5) => { for (let i = 0; i < times; i++) { frames.push(once()); for (const [i2, fn] of effects.splice(0)) { const c = fn(); slots[i2].cleanup = typeof c === 'function' ? c : null; } await wait(); } const t = once(); frames.push(t); return t; };
  const buttons = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'ActionButton') out.push(n.props); if (n.type === 'TextInput' || n.type === 'Pressable') out.push({ label: `${n.type}!` }); }); return out; };
  return { world, render, frames, buttons };
}
