// G1 TASK 38 (G2 QA S-3, S-2, S-7): the REAL home with the REAL hook, write guard and G3's REAL X store over a scripted fetch, and the
// REAL reservation card. The gate is turned on by an argument in this file only. Nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as dataView from '../src/domain/data-view.ts';
import * as reservationFlow from '../src/domain/reservation-flow.ts';
import * as planner from '../src/domain/schedule-planner.ts';
import * as enrollment from '../src/domain/service-enrollment.ts';
import * as homeReservations from '../src/features/reservations/home-reservations.ts';
import * as signal from '../src/features/reservations/x-reconnect-signal.ts';
import * as xWriteView from '../src/features/reservations/x-write-view.ts';
import * as xRowGeneration from '../src/features/reservations/x-row-generation.ts';
import { reservationErrorAction } from '../src/features/schedule/reservation-error-actions.ts';
import * as reservationStore from '../src/features/schedule/reservation-store.ts';
import * as serverState from '../src/features/schedule/server-reservations-state.ts';

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
test.beforeEach(() => { signal.clearAllXReconnectRequired(); signal.clearXServiceRestarted('person-1'); });

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
};
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const textOf = (tree) => { const out = []; walk(tree, (n) => { for (const c of [n.props?.children].flat()) if (typeof c === 'string' || typeof c === 'number') out.push(String(c)); }); return out.join('\n'); };
const labelled = (tree, type, label) => { let hit = null; walk(tree, (n) => { if (n.type === type && n.props.label === label) hit = n.props; }); return hit; };
const jwt = (sub, sid) => { const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); return `${part({ alg: 'none' })}.${part({ sub, session_id: sid })}.x`; };
const compile = async (rel) => ts.transpileModule(await readFile(new URL(rel, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const load = async (rel, stubs) => {
  const loaded = { exports: {} };
  vm.runInNewContext(await compile(rel), { module: loaded, exports: loaded.exports, Promise, Date, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: rel });
  return loaded.exports;
};
const jsxRuntime = { jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), jsxs: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), Fragment: 'Fragment' };

const ME = 'u_me';
const ACCOUNT = { id: '11111111-1111-4111-8111-111111111111', brandId: ME, platform: 'x', profile: { displayName: 'me', handle: '@me', avatarColor: '#000' }, connectionStatus: 'connected', postingState: 'active' };
const OTHER_ACCOUNT = { ...ACCOUNT, id: '44444444-4444-4444-8444-444444444444' };
const inDays = (days) => new Date(Date.now() + days * 864e5).toISOString();
const row = (id, patch = {}) => ({ reservationId: id, batchId: 'b', draftId: `d-${id}`, scheduledAt: inDays(5), status: 'planned', revision: 1, consentState: 'confirmed', body: `body ${id}`, mode: 'manual_exact', origin: 'user_authored', ...patch });
const ok = (rows) => ({ status: 200, json: { ok: true, reservations: rows } });
const no = (status, code) => ({ status, json: { ok: false, code } });
/**
 * G3 #629's field as its store passes it on: this tree's store may drop it, so `world.generations[id]` is put on the rows of list / get, and
 * `world.afterWrite[id]` (if given, else the same map) on the read-back row a write returns. An id in neither map has no field.
 */
const withGenerations = (store, world) => (!store.enabled ? store : new Proxy(store, {
  get(target, key) {
    const fn = target[key];
    if (typeof fn !== 'function' || !['list', 'get', 'reschedule', 'reconfirm', 'cancel'].includes(key)) return fn;
    return async (...args) => {
      const answer = await fn.apply(target, args);
      const map = (key === 'list' || key === 'get' ? world.generations : world.afterWrite ?? world.generations) ?? {};
      const put = (row) => (Object.hasOwn(map, row.reservationId) ? { ...row, connectionGeneration: map[row.reservationId] } : row);
      return answer && answer.ok ? { ...answer, value: Array.isArray(answer.value) ? answer.value.map(put) : put(answer.value) } : answer;
    };
  },
}));

/** The real home. `reply` answers each fetch, 'lost' is a network failure, a promise holds the answer. */
async function home({ gate = true, reply = () => ok([]), account = ACCOUNT, workspace = { kind: 'ready', workspaceId: ME }, data = {}, status = 'ready' } = {}) {
  const slots = []; let cursor = 0; const effects = [];
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return i; };
  const react = {
    useState: (initial) => { const i = slot(() => (typeof initial === 'function' ? initial() : initial)); return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => slots[slot(() => ({ current: initial }))],
    useMemo: (factory) => slots[slot(factory)],
    useCallback: (callback) => slots[slot(() => callback)],
    useEffect: (effect, deps) => {
      const i = cursor++;
      const changed = !(i in slots) || !deps || deps.length !== slots[i].length || deps.some((d, k) => !Object.is(d, slots[i][k]));
      if (changed) { slots[i] = deps ?? []; effects.push(() => { if (typeof slots[`c${i}`] === 'function') slots[`c${i}`](); slots[`c${i}`] = effect(); }); }
    },
  };
  const world = { account, workspace, token: jwt('person-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'), userId: 'person-1', calls: [], sessionReads: 0, refocus: null, status, reason: null, snapshot: { plannedPosts: [], history: [], ...data } };
  const client = { auth: { getSession: async () => { world.sessionReads += 1; return { data: { session: world.token ? { access_token: world.token, user: { id: world.userId } } : null }, error: null }; } } };
  const fetchImpl = async (url, init) => {
    const call = { body: init?.body ? JSON.parse(init.body) : null, token: init?.headers?.authorization ?? null };
    world.calls.push(call);
    const answer = await world.reply(call);
    if (answer === 'lost') throw new Error('network lost');
    return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status, headers: { 'content-type': 'application/json' } });
  };
  world.reply = reply;
  const workspaceStub = { usePersonalWorkspace: () => ({ view: world.workspace }) };
  const auth = { useAuth: () => ({ session: world.token ? { access_token: world.token, user: { id: world.userId } } : null }) };
  const signals = { ...signal, useXReconnectSignal: () => 0 };
  const guard = await load('../src/features/reservations/use-x-write-guard.ts', {
    react, '@/domain/service-enrollment': enrollment, '@/features/personal-workspace/personal-workspace-provider': workspaceStub,
    '@/features/reservations/x-reconnect-signal': signals, '@/features/reservations/x-write-view': xWriteView, '@/providers/auth-provider': auth,
  });
  const refocus = await load('../src/features/reservations/use-refocus-count.ts', { react, 'expo-router': { useFocusEffect: (callback) => { if (world.refocus === null) callback(); world.refocus = callback; } } });
  const hook = await load('../src/features/reservations/use-home-reservations.ts', {
    react, '@/features/personal-workspace/personal-workspace-provider': workspaceStub, '@/features/reservations/home-reservations': homeReservations,
    '@/features/reservations/use-refocus-count': refocus, '@/features/reservations/use-x-write-guard': guard, '@/features/reservations/x-reconnect-signal': signals,
    '@/features/schedule/reservation-error-actions': { reservationErrorAction },
    '@/features/schedule/reservation-store': { ...reservationStore, createReservationStore: (_constant, live) => withGenerations(reservationStore.createReservationStore(gate, live ? { ...live, fetch: fetchImpl } : null), world) },
    '@/features/schedule/server-reservations-state': serverState,
    '@/lib/supabase': { supabase: client, getSupabaseConfig: () => ({ ok: true, config: { url: 'https://example.invalid', publishableKey: 'sb_publishable_testkey01' } }) },
  });
  const screen = await load('../src/app/(tabs)/index.tsx', {
    'expo-router': { Link: 'Link' }, 'react/jsx-runtime': jsxRuntime, 'react-native': { ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    '@/data/mock-repository': { mockRepository: { getPlannedPosts: () => [], getHistory: () => [], getWorkspace: () => null } },
    '@/constants/theme': { colors: {}, typography: {} },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', EmptyState: 'EmptyState', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: {} },
    '@/components/sign-out-button': { SignOutButton: 'SignOutButton' },
    '@/features/brand-preview/brand-post-preview': { BrandPostPreview: 'BrandPostPreview' },
    '@/features/reservations/home-reservations': homeReservations, '@/features/reservations/use-home-reservations': hook,
    '@/features/reservations/x-reconnect-signal': signals, '@/features/reservations/x-write-view': xWriteView,
    '@/features/reservations/x-row-generation': xRowGeneration,
    '@/domain/data-view': dataView, '@/features/personal-workspace/personal-workspace-provider': workspaceStub,
    '@/providers/active-account-provider': { useActiveAccount: () => ({ activeAccount: world.account }) }, '@/providers/auth-provider': auth,
    '@/providers/data-provider': { useDataStatus: () => ({ status: world.status, reason: world.reason, snapshot: world.snapshot }) },
  });
  const render = () => { cursor = 0; return screen.default({}); };
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
  /** The numbers under 今後の予定 and 要確認. */
  const counts = () => { const lines = textOf(render()).split('\n'); return [lines[lines.indexOf('今後の予定') + 1], lines[lines.indexOf('要確認') + 1]]; };
  const lists = () => world.calls.filter((call) => call.body.action === 'list').length;
  return { world, render, update, counts, lists, text: () => textOf(render()), refocus: async () => { world.refocus(); await update(); } };
}

