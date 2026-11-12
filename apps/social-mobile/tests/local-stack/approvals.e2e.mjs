// G1 TASK 44: the approval and notification screens on G3's throw-away local runtime (run-x-disconnected.sh): real GoTrue JWTs -> Kong
// (verify_jwt) -> G3's Edge twin postona-x-approvals-localtest (PR #644: only the static gate and the transport differ from the entry) ->
// Postgres with 018 installed by G3's rollout, and G5 PR #645's ownership-lock trigger installed by this file (local only). The screens,
// hooks and client are the app's; React / RN are stubbed (tests/approvals-harness.mjs). SYNTHETIC (labelled): the X connection is G4's SQL
// with fake tokens, an expired session and a membership change are rows. No worker runs; nothing reaches X.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as stack from './x-disconnected-world.mjs';
import * as view from '../../src/features/approvals/approval-view.ts';
import { button, has, mountApprovals, pressables, texts } from '../approvals-harness.mjs';
import { mountEndedHistory } from '../ended-history-harness.mjs';

const REAL_FETCH = globalThis.fetch;
const FN = 'postona-x-approvals-localtest';
const URL_ = `${stack.API}/functions/v1/${FN}`;
const opts = { concurrency: false };
test.afterEach(() => { globalThis.fetch = REAL_FETCH; });

