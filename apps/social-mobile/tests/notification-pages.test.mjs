// G1 TASK 51 (G3-02 #22/#23, docs/postona/g3-approval-notification-contract-20261105.md §5b): the history of notifications past the first
// page, on the notification screen AND on the read-only history of an ended service. The REAL hooks, screens and approval client over a
// scripted stand-in of G3's paging API (PR #677): `before` a positive integer, rows newest first each with a `cursor`, `nextCursor` = the last
// cursor of a full page or null. React / RN are stubbed; nothing leaves the process. The real Edge twin + PG17 is local-stack/approvals.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as client from '../src/features/approvals/approval-client.ts';
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

/**
 * G3 with PR #677's paging. `total` notifications per person: cursor 1..total (the newest has the highest), one candidate each, kind
 * approval_approved (one line per row) unless `kinds` says otherwise. `s.hold` holds the next answers of `notifications` with `before`.
 */
function pagedG3(total = 279, { owners = ['person-a'], kinds = () => ['approval_approved'] } = {}) {
  const s = { calls: [], notes: [], tokens: { 'jwt-a': 'person-a', 'jwt-b': 'person-b' }, holds: [], tamper: null };
  const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  for (const owner of owners) {
    for (let i = 1; i <= total; i += 1) {
      const [kind, candidateId] = kinds(i);
      s.notes.push({ owner, notificationId: `${owner}-n-${i}`, kind, candidateId: candidateId ?? `${owner}-c-${i}`, reservationId: null, subjectRevision: 1, state: null, scheduledAt: null, cursor: i, createdAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), readAt: null });
    }
  }
  const strip = ({ owner: _o, ...rest }) => rest;
  s.fetch = async (url, init) => {
    const { action, payload } = JSON.parse(init.body);
    const token = (init.headers.authorization ?? '').replace(/^Bearer /u, '');
    s.calls.push({ action, token, payload });
    const who = s.tokens[token];
    if (!who) return out(401, { ok: false, code: 'AUTH_REQUIRED' });
    if (action === 'notifications') {
      const keys = Object.keys(payload ?? {});
      const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
      if (keys.some((k) => !['limit', 'before'].includes(k)) || (payload.limit !== undefined && !isInt(payload.limit, 1, 100)) || (payload.before !== undefined && !isInt(payload.before, 1, Number.MAX_SAFE_INTEGER))) return out(400, { ok: false, code: 'REQUEST_INVALID' });
      const limit = payload.limit ?? 50;
      const rows = s.notes.filter((n) => n.owner === who && (payload.before === undefined || n.cursor < payload.before)).sort((a, b) => b.cursor - a.cursor).slice(0, limit);
      let body = { ok: true, notifications: rows.map(strip), nextCursor: rows.length === limit ? rows[rows.length - 1].cursor : null };
      if (payload.before !== undefined && s.holds.length) await new Promise((resolve) => s.holds.push(resolve));
      if (s.tamper) body = s.tamper(body, payload) ?? body;
      return out(200, body);
    }
    if (action === 'markRead') { const n = s.notes.find((x) => x.owner === who && x.notificationId === payload.notificationId); if (!n) return out(404, { ok: false, code: 'POSTONA_RESV_NOT_FOUND' }); n.readAt ??= '2026-11-15T00:00:00.000Z'; return out(200, { ok: true, notifications: [strip(n)] }); }
    if (action === 'get') return out(404, { ok: false, code: 'POSTONA_RESV_NOT_FOUND' });
    return out(400, { ok: false, code: 'REQUEST_INVALID' });
  };
  s.count = (action, pred = () => true) => s.calls.filter((c) => c.action === action && pred(c)).length;
  s.pageCalls = () => s.calls.filter((c) => c.action === 'notifications').map((c) => [c.payload.limit, c.payload.before ?? null]);
  return s;
}
async function mount(srv, options = {}) {
  const h = await mountApprovals({ session: A, workspace: { kind: 'ready', workspaceId: WS }, account: ACCOUNT, fetch: srv.fetch, screen: 'notifications', ...options });
  await h.render();
  return h;
}
const lines = (tree) => pressables(tree, 'お知らせ ');
const MORE = pages.PAGES_MORE_TEXT;