test('S-3 / H5 U2: two saved rows, one awaiting reconfirmation: one upcoming candidate and one needing attention', async () => {
  const later = inDays(9);
  const h = await home({ reply: () => ok([row('a', { scheduledAt: later }), row('b', { scheduledAt: inDays(3), consentState: 'needs_reconfirm' })]) });
  assert.deepEqual(h.counts(), ['1件', '1件']);
  assert.match(h.text(), /Xの保存済み予約: 2件/u);
  const text = h.text();
  assert.doesNotMatch(text, /予定されている投稿はありません/u);
  assert.doesNotMatch(JSON.stringify(h.render()), /まだ運用データがありません/u);
  assert.match(text, /body a/u, 'the row awaiting a reconfirmation comes first in time but is not the next post');
  assert.doesNotMatch(text, /body b/u);
  assert.match(text, /投稿を保証するものではありません/u);
  assert.doesNotMatch(JSON.stringify(h.render()), /次に投稿される予定/u);
});

test('a true empty is the only 「0件」 and 「ありません」', async () => {
  const h = await home();
  assert.deepEqual(h.counts(), ['0件', '0件']);
  assert.match(h.text(), /予定されている投稿はありません/u);
  assert.match(JSON.stringify(h.render()), /まだ運用データがありません/u);
  assert.equal(h.lists(), 1);
});