const raw = async (action, payload, token) => {
  const headers = { apikey: stack.PUBLISHABLE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const r = await REAL_FETCH(URL_, { method: 'POST', headers, body: JSON.stringify({ action, payload }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const jstIn = (days, hour = 9) => { const at = new Date(Date.now() + days * 864e5); const j = new Date(at.getTime() + 9 * 3600e3); return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}-${String(j.getUTCDate()).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00`; };
// what the screens sent and got (kept to explain a failure)
const wire = [];
// G1 TASK 45: `lose` holds actions whose next answer is lost after the server has done it (the request reached the Edge and committed;
// the app sees a network failure), and `fail` actions whose next request never leaves the device.
const lose = []; const fail = [];
const recorded = async (url, init) => {
  const action = JSON.parse(init.body).action;
  if (fail.includes(action)) { fail.splice(fail.indexOf(action), 1); wire.push(`${action} (not sent)`); throw new TypeError('Network request failed'); }
  const r = await REAL_FETCH(url, init); const c = await r.clone().json().catch(() => null); wire.push(`${action} ${r.status} ${c?.code ?? 'ok'}`);
  if (lose.includes(action)) { lose.splice(lose.indexOf(action), 1); wire.push(`${action} answer lost`); throw new TypeError('Network request failed'); }
  return r;
};
const mountFor = (p, extra = {}) => mountApprovals({
  session: { token: p.token, userId: p.userId }, workspace: { kind: 'ready', workspaceId: p.workspace },
  account: { id: p.account, brandId: p.workspace, platform: 'x', connectionStatus: 'connected', profile: { handle: '@h', displayName: 'h' } },
  fetch: recorded, endpoint: { functionName: FN, allowLoopbackHttpForTests: true }, config: { ok: true, config: { url: stack.API, publishableKey: stack.PUBLISHABLE } },
  uuid: () => crypto.randomUUID(), wait: () => new Promise((resolve) => setTimeout(resolve, 60)), ...extra,
});
async function until(h, predicate, label, ms = 20000) {
  const end = Date.now() + ms;
  let tree = await h.render(3);
  while (!predicate(tree)) {
    assert.ok(Date.now() < end, `timed out: ${label}; the screen says: ${texts(tree).join(' / ')}; wire: ${wire.slice(-8).join(' | ')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    tree = await h.render(2);
  }
  return tree;
}
const q = (sql, vars) => stack.psql(sql, vars);
const candidatesOf = (p) => q("select coalesce(string_agg(state || ':' || revision || ':' || (reservation_id is not null), ',' order by created_at), '') from postona_x_resv.approval_candidates where user_id = :'u'", { u: p.userId });
const notesOf = (p) => q("select count(*) || ':' || count(*) filter (where read_at is not null) from postona_x_resv.notifications where user_id = :'u'", { u: p.userId });
const outboxOf = (p) => q("select count(*) from postona_x_resv.push_outbox o join postona_x_resv.notifications n on n.id = o.notification_id where n.user_id = :'u'", { u: p.userId });
async function compose(h, body, when) {
  await h.type('投稿候補の本文', body);
  await h.type('投稿候補の日時', when);
  button(h.once(), '承認に回す').onPress();
  return until(h, (t) => has(t, view.SUBMITTED_TEXT), `submit ${body}`);
}
async function approveShown(h, label) {
  button(h.once(), '承認する').onPress();
  return until(h, (t) => (has(t, view.APPROVED_TEXT) || has(t, view.ACTION_TEXT.generation_changed) || has(t, view.ACTION_TEXT.reread)) && button(t, '承認する')?.disabled !== true, label);
}

let A;
test('the person on the real stack: 承認に回す -> no reservation -> notification read -> 承認 -> exactly one reservation', opts, async () => {
  A = await stack.person('apa');
  assert.equal(await q("select brand_id from public.social_accounts where id = :'a'", { a: A.account }), A.workspace, 'the X account is in the personal workspace');
  const h = await mountFor(A);
  await until(h, (t) => has(t, '投稿候補はまだありません'), 'empty');
  await compose(h, 'G1第44 承認の本文', jstIn(3));
  assert.equal(await candidatesOf(A), 'pending_approval:1:false');
  assert.equal(await stack.rowCount(A.account), '0', 'before the approval there is no reservation: nothing exists for a worker to send');

  let tree = await h.show('notifications');
  tree = await until(h, (t) => has(t, '未読 1件'), 'one unread');
  assert.ok(has(tree, view.PUSH_NOTE));
  assert.equal(await outboxOf(A), '1', 'an outbox row exists ...');
  assert.ok(!texts(tree).some((t) => /送信済み|配信済み|通知しました/u.test(t)), '... and the screen does not say a push was delivered');
  pressables(tree, 'お知らせ ')[0].onPress();
  await until(h, (t) => has(t, '未読 0件'), 'read');
  assert.equal(await notesOf(A), '1:1');
  assert.equal(JSON.parse(JSON.stringify(h.world.pushes))[0].pathname, '/approvals');

  h.world.params = JSON.parse(JSON.stringify(h.world.pushes))[0].params;
  tree = await h.show('approvals');
  tree = await until(h, (t) => !!button(t, '承認する'), 'the candidate open');
  tree = await approveShown(h, 'approve');
  assert.ok(has(tree, view.APPROVED_TEXT), texts(tree).join(' / '));
  assert.match(await candidatesOf(A), /^approved:\d+:true$/u, 'approved, with its reservation (the server moves the revision on approve)');
  assert.equal(await stack.rowCount(A.account), '1', 'one reservation, through the normal create path');
  button(h.once(), '承認する') === undefined || assert.fail('no second approve offered');
});

test('G4 disconnect + reconnect after submit: 409 APPROVAL_GENERATION_CHANGED, no reservation; 「修正して承認に回し直す」 then 承認 under the current connection', opts, async () => {
  const h = await mountFor(A);
  await until(h, (t) => has(t, '承認済み'), 'the list');
  await compose(h, 'G1第44 再接続の前の本文', jstIn(6));
  await stack.xDisconnect(A);
  assert.equal(await stack.xConnect(A, 'apa2', A.puid), A.account, 'the same X account, a new connection generation');
  await pressables(h.once(), '投稿候補 ')[0].onPress();
  let tree = await until(h, (t) => !!button(t, '承認する'), 'open');
  tree = await approveShown(h, 'approve before reconnect');
  assert.ok(has(tree, view.ACTION_TEXT.generation_changed), texts(tree).join(' / '));
  assert.equal(await stack.rowCount(A.account), '1', 'refused: no second reservation');
  // the words show as soon as the refusal is known; the button is enabled once the read back has settled (busy over)
  tree = await until(h, (t) => button(t, '修正して承認に回し直す')?.disabled === false, 'revise offered');
  button(tree, '修正して承認に回し直す').onPress();
  tree = await until(h, (t) => has(t, view.REVISED_TEXT), 'revised');
  tree = await approveShown(h, 'approve after revise');
  assert.ok(has(tree, view.APPROVED_TEXT), texts(tree).join(' / '));
  assert.equal(await stack.rowCount(A.account), '2');
  assert.match(await candidatesOf(A), /,approved:\d+:true$/u);
});

test('another person, no token, an expired session: refused; the screen drops what it held', opts, async () => {
  const B = await stack.person('apb');
  const mine = await q("select id from postona_x_resv.approval_candidates where user_id = :'u' order by created_at limit 1", { u: A.userId });
  assert.equal((await raw('get', { candidateId: mine }, B.token)).status, 404, 'another person: not found');
  assert.equal((await raw('approve', { candidateId: mine, expectedRevision: 1, contentSha256: '0'.repeat(64) }, B.token)).status, 404);
  const other = await raw('list', { socialAccountId: A.account }, B.token);
  assert.ok(other.status === 404 || (other.status === 200 && other.body.candidates.length === 0), JSON.stringify(other));
  assert.equal((await raw('notifications', {}, null)).status, 401, 'no token');
  const h = await mountFor(A);
  await until(h, (t) => has(t, '承認済み'), 'A sees theirs');
  h.frames.length = 0;
  await q("update auth.sessions set not_after = now() - interval '1 second' where id = :'s'", { s: A.sessionId });
  h.world.refocus += 1;
  const tree = await until(h, (t) => has(t, view.ACTION_TEXT.sign_in), 'expired');
  assert.ok(!has(tree, 'G1第44 承認の本文'), 'nothing of A stays');
  await q("update auth.sessions set not_after = null where id = :'s'", { s: A.sessionId });
});

test('two notification reads at once write one reservation_changed; with G5\'s ownership lock installed, an eligibility change adds no notification and no outbox row', opts, async () => {
  const resv = await q("select reservation_id from postona_x_resv.approval_candidates where user_id = :'u' and reservation_id is not null order by created_at limit 1", { u: A.userId });
  const row = (await stack.http('get', { reservationId: resv }, A.token)).rows[0];
  const moved = await stack.http('reschedule', { reservationId: resv, expectedRevision: row.revision, scheduledAt: new Date(Date.now() + 9 * 864e5).toISOString() }, A.token);
  assert.equal(moved.code, '200 ok');
  const [r1, r2] = await Promise.all([raw('notifications', {}, A.token), raw('notifications', {}, A.token)]);
  assert.deepEqual([r1.status, r2.status], [200, 200]);
  assert.equal(await q("select count(*) from postona_x_resv.notifications where user_id = :'u' and kind = 'reservation_changed' and reservation_id = :'r'", { u: A.userId, r: resv }), '1', 'one row for one change');

  const lock = await readFile(new URL('../../../../supabase/candidates/postona_workspace_ownership_lock/001_workspace_ownership_lock.sql', import.meta.url), 'utf8');
  const installed = await q(lock);
  assert.doesNotMatch(installed, /^ERR:/u, `G5 lock install: ${installed}`);
  assert.equal(await q("select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = 'brand_memberships' and not t.tgisinternal and t.tgname like '%ownership%'"), '1', 'the trigger is there');

  // the control is above: with the workspace still A's own, one change + one read wrote one row. Now the same with the lock installed and
  // another owner joining A's personal workspace before the read (SYNTHETIC: the row, as a Data API writer would insert it).
  const C = await stack.person('apc');
  const again = (await stack.http('get', { reservationId: resv }, A.token)).rows[0];
  assert.equal((await stack.http('reschedule', { reservationId: resv, expectedRevision: again.revision, scheduledAt: new Date(Date.now() + 10 * 864e5).toISOString() }, A.token)).code, '200 ok');
  const before = [await notesOf(A), await outboxOf(A)];
  const joined = await q("insert into public.brand_memberships (brand_id, user_id, role) values (:'b', :'u', 'owner') returning 'joined'", { b: A.workspace, u: C.userId });
  assert.equal(joined, 'joined');
  const after = await raw('notifications', {}, A.token);
  const listed = after.status === 200 ? after.body.notifications.length : null;
  assert.deepEqual([await notesOf(A), await outboxOf(A)], before, 'the workspace is no longer A\'s personal one: no new notification, no outbox row');
  const h = await mountFor(A, { screen: 'notifications' });
  const tree = await until(h, (t) => !has(t, '読み込んでいます'), 'the screen answers');
  // G1 TASK 46: one line per candidate for its approval requests (G3 §5a), so the lines are the server's rows, grouped
  const lines = after.status === 200 ? view.groupNotifications(after.body.notifications).length : 0;
  assert.equal(pressables(tree, 'お知らせ ').length, lines, 'the screen shows what the server returned, nothing more');
  console.log(`G1T44 measured: after the membership insert the notifications call answered ${after.status} ${after.body?.code ?? `rows=${listed}`}; notifications:read ${before[0]} -> ${await notesOf(A)}, outbox ${before[1]} -> ${await outboxOf(A)}`);
  // the zero was the eligibility: once the workspace is A's personal one again, the next read writes the change that was held back
  await q("delete from public.brand_memberships where brand_id = :'b' and user_id = :'u'", { b: A.workspace, u: C.userId });
  assert.equal((await raw('notifications', {}, A.token)).status, 200);
  assert.equal(await q("select count(*) from postona_x_resv.notifications where user_id = :'u' and kind = 'reservation_changed' and reservation_id = :'r'", { u: A.userId, r: resv }), '2', 'the held-back change is written now');
  console.log('G1T44_APPROVALS_LOCAL_STACK_PASS');
});

// ---- G1 TASK 45: what G2 #9 could not run on the Simulator, on the real runtime -------------------------------------------------------
const sent = (action) => wire.filter((w) => w.startsWith(`${action} `) && !w.endsWith('(not sent)') && !w.endsWith('answer lost')).length;
let R;
test('T45 reconfirm: another session revises the shown candidate -> 「承認」 gets 409 STALE -> the screen reads back the new text and version; the next 承認 uses them', opts, async () => {
  R = await stack.person('apr');
  const h = await mountFor(R);
  await until(h, (t) => has(t, '投稿候補はまだありません'), 'empty');
  await compose(h, 'G1第45 画面に出ている本文', jstIn(4));
  await pressables(h.once(), '投稿候補 ')[0].onPress();
  await until(h, (t) => !!button(t, '承認する'), 'open');
  const id = await q("select id from postona_x_resv.approval_candidates where user_id = :'u'", { u: R.userId });
  const other = await stack.signIn(R);
  const revised = await raw('revise', { candidateId: id, expectedRevision: 1, body: 'G1第45 別の端末で直した本文', scheduledAt: new Date(Date.now() + 4 * 864e5).toISOString() }, other.token);
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  const before = sent('approve');
  let tree = await approveShown(h, 'stale approve');
  assert.ok(has(tree, view.ACTION_TEXT.reread), texts(tree).join(' / '));
  assert.ok(has(tree, 'G1第45 別の端末で直した本文'), 'the read back shows the new text');
  assert.ok(texts(tree).some((t) => t.includes('版 2')), 'and the new version');
  assert.equal(sent('approve') - before, 1, 'not sent again on its own');
  assert.equal(await stack.rowCount(R.account), '0');
  tree = await approveShown(h, 'approve the new text');
  assert.ok(has(tree, view.APPROVED_TEXT), texts(tree).join(' / '));
  assert.equal(await stack.rowCount(R.account), '1');
  const shaSent = await q("select content_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex') from postona_x_resv.approval_candidates where id = :'i'", { i: id });
  assert.equal(shaSent, 't', 'the approved hash is the hash of the text shown last');
});

test('T45 a text that is not what the server hashed (SYNTHETIC: the row\'s body changed under it) is never approved: no approve leaves the device', opts, async () => {
  const h = await mountFor(R);
  await until(h, (t) => has(t, '承認済み'), 'list');
  await compose(h, 'G1第45 ハッシュの確認', jstIn(8));
  await q("update postona_x_resv.approval_candidates set body = body || '（書き換え）' where user_id = :'u' and state = 'pending_approval'", { u: R.userId });
  h.world.refocus += 1;
  let tree = await until(h, (t) => has(t, 'G1第45 ハッシュの確認（書き換え）'), 'the changed row read');
  const target = pressables(tree, '投稿候補 ').find((p) => p.accessibilityLabel.includes(jstIn(8).slice(0, 10)));
  target.onPress();
  tree = await until(h, (t) => !!button(t, '承認する'), 'open');
  const before = sent('approve');
  button(tree, '承認する').onPress();
  tree = await until(h, (t) => has(t, view.HASH_MISMATCH_TEXT), 'refused here');
  assert.equal(sent('approve'), before, 'nothing sent');
  await q("update postona_x_resv.approval_candidates set state = 'rejected', decided_at = now() where user_id = :'u' and state = 'pending_approval'", { u: R.userId });
});

test('T45 UNCERTAIN on the real runtime: a lost approve answer is read back as approved (one reservation); a lost submit answer is found by the list (one candidate); a submit that never left is sent again with the same request id', opts, async () => {
  const h = await mountFor(R);
  await until(h, (t) => has(t, '承認済み'), 'list');
  await compose(h, 'G1第45 答えが消える承認', jstIn(12));
  const rows = Number(await stack.rowCount(R.account));
  const target = pressables(h.once(), '投稿候補 ').find((p) => p.accessibilityLabel.includes(jstIn(12).slice(0, 10)));
  target.onPress();
  await until(h, (t) => !!button(t, '承認する'), 'open');
  lose.push('approve');
  button(h.once(), '承認する').onPress();
  let tree = await until(h, (t) => has(t, view.UNCERTAIN_REREAD_OK_TEXT) && has(t, '承認済み（予約に登録済み）') && !button(t, '承認する'), 'read back approved');
  assert.equal(Number(await stack.rowCount(R.account)), rows + 1, 'exactly one reservation');
  assert.ok(wire.includes('approve answer lost') && wire.at(-1).startsWith('get 200'), wire.slice(-4).join(' | '));
  button(h.once(), '最新の状態を読み込む').onPress();
  tree = await until(h, (t) => !has(t, view.UNCERTAIN_REREAD_OK_TEXT), 'the banner goes with the refresh');
  assert.equal(Number(await stack.rowCount(R.account)), rows + 1);

  const count = async () => Number(await q("select count(*) from postona_x_resv.approval_candidates where user_id = :'u'", { u: R.userId }));
  let n = await count();
  lose.push('submit');
  await h.type('投稿候補の本文', 'G1第45 答えが消えた候補');
  await h.type('投稿候補の日時', jstIn(15));
  button(h.once(), '承認に回す').onPress();
  tree = await until(h, (t) => has(t, view.SUBMIT_CONFIRMED_TEXT), 'the list says it was made');
  assert.equal(await count(), n + 1);

  n = await count();
  fail.push('submit', 'list');
  await h.type('投稿候補の本文', 'G1第45 届かなかった候補');
  await h.type('投稿候補の日時', jstIn(18));
  button(h.once(), '承認に回す').onPress();
  tree = await until(h, (t) => has(t, view.SUBMIT_PENDING_TEXT), 'press again');
  assert.equal(await count(), n, 'nothing was made');
  const submits = () => wire.filter((w) => w.startsWith('submit '));
  button(h.once(), '承認に回す').onPress();
  tree = await until(h, (t) => has(t, view.SUBMITTED_TEXT), 'made on the press again');
  assert.equal(await count(), n + 1);
  console.log(`G1T45 measured wire tail: ${wire.slice(-7).join(' | ')} (submits: ${submits().length})`);
});

test('T45 flag OFF (the product\'s gate constant): the same screens on the same runtime send nothing', opts, async () => {
  const gate = await readFile(new URL('../../src/features/approvals/approval-gate.ts', import.meta.url), 'utf8');
  assert.match(gate, /export const POSTONA_APPROVAL_UI_ENABLED = false;/u);
  const before = wire.length;
  for (const screen of ['approvals', 'notifications']) {
    const h = await mountFor(R, { gate: false, screen });
    const tree = await h.render(4);
    assert.ok(has(tree, view.POSTONA_APPROVAL_UI_GATE_TEXT), screen);
  }
  assert.equal(wire.length, before, 'no request at all');
  console.log('G1T45_APPROVALS_LOCAL_STACK_PASS');
});

// ---- G1 TASK 46 (G2 #10) on the real runtime --------------------------------------------------------------------------------------
async function reviseShown(h, text) {
  button(h.once(), '修正する').onPress();
  await until(h, (t) => texts(t).some((x) => x === '修正を保存') || !!button(t, '修正を保存'), 'edit open');
  await h.type('修正する本文', text);
  button(h.once(), '修正を保存').onPress();
  return until(h, (t) => has(t, view.REVISED_TEXT) && has(t, text), `revise ${text}`);
}
const unreadOf = async (p) => (await raw('notifications', {}, p.token)).body.notifications.filter((n) => n.readAt === null);

test('T46 grouping on the real runtime: revised twice + another candidate = 2 lines / 未読 2件; opening one marks its 3 rows read, one call each; no outbox change', opts, async () => {
  const G = await stack.person('apg');
  const h = await mountFor(G);
  await until(h, (t) => has(t, '投稿候補はまだありません'), 'empty');
  await compose(h, 'G1第46 候補X', jstIn(3));
  await pressables(h.once(), '投稿候補 ')[0].onPress();
  await until(h, (t) => !!button(t, '修正する'), 'open X');
  await reviseShown(h, 'G1第46 候補X 改1');
  await reviseShown(h, 'G1第46 候補X 改2');
  await compose(h, 'G1第46 候補Y', jstIn(4));
  const all = (await raw('notifications', {}, G.token)).body.notifications;
  const ids = [...new Set(all.map((n) => n.candidateId))];
  const x = ids.find((id) => all.filter((n) => n.candidateId === id && n.kind === 'approval_requested').length === 3);
  assert.ok(x, `G3 keeps three approval_requested rows for X: ${JSON.stringify(all.map((n) => [n.kind, n.candidateId, n.subjectRevision]))}`);
  const outbox = await outboxOf(G);
  let tree = await h.show('notifications');
  tree = await until(h, (t) => has(t, '未読 2件'), 'two lines unread');
  assert.equal(pressables(tree, 'お知らせ ').length, 2);
  assert.ok(has(tree, view.olderRequestsText(2)));
  const before = sent('markRead');
  pressables(tree, 'お知らせ ')[1].onPress();
  tree = await until(h, (t) => has(t, '未読 1件'), 'X read');
  assert.equal(sent('markRead') - before, 3, 'one call per row of X');
  const left = await unreadOf(G);
  assert.ok(left.length === 1 && left[0].candidateId !== x, `only Y is unread: ${JSON.stringify(left)}`);
  assert.equal(await outboxOf(G), outbox, 'reading changes no push outbox row');
  console.log(`G1T46 measured: X rows=${all.filter((n) => n.candidateId === x).length}, lines=2, markRead sent=${sent('markRead') - before}, outbox ${outbox} -> ${await outboxOf(G)}`);
});

test('T46 owner join on the real runtime: approve answers 403 X_ACCOUNT_NOT_VERIFIED; the screen says connection OR workspace, nothing is approved', opts, async () => {
  const O = await stack.person('apo');
  const C = await stack.person('apoc');
  const h = await mountFor(O);
  await until(h, (t) => has(t, '投稿候補はまだありません'), 'empty');
  await compose(h, 'G1第46 二人目の所有者', jstIn(5));
  await pressables(h.once(), '投稿候補 ')[0].onPress();
  await until(h, (t) => !!button(t, '承認する'), 'open');
  assert.equal(await q("insert into public.brand_memberships (brand_id, user_id, role) values (:'b', :'u', 'owner') returning 'joined'", { b: O.workspace, u: C.userId }), 'joined');
  try {
    button(h.once(), '承認する').onPress();
    const tree = await until(h, (t) => has(t, view.ACTION_TEXT.reconnect_x) || has(t, view.ACTION_TEXT.forbidden) || has(t, view.ACTION_TEXT.not_found), 'refused');
    const last = wire.filter((w) => w.startsWith('approve ')).at(-1);
    console.log(`G1T46 measured: approve after the 2nd owner joined answered ${last}`);
    assert.equal(last, 'approve 403 POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED');
    assert.ok(has(tree, view.ACTION_TEXT.reconnect_x));
    assert.match(await candidatesOf(O), /^pending_approval:1:false$/u);
    assert.equal(await stack.rowCount(O.account), '0');
  } finally {
    await q("delete from public.brand_memberships where brand_id = :'b' and user_id = :'u'", { b: O.workspace, u: C.userId });
  }
});

test('T46 service ended on the real runtime: writes 403 SERVICE_NOT_ACTIVE, reads 200; the read-only history shows the person\'s own only and sends no write; another person sees none of it', opts, async () => {
  const E = await stack.person('ape');
  const F = await stack.person('apf');
  const h = await mountFor(E);
  await until(h, (t) => has(t, '投稿候補はまだありません'), 'empty');
  await compose(h, 'G1第46 退会前の候補', jstIn(6));
  await pressables(h.once(), '投稿候補 ')[0].onPress();
  await until(h, (t) => !!button(t, '修正する'), 'open');
  await reviseShown(h, 'G1第46 退会前の候補 改1');
  const id = await q("select id from postona_x_resv.approval_candidates where user_id = :'u'", { u: E.userId });
  await stack.endService(E);
  const answers = {
    submit: await raw('submit', { socialAccountId: E.account, clientRequestId: crypto.randomUUID(), body: 'x', scheduledAt: new Date(Date.now() + 7 * 864e5).toISOString() }, E.token),
    revise: await raw('revise', { candidateId: id, expectedRevision: 2, body: 'y', scheduledAt: new Date(Date.now() + 7 * 864e5).toISOString() }, E.token),
    approve: await raw('approve', { candidateId: id, expectedRevision: 2, contentSha256: stack.sha256('G1第46 退会前の候補 改1') }, E.token),
    get: await raw('get', { candidateId: id }, E.token),
    notifications: await raw('notifications', {}, E.token),
  };
  console.log(`G1T46 measured (service ended): ${Object.entries(answers).map(([k, v]) => `${k} ${v.status} ${v.body?.code ?? 'ok'}`).join(', ')}`);
  for (const k of ['submit', 'revise', 'approve']) assert.deepEqual([answers[k].status, answers[k].body?.code], [403, 'POSTONA_RESV_SERVICE_NOT_ACTIVE'], k);
  assert.deepEqual([answers.get.status, answers.notifications.status], [200, 200]);
  assert.match(await candidatesOf(E), /^pending_approval:2:false$/u, 'nothing was written');

  const base = { endpoint: { functionName: FN, allowLoopbackHttpForTests: true }, config: { ok: true, config: { url: stack.API, publishableKey: stack.PUBLISHABLE } }, fetch: recorded, wait: () => new Promise((resolve) => setTimeout(resolve, 60)) };
  const at = wire.length;
  const mine = await mountEndedHistory({ ...base, userId: E.userId, session: { token: E.token, userId: E.userId } });
  let tree = await mine.render(4);
  for (let i = 0; i < 100 && !has(tree, 'G1第46 退会前の候補 改1'); i++) { await new Promise((resolve) => setTimeout(resolve, 100)); tree = await mine.render(2); }
  assert.ok(has(tree, 'G1第46 退会前の候補 改1'), `history: ${texts(tree).join(' / ')}`);
  assert.ok(has(tree, view.ENDED_HISTORY_NOTE));
  assert.ok(has(tree, view.olderRequestsText(1)), 'the two requests are one line');
  const actions = wire.slice(at).map((w) => w.split(' ')[0]);
  assert.deepEqual([...new Set(actions)].sort(), ['get', 'notifications'], `only reads: ${wire.slice(at).join(' | ')}`);

  const other = await mountEndedHistory({ ...base, userId: F.userId, session: { token: F.token, userId: F.userId } });
  tree = await other.render(4);
  for (let i = 0; i < 100 && !has(tree, 'お知らせはありません'); i++) { await new Promise((resolve) => setTimeout(resolve, 100)); tree = await other.render(2); }
  assert.ok(other.frames.every((f) => !has(f, 'G1第46 退会前の候補')), 'F never sees E\'s rows');
  assert.ok(has(tree, '表示できる投稿候補はありません。'));
  assert.equal((await raw('get', { candidateId: id }, F.token)).status, 404, 'E\'s candidate is not F\'s');

  const crossed = wire.length;
  const stale = await mountEndedHistory({ ...base, userId: E.userId, session: { token: F.token, userId: F.userId } });
  tree = await stale.render(4);
  assert.equal(wire.length, crossed, 'E\'s view sends nothing with F\'s session');
  assert.ok(!has(tree, 'G1第46 退会前の候補'));
  console.log('G1T46_APPROVALS_LOCAL_STACK_PASS');
});

// G1 TASK 47 (G2 #11 P3): the notification screen left open while the service ends, on the real runtime. The screen's fresh check is the
// gate's: the same start RPC (start_x_autopost_service, through Kong and PostgREST with the person's own JWT) mapped as
// service-enrollment-gate.tsx maps it (its own tests drive the real gate). Measured: what the app sent, what the server holds.
import { createSessionBoundTransport, startServiceAutomatically } from '../../src/domain/service-enrollment.ts';
const gateCheck = (p, asked) => async () => {
  // Its own fetch: the screens' `recorded` wire keeps only what the approval client sent.
  const transport = createSessionBoundTransport({ url: stack.API, apiKey: stack.PUBLISHABLE, accessToken: p.token, fetch: REAL_FETCH });
  let outcome;
  try { outcome = await startServiceAutomatically(transport, 'x_autopost', new AbortController().signal); } catch { asked.push('no answer'); return 'unknown'; }
  asked.push(outcome.kind);
  if (outcome.kind === 'reenroll_required') asked.version = outcome.lifecycleVersion;
  return outcome.kind === 'ready' ? 'active' : outcome.kind === 'reenroll_required' ? 'ended' : 'unknown';
};
const readAtOf = (p) => q("select coalesce(string_agg((read_at is not null)::text, ',' order by created_at), '') from postona_x_resv.notifications where user_id = :'u'", { u: p.userId });

test('T47 G2 #11 P3 on the real runtime: service ended with the notification screen open -> the tap sends no markRead, the rows stay unread, the screen is read-only; G3 itself would still accept it (measured); restart -> marks once', opts, async () => {
  const P = await stack.person('apq');
  const asked = [];
  const h = await mountFor(P, { lifecycle: gateCheck(P, asked) });
  await until(h, (t) => has(t, '投稿候補はまだありません'), 'empty');
  await compose(h, 'G1第47 退会前の候補', jstIn(4));
  let tree = await h.show('notifications');
  tree = await until(h, (t) => has(t, '未読 1件'), 'one unread');
  assert.equal(await readAtOf(P), 'false');
  assert.ok(asked.includes('ready'), `the screen asked the gate on its read: ${asked.join(',')}`);

  await stack.endService(P);   // ended elsewhere (another device / tab): this app decided 'ready' at sign-in
  const at = wire.length;
  pressables(tree, 'お知らせ ')[0].onPress();
  tree = await until(h, (t) => has(t, view.NOTIFICATIONS_ENDED_TEXT), 'read-only');
  assert.equal(asked.at(-1), 'reenroll_required', 'the start RPC answered the end; it restarted nothing');
  assert.equal(await q("select status from public.service_entitlements where user_id = :'u' and service_key = 'x_autopost'", { u: P.userId }), 'ended');
  assert.deepEqual(wire.slice(at).filter((w) => w.startsWith('markRead')), [], 'no markRead left the app');
  assert.equal(await readAtOf(P), 'false', 'the server row is unread');
  assert.ok(pressables(tree, 'お知らせ ').every((r) => r.disabled === true));
  h.world.refocus += 1;   // back to the screen
  tree = await until(h, (t) => has(t, view.NOTIFICATIONS_ENDED_TEXT) && has(t, '未読 1件'), 'still read-only after the re-read');
  pressables(tree, 'お知らせ ')[0].onPress();
  await h.render(3);
  assert.deepEqual(wire.slice(at).filter((w) => w.startsWith('markRead')), [], 'nor after the re-read');
  const sentActions = [...new Set(wire.slice(at).map((w) => w.split(' ')[0]))];
  assert.deepEqual(sentActions, ['notifications'], `only reads: ${wire.slice(at).join(' | ')}`);

  // The residual G3 boundary, measured with the person's own token outside the app (not something the app does): still 200.
  const noteId = await q("select id from postona_x_resv.notifications where user_id = :'u'", { u: P.userId });
  const direct = await raw('markRead', { notificationId: noteId }, P.token);
  console.log(`G1T47 measured: after the end the app sent markRead 0 (read_at stayed null); a direct markRead with the same JWT answered ${direct.status} ${direct.body?.code ?? 'ok'} (G3 server-side guard absent)`);
  assert.equal(direct.status, 200, 'G3 still accepts it: the server guard is G3\'s to add');
  await q("update postona_x_resv.notifications set read_at = null where id = :'n'", { n: noteId });

  // The person's own restart (the gate's reactivate RPC at the version the check reported), then a fresh screen: the read goes once.
  const restarted = await stack.rpc('reactivate_x_autopost_service', P.token, { p_expected_lifecycle_version: asked.version });
  assert.deepEqual([restarted.status, restarted.body?.status], [200, 'active'], JSON.stringify(restarted.body));
  const again = await mountFor(P, { lifecycle: gateCheck(P, asked), screen: 'notifications' });
  tree = await until(again, (t) => has(t, '未読 1件') && !has(t, view.NOTIFICATIONS_ENDED_TEXT), 'active again');
  const before = wire.length;
  pressables(tree, 'お知らせ ')[0].onPress();
  await until(again, (t) => has(t, '未読 0件'), 'read');
  assert.deepEqual(wire.slice(before).filter((w) => w.startsWith('markRead')), ['markRead 200 ok']);
  assert.equal(await readAtOf(P), 'true');
  console.log(`G1T47 measured: checks ${asked.join(' -> ')}; after the restart markRead sent 1`);
  console.log('G1T47_APPROVALS_LOCAL_STACK_PASS');
});

test('T47 on the real runtime: an expired / foreign JWT gives the check no answer -> nothing marked; another person\'s screen reads none of P\'s rows', opts, async () => {
  const P = await stack.person('apr');
  const R = await stack.person('aps');
  const asked = [];
  const h = await mountFor(P, { lifecycle: gateCheck({ ...P, token: `${P.token.slice(0, -4)}AAAA` }, asked) });
  await until(h, (t) => has(t, '投稿候補はまだありません'), 'empty');
  await compose(h, 'G1第47 署名の壊れたJWT', jstIn(4));
  let tree = await h.show('notifications');
  tree = await until(h, (t) => has(t, '未読 1件'), 'one unread');
  const at = wire.length;
  pressables(tree, 'お知らせ ')[0].onPress();
  tree = await until(h, (t) => has(t, view.LIFECYCLE_UNKNOWN_TEXT), 'not confirmed');
  assert.ok(asked.every((a) => a === 'no answer'), asked.join(','));
  assert.deepEqual(wire.slice(at).filter((w) => w.startsWith('markRead')), []);
  assert.equal(await readAtOf(P), 'false');
  const other = await mountFor(R, { lifecycle: gateCheck(R, []), screen: 'notifications' });
  tree = await until(other, (t) => has(t, 'お知らせはありません'), 'R empty');
  assert.ok(other.frames.every((f) => !has(f, 'G1第47')), 'R never sees P\'s rows');
});
