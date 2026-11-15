// G1-02 TASK 1 (G3-02 #24 / PR #684, contract §5b): the last page. G3's Edge now answers `nextCursor: null` EXACTLY on the last page (a page with
// exactly `limit` rows left, too), so a client never asks for an empty page. These are the REAL hooks, screens and approval client over a scripted
// stand-in of that Edge (`final`) and of PR #677's (`legacy`: a full page always points on), at the sizes that matter: 50 / 51 / 100 / 101 / 150
// / 151 / 279, rows added or removed during a walk, a mark-as-read during a walk, the 20-page cap, the read-only history of an ended service,
// and a page answered after the person changed. React / RN are stubbed; nothing leaves the process. The real Edge + PG17 is
// local-stack/approvals.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as pages from '../src/features/approvals/notification-pages.ts';
import * as view from '../src/features/approvals/approval-view.ts';
import { button, has, mountApprovals, pressables, texts } from './approvals-harness.mjs';
import { mountEndedHistory } from './ended-history-harness.mjs';

const REAL_FETCH = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = REAL_FETCH; });
const WS = 'u_0123456789abcdef01234567';
const ACCOUNT = { id: 'sa_0123456789abcdef01234567', brandId: WS, platform: 'x', connectionStatus: 'connected', profile: { handle: '@me', displayName: 'me' } };
const A = { token: 'jwt-a', userId: 'person-a' };
const B = { token: 'jwt-b', userId: 'person-b' };
const MORE = pages.PAGES_MORE_TEXT;

/**
 * G3 with the paging API. `mode`: 'final' = PR #684 (nextCursor is null exactly when nothing older is left), 'legacy' = PR #677 (a page with
 * exactly `limit` rows always points on). `total` notifications per person: cursor 1..total, the newest has the highest.
 */
function g3(total, { mode = 'final', owners = ['person-a'] } = {}) {
  const s = { calls: [], notes: [], tokens: { 'jwt-a': 'person-a', 'jwt-b': 'person-b' }, held: null, tamper: null };
  const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const make = (owner, i) => ({ owner, notificationId: `${owner}-n-${i}`, kind: 'approval_approved', candidateId: `${owner}-c-${i}`, reservationId: null, subjectRevision: 1, state: null, scheduledAt: null, cursor: i, createdAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), readAt: null });
  for (const owner of owners) for (let i = 1; i <= total; i += 1) s.notes.push(make(owner, i));
  const strip = ({ owner: _o, ...rest }) => rest;
  s.add = (owner, cursor) => { s.notes.push(make(owner, cursor)); };
  s.remove = (owner, cursor) => { s.notes = s.notes.filter((n) => !(n.owner === owner && n.cursor === cursor)); };
  s.hold = () => { let release; s.held = new Promise((resolve) => { release = resolve; }); return () => { s.held = null; release(); }; };
  s.fetch = async (url, init) => {
    const { action, payload } = JSON.parse(init.body);
    const token = (init.headers.authorization ?? '').replace(/^Bearer /u, '');
    s.calls.push({ action, token, payload });
    const who = s.tokens[token];
    if (!who) return out(401, { ok: false, code: 'AUTH_REQUIRED' });
    if (action === 'notifications') {
      const limit = payload.limit ?? 50;
      const below = s.notes.filter((n) => n.owner === who && (payload.before === undefined || n.cursor < payload.before)).sort((a, b) => b.cursor - a.cursor);
      const rows = below.slice(0, limit);
      const more = mode === 'final' ? below.length > limit : rows.length === limit;
      let body = { ok: true, notifications: rows.map(strip), nextCursor: more ? rows[rows.length - 1].cursor : null };
      if (payload.before !== undefined && s.held) await s.held;
      if (s.tamper) body = s.tamper(body, payload) ?? body;
      return out(200, body);
    }
    if (action === 'markRead') { const n = s.notes.find((x) => x.owner === who && x.notificationId === payload.notificationId); if (!n) return out(404, { ok: false, code: 'POSTONA_RESV_NOT_FOUND' }); n.readAt ??= '2026-11-15T00:00:00.000Z'; return out(200, { ok: true, notifications: [strip(n)] }); }
    if (action === 'get') return out(404, { ok: false, code: 'POSTONA_RESV_NOT_FOUND' });
    return out(400, { ok: false, code: 'REQUEST_INVALID' });
  };
  s.count = (action) => s.calls.filter((c) => c.action === action).length;
  s.pageCalls = () => s.calls.filter((c) => c.action === 'notifications').map((c) => [c.payload.limit, c.payload.before ?? null]);
  s.writes = () => s.calls.filter((c) => !['notifications', 'get'].includes(c.action)).length;
  return s;
}
async function mount(srv, options = {}) {
  const h = await mountApprovals({ session: A, workspace: { kind: 'ready', workspaceId: WS }, account: ACCOUNT, fetch: srv.fetch, screen: 'notifications', ...options });
  await h.render();
  return h;
}
const lines = (tree) => pressables(tree, 'お知らせ ');
const minutes = (tree) => texts(tree).filter((t) => /^\d{4}-\d\d-\d\d \d\d:\d\d$/u.test(t));
/** Press "さらに読み込む" until the screen offers no more; returns the last tree. */
async function drain(h, tree, max = 40) {
  let t = tree;
  for (let i = 0; i < max && button(t, MORE); i += 1) { button(t, MORE).onPress(); t = await h.render(); }
  return t;
}

