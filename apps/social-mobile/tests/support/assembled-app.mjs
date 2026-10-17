// The assembled POSTONA app for the F5 gate tests: F4's REAL ServiceLifecycleProvider, the F5 seam, the REAL
// ServiceEnrollmentGate, F4's REAL ServiceLifecycleSurface and end screen, rendered together through one hook runtime
// that shares context. Only Auth (a synthetic session that can be rotated), the end request and PostgREST are fake.
// Same assembly as tests/service-end-g1-g2-integration.test.mjs (F4+F5 joint), kept here so F5 tests do not edit that file.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as enrollmentDomain from '../../src/domain/service-enrollment.ts';
import * as account from '../../src/domain/account-deletion.ts';
import * as endDomain from '../../src/domain/postona-service-end.ts';
import * as notices from '../../src/domain/postona-end-notices.ts';
import * as flows from '../../src/domain/auth-flows.ts';
import * as recovery from '../../src/domain/recovery-binding.ts';
import { fakeServer, flush, loginUuid, sessionOf as gateSessionOf } from './enrollment-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFile(join(root, path), 'utf8');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
export const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); walk(n.props?.children, out); } return out; };
export const textOf = (n) => [n.props?.children].flat(Infinity).filter((s) => typeof s === 'string').join('');
export const ACTIVE = { body: { status: 'active', service: 'x_autopost', started: false, shared_account: false } };
export const ENDED = (version) => ({ body: { status: 'reenroll_required', service: 'x_autopost', lifecycle_version: version } });
export const ENDED_BODY = { ok: true, outcome: 'ended', providers: { x: 'done', threads: 'local_removed_remote_unverified' }, remote_unverified: ['threads'], x_posts_unconfirmed: 2 };
export const sessionOf = (user, login = 1, refresh = 0) => ({ ...gateSessionOf(user, login, refresh), user: { id: `user-${user}`, identities: [{ provider: 'email' }] } });
export const contextOf = (user, login) => ({ userId: `user-${user}`, sessionId: loginUuid(user, login) });

/** One hook runtime shared by several component instances (each with its own hooks), and context objects. */
export function runtime() {
  let active = null;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    createContext: (value) => { const context = { Provider: { context: null }, current: value }; context.Provider.context = context; return context; },
    useContext: (context) => context.current,
    useState: (...a) => active.useState(...a), useRef: (...a) => active.useRef(...a), useMemo: (...a) => active.useMemo(...a),
    useCallback: (...a) => active.useCallback(...a), useEffect: (...a) => active.useEffect(...a),
  };
  const provide = (tree) => { for (const node of walk(tree)) if (node.type?.context) node.type.context.current = node.props.value; };
  function instance() {
    const slots = []; let cursor = 0; let pending = [];
    const self = {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; const s = slots[i]; return [s.value, (n) => { s.value = typeof n === 'function' ? n(s.value) : n; }]; },
      useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useMemo(factory, deps) { const i = cursor++; if (slots[i] && same(slots[i].deps, deps)) return slots[i].value; slots[i] = { deps, value: factory() }; return slots[i].value; },
      useCallback(callback, deps) { return self.useMemo(() => callback, deps); },
      useEffect(effect, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { const prev = slots[i]; slots[i] = { deps, cleanup: prev?.cleanup }; pending.push({ i, effect }); } },
      render(component, props) {
        const previous = active; active = self; cursor = 0; pending = [];
        let tree;
        try { tree = component(props); } finally { active = previous; }
        provide(tree);
        for (const { i, effect } of pending) { slots[i].cleanup?.(); const c = effect(); slots[i].cleanup = typeof c === 'function' ? c : undefined; }
        return tree;
      },
      unmount() { for (const s of slots) if (s && typeof s.cleanup === 'function') s.cleanup(); },
    };
    return self;
  }
  return { react, instance };
}