test('loading: no number and no 「ありません」 until the server answered', async () => {
  let release;
  const h = await home({ reply: () => new Promise((resolve) => { release = resolve; }) });
  assert.deepEqual(h.counts(), ['－', '－']);
  assert.match(h.text(), /読み込み中/u);
  assert.doesNotMatch(h.text(), /予定されている投稿はありません/u);
  assert.doesNotMatch(JSON.stringify(h.render()), /まだ運用データがありません/u);
  release(ok([row('a')]));
  await h.update();
  assert.deepEqual(h.counts(), ['1件', '0件']);
});

test('a network failure (G2 S21): no number, it says the reservations are not known, and a press reads again', async () => {
  let reply = 'lost';
  const h = await home({ reply: () => reply });
  assert.deepEqual(h.counts(), ['－', '－']);
  assert.match(h.text(), new RegExp(homeReservations.HOME_ERROR_TEXT, 'u'));
  assert.doesNotMatch(h.text(), /予定されている投稿はありません/u);
  reply = ok([row('a')]);
  labelled(h.render(), 'ActionButton', 'もう一度読み込む').onPress();
  await h.update();
  assert.deepEqual(h.counts(), ['1件', '0件']);
  assert.equal(labelled(h.render(), 'ActionButton', 'もう一度読み込む'), null);
});