// ---- the pure rule ----------------------------------------------------------------------------------------------------------------------
const row = (cursor) => ({ notificationId: `n-${cursor}`, kind: 'approval_approved', candidateId: `c-${cursor}`, reservationId: null, subjectRevision: 1, state: null, scheduledAt: null, createdAt: '2026-11-01T00:00:00.000Z', readAt: null, cursor });
const rowsOf = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => row(from - i));

test('G1-02 rules: a cursor is only valid on a full page — a short first or later page that still points on stops the walk; a full page with null is the end', () => {
  const short = pages.startWalk({ rows: rowsOf(30, 1), nextCursor: 1 });
  assert.deepEqual([short.stopped, short.next, short.rows.length], ['invalid_page', null, 30], 'the rows stay, no continuation');
  const full = pages.startWalk({ rows: rowsOf(50, 1), nextCursor: null });
  assert.deepEqual([full.stopped, full.next], [null, null], 'exactly 50 rows and null: the end (G3 #24)');
  const walk = pages.startWalk({ rows: rowsOf(279, 230), nextCursor: 230 });
  const later = pages.acceptPage(walk, 230, { rows: rowsOf(229, 200), nextCursor: 200 });
  assert.deepEqual([later.added, later.walk.stopped, later.walk.rows.length], [false, 'invalid_page', 50]);
  const end = pages.acceptPage(walk, 230, { rows: rowsOf(229, 130), nextCursor: null });
  assert.deepEqual([end.added, end.walk.stopped, end.walk.next, end.walk.rows.length], [true, null, null, 150], 'a full page and null is accepted');
  const empty = pages.acceptPage(walk, 230, { rows: [], nextCursor: null });
  assert.deepEqual([empty.added, empty.walk.stopped, empty.walk.next], [true, null, null], 'an empty page and null is the end too');
  assert.equal(pages.moreOf(end.walk, 'idle').state, 'end');
  assert.equal(pages.moreOf(pages.startWalk({ rows: rowsOf(50, 1), nextCursor: null }), 'idle').state, 'none', 'one page, nothing more: no line at all');
});

// ---- the notification screen -------------------------------------------------------------------------------------------------------------
const SIZES = [
  // total, requests (limit, before) in the order the person's presses make them
  [50, [[50, null]]],
  [51, [[50, null], [100, 2]]],
  [100, [[50, null], [100, 51]]],
  [101, [[50, null], [100, 52]]],
  [150, [[50, null], [100, 101]]],
  [151, [[50, null], [100, 102], [100, 2]]],
  [279, [[50, null], [100, 230], [100, 130], [100, 30]]],
];

