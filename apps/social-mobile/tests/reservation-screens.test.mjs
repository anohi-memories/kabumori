// G1 TASK 30: the X / Threads reservations screen (src/app/reservations/index.tsx) against G3's store contract (handoff
// 6536788017, PR #601 2a02fcbd). The REAL view rules (reservation-view.ts), the REAL disabled ports of this build, and the
// REAL screen (transpiled, stubbed React / RN / router) driven by scripted stand-ins of G3's stores that answer the way
// the handoff says the real ones do. A scripted "saved" here proves the screen's handling only -- not that a real server
// adopted anything. Nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as view from '../src/features/reservations/reservation-view.ts';
import * as ports from '../src/features/reservations/reservation-ports.ts';
import * as enrollment from '../src/domain/service-enrollment.ts';

const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];
const savedGlobals = new Map();
let trapped = 0;
test.before(() => {
  for (const name of NETWORK) {
    savedGlobals.set(name, globalThis[name]);
    globalThis[name] = function forbidden() { trapped += 1; throw new Error(`network entry point ${name} must not be used`); };
  }
});
test.after(() => {
  for (const name of NETWORK) {
    if (savedGlobals.get(name) === undefined) delete globalThis[name];
    else globalThis[name] = savedGlobals.get(name);
  }
  assert.equal(trapped, 0);
});

const NOW = new Date('2026-10-31T00:00:00Z');
const row = (id, over = {}) => ({ reservationId: id, draftId: `d-${id}`, scheduledAt: '2026-11-02T00:30:00Z', status: 'planned', revision: 1, consentState: 'confirmed', body: `本文${id}`, ...over });
const receipt = (state, over = {}) => ({ reservationId: 'th-1', state, providerPostId: null, outcomeCode: null, afterFreeze: false, simulated: true, ...over });

// ---------------------------------------------------------------------------------------------------------------
// The rules (pure).

test('「予約済み」 only for planned + confirmed (X) and a pending receipt (Threads); uncertain is "check", never editable', () => {
  const statuses = ['planned', 'claimed', 'published', 'failed', 'uncertain', 'cancelled', 'expired'];
  const consents = ['confirmed', 'needs_reconfirm', 'ai_owner_opt_in'];
  for (const status of statuses) {
    for (const consentState of consents) {
      const v = view.xRowView(row('r', { status, consentState }));
      assert.equal(v.label === '予約済み', status === 'planned' && consentState === 'confirmed', `${status}/${consentState}`);
      if (status !== 'planned') assert.deepEqual([v.canReschedule, v.needsReconfirm, v.canCancel], [false, false, false], `${status}: no edit`);
    }
  }
  assert.equal(view.xRowView(row('r', { status: 'uncertain' })).label, 'Xで確認してください');
  assert.match(view.xRowView(row('r', { status: 'uncertain' })).detail, /自動で送り直すことはありません/u);
  const reconfirm = view.xRowView(row('r', { consentState: 'needs_reconfirm' }));
  assert.deepEqual([reconfirm.label, reconfirm.needsReconfirm, reconfirm.canReschedule, reconfirm.canCancel], ['再確認が必要', true, true, true]);
  for (const state of ['sent', 'failed', 'cancelled', 'pending', 'uncertain', null]) {
    const r = view.threadsReceiptView(state);
    assert.equal(r.label === '予約済み', state === 'pending', String(state));
    assert.equal(r.canCancel, state === 'pending', String(state));
  }
  assert.equal(view.threadsReceiptView('uncertain').label, 'Threadsで確認してください');
  assert.match(view.threadsReceiptView('uncertain').detail, /作り直すことはありません/u);
  assert.match(view.threadsReceiptView(null).detail, /作り直すことはありません/u);
});

test('every store action maps to one safe screen behaviour', () => {
  const expected = {
    sign_in: ['settings', true, false], start_service: ['settings', true, false], reconnect_x: ['accounts', true, false],
    reconnect_threads: ['accounts', true, false], not_available: [null, true, false], reload: [null, false, true],
    final: [null, false, true], not_found: [null, false, true], fix_input: [null, false, false], retry_later: [null, false, false], check: [null, false, true],
  };
  for (const [action, [button, blocks, reread]] of Object.entries(expected)) {
    const v = view.actionView(action, 'x');
    assert.deepEqual([v.button, v.blocks, v.reread], [button, blocks, reread], action);
    assert.doesNotMatch(v.message, /予約しました|保存しました|投稿しました/u, `${action}: never success`);
  }
  assert.match(view.actionView('not_available', 'threads').message, /Threadsの予約は、いまは使えません/u);
  assert.match(view.actionView('check', 'x').message, /自動で送り直すことはありません/u);
  assert.match(view.actionView('retry_later', 'x').message, /何も変更されていません/u);
  for (const text of Object.values(view.GATE_OFF_TEXT)) assert.match(text, /「予約済み」と表示されることはありません/u);
});