/** The assembled app: provider -> (gate around APP, surface -> end screen), sharing one synthetic Auth. */
export async function assemble({ answer = () => ACTIVE, endAnswer = () => endDomain.parseEndResult(200, ENDED_BODY, ['threads']), user = 'A' } = {}) {
  const rt = runtime();
  const jsxRuntime = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'Fragment' };
  const load = (source, modules) => {
    const module = { exports: {} };
    vm.runInNewContext(transpile(source), { module, exports: module.exports, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; } });
    return module.exports;
  };
  const server = fakeServer((entry) => answer(entry));
  const ends = [];
  const auth = {
    session: sessionOf(user, 1), backendAvailable: true, email: { signIn: true }, readiness: () => ({ usableNow: true }),
    rotateOnReauth: false,
    reauthenticate: async () => {
      // Re-authentication signs in again: a new login (session id) of the same person when rotating.
      const id = auth.session.user.id.replace('user-', ''); const login = Number(JSON.parse(Buffer.from(auth.session.access_token.split('.')[1], 'base64url')).session_id.slice(-6));
      if (auth.rotateOnReauth) auth.session = sessionOf(id, login + 1);
      return { ok: true, context: contextOf(id, auth.rotateOnReauth ? login + 1 : login) };
    },
    previewPostonaEnd: async () => {
      const claims = JSON.parse(Buffer.from(auth.session.access_token.split('.')[1], 'base64url'));
      return { ok: true, accountStatus: 'active', lifecycleVersion: 7, services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status: 'active' }], acknowledgementRequired: ['threads'], postonaAvailable: true, deletionInProgress: false, context: { userId: auth.session.user.id, sessionId: claims.session_id } };
    },
    endPostonaService: async (input) => { ends.push(input); const a = endAnswer(input); if (a instanceof Error) throw a; return a; },
  };
  const authModule = { useAuth: () => auth };
  const rn = Object.fromEntries(['ActivityIndicator', 'Linking', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map((n) => [n, n]));
  const lifecycle = load(await read('src/features/service-lifecycle/service-lifecycle.tsx'), { react: rt.react, 'react/jsx-runtime': jsxRuntime, '@/providers/auth-provider': authModule });
  const seam = load(await read('src/features/service-enrollment/lifecycle-epoch.ts'), { '@/features/service-lifecycle/service-lifecycle': lifecycle });
  const screenModule = load(await read('src/app/account-deletion.tsx'), {
    react: rt.react, 'react/jsx-runtime': jsxRuntime, 'react-native': rn,
    '@/constants/theme': { colors: {} }, '@/components/ui': { Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/domain/account-deletion': account, '@/domain/postona-service-end': { ...endDomain, POSTONA_END_SOURCE_ENABLED: true }, '@/domain/postona-end-notices': notices,
    '@/domain/auth-flows': flows, '@/domain/recovery-binding': recovery, '@/domain/legal-links': { LEGAL_LINK_LABELS: {} },
    '@/lib/legal-config': { LEGAL_LINKS: { support: {} } }, '@/providers/auth-provider': authModule, '@/features/service-lifecycle/service-lifecycle': lifecycle,
  });
  const surfaceModule = load(await read('src/features/service-lifecycle/service-lifecycle-surface.tsx'), {
    react: rt.react, 'react/jsx-runtime': jsxRuntime, 'react-native': rn, '@/constants/theme': { colors: {} },
    '@/app/account-deletion': screenModule, '@/features/service-lifecycle/service-lifecycle': lifecycle,
  });
  const gateModule = load(await read('src/features/service-enrollment/service-enrollment-gate.tsx'), {
    react: rt.react, 'react/jsx-runtime': jsxRuntime, 'react-native': rn,
    '@/constants/theme': { colors: {}, typography: {} }, '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/components/sign-out-button': { SignOutButton: 'SignOutButton' }, '@/data/repository-selection': { selectDataSource: () => ({ kind: 'supabase' }) },
    '@/domain/service-enrollment': enrollmentDomain,
    '@/lib/supabase': { getSupabaseConfig: () => ({ ok: true, config: { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' } }) },
    '@/providers/auth-provider': authModule, '@/features/service-enrollment/lifecycle-epoch': seam, '@/features/service-lifecycle/service-lifecycle': lifecycle,
    '@/app/account-deletion': screenModule,   // only an older gate imports the screen itself (kept so the SAME assembly can load it for a fail-before run)
  });
  const originalFetch = globalThis.fetch; globalThis.fetch = server.fetchImpl;
  const APP = { type: 'APP' };
  const provider = rt.instance(); let gate = rt.instance(); const surface = rt.instance();
  let screen = null; let screenKey = null;
  const view = { gate: null, surface: null, screen: null };
  function frame() {
    provider.render(lifecycle.ServiceLifecycleProvider, { children: null });
    view.gate = gate.render(gateModule.ServiceEnrollmentGate, { children: APP });
    view.surface = surface.render(surfaceModule.ServiceLifecycleSurface, {});
    const element = view.surface ? walk(view.surface).find((n) => n.type === screenModule.default) : null;
    if (element && (screen === null || screenKey !== element.key)) { screen?.unmount(); screen = rt.instance(); screenKey = element.key; }
    if (!element && screen) { screen.unmount(); screen = null; screenKey = null; }
    view.screen = screen ? screen.render(screenModule.default, {}) : null;
    return view;
  }
  async function settle(rounds = 8) { for (let i = 0; i < rounds; i += 1) { await flush(); frame(); } return view; }
  const screenText = () => walk(view.screen).filter((n) => n.type === 'Text' || n.type === 'Pill').map(textOf);
  const pressable = (tree, label) => walk(tree).find((n) => n.type === 'Pressable' && walk(n.props.children).some((c) => c.type === 'Text' && textOf(c).includes(label)));
  async function endFlow({ rotate = false } = {}) {
    auth.rotateOnReauth = rotate;
    await settle();
    walk(view.screen).find((n) => n.type === 'TextInput' && n.props.secureTextEntry).props.onChangeText('synthetic');
    frame();
    await pressable(view.screen, 'で本人確認').props.onPress(); await settle();
    walk(view.screen).find((n) => n.type === 'TextInput' && !n.props.secureTextEntry).props.onChangeText(endDomain.POSTONA_END_CONFIRM_PHRASE);
    frame();
    walk(view.screen).find((n) => n.type === 'Pressable' && n.props.accessibilityRole === 'checkbox').props.onPress();
    frame();
    const submit = pressable(view.screen, 'POSTONAの利用を終了');
    assert.ok(submit && !submit.props.disabled, 'the end can be sent');
    return submit.props.onPress();
  }
  frame(); await settle();
  return {
    auth, server, ends, view, frame, settle, endFlow, screenText, pressable, APP, lifecycle,
    api: () => lifecycle.useServiceLifecycle(),
    epoch: (userId) => lifecycle.useServiceLifecycleEpoch(userId),
    isApp: () => view.gate === APP || walk(view.gate).includes(APP),
    gateButton: (label) => walk(view.gate).find((n) => n.type === 'ActionButton' && n.props.label === label) ?? null,
    remountGate() { gate.unmount(); gate = rt.instance(); },
    done() { screen?.unmount(); surface.unmount(); gate.unmount(); provider.unmount(); globalThis.fetch = originalFetch; },
  };
}
