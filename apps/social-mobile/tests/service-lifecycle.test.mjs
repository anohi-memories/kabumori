// F4 (postona-f4-service-lifecycle-provider-g1-g2-implementation-20261017): the F4-owned half of design B (PR230).
// - ServiceLifecycleProvider: a user-scoped, monotonic epoch per person (`bump`), and the end surface's open state
//   (`open`/`close`), both acting only for the person signed in now; nothing in it is a token, a verdict or a preview.
// - ServiceLifecycleSurface: the end / ID-management screen OUTSIDE the per-login enrollment gate, so re-authentication
//   (a new login of the same person) does not destroy the flow (G2); another person or sign-out closes it.
// - The end screen bumps exactly once, only for an authoritative `ended` / `already_ended` of the pinned person (G1).
// - Layout and the entry points (login-methods, onboarding) open the surface; the F5 gate file is not touched here.
// Synthetic sessions only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { Buffer } from 'node:buffer';
import ts from 'typescript';
import * as account from '../src/domain/account-deletion.ts';
import * as endDomain from '../src/domain/postona-service-end.ts';
import * as notices from '../src/domain/postona-end-notices.ts';
import * as flows from '../src/domain/auth-flows.ts';
import * as recovery from '../src/domain/recovery-binding.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(join(root, path), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const jwt = (id, sid) => ({ user: { id, identities: [{ provider: 'email' }] }, access_token: `synthetic.${Buffer.from(JSON.stringify({ session_id: sid })).toString('base64url')}.signature` });
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); walk(n.props?.children, out); } return out; };

/** A hook runtime for ONE component (dependency-tracked effects with cleanups) plus context objects. */
function hooks() {
  const slots = []; let cursor = 0; let pending = []; const contexts = [];
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    createContext: (value) => { const context = { Provider: { context: null }, current: value }; context.Provider.context = context; contexts.push(context); return context; },
    useContext: (context) => context.current,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; const s = slots[i]; return [s.value, (n) => { s.value = typeof n === 'function' ? n(s.value) : n; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo(factory, deps) { const i = cursor++; if (slots[i] && same(slots[i].deps, deps)) return slots[i].value; slots[i] = { deps, value: factory() }; return slots[i].value; },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { const prev = slots[i]; slots[i] = { deps, cleanup: prev?.cleanup }; pending.push({ i, effect }); } },
  };
  /** Makes every context Provider in `tree` current, as React would for its children. */
  const provide = (tree) => { for (const node of walk(tree)) if (node.type?.context) node.type.context.current = node.props.value; };
  return {
    react, contexts,
    run(component, props) {
      cursor = 0; pending = [];
      const tree = component(props);
      provide(tree);
      for (const { i, effect } of pending) { slots[i].cleanup?.(); const c = effect(); slots[i].cleanup = typeof c === 'function' ? c : undefined; }
      return tree;
    },
    unmount() { for (const s of slots) if (s && typeof s.cleanup === 'function') s.cleanup(); },
  };
}
const jsxRuntime = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'Fragment' };

