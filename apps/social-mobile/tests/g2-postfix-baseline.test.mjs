// G2 QA (Issue #317, task postona-g2-negative-controls-postfix-compatibility-qa-20261021) -- QA only, no product code.
// A post-fix baseline for G2's manual-X-post draft / send QA that keeps working on every G1 head of the stack
// (#366 before the fixes, #398/#400 after SM1/SM3/N1, #410 with the in-flight take-over), unlike the original G2 files
// (#380 / #394) whose negative controls replaced exact source lines that G1 has since changed.
//
//   FIXED-*   behaviour G1 fixed (SM1, SM3, X1 = N1) plus paths that must keep holding: they PASS on a fixed head and
//             FAIL on #366 (that is the detection).
//   FINDING-* known open gaps (SM2, SM3R, SM4, SM4-D): they PASS while the gap exists and FAIL once fixed.
//   NC-*      negative controls built with the TypeScript AST (no source line strings): each mutant re-creates one
//             regression and the matching FIXED scenario must show it. They hold on every head.
// Real route + screen + model + flow + stores, MOCK sessions, a scripted future send port; offline. The meaning of the
// real Auth `last_sign_in_at` is NOT_VERIFIED.
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
const DRAFT_URL = new URL('../src/features/manual-publish/manual-publish-draft-store.ts', import.meta.url);
const PROVIDER = await readFile(new URL('../src/providers/auth-provider.tsx', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const SAME_ID_LINE = '前回と同じ内容・同じ送信IDで確認します。同じ送信IDは、サーバーが2回送ることはありません。';
const DKEY = (u) => `postona.manual-publish.draft.v1:${u}`;
const T1 = '2026-10-20T08:00:00.000000Z';
const T2 = '2026-10-20T09:30:00.000000Z';
const HOUR = 3600_000;
const session = (id, mark, token = 'rig-at-1') => ({ access_token: token, user: mark === undefined ? { id } : { id, last_sign_in_at: mark } });
const account = (id) => ({ id, brandId: 'A', platform: 'x', profile: { displayName: `name-${id}`, handle: `@${id}`, avatarColor: '#123456' }, connectionStatus: 'connected', postingState: 'active' });

function kv() {
  const data = new Map();
  const held = [];
  let hold = false;
  return {
    data, hold: (on) => { hold = on; }, release: () => { while (held.length) held.shift()(); }, heldCount: () => held.length,
    getItem: (k) => { const v = data.has(k) ? data.get(k) : null; return hold ? new Promise((r) => held.push(() => r(v))) : Promise.resolve(v); },
    setItem: async (k, v) => { data.set(k, v); }, removeItem: async (k) => { data.delete(k); },
  };
}
function scriptedPort() {
  const sends = [];
  return { sends, port: { checkReadiness: async () => ({ kind: 'ready' }), send: (target) => new Promise((resolve) => { sends.push({ target, resolve }); }) } };
}

// ---- the AST mutants (no source line strings) ------------------------------------------------------------------------

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const f = ts.factory;
function mutate(source, kind, visitorOf) {
  const file = ts.createSourceFile('x', source, ts.ScriptTarget.ES2022, true, kind);
  const counter = { n: 0 };
  const result = ts.transform(file, [(context) => (root) => { const visit = visitorOf(context, counter); return ts.visitNode(root, function v(node) { return visit(node) ?? ts.visitEachChild(node, v, context); }); }]);
  return { text: printer.printFile(result.transformed[0]), n: counter.n };
}
const textOf = (node) => node.getText();
const screenElement = (node) => (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === 'ManualPublishScreen';
/** <ManualPublishScreen key={...}> -> key={userId ?? 'signed-out'} (the pre-#398 route). */
const routeKeyByUserOnly = (src) => mutate(src, ts.ScriptKind.TSX, (_c, k) => (node) => {
  if (ts.isJsxAttribute(node) && node.name.getText() === 'key' && screenElement(node.parent.parent)) {
    k.n += 1;
    return f.updateJsxAttribute(node, node.name, f.createJsxExpression(undefined, f.createBinaryExpression(f.createIdentifier('userId'), ts.SyntaxKind.QuestionQuestionToken, f.createStringLiteral('signed-out'))));
  }
  return undefined;
});
/** <ManualPublishScreen sessionMark={...}> -> sessionMark={'rig-constant'} (every session looks the same). */
const constantSessionMark = (src) => mutate(src, ts.ScriptKind.TSX, (_c, k) => (node) => {
  if (ts.isJsxAttribute(node) && node.name.getText() === 'sessionMark' && screenElement(node.parent.parent)) {
    k.n += 1;
    return f.updateJsxAttribute(node, node.name, f.createJsxExpression(undefined, f.createStringLiteral('rig-constant')));
  }
  return undefined;
});
/** The condition of the JSX conditional that renders the same-id line -> `state.unresolved !== null` (pre-#398). */
const sameIdLineOnAnyUnresolved = (src) => mutate(src, ts.ScriptKind.TSX, (_c, k) => (node) => {
  // Only the innermost conditional whose true branch IS the <Text> line (an outer conditional also "contains" it).
  let branch = node.whenTrue;
  while (branch && ts.isParenthesizedExpression(branch)) branch = branch.expression;
  if (ts.isConditionalExpression(node) && branch && ts.isJsxElement(branch) && branch.openingElement.tagName.getText() === 'Text' && textOf(branch).includes('前回と同じ内容・同じ送信ID')) {
    k.n += 1;
    return f.updateConditionalExpression(node, f.createBinaryExpression(f.createPropertyAccessExpression(f.createIdentifier('state'), 'unresolved'), ts.SyntaxKind.ExclamationEqualsEqualsToken, f.createNull()), node.questionToken, node.whenTrue, node.colonToken, node.whenFalse);
  }
  return undefined;
});
/** In the `.then` of `loadDraftForRestore(...)`: `if (cancelled || !mountedRef.current) return;` -> `if (!mountedRef.current) return;`. */
const restoreWithoutCancel = (src) => mutate(src, ts.ScriptKind.TSX, (context, k) => (node) => {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.getText() === 'then'
    && ts.isCallExpression(node.expression.expression) && node.expression.expression.expression.getText() === 'loadDraftForRestore') {
    const inner = (n) => {
      if (ts.isIfStatement(n) && ts.isBinaryExpression(n.expression) && n.expression.operatorToken.kind === ts.SyntaxKind.BarBarToken && n.expression.left.getText() === 'cancelled') {
        k.n += 1;
        return f.updateIfStatement(n, n.expression.right, n.thenStatement, n.elseStatement);
      }
      return ts.visitEachChild(n, inner, context);
    };
    return ts.visitEachChild(node, inner, context);
  }
  return undefined;
});
/** decideRestore without any session-mark discard (`reason: 'other_session' | 'no_session_mark'`). */
const storeIgnoresMark = (src) => mutate(src, ts.ScriptKind.TS, (context, k) => (node) => {
  if (ts.isFunctionDeclaration(node) && node.name?.getText() === 'decideRestore' && node.body) {
    const kept = node.body.statements.filter((s) => {
      const drop = ts.isIfStatement(s) && /reason: '(other_session|no_session_mark)'/u.test(textOf(s.thenStatement));
      if (drop) k.n += 1;
      return !drop;
    });
    return f.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, f.updateBlock(node.body, kept));
  }
  return undefined;
});
async function importMutatedDraftStore() {
  const { text, n } = storeIgnoresMark(await readFile(DRAFT_URL, 'utf8'));
  assert.ok(n >= 1, 'the session-mark discard was found in decideRestore');
  const fixed = text.replace(/from "(\.[^"]+)"/gu, (_m, rel) => `from "${new URL(rel, DRAFT_URL).href}"`).replace(/from '(\.[^']+)'/gu, (_m, rel) => `from '${new URL(rel, DRAFT_URL).href}'`);
  const dir = await mkdtemp(join(tmpdir(), 'g2-postfix-'));
  try { await writeFile(join(dir, 'draft.mutant.ts'), fixed); return await import(join(dir, 'draft.mutant.ts')); } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---- harness ---------------------------------------------------------------------------------------------------------

async function createApp({ port, source = ROUTE_SOURCE, draftModule = realDraft, draftKv = kv(), clock = { t: Date.parse('2026-10-20T09:00:00Z') } } = {}) {
  const world = { session: null, accounts: [account('X_A'), account('X_B')], status: 'ready' };
  const flow = { ...realFlow, attemptMemory: realFlow.createAttemptMemory(), ...(realFlow.createInFlightSends ? { inFlightSends: realFlow.createInFlightSends() } : {}) };
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
    'react-native': { Platform: { OS: 'ios' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-router': { Link: 'Link', Stack: { Screen: 'StackScreen' } },
    'expo-crypto': { randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '@/constants/theme': { colors: new Proxy({}, { get: (_t, name) => String(name) }), spacing: { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: { muted: true } } },
    '@/features/manual-publish/manual-post-preview': { ManualPostPreview: 'ManualPostPreview' },
    '@/features/manual-publish/manual-publish-flow': flow,
    '@/features/manual-publish/manual-publish-model': model,
    '@/features/manual-publish/manual-publish-port': { ...realPort, getManualPublishPort: () => port ?? realPort.UNCONNECTED_MANUAL_PUBLISH_PORT },
    '@/features/manual-publish/manual-publish-storage': { attemptStore: realStore.createAttemptStore(kv()), draftStore: draftModule.createDraftStore(draftKv) },
    '@/features/manual-publish/manual-publish-draft-store': draftModule,
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: world.accounts, activeAccount: world.accounts[0] ?? null }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.session }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status, reason: null, snapshot: null }) },
  };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, Promise, Date, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'manual-publish.tsx' });
  let screen = null;
  let instances = 0;
  const newInst = () => { instances += 1; return { slots: [], cursor: 0, pending: [] }; };
  const unmount = (inst) => { inst.slots.forEach((s) => s?.cleanup?.()); };
  const nowFn = () => clock.t;
  const renderScreen = () => { current = screen.inst; current.cursor = 0; try { screen.tree = mod.exports.ManualPublishScreen({ ...screen.element.props, now: nowFn }); } finally { current = null; } };
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
      for (const { i, effect } of batch) { const s = screen.inst.slots[i]; s.cleanup?.(); const cleanup = effect(); s.cleanup = typeof cleanup === 'function' ? cleanup : undefined; }
    }
  };
  const find = (type) => { const out = []; const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (n === null || typeof n !== 'object') return; if (n.type === type) out.push(n); walk(n.props?.children); }; walk(screen.tree); return out; };
  const lines = () => { const out = []; const visit = (node) => { if (Array.isArray(node)) { node.forEach(visit); return; } if (node === null || typeof node !== 'object') return; if (node.props?.label) out.push(node.props.label); const kids = [node.props?.children].flat(Infinity); const own = kids.filter((x) => typeof x === 'string' || typeof x === 'number').join(''); if (own !== '') out.push(own); kids.forEach((x) => { if (x !== null && typeof x === 'object') visit(x); }); }; visit(screen.tree); return out; };
  const api = {
    world, draftKv, clock, sync, lines, instances: () => instances,
    async auth(s) { world.session = s; await sync(); },
    async open() { screen = { key: Symbol('none'), inst: newInst() }; await sync(); },
    leave() { if (screen) unmount(screen.inst); screen = null; },
    state: () => screen.inst.slots[0].v,
    button: (label) => find('ActionButton').find((b) => b.props.label === label) ?? null,
    async press(label) { const b = api.button(label); assert.ok(b, `button "${label}" exists`); if (b.props.disabled) return false; b.props.onPress(); await sync(); return true; },
    async type(value) { find('TextInput')[0].props.onChangeText(value); await sync(); },
    async pick(i) { find('Pressable').filter((n) => n.props.accessibilityRole === 'radio')[i].props.onPress(); await sync(); },
    async tick() { const box = find('Pressable').find((n) => n.props.accessibilityRole === 'checkbox'); assert.ok(box, 'consent checkbox'); box.props.onPress(); await sync(); },
    async sendText(value) { await api.type(value); assert.ok(await api.press('内容を確認する')); await api.tick(); const b = api.button('Xに投稿する'); assert.ok(b && !b.props.disabled, 'send enabled'); b.props.onPress(); b.props.onPress(); await sync(); },
    record: (u) => (draftKv.data.has(DKEY(u)) ? JSON.parse(draftKv.data.get(DKEY(u))) : null),
  };
  return api;
}

