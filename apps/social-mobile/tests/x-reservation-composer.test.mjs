// G1 TASK 32: the X new-reservation flow on the REAL schedule.tsx (transpiled, stubbed React / RN), with the REAL write guard, the
// REAL buildSaveRequest and G3's REAL X store over a scripted fetch, plus the connection display after a server's reconnect refusal.
// The gate is turned on by an argument in this file only. "saved" proves the screen and the wiring, not that a real server adopted
// anything. Nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as scheduleView from '../src/domain/schedule-view.ts';
import * as planner from '../src/domain/schedule-planner.ts';
import * as dataView from '../src/domain/data-view.ts';
import * as contentSettings from '../src/domain/content-settings.ts';
import * as reservationFlow from '../src/domain/reservation-flow.ts';
import * as enrollment from '../src/domain/service-enrollment.ts';
import * as reservationStore from '../src/features/schedule/reservation-store.ts';
import { reservationErrorAction } from '../src/features/schedule/reservation-error-actions.ts';
import * as confirmationState from '../src/features/schedule/confirmation-state.ts';
import * as timeEdit from '../src/features/schedule/time-edit.ts';
import * as scheduleLabels from '../src/features/schedule/schedule-labels.ts';
import * as serverState from '../src/features/schedule/server-reservations-state.ts';
import * as reservationView from '../src/features/reservations/reservation-view.ts';
import * as xWriteView from '../src/features/reservations/x-write-view.ts';
import * as signal from '../src/features/reservations/x-reconnect-signal.ts';

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
test.beforeEach(() => { signal.clearAllXReconnectRequired(); signal.clearXServiceRestarted('person-1'); signal.forgetXReconnectedAfterRestart('person-1'); });

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
};
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const textOf = (tree) => { const out = []; walk(tree, (n) => { for (const c of [n.props?.children].flat()) if (typeof c === 'string' || typeof c === 'number') out.push(String(c)); }); return out.join('\n'); };
const labelled = (tree, type, label) => { let hit = null; walk(tree, (n) => { if (n.type === type && n.props.label === label) hit = n.props; }); return hit; };
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const jwt = (sub, sid, n = 1) => { const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); return `${part({ alg: 'none' })}.${part({ sub, session_id: sid, n })}.x`; };

const ME = 'u_me';
const held2 = new Promise(() => {});
const ACCOUNT = { id: '11111111-1111-4111-8111-111111111111', brandId: ME, platform: 'x', profile: { displayName: 'me', handle: '@me', avatarColor: '#000' }, connectionStatus: 'connected', postingState: 'active' };
const OTHER_ACCOUNT = { ...ACCOUNT, id: '44444444-4444-4444-8444-444444444444' };

/**
 * The real schedule screen. `gate`: G3's store is built by G3's factory with this argument; the live deps are the ones the screen
 * assembles. `reply(call)` answers each fetch.
 */
async function screen({ gate = true, reply = null, account = ACCOUNT, workspaceId = ME } = {}) {
  const slots = []; let cursor = 0; const effects = [];
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return i; };
  const react = {
    useState: (initial) => { const i = slot(() => (typeof initial === 'function' ? initial() : initial)); return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => slots[slot(() => ({ current: initial }))],
    useMemo: (factory) => slots[slot(factory)],
    useEffect: (effect, deps) => {
      const i = cursor++;
      const changed = !(i in slots) || !deps || deps.length !== slots[i].length || deps.some((d, k) => !Object.is(d, slots[i][k]));
      if (changed) { slots[i] = deps ?? []; effects.push(effect); }
    },
  };
  const world = { account, workspaceId, token: jwt('person-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'), userId: 'person-1', calls: [], pushes: [], sessionReads: 0, refocus: 0 };
  const client = { auth: { getSession: async () => { world.sessionReads += 1; return { data: { session: world.token ? { access_token: world.token, user: { id: world.userId } } : null }, error: null }; } } };
  const fetchImpl = async (url, init) => {
    const call = { url: String(url), body: init?.body ? JSON.parse(init.body) : null, token: init?.headers?.authorization ?? null, apikey: init?.headers?.apikey ?? null };
    world.calls.push(call);
    const answer = reply ? await reply(call, world) : { status: 200, json: { ok: true, reservations: [] } };
    if (answer === 'lost') throw new Error('network lost');
    return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status, headers: { 'content-type': 'application/json' } });
  };
  class Repository { read() { return Promise.resolve({ state: 'ready', data: contentSettings.SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, updatedAt: null }); } }
  const guardStubs = {
    react: { ...react },
    '@/domain/service-enrollment': enrollment,
    '@/features/personal-workspace/personal-workspace-provider': { usePersonalWorkspace: () => ({ view: world.workspaceId ? { kind: 'ready', workspaceId: world.workspaceId } : { kind: 'loading' } }) },
    '@/features/reservations/x-reconnect-signal': { ...signal, useXReconnectSignal: () => 0 },
    '@/features/reservations/x-write-view': xWriteView,
    '@/providers/auth-provider': { useAuth: () => ({ session: world.token ? { access_token: world.token, user: { id: world.userId } } : null }) },
  };
  const load = async (rel, stubs) => {
    const source = await readFile(new URL(rel, import.meta.url), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const loaded = { exports: {} };
    vm.runInNewContext(js, { module: loaded, exports: loaded.exports, Promise, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: rel });
    return loaded.exports;
  };
  const guard = await load('../src/features/reservations/use-x-write-guard.ts', guardStubs);
  const stubs = {
    'expo-router': { useRouter: () => ({ push: (href) => world.pushes.push(href) }) },
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), jsxs: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), Fragment: 'Fragment' },
    'react-native': { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    '@/constants/theme': { colors: { primary: 'p', primarySoft: 'ps', surface: 's', border: 'b', ink: 'i', danger: 'd' } },
    '@/components/sign-out-button': { SignOutButton: 'SignOutButton' },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', EmptyState: 'EmptyState', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: {}, buttonPressed: {} } },
    '@/data/mock-repository': { mockRepository: { getPlannedPosts: () => [], getAccounts: () => [world.account] } },
    '@/data/content-settings-repository': { SupabaseContentSettingsRepository: Repository },
    '@/lib/supabase': { supabase: client, getSupabaseConfig: () => ({ ok: true, config: { url: 'https://example.invalid', publishableKey: 'sb_publishable_testkey01' } }) },
    '@/domain/data-view': dataView,
    '@/domain/schedule-view': scheduleView,
    '@/domain/schedule-planner': planner,
    '@/domain/types': {},
    '@/domain/reservation-flow': reservationFlow,
    '@/features/reservations/reservation-view': reservationView,
    '@/features/reservations/use-refocus-count': { useRefocusCount: () => world.refocus },
    '@/features/reservations/use-x-write-guard': guard,
    '@/features/reservations/x-reconnect-signal': signal,
    '@/features/reservations/x-write-view': xWriteView,
    '@/features/schedule/schedule-composer': { ScheduleComposer: function ScheduleComposer(props) { return { type: 'ScheduleComposer', props }; }, SmallButton: 'SmallButton' },
    '@/features/schedule/reservation-error-actions': { reservationErrorAction },
    '@/features/schedule/reservation-store': {
      ...reservationStore,
      // G3's real factory with the gate of this test, on a real live store whose fetch is scripted.
      createReservationStore: (_constant, live) => reservationStore.createReservationStore(gate, live ? { ...live, fetch: fetchImpl } : null),
    },
    '@/features/schedule/server-reservations-state': serverState,
    '@/features/schedule/server-reservation-card': { ServerReservationCard: function ServerReservationCard(props) { return { type: 'ServerReservationCard', props }; } },
    '@/features/schedule/confirmation-state': confirmationState,
    '@/features/schedule/time-edit': timeEdit,
    '@/features/schedule/schedule-labels': scheduleLabels,
    '@/features/schedule/preview-card': { PreviewCard: function PreviewCard(props) { return { type: 'PreviewCard', props }; } },
    '@/features/schedule/sha256': { sha256Hex: async (text) => sha(text) },
    '@/providers/active-account-provider': { useActiveAccount: () => ({ activeAccount: world.account, accounts: world.account ? [world.account] : [] }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: 'ready', reason: null, snapshot: { workspace: { id: world.workspaceId }, accounts: world.account ? [world.account] : [], plannedPosts: [] } }) },
  };
  // The guard's hooks share the screen's slots.
  guardStubs.react.useState = react.useState;
  const screenModule = await load('../src/app/(tabs)/schedule.tsx', stubs);
  const render = () => { cursor = 0; return screenModule.default({}); };
  const flush = async () => {
    for (let round = 0; round < 5; round += 1) {
      effects.splice(0).forEach((effect) => effect());
      render();
      await settle();
    }
  };
  render();
  await flush();
  const update = async () => { render(); await flush(); return render(); };
  return { world, render, update, flush };
}