// ---- the pure rules ---------------------------------------------------------------------------------------------------------------------
const row = (cursor, extra = {}) => ({ notificationId: `n-${cursor}`, kind: 'approval_approved', candidateId: `c-${cursor}`, reservationId: null, subjectRevision: 1, state: null, scheduledAt: null, createdAt: '2026-11-01T00:00:00.000Z', readAt: null, cursor, ...extra });
const pageOf = (from, to, nextCursor) => ({ rows: Array.from({ length: from - to + 1 }, (_, i) => row(from - i)), nextCursor });

test('T51 rules: 279 rows are reached as 50 + 100 + 100 + 29, each once, in order; the walk ends at null', () => {
  let walk = pages.startWalk(pageOf(279, 230, 230));
  assert.deepEqual([walk.rows.length, walk.next, walk.stopped], [50, 230, null]);
  for (const [from, to, next] of [[229, 130, 130], [129, 30, 30], [29, 1, null]]) {
    const before = walk.next;
    const r = pages.acceptPage(walk, before, pageOf(from, to, next));
    assert.equal(r.added, true);
    walk = r.walk;
  }
  assert.deepEqual([walk.rows.length, walk.next, walk.stopped, walk.pages], [279, null, null, 4]);
  assert.deepEqual(walk.rows.map((r) => r.cursor), Array.from({ length: 279 }, (_, i) => 279 - i));
});

test('T51 rules: a full last page ends with an empty page and null; a server without paging gives one page and no continuation', () => {
  let walk = pages.startWalk(pageOf(100, 51, 51), 50 + 50);
  const r = pages.acceptPage(walk, 51, { rows: [], nextCursor: null });
  assert.deepEqual([r.added, r.walk.next, r.walk.stopped, r.walk.rows.length], [true, null, null, 50]);
  const old = pages.startWalk({ rows: [{ ...row(1), cursor: undefined }], nextCursor: null });
  assert.deepEqual([old.next, old.stopped], [null, null]);
});

test('T51 rules: anything that is not the next older page stops the walk and adds nothing (duplicate, order, same cursor, cursor mismatch, too many rows, bad cursor)', () => {
  const start = () => pages.startWalk(pageOf(279, 230, 230));
  const cases = [
    ['duplicate within a page', { rows: [row(229), row(229)], nextCursor: null }, 'duplicate'],
    ['a row already held', { rows: [row(229), row(279)], nextCursor: null }, 'order'],
    ['a row at the cursor (same cursor again)', { rows: [row(230), row(229)], nextCursor: null }, 'order'],
    ['ascending', { rows: [row(100), row(200)], nextCursor: null }, 'order'],
    ['nextCursor not the last cursor', { rows: [row(229), row(228)], nextCursor: 100 }, 'cursor'],
    ['nextCursor on an empty page', { rows: [], nextCursor: 5 }, 'cursor'],
    ['too many rows', { rows: Array.from({ length: 101 }, (_, i) => row(229 - i)), nextCursor: 129 }, 'invalid_page'],
    ['a row without a cursor', { rows: [{ ...row(229), cursor: undefined }], nextCursor: null }, 'cursor'],
  ];
  for (const [name, page, reason] of cases) {
    const r = pages.acceptPage(start(), 230, page);
    assert.deepEqual([r.added, r.walk.stopped, r.walk.next, r.walk.rows.length], [false, reason, null, 50], name);
  }
  const held = start();
  held.rows.push(row(229));
  const dup = pages.acceptPage({ ...held, next: 229 }, 229, { rows: [row(228)], nextCursor: null });
  assert.equal(dup.added, true);
  const dupId = pages.acceptPage(start(), 230, { rows: [{ ...row(229), notificationId: 'n-279' }], nextCursor: null });
  assert.deepEqual([dupId.added, dupId.walk.stopped], [false, 'duplicate'], 'an id the walk already holds');
});

