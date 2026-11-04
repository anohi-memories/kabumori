// G1 TASK 43: mounts the real media box screen (src/app/media/index.tsx) and its real hook (use-media-box.ts) with React / RN stubbed
// and G5's client copy real. The client underneath is the caller's: a scripted stand-in (media-box.test.mjs) or the real supabase-js
// client on the local Supabase (local-stack/media-box.e2e.mjs). Not a test file itself.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as mbClient from '../src/features/media-box/media-box-client.ts';
import * as mbView from '../src/features/media-box/media-box-view.ts';

export const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
const transpile = async (rel) => ts.transpileModule(await readFile(new URL(rel, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const HOOK_JS = await transpile('../src/features/media-box/use-media-box.ts');
const SCREEN_JS = await transpile('../src/app/media/index.tsx');
function load(js, stubs) {
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, Promise, Date, setTimeout, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } });
  return mod.exports;
}
export const walk = (node, visit) => { if (Array.isArray(node)) return node.forEach((n) => walk(n, visit)); if (!node || typeof node !== 'object') return; visit(node); walk(node.props?.children, visit); };
export const texts = (tree) => { const out = []; walk(tree, (n) => { for (const c of [n.props?.children].flat()) if (typeof c === 'string') out.push(c); if (n.props?.title) out.push(n.props.title); if (n.props?.detail) out.push(n.props.detail); }); return out; };
export const has = (tree, fragment) => texts(tree).some((t) => t.includes(fragment));
export const buttons = (tree, label) => { const out = []; walk(tree, (n) => { if (n.type === 'ActionButton' && n.props.label === label) out.push(n.props); }); return out; };
export const button = (tree, label) => buttons(tree, label)[0];
export const tiles = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'Pressable' && String(n.props.accessibilityLabel ?? '').startsWith('素材 ')) out.push(n.props.accessibilityLabel.slice(3)); }); return out; };
export const images = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'Image') out.push(n.props); }); return out; };
export const videos = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'MediaVideo') out.push(n.props); }); return out; };
export const sessionOf = (id, token = `jwt-${id}`) => ({ access_token: token, user: { id } });
export const picked = (name = 'cafe.png', contentType = 'image/png', size = 70, body = new Uint8Array(size).buffer) => ({ kind: 'picked', name, contentType, size, body });

/** `world` is what the stubs read on every render: change it, then `render()`. */
export async function mountMediaBox({ gate = true, status = 'ready', session, workspace, client, config, settleTimes = 6, wait = settle }) {
  const slots = []; let cursor = 0; const effects = [];
  const react = {
    useState: (init) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (init) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: init }; return slots[i]; },
    useEffect: (fn, deps) => { const i = cursor++; const prev = slots[i]; if (!prev || deps.some((d, j) => !Object.is(d, prev.deps[j]))) { prev?.cleanup?.(); slots[i] = { deps }; effects.push([i, fn]); } },
  };
  const world = { gate, status, session, workspace, client, config, refocus: 0, ids: 0, picks: 0, pick: async () => picked() };
  const lib = { get supabase() { return world.client ?? null; }, getSupabaseConfig: () => world.config };
  const hook = load(HOOK_JS, {
    'expo-crypto': { randomUUID: () => world.uuid ? world.uuid() : `req-${++world.ids}` },
    react,
    '@/features/personal-workspace/personal-workspace-provider': { usePersonalWorkspace: () => ({ view: world.workspace, retry() {} }) },
    '@/features/reservations/use-refocus-count': { useRefocusCount: () => world.refocus },
    '@/lib/supabase': lib,
    '@/providers/auth-provider': { useAuth: () => ({ session: world.session }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status }) },
    './media-box-client': mbClient,
    './media-box-gate': { get POSTONA_MEDIA_BOX_ENABLED() { return world.gate; } },
    './media-box-view': mbView,
    './pick-media': { pickMedia: () => { world.picks += 1; return world.pick(); } },
  });
  const jsx = (type, props) => ({ type: typeof type === 'function' ? type.name : type, props });
  const screen = load(SCREEN_JS, {
    'expo-video': { useVideoPlayer: (source) => ({ source }), VideoView: 'VideoView' },
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    '@/constants/theme': { colors: {} },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', EmptyState: 'EmptyState', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/features/media-box/media-box-view': mbView,
    '@/features/media-box/use-media-box': hook,
  });
  const frames = [];
  const once = () => { cursor = 0; const tree = screen.default(); frames.push(tree); return tree; };
  const render = async () => { for (let i = 0; i < settleTimes; i++) { once(); for (const [i2, fn] of effects.splice(0)) { const c = fn(); slots[i2].cleanup = typeof c === 'function' ? c : null; } await wait(); } return once(); };
  const press = async (label) => { const b = button(once(), label); assert.ok(b, `button ${label}`); assert.notEqual(b.disabled, true, `${label} enabled`); b.onPress(); return render(); };
  const open = async (name) => { let target; walk(once(), (n) => { if (n.type === 'Pressable' && n.props.accessibilityLabel === `素材 ${name}`) target = n.props; }); assert.ok(target, `tile ${name}`); target.onPress(); return render(); };
  return { world, render, once, press, open, frames, slots };
}