// ---- scenarios (shared by the FIXED tests and the negative controls) -------------------------------------------------

/** Sign out and in again (a new mark): the old text must not come back. */
async function relogin(opts = {}) {
  const app = await createApp(opts);
  await app.auth(session('UA', T1));
  await app.open();
  await app.type('前のセッションの下書き');
  app.leave();
  await app.auth(null);
  await app.auth(session('UA', T2));
  await app.open();
  return app.state().draft;
}
/** A new sign-in of the same person (no SIGNED_OUT) while the screen is open. */
async function reSignInWhileOpen(opts = {}) {
  const app = await createApp(opts);
  await app.auth(session('UA', T1));
  await app.open();
  await app.type('開いたままの下書き');
  await app.auth(session('UA', T2, 'rig-at-2'));
  const shown = app.state().draft;
  await app.type(`${shown}。`);
  return { shown, recordMark: app.record('UA')?.sessionMark ?? null, recordText: app.record('UA')?.text ?? null };
}
/** The first send of a new text: is the same-id line shown while it is out? */
async function firstSendShowsSameId(opts = {}) {
  const p = scriptedPort();
  const app = await createApp({ ...opts, port: p.port });
  await app.auth(session('UA', T1));
  await app.open();
  await app.sendText('はじめての投稿');
  return app.lines().includes(SAME_ID_LINE);
}
/** ABA: the chosen account disappears while the restore read is pending. */
async function accountGoneDuringRestore(opts = {}) {
  const draftKv = kv();
  const app = await createApp({ ...opts, draftKv });
  await app.auth(session('UA', T1));
  await app.open();
  await app.pick(1);
  await app.type('Bへの下書き');
  app.leave();
  draftKv.hold(true);
  await app.open();
  app.world.accounts = [account('X_A')];
  await app.sync();
  draftKv.hold(false);
  draftKv.release();
  await app.sync();
  await app.sync();
  return { draft: app.state().draft, record: app.record('UA') };
}