async function planOne(h, text = 'hello', batchId = 'f0e2b1a4-0000-4000-8000-000000000001') {
  labelled(h.render(), 'ActionButton', '投稿を作成').onPress();
  let composer = null;
  walk(h.render(), (n) => { if (n.type === 'ScheduleComposer') composer = n.props; });
  assert.ok(composer, 'the composer opens on the press');
  const day = new Date(Date.now() + 5 * 864e5 + 9 * 36e5).toISOString().slice(0, 10);
  const planned = planner.planBatch({ mode: 'manual_exact', posts: [{ text, date: day, time: '09:30' }] }, { ...composer.context, batchId });
  assert.equal(planned.ok, true, JSON.stringify(planned.issues ?? []));
  composer.onPlanned(planned);
  await h.update();
}
async function confirmAll(h) {
  const cards = []; walk(h.render(), (n) => { if (n.type === 'PreviewCard') cards.push(n.props); });
  for (const card of cards) { card.onConfirm(); await settle(); }
  await h.update();
}
const saveButton = (h) => labelled(h.render(), 'SmallButton', 'サーバーに保存');
async function pressSave(h) { saveButton(h).onPress(); await settle(); await h.update(); }

test('gate OFF (G3\'s constant): plan, confirm, the save stays 準備中; no store call, no token read, no fetch, no 「予約済み」; the list is one press away', async () => {
  assert.equal(reservationStore.POSTONA_RESERVATION_PERSISTENCE_ENABLED, false);
  const h = await screen({ gate: reservationStore.POSTONA_RESERVATION_PERSISTENCE_ENABLED });
  await planOne(h);
  await confirmAll(h);
  const tree = h.render();
  assert.equal(labelled(tree, 'ActionButton', '予約として保存（準備中）').disabled, true);
  assert.equal(saveButton(h), null);
  assert.deepEqual([h.world.calls.length, h.world.sessionReads], [0, 0]);
  assert.doesNotMatch(textOf(tree), /予約済み/u);
  labelled(tree, 'ActionButton', '予約の管理を開く').onPress();
  assert.deepEqual(h.world.pushes, ['/reservations']);
});

test('nothing is sent before the press: planning and confirming send no write; the save needs every post confirmed', async () => {
  const h = await screen();
  const before = h.world.calls.length;
  await planOne(h);
  assert.equal(saveButton(h).disabled, true, 'unconfirmed');
  await confirmAll(h);
  assert.equal(saveButton(h).disabled, false);
  assert.equal(h.world.calls.length, before, 'no call until the person presses');
});

const ok = (rows) => ({ status: 200, json: { ok: true, reservations: rows } });
const no = (status, code) => ({ status, json: { ok: false, code } });
/** A tiny server for the store's calls: `script[action]` may answer one call first (return nothing to fall through). */
function server(script = {}) {
  const rows = [];
  const reply = async (call, world) => {
    const { action, payload } = call.body;
    const scripted = script[action]?.(call, world);
    if (scripted) return scripted;
    if (action === 'create') {
      for (const item of payload.items) rows.push({ reservationId: `r-${rows.length + 1}`, batchId: payload.clientBatchId, draftId: item.draft_id, scheduledAt: item.scheduled_at, status: 'planned', revision: 1, consentState: item.body !== undefined ? 'confirmed' : 'ai_owner_opt_in', body: item.body ?? null, mode: payload.mode, origin: 'user_authored' });
      return ok(rows);
    }
    if (action === 'get') return ok(rows.filter((row) => row.reservationId === payload.reservationId));
    return ok(rows);
  };
  return { rows, reply };
}
const ofAction = (h, action) => h.world.calls.filter((c) => c.body?.action === action);
const onScreen = (h) => textOf(h.render());
async function ready(script, options = {}) {
  const s = server(script);
  const h = await screen({ reply: s.reply, ...options });
  await planOne(h);
  await confirmAll(h);
  return { h, s };
}

test('saved: the exact confirmed text goes to the real function with the person\'s token and the public key; the store\'s read-back decides; the list is read again', async () => {
  const { h, s } = await ready();
  await pressSave(h);
  const [create] = ofAction(h, 'create');
  assert.ok(create.url.endsWith('/functions/v1/postona-x-reservations'));
  assert.equal(create.token, `Bearer ${h.world.token}`);
  assert.equal(create.apikey, 'sb_publishable_testkey01');
  assert.equal(create.body.payload.socialAccountId, ACCOUNT.id);
  assert.deepEqual(create.body.payload.items.map((item) => [item.body, item.consent.confirmed, item.consent.content_sha256]), [['hello', true, sha('hello')]]);
  assert.match(onScreen(h), /サーバーに保存し、読み戻して一致を確認しました/u);
  assert.equal(s.rows.length, 1);
  let cards = 0; walk(h.render(), (n) => { if (n.type === 'ServerReservationCard') cards += 1; });
  assert.equal(cards, 1, 'the row as read back');
  assert.ok(ofAction(h, 'list').length >= 3, 'entry + read-back + a fresh list');
  assert.equal(ofAction(h, 'create').length, 1);
});

test('uncertain: the write\'s answer is lost, the read-back cannot confirm: not saved, the list is read again, and 保存状況を確認 re-sends the SAME request', async () => {
  let lost = true;
  const { h } = await ready({ create: () => (lost ? 'lost' : undefined), list: () => (lost ? 'lost' : undefined) });
  const readsBefore = ofAction(h, 'list').length;
  await pressSave(h);
  assert.match(onScreen(h), /保存できたかを確認できません（未確定）/u);
  assert.doesNotMatch(onScreen(h), /一致を確認しました/u);
  assert.equal(ofAction(h, 'list').length - readsBefore, 2, 'the store\'s read-back + the list read again');
  const first = ofAction(h, 'create')[0].body.payload;
  assert.equal(labelled(h.render(), 'SmallButton', 'サーバーに保存'), null, 'no fresh save is offered');
  lost = false;
  labelled(h.render(), 'SmallButton', '保存状況を確認').onPress();
  await settle(); await h.update();
  assert.deepEqual(ofAction(h, 'create')[1].body.payload, first, 'the same idempotency key and content');
  assert.match(onScreen(h), /一致を確認しました/u);
});