test('a read that fails after a good one drops the old number', async () => {
  let reply = ok([row('a')]);
  const h = await home({ reply: () => reply });
  assert.deepEqual(h.counts(), ['1件', '0件']);
  reply = 'lost';
  await h.refocus();
  assert.deepEqual(h.counts(), ['－', '－']);
});

test('401: no number, the login is named, and no further read with that token; a new token reads again', async () => {
  let reply = no(401, 'AUTH_REQUIRED');
  const h = await home({ reply: () => reply });
  assert.deepEqual(h.counts(), ['－', '－']);
  assert.match(h.text(), new RegExp(homeReservations.HOME_LOGIN_TEXT, 'u'));
  const reads = h.lists();
  await h.refocus();
  assert.equal(h.lists(), reads);
  reply = ok([row('a')]);
  h.world.token = jwt('person-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2');
  await h.update();
  assert.equal(h.lists(), reads + 1);
  assert.deepEqual(h.counts(), ['1件', '0件']);
});

test('no login: nothing is asked and the login is named, not 「読み込み中」', async () => {
  const h = await home();
  const reads = h.lists();
  h.world.token = null;
  await h.update();
  assert.equal(h.lists(), reads);
  assert.deepEqual(h.counts(), ['－', '－']);
  assert.match(h.text(), new RegExp(homeReservations.HOME_LOGIN_TEXT, 'u'));
});

test('an account that is not the person\'s own (S-5: G3 would answer 200 and no rows): not asked, no 「0件」', async () => {
  const h = await home({ account: { ...ACCOUNT, brandId: 'someone_else' } });
  assert.equal(h.lists(), 0);
  assert.deepEqual(h.counts(), ['－', '－']);
  assert.match(h.text(), new RegExp(homeReservations.HOME_NO_ACCESS_TEXT, 'u'));
});

test('the workspace still being prepared is loading, not 「確認できません」; a 404 from the server is no access', async () => {
  const h = await home({ workspace: { kind: 'preparing' } });
  assert.equal(h.lists(), 0);
  assert.deepEqual(h.counts(), ['－', '－']);
  assert.doesNotMatch(h.text(), new RegExp(homeReservations.HOME_NO_ACCESS_TEXT, 'u'));
  const denied = await home({ reply: () => no(404, 'POSTONA_RESV_ACCOUNT_NOT_FOUND') });
  assert.deepEqual(denied.counts(), ['－', '－']);
  assert.match(denied.text(), new RegExp(homeReservations.HOME_NO_ACCESS_TEXT, 'u'));
});