test('time input: Japan time "YYYY-MM-DD HH:mm", a real date, in the future; formatJst is its inverse', () => {
  assert.deepEqual(view.parseJstInput('2026-11-01 09:30', NOW), { ok: true, iso: '2026-11-01T09:30:00+09:00' });
  assert.equal(view.formatJst('2026-11-01T00:30:00Z'), '2026-11-01 09:30');
  assert.equal(view.formatJst('not a date'), '');
  for (const text of ['2026-11-01T09:30', '2026/11/01 09:30', '', '2026-11-1 9:30']) assert.equal(view.parseJstInput(text, NOW).ok, false, text);
  assert.match(view.parseJstInput('2026-02-30 09:00', NOW).message, /ありません/u);
  assert.match(view.parseJstInput('2026-11-01 24:00', NOW).message, /ありません/u);
  assert.match(view.parseJstInput('2026-10-31 08:59', NOW).message, /これから/u);
  assert.equal(view.parseJstInput('2026-10-31 09:01', NOW).ok, true);
});

test('only an account of the person\'s own personal workspace, connected, on the chosen platform', () => {
  const acc = (over = {}) => ({ brandId: 'u_me', connectionStatus: 'connected', platform: 'x', ...over });
  assert.equal(view.accountRefusal(acc(), 'x', 'u_me'), null);
  assert.match(view.accountRefusal(null, 'x', 'u_me'), /まだ接続されていません/u);
  assert.match(view.accountRefusal(acc({ platform: 'threads' }), 'x', 'u_me'), /Xアカウントを選んで/u);
  assert.match(view.accountRefusal(acc({ brandId: 'shared' }), 'x', 'u_me'), /個人ワークスペース/u);
  assert.match(view.accountRefusal(acc({ brandId: undefined }), 'x', 'u_me'), /個人ワークスペース/u);
  assert.match(view.accountRefusal(acc(), 'x', null), /個人ワークスペース/u, 'W0 not ready: refused');
  assert.match(view.accountRefusal(acc({ connectionStatus: 'needs_attention' }), 'x', 'u_me'), /接続し直して/u);
});

test('the ports of this build are the disabled ones: every call NOT_AVAILABLE, nothing else is known', async () => {
  const d = ports.DISABLED_RESERVATION_PORTS;
  assert.equal(d.x.enabled, false); assert.equal(d.threads.enabled, false);
  for (const call of [d.x.list('a'), d.x.get('r'), d.x.reschedule('r', 1, 't'), d.x.reconfirm('r', 1, 's'), d.x.cancel('r', 1), d.threads.cancel('r', 'a', 'c'), d.threads.receipt('a', 'c')]) {
    assert.deepEqual(await call, { ok: false, code: 'NOT_AVAILABLE' });
  }
  assert.deepEqual(await d.threads.create({ socialAccountId: 'a', clientRequestId: 'c', text: 't', contentSha256: 's', scheduledAt: 'x' }), { kind: 'not_available' });
  assert.equal(d.actionOf('NOT_AVAILABLE'), 'not_available');
  for (const code of ['POSTONA_RESV_STALE_REVISION', 'AUTH_REQUIRED', 'SOMETHING']) assert.equal(d.actionOf(code), 'check', code);
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.x) && Object.isFrozen(d.threads));
});