test('401: sign in again; no further call with that token, not even a read; a new token reads and the save comes back', async () => {
  const { h } = await ready({ create: () => no(401, 'POSTONA_RESV_AUTH_REQUIRED') });
  const readsBefore = ofAction(h, 'list').length;
  await pressSave(h);
  assert.equal(ofAction(h, 'list').length, readsBefore, 'no read with the refused token');
  assert.match(onScreen(h), /ログインを確認できませんでした|ログインの有効期限が切れた/u);
  assert.equal(saveButton(h).disabled, true);
  labelled(h.render(), 'ActionButton', '設定画面を開く').onPress();
  assert.deepEqual(h.world.pushes, ['/(tabs)/settings']);
  const before = h.world.calls.length;
  await h.update();
  assert.equal(h.world.calls.length, before, 'nothing more with the refused token');
  saveButton(h).onPress();
  await settle();
  assert.equal(ofAction(h, 'create').length, 1, 'a stale press sends nothing');
  h.world.token = jwt('person-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 2); // refreshed: the same login, another token
  await h.update();
  assert.equal(saveButton(h).disabled, false, 'the refusal was for that token only');
  h.world.token = jwt('person-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2');
  await h.update();
  assert.ok(h.world.calls.length > before, 'the new login reads');
  assert.equal(saveButton(h).disabled, false);
});

test('a 401 on the list: 読み込み直す sends nothing with that token', async () => {
  const s = server({ list: () => no(401, 'POSTONA_RESV_AUTH_REQUIRED') });
  const h = await screen({ reply: s.reply });
  await h.update();
  const before = h.world.calls.length;
  labelled(h.render(), 'SmallButton', '読み込み直す').onPress();
  await settle();
  assert.equal(h.world.calls.length, before);
});

test('403 service not active: writes off with the way to settings; a new login turns them back on', async () => {
  const { h } = await ready({ create: () => no(403, 'POSTONA_RESV_SERVICE_NOT_ACTIVE') });
  await pressSave(h);
  assert.match(onScreen(h), /利用登録が有効ではないため/u);
  assert.equal(saveButton(h).disabled, true);
  assert.ok(labelled(h.render(), 'ActionButton', '設定画面を開く'));
  assert.equal(signal.isXReconnectRequired(ACCOUNT.id), false, 'a service refusal says nothing about the X connection');
  h.world.token = jwt('person-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2');
  await h.update();
  assert.equal(saveButton(h).disabled, false);
});

test('403 X not verified: 「再接続が必要」; writes stay off (a read does not undo it) until a new connect; the way to the accounts screen', async () => {
  const { h } = await ready({ create: () => no(403, 'POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED') });
  await pressSave(h);
  assert.match(onScreen(h), /Xの再接続が必要です/u);
  assert.equal(signal.isXReconnectRequired(ACCOUNT.id), true);
  assert.equal(saveButton(h).disabled, true);
  labelled(h.render(), 'ActionButton', 'アカウント画面を開く').onPress();
  assert.deepEqual(h.world.pushes, ['/accounts']);
  await h.update();
  assert.equal(saveButton(h).disabled, true, 'still off');
  assert.equal(ofAction(h, 'create').length, 1);
  signal.clearAllXReconnectRequired();
  await h.update();
  assert.equal(saveButton(h).disabled, false, 'the connect screen clears it');
});

test('409: a changed batch re-reads once and never re-sends; a slot conflict is the person\'s to fix; 422 too; 429 changes nothing and reads nothing', async () => {
  for (const [status, code, words, rereads] of [
    [409, 'POSTONA_RESV_IDEMPOTENCY_CONFLICT', /同じ保存が別の内容で/u, 1],
    [409, 'POSTONA_RESV_SLOT_CONFLICT', /近い時刻にほかの予約があります/u, 0],
    [422, 'POSTONA_RESV_TIME_OUT_OF_RANGE', /日時は5分以上先/u, 0],
    [429, 'RATE', /何も変更されていません/u, 0],
  ]) {
    signal.clearAllXReconnectRequired();
    const { h } = await ready({ create: () => no(status, code) });
    const reads = ofAction(h, 'list').length;
    await pressSave(h);
    assert.match(onScreen(h), words, code);
    assert.equal(ofAction(h, 'create').length, 1, `${code}: sent once`);
    assert.equal(ofAction(h, 'list').length - reads, rereads, `${code}: re-reads`);
    assert.doesNotMatch(onScreen(h), /一致を確認しました/u, code);
    let cards = 0; walk(h.render(), (n) => { if (n.type === 'PreviewCard') cards += 1; });
    assert.equal(cards, 1, `${code}: the preview is kept to fix`);
    assert.equal(saveButton(h).disabled, false, `${code}: not blocked`);
  }
});

test('a double press sends one save', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; });
  const { h } = await ready({ create: () => held.then(() => ok([])) });
  const press = saveButton(h).onPress;
  press(); press();
  await settle();
  assert.equal(ofAction(h, 'create').length, 1);
  release();
  await settle();
});

test('another login / account while a save is out: its answer reaches nobody else, and the new screen does not read the old account', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; });
  const { h } = await ready({ create: () => held.then(() => no(403, 'POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED')) });
  saveButton(h).onPress();
  await settle();
  const other = { ...ACCOUNT, id: '22222222-2222-4222-8222-222222222222' };
  h.world.account = other;
  await h.update();
  release();
  await settle(); await h.update();
  assert.equal(signal.isXReconnectRequired(ACCOUNT.id), true, 'the server\'s answer about the old account is still recorded');
  assert.equal(signal.isXReconnectRequired(other.id), false);
  assert.doesNotMatch(onScreen(h), /Xの再接続が必要です/u, 'its words are not shown on the other account');
});

test('T33 real-tap finding: confirming removes the notice it made out of date; the header back label is not the route group', async () => {
  const h = await screen({});
  await planOne(h);
  assert.match(onScreen(h), /プレビューを作りました/u);
  await confirmAll(h);
  assert.doesNotMatch(onScreen(h), /プレビューを作りました/u);
  const layout = await readFile(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /headerBackTitle: '戻る'/u);
});

const emptyTitles = (h) => { const out = []; walk(h.render(), (n) => { if (n.type === 'EmptyState') out.push(n.props.title); }); return out; };
const ROW = { reservationId: 'k', batchId: 'b', draftId: 'd2', scheduledAt: '2026-12-01T00:30:00.000Z', status: 'planned', revision: 1, consentState: 'confirmed', body: 'x', mode: 'manual_exact', origin: 'user_authored' };

const DISCONNECTED = { ...ACCOUNT, connectionStatus: 'needs_attention' };
test('T35 disconnected: the rows are read and shown, new saves and time changes stop before a request, a cancel still goes (two presses), and its success says nothing about the connection', async () => {
  const seen = [];
  let current = ROW;
  const h = await screen({ account: DISCONNECTED, reply: async (call) => {
    seen.push(call.body.action);
    if (call.body.action === 'cancel') current = { ...ROW, status: 'cancelled', revision: 2 };
    return ok([current]);
  } });
  await h.update();
  assert.match(onScreen(h), /既存の予約の確認と取消はできます/u);
  signal.markXReconnectRequired(DISCONNECTED.id);
  await h.update();
  assert.deepEqual(seen, ['list']);
  const cards = () => { const out = []; walk(h.render(), (n) => { if (n.type === 'ServerReservationCard') out.push(n.props); }); return out; };
  assert.equal(cards().length, 1);
  assert.deepEqual(emptyTitles(h), []);
  cards()[0].onRetime(); await h.update();
  cards()[0].onRetimeApply(); await settle(); await h.update();
  assert.equal(seen.includes('reschedule'), false, 'a time change stops before a request');
  cards()[0].onCancel(); await h.update();
  cards()[0].onCancel(); await settle(); await h.update();
  assert.deepEqual(seen.filter((a) => a === 'cancel'), ['cancel']);
  assert.equal(signal.isXReconnectRequired(DISCONNECTED.id), true, 'the signal stays');
  assert.match(onScreen(h), /予約を取り消しました/u);
});

test('T35 what still stops a cancel: a refused token, and an account that is not the person\'s own', async () => {
  const calls = [];
  const shared = { ...DISCONNECTED, brandId: 'shared' };
  let h = await screen({ account: shared, reply: async (call) => { calls.push(call.body.action); return ok([ROW]); } });
  await h.update();
  const cards = () => { const out = []; walk(h.render(), (n) => { if (n.type === 'ServerReservationCard') out.push(n.props); }); return out; };
  cards()[0]?.onCancel(); await h.update();
  cards()[0]?.onCancel(); await settle(); await h.update();
  assert.equal(calls.includes('cancel'), false, 'another workspace');
  const seen = [];
  let refused = false;
  h = await screen({ account: DISCONNECTED, reply: async (call) => { seen.push(call.body.action); return refused ? no(401, 'POSTONA_RESV_AUTH_REQUIRED') : ok([ROW]); } });
  await h.update();
  refused = true;
  labelled(h.render(), 'ActionButton', '投稿を作成');
  cards2(h)[0].onCancel(); await h.update();
  cards2(h)[0].onCancel(); await settle(); await h.update();
  const after = seen.length;
  cards2(h)[0].onCancel(); await h.update();
  cards2(h)[0].onCancel(); await settle(); await h.update();
  assert.equal(seen.length, after, 'nothing more with that token');
});
const cards2 = (h) => { const out = []; walk(h.render(), (n) => { if (n.type === 'ServerReservationCard') out.push(n.props); }); return out; };