test('T51 rules: a late answer for another cursor adds nothing; a stopped walk and the end add nothing; the walk holds at most MAX_PAGES pages', () => {
  const walk = pages.startWalk(pageOf(279, 230, 230));
  assert.equal(pages.acceptPage(walk, 130, pageOf(129, 30, 30)).added, false, 'not the cursor the walk waits for');
  assert.equal(pages.acceptPage({ ...walk, stopped: 'order' }, 230, pageOf(229, 130, 130)).added, false);
  assert.equal(pages.acceptPage({ ...walk, next: null }, 230, pageOf(229, 130, 130)).added, false);
  let w = pages.startWalk(pageOf(10000, 9951, 9951));
  let cursor = 9951;
  for (let i = 1; i < pages.MAX_PAGES; i += 1) {
    const r = pages.acceptPage(w, cursor, pageOf(cursor - 1, cursor - 100, cursor - 100));
    w = r.walk; cursor -= 100;
  }
  assert.deepEqual([w.pages, w.stopped, w.next], [pages.MAX_PAGES, 'capped', null], 'the 20th page is the last one the walk takes');
  assert.equal(w.rows.length, 50 + 19 * 100);
});

// ---- the client -----------------------------------------------------------------------------------------------------------------------
test('T51 client: the first page sends only the limit; later pages send `before` = a cursor; a request G3 would refuse is never sent; nextCursor must be null or a cursor', async () => {
  const srv = pagedG3(120);
  const api = client.createApprovalClient({ supabaseUrl: 'https://proj.example.test', publishableKey: 'sb_publishable_testkey01', accessToken: async () => 'jwt-a', fetch: srv.fetch });
  const first = await api.notificationPage({ limit: 50 });
  assert.equal(first.ok, true);
  assert.deepEqual([first.value.rows.length, first.value.nextCursor, first.value.rows[0].cursor], [50, 71, 120]);
  assert.deepEqual(srv.calls[0].payload, { limit: 50 }, 'no `before`, not even null');
  const second = await api.notificationPage({ limit: 100, before: 71 });
  assert.deepEqual([second.value.rows.length, second.value.nextCursor], [70, null]);
  assert.deepEqual(srv.calls[1].payload, { limit: 100, before: 71 });
  const sent = srv.calls.length;
  for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { before: 0 }, { before: -1 }, { before: 2.5 }, { before: '5' }, { before: null }, { before: Number.MAX_SAFE_INTEGER + 2 }]) {
    const r = await api.notificationPage(bad);
    assert.deepEqual([r.ok, r.code, r.definite], [false, 'REQUEST_INVALID', true], JSON.stringify(bad));
  }
  assert.equal(srv.calls.length, sent, 'none of them was sent');
  for (const nextCursor of [0, -3, 2.5, '70', Number.MAX_SAFE_INTEGER + 2]) {
    srv.tamper = (body) => ({ ...body, nextCursor });
    const r = await api.notificationPage({ limit: 50 });
    assert.deepEqual([r.ok, r.code, r.status], [false, client.UNCERTAIN, 200], `nextCursor ${String(nextCursor)} is not a page`);
  }
  srv.tamper = (body) => ({ ...body, notifications: body.notifications.map((n, i) => (i === 0 ? { ...n, cursor: 0 } : n)) });
  assert.equal((await api.notificationPage({ limit: 50 })).ok, false, 'a row with a bad cursor is not a page');
  const old = { ok: true, notifications: [{ ...srv.notes[0], owner: undefined, cursor: undefined }] };
  srv.tamper = () => old;
  const plain = await api.notificationPage({ limit: 50 });
  assert.deepEqual([plain.ok, plain.value.nextCursor], [true, null], 'a server without paging: one page, no continuation');
});