test('G1-02 notifications: 50 / 51 / 100 / 101 / 150 / 151 / 279 — every row once, the exact requests, no request after the end (nextCursor null), no empty page asked for, no write', async () => {
  for (const [total, expected] of SIZES) {
    const srv = g3(total);
    const h = await mount(srv);
    const tree = await drain(h, await h.render());
    assert.equal(lines(tree).length, total, `${total}: all rows`);
    assert.equal(new Set(minutes(tree)).size, total, `${total}: each once`);
    assert.deepEqual(srv.pageCalls(), expected, `${total}: the requests`);
    assert.equal(button(tree, MORE), undefined, `${total}: no more button`);
    assert.equal(has(tree, pages.PAGES_END_TEXT), total > 50, `${total}: the end line only when there was a second page`);
    assert.equal(has(tree, pages.PAGES_RETRY_TEXT) || Object.values(pages.PAGES_STOP_TEXT).some((t) => has(tree, t)), false, `${total}: no error line`);
    const calls = srv.calls.length;
    await h.render(4);
    assert.equal(srv.calls.length, calls, `${total}: nothing more is asked after the end`);
    assert.equal(srv.writes(), 0, `${total}: paging writes nothing`);
  }
});

test('G1-02 notifications: against PR #677 (a full page always points on) the same walk still works — one more, empty page ends it; nothing is stopped', async () => {
  for (const [total, expected] of [[50, [[50, null], [100, 1]]], [150, [[50, null], [100, 101], [100, 1]]]]) {
    const srv = g3(total, { mode: 'legacy' });
    const h = await mount(srv);
    const tree = await drain(h, await h.render());
    assert.equal(lines(tree).length, total);
    assert.deepEqual(srv.pageCalls(), expected, `${total}: legacy requests`);
    assert.ok(has(tree, pages.PAGES_END_TEXT));
    assert.equal(Object.values(pages.PAGES_STOP_TEXT).some((t) => has(tree, t)), false);
  }
});

test('G1-02 notifications: a short page that still has a nextCursor (first page or later) is not a page — nothing continues, the rows already shown stay, a reload starts over', async () => {
  const first = g3(30);
  first.tamper = (body) => ({ ...body, nextCursor: body.notifications[body.notifications.length - 1].cursor });
  const h = await mount(first);
  let tree = await h.render();
  assert.equal(lines(tree).length, 30, 'the rows are shown');
  assert.ok(has(tree, pages.PAGES_STOP_TEXT.invalid_page));
  assert.equal(button(tree, MORE), undefined);
  await h.render(3);
  assert.equal(first.pageCalls().length, 1, 'no request after it');
  first.tamper = null;
  h.world.refocus += 1;
  tree = await h.render();
  assert.ok(!has(tree, pages.PAGES_STOP_TEXT.invalid_page), 'a reload reads the true state');

  const later = g3(279);
  const l = await mount(later);
  tree = await l.render();
  later.tamper = (body, payload) => (payload.before === undefined ? body : { ...body, notifications: body.notifications.slice(0, 40), nextCursor: body.notifications[39].cursor });
  button(tree, MORE).onPress();
  tree = await l.render();
  assert.equal(lines(tree).length, 50, 'nothing added');
  assert.ok(has(tree, pages.PAGES_STOP_TEXT.invalid_page));
  const calls = later.calls.length;
  await l.render(3);
  assert.equal(later.calls.length, calls);
});

