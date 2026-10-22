// G2 QA (Issue #317, task postona-g2-x-uncertain-result-sn5-ui-copy-contract-offline-20261023) -- QA only, no product code.
// The X manual-publish result screen's WORDS and ACTIONS, state by state, as an offline contract: a result that is not
// known must not be called a success or a failure, must not lead to a new post before X is checked, must not be shown to
// another person, and only a real accepted post may say "accepted". Measured on G1 PR #461 (cd6d4eba, on #450 bf053ee0;
// review_required -- not judged here) with #450 for comparison. Known items are classified, not re-reported: G2-SN5 (a
// local wall refusal reads "nothing recorded"), G2-RK3 (an old attempt shown as unconfirmed), H1's post-ack same-id re-ask
// (G1's #461 subject -- not passed here). REAL route + screen + model + flow + stores with MOCK sessions and a scripted
// future send port (G2 #430 / #448 / #458 harness). Offline.
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
    setItem: async (k, v) => { data.set(k, v); },
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
async function createApp({ port, routeSource = ROUTE_SOURCE, flowModule = realFlow } = {}) {
  const world = { session: null, accounts: [account('X_A'), account('X_B')], status: 'ready' };
  const flow = { ...flowModule, attemptMemory: flowModule.createAttemptMemory(), inFlightSends: flowModule.createInFlightSends() };
  const store = kv();
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
    '@/features/manual-publish/manual-publish-storage': { attemptStore: realStore.createAttemptStore(store), draftStore: realDraft.createDraftStore(kv()) },
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
    world, store, flow, sync,
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


// ---- the contract ------------------------------------------------------------------------------------------------------
const UNRESOLVED_KINDS = new Set(['pending', 'unconfirmed', 'uncertain', 'simulated']);
const SUCCESS_WORDS = /投稿を受け付けました|投稿しました|投稿が完了|送信が完了|送信できました/u;
const NOT_SENT_WORDS = /送信されていません|投稿されませんでした|何も記録していません/u;
const UNKNOWN_WORDS = /分かりません|可能性|確認できません|処理中|証拠でもありません/u;
const NEW_POST_ACTIONS = ['新しい投稿を作る', '編集に戻る'];
/**
 * R1 only a real accepted post says it was accepted; R2 an unresolved result never says "not sent / not posted / nothing
 * recorded"; R3 an unresolved result says it is unknown and offers no new-post action; R4 while the process holds an
 * unresolved attempt of this person, no screen says "nothing recorded" or offers a new post; R5 an attempt the process
 * knows was posted is never described as unknown.
 */
function violations(h, ctx) {
  const kind = h.state().result?.kind ?? null;
  const lines = h.lines();
  const has = (re) => lines.some((l) => re.test(l));
  const action = (label) => Boolean(h.button(label));
  const out = [];
  if (kind !== 'sent' && has(SUCCESS_WORDS)) out.push('R1');
  if (UNRESOLVED_KINDS.has(kind) && has(NOT_SENT_WORDS)) out.push('R2');
  if (UNRESOLVED_KINDS.has(kind) && (!has(UNKNOWN_WORDS) || NEW_POST_ACTIONS.some(action))) out.push('R3');
  if (ctx.unresolvedInProcess && (has(/何も記録していません/u) || NEW_POST_ACTIONS.some(action))) out.push('R4');
  if (ctx.shownAttemptWasPosted && has(/分かりません|確認できません/u)) out.push('R5');
  return { kind, out };
}

async function single(answer, opts = {}) {
  const p = scriptedPort();
  const app = await createApp({ ...opts, port: p.port });
  await app.auth(session('UA', T1));
  const a = await app.open();
  assert.ok(await a.trySend(TEXT));
  answerOf(p.sends[0], answer);
  await app.sync();
  return { p, app, a };
}
const STATES = {
  sent: async (opts) => { const { a } = await single(PUBLISHED, opts); return { h: a, ctx: {} }; },
  simulated: async (opts) => { const { a } = await single({ kind: 'published', providerPostId: '1850000000000000009', marks: { simulated: true, afterFreeze: false } }, opts); return { h: a, ctx: {} }; },
  failed: async (opts) => { const { a } = await single({ kind: 'rejected', code: 'X_DUPLICATE', marks: REAL }, opts); return { h: a, ctx: {} }; },
  refused_by_server: async (opts) => { const { a } = await single({ kind: 'refused', code: 'X_NOT_ALLOWED', retryable: false }, opts); return { h: a, ctx: {} }; },
  pending: async (opts) => { const { a } = await single(PENDING, opts); return { h: a, ctx: {} }; },
  unconfirmed: async (opts) => { const { a } = await single({ kind: 'unavailable', code: 'X_TIMEOUT' }, opts); return { h: a, ctx: {} }; },
  uncertain: async (opts) => { const { a } = await single(UNCERTAIN, opts); return { h: a, ctx: {} }; },
  sn5_wall_refusal: async (opts) => {
    const p = scriptedPort();
    const app = await createApp({ ...opts, port: p.port });
    await app.auth(session('UA', T1));
    const a = await app.open();
    const b = await app.open();
    assert.ok(await a.trySend(TEXT));
    answerOf(p.sends[0], UNCERTAIN);
    await app.sync();
    await b.trySend(TEXT);
    await app.sync();
    assert.equal(p.sends.length, 1);
    return { h: b, ctx: { unresolvedInProcess: app.flow.attemptMemory.get('UA') !== null } };
  },
  rk3_old_posted_attempt: async (opts) => {
    const { p, app, a, b } = await staleReAsk(PUBLISHED, opts);
    assert.ok(await a.press('新しい投稿を作る'));
    assert.ok(await a.trySend('Aさんの次の投稿'));
    await reAsk(b, 1);
    await app.sync();
    assert.equal(p.sends.length, 3);
    return { h: b, ctx: { shownAttemptWasPosted: b.state().unresolved?.requestId === p.sends[0].target.targetId } };
  },
};
/** The measured verdicts: [] = the contract holds; anything else is a known or new item (named). */
const EXPECTED = {
  sent: [], simulated: [], failed: [], refused_by_server: [], unconfirmed: [], uncertain: [],
  pending: ['R2'], // NEW G2-UC1 (P3): heading "まだ送信されていません" for a request the server holds
  sn5_wall_refusal: ['R4'], // KNOWN G2-SN5
  rk3_old_posted_attempt: ['R5'], // KNOWN G2-RK3
};

for (const [name, make] of Object.entries(STATES)) {
  test(`G2-UC ${name}: the copy contract, measured`, async (t) => {
    const { h, ctx } = await make({});
    const v = violations(h, ctx);
    t.diagnostic(`${name}: kind=${v.kind} violations=${JSON.stringify(v.out)} lines=${JSON.stringify(h.lines().filter((l) => /投稿|送信|確認|記録|処理中|分かり|可能性/u.test(l)).slice(0, 6))}`);
    assert.deepEqual(v.out, EXPECTED[name]);
  });
}

test('G2-UC-P: another person signs in on top of an uncertain result -- none of A\'s result words or actions are shown to B', async () => {
  const { app, a } = await single(UNCERTAIN);
  await app.auth(session('UB', T1));
  assert.equal(a.state().result, null);
  assert.equal(a.lines().some((l) => UNKNOWN_WORDS.test(l) || SUCCESS_WORDS.test(l) || NOT_SENT_WORDS.test(l)), false);
  assert.equal(ackButton(a), null);
});

test('RELEASE GATE G2-UC1 (P3, owner G1, new): a PENDING result does not say "not sent" -- the server holds the request and the post may still appear', { todo: 'copy gate: red until the pending heading stops asserting "not sent"' }, async () => {
  const { a } = await single(PENDING);
  assert.equal(a.lines().some((l) => /送信されていません/u.test(l)), false);
});

// ---- negative controls: the contract notices broken copy -------------------------------------------------------------
test('negative controls: (1) an uncertain heading that says "投稿しました" breaks R1; (2) an uncertain card that offers "新しい投稿を作る" breaks R3; (3) a pending heading that no longer says "not sent" turns the G2-UC1 gate green', async () => {
  const swap = (from, to) => { assert.equal(ROUTE_SOURCE.split(from).length, 2, `one "${from}"`); return ROUTE_SOURCE.replace(from, to); };
  {
    const { a } = await single(UNCERTAIN, { routeSource: swap('<SectionTitle>投稿されたか確認できません</SectionTitle>', '<SectionTitle>投稿しました</SectionTitle>') });
    assert.ok(violations(a, {}).out.includes('R1'));
  }
  {
    const src = swap("<Text style={{ color: colors.warning, fontWeight: '700' }}>Xに投稿された可能性があります。Xで確認するまで、同じ内容を再送信しないでください。</Text>", "<Text style={{ color: colors.warning, fontWeight: '700' }}>Xに投稿された可能性があります。Xで確認するまで、同じ内容を再送信しないでください。</Text><ActionButton label=\"新しい投稿を作る\" onPress={() => dispatch({ type: 'result_dismissed' })} />");
    const { a } = await single(UNCERTAIN, { routeSource: src });
    assert.ok(violations(a, {}).out.includes('R3'));
  }
  {
    let src = swap('<SectionTitle>まだ送信されていません</SectionTitle>', '<SectionTitle>投稿の結果がまだ出ていません</SectionTitle>');
    assert.equal(src.split("label: 'まだ送信されていません（処理中の可能性）'").length, 2);
    src = src.replace("label: 'まだ送信されていません（処理中の可能性）'", "label: '投稿の結果がまだ出ていません（処理中）'");
    const { a } = await single(PENDING, { routeSource: src });
    assert.equal(a.lines().some((l) => /送信されていません/u.test(l)), false, 'the gate assertion holds on the fixed copy');
    assert.deepEqual(violations(a, {}).out, [], 'and the contract holds');
  }
});