// ---- the notification screen ----------------------------------------------------------------------------------------------------------
test('T51 notifications: 279 notifications are read as 50 + 100 + 100 + 29 by the person\'s presses; each once; the row is gone at the end; the first page is as before', async () => {
  const srv = pagedG3(279);
  const h = await mount(srv);
  let tree = await h.render();
  assert.equal(lines(tree).length, 50, 'the first page keeps its size (50)');
  assert.ok(has(tree, '未読 50件'));
  assert.ok(button(tree, MORE), 'there is more');
  assert.deepEqual(srv.pageCalls(), [[50, null]], 'nothing is read until the person asks');
  for (const [shown, unread] of [[150, 150], [250, 250], [279, 279]]) {
    button(tree, MORE)?.onPress();
    tree = await h.render();
    assert.equal(lines(tree).length, shown);
    assert.ok(has(tree, `未読 ${unread}件`));
  }
  assert.deepEqual(srv.pageCalls(), [[50, null], [100, 230], [100, 130], [100, 30]]);
  assert.equal(button(tree, MORE), undefined, 'no more row at the end');
  assert.ok(has(tree, pages.PAGES_END_TEXT));
  const times = texts(tree).filter((t) => /^\d{4}-\d\d-\d\d \d\d:\d\d$/u.test(t));   // each row shows its own minute
  assert.equal(times.length, 279);
  assert.equal(new Set(times).size, 279, 'each notification once');
  assert.equal(srv.count('markRead') + srv.count('submit') + srv.count('approve'), 0, 'paging writes nothing');
});

test('T51 notifications: two quick presses ask for one page; a reload starts from the newest and drops the older pages; an answer of the earlier read adds nothing', async () => {
  const srv = pagedG3(279);
  const h = await mount(srv);
  let tree = await h.render();
  const more = button(tree, MORE);
  more.onPress(); more.onPress(); more.onPress();
  tree = await h.render();
  assert.equal(srv.pageCalls().filter(([, b]) => b !== null).length, 1, 'one request for the cursor');
  assert.equal(lines(tree).length, 150);
  // a page held on its way, then the person reads again from the top: the held answer is the earlier read's
  srv.holds.push(() => {});
  srv.holds.length = 0;
  const release = [];
  srv.holds.push(null);
  srv.holds.length = 0;
  srv.holds = [];
  srv.holds.push = (fn) => { release.push(fn); return release.length; };
  srv.holds.length = 1;   // truthy: hold the next page answers
  button(tree, MORE).onPress();
  await h.render(2);
  assert.equal(release.length, 1, 'the next page is on its way');
  h.world.refocus += 1;
  tree = await h.render();
  assert.equal(lines(tree).length, 50, 'the screen read again from the first page');
  release.forEach((fn) => fn());
  tree = await h.render();
  assert.equal(lines(tree).length, 50, 'the held answer of the earlier read adds nothing');
  assert.ok(button(tree, MORE), 'the new walk starts again from its own cursor');
});

test('T51 notifications: a lost page keeps the cursor and says so; pressing again asks for the same page once; then it is added', async () => {
  const srv = pagedG3(279);
  const h = await mount(srv);
  let tree = await h.render();
  const real = h.world.fetch;
  let failures = 1;
  h.world.fetch = async (url, init) => { const { payload } = JSON.parse(init.body); if (payload?.before !== undefined && failures-- > 0) throw new TypeError('offline'); return real(url, init); };
  button(tree, MORE).onPress();
  tree = await h.render();
  assert.equal(lines(tree).length, 50, 'nothing added');
  assert.ok(has(tree, pages.PAGES_RETRY_TEXT));
  assert.ok(button(tree, MORE), 'the same button asks again');
  button(tree, MORE).onPress();
  tree = await h.render();
  assert.equal(lines(tree).length, 150);
  assert.ok(!has(tree, pages.PAGES_RETRY_TEXT));
  assert.deepEqual(srv.pageCalls().filter(([, b]) => b !== null), [[100, 230]], 'the same cursor, answered once');
});