test('T35 home (real): the card and the ways out for a disconnected X account only', async () => {
  const stubsFor = (account) => ({
    ...baseStubs(),
    'expo-router': { Link: 'Link' },
    '@/data/mock-repository': { mockRepository: { getPlannedPosts: () => [], getHistory: () => [] } },
    '@/features/brand-preview/brand-post-preview': { BrandPostPreview: 'BrandPostPreview' },
    '@/domain/data-view': dataView,
    '@/providers/active-account-provider': { useActiveAccount: () => ({ activeAccount: account }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: 'ready', reason: null, snapshot: { plannedPosts: [], history: [] } }) },
    '@/components/sign-out-button': { SignOutButton: 'SignOutButton' },
    '@/providers/auth-provider': { useAuth: () => ({ session: { user: { id: 'person-1' } } }) },
    '@/features/personal-workspace/personal-workspace-provider': { usePersonalWorkspace: () => ({ view: { kind: 'ready', workspaceId: ME } }) },
  });
  const links = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'Link') out.push(n.props.href); }); return out; };
  let render = await loadScreen('../src/app/(tabs)/index.tsx', stubsFor(DISCONNECTED));
  let tree = render({});
  assert.match(textOf(tree), /接続を確認できないため/u);
  assert.equal(links(tree).filter((href) => href === '/reservations').length, 2, 'the card and the existing entry');
  render = await loadScreen('../src/app/(tabs)/index.tsx', stubsFor(ACCOUNT));
  tree = render({});
  assert.doesNotMatch(textOf(tree), /接続を確認できないため/u);
  render = await loadScreen('../src/app/(tabs)/index.tsx', stubsFor({ ...DISCONNECTED, platform: 'instagram' }));
  assert.doesNotMatch(textOf(render({})), /接続を確認できないため/u);
});

test('T37 NOT_PLANNED on the tab: not a success, the words say a cancel is left, no retry; the row stops being 予約済み with no time change; a cancel still goes; another row is untouched', async () => {
  const other = { ...ROW, reservationId: 'm', draftId: 'd3', scheduledAt: '2026-12-02T00:30:00.000Z' };
  const mine = { ...ROW, reservationId: 't37-k' };
  let current = mine;
  const seen = [];
  const h = await screen({ reply: async (call) => {
    seen.push(call.body.action);
    if (call.body.action === 'reschedule') return no(409, 'POSTONA_RESV_NOT_PLANNED');
    if (call.body.action === 'cancel') { current = { ...mine, status: 'cancelled', revision: 2 }; return ok([current]); }
    if (call.body.action === 'get') return ok([current]);
    return ok([current, other]);
  } });
  await h.update();
  const card = (id) => { let hit = null; walk(h.render(), (n) => { if (n.type === 'ServerReservationCard' && n.props.row.reservationId === id) hit = n.props; }); return hit; };
  assert.equal(card('t37-k').notEditable, null);
  card('t37-k').onRetime(); await h.update();
  card('t37-k').onRetimeApply(); await settle(); await h.update();
  assert.deepEqual(seen.filter((a) => a === 'reschedule'), ['reschedule'], 'once');
  assert.match(onScreen(h), /サーバーがこの予約の変更を受け付けませんでした/u);
  assert.doesNotMatch(onScreen(h), /日時を変更しました|もう変更できません/u);
  assert.equal(card('t37-k').notEditable.label, '変更できない予約');
  assert.equal(card('m').notEditable, null);
  card('t37-k').onCancel(); await h.update();
  card('t37-k').onCancel(); await settle(); await h.update();
  assert.equal(seen.filter((a) => a === 'cancel').length, 1);
  assert.match(onScreen(h), /予約を取り消しました/u);
});

test('T37 after a restart + reconnect: writes are back, and the words say what is true of rows saved before it; nothing is called failed; no rows, no words; another person sees none of it', async () => {
  signal.markXServiceRestarted('person-1');
  signal.clearXServiceRestarted('person-1');
  assert.equal(signal.isXReconnectedAfterRestart('person-1'), true);
  const h = await screen({ reply: async () => ok([ROW]) });
  await h.update();
  assert.match(onScreen(h), /再開前に保存した予約は/u);
  assert.match(onScreen(h), /判別できません/u);
  assert.doesNotMatch(onScreen(h), /接続済みと表示されていても/u, 'one note');
  let label = null; walk(h.render(), (n) => { if (n.type === 'ServerReservationCard') label = n.props.notEditable; });
  assert.equal(label, null, 'no row is singled out');
  const none = await screen({ reply: async () => ok([]) });
  await none.update();
  assert.doesNotMatch(onScreen(none), /再開前に保存した予約は/u);
  h.world.userId = 'person-9';
  await h.update();
  assert.doesNotMatch(onScreen(h), /再開前に保存した予約は/u);
});

test('T38 S-2 NOT_PLANNED on the tab: the editor closes and stays closed, a press still on its way sends nothing, the cancel goes', async () => {
  const mine = { ...ROW, reservationId: 't38-a' };
  let current = mine;
  const seen = [];
  const h = await screen({ reply: async (call) => {
    seen.push(call.body.action);
    if (call.body.action === 'reschedule') return no(409, 'POSTONA_RESV_NOT_PLANNED');
    if (call.body.action === 'cancel') { current = { ...mine, status: 'cancelled', revision: 2 }; return ok([current]); }
    return ok([current]);
  } });
  await h.update();
  const card = () => cards2(h)[0];
  card().onRetime(); await h.update();
  assert.notEqual(card().retiming, null, 'open before the refusal');
  const stale = card();
  card().onRetimeApply(); await settle(); await h.update();
  assert.equal(seen.filter((a) => a === 'reschedule').length, 1);
  assert.equal(card().retiming, null, 'S16: the editor was still open here');
  assert.notEqual(card().notEditable, null);
  stale.onRetimeApply(); await settle(); await h.update();
  stale.onReconfirm(); await settle(); await h.update();
  assert.deepEqual(seen.filter((a) => a === 'reschedule' || a === 'reconfirm'), ['reschedule'], 'the old buttons send nothing more');
  card().onCancel(); await h.update();
  card().onCancel(); await settle(); await h.update();
  assert.equal(seen.filter((a) => a === 'cancel').length, 1);
});

test('T38 S-2 403 on the tab: no editor, no time change and no reconfirm are offered while the writes are off; no retry; a new connect offers them again', async () => {
  const mine = { ...ROW, reservationId: 't38-b' };
  const seen = [];
  const h = await screen({ reply: async (call) => { seen.push(call.body.action); return call.body.action === 'reschedule' ? no(403, 'POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED') : ok([mine]); } });
  await h.update();
  const card = () => cards2(h)[0];
  assert.equal(card().canEdit, true);
  card().onRetime(); await h.update();
  card().onRetimeApply(); await settle(); await h.update();
  assert.equal(card().retiming, null);
  assert.equal(card().canEdit, false);
  assert.equal(seen.filter((a) => a === 'reschedule').length, 1);
  signal.clearXReconnectRequired(h.world.account.id);
  await h.update();
  assert.equal(card().canEdit, true);
  assert.equal(card().retiming, null, 'it is opened again by a press');
});