// ---- FIXED (pass on a fixed head, fail on #366) ----------------------------------------------------------------------

test('FIXED-SM1: with no usable last_sign_in_at nothing is kept and a new session gets nothing back', async () => {
  for (const missing of [undefined, null, '']) {
    const app = await createApp();
    await app.auth(session('UA', missing));
    await app.open();
    await app.type('印のない下書き');
    assert.equal(app.record('UA'), null, `${String(missing)}: nothing written`);
    app.leave();
    await app.auth(null);
    await app.auth(session('UA', missing, 'rig-at-2'));
    await app.open();
    assert.equal(app.state().draft, '', `${String(missing)}: nothing restored`);
  }
});

test('FIXED-SM3: a new sign-in of the same person while the screen is open re-creates it -- the old text is neither shown nor saved under the new mark', async () => {
  const seen = await reSignInWhileOpen();
  assert.equal(seen.shown, '');
  assert.notEqual(seen.recordText, '開いたままの下書き。');
});

test('FIXED-X1: a first send does not say "same content, same id"', async () => {
  assert.equal(await firstSendShowsSameId(), false);
});

test('FIXED-HOLD: sign-out + sign-in gets nothing back; a refresh that keeps the mark keeps the open text; an account removed during a pending restore is not restored', async () => {
  assert.equal(await relogin(), '');
  const app = await createApp();
  await app.auth(session('UA', T1, 'rig-at-1'));
  await app.open();
  await app.type('更新をまたぐ下書き');
  const before = app.instances();
  await app.auth(session('UA', T1, 'rig-at-2'));
  assert.equal(app.instances(), before);
  assert.equal(app.state().draft, '更新をまたぐ下書き');
  const aba = await accountGoneDuringRestore();
  assert.equal(aba.draft, '');
  assert.equal(aba.record, null);
});