// ---------------------------------------------------------------------------------------------------------------
// The real screen over scripted stores.

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (user, session, n = 1) => `${b64({ alg: 'ES256' })}.${b64({ sub: user, session_id: session, n })}.sig${n}`;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
// A fixture of G3's code -> action table (reservation-error-actions.ts at #601), for the codes these tests use.
const G3_ACTIONS = {
  AUTH_REQUIRED: 'sign_in', POSTONA_RESV_SERVICE_NOT_ACTIVE: 'start_service', POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED: 'reconnect_x',
  POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED: 'reconnect_threads', NOT_AVAILABLE: 'not_available', POSTONA_THREADS_RESV_PUBLISH_DISABLED: 'not_available',
  POSTONA_RESV_STALE_REVISION: 'reload', POSTONA_RESV_ALREADY_FINAL: 'final', POSTONA_RESV_NOT_FOUND: 'not_found', POSTONA_THREADS_RESV_NOT_FOUND: 'not_found',
  POSTONA_RESV_SLOT_CONFLICT: 'fix_input', POSTONA_THREADS_RESV_TEXT_INVALID: 'fix_input', RATE_LIMITED: 'retry_later',
};

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
};
const flat = (children) => [children].flat(Infinity).filter((c) => typeof c === 'string' || typeof c === 'number').join('');
const texts = (tree) => { const out = []; walk(tree, (n) => { if (['Text', 'Pill'].includes(n.type)) out.push(flat(n.props.children)); }); return out; };
const has = (tree, fragment) => texts(tree).some((t) => t.includes(fragment));
const buttons = (tree, label) => { const out = []; walk(tree, (n) => { if (n.type === 'ActionButton' && n.props.label === label) out.push(n.props); }); return out; };
const button = (tree, label, index = 0) => buttons(tree, label)[index];
const chip = (tree, label) => { let found; walk(tree, (n) => { if (n.type === 'Chip' && n.props.label === label) found = n.props; }); return found; };
const field = (tree, label) => { let found; walk(tree, (n) => { if (n.type === 'TextInput' && n.props.accessibilityLabel === label) found = n.props; }); return found; };
const rowPress = (tree, label) => { let found; walk(tree, (n) => { if (n.type === 'Pressable' && n.props.accessibilityLabel === label) found = n.props; }); return found; };
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** Scripted stand-ins of G3's X / Threads stores: answers per method in order; `hold` keeps one pending until release(). */
function scriptedPorts({ x = true, threads = true } = {}) {
  const calls = [];
  const queues = {};
  const held = [];
  const method = (store, name) => (...args) => {
    calls.push([`${store}.${name}`, ...args]);
    const answer = (queues[`${store}.${name}`] ?? []).shift();
    assert.ok(answer, `unexpected ${store}.${name}(${JSON.stringify(args)})`);
    if (!answer.hold) return Promise.resolve(answer.value);
    return new Promise((resolve) => held.push(() => resolve(answer.value)));
  };
  const value = {
    x: { enabled: x, list: method('x', 'list'), get: method('x', 'get'), reschedule: method('x', 'reschedule'), reconfirm: method('x', 'reconfirm'), cancel: method('x', 'cancel') },
    threads: { enabled: threads, create: method('threads', 'create'), cancel: method('threads', 'cancel'), receipt: method('threads', 'receipt') },
    actionOf: (code) => G3_ACTIONS[code] ?? 'check',
  };
  const answer = (name, result, hold = false) => { (queues[name] ??= []).push({ value: result, hold }); };
  return { value, calls, answer, release: async () => { held.shift()(); await settle(); }, count: (name) => calls.filter((c) => c[0] === name).length };
}

const xAccount = (id = 'acc-x', over = {}) => ({ id, brandId: 'u_me', platform: 'x', connectionStatus: 'connected', profile: { handle: `@${id}`, displayName: id }, ...over });
const thAccount = (id = 'acc-th', over = {}) => ({ id, brandId: 'u_me', platform: 'threads', connectionStatus: 'connected', profile: { handle: `@${id}`, displayName: id }, ...over });

async function mount({ store = scriptedPorts(), accounts = [xAccount(), thAccount()], workspace = { kind: 'ready', workspaceId: 'u_me' }, token = jwt('user-A', S1), userId = 'user-A' } = {}) {
  const slots = []; let cursor = 0; const effects = []; const pendingEffects = [];
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return i; };
  const react = {
    useState: (initial) => { const i = slot(() => (typeof initial === 'function' ? initial() : initial)); return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => slots[slot(() => ({ current: initial }))],
    useEffect: (effect, deps) => {
      const i = cursor++;
      const previous = effects[i];
      if (!previous || !deps || deps.length !== previous.deps.length || deps.some((d, k) => !Object.is(d, previous.deps[k]))) pendingEffects.push({ i, effect, deps });
    },
  };
  const world = { token, userId, accounts, workspace, pushes: [], ports: store.value, ids: 0 };
  const stubs = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), jsxs: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), Fragment: 'Fragment' },
    'react-native': { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-router': { useRouter: () => ({ push: (href) => world.pushes.push(href) }) },
    '@/constants/theme': { colors: { primary: 'p', primarySoft: 'ps', surface: 's', border: 'b', ink: 'i' } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: {} } },
    '@/domain/service-enrollment': enrollment,
    '@/features/personal-workspace/personal-workspace-provider': { usePersonalWorkspace: () => ({ view: world.workspace, retry() {} }) },
    '@/features/reservations/reservation-ports': ports,
    '@/features/reservations/reservation-view': view,
    '@/features/reservations/use-reservation-ports': { useReservationPorts: () => world.ports, newClientRequestId: () => `cid-${++world.ids}`, contentSha256: async (text) => `sha256:${text}` },
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: world.accounts }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.token ? { access_token: world.token, user: { id: world.userId } } : null }) },
  };
  const source = await readFile(new URL('../src/app/reservations/index.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...args) { super(...(args.length ? args : [NOW.getTime()])); } static now() { return NOW.getTime(); } }
  vm.runInNewContext(js, { module: loaded, exports: loaded.exports, Promise, Date: FixedDate, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } });
  const renderOnce = () => {
    cursor = 0;
    const tree = loaded.exports.default();
    while (pendingEffects.length) {
      const { i, effect, deps } = pendingEffects.shift();
      effects[i]?.cleanup?.();
      effects[i] = { deps: deps ?? [], cleanup: effect() };
    }
    return tree;
  };
  const render = async () => { for (let i = 0; i < 4; i += 1) { renderOnce(); await settle(); } return renderOnce(); };
  return { world, store, render, renderOnce };
}
/** Mounted on the X tab (its list read answered empty), then switched to Threads. */
async function threadsScreen(store) {
  store.answer('x.list', { ok: true, value: [] });
  const h = await mount({ store });
  chip(await h.render(), 'Threads').onPress();
  return h;
}
const press = async (h, label, index = 0) => { const b = button(h.renderOnce(), label, index); assert.ok(b, `button ${label}`); assert.notEqual(b.disabled, true, `${label} enabled`); b.onPress(); await settle(); return h.render(); };
const open = async (h, label) => { rowPress(h.renderOnce(), label).onPress(); return h.render(); };