test('T38 S-2 the editor stays only for what another time can answer: a slot conflict keeps it; a stale revision and a lost answer close it, and neither is called not editable', async () => {
  const mine = { ...ROW, reservationId: 't38-c' };
  let answer = no(409, 'POSTONA_RESV_SLOT_CONFLICT');
  const h = await screen({ reply: async (call) => (call.body.action === 'reschedule' ? answer : ok([mine])) });
  await h.update();
  const card = () => cards2(h)[0];
  card().onRetime(); await h.update();
  card().onRetimeApply(); await settle(); await h.update();
  assert.notEqual(card().retiming, null, 'fix_input');
  assert.equal(card().canEdit, true);
  answer = no(409, 'POSTONA_RESV_STALE_REVISION');
  card().onRetimeApply(); await settle(); await h.update();
  assert.equal(card().retiming, null, 'reload');
  assert.equal(card().notEditable, null);
  assert.equal(card().canEdit, true);
  answer = 'lost';
  card().onRetime(); await h.update();
  card().onRetimeApply(); await settle(); await h.update();
  assert.equal(card().retiming, null, 'not known: no second press from the same editor');
  assert.equal(card().notEditable, null);
});

test('T38 S-6 a return to the tab reads again: a change made elsewhere shows, and a failure replaces the old rows with its error; gate OFF reads nothing', async () => {
  let reply = ok([{ ...ROW, reservationId: 't38-d' }]);
  const h = await screen({ reply: async () => reply });
  await h.update();
  const reads = () => h.world.calls.filter((call) => call.body.action === 'list').length;
  const before = reads();
  assert.equal(cards2(h).length, 1);
  reply = ok([]);
  h.world.refocus += 1;
  await h.update();
  assert.equal(reads(), before + 1);
  assert.equal(cards2(h).length, 0);
  reply = ok([{ ...ROW, reservationId: 't38-d' }]);
  h.world.refocus += 1;
  await h.update();
  reply = 'lost';
  h.world.refocus += 1;
  await h.update();
  assert.equal(cards2(h).length, 0);
  assert.match(onScreen(h), /サーバーの予約を読み込めませんでした/u);
  const off = await screen({ gate: false });
  off.world.refocus += 1;
  await off.update();
  assert.deepEqual([off.world.calls.length, off.world.sessionReads], [0, 0]);
});

test('T38 S-1 the words: a reconnect alone is not said to bring a stored row back; what to do is said; no row is declared lost', () => {
  for (const text of [xWriteView.RECONNECT_REQUIRED_TEXT, xWriteView.RESTART_OBSERVED_TEXT, xWriteView.RESTART_OBSERVED_ACCOUNTS_TEXT, xWriteView.X_NOT_CONNECTED_TEXT, xWriteView.X_NOT_CONNECTED_HOME_TEXT]) {
    assert.doesNotMatch(text, /接続し直すまで投稿/u);
    assert.match(text, /接続し直すだけでは投稿されないことがあります/u);
    assert.match(text, /取り消して作り直/u);
  }
  assert.doesNotMatch(xWriteView.CONNECTED_NOT_PROOF_TEXT, /接続し直してください/u);
  assert.match(xWriteView.CONNECTED_NOT_PROOF_TEXT, /取り消して作り直/u);
  assert.match(xWriteView.RESTART_HELP_TEXT, /再接続しても投稿されません/u);
  assert.match(xWriteView.RESTART_RECONNECTED_TEXT, /判別できません/u);
});

test('T37 the words: a stored row may not be sent while the connection is off; 接続済み and 予約済み are no promise; a code the app cannot place is not called not-editable', () => {
  for (const text of [xWriteView.RECONNECT_REQUIRED_TEXT, xWriteView.RESTART_OBSERVED_TEXT, xWriteView.X_NOT_CONNECTED_TEXT, xWriteView.X_NOT_CONNECTED_HOME_TEXT]) assert.match(text, /投稿されないことがあります/u);
  assert.match(xWriteView.CONNECTED_NOT_PROOF_TEXT, /投稿を保証するものではありません/u);
  assert.equal(xWriteView.isNotEditableCode('POSTONA_RESV_NOT_PLANNED'), true);
  assert.equal(xWriteView.isNotEditableCode('POSTONA_RESV_ALREADY_FINAL'), false);
  assert.match(xWriteView.xAnswerView('POSTONA_RESV_NOT_PLANNED', reservationErrorAction).text, /受け付けませんでした/u);
  assert.equal(xWriteView.xAnswerView('POSTONA_RESV_NOT_PLANNED', reservationErrorAction).reread, true);
  assert.match(xWriteView.xAnswerView('POSTONA_RESV_ALREADY_FINAL', reservationErrorAction).text, /もう変更できません/u);
  signal.markXServiceRestarted('p37');
  signal.clearXServiceRestarted('p37');
  assert.deepEqual([signal.isXReconnectedAfterRestart('p37'), signal.isXReconnectedAfterRestart('q37'), signal.isXReconnectedAfterRestart(null)], [true, false, false]);
  signal.forgetXReconnectedAfterRestart('p37');
  signal.markXRowNotEditable('z');
  assert.deepEqual([signal.isXRowNotEditable('z'), signal.isXRowNotEditable('y')], [true, false]);
});

test('T34 RESV-1: 「投稿予定はありません」 only for an answered, empty list: loading, rows, a read error, a refused login and another account never show it', async () => {
  let h = await screen({ reply: async () => ok([]) });
  await h.update();
  assert.deepEqual(emptyTitles(h), ['投稿予定はありません'], 'answered and empty');

  let release; const held = new Promise((resolve) => { release = resolve; });
  h = await screen({ reply: async () => { await held; return ok([]); } });
  assert.deepEqual(emptyTitles(h), [], 'loading');
  release(); await settle(); await h.update();
  assert.deepEqual(emptyTitles(h), ['投稿予定はありません'], 'then answered');

  h = await screen({ reply: async () => ok([ROW]) });
  await h.update();
  assert.deepEqual(emptyTitles(h), [], 'a saved reservation');

  h = await screen({ reply: async () => no(503, 'NETWORK_ERROR') });
  await h.update();
  assert.deepEqual(emptyTitles(h), [], 'a read error');
  assert.match(onScreen(h), /サーバーの予約を読み込めませんでした/u);

  h = await screen({ reply: async () => no(401, 'POSTONA_RESV_AUTH_REQUIRED') });
  await h.update();
  assert.deepEqual(emptyTitles(h), [], 'a refused login');

  h = await screen({ reply: async (call) => (call.body.payload?.socialAccountId === OTHER_ACCOUNT.id ? held2 : ok([])) });
  await h.update();
  assert.deepEqual(emptyTitles(h), ['投稿予定はありません']);
  h.world.account = OTHER_ACCOUNT;
  await h.update();
  assert.deepEqual(emptyTitles(h), [], 'another account: not read yet');
});

test('T34 RESV-1: with only a send-now row the tab can say none (it is not a reservation), and it says where that row is', async () => {
  const send = { ...ROW, reservationId: 's1', draftId: 'single:1' };
  const h = await screen({ reply: async () => ok([send]) });
  await h.update();
  assert.deepEqual(emptyTitles(h), ['投稿予定はありません']);
  assert.match(onScreen(h), /即時投稿が1件あります/u);
});

test('T34 gate OFF: the empty card stays as it was, no read, no token; the words say nothing can be saved', async () => {
  const h = await screen({ gate: false });
  await h.update();
  assert.deepEqual(emptyTitles(h), ['投稿予定はありません']);
  assert.deepEqual([h.world.calls.length, h.world.sessionReads], [0, 0]);
  await planOne(h);
  assert.match(onScreen(h), /実際の予約と投稿は、まだ利用できません/u);
  assert.doesNotMatch(onScreen(h), /「サーバーに保存」のあとです/u);
});