// ---- FINDING (known open gaps: pass while they exist) ------------------------------------------------------------------

test('FINDING-SM2 (MOCK): the same person signing in elsewhere changes the mark on refresh -- this device\'s stored draft is discarded', async () => {
  const app = await createApp();
  await app.auth(session('UA', T1));
  await app.open();
  await app.type('この端末の下書き');
  app.leave();
  await app.auth(session('UA', T2, 'rig-at-2'));
  await app.open();
  assert.equal(app.state().draft, '');
});

test('FINDING-SM3R-T (since #398, MOCK): a refresh with a changed mark re-creates the OPEN screen and the typed text is gone at once', async () => {
  const app = await createApp();
  await app.auth(session('UA', T1));
  await app.open();
  await app.type('入力中の本文');
  await app.auth(session('UA', T2, 'rig-at-2'));
  assert.equal(app.state().draft, '');
});

test('FINDING-SM3R-S (since #398, MOCK): the same change while a send is out shows the attempt as "unconfirmed" and offers a same-id re-ask before the first answer', async () => {
  const p = scriptedPort();
  const app = await createApp({ port: p.port });
  await app.auth(session('UA', T1));
  await app.open();
  await app.sendText('送信中の本文');
  await app.auth(session('UA', T2, 'rig-at-2'));
  assert.equal(app.state().unresolved?.kind, 'unconfirmed');
  assert.ok(app.button('同じ内容・同じ送信IDで確認し直す'));
});