test('gates OFF (the real disabled ports): the reason is shown, nothing is offered, nothing is called, nothing reads 「予約済み」', async () => {
  const h = await mount({ store: { value: ports.DISABLED_RESERVATION_PORTS } });
  let tree = await h.render();
  assert.ok(has(tree, 'Xの予約の保存・変更・取消は、公開前の準備中のため、まだ使えません'));
  assert.equal(button(tree, '最新の状態を読み込む').disabled, true);
  assert.ok(!texts(tree).some((t) => t === '予約済み'));
  button(tree, '作成画面を開く').onPress();
  assert.deepEqual(h.world.pushes, ['/(tabs)/schedule'], 'X reservations are made in the existing composer');
  chip(tree, 'Threads').onPress();
  tree = await h.render();
  assert.ok(has(tree, 'Threadsの予約は、公開前の準備中のため'));
  assert.equal(button(tree, 'Threadsに予約する').disabled, true);
  field(tree, 'Threadsの本文').onChangeText('こんにちは');
  field(tree, 'Threadsの日時').onChangeText('2026-11-01 09:30');
  button(h.renderOnce(), 'Threadsに予約する').onPress(); // even if pressed: nothing is sent
  await settle();
  tree = await h.render();
  assert.ok(!texts(tree).some((t) => t.includes('予約しました')));
  assert.equal(h.world.ids, 0, 'no request id was even made');
});

test('X: the list as read; 「予約済み」 only for planned + confirmed; uncertain rows say "check X" and offer nothing', async () => {
  const store = scriptedPorts();
  store.answer('x.list', { ok: true, value: [row('b', { scheduledAt: '2026-11-03T00:00:00Z', status: 'uncertain' }), row('a'), row('c', { scheduledAt: '2026-11-04T00:00:00Z', consentState: 'needs_reconfirm' })] });
  const h = await mount({ store });
  let tree = await h.render();
  assert.deepEqual(store.calls, [['x.list', 'acc-x']]);
  assert.deepEqual(texts(tree).filter((t) => ['予約済み', 'Xで確認してください', '再確認が必要'].includes(t)), ['予約済み', 'Xで確認してください', '再確認が必要'], 'sorted by time');
  tree = await open(h, '予約 2026-11-03 09:00');
  assert.ok(has(tree, '自動で送り直すことはありません'));
  assert.equal(buttons(tree, '時刻を変更').length, 0); assert.equal(buttons(tree, '予約を取り消す').length, 0);
});

test('X reschedule → needs_reconfirm → 「再確認が必要」 → reconfirm with the body\'s SHA-256 and the revision last read → 「予約済み」', async () => {
  const store = scriptedPorts();
  store.answer('x.list', { ok: true, value: [row('a', { revision: 4 })] });
  const h = await mount({ store });
  await h.render();
  let tree = await open(h, '予約 2026-11-02 09:30');
  field(tree, '新しい日時').onChangeText('2026-11-05 10:00');
  store.answer('x.reschedule', { ok: true, value: row('a', { revision: 5, scheduledAt: '2026-11-05T01:00:00Z', consentState: 'needs_reconfirm' }) });
  tree = await press(h, '時刻を変更');
  assert.deepEqual(store.calls[1], ['x.reschedule', 'a', 4, '2026-11-05T10:00:00+09:00']);
  assert.ok(has(tree, '再確認が必要'));
  assert.ok(has(tree, '確認するまで投稿されません'));
  store.answer('x.reconfirm', { ok: true, value: row('a', { revision: 6, scheduledAt: '2026-11-05T01:00:00Z' }) });
  tree = await press(h, 'この本文で再確認する');
  assert.deepEqual(store.calls[2], ['x.reconfirm', 'a', 5, 'sha256:本文a']);
  assert.ok(texts(tree).includes('予約済み'));
  // an invalid time is refused before anything is sent
  field(tree, '新しい日時').onChangeText('来週');
  tree = await press(h, '時刻を変更');
  assert.ok(has(tree, '日時は「2026-11-01 09:30」の形で'));
  assert.equal(store.calls.length, 3);
});