test('T34 RESV-2: with the gate on, the words match the save button; the composer is told', async () => {
  const h = await screen();
  labelled(h.render(), 'ActionButton', '投稿を作成').onPress();
  await h.update();
  let composer = null; walk(h.render(), (n) => { if (n.type === 'ScheduleComposer') composer = n.props; });
  assert.equal(composer.saveAvailable, true);
  composer.onClose();
  await h.update();
  await planOne(h);
  assert.match(onScreen(h), /「サーバーに保存」のあとです/u);
  assert.doesNotMatch(onScreen(h), /実際の予約と投稿は、まだ利用できません/u);
  const source = await readFile(new URL('../src/features/schedule/schedule-composer.tsx', import.meta.url), 'utf8');
  assert.match(source, /saveAvailable \? 'ここで作るのは、まだ保存されていないプレビューです/u);
  const off = await screen({ gate: false });
  labelled(off.render(), 'ActionButton', '投稿を作成').onPress();
  await off.update();
  walk(off.render(), (n) => { if (n.type === 'ScheduleComposer') composer = n.props; });
  assert.equal(composer.saveAvailable, false);
});

test('T34 RESV-3: on the tab a cancel asks first; the second press sends one cancel; another row does not inherit the question', async () => {
  const second = { ...ROW, reservationId: 'm', draftId: 'd3' };
  const h = await screen({ reply: async (call) => {
    if (call.body.action === 'cancel') return { status: 200, json: { ok: true, reservations: [{ ...ROW, status: 'cancelled', revision: 2 }] } };
    return ok([ROW, second]);
  } });
  await h.update();
  const cards = () => { const out = []; walk(h.render(), (n) => { if (n.type === 'ServerReservationCard') out.push(n.props); }); return out; };
  cards()[0].onCancel();
  await h.update();
  assert.equal(ofAction(h, 'cancel').length, 0, 'the first press only asks');
  assert.deepEqual(cards().map((c) => c.confirmingCancel), [true, false]);
  cards()[1].onCancel();
  await h.update();
  assert.deepEqual(cards().map((c) => c.confirmingCancel), [false, true], 'the question moved with the press');
  cards()[0].onCancel();
  await h.update();
  cards()[0].onCancel();
  await settle(); await h.update();
  assert.equal(ofAction(h, 'cancel').length, 1);
  assert.equal(ofAction(h, 'cancel')[0].body.payload.reservationId, 'k');
});

test('T34 RESV-4 + 7: a 401 says it once, with the settings and the sign-out right there; a new token removes them', async () => {
  const { h } = await ready({ create: () => no(401, 'POSTONA_RESV_AUTH_REQUIRED') });
  await pressSave(h);
  const said = []; walk(h.render(), (n) => { if (n.type === 'Pill' && /ログイン/u.test(textOf(n))) said.push(textOf(n)); });
  assert.equal(said.length, 1, `said once, on the batch row: ${said.join(' / ')}`);
  assert.ok(labelled(h.render(), 'ActionButton', '設定画面を開く'));
  const signOuts = () => { let n = 0; walk(h.render(), (x) => { if (x.type === 'SignOutButton') n += 1; }); return n; };
  assert.equal(signOuts(), 1);
  h.world.token = jwt('person-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2');
  await h.update();
  assert.equal(signOuts(), 0);
});

test('T34 RESV-7: 読み込み直す clears an old warning; once the read is good, no yellow or red is left', async () => {
  let down = false;
  const h = await screen({ reply: async (call) => {
    if (call.body.action === 'cancel') { down = true; return no(503, 'NETWORK_ERROR'); }
    return down ? no(503, 'NETWORK_ERROR') : ok([ROW]);
  } });
  await h.update();
  const cards = () => { const out = []; walk(h.render(), (n) => { if (n.type === 'ServerReservationCard') out.push(n.props); }); return out; };
  cards()[0].onCancel(); await h.update();
  cards()[0].onCancel(); await settle(); await h.update();
  const warnings = () => { const out = []; walk(h.render(), (n) => { if (n.type === 'Pill' && n.props.tone !== 'success') out.push(textOf(n)); }); return out; };
  assert.ok(warnings().length > 0, 'the failed cancel and the failed read');
  down = false;
  labelled(h.render(), 'SmallButton', '読み込み直す').onPress();
  await settle(); await h.update();
  assert.deepEqual(warnings(), []);
  assert.equal(cards().length, 1, 'the row is back');
});

test('T34 RESV-8 + 9: the keyboard insets and the tab scene inset are set in the source', async () => {
  const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');
  assert.match(await read('../src/app/(tabs)/schedule.tsx'), /<ScrollView automaticallyAdjustKeyboardInsets/u);
  assert.match(await read('../src/app/reservations/index.tsx'), /<ScrollView automaticallyAdjustKeyboardInsets/u);
  assert.match(await read('../src/app/(tabs)/_layout.tsx'), /sceneStyle: \{ backgroundColor: colors\.background, paddingTop: insets\.top \}/u);
});

test('T33 not observable: a connected account can save, and the supplement says 接続済み is no promise; no reconnect is claimed', async () => {
  const { h } = await ready({ create: () => no(429, 'POSTONA_RESV_RATE_LIMITED') });
  assert.equal(saveButton(h).disabled, false);
  assert.match(onScreen(h), /接続済みと表示されていても/u);
  assert.doesNotMatch(onScreen(h), /再接続が必要|Xの再接続/u);
  assert.equal(ofAction(h, 'create').length, 0);
});

test('T33 observed: after this person\'s restart nothing is sent, the words and the way out are shown; another person is not affected; only the connect turns it back on', async () => {
  const { h } = await ready();
  signal.markXServiceRestarted('person-9');
  await h.update();
  assert.equal(saveButton(h).disabled, false, 'another person\'s restart');
  signal.clearXServiceRestarted('person-9');
  signal.markXServiceRestarted('person-1');
  await h.update();
  assert.equal(saveButton(h).disabled, true);
  assert.match(onScreen(h), /X自動投稿を再開しました/u);
  assert.doesNotMatch(onScreen(h), /Xの再接続が必要です|接続済みと表示されていても/u);
  labelled(h.render(), 'ActionButton', 'アカウント画面を開く').onPress();
  assert.deepEqual(h.world.pushes, ['/accounts']);
  assert.equal(ofAction(h, 'create').length, 0);
  signal.clearAllXReconnectRequired();
  await h.update();
  assert.equal(saveButton(h).disabled, true, 'clearing a server\'s refusal does not clear the restart');
  signal.clearXServiceRestarted('person-1');
  await h.update();
  assert.equal(saveButton(h).disabled, false);
});

test('T33 observable: G4\'s generation code, if a server answer carries it, says 再接続が必要 and stops the writes; not a retry', async () => {
  const { h } = await ready({ create: () => no(403, 'X_REFRESH_PRECHECK_SERVICE_GENERATION_CHANGED') });
  await pressSave(h);
  assert.equal(signal.isXReconnectRequired(ACCOUNT.id), true);
  assert.match(onScreen(h), /Xの再接続が必要です/u);
  assert.equal(saveButton(h).disabled, true);
  assert.equal(ofAction(h, 'create').length, 1);
});

test('T33 A-B-A: a refusal stays with its account; B can save; back on A the writes are off again and no answer crossed', async () => {
  const other = { ...ACCOUNT, id: '22222222-2222-4222-8222-222222222222' };
  const { h } = await ready({ create: () => no(403, 'POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED') });
  await pressSave(h);
  assert.equal(saveButton(h).disabled, true);
  h.world.account = other;
  await h.update();
  assert.doesNotMatch(onScreen(h), /Xの再接続が必要です/u, 'A\'s words do not follow the person to B');
  assert.equal(signal.isXReconnectRequired(other.id), false);
  h.world.account = ACCOUNT;
  await h.update();
  assert.match(onScreen(h), /Xの再接続が必要です/u);
  assert.equal(ofAction(h, 'create').length, 1, 'nothing was re-sent on the way back');
});

test('T33 gate OFF: with or without a recorded restart, nothing is sent, no token is read, and no supplement is shown (nothing is being saved)', async () => {
  const h = await screen({ gate: false });
  await h.update();
  assert.doesNotMatch(onScreen(h), /接続済みと表示されていても/u);
  signal.markXServiceRestarted('person-1');
  await h.update();
  assert.doesNotMatch(onScreen(h), /接続済みと表示されていても/u);
  assert.equal(h.world.calls.length, 0);
  assert.equal(h.world.sessionReads, 0);
});

test('refused before any request: no login, another person\'s workspace, W0 not ready, a disconnected account', async () => {
  for (const [change, words] of [
    [(world) => { world.token = null; }, /ログインが確認できない/u],
    [(world) => { world.account = { ...ACCOUNT, brandId: 'shared' }; }, /個人ワークスペース/u],
    [(world) => { world.workspaceId = null; }, /個人ワークスペース/u],
    [(world) => { world.account = { ...ACCOUNT, connectionStatus: 'needs_attention' }; }, /接続を確認できない/u],
  ]) {
    const { h } = await ready();
    change(h.world);
    await h.update();
    if (h.world.token && h.world.workspaceId && h.world.account.brandId === ME) assert.equal(saveButton(h).disabled, true);
    assert.match(onScreen(h), words);
    assert.equal(ofAction(h, 'create').length, 0);
  }
});

test('a send-now row is not listed as a reservation here; a saved row is 予約済み only as planned + confirmed; AI rows are not', async () => {
  const send = { reservationId: 's1', batchId: 'b', draftId: 'single:1', scheduledAt: '2026-12-01T00:30:00.000Z', status: 'planned', revision: 1, consentState: 'confirmed', body: 'now', mode: 'manual_exact', origin: 'user_authored' };
  const h = await screen({ reply: async () => ok([send, { ...send, reservationId: 'k', draftId: 'd2' }]) });
  await h.update();
  const cards = []; walk(h.render(), (n) => { if (n.type === 'ServerReservationCard') cards.push(n.props.row.reservationId); });
  assert.deepEqual(cards, ['k']);
  assert.match(onScreen(h), /即時投稿が1件あります/u);
  const source = await readFile(new URL('../src/features/schedule/server-reservation-card.tsx', import.meta.url), 'utf8');
  assert.match(source, /row\.status === 'planned' && row\.consentState === 'ai_owner_opt_in' \? 'AI自動予約'/u);
  assert.equal(reservationView.xRowView({ ...send, draftId: 'd', consentState: 'ai_owner_opt_in' }).label, 'AI自動予約');
});

// ---------------------------------------------------------------------------------------------------------------
// The contract with G4 PR 617 / G5, and the connection display.

test('xAnswerView: every G3 action has one next step; only a server\'s code means reconnect; G4\'s generation code maps to it, an unknown code does not', () => {
  const G4 = 'X_REFRESH_PRECHECK_SERVICE_GENERATION_CHANGED';
  assert.equal(reservationErrorAction(G4), 'check', 'G3\'s table does not know it (and is not changed)');
  assert.equal(xWriteView.xActionOf(G4, reservationErrorAction), 'reconnect_x');
  assert.equal(xWriteView.xAnswerView(G4, reservationErrorAction).text, xWriteView.RECONNECT_REQUIRED_TEXT);
  assert.equal(xWriteView.xAnswerView('POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED', reservationErrorAction).button, 'accounts');
  for (const code of ['X_REFRESH_HTTP_502', 'X_REFRESH_IN_PROGRESS', 'X_REFRESH_PRECHECK_SERVICE_NOT_ACTIVE', 'SOMETHING_NEW', 'UNCERTAIN']) {
    assert.notEqual(xWriteView.xActionOf(code, reservationErrorAction), 'reconnect_x', code);
  }
  for (const code of ['AUTH_REQUIRED', 'POSTONA_RESV_SERVICE_NOT_ACTIVE', 'POSTONA_RESV_STALE_REVISION', 'POSTONA_RESV_SLOT_CONFLICT', 'RATE_LIMITED', 'SOMETHING_NEW']) {
    assert.doesNotMatch(xWriteView.xAnswerView(code, reservationErrorAction).text, /保存しました|予約しました|投稿しました|再接続が必要/u, code);
  }
});

test('connectionPill: 「再接続が必要」 only for a server\'s refusal; a restart alone changes nothing; connection_status keeps each screen\'s wording', () => {
  assert.deepEqual(xWriteView.connectionPill('connected', false, '要再接続'), { label: '接続済み', tone: 'success' });
  assert.deepEqual(xWriteView.connectionPill('connected', true, '要再接続'), { label: '再接続が必要', tone: 'warning' });
  assert.deepEqual(xWriteView.connectionPill('needs_attention', false, '要再接続'), { label: '要再接続', tone: 'warning' });
  assert.deepEqual(xWriteView.connectionPill('needs_attention', false, '要確認'), { label: '要確認', tone: 'warning' });
  assert.deepEqual(xWriteView.connectionPill('needs_attention', true, '要確認'), { label: '再接続が必要', tone: 'warning' });
  assert.doesNotMatch(xWriteView.RESTART_HELP_TEXT, /必要です/u, 'the help does not state it for this account');
});

test('T33 connectionPill: an observed restart hides 接続済み without saying 再接続が必要; a refusal and connection_status keep their words', () => {
  assert.deepEqual(xWriteView.connectionPill('connected', false, '要再接続', true), { label: '要確認', tone: 'warning' });
  assert.deepEqual(xWriteView.connectionPill('connected', true, '要再接続', true), { label: '再接続が必要', tone: 'warning' });
  assert.deepEqual(xWriteView.connectionPill('needs_attention', false, '要再接続', true), { label: '要再接続', tone: 'warning' });
  assert.deepEqual(xWriteView.connectionPill('connected', false, '要再接続', false), { label: '接続済み', tone: 'success' });
  const account = { brandId: 'me', connectionStatus: 'connected', platform: 'x' };
  assert.equal(xWriteView.xWriteRefusal({ loginId: 'l', account, personalId: 'me', reconnectRequired: false, restartObserved: true }).text, xWriteView.RESTART_OBSERVED_TEXT);
  assert.equal(xWriteView.xWriteRefusal({ loginId: 'l', account, personalId: 'me', reconnectRequired: true, restartObserved: true }).text, xWriteView.RECONNECT_REQUIRED_TEXT);
  assert.equal(xWriteView.xWriteRefusal({ loginId: 'l', account, personalId: 'me', reconnectRequired: false, restartObserved: false }), null);
});

test('T33 the restart signal: per person, null is nobody, an accepted write or a refusal clear does not touch it', () => {
  signal.markXServiceRestarted('p');
  assert.deepEqual([signal.isXServiceRestarted('p'), signal.isXServiceRestarted('q'), signal.isXServiceRestarted(null)], [true, false, false]);
  signal.markXReconnectRequired('r');
  signal.clearXReconnectRequired('r');
  signal.markXReconnectRequired('r');
  signal.clearAllXReconnectRequired();
  assert.equal(signal.isXReconnectRequired('r'), false);
  assert.equal(signal.isXServiceRestarted('p'), true);
  signal.clearXServiceRestarted('q');
  assert.equal(signal.isXServiceRestarted('p'), true);
  signal.clearXServiceRestarted('p');
  assert.equal(signal.isXServiceRestarted('p'), false);
});

test('the signal: set by a refusal, per account; cleared by the connect or by one account\'s accepted write; memory only', async () => {
  signal.markXReconnectRequired('a');
  signal.markXReconnectRequired('b');
  assert.deepEqual([signal.isXReconnectRequired('a'), signal.isXReconnectRequired('c'), signal.isXReconnectRequired(null)], [true, false, false]);
  signal.clearXReconnectRequired('a');
  assert.deepEqual([signal.isXReconnectRequired('a'), signal.isXReconnectRequired('b')], [false, true]);
  signal.clearAllXReconnectRequired();
  assert.equal(signal.isXReconnectRequired('b'), false);
  const source = await readFile(new URL('../src/features/reservations/x-reconnect-signal.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /AsyncStorage|SecureStore|fetch\(|localStorage/u);
});

async function loadScreen(rel, stubs) {
  const source = await readFile(new URL(rel, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(js, { module: loaded, exports: loaded.exports, Date, require: (name) => { if (!Object.hasOwn(stubs, name)) throw new Error(`unexpected import ${name}`); return stubs[name]; } }, { filename: rel });
  return loaded.exports.default;
}
const baseStubs = () => ({
  'react/jsx-runtime': { jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), jsxs: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), Fragment: 'Fragment' },
  'react-native': { ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
  '@/constants/theme': { colors: { primary: 'p', ink: 'i', muted: 'm' }, typography: {} },
  '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', EmptyState: 'EmptyState', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
  '@/features/reservations/x-reconnect-signal': { ...signal, useXReconnectSignal: () => 0 },
  '@/features/reservations/x-write-view': xWriteView,
  '@/features/reservations/home-reservations': { homeCount: (fromPosts) => fromPosts, homeHasNoReservations: () => true, homeHeadline: (headline) => headline },
  '@/features/reservations/use-home-reservations': { useHomeReservations: () => ({ view: { kind: 'not_applicable' }, reload() {} }) },
});

test('accounts screen (real): 接続済み until a server\'s refusal; then 再接続が必要 with the words; a new connect clears it; the help is always there and never claims', async () => {
  const effects = [];
  let connectState = 'idle';
  const render = await loadScreen('../src/app/accounts/index.tsx', {
    ...baseStubs(),
    react: { useEffect: (effect) => effects.push(effect) },
    'expo-router': { useRouter: () => ({ push() {} }) },
    '@/features/x-connect/use-x-connect': { useXConnect: () => ({ state: connectState, stateText: '', verifiedHandle: null, connect() {} }) },
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: [ACCOUNT], activeAccount: ACCOUNT, selectAccount() {} }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: 'ready', reload() {} }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: { user: { id: 'person-1' } } }) },
    '@/features/personal-workspace/personal-workspace-provider': { usePersonalWorkspace: () => ({ view: { kind: 'ready', workspaceId: ME } }) },
  });
  let text = textOf(render({}));
  assert.match(text, /接続済み/u);
  assert.doesNotMatch(text, /再接続が必要/u);
  assert.match(text, /接続の更新が止まることがあります/u);
  signal.markXReconnectRequired(ACCOUNT.id);
  text = textOf(render({}));
  assert.match(text, /再接続が必要/u);
  assert.doesNotMatch(text, /接続済み/u, 'the connected label does not stay');
  assert.match(text, /Xの再接続が必要です/u);
  assert.match(text, /Xアカウントの再接続/u);
  connectState = 'connected';
  effects.length = 0;
  render({});
  effects.forEach((effect) => effect());
  assert.equal(signal.isXReconnectRequired(ACCOUNT.id), false);
  // T33: a restart observed in this app, with no refusal: not 接続済み, not 再接続が必要, the reconnect button; the connect clears it, for this person only
  connectState = 'idle';
  signal.markXServiceRestarted('person-1');
  signal.markXServiceRestarted('person-9');
  text = textOf(render({}));
  assert.doesNotMatch(text, /接続済み|再接続が必要/u);
  assert.match(text, /要確認/u);
  assert.match(text, /X自動投稿を再開しました/u);
  assert.match(text, /下のボタンから接続し直してください/u);
  assert.match(text, /Xアカウントの再接続/u);
  effects.length = 0;
  render({});
  effects.forEach((effect) => effect());
  assert.equal(signal.isXServiceRestarted('person-1'), true, 'opening the screen is not a connect');
  connectState = 'connected';
  effects.length = 0;
  render({});
  effects.forEach((effect) => effect());
  assert.equal(signal.isXServiceRestarted('person-1'), false);
  assert.equal(signal.isXServiceRestarted('person-9'), true);
  signal.clearXServiceRestarted('person-9');
});