test('T51 notifications: fail-closed — a malformed 200, a duplicate, an ascending page, the same cursor again or a wrong nextCursor stops the walk: nothing added, no more requests, the rows already shown stay, a reload starts over', async () => {
  const bad = [
    ['not a page (malformed 200)', () => ({ ok: true, notifications: 'x' }), 'invalid_page'],
    ['a nextCursor that is not a cursor', (b) => ({ ...b, nextCursor: -4 }), 'invalid_page'],
    ['a row already shown', (b) => ({ ...b, notifications: [{ ...b.notifications[0], notificationId: 'person-a-n-279', cursor: 229 }, ...b.notifications.slice(1)] }), 'duplicate'],
    ['ascending', (b) => ({ ...b, notifications: [...b.notifications].reverse() }), 'order'],
    ['the same cursor again', (b, p) => ({ ...b, notifications: [{ ...b.notifications[0], cursor: p.before }, ...b.notifications.slice(1)] }), 'order'],
    ['a wrong nextCursor', (b) => ({ ...b, nextCursor: 3 }), 'cursor'],
  ];
  for (const [name, tamper, reason] of bad) {
    const srv = pagedG3(279);
    const h = await mount(srv);
    let tree = await h.render();
    srv.tamper = (body, payload) => (payload.before === undefined ? body : tamper(body, payload));
    button(tree, MORE).onPress();
    tree = await h.render();
    assert.equal(lines(tree).length, 50, `${name}: nothing added`);
    assert.ok(has(tree, pages.PAGES_STOP_TEXT[reason]), `${name}: says why`);
    assert.equal(button(tree, MORE), undefined, `${name}: no more row`);
    const calls = srv.calls.length;
    await h.render(3);
    assert.equal(srv.calls.length, calls, `${name}: no further request`);
    srv.tamper = null;
    h.world.refocus += 1;
    tree = await h.render();
    assert.ok(button(tree, MORE), `${name}: a reload starts over from the newest`);
    assert.ok(!has(tree, pages.PAGES_STOP_TEXT[reason]));
  }
});

test('T51 notifications: grouping and the badge hold across pages (a candidate\'s older requests on a later page join its newest line); opening marks only what is loaded, each row once, and a marked row is not duplicated by a later page', async () => {
  // cursor 279..: candidate X has requests at 275 and 230 (page 1) and 229 (page 2, joins X's line); every other row is its own line
  const kinds = (i) => ([275, 230, 229].includes(i) ? ['approval_requested', 'cand-x'] : ['approval_approved']);
  const srv = pagedG3(279, { kinds });
  const h = await mount(srv);
  let tree = await h.render();
  // page 1 holds X's requests at 275 and 230: one line, the older one behind it
  assert.equal(lines(tree).length, 49);
  assert.ok(has(tree, '未読 49件'));
  assert.ok(has(tree, view.olderRequestsText(1)));
  button(tree, MORE).onPress();
  tree = await h.render();
  // 150 rows loaded, 3 of them X: 148 lines, X's two older requests behind the newest (275)
  assert.equal(lines(tree).length, 148);
  assert.ok(has(tree, '未読 148件'), 'a candidate\'s older requests are not counted on top of its newest');
  assert.ok(has(tree, view.olderRequestsText(2)));
  const xLine = lines(tree).find((l) => l.accessibilityLabel.includes('承認待ち'));
  xLine.onPress();   // opening X marks the newest and its two loaded older requests
  tree = await h.render(8);
  assert.equal(srv.count('markRead'), 3);
  assert.ok(has(tree, '未読 147件'));
  button(tree, MORE).onPress();
  tree = await h.render();
  const minutes = texts(tree).filter((t) => /^\d{4}-\d\d-\d\d \d\d:\d\d$/u.test(t));
  assert.equal(new Set(minutes).size, minutes.length, 'no line twice');
  assert.equal(srv.notes.filter((n) => n.candidateId === 'cand-x' && n.readAt === null).length, 0);
});

test('T51 notifications: the read-only state (service ended) still pages — reads only; no markRead on any page', async () => {
  const srv = pagedG3(279);
  const h = await mount(srv, { lifecycle: 'ended' });
  let tree = await h.render();
  tree = await h.render(4);
  assert.ok(has(tree, view.NOTIFICATIONS_ENDED_TEXT), 'read-only');
  button(tree, MORE).onPress();
  tree = await h.render();
  assert.equal(lines(tree).length, 150, 'the next page is read');
  lines(tree)[0].onPress();
  lines(tree)[120].onPress();
  await h.render(3);
  assert.equal(srv.count('markRead'), 0, 'nothing is marked read, on the first page or a later one');
});