test('G1-02 notifications: rows added or removed while a walk is open — the walk neither repeats nor skips; a removed last row ends cleanly with an empty page; a new first page shows the added rows', async () => {
  // added: 3 new rows while 51 are loaded as 50 + (more): the started walk stays at its own rows
  const added = g3(51);
  let h = await mount(added);
  let tree = await h.render();
  for (const c of [52, 53, 54]) added.add('person-a', c);
  button(tree, MORE).onPress();
  tree = await h.render();
  assert.equal(lines(tree).length, 51, 'the walk shows what it started with (rows 1..51)');
  assert.equal(new Set(minutes(tree)).size, 51);
  assert.ok(has(tree, pages.PAGES_END_TEXT));
  h.world.refocus += 1;
  tree = await h.render();
  assert.equal(lines(tree).length, 50, 'a new first page: the newest 50 of 54');
  assert.ok(has(tree, '未読 50件'));
  assert.ok(button(tree, MORE), 'and four older ones');
  // removed: the one row behind the first page is gone before the press — an empty page, null, a clean end
  const gone = g3(51);
  h = await mount(gone);
  tree = await h.render();
  gone.remove('person-a', 1);
  button(tree, MORE).onPress();
  tree = await h.render();
  assert.equal(lines(tree).length, 50);
  assert.ok(has(tree, pages.PAGES_END_TEXT));
  assert.equal(Object.values(pages.PAGES_STOP_TEXT).some((t) => has(tree, t)), false, 'not an error');
  assert.deepEqual(gone.pageCalls(), [[50, null], [100, 2]]);
  // two rows removed from the pages not read yet (cursor 77 and 40): 277 rows, each once, no hole that stops the walk
  const mid = g3(279);
  h = await mount(mid);
  tree = await h.render();
  button(tree, MORE).onPress();
  tree = await h.render();
  mid.remove('person-a', 77);
  mid.remove('person-a', 40);
  tree = await drain(h, tree);
  assert.equal(lines(tree).length, 277, '279 - 2');
  assert.equal(new Set(minutes(tree)).size, 277);
  assert.ok(has(tree, pages.PAGES_END_TEXT));
  assert.equal(Object.values(pages.PAGES_STOP_TEXT).some((t) => has(tree, t)), false);
});

test('G1-02 notifications: opening a row between two pages marks only that row; the walk keeps its cursor — the first page is not read again, the next page asks for the same cursor', async () => {
  const srv = g3(279);
  const h = await mount(srv);
  let tree = await h.render();
  button(tree, MORE).onPress();
  tree = await h.render();
  assert.equal(lines(tree).length, 150);
  lines(tree)[0].onPress();
  tree = await h.render(8);
  assert.equal(srv.count('markRead'), 1, 'the opened row');
  assert.deepEqual(srv.pageCalls(), [[50, null], [100, 230]], 'no page was read again by the mark');
  assert.equal(lines(tree).length, 150, 'the rows are still there');
  assert.ok(has(tree, '未読 149件'));
  button(tree, MORE).onPress();
  tree = await h.render();
  assert.deepEqual(srv.pageCalls(), [[50, null], [100, 230], [100, 130]], 'the walk went on from its own cursor');
  assert.equal(lines(tree).length, 250);
  assert.ok(has(tree, '未読 249件'));
  assert.equal(new Set(minutes(tree)).size, 250);
  tree = await drain(h, tree);
  assert.equal(lines(tree).length, 279);
  assert.equal(srv.notes.filter((n) => n.readAt !== null).length, 1, 'only the one row the person opened is read');
});

test('G1-02 notifications: the 20-page cap — exactly 1950 rows end cleanly (nothing older); one more is the cap line; never a 21st request', async () => {
  const exact = g3(50 + 19 * 100);
  let h = await mount(exact);
  let tree = await drain(h, await h.render(), 30);
  assert.equal(lines(tree).length, 1950);
  assert.equal(exact.pageCalls().length, 20, 'the first page and 19 more');
  assert.ok(has(tree, pages.PAGES_END_TEXT), 'G3 #24 says there is nothing older: the end, not the cap');
  assert.ok(!has(tree, pages.PAGES_STOP_TEXT.capped));
  const over = g3(50 + 19 * 100 + 1);
  h = await mount(over);
  tree = await drain(h, await h.render(), 30);
  assert.equal(lines(tree).length, 1950);
  assert.equal(over.pageCalls().length, 20);
  assert.ok(has(tree, pages.PAGES_STOP_TEXT.capped), 'one older row exists: the cap line');
  assert.equal(button(tree, MORE), undefined);
  const calls = over.calls.length;
  await h.render(4);
  assert.equal(over.calls.length, calls, 'no 21st request');
});