test('T33 another workspace\'s X account: a restart does not touch it, on the accounts screen or at home; an unknown workspace may be this one', async () => {
  const SHARED = { ...ACCOUNT, id: '33333333-3333-4333-8333-333333333333', brandId: 'shared-org' };
  let view = { kind: 'ready', workspaceId: ME };
  const common = {
    ...baseStubs(),
    '@/features/personal-workspace/personal-workspace-provider': { usePersonalWorkspace: () => ({ view }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: { user: { id: 'person-1' } } }) },
  };
  const accounts = await loadScreen('../src/app/accounts/index.tsx', {
    ...common,
    react: { useEffect() {} },
    'expo-router': { useRouter: () => ({ push() {} }) },
    '@/features/x-connect/use-x-connect': { useXConnect: () => ({ state: 'idle', stateText: '', verifiedHandle: null, connect() {} }) },
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: [SHARED], activeAccount: SHARED, selectAccount() {} }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: 'ready', reload() {} }) },
  });
  const home = await loadScreen('../src/app/(tabs)/index.tsx', {
    ...common,
    'expo-router': { Link: 'Link' },
    '@/data/mock-repository': { mockRepository: { getPlannedPosts: () => [], getHistory: () => [] } },
    '@/features/brand-preview/brand-post-preview': { BrandPostPreview: 'BrandPostPreview' },
    '@/domain/data-view': dataView,
    '@/providers/active-account-provider': { useActiveAccount: () => ({ activeAccount: SHARED }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: 'ready', reason: null, snapshot: { plannedPosts: [], history: [] } }) },
    '@/components/sign-out-button': { SignOutButton: 'SignOutButton' },
  });
  signal.markXServiceRestarted('person-1');
  let text = textOf(accounts({}));
  assert.match(text, /接続済み/u);
  assert.doesNotMatch(text, /要確認|X自動投稿を再開しました|Xアカウントの再接続/u);
  assert.match(textOf(home({})), /^接続済み$/mu);
  view = { kind: 'preparing' };
  text = textOf(accounts({}));
  assert.match(text, /要確認/u);
  assert.match(textOf(home({})), /^要確認$/mu);
  assert.deepEqual([
    xWriteView.restartAppliesTo({ platform: 'x', brandId: 'me' }, 'me'),
    xWriteView.restartAppliesTo({ platform: 'x', brandId: 'other' }, 'me'),
    xWriteView.restartAppliesTo({ platform: 'threads', brandId: 'me' }, 'me'),
    xWriteView.restartAppliesTo({ platform: 'x', brandId: 'other' }, null),
  ], [true, false, false, true]);
});