test('T51 notifications: A -> B and sign-out — a page answered after the switch lands nowhere; B sees only B\'s rows with B\'s token; the cursor of A is never sent with B\'s token', async () => {
  const srv = pagedG3(279, { owners: ['person-a', 'person-b'] });
  const h = await mount(srv);
  let tree = await h.render();
  const release = [];
  srv.holds.push = (fn) => { release.push(fn); return release.length; };
  srv.holds.length = 1;
  button(tree, MORE).onPress();
  await h.render(2);
  assert.equal(release.length, 1);
  h.frames.length = 0;
  h.world.session = B;
  tree = await h.render();
  release.forEach((fn) => fn());
  tree = await h.render();
  assert.ok(h.frames.every((f) => !texts(f).some((t) => t.includes('person-a'))), 'no frame shows A\'s rows to B');
  assert.equal(lines(tree).length, 50, 'B\'s own first page');
  assert.ok(srv.calls.filter((c) => c.token === 'jwt-b').every((c) => c.payload.before === undefined), 'B\'s token never carries A\'s cursor');
  const sent = srv.calls.length;
  h.world.session = null;
  tree = await h.render();
  assert.equal(lines(tree).length, 0, 'sign-out shows no line');
  assert.equal(srv.calls.length, sent, 'and sends nothing');
});

test('T51 notifications: an expired token ends the list (sign-in), not a retry; flag OFF and a person not in an own workspace send nothing', async () => {
  const srv = pagedG3(279);
  const h = await mount(srv);
  let tree = await h.render();
  srv.tokens['jwt-a'] = undefined;
  button(tree, MORE).onPress();
  tree = await h.render();
  assert.ok(has(tree, view.ACTION_TEXT.sign_in));
  assert.equal(button(tree, MORE), undefined);
  const off = pagedG3(279);
  const o = await mount(off, { gate: false });
  assert.ok(has(await o.render(), view.POSTONA_APPROVAL_UI_GATE_TEXT));
  assert.equal(off.calls.length, 0);
});

// ---- the read-only history of an ended service ------------------------------------------------------------------------------------------
async function history(srv, extra = {}) {
  const base = { userId: 'person-a', session: A, fetch: srv.fetch, gate: true };
  const h = await mountEndedHistory({ ...base, ...extra });
  await h.render(8);
  return h;
}
const bodyTexts = (h) => texts(h.once());

test('T51 history: the ended-service history pages the same way — 279 as 50 + 100 + 100 + 29 by presses, reads only (notificationPage + get), the buttons stay', async () => {
  const srv = pagedG3(279);
  const h = await history(srv);
  const press = async () => { const b = h.buttons(h.once()).find((x) => x.label === MORE); assert.ok(b, 'a more button'); b.onPress(); await h.render(8); };
  assert.deepEqual(srv.pageCalls(), [[50, null]]);
  const count = () => bodyTexts(h).filter((t) => t === view.NOTIFICATION_KIND_TEXT.approval_approved).length;
  assert.equal(count(), 50);
  for (const shown of [150, 250, 279]) { await press(); assert.equal(count(), shown); }
  assert.deepEqual(srv.pageCalls(), [[50, null], [100, 230], [100, 130], [100, 30]]);
  assert.equal(h.buttons(h.once()).find((x) => x.label === MORE), undefined);
  assert.ok(has(h.once(), pages.PAGES_END_TEXT));
  assert.deepEqual([...new Set(srv.calls.map((c) => c.action))].sort(), ['get', 'notifications'], 'only reads');
  assert.ok(h.buttons(h.once()).some((x) => x.label === '最新の状態を読み込む'));
});

