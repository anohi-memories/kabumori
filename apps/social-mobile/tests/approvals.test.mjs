// G1 TASK 44: the approval and notification screens, their hooks and the approval client over a scripted stand-in of G3's API
// (docs/postona/g3-approval-notification-contract-20261105.md). Only the stand-in answers: the real network is closed in every test.
// The real local Edge twin + Postgres run is tests/local-stack/approvals.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as client from '../src/features/approvals/approval-client.ts';
import * as view from '../src/features/approvals/approval-view.ts';
import { button, field, has, mountApprovals, pressables, sha, texts } from './approvals-harness.mjs';

const REAL_FETCH = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = REAL_FETCH; });

const WS = 'u_0123456789abcdef01234567';
const ACCOUNT = { id: 'sa_0123456789abcdef01234567', brandId: WS, platform: 'x', connectionStatus: 'connected', profile: { handle: '@me', displayName: 'me' } };
const A = { token: 'jwt-a', userId: 'person-a' };
const B = { token: 'jwt-b', userId: 'person-b' };
const inDays = (d) => new Date(Date.now() + d * 864e5);
const jstText = (date) => { const j = new Date(date.getTime() + 9 * 3600e3); return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}-${String(j.getUTCDate()).padStart(2, '0')} ${String(j.getUTCHours()).padStart(2, '0')}:${String(j.getUTCMinutes()).padStart(2, '0')}`; };

// ---- a stand-in for G3's API, as the contract describes it --------------------------------------------------------------------------
function g3() {
  const s = { calls: [], requests: [], candidates: new Map(), notes: [], generation: 1, reservations: 0, inject: {}, after: {}, tokens: { 'jwt-a': 'person-a', 'jwt-b': 'person-b' }, n: 0 };
  const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const dto = (c) => ({ candidateId: c.candidateId, socialAccountId: c.socialAccountId, body: c.body, contentSha256: c.contentSha256, scheduledAt: c.scheduledAt, state: c.state, revision: c.revision, reservationId: c.reservationId, decidedAt: c.decidedAt, createdAt: c.createdAt });
  const note = (owner, kind, c) => s.notes.push({ owner, notificationId: `n-${++s.n}`, kind, candidateId: c.candidateId, reservationId: c.reservationId, subjectRevision: c.revision, state: c.state, scheduledAt: c.scheduledAt, createdAt: new Date(Date.UTC(2026, 10, 6, 3, 0, s.n)).toISOString(), readAt: null });
  const mine = (who, id) => { const c = s.candidates.get(id); return c && c.owner === who ? c : null; };
  const actions = {
    submit: (who, p) => {
      const same = [...s.candidates.values()].find((c) => c.owner === who && c.request === p.clientRequestId);
      if (same) return same.body === p.body && same.scheduledAt === p.scheduledAt ? out(200, { ok: true, candidates: [dto(same)] }) : out(409, { ok: false, code: 'POSTONA_RESV_IDEMPOTENCY_CONFLICT' });
      const c = { owner: who, request: p.clientRequestId, candidateId: `00000000-0000-4000-9000-${String(s.candidates.size + 1).padStart(12, '0')}`, socialAccountId: p.socialAccountId, body: p.body, contentSha256: sha(p.body), scheduledAt: p.scheduledAt, state: 'pending_approval', revision: 1, reservationId: null, decidedAt: null, createdAt: new Date(Date.UTC(2026, 10, 6, 2, 0, s.candidates.size)).toISOString(), gen: s.generation };
      s.candidates.set(c.candidateId, c); note(who, 'approval_requested', c);
      return out(200, { ok: true, candidates: [dto(c)] });
    },
    revise: (who, p) => {
      const c = mine(who, p.candidateId); if (!c) return out(404, { ok: false, code: 'POSTONA_RESV_NOT_FOUND' });
      if (c.state !== 'pending_approval') return out(409, { ok: false, code: 'POSTONA_RESV_APPROVAL_NOT_PENDING' });
      if (c.revision !== p.expectedRevision) return out(409, { ok: false, code: 'POSTONA_RESV_STALE_REVISION' });
      Object.assign(c, { body: p.body, contentSha256: sha(p.body), scheduledAt: p.scheduledAt, revision: c.revision + 1, gen: s.generation }); note(who, 'approval_requested', c);
      return out(200, { ok: true, candidates: [dto(c)] });
    },
    approve: (who, p) => {
      const c = mine(who, p.candidateId); if (!c) return out(404, { ok: false, code: 'POSTONA_RESV_NOT_FOUND' });
      if (c.state === 'approved' && c.revision === p.expectedRevision) return out(200, { ok: true, candidates: [dto(c)] });
      if (c.state !== 'pending_approval') return out(409, { ok: false, code: 'POSTONA_RESV_APPROVAL_NOT_PENDING' });
      if (c.revision !== p.expectedRevision) return out(409, { ok: false, code: 'POSTONA_RESV_STALE_REVISION' });
      if (c.contentSha256 !== p.contentSha256) return out(422, { ok: false, code: 'POSTONA_RESV_CONSENT_REQUIRED' });
      if (c.gen !== s.generation) return out(409, { ok: false, code: 'POSTONA_RESV_APPROVAL_GENERATION_CHANGED' });
      Object.assign(c, { state: 'approved', reservationId: `resv-${++s.reservations}`, decidedAt: '2026-11-06T04:00:00.000Z' }); note(who, 'approval_approved', c);
      return out(200, { ok: true, candidates: [dto(c)] });
    },
    reject: (who, p) => {
      const c = mine(who, p.candidateId); if (!c) return out(404, { ok: false, code: 'POSTONA_RESV_NOT_FOUND' });
      if (c.state !== 'pending_approval') return out(409, { ok: false, code: 'POSTONA_RESV_APPROVAL_NOT_PENDING' });
      if (c.revision !== p.expectedRevision) return out(409, { ok: false, code: 'POSTONA_RESV_STALE_REVISION' });
      Object.assign(c, { state: 'rejected', decidedAt: '2026-11-06T04:00:00.000Z' }); note(who, 'approval_rejected', c);
      return out(200, { ok: true, candidates: [dto(c)] });
    },
    get: (who, p) => { const c = mine(who, p.candidateId); return c ? out(200, { ok: true, candidates: [dto(c)] }) : out(404, { ok: false, code: 'POSTONA_RESV_NOT_FOUND' }); },
    list: (who, p) => out(200, { ok: true, candidates: [...s.candidates.values()].filter((c) => c.owner === who && c.socialAccountId === p.socialAccountId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(dto) }),
    notifications: (who) => out(200, { ok: true, notifications: s.notes.filter((n) => n.owner === who).slice().reverse().map(({ owner: _o, ...n }) => n) }),
    markRead: (who, p) => { const n = s.notes.find((x) => x.owner === who && x.notificationId === p.notificationId); if (!n) return out(404, { ok: false, code: 'POSTONA_RESV_NOT_FOUND' }); n.readAt ??= '2026-11-06T05:00:00.000Z'; const { owner: _o, ...rest } = n; return out(200, { ok: true, notifications: [rest] }); },
  };
  s.fetch = async (url, init) => {
    const { action, payload } = JSON.parse(init.body);
    s.calls.push(action);
    s.requests.push({ url, init, action, payload });
    const who = s.tokens[(init.headers.authorization ?? '').replace(/^Bearer /u, '')];
    const queued = s.inject[action]?.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return out(queued.status, queued.body);
    const answer = who ? actions[action](who, payload) : out(401, { ok: false, code: 'AUTH_REQUIRED' });
    if (s.after[action]?.shift()) throw new TypeError('Network request failed');   // the server did it; the answer is lost
    return answer;
  };
  s.count = (action) => s.calls.filter((c) => c === action).length;
  return s;
}

async function mount(options = {}) {
  const srv = options.srv ?? g3();
  const h = await mountApprovals({ session: A, workspace: { kind: 'ready', workspaceId: WS }, account: ACCOUNT, fetch: srv.fetch, ...options });
  return { ...h, srv };
}
async function submitOne(h, body = '新メニューのお知らせです', when = inDays(3)) {
  await h.type('投稿候補の本文', body);
  await h.type('投稿候補の日時', jstText(when));
  return h.press('承認に回す');
}

// ---- the client ---------------------------------------------------------------------------------------------------------------------
test('client: https only (loopback http only for tests), the public key only, no token = no request; the request carries the token and key', async () => {
  const ok = { supabaseUrl: 'https://proj.example.test', publishableKey: 'sb_publishable_testkey01', accessToken: async () => 'tok', fetch: async () => new Response('{}') };
  assert.throws(() => client.createApprovalClient({ ...ok, supabaseUrl: 'http://proj.example.test' }), /HTTPS/u);
  assert.throws(() => client.createApprovalClient({ ...ok, supabaseUrl: 'http://127.0.0.1:54321' }), /HTTPS/u);
  assert.doesNotThrow(() => client.createApprovalClient({ ...ok, supabaseUrl: 'http://127.0.0.1:54321', allowLoopbackHttpForTests: true }));
  assert.throws(() => client.createApprovalClient({ ...ok, publishableKey: 'sb_secret_abcdefghij' }), /PUBLIC/u);
  let sent = 0;
  const none = client.createApprovalClient({ ...ok, accessToken: async () => null, fetch: async () => { sent += 1; return new Response('{}'); } });
  assert.deepEqual(await none.list('sa_x'), { ok: false, code: 'AUTH_REQUIRED', status: 401, definite: true });
  assert.equal(sent, 0);
  let seen;
  const c = client.createApprovalClient({ ...ok, fetch: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ ok: true, candidates: [] }), { status: 200 }); } });
  assert.deepEqual(await c.list('sa_x'), { ok: true, value: [] });
  assert.equal(seen.url, 'https://proj.example.test/functions/v1/postona-x-approvals');
  assert.deepEqual([seen.init.method, seen.init.redirect, seen.init.headers.authorization, seen.init.headers.apikey], ['POST', 'error', 'Bearer tok', 'sb_publishable_testkey01']);
  assert.deepEqual(JSON.parse(seen.init.body), { action: 'list', payload: { socialAccountId: 'sa_x' } });
});

test('client: a 4xx with a code is definite; a 5xx, a network failure, a non-JSON or off-contract 200 are UNCERTAIN (read back, never shown as a result)', async () => {
  const at = (respond) => client.createApprovalClient({ supabaseUrl: 'https://p.example.test', publishableKey: 'sb_publishable_testkey01', accessToken: async () => 't', fetch: respond });
  const r = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  assert.deepEqual(await at(r(409, { ok: false, code: 'POSTONA_RESV_STALE_REVISION' })).get('c'), { ok: false, code: 'POSTONA_RESV_STALE_REVISION', status: 409, definite: true });
  assert.deepEqual(await at(r(503, { ok: false, code: 'STORE_UNAVAILABLE' })).get('c'), { ok: false, code: 'STORE_UNAVAILABLE', status: 503, definite: false });
  assert.deepEqual(await at(async () => { throw new TypeError('offline'); }).get('c'), { ok: false, code: 'UNCERTAIN', status: 0, definite: false });
  assert.deepEqual(await at(r(200, 'not json')).get('c'), { ok: false, code: 'UNCERTAIN', status: 200, definite: false });
  assert.equal((await at(r(200, { ok: true, candidates: [{ candidateId: 'c', body: 'x' }] })).get('c')).code, 'UNCERTAIN', 'not a candidate');
  assert.equal((await at(r(200, { ok: true, candidates: [] })).get('c')).code, 'UNCERTAIN', 'get is exactly one');
  assert.equal((await at(r(400, 'oops')).get('c')).definite, false, 'a 4xx without the contract body is not trusted');
});

test('view: every code of the contract has an action and words; only sign-in / forbidden drop what is held; the badge is unread rows; no push is claimed', () => {
  const codes = { AUTH_REQUIRED: 'sign_in', POSTONA_RESV_AUTH_REQUIRED: 'sign_in', POSTONA_RESV_SERVICE_NOT_ACTIVE: 'forbidden', POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED: 'reconnect_x', POSTONA_RESV_NOT_FOUND: 'not_found', POSTONA_RESV_ACCOUNT_NOT_FOUND: 'not_found',
    POSTONA_RESV_STALE_REVISION: 'reread', POSTONA_RESV_APPROVAL_NOT_PENDING: 'reread', POSTONA_RESV_APPROVAL_GENERATION_CHANGED: 'generation_changed', POSTONA_RESV_SLOT_CONFLICT: 'change_time', POSTONA_RESV_DAILY_CAPACITY: 'change_time',
    POSTONA_RESV_MONTHLY_CAPACITY: 'change_time', POSTONA_RESV_APPROVAL_CAPACITY: 'change_time', POSTONA_RESV_CONSENT_REQUIRED: 'show_again', POSTONA_RESV_TEXT_INVALID: 'fix_input', POSTONA_RESV_TIME_OUT_OF_RANGE: 'fix_input', POSTONA_RESV_REQUEST_INVALID: 'fix_input' };
  for (const [code, action] of Object.entries(codes)) assert.equal(view.actionOf(code, true), action, code);
  for (const code of ['NOT_AVAILABLE', 'STORE_UNAVAILABLE', 'AUTH_UNAVAILABLE', 'POSTONA_RESV_SERVICE_BUSY']) assert.equal(view.actionOf(code, false), 'later', code);
  assert.equal(view.actionOf('SOMETHING_NEW', true), 'uncertain');
  assert.equal(view.actionOf('POSTONA_RESV_STALE_REVISION', false), 'uncertain', 'not trusted unless definite');
  for (const action of Object.values(codes)) assert.ok(view.ACTION_TEXT[action].length > 10);
  assert.deepEqual(['reread', 'generation_changed', 'show_again', 'uncertain', 'later', 'change_time'].map(view.rereads), [true, true, true, true, true, true]);
  assert.deepEqual(['sign_in', 'forbidden', 'not_found', 'fix_input', 'reconnect_x'].map(view.rereads), [false, false, false, false, false]);
  assert.equal(view.unreadCount([{ readAt: null }, { readAt: 'x' }, { readAt: null }]), 2);
  assert.match(view.PUSH_NOTE, /プッシュ）はまだ送られません/u);
});

// ---- nothing is sent before the person may use it ----------------------------------------------------------------------------------
test('gate OFF (the source constant), sample data, no config, signed out, workspace not ready, no / another X account: the reason, no request', async () => {
  for (const [options, block] of [[{ gate: false }, 'off'], [{ status: 'mock_preview' }, 'preview'], [{ config: { ok: false } }, 'unconfigured'], [{ config: { ok: true, config: { url: 'http://proj.example.test', publishableKey: 'sb_publishable_testkey01' } } }, 'unconfigured'],
    [{ session: null }, 'signed_out'], [{ workspace: { kind: 'preparing' } }, 'workspace_preparing'], [{ workspace: { kind: 'relogin' } }, 'relogin'], [{ account: null }, 'no_x_account'], [{ account: { ...ACCOUNT, platform: 'threads' } }, 'no_x_account'],
    [{ account: { ...ACCOUNT, brandId: 'team_brand' } }, 'other_workspace']]) {
    const h = await mount(options);
    const tree = await h.render();
    assert.ok(has(tree, view.APPROVAL_BLOCK_TEXT[block]), block);
    assert.equal(button(tree, '承認に回す'), undefined, block);
    assert.equal(h.srv.calls.length, 0, block);
  }
  const gate = await readFile(new URL('../src/features/approvals/approval-gate.ts', import.meta.url), 'utf8');
  assert.match(gate, /export const POSTONA_APPROVAL_UI_ENABLED = false;/u);
  assert.match(gate, /functionName: APPROVAL_FUNCTION, allowLoopbackHttpForTests: false/u);
});

// ---- submit / approve / reject / revise ------------------------------------------------------------------------------------------------
test('承認に回す: a pending candidate, no reservation; the inputs clear; the composer refuses a bad time before sending', async () => {
  const h = await mount();
  assert.ok(has(await h.render(), '投稿候補はまだありません'));
  await h.type('投稿候補の本文', '本文');
  await h.type('投稿候補の日時', '来週');
  let tree = await h.press('承認に回す');
  assert.ok(has(tree, '日時は「2026-11-01 09:30」の形で'));
  assert.equal(h.srv.count('submit'), 0);
  tree = await submitOne(h);
  assert.ok(has(tree, view.SUBMITTED_TEXT));
  assert.ok(has(tree, '承認待ち'));
  assert.equal(h.srv.reservations, 0, 'nothing to send before the approval');
  assert.equal(field(tree, '投稿候補の本文').value, '');
  assert.deepEqual(Object.keys(h.srv.requests.find((r) => r.action === 'submit').payload).sort(), ['body', 'clientRequestId', 'scheduledAt', 'socialAccountId']);
});

test('承認に回す, answer lost and the list cannot tell: 「確認できませんでした」; the next press is the same request id; one candidate', async () => {
  // G1 TASK 45: when the refresh can read the list, it tells (see T45 below); here it cannot, so the press-again path is what is left
  const srv = g3(); srv.after.submit = [true]; srv.inject.list = [undefined, new TypeError('offline')];
  const h = await mount({ srv });
  await h.render();
  let tree = await submitOne(h);
  assert.ok(has(tree, view.SUBMIT_PENDING_TEXT));
  tree = await h.press('承認に回す');
  const ids = srv.requests.filter((r) => r.action === 'submit').map((r) => r.payload.clientRequestId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], 'the same intent, the same id');
  assert.equal(srv.candidates.size, 1);
  assert.ok(has(tree, view.SUBMITTED_TEXT));
});

test('承認: the shown revision and the hash of the shown text; then 予約に登録済み and the way to 予約の管理', async () => {
  const h = await mount();
  await h.render();
  await submitOne(h, '承認する本文');
  await h.open('投稿候補 ');
  let tree = await h.press('承認する');
  assert.ok(has(tree, view.APPROVED_TEXT));
  assert.ok(has(tree, '承認済み（予約に登録済み）'));
  const sent = h.srv.requests.find((r) => r.action === 'approve').payload;
  assert.deepEqual(sent, { candidateId: [...h.srv.candidates.keys()][0], expectedRevision: 1, contentSha256: sha('承認する本文') });
  assert.equal(h.srv.reservations, 1);
  tree = await h.press('予約の管理を開く');
  assert.deepEqual(h.world.pushes, ['/reservations']);
});

test('the shown text must be what the server hashed: a mismatch sends no approval', async () => {
  const srv = g3();
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, '正しい本文');
  const c = [...srv.candidates.values()][0];
  srv.inject.list = [{ status: 200, body: { ok: true, candidates: [{ ...Object.fromEntries(Object.entries(c).filter(([k]) => !['owner', 'request', 'gen'].includes(k))), body: '画面だけ違う本文' }] } }];
  h.world.refocus += 1;
  await h.render();
  await h.open('投稿候補 ');
  const tree = await h.press('承認する');
  assert.ok(has(tree, view.HASH_MISMATCH_TEXT));
  assert.equal(srv.count('approve'), 0);
});

test('G4 reconnect / service restart after submit: 409 APPROVAL_GENERATION_CHANGED -> read back -> 「修正して承認に回し直す」 -> approve under the current connection', async () => {
  const srv = g3();
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, '再接続の前の本文');
  srv.generation += 1;
  await h.open('投稿候補 ');
  let tree = await h.press('承認する');
  assert.ok(has(tree, view.ACTION_TEXT.generation_changed));
  assert.equal(srv.reservations, 0);
  assert.ok(srv.calls.includes('get'), 'read back before saying anything');
  tree = await h.press('修正して承認に回し直す');
  assert.ok(has(tree, view.REVISED_TEXT));
  assert.equal(button(tree, '修正して承認に回し直す'), undefined);
  const revised = srv.requests.find((r) => r.action === 'revise').payload;
  assert.equal(revised.body, '再接続の前の本文', 'the same content, under the current connection');
  tree = await h.press('承認する');
  assert.ok(has(tree, view.APPROVED_TEXT));
  assert.equal(srv.requests.filter((r) => r.action === 'approve').at(-1).payload.expectedRevision, 2);
  assert.equal(srv.reservations, 1);
});

test('conflicts are read back, never retried on their own: a stale revision shows the newer text; an answer lost after the approve shows the server\'s result', async () => {
  const srv = g3();
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, '最初の本文');
  const c = [...srv.candidates.values()][0];
  Object.assign(c, { body: '別の端末で直した本文', contentSha256: sha('別の端末で直した本文'), revision: 2 });
  await h.open('投稿候補 ');
  let tree = await h.press('承認する');
  assert.ok(has(tree, view.ACTION_TEXT.reread));
  assert.ok(has(tree, '別の端末で直した本文'));
  assert.equal(srv.count('approve'), 1, 'not sent again');
  srv.after.approve = [true];
  tree = await h.press('承認する');
  assert.ok(has(tree, view.ACTION_TEXT.uncertain));
  assert.ok(has(tree, '承認済み（予約に登録済み）'), 'the read back says it was approved');
  assert.equal(srv.reservations, 1);
});

test('却下 asks twice; 修正する edits the text and time (revision + 1)', async () => {
  const srv = g3();
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, '直す前');
  await h.open('投稿候補 ');
  await h.press('修正する');
  await h.type('修正する本文', '直した後');
  let tree = await h.press('修正を保存');
  assert.ok(has(tree, view.REVISED_TEXT));
  assert.ok(has(tree, '直した後'));
  assert.equal([...srv.candidates.values()][0].revision, 2);
  tree = await h.press('却下する');
  assert.equal(srv.count('reject'), 0, 'the first press only asks');
  tree = await h.press('本当に却下する');
  assert.ok(has(tree, view.REJECTED_TEXT));
  assert.ok(has(tree, '却下'));
  assert.equal(button(tree, '承認する'), undefined);
});

// ---- whose candidates ------------------------------------------------------------------------------------------------------------------
test('a 401 / service end drops everything held; user A -> B -> A never shows another person\'s candidate in any frame; sign-out closes', async () => {
  const srv = g3();
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, 'Aだけの本文');
  h.frames.length = 0;
  h.world.session = B;
  let tree = await h.render();
  assert.ok(h.frames.every((f) => !has(f, 'Aだけの本文')), 'B never sees A\'s candidate');
  assert.ok(has(tree, '投稿候補はまだありません'));
  h.world.session = A;
  tree = await h.render();
  assert.ok(has(tree, 'Aだけの本文'));
  srv.inject.list = [{ status: 403, body: { ok: false, code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE' } }];
  h.world.refocus += 1;
  tree = await h.render();
  assert.ok(!has(tree, 'Aだけの本文'));
  assert.ok(has(tree, view.ACTION_TEXT.forbidden));
  srv.tokens['jwt-a'] = undefined;   // the session ended on the server
  tree = await h.press('もう一度読み込む');
  assert.ok(has(tree, view.ACTION_TEXT.sign_in));
  h.world.session = null;
  tree = await h.render();
  assert.ok(has(tree, view.APPROVAL_BLOCK_TEXT.signed_out));
});

// ---- notifications -----------------------------------------------------------------------------------------------------------------
test('notifications: newest first, the unread badge, opening marks read once and goes to the candidate; no push is claimed', async () => {
  const srv = g3();
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, '通知の本文');
  await h.open('投稿候補 ');
  await h.press('承認する');
  let tree = await h.show('notifications');
  assert.ok(has(tree, '未読 2件'));
  assert.ok(has(tree, view.PUSH_NOTE));
  const rows = pressables(tree, 'お知らせ ');
  assert.equal(rows[0].accessibilityLabel, `お知らせ ${view.NOTIFICATION_KIND_TEXT.approval_approved}`, 'newest first');
  assert.ok(!has(tree, '通知の本文'), 'a notification carries no post text');
  rows[0].onPress();
  tree = await h.render();
  assert.ok(has(tree, '未読 1件'));
  assert.deepEqual(JSON.parse(JSON.stringify(h.world.pushes)), [{ pathname: '/approvals', params: { candidate: [...srv.candidates.keys()][0] } }]);
  pressables(tree, 'お知らせ ')[0].onPress();
  await h.render();
  assert.equal(srv.count('markRead'), 1, 'an opened one is not marked again');
  srv.inject.notifications = [{ status: 401, body: { ok: false, code: 'AUTH_REQUIRED' } }];
  tree = await h.press('最新の状態を読み込む');
  assert.equal(pressables(tree, 'お知らせ ').length, 0);
  assert.ok(has(tree, view.ACTION_TEXT.sign_in));
});

test('a notification opened from the list opens its candidate on the approval screen', async () => {
  const srv = g3();
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, '開く候補');
  h.world.params = { candidate: [...srv.candidates.keys()][0] };
  const tree = await h.show('approvals');
  assert.ok(button(tree, '承認する'), 'the candidate is open');
});

test('boundaries: settings opens both screens, the stack registers them; the screens reach the API only through the G1 client; no G3 code, no push', async () => {
  const settings = await readFile(new URL('../src/app/(tabs)/settings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /router\.push\('\/approvals'\)/u);
  assert.match(settings, /router\.push\('\/notifications'\)/u);
  const layout = await readFile(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /name="approvals\/index"/u);
  assert.match(layout, /name="notifications\/index"/u);
  for (const rel of ['../src/app/approvals/index.tsx', '../src/app/notifications/index.tsx', '../src/features/approvals/use-approvals.ts', '../src/features/approvals/use-approval-notifications.ts', '../src/features/approvals/use-approval-env.ts', '../src/features/approvals/approval-client.ts']) {
    const text = await readFile(new URL(rel, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /supabase\/functions|_shared|reservation-store|remote-reservation|expo-notifications|push_outbox|AsyncStorage|SecureStore|console\./u, rel);
  }
});

// ---- G1 TASK 45: G2 #9 P3 -- what a failed read, an unknown outcome and a successful re-read each say ------------------------------------
const CLAIMS_READ = /最新の内容を読み込みました|結果を確認しました/u;

test('T45 A17 notifications: a failed read says it could not read, never that it did; the re-read that works clears it', async () => {
  const srv = g3();
  srv.inject.notifications = [new TypeError('offline')];
  const h = await mount({ srv, screen: 'notifications' });
  let tree = await h.render();
  assert.ok(has(tree, 'お知らせを読み込めませんでした'));
  assert.ok(!texts(tree).some((t) => CLAIMS_READ.test(t)), 'no line claims a read that failed');
  tree = await h.press('もう一度読み込む');
  assert.ok(has(tree, 'お知らせはありません'));
  assert.ok(!has(tree, '読み込めませんでした') && !has(tree, '確認できませんでした'), 'nothing of the failure stays');
});

test('T45 A17 approvals: a failed list read says it could not read; the re-read that works clears it', async () => {
  const srv = g3();
  srv.inject.list = [{ status: 503, body: { ok: false, code: 'STORE_UNAVAILABLE' } }];
  const h = await mount({ srv });
  let tree = await h.render();
  assert.ok(has(tree, '投稿候補を読み込めませんでした'));
  assert.ok(!texts(tree).some((t) => CLAIMS_READ.test(t)));
  tree = await h.press('もう一度読み込む');
  assert.ok(has(tree, '投稿候補はまだありません'));
  assert.ok(!has(tree, '読み込めませんでした'));
});

test('T45 A18 an approve whose answer was lost: read back, the server\'s result, then a later refresh leaves no stale yellow banner', async () => {
  const srv = g3();
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, '答えが消える承認');
  await h.open('投稿候補 ');
  srv.after.approve = [true];
  let tree = await h.press('承認する');
  assert.ok(has(tree, '承認済み（予約に登録済み）'), 'the read back says approved');
  assert.ok(has(tree, view.UNCERTAIN_REREAD_OK_TEXT));
  tree = await h.press('最新の状態を読み込む');
  assert.ok(!has(tree, view.UNCERTAIN_REREAD_OK_TEXT), 'the banner went with the successful refresh');
  assert.equal(srv.reservations, 1, 'one reservation');
  assert.equal(srv.count('approve'), 1, 'not sent again');
});

test('T45 an unknown outcome whose read back fails too: says the latest could not be read (not that it was), and nothing is sent again', async () => {
  const srv = g3();
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, '読み戻しも失敗');
  await h.open('投稿候補 ');
  srv.after.approve = [true];
  srv.inject.get = [new TypeError('offline')];
  let tree = await h.press('承認する');
  assert.ok(has(tree, view.REREAD_FAILED_TEXT));
  assert.ok(!texts(tree).some((t) => CLAIMS_READ.test(t)), 'no claim of a read that failed');
  assert.equal(srv.count('approve'), 1);
  tree = await h.press('最新の状態を読み込む');
  assert.ok(has(tree, '承認済み（予約に登録済み）'));
  assert.ok(!has(tree, view.REREAD_FAILED_TEXT));
  assert.equal(srv.reservations, 1);
});

test('T45 承認に回す, answer lost: the refresh finds it -> 「承認に回せていました」, no second candidate; not found -> the press-again text stays', async () => {
  const srv = g3(); srv.after.submit = [true];
  const h = await mount({ srv });
  await h.render();
  let tree = await submitOne(h, '答えが消えた候補');
  assert.ok(has(tree, view.SUBMIT_CONFIRMED_TEXT), 'the list read after the lost answer shows it was made');
  assert.ok(!has(tree, view.SUBMIT_PENDING_TEXT));
  assert.equal(srv.candidates.size, 1);
  const other = g3(); other.inject.submit = [new TypeError('offline')];
  const h2 = await mount({ srv: other });
  await h2.render();
  tree = await submitOne(h2, '届かなかった候補');
  assert.ok(has(tree, view.SUBMIT_PENDING_TEXT), 'not made: the press-again words stay after the refresh');
  assert.equal(other.candidates.size, 0);
});

test('T45 a banner of person A is not shown to B, nor restored when A comes back', async () => {
  const srv = g3();
  srv.inject.list = [undefined, { status: 503, body: { ok: false, code: 'STORE_UNAVAILABLE' } }];
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, 'Aの候補');
  assert.ok(has(h.once(), view.SUBMITTED_TEXT));
  h.world.session = B;
  let tree = await h.render();
  assert.ok(!has(tree, view.SUBMITTED_TEXT));
  h.world.session = A;
  tree = await h.render();
  assert.ok(!has(tree, view.SUBMITTED_TEXT), 'not restored');
});

test('T45 runner: the G1 runner sets G1T39_G3_629=1 itself (the G3 #629 world this tree carries), unless the caller says otherwise', async () => {
  const runner = await readFile(new URL('./local-stack/run-x-disconnected.sh', import.meta.url), 'utf8');
  assert.match(runner, /^export G1T39_G3_629="\$\{G1T39_G3_629:-1\}"$/mu);
});

test('T45 a lost 承認に回す is matched by its own text and time only: another candidate in the list does not count as it', async () => {
  const srv = g3();
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, 'もとからある候補', inDays(2));
  srv.inject.submit = [new TypeError('offline')];
  const tree = await submitOne(h, '届かなかった別の候補', inDays(5));
  assert.ok(has(tree, view.SUBMIT_PENDING_TEXT), 'the press-again words stay');
  assert.ok(!has(tree, view.SUBMIT_CONFIRMED_TEXT));
  assert.equal(srv.candidates.size, 1);
});

test('T45 notifications: a mark-read that failed says so, and the next read that works clears it', async () => {
  const srv = g3();
  const h = await mount({ srv });
  await h.render();
  await submitOne(h, '既読の失敗');
  let tree = await h.show('notifications');
  srv.inject.markRead = [new TypeError('offline')];
  pressables(tree, 'お知らせ ')[0].onPress();
  tree = await h.render();
  assert.ok(has(tree, view.MARK_READ_FAILED_TEXT));
  assert.ok(has(tree, '未読 1件'), 'still unread');
  tree = await h.press('最新の状態を読み込む');
  assert.ok(!has(tree, view.MARK_READ_FAILED_TEXT), 'gone with the successful read');
});