test('A-B-A: a late answer for the account left behind is not B\'s number; another person never sees the first one\'s', async () => {
  const held = [];
  const h = await home({ reply: (call) => (call.body.payload?.socialAccountId === ACCOUNT.id && held.length === 0 ? new Promise((resolve) => { held.push(resolve); }) : ok([row('b1'), row('b2')])) });
  assert.equal(held.length, 1, 'the read for A is out');
  h.world.account = OTHER_ACCOUNT;
  await h.update();
  assert.deepEqual(h.counts(), ['2件', '0件']);
  held[0](ok([row('a1'), row('a2'), row('a3')]));
  await h.update();
  assert.deepEqual(h.counts(), ['2件', '0件'], 'A\'s late answer changes nothing');
  h.world.reply = () => new Promise(() => {});
  h.world.account = ACCOUNT;
  await h.update();
  assert.deepEqual(h.counts(), ['－', '－'], 'back on A: nothing shown from B');
  h.world.userId = 'person-2';
  h.world.token = jwt('person-2', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');
  await h.update();
  assert.deepEqual(h.counts(), ['－', '－']);
});

test('a return to the home reads again: a row cancelled elsewhere leaves the count; the first arrival reads once', async () => {
  let rows = [row('a'), row('b')];
  const h = await home({ reply: () => ok(rows) });
  assert.equal(h.lists(), 1);
  assert.deepEqual(h.counts(), ['2件', '0件']);
  rows = [row('a'), row('b', { status: 'cancelled' })];
  await h.refocus();
  assert.equal(h.lists(), 2);
  assert.deepEqual(h.counts(), ['1件', '0件']);
});

test('a row refused an edit is 要確認 and never the next post; with nothing else the home says to check, not 「ありません」', async () => {
  signal.markXRowNotEditable('t38-refused');
  const h = await home({ reply: () => ok([row('t38-refused')]) });
  assert.deepEqual(h.counts(), ['0件', '1件']);
  assert.doesNotMatch(h.text(), /body t38-refused|予定されている投稿はありません/u);
  assert.match(h.text(), new RegExp(homeReservations.HOME_NEEDS_CHECK_TEXT, 'u'));
});

test('the counts: a send-now row is no reservation; an overdue planned row and a failed one are 要確認; final rows are in neither; an AI slot is counted but not next', async () => {
  const now = Date.now();
  const of = (rows, notEditable = () => false) => homeReservations.homeReservationsOf({ state: 'ready', rows }, notEditable, now, reservationErrorAction);
  const count = (view) => [view.total, view.upcomingCount, view.attentionCount, view.next?.reservationId ?? null];
  assert.deepEqual(count(of([row('now', { draftId: 'single:1' })])), [0, 0, 0, null]);
  assert.deepEqual(count(of([row('late', { scheduledAt: inDays(-1) })])), [1, 0, 1, null]);
  assert.deepEqual(count(of([row('f', { status: 'failed' }), row('u', { status: 'uncertain' })])), [2, 0, 2, null]);
  assert.deepEqual(count(of([row('p', { status: 'published' }), row('c', { status: 'cancelled' }), row('e', { status: 'expired' })])), [3, 0, 0, null]);
  assert.deepEqual(count(of([row('ai', { consentState: 'ai_owner_opt_in', body: null })])), [1, 1, 0, null]);
  assert.deepEqual(count(of([row('cl', { status: 'claimed', scheduledAt: inDays(-1) })])), [1, 1, 0, null]);
  assert.deepEqual(count(of([row('x', { status: 'mystery' })])), [1, 0, 1, null], 'an unknown status is to be checked');
  assert.deepEqual(count(of([row('later', { scheduledAt: inDays(8) }), row('sooner', { scheduledAt: inDays(2) })])), [2, 2, 0, 'sooner']);
  assert.deepEqual(count(of([row('r')], (id) => id === 'r')), [1, 0, 1, null]);
});

test('with the older scheduled posts: the numbers add up, the earlier one is next; posts not readable means no number', async () => {
  const post = { id: 'p1', accountId: ACCOUNT.id, scheduledAt: inDays(1), status: 'scheduled', text: 'older post' };
  const failed = { id: 'p2', accountId: ACCOUNT.id, scheduledAt: inDays(-2), status: 'failed', text: 'x' };
  const h = await home({ reply: () => ok([row('a', { scheduledAt: inDays(4) })]), data: { plannedPosts: [post], history: [failed] } });
  assert.deepEqual(h.counts(), ['2件', '1件']);
  assert.match(h.text(), /older post/u);
  assert.doesNotMatch(h.text(), /body a/u);
  const sooner = await home({ reply: () => ok([row('a', { scheduledAt: inDays(0.5) })]), data: { plannedPosts: [post] } });
  assert.match(sooner.text(), /body a/u);
  assert.doesNotMatch(sooner.text(), /older post/u);
  assert.equal(homeReservations.homeCount(null, { kind: 'ready', total: 1, upcomingCount: 1, attentionCount: 0, next: null }, 'upcomingCount'), null);
});

test('gate OFF (G3\'s constant) and the sample data: nothing read, no token, no new text, the home as before', async () => {
  assert.equal(reservationStore.POSTONA_RESERVATION_PERSISTENCE_ENABLED, false);
  const off = await home({ gate: reservationStore.POSTONA_RESERVATION_PERSISTENCE_ENABLED });
  await off.refocus();
  assert.deepEqual([off.world.calls.length, off.world.sessionReads], [0, 0]);
  assert.deepEqual(off.counts(), ['0件', '0件']);
  assert.match(off.text(), /予定されている投稿はありません/u);
  const sample = await home({ status: 'mock_preview' });
  assert.equal(sample.world.calls.length, 0);
  assert.doesNotMatch(sample.text(), /要確認を除く候補・投稿の保証なし/u);
  const threads = await home({ account: { ...ACCOUNT, platform: 'threads' } });
  assert.equal(threads.world.calls.length, 0);
  assert.doesNotMatch(threads.text(), /要確認を除く候補・投稿の保証なし/u);
  assert.deepEqual(threads.counts(), ['0件', '0件']);
});

test('S-7: 接続済みデータ is not green for an unverified X connection, including after the restart signal is lost', async () => {
  const ready = dataView.statusHeadline('ready');
  assert.deepEqual(homeReservations.homeHeadline(ready, 'success'), ready);
  const shown = homeReservations.homeHeadline(ready, 'warning');
  assert.equal(shown.tone, 'loading');
  assert.doesNotMatch(shown.label, /接続済み/u);
  const attention = dataView.statusHeadline('error');
  assert.deepEqual(homeReservations.homeHeadline(attention, 'warning'), attention, 'only the green one changes');
  signal.markXServiceRestarted('person-1');
  const h = await home({ reply: () => ok([]) });
  assert.doesNotMatch(h.text(), /接続済みデータ/u);
  assert.match(h.text(), /Xの接続は要確認/u);
  signal.clearXServiceRestarted('person-1');
  const fine = await home({ reply: () => ok([]) });
  assert.doesNotMatch(fine.text(), /接続済みデータ/u);
  assert.match(fine.text(), /現在の接続は未確認/u);
});

test('T39 the home: a row of an earlier generation is 要確認 and never next; an unknown next row says so; a current one does not add a line', async () => {
  const rows = [row('old', { scheduledAt: inDays(2) }), row('now', { scheduledAt: inDays(4) })];
  const h = await home({ reply: () => ok(rows) });
  h.world.generations = { old: 'earlier', now: 'current' };
  await h.refocus();
  assert.deepEqual(h.counts(), ['1件', '1件']);
  assert.match(h.text(), /body now/u);
  assert.doesNotMatch(h.text(), /body old/u);
  assert.doesNotMatch(h.text(), new RegExp(xRowGeneration.CURRENT_TEXT, 'u'), 'the home says no promise already');
  h.world.generations = { old: 'earlier' };
  await h.refocus();
  assert.match(h.text(), new RegExp(xRowGeneration.UNKNOWN_TEXT, 'u'));
  h.world.generations = { old: 'earlier', now: 'earlier' };
  await h.refocus();
  assert.deepEqual(h.counts(), ['0件', '2件']);
  assert.match(h.text(), new RegExp(homeReservations.HOME_NEEDS_CHECK_TEXT, 'u'));
});

// --- The real card (S-2) ---
test('H5 S7: a cold start without any restart signal never proves the current X connection', async () => {
  const h = await home({ reply: () => ok([row('old')]) });
  h.world.generations = { old: 'earlier' };
  await h.refocus();
  assert.doesNotMatch(h.text(), /^接続済み$|接続済みデータ/mu);
  assert.match(h.text(), /現在の接続は未確認/u);
  // Reconnecting may leave old rows behind: neither earlier nor current authorizes an account.
  h.world.generations = { old: 'current' };
  await h.refocus();
  assert.doesNotMatch(h.text(), /^接続済み$|接続済みデータ/mu);
});

test('H5 U2: earlier reservations stay saved and visible, but never overlap upcoming candidates', () => {
  const rows = [row('old', { connectionGeneration: 'earlier' }), row('new', { connectionGeneration: 'current' })];
  const v = homeReservations.homeReservationsOf({ state: 'ready', rows }, () => false, Date.now(), reservationErrorAction);
  assert.deepEqual([v.total, v.upcomingCount, v.attentionCount, v.next?.reservationId], [2, 1, 1, 'new']);
});

async function cardOf(props) {
  const card = await load('../src/features/schedule/server-reservation-card.tsx', {
    'react/jsx-runtime': jsxRuntime, 'react-native': { Text: 'Text', TextInput: 'TextInput', View: 'View' }, '@/constants/theme': { colors: {} },
    '@/components/ui': { Card: 'Card', Pill: 'Pill', styles: {} }, '@/domain/reservation-flow': reservationFlow, '@/domain/schedule-planner': planner,
    '@/features/schedule/preview-card': {}, '@/features/schedule/schedule-composer': { SmallButton: 'SmallButton' },
  });
  const noop = () => {};
  return card.ServerReservationCard({ row: row('c'), account: null, busy: false, retiming: null, onRetime: noop, onRetimeChange: noop, onRetimeApply: noop, onRetimeCancel: noop, onReconfirm: noop, onCancel: noop, ...props });
}
const offered = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'SmallButton') out.push(n.props.label); if (n.type === 'TextInput') out.push('input'); }); return out; };
const OPEN = { date: '2026-12-03', time: '09:03' };