test('T51 history: fail-closed and isolation — a bad page stops it; a held page of A never lands in B; a reload starts over; the candidates read stay at the cap', async () => {
  const srv = pagedG3(279);
  const h = await history(srv);
  srv.tamper = (body, payload) => (payload.before === undefined ? body : { ...body, nextCursor: 3 });
  h.buttons(h.once()).find((x) => x.label === MORE).onPress();
  await h.render(8);
  assert.ok(has(h.once(), pages.PAGES_STOP_TEXT.cursor));
  assert.equal(h.buttons(h.once()).find((x) => x.label === MORE), undefined);
  const calls = srv.calls.length;
  await h.render(3);
  assert.equal(srv.calls.length, calls, 'no further request');
  srv.tamper = null;
  h.buttons(h.once()).find((x) => x.label === '最新の状態を読み込む').onPress();
  await h.render(8);
  assert.ok(h.buttons(h.once()).find((x) => x.label === MORE), 'a reload starts over');
  // the candidate reads of one walk stay at the cap (20) however many pages are read (a reload is a new walk: it counts again)
  const getsBefore = srv.count('get');
  for (let i = 0; i < 3; i += 1) { h.buttons(h.once()).find((x) => x.label === MORE)?.onPress(); await h.render(8); }
  assert.equal(srv.count('get') - getsBefore, 0, 'the first page already used the cap: later pages read no more candidates');
  assert.ok(getsBefore <= 40, 'one walk of 20 before the reload, one of 20 after');

  const two = pagedG3(279, { owners: ['person-a', 'person-b'] });
  const g = await history(two);
  const release = [];
  two.holds.push = (fn) => { release.push(fn); return release.length; };
  two.holds.length = 1;
  g.buttons(g.once()).find((x) => x.label === MORE).onPress();
  await g.render(3);
  g.world.session = B;
  g.world.userId = 'person-b';
  await g.render(8);
  release.forEach((fn) => fn());
  await g.render(8);
  assert.ok(g.frames.slice(-20).every((f) => !texts(f).some((t) => t.includes('person-a'))));
  assert.ok(two.calls.filter((c) => c.token === 'jwt-b').every((c) => c.payload.before === undefined || c.payload.before <= 230), 'only B\'s own cursors');
});