test('G1-02 notifications: the last page answered after the person changed lands nowhere — A held, then B; B sees only B, with no cursor of A; sign-out shows nothing and sends nothing', async () => {
  const srv = g3(100, { owners: ['person-a', 'person-b'] });
  const h = await mount(srv);
  let tree = await h.render();
  const release = srv.hold();
  button(tree, MORE).onPress();
  await h.render(2);
  assert.equal(srv.pageCalls().length, 2, 'the last page is on its way');
  h.frames.length = 0;
  h.world.session = B;
  tree = await h.render();
  release();
  tree = await h.render();
  assert.ok(h.frames.every((f) => !texts(f).some((t) => t.includes('person-a'))), 'no frame shows A\'s rows to B');
  assert.equal(lines(tree).length, 50, 'B\'s own first page');
  assert.ok(button(tree, MORE), 'B has more: A\'s end did not carry over');
  assert.ok(srv.calls.filter((c) => c.token === 'jwt-b').every((c) => c.payload.before === undefined), 'B\'s token never carries A\'s cursor');
  const sent = srv.calls.length;
  h.world.session = null;
  tree = await h.render();
  assert.equal(lines(tree).length, 0);
  assert.equal(srv.calls.length, sent);
});

// ---- the read-only history of an ended service ------------------------------------------------------------------------------------------
async function history(srv, extra = {}) {
  const h = await mountEndedHistory({ userId: 'person-a', session: A, fetch: srv.fetch, gate: true, ...extra });
  await h.render(8);
  return h;
}
const moreButton = (h) => h.buttons(h.once()).find((x) => x.label === MORE);

test('G1-02 history: the ended service\'s history at 50 / 51 / 100 / 150 / 151 / 279 — the exact requests, the end line, reads only, nothing after the end', async () => {
  for (const [total, expected] of SIZES.filter(([t]) => [50, 51, 100, 150, 151, 279].includes(t))) {
    const srv = g3(total);
    const h = await history(srv);
    for (let i = 0; i < 40 && moreButton(h); i += 1) { moreButton(h).onPress(); await h.render(8); }
    const shown = texts(h.once()).filter((t) => t === view.NOTIFICATION_KIND_TEXT.approval_approved).length;
    assert.equal(shown, total, `${total}: all rows`);
    assert.deepEqual(srv.pageCalls(), expected, `${total}: the requests`);
    assert.equal(has(h.once(), pages.PAGES_END_TEXT), total > 50, `${total}: the end line`);
    assert.equal(moreButton(h), undefined);
    const calls = srv.calls.length;
    await h.render(4);
    assert.equal(srv.calls.length, calls, `${total}: nothing after the end`);
    assert.deepEqual([...new Set(srv.calls.map((c) => c.action))].sort(), ['get', 'notifications'], `${total}: reads only`);
    assert.equal(srv.writes(), 0);
    assert.ok(h.buttons(h.once()).some((x) => x.label === '最新の状態を読み込む'), `${total}: the exits stay`);
  }
});

test('G1-02 history: a short page that points on stops it; rows removed during the walk end it cleanly; the last page of A never lands in B', async () => {
  const bad = g3(279);
  let h = await history(bad);
  bad.tamper = (body, payload) => (payload.before === undefined ? body : { ...body, notifications: body.notifications.slice(0, 10), nextCursor: body.notifications[9].cursor });
  moreButton(h).onPress();
  await h.render(8);
  assert.ok(has(h.once(), pages.PAGES_STOP_TEXT.invalid_page));
  assert.equal(moreButton(h), undefined);
  const calls = bad.calls.length;
  await h.render(3);
  assert.equal(bad.calls.length, calls);

  const gone = g3(51);
  h = await history(gone);
  gone.remove('person-a', 1);
  moreButton(h).onPress();
  await h.render(8);
  assert.ok(has(h.once(), pages.PAGES_END_TEXT));
  assert.equal(Object.values(pages.PAGES_STOP_TEXT).some((t) => has(h.once(), t)), false);
  assert.equal(texts(h.once()).filter((t) => t === view.NOTIFICATION_KIND_TEXT.approval_approved).length, 50);

  const two = g3(100, { owners: ['person-a', 'person-b'] });
  const g = await history(two);
  const release = two.hold();
  moreButton(g).onPress();
  await g.render(3);
  g.world.session = B;
  g.world.userId = 'person-b';
  await g.render(8);
  release();
  await g.render(8);
  assert.ok(g.frames.slice(-20).every((f) => !texts(f).some((t) => t.includes('person-a'))));
  assert.ok(two.calls.filter((c) => c.token === 'jwt-b').every((c) => c.payload.before === undefined || c.payload.before <= 51), 'only B\'s own cursors');
  assert.ok(moreButton(g), 'B has its own next page: A\'s end did not carry over');
});
