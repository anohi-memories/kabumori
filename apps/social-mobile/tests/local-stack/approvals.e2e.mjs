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
const recorded = async (url, init) => { const r = await REAL_FETCH(url, init); const c = await r.clone().json().catch(() => null); wire.push(`${JSON.parse(init.body).action} ${r.status} ${c?.code ?? 'ok'}`); return r; };
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
  assert.equal(pressables(tree, 'お知らせ ').length, listed ?? 0, 'the screen shows what the server returned, nothing more');
  console.log(`G1T44 measured: after the membership insert the notifications call answered ${after.status} ${after.body?.code ?? `rows=${listed}`}; notifications:read ${before[0]} -> ${await notesOf(A)}, outbox ${before[1]} -> ${await outboxOf(A)}`);
  // the zero was the eligibility: once the workspace is A's personal one again, the next read writes the change that was held back
  await q("delete from public.brand_memberships where brand_id = :'b' and user_id = :'u'", { b: A.workspace, u: C.userId });
  assert.equal((await raw('notifications', {}, A.token)).status, 200);
  assert.equal(await q("select count(*) from postona_x_resv.notifications where user_id = :'u' and kind = 'reservation_changed' and reservation_id = :'r'", { u: A.userId, r: resv }), '2', 'the held-back change is written now');
  console.log('G1T44_APPROVALS_LOCAL_STACK_PASS');
});