test('home (real): 再接続が必要 replaces 接続済み for the selected X account after a server\'s refusal', async () => {
  const render = await loadScreen('../src/app/(tabs)/index.tsx', {
    ...baseStubs(),
    'expo-router': { Link: 'Link' },
    '@/data/mock-repository': { mockRepository: { getPlannedPosts: () => [], getHistory: () => [] } },
    '@/features/brand-preview/brand-post-preview': { BrandPostPreview: 'BrandPostPreview' },
    '@/domain/data-view': dataView,
    '@/providers/active-account-provider': { useActiveAccount: () => ({ activeAccount: ACCOUNT }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: 'ready', reason: null, snapshot: { plannedPosts: [], history: [] } }) },
    '@/components/sign-out-button': { SignOutButton: 'SignOutButton' },
    '@/providers/auth-provider': { useAuth: () => ({ session: { user: { id: 'person-1' } } }) },
    '@/features/personal-workspace/personal-workspace-provider': { usePersonalWorkspace: () => ({ view: { kind: 'ready', workspaceId: ME } }) },
  });
  assert.match(textOf(render({})), /^接続済み$/mu);
  signal.markXServiceRestarted('person-9');
  assert.match(textOf(render({})), /^接続済み$/mu, 'another person\'s restart');
  signal.clearXServiceRestarted('person-9');
  signal.markXServiceRestarted('person-1');
  const restarted = textOf(render({}));
  assert.match(restarted, /^要確認$/mu, 'an observed restart hides 接続済み');
  assert.doesNotMatch(restarted, /^接続済み$|再接続が必要/mu);
  signal.clearXServiceRestarted('person-1');
  signal.markXReconnectRequired(ACCOUNT.id);
  const text = textOf(render({}));
  assert.match(text, /再接続が必要/u);
  assert.doesNotMatch(text, /^接続済み$/mu);
});