test('X 409 stale / final / not found / unknown: one re-read, never the same write again; fix_input and 429 keep things as they are', async () => {
  for (const [code, reread, words] of [
    ['POSTONA_RESV_STALE_REVISION', true, '内容が更新されていました'], ['POSTONA_RESV_ALREADY_FINAL', true, 'すでに確定'],
    ['POSTONA_RESV_NOT_FOUND', true, '見つかりませんでした'], ['SOMETHING_NEW', true, '結果を確認できませんでした'],
    ['POSTONA_RESV_SLOT_CONFLICT', false, '時刻や本文を見直して'], ['RATE_LIMITED', false, '何も変更されていません'],
  ]) {
    const store = scriptedPorts();
    store.answer('x.list', { ok: true, value: [row('a')] });
    const h = await mount({ store });
    await h.render();
    let tree = await open(h, '予約 2026-11-02 09:30');
    field(tree, '新しい日時').onChangeText('2026-11-05 10:00');
    store.answer('x.reschedule', { ok: false, code });
    if (reread) store.answer('x.list', { ok: true, value: [row('a', { revision: 2 })] });
    tree = await press(h, '時刻を変更');
    assert.ok(has(tree, words), code);
    assert.equal(has(tree, '最新の状態を読み込みます'), reread, `${code}: says it reads only when it does`);
    assert.equal(store.count('x.list'), reread ? 2 : 1, code);
    assert.equal(store.count('x.reschedule'), 1, `${code}: never re-sent`);
    assert.ok(!texts(tree).some((t) => t.includes('時刻を変更しました')), code);
  }
});

test('X 401: "sign in again", no write and no read with that token; a new token reads again and the writes come back', async () => {
  const store = scriptedPorts();
  store.answer('x.list', { ok: true, value: [row('a')] });
  const h = await mount({ store });
  await h.render();
  let tree = await open(h, '予約 2026-11-02 09:30');
  store.answer('x.cancel', { ok: false, code: 'AUTH_REQUIRED' });
  await press(h, '予約を取り消す'); // first press asks to confirm
  tree = await press(h, '本当に取り消す');
  assert.ok(has(tree, 'ログインし直すまで予約を操作できません'));
  assert.equal(button(tree, '最新の状態を読み込む').disabled, true);
  assert.equal(button(tree, '予約を取り消す')?.disabled ?? true, true);
  button(tree, '設定画面を開く').onPress();
  assert.deepEqual(h.world.pushes, ['/(tabs)/settings']);
  await h.render();
  assert.equal(store.count('x.list'), 1, 'nothing more with the refused token');
  h.world.token = jwt('user-A', S1, 2); // refreshed
  store.answer('x.list', { ok: true, value: [row('a')] });
  tree = await h.render();
  assert.equal(store.count('x.list'), 2);
  assert.ok(!has(tree, 'ログインし直すまで'));
  assert.equal(button(tree, '最新の状態を読み込む').disabled, false);
});

test('X 403 service / X not verified: writes off with the way out (settings / accounts); reads still work and a good read clears it', async () => {
  for (const [code, label, href, words] of [
    ['POSTONA_RESV_SERVICE_NOT_ACTIVE', '設定画面を開く', '/(tabs)/settings', '利用登録が有効でない'],
    ['POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED', 'アカウント画面を開く', '/accounts', 'Xを接続し直して'],
  ]) {
    const store = scriptedPorts();
    store.answer('x.list', { ok: true, value: [row('a')] });
    const h = await mount({ store });
    await h.render();
    let tree = await open(h, '予約 2026-11-02 09:30');
    field(tree, '新しい日時').onChangeText('2026-11-05 10:00');
    store.answer('x.reschedule', { ok: false, code });
    tree = await press(h, '時刻を変更');
    assert.ok(has(tree, words), code);
    assert.equal(button(tree, '時刻を変更').disabled, true, `${code}: writes off`);
    buttons(tree, label).at(-1).onPress();
    assert.deepEqual(h.world.pushes, [href]);
    store.answer('x.list', { ok: true, value: [row('a')] });
    tree = await press(h, '最新の状態を読み込む');
    assert.equal(button(tree, '時刻を変更').disabled, false, `${code}: a good read clears it`);
    assert.equal(store.count('x.reschedule'), 1);
  }
});