function load(source, modules) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(source), { module, exports: module.exports, require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n}`); return modules[n]; } });
  return module.exports;
}

/** The real provider, with a synthetic signed-in session. */
async function providerHarness() {
  const h = hooks();
  const auth = { session: jwt('user-A', 'login-1') };
  const lifecycle = load(await read('src/features/service-lifecycle/service-lifecycle.tsx'), { react: h.react, 'react/jsx-runtime': jsxRuntime, '@/providers/auth-provider': { useAuth: () => auth } });
  const APP = { type: 'APP' };
  const render = () => h.run(lifecycle.ServiceLifecycleProvider, { children: APP });
  render();
  return {
    auth, lifecycle, render, APP,
    api: () => lifecycle.useServiceLifecycle(),
    epoch: (userId) => lifecycle.useServiceLifecycleEpoch(userId),
    done: () => h.unmount(),
  };
}

// ------------------------------------------------------------------------------------------- provider contract

test('provider: each person has a monotonic epoch that only bump() of that person, signed in now, increases by one', async () => {
  const p = await providerHarness();
  assert.equal(p.epoch('user-A'), 0); assert.equal(p.epoch(null), 0); assert.equal(p.epoch('user-B'), 0);
  assert.equal(p.api().bump('user-A'), true); p.render();
  assert.equal(p.epoch('user-A'), 1);
  assert.equal(p.api().bump('user-A'), true); p.render();
  assert.equal(p.epoch('user-A'), 2, 'one per call, never reset while signed in');
  assert.equal(p.api().bump('user-B'), false, 'another person\'s signal is refused'); p.render();
  assert.equal(p.epoch('user-B'), 0); assert.equal(p.epoch('user-A'), 2);
  assert.equal(p.api().bump(''), false);
  p.done();
});

test('provider: a late bump for the previous person after a switch is refused; the new person\'s epoch is untouched', async () => {
  const p = await providerHarness();
  const stale = p.api();
  p.auth.session = jwt('user-B', 'login-9'); p.render();
  assert.equal(stale.bump('user-A'), false, 'A is no longer signed in'); p.render();
  assert.equal(p.epoch('user-A'), 0); assert.equal(p.epoch('user-B'), 0);
  p.done();
});

test('provider: the surface opens only for the person signed in, survives that person\'s new login, and closes for anyone else', async () => {
  const p = await providerHarness();
  assert.equal(p.api().openFor, null);
  assert.equal(p.api().open('user-B'), false, 'never for someone else'); p.render();
  assert.equal(p.api().openFor, null);
  assert.equal(p.api().open('user-A'), true); p.render();
  assert.equal(p.api().openFor, 'user-A');
  p.auth.session = jwt('user-A', 'login-2'); p.render();          // re-authentication: same person, new login
  assert.equal(p.api().openFor, 'user-A', 'kept across the session_id rotation');
  p.auth.session = jwt('user-B', 'login-1'); p.render();
  assert.equal(p.api().openFor, null, 'not shown to B even for one render');
  p.auth.session = jwt('user-A', 'login-3'); p.render();
  assert.equal(p.api().openFor, null, 'closed, not merely hidden: A coming back does not reopen it');
  p.api().open('user-A'); p.render(); p.api().close(); p.render();
  assert.equal(p.api().openFor, null);
  p.done();
});

test('provider: the context carries no token, session, verdict or preview -- only the person id and functions', async () => {
  const p = await providerHarness();
  p.api().open('user-A'); p.api().bump('user-A'); p.render();
  const api = p.api();
  assert.deepEqual(Object.keys(api).sort(), ['bump', 'close', 'open', 'openFor']);
  const serialized = JSON.stringify(api) + JSON.stringify(p.epoch('user-A'));
  assert.doesNotMatch(serialized, /synthetic|access_token|session|login-|ready|preview/u);
  assert.equal(typeof p.epoch('user-A'), 'number');
  p.done();
});

test('provider: hooks outside the provider fail loudly (useServiceLifecycle) or read 0 (epoch)', async () => {
  const h = hooks();
  const lifecycle = load(await read('src/features/service-lifecycle/service-lifecycle.tsx'), { react: h.react, 'react/jsx-runtime': jsxRuntime, '@/providers/auth-provider': { useAuth: () => ({ session: null }) } });
  assert.throws(() => lifecycle.useServiceLifecycle(), /ServiceLifecycleProvider/u);
  assert.equal(lifecycle.useServiceLifecycleEpoch('user-A'), 0);
});

// ------------------------------------------------------------------------------------------- surface

test('surface: renders the end screen only while open, keyed by the person (one instance across that person\'s new logins)', async () => {
  const h = hooks();
  const state = { openFor: null, closed: 0 };
  const surface = load(await read('src/features/service-lifecycle/service-lifecycle-surface.tsx'), {
    react: h.react, 'react/jsx-runtime': jsxRuntime,
    'react-native': { Modal: 'Modal', Pressable: 'Pressable', Text: 'Text', View: 'View' },
    '@/constants/theme': { colors: {} },
    '@/app/account-deletion': { __esModule: true, default: 'AccountDeletionScreen' },
    '@/features/service-lifecycle/service-lifecycle': { useServiceLifecycle: () => ({ openFor: state.openFor, open() { return false; }, close() { state.openFor = null; state.closed += 1; }, bump() { return false; } }) },
  });
  const render = () => h.run(surface.ServiceLifecycleSurface, {});
  assert.equal(render(), null);
  state.openFor = 'user-A';
  const screen = walk(render()).find((n) => n.type === 'AccountDeletionScreen');
  assert.ok(screen); assert.equal(screen.key, 'user-A', 'one instance per person: a new login of the same person keeps it');
  const close = walk(render()).find((n) => n.type === 'Pressable');
  close.props.onPress();
  assert.equal(state.closed, 1); assert.equal(render(), null);
});

// ------------------------------------------------------------------------------------------- the end screen

async function screenHarness({ endAnswer, rotateOnReauth = false } = {}) {
  const h = hooks();
  const bumps = []; const ends = [];
  const boundFor = (ctx) => ({ ok: true, accountStatus: 'active', lifecycleVersion: 7, services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status: 'active' }], acknowledgementRequired: ['threads'], postonaAvailable: true, deletionInProgress: false, context: ctx });
  let sid = 's1';
  const auth = {
    session: jwt('u1', sid), backendAvailable: true, email: { signIn: true }, readiness: () => ({ usableNow: true }),
    reauthenticate: async () => {
      // Re-authentication signs in again: a new login (session id) of the same person.
      if (rotateOnReauth) { sid = 's2'; auth.session = jwt('u1', sid); }
      return { ok: true, context: { userId: 'u1', sessionId: sid } };
    },
    previewPostonaEnd: async () => boundFor({ userId: 'u1', sessionId: sid }),
    endPostonaService: async (input) => { ends.push(input); if (endAnswer instanceof Error) throw endAnswer; return typeof endAnswer === 'function' ? endAnswer() : endAnswer; },
  };
  const screen = load(await read('src/app/account-deletion.tsx'), {
    react: h.react, 'react/jsx-runtime': jsxRuntime,
    'react-native': Object.fromEntries(['ActivityIndicator', 'Linking', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map((n) => [n, n])),
    '@/constants/theme': { colors: {} }, '@/components/ui': { Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/domain/account-deletion': account, '@/domain/postona-service-end': { ...endDomain, POSTONA_END_SOURCE_ENABLED: true }, '@/domain/postona-end-notices': notices,
    '@/domain/auth-flows': flows, '@/domain/recovery-binding': recovery, '@/domain/legal-links': { LEGAL_LINK_LABELS: {} },
    '@/lib/legal-config': { LEGAL_LINKS: { support: {} } }, '@/providers/auth-provider': { useAuth: () => auth },
    '@/features/service-lifecycle/service-lifecycle': { useServiceLifecycle: () => ({ openFor: 'u1', open() { return true; }, close() {}, bump: (userId) => { bumps.push(userId); return true; } }) },
  });
  const render = () => h.run(screen.default, {});
  const texts = (tree) => walk(tree).filter((n) => n.type === 'Text' || n.type === 'Pill').map((n) => [n.props.children].flat(Infinity).filter((s) => typeof s === 'string').join(''));
  const button = (tree, label) => walk(tree).find((n) => n.type === 'Pressable' && walk(n.props.children).some((c) => c.type === 'Text' && [c.props.children].flat(Infinity).join('').includes(label)));
  const phraseInput = () => walk(render()).find((n) => n.type === 'TextInput' && !n.props.secureTextEntry);
  async function reauth() {
    render(); await flush();
    walk(render()).find((n) => n.type === 'TextInput' && n.props.secureTextEntry).props.onChangeText('synthetic');
    await button(render(), 'で本人確認').props.onPress(); await flush(); render(); await flush();
  }
  function consent() {
    phraseInput().props.onChangeText(endDomain.POSTONA_END_CONFIRM_PHRASE);
    walk(render()).find((n) => n.type === 'Pressable' && n.props.accessibilityRole === 'checkbox').props.onPress();
  }
  async function submit() { const pressed = button(render(), 'POSTONAの利用を終了').props.onPress(); await pressed; await flush(); return texts(render()); }
  return { h, auth, bumps, ends, render, texts, button, phraseInput, reauth, consent, submit };
}
const ENDED_BODY = { ok: true, outcome: 'ended', providers: { x: 'done', threads: 'local_removed_remote_unverified' }, remote_unverified: ['threads'], x_posts_unconfirmed: 2 };
const parsed = (body) => endDomain.parseEndResult(200, body, ['threads']);

test('G1: an authoritative `ended` or `already_ended` of the pinned person bumps that person exactly once; the result stays visible', async () => {
  for (const answer of [parsed(ENDED_BODY), parsed({ ok: true, outcome: 'already_ended', providers: { x: 'done', threads: 'local_removed_remote_unverified' }, remote_unverified: ['threads'], x_posts_unconfirmed: 2 })]) {
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const s = await screenHarness({ endAnswer: answer });
    await s.reauth(); s.consent();
    assert.deepEqual(s.bumps, [], 'nothing before the end is sent');
    const shown = await s.submit();
    assert.deepEqual(s.bumps, ['u1'], `${answer.outcome}: one signal for the pinned person`);
    assert.ok(shown.some((line) => line.includes('予約が2件')), 'the person still sees their own warning lines');
    s.h.unmount();
  }
});

test('G1: no bump for not_registered, an unconfirmed or refused answer, a session change, a thrown request, or before sending', async () => {
  const answers = [
    parsed({ ok: true, outcome: 'not_registered' }),
    endDomain.endFailure('RESULT_UNCONFIRMED', undefined, { remoteUnverified: ['threads'], xPostsUnconfirmed: 2 }),
    endDomain.endFailure('SESSION_CHANGED'),
    endDomain.endFailure('LIFECYCLE_CHANGED'),
    endDomain.endFailure('WITHDRAW_BLOCKED'),
    new Error('synthetic transport failure'),
  ];
  for (const answer of answers) {
    const s = await screenHarness({ endAnswer: answer });
    await s.reauth(); s.consent();
    await s.submit();
    assert.equal(s.ends.length, 1);
    assert.deepEqual(s.bumps, [], `no signal for ${answer instanceof Error ? 'a thrown request' : answer.ok ? answer.outcome : answer.code}`);
    s.h.unmount();
  }
  // Preview only and re-authentication only: no signal.
  const s = await screenHarness({ endAnswer: parsed(ENDED_BODY) });
  await s.reauth();
  assert.deepEqual(s.bumps, []); assert.equal(s.ends.length, 0);
  s.h.unmount();
});

test('G1: a double tap sends one end and gives one signal', async () => {
  let release; const held = new Promise((r) => { release = r; });
  const s = await screenHarness({ endAnswer: async () => { await held; return parsed(ENDED_BODY); } });
  await s.reauth(); s.consent();
  const first = s.button(s.render(), 'POSTONAの利用を終了').props.onPress();
  const second = s.button(s.render(), 'POSTONAの利用を終了').props.onPress();
  release(); await first; await second; await flush(); s.render();
  assert.equal(s.ends.length, 1); assert.deepEqual(s.bumps, ['u1']);
  s.h.unmount();
});

test('G2: while the screen stays mounted (the surface), re-authentication on a new login continues with a fresh preview and fresh consent', async () => {
  const s = await screenHarness({ endAnswer: parsed(ENDED_BODY), rotateOnReauth: true });
  s.render(); await flush();
  s.phraseInput().props.onChangeText(endDomain.POSTONA_END_CONFIRM_PHRASE);   // typed before re-authentication
  await s.reauth();
  assert.ok(s.texts(s.render()).some((line) => line.includes('本人確認が済みました')), 'the new login is the verified one');
  assert.equal(s.phraseInput().props.value, '', 'consent typed for the old login does not carry over');
  s.consent();
  await s.submit();
  assert.equal(s.ends.length, 1);
  assert.deepEqual(s.ends[0].context, { userId: 'u1', sessionId: 's2' }, 'pinned to the new login');
  assert.deepEqual(s.ends[0].preview.context, { userId: 'u1', sessionId: 's2' }, 'with a preview read for the new login, never the old one');
  assert.deepEqual(s.bumps, ['u1']);
  s.h.unmount();
});

// ------------------------------------------------------------------------------------------- layout and entry points

test('layout: the provider is above the enrollment gate (signed-in only) and the surface is a sibling AFTER the gate', async () => {
  const layout = await read('src/app/_layout.tsx');
  const signedIn = layout.indexOf('if (!session) return <AuthScreen />');
  const recoveryCheck = layout.indexOf('if (recoveryMode) return <NewPasswordScreen />');
  const provider = layout.indexOf('<ServiceLifecycleProvider>');
  const gate = layout.indexOf('<ServiceEnrollmentGate>');
  const gateEnd = layout.indexOf('</ServiceEnrollmentGate>');
  const surface = layout.indexOf('<ServiceLifecycleSurface />');
  const providerEnd = layout.indexOf('</ServiceLifecycleProvider>');
  assert.ok(signedIn > -1 && recoveryCheck > signedIn && provider > recoveryCheck, 'only a signed-in, non-recovery session reaches it');
  assert.ok(gate > provider && gateEnd > gate && surface > gateEnd && providerEnd > surface, 'the surface is outside the subtree the gate remounts');
  assert.match(layout, /<\/DataProvider><\/ServiceEnrollmentGate>/u, 'the gate still wraps data and onboarding (F5 routing contract)');
});

test('entry points open the surface for the person signed in instead of a route inside the gate', async () => {
  const methods = code(await read('src/app/login-methods.tsx'));
  assert.doesNotMatch(methods, /router\.push\('\/account-deletion'\)/u);
  assert.match(methods, /lifecycle\.open\(session\.user\.id\)|lifecycle\.open\(userId\)/u);
  const onboarding = code(await read('src/features/onboarding/onboarding-gate.tsx'));
  assert.doesNotMatch(onboarding, /<AccountDeletionScreen \/>/u, 'no in-gate copy that a new login would destroy');
  assert.match(onboarding, /lifecycle\.open\(/u);
  assert.match(onboarding, /<DeletionEntry onOpen=/u, 'still reachable from every unfinished onboarding screen (App Review 5.1.1(v))');
});