test('S-2 the card: only what can still be done is offered', async () => {
  assert.deepEqual(offered(await cardOf({})), ['日時を変更', '予約を取り消す']);
  assert.deepEqual(offered(await cardOf({ retiming: OPEN })), ['input', 'input', '予約の日時を変更する', 'やめる', '予約を取り消す']);
  const refused = { label: '変更できない予約', text: 't' };
  assert.deepEqual(offered(await cardOf({ retiming: OPEN, notEditable: refused })), ['予約を取り消す'], 'refused, with the editor as G2 saw it (S16)');
  assert.deepEqual(offered(await cardOf({ retiming: OPEN, canEdit: false })), ['予約を取り消す'], 'every write refused');
  const reconfirm = row('c', { consentState: 'needs_reconfirm' });
  assert.deepEqual(offered(await cardOf({ row: reconfirm })), ['日時を変更', 'この内容で再確認', '予約を取り消す']);
  assert.deepEqual(offered(await cardOf({ row: reconfirm, canEdit: false })), ['予約を取り消す']);
  assert.deepEqual(offered(await cardOf({ row: row('c', { status: 'cancelled' }), retiming: OPEN })), [], 'a final row has no editor left open');
});

test('T39 the card: the generation line beside a planned row that is not refused only', async () => {
  const lines = async (props) => { const out = []; walk(await cardOf(props), (n) => { if (n.type === 'Text' && n.props.children === 'NOTE') out.push(n); }); return out.length; };
  assert.equal(await lines({ generationNote: 'NOTE' }), 1);
  assert.equal(await lines({ generationNote: 'NOTE', notEditable: { label: 'l', text: 't' } }), 0);
  assert.equal(await lines({ generationNote: 'NOTE', row: row('c', { status: 'published' }) }), 0);
  assert.equal(await lines({}), 0);
});

test('use-refocus-count: the first arrival is no return', async () => {
  let focus = null; let value = 0; let ran = false; const ref = { current: false };
  const module = await load('../src/features/reservations/use-refocus-count.ts', {
    react: { useState: () => [value, (next) => { value = typeof next === 'function' ? next(value) : next; }], useRef: () => ref, useCallback: (callback) => callback },
    'expo-router': { useFocusEffect: (callback) => { focus = callback; if (!ran) { ran = true; callback(); } } },
  });
  assert.equal(module.useRefocusCount(), 0);
  assert.equal(value, 0);
  focus();
  assert.equal(module.useRefocusCount(), 1);
});