test('X cancel asks twice; a double tap sends once; the revision last read is sent', async () => {
  const store = scriptedPorts();
  store.answer('x.list', { ok: true, value: [row('a', { revision: 7 })] });
  const h = await mount({ store });
  await h.render();
  await open(h, '予約 2026-11-02 09:30');
  let tree = await press(h, '予約を取り消す');
  assert.equal(store.count('x.cancel'), 0, 'first press only asks');
  store.answer('x.cancel', { ok: true, value: row('a', { revision: 8, status: 'cancelled' }) }, true);
  const confirm = button(tree, '本当に取り消す');
  confirm.onPress(); confirm.onPress(); // double tap before any re-render
  await settle();
  assert.equal(store.count('x.cancel'), 1);
  assert.deepEqual(store.calls.find((c) => c[0] === 'x.cancel'), ['x.cancel', 'a', 7]);
  await store.release();
  tree = await h.render();
  assert.ok(texts(tree).includes('取消済み'));
  assert.ok(has(tree, '予約を取り消しました'));
});

test('another account / person / login while an edit is out: its answer and its notice reach nobody else', async () => {
  const store = scriptedPorts();
  store.answer('x.list', { ok: true, value: [row('a')] });
  const accounts = [xAccount('acc-1'), xAccount('acc-2')];
  const h = await mount({ store, accounts });
  await h.render();
  let tree = await open(h, '予約 2026-11-02 09:30');
  field(tree, '新しい日時').onChangeText('2026-11-05 10:00');
  store.answer('x.reschedule', { ok: true, value: row('a', { revision: 2, consentState: 'needs_reconfirm' }) }, true);
  button(h.renderOnce(), '時刻を変更').onPress();
  await settle();
  store.answer('x.list', { ok: true, value: [row('z')] });
  chip(h.renderOnce(), '@acc-2').onPress(); // switch the account while the edit is out
  tree = await h.render();
  assert.deepEqual(store.calls.at(-1), ['x.list', 'acc-2']);
  await store.release();
  tree = await h.render();
  assert.ok(!has(tree, '時刻を変更しました'), 'the old account\'s notice is not shown here');
  assert.ok(!texts(tree).includes('再確認が必要'), 'the old account\'s row is not shown here');
  // another person: the list is read for them, with their own scope
  store.answer('x.list', { ok: true, value: [] });
  h.world.userId = 'user-B'; h.world.token = jwt('user-B', S2);
  h.world.accounts = [xAccount('acc-b')];
  tree = await h.render();
  assert.deepEqual(store.calls.at(-1), ['x.list', 'acc-b']);
  assert.ok(has(tree, 'このアカウントの予約はありません'));
  // signed out: nothing is read or offered
  h.world.token = null; h.world.userId = null;
  tree = await h.render();
  assert.ok(has(tree, 'ログインが確認できないため'));
  assert.equal(button(tree, '最新の状態を読み込む').disabled, true);
});

test('switching accounts: the old account\'s rows and notices are not shown, and its late refusal neither re-reads nor blocks the new one', async () => {
  const store = scriptedPorts();
  store.answer('x.list', { ok: true, value: [row('a')] });
  const h = await mount({ store, accounts: [xAccount('acc-1'), xAccount('acc-2')] });
  await h.render();
  await open(h, '予約 2026-11-02 09:30');
  await press(h, '予約を取り消す');
  store.answer('x.cancel', { ok: true, value: row('a', { revision: 2, status: 'cancelled' }) });
  let tree = await press(h, '本当に取り消す');
  assert.ok(has(tree, '予約を取り消しました'));
  store.answer('x.list', { ok: true, value: [] }, true);
  chip(h.renderOnce(), '@acc-2').onPress();
  tree = await h.render();
  assert.ok(!has(tree, '予約を取り消しました'), 'acc-1\'s notice is not acc-2\'s');
  assert.equal(rowPress(tree, '予約 2026-11-02 09:30'), undefined, 'acc-1\'s rows are not shown while acc-2 is read');
  await store.release();
  tree = await h.render();
  assert.ok(has(tree, 'このアカウントの予約はありません'));
  // back to acc-1: a reschedule is out when the person switches to acc-2; it is refused late (stale revision)
  store.answer('x.list', { ok: true, value: [row('b')] });
  chip(h.renderOnce(), '@acc-1').onPress();
  tree = await h.render();
  tree = await open(h, '予約 2026-11-02 09:30');
  field(tree, '新しい日時').onChangeText('2026-11-05 10:00');
  store.answer('x.reschedule', { ok: false, code: 'POSTONA_RESV_STALE_REVISION' }, true);
  button(h.renderOnce(), '時刻を変更').onPress();
  await settle();
  store.answer('x.list', { ok: true, value: [] });
  chip(h.renderOnce(), '@acc-2').onPress();
  await h.render();
  const lists = store.count('x.list');
  await store.release();
  tree = await h.render();
  assert.equal(store.count('x.list'), lists, 'no re-read was triggered by another account\'s answer');
  assert.ok(!has(tree, '内容が更新されていました'));
  assert.equal(button(tree, '最新の状態を読み込む').disabled, false);
});