test('FINDING-SM4: sign-out leaves the text on the device and 24 hours are only checked when the same person reads it again', async () => {
  const clock = { t: Date.parse('2026-10-20T09:00:00Z') };
  const app = await createApp({ clock });
  await app.auth(session('UA', T1));
  await app.open();
  await app.type('共有端末に残る本文');
  app.leave();
  await app.auth(null);
  clock.t += 48 * HOUR;
  await app.auth(session('UB', T1));
  await app.open();
  assert.equal(app.record('UA')?.text, '共有端末に残る本文');
});

test('FINDING-SM4-D (static): the account-deletion clean-up removes the onboarding state but nothing of the manual post', () => {
  const start = PROVIDER.indexOf("// The server confirmed: forget this device's session and per-user state.");
  assert.ok(start > 0);
  const block = PROVIDER.slice(start, PROVIDER.indexOf('setDeletionNotice(', start));
  assert.match(block, /onboardingStorageKey\(/u);
  assert.doesNotMatch(block, /manual-publish|draftStore|draftKeyOf|attemptStore|storeKeyOf/u);
});

// ---- NC (AST mutants; each must re-create its regression on every head) ------------------------------------------------

test('NC-1: the route keyed by the user only (AST) carries the text into a new sign-in', async () => {
  const m = routeKeyByUserOnly(ROUTE_SOURCE);
  assert.equal(m.n, 1, 'exactly one key attribute on ManualPublishScreen');
  assert.equal((await reSignInWhileOpen({ source: m.text })).shown, '開いたままの下書き');
});

test('NC-2: a constant session mark (AST) brings the old text back after sign-out + sign-in', async () => {
  const m = constantSessionMark(ROUTE_SOURCE);
  assert.equal(m.n, 1, 'exactly one sessionMark attribute on ManualPublishScreen');
  assert.equal(await relogin({ source: m.text }), '前のセッションの下書き');
});

test('NC-3: the same-id line on any unresolved attempt (AST) shows it on a first send', async () => {
  const m = sameIdLineOnAnyUnresolved(ROUTE_SOURCE);
  assert.equal(m.n, 1, 'exactly one conditional renders the same-id line');
  assert.equal(await firstSendShowsSameId({ source: m.text }), true);
});

test('NC-4: the restore without its cancel check (AST) restores a draft whose account was removed meanwhile', async () => {
  const m = restoreWithoutCancel(ROUTE_SOURCE);
  assert.equal(m.n, 1, 'exactly one cancel check in the restore');
  assert.equal((await accountGoneDuringRestore({ source: m.text })).draft, 'Bへの下書き');
});

test('NC-5: a draft store whose decideRestore ignores the session mark (AST) brings the old text back after sign-out + sign-in', async () => {
  const mutant = await importMutatedDraftStore();
  assert.equal(await relogin({ draftModule: mutant }), '前のセッションの下書き');
});