test('T51 source: the paging reads only (notificationPage, never a write), keeps the cursor in memory only, and asks for `before` only from the walk\'s own cursor', async () => {
  const read = (rel) => readFile(new URL(`../src/features/approvals/${rel}`, import.meta.url), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
  for (const f of ['use-approval-notifications.ts', 'use-ended-history.ts', 'notification-pages.ts']) {
    const code = strip(await read(f));
    assert.doesNotMatch(code, /localStorage|AsyncStorage|SecureStore|expo-secure-store/u, `${f}: the cursor is kept in memory only`);
  }
  const hook = strip(await read('use-approval-notifications.ts'));
  assert.deepEqual([...hook.matchAll(/client\.notificationPage\(\{ limit: (\w+)(?:, before)?/gu)].map((m) => m[1]), ['FIRST_PAGE_SIZE', 'MORE_PAGE_SIZE']);
  assert.equal([...hook.matchAll(/client\.(\w+)\(/gu)].map((m) => m[1]).filter((m) => m !== 'notificationPage' && m !== 'markRead').length, 0);
  const screen = strip(await readFile(new URL('../src/app/notifications/index.tsx', import.meta.url), 'utf8'));
  assert.match(screen, /view\.more\.load/u);
});

// ---- the survivors of the first mutation run -------------------------------------------------------------------------------------------
test('T51 notifications: the first "more" held, the screen reads again from the top (the new first page asks for the same cursor): the held answer is the earlier read\'s and adds nothing', async () => {
  const srv = pagedG3(279);
  const h = await mount(srv);
  let tree = await h.render();
  const release = [];
  srv.holds.push = (fn) => { release.push(fn); return release.length; };
  srv.holds.length = 1;
  button(tree, MORE).onPress();
  await h.render(2);
  assert.equal(release.length, 1);
  h.world.refocus += 1;
  tree = await h.render();
  assert.equal(lines(tree).length, 50);
  assert.equal(srv.pageCalls().filter(([, b]) => b === 230).length, 1, 'the held request asked for cursor 230, the new first page waits for the same one');
  release.forEach((fn) => fn());
  tree = await h.render();
  assert.equal(lines(tree).length, 50, 'the earlier read\'s answer is not added to the new walk');
  srv.holds.length = 0;   // stop holding
  button(tree, MORE).onPress();
  tree = await h.render();
  assert.equal(lines(tree).length, 150, 'the new walk reads its own next page');
});

test('T51 history: two quick presses ask for one page; the first "more" held and then a reload: the held answer adds nothing', async () => {
  const srv = pagedG3(279);
  const h = await history(srv);
  const more = () => h.buttons(h.once()).find((x) => x.label === MORE);
  const press = more();
  press.onPress(); press.onPress(); press.onPress();
  await h.render(8);
  assert.equal(srv.pageCalls().filter(([, b]) => b !== null).length, 1, 'one request for the cursor');
  const release = [];
  const real = h.world.fetch;
  let hold = true;
  h.world.fetch = async (url, init) => { const { payload } = JSON.parse(init.body); if (hold && payload?.before === 130) await new Promise((resolve) => release.push(resolve)); return real(url, init); };
  more().onPress();
  await h.render(3);
  assert.equal(release.length, 1, 'the next page (cursor 130) is on its way');
  hold = false;
  h.buttons(h.once()).find((x) => x.label === '最新の状態を読み込む').onPress();
  await h.render(8);
  const count = () => texts(h.once()).filter((t) => t === view.NOTIFICATION_KIND_TEXT.approval_approved).length;
  assert.equal(count(), 50, 'read again from the first page');
  release.forEach((fn) => fn());
  await h.render(8);
  assert.equal(count(), 50, 'the held answer (cursor 130 of the earlier walk) adds nothing');
});

test('T51 order: rows made in the same instant are ordered by their cursor, so a candidate\'s newest request is the one with the highest cursor', () => {
  const same = '2026-11-01T00:00:00.000Z';
  const rows = [row(7, { kind: 'approval_requested', candidateId: 'c', subjectRevision: 1, createdAt: same }), row(9, { kind: 'approval_requested', candidateId: 'c', subjectRevision: 1, createdAt: same }), row(8, { kind: 'approval_requested', candidateId: 'c', subjectRevision: 1, createdAt: same })];
  const groups = view.groupNotifications(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].row.cursor, 9);
  assert.equal(JSON.stringify(groups[0].older.map((r) => r.cursor)), '[8,7]');
  const plain = view.groupNotifications(rows.map((r) => ({ ...r, cursor: undefined, subjectRevision: r.cursor })));
  assert.equal(plain[0].row.subjectRevision, 9, 'without cursors it falls back to the time and the revision, as before');
});

test('T51 gateway 401: an expired / broken token refused by the gateway\'s own 401 (no G3 code) is a sign-in, on the first page and on a later page; a 5xx stays a lost answer', async () => {
  const kong = () => new Response(JSON.stringify({ code: 401, message: 'Invalid JWT' }), { status: 401, headers: { 'content-type': 'application/json' } });
  const api = client.createApprovalClient({ supabaseUrl: 'https://proj.example.test', publishableKey: 'sb_publishable_testkey01', accessToken: async () => 'jwt-a', fetch: async () => kong() });
  const r = await api.notificationPage({ limit: 50 });
  assert.equal(JSON.stringify([r.ok, r.code, r.status, r.definite]), JSON.stringify([false, client.AUTH_REQUIRED, 401, true]));
  const five = client.createApprovalClient({ supabaseUrl: 'https://proj.example.test', publishableKey: 'sb_publishable_testkey01', accessToken: async () => 'jwt-a', fetch: async () => new Response('bad gateway', { status: 502 }) });
  const r5 = await five.notificationPage({ limit: 50 });
  assert.equal(JSON.stringify([r5.ok, r5.code, r5.definite]), JSON.stringify([false, client.UNCERTAIN, false]));

  const srv = pagedG3(279);
  const h = await mount(srv);
  let tree = await h.render();
  const real = h.world.fetch;
  h.world.fetch = async (url, init) => (JSON.parse(init.body).payload?.before !== undefined ? kong() : real(url, init));
  button(tree, MORE).onPress();
  tree = await h.render();
  assert.ok(has(tree, view.ACTION_TEXT.sign_in), 'the person is told to sign in again');
  assert.equal(button(tree, MORE), undefined, 'no retry for an expired session');
});