test('fail-closed before any request: another workspace\'s account, W0 not ready, a disconnected account, no account', async () => {
  for (const [options, words] of [
    [{ accounts: [xAccount('acc-s', { brandId: 'shared-brand' })] }, '個人ワークスペースのアカウントだけ'],
    [{ workspace: { kind: 'preparing' } }, '個人ワークスペースのアカウントだけ'],
    [{ workspace: { kind: 'unconfirmed' } }, '個人ワークスペースのアカウントだけ'],
    [{ accounts: [xAccount('acc-n', { connectionStatus: 'needs_attention' })] }, '接続し直してください'],
    [{ accounts: [] }, 'まだ接続されていません'],
  ]) {
    const store = scriptedPorts();
    const h = await mount({ store, ...options });
    const tree = await h.render();
    assert.ok(has(tree, words), words);
    assert.equal(store.calls.length, 0, words);
    assert.equal(button(tree, '最新の状態を読み込む').disabled, true, words);
    button(tree, 'アカウント画面を開く').onPress();
    assert.deepEqual(h.world.pushes, ['/accounts']);
  }
});

test('Threads create: saved only with a pending receipt; one press = one new request id; the text and time go as typed', async () => {
  const store = scriptedPorts();
  const h = await threadsScreen(store);
  let tree = await h.render();
  field(tree, 'Threadsの本文').onChangeText('  新メニューのお知らせ  ');
  field(tree, 'Threadsの日時').onChangeText('2026-11-01 09:30');
  store.answer('threads.create', { kind: 'saved', receipt: receipt('pending') }, true);
  const create = button(h.renderOnce(), 'Threadsに予約する');
  create.onPress(); create.onPress(); // double tap
  await settle();
  assert.equal(store.count('threads.create'), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(store.calls[1])), ['threads.create', { socialAccountId: 'acc-th', clientRequestId: 'cid-1', text: '新メニューのお知らせ', contentSha256: 'sha256:新メニューのお知らせ', scheduledAt: '2026-11-01T09:30:00+09:00' }]);
  await store.release();
  tree = await h.render();
  assert.ok(texts(tree).includes('予約済み'));
  assert.ok(has(tree, '予約しました（受領票で確認済み）'));
  // a second create is a new request with a new id
  field(tree, 'Threadsの本文').onChangeText('二件目');
  field(tree, 'Threadsの日時').onChangeText('2026-11-02 09:30');
  store.answer('threads.create', { kind: 'saved', receipt: receipt('pending', { reservationId: 'th-2' }) });
  tree = await press(h, 'Threadsに予約する');
  assert.equal(store.calls.at(-1)[1].clientRequestId, 'cid-2');
  assert.equal(texts(tree).filter((t) => t === '予約済み').length, 2);
  assert.equal(field(tree, 'Threadsの本文').value, '', 'the form is cleared after a saved create');
  // cancel asks twice, with the receipt's reservation id and the same request id
  await press(h, '予約を取り消す', 0);
  store.answer('threads.cancel', { ok: true, value: receipt('cancelled') });
  tree = await press(h, '本当に取り消す');
  assert.deepEqual(store.calls.at(-1), ['threads.cancel', 'th-1', 'acc-th', 'cid-1']);
  assert.ok(texts(tree).includes('取消済み'));
});

test('Threads create uncertain: kept to read its receipt, never created again; an uncertain receipt says "check Threads"', async () => {
  const store = scriptedPorts();
  const h = await threadsScreen(store);
  let tree = await h.render();
  field(tree, 'Threadsの本文').onChangeText('本文');
  field(tree, 'Threadsの日時').onChangeText('2026-11-01 09:30');
  store.answer('threads.create', { kind: 'uncertain', code: 'UNCERTAIN' });
  tree = await press(h, 'Threadsに予約する');
  assert.ok(has(tree, '同じ予約を作り直すことはありません'));
  assert.ok(texts(tree).includes('受領票を確認中'));
  assert.equal(field(tree, 'Threadsの本文').value, '本文', 'the typed text stays');
  store.answer('threads.receipt', { ok: true, value: receipt('uncertain') });
  tree = await press(h, '受領票を確認');
  assert.deepEqual(store.calls.at(-1), ['threads.receipt', 'acc-th', 'cid-1']);
  assert.ok(texts(tree).includes('Threadsで確認してください'));
  assert.equal(buttons(tree, '予約を取り消す').length, 0);
  assert.equal(store.count('threads.create'), 1, 'never re-created');
  // a receipt that reads not found: nothing was stored
  store.answer('threads.receipt', { ok: false, code: 'POSTONA_THREADS_RESV_NOT_FOUND' });
  tree = await press(h, '受領票を確認');
  assert.ok(texts(tree).includes('予約は見つかりませんでした'));
  assert.equal(store.count('threads.receipt'), 2, 'a read is not followed by another read');
});

test('Threads refusals: U8 publish disabled → not available (writes off, receipts readable); fix_input keeps the form; 401 → sign in', async () => {
  const store = scriptedPorts();
  const h = await threadsScreen(store);
  let tree = await h.render();
  field(tree, 'Threadsの本文').onChangeText('本文');
  field(tree, 'Threadsの日時').onChangeText('2026-11-01 09:30');
  store.answer('threads.create', { kind: 'failed', code: 'POSTONA_THREADS_RESV_TEXT_INVALID' });
  tree = await press(h, 'Threadsに予約する');
  assert.ok(has(tree, '時刻や本文を見直して'));
  assert.equal(field(tree, 'Threadsの本文').value, '本文');
  assert.equal(buttons(tree, '受領票を確認').length, 0, 'nothing was written, nothing is kept');
  store.answer('threads.create', { kind: 'failed', code: 'POSTONA_THREADS_RESV_PUBLISH_DISABLED' });
  tree = await press(h, 'Threadsに予約する');
  assert.ok(has(tree, 'Threadsの予約は、いまは使えません'));
  assert.equal(button(tree, 'Threadsに予約する').disabled, true);
  const signIn = scriptedPorts();
  const s = await threadsScreen(signIn);
  tree = await s.render();
  field(tree, 'Threadsの本文').onChangeText('本文');
  field(tree, 'Threadsの日時').onChangeText('2026-11-01 09:30');
  signIn.answer('threads.create', { kind: 'failed', code: 'AUTH_REQUIRED' });
  tree = await press(s, 'Threadsに予約する');
  assert.ok(has(tree, 'ログインし直すまで予約を操作できません'));
  assert.equal(button(tree, 'Threadsに予約する').disabled, true);
  const reconnect = scriptedPorts();
  const r = await threadsScreen(reconnect);
  tree = await r.render();
  field(tree, 'Threadsの本文').onChangeText('本文');
  field(tree, 'Threadsの日時').onChangeText('2026-11-01 09:30');
  reconnect.answer('threads.create', { kind: 'failed', code: 'POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED' });
  tree = await press(r, 'Threadsに予約する');
  assert.ok(has(tree, 'Threadsアカウントの接続を確認できない'));
  buttons(tree, 'アカウント画面を開く').at(-1).onPress();
  assert.deepEqual(r.world.pushes, ['/accounts']);
});

// ---------------------------------------------------------------------------------------------------------------
// Wiring and boundary (source).

const read = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');

test('navigation: home → /reservations; the route is registered in the stack; the composer stays where X reservations are made', async () => {
  const home = await read('app/(tabs)/index.tsx');
  assert.match(home, /<Link href="\/reservations" asChild>\s*<ActionButton label="X・Threadsの予約を管理"/u);
  const layout = await read('app/_layout.tsx');
  assert.match(layout, /<Stack\.Screen name="reservations\/index" options=\{\{ headerShown: true, title: '予約の管理' \}\} \/>/u);
  const screen = await read('app/reservations/index.tsx');
  assert.match(screen, /router\.push\('\/\(tabs\)\/schedule'\)/u);
});

test('boundary: the screen reaches the stores only through use-reservation-ports (the disabled ports); no G3 file, no network, no storage, no post', async () => {
  const screen = code(await read('app/reservations/index.tsx'));
  const hook = code(await read('features/reservations/use-reservation-ports.ts'));
  const contract = code(await read('features/reservations/reservation-ports.ts'));
  const rules = code(await read('features/reservations/reservation-view.ts'));
  const importsOf = (source) => [...source.matchAll(/from ['"]([^'"]+)['"]/gu)].map((m) => m[1]).sort();
  assert.deepEqual(importsOf(screen), ['@/components/ui', '@/constants/theme', '@/domain/service-enrollment', '@/features/personal-workspace/personal-workspace-provider',
    '@/features/reservations/reservation-ports', '@/features/reservations/reservation-view', '@/features/reservations/use-reservation-ports',
    '@/providers/active-account-provider', '@/providers/auth-provider', 'expo-router', 'react', 'react-native']);
  assert.deepEqual(importsOf(hook), ['@/features/reservations/reservation-ports', 'expo-crypto']);
  assert.deepEqual(importsOf(contract), []);
  assert.deepEqual(importsOf(rules), ['./reservation-ports.ts']);
  assert.match(hook, /return DISABLED_RESERVATION_PORTS;/u);
  for (const [name, text] of [['screen', screen], ['hook', hook], ['contract', contract], ['rules', rules]]) {
    assert.doesNotMatch(text, /features\/schedule\/|reservation-store|reservation-error-actions/u, `${name}: no G3 file`);
    assert.doesNotMatch(text, /fetch\(|supabase|functions\.invoke|\.rpc\(|\.from\(|AsyncStorage|SecureStore|localStorage|console\./u, `${name}: no network / storage / log`);
    assert.doesNotMatch(text, /publish\w*\(|manual-publish|start_x_autopost_service|x-oauth|oauth_state/iu, `${name}: no post, no service start, no OAuth`);
  }
});
