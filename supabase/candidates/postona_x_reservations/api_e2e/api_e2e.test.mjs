// POSTONA X reservations — end-to-end on a disposable LOCAL PostgreSQL (run through api_e2e_run.sh only).
// Real code path: app remote store -> API handler (api.ts) -> postona_resv_api role -> SQL candidate (001 + 002).
// MOCK_ONLY: the token verifier, the TS permission sources and the G5 / G4 SQL predicates are test doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReservationApi } from '../../../functions/_shared/postona_reservations/api.ts';
import { createRemoteReservationStore } from '../../../../apps/social-mobile/src/features/schedule/remote-reservation-store.ts';
import { buildSaveRequest, confirmPost } from '../../../../apps/social-mobile/src/domain/reservation-flow.ts';
import { planBatch, jstDateOf } from '../../../../apps/social-mobile/src/domain/schedule-planner.ts';
import { psqlAs, psqlReservationDb } from './psql_db.mjs';

const env = (name) => {
  const value = process.env[name];
  assert.ok(value, `${name} is set by api_e2e_run.sh`);
  return value;
};
const conn = { host: env('RESV_E2E_HOST'), port: env('RESV_E2E_PORT'), database: env('RESV_E2E_DB') };
const asOwner = (sql) => psqlAs({ ...conn, role: env('RESV_E2E_OWNER') }, sql);

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const TOKENS = { 'token-user-a-000000000000': A, 'token-user-b-000000000000': B, 'token-user-c-000000000000': C };
const sha256 = async (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const DAY = 24 * 60 * 60 * 1000;
const dayAhead = (n) => jstDateOf(Date.now() + n * DAY);

const dbCalls = [];
const db = psqlReservationDb({ ...conn, loginRole: env('RESV_E2E_LOGIN'), onCall: (fn, subject) => dbCalls.push([fn, subject]) });
// MOCK_ONLY permission sources: allow at the TS layer so the DATABASE predicates are what is proven to refuse.
const api = createReservationApi({
  enabled: true,
  auth: { verify: (token) => Promise.resolve(TOKENS[token] ? { userId: TOKENS[token] } : null) },
  permissions: { xAutopostAllowed: () => Promise.resolve(true), xAccountVerified: () => Promise.resolve(true) },
  db,
});
/** HTTP-like transport: the call and the answer are serialised as JSON, exactly like the wire. */
const httpTransport = async (call, token) => {
  const response = await api({ method: 'POST', authorization: `Bearer ${token}`, body: JSON.stringify(call) });
  return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) };
};
const storeFor = (token, transport = httpTransport) => createRemoteReservationStore({ transport, getAccessToken: () => Promise.resolve(token) });
const storeA = () => storeFor('token-user-a-000000000000');
const storeB = () => storeFor('token-user-b-000000000000');
const storeC = () => storeFor('token-user-c-000000000000');

const OWNER_A = { accountId: 'x_a', brandId: 'brand_a', platform: 'x' };
const OPT_OUT = { source: 'saved', approvalMode: 'manual_review' };
async function confirmedRequest(planned, aiOptIn = OPT_OUT) {
  assert.equal(planned.ok, true, JSON.stringify(planned.issues));
  const confirmations = {};
  for (const draft of planned.drafts) if (draft.origin === 'user_authored') confirmations[draft.id] = await confirmPost(draft, sha256);
  const built = await buildSaveRequest({ batch: planned.batch, drafts: planned.drafts, confirmations, aiOptIn, sha256 });
  assert.equal(built.ok, true, JSON.stringify(built.issues));
  return built.request;
}
const exactPlan = (batchId, day, owner = OWNER_A) => planBatch({
  mode: 'manual_exact',
  posts: [{ text: '朝の告知', date: dayAhead(day), time: '08:30' }, { text: '昼の告知', date: dayAhead(day), time: '12:00' }, { text: '夜の告知', date: dayAhead(day + 1), time: '21:15' }],
}, { owner, now: new Date(), batchId });
const listRows = async (store, account = 'x_a') => {
  const result = await store.list(account);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};

let saved; // the exact batch's rows, shared by the sequential tests below

test('save: confirmed manual posts -> create -> independent read-back -> saved; the rows are planned and confirmed', async () => {
  const request = await confirmedRequest(exactPlan('6f1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e01', 3));
  dbCalls.length = 0;
  const outcome = await storeA().save(request);
  assert.equal(outcome.kind, 'saved', JSON.stringify(outcome));
  assert.deepEqual(dbCalls.map(([fn]) => fn), ['create_batch', 'list_reservations'], 'the write is followed by a separate read');
  assert.ok(dbCalls.every(([, subject]) => subject === A), 'every call runs as the verified subject');
  saved = outcome.reservations;
  assert.equal(saved.length, 3);
  assert.ok(saved.every((row) => row.status === 'planned' && row.consentState === 'confirmed' && row.revision === 1));
  assert.deepEqual(saved.map((row) => row.body), ['朝の告知', '昼の告知', '夜の告知']);
});

test('restart: a fresh client (new store, nothing in memory) lists exactly the stored rows', async () => {
  const rows = await listRows(storeA());
  assert.deepEqual(rows.map((row) => row.reservationId).sort(), saved.map((row) => row.reservationId).sort());
});

test('idempotent retry: the same request again returns the same rows and stores nothing twice', async () => {
  const request = await confirmedRequest(exactPlan('6f1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e01', 3));
  const again = await storeA().save(request);
  assert.equal(again.kind, 'saved');
  assert.deepEqual(again.reservations.map((row) => row.reservationId).sort(), saved.map((row) => row.reservationId).sort());
  assert.equal((await listRows(storeA())).length, 3);
});

test('uncertain: a lost answer is resolved only by the read-back; an unreachable server is never shown as saved', async () => {
  // The create reached the server, but its answer was lost: the read-back proves it was stored.
  const lostAnswer = async (call, token) => {
    const response = await httpTransport(call, token);
    if (call.action === 'create') throw new Error('connection reset after send');
    return response;
  };
  const request = await confirmedRequest(exactPlan('6f1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e02', 6));
  const outcome = await storeFor('token-user-a-000000000000', lostAnswer).save(request);
  assert.equal(outcome.kind, 'saved');
  // Nothing reaches the server: the outcome is uncertain, and a later retry with the same key saves it once.
  const offline = async () => { throw new Error('offline'); };
  const request2 = await confirmedRequest(exactPlan('6f1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e03', 9));
  assert.deepEqual(await storeFor('token-user-a-000000000000', offline).save(request2), { kind: 'uncertain', code: 'UNCERTAIN' });
  const retried = await storeA().save(request2);
  assert.equal(retried.kind, 'saved');
  assert.equal((await storeA().save(request2)).kind, 'saved');
  assert.equal((await listRows(storeA())).length, 9, 'three batches of three, no duplicates');
});

test('change: reschedule (CAS) invalidates the consent, reconfirm restores it, a stale revision is refused', async () => {
  const store = storeA();
  const row = saved[0];
  const newAt = new Date(Date.parse(row.scheduledAt) + 2 * 60 * 60 * 1000).toISOString();
  const moved = await store.reschedule(row.reservationId, row.revision, newAt);
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.value.revision, 2);
  assert.equal(moved.value.consentState, 'needs_reconfirm');
  assert.equal(new Date(moved.value.scheduledAt).toISOString(), newAt);
  assert.deepEqual(await store.reschedule(row.reservationId, 1, newAt), { ok: false, code: 'POSTONA_RESV_STALE_REVISION' });
  assert.deepEqual(await store.reconfirm(row.reservationId, 2, await sha256('別の本文')), { ok: false, code: 'POSTONA_RESV_CONSENT_REQUIRED' });
  const reconfirmed = await store.reconfirm(row.reservationId, 2, await sha256('朝の告知'));
  assert.equal(reconfirmed.ok, true);
  assert.equal(reconfirmed.value.consentState, 'confirmed');
  // A fresh client sees the same state.
  const fresh = (await listRows(storeA())).find((r) => r.reservationId === row.reservationId);
  assert.deepEqual([fresh.revision, fresh.consentState], [2, 'confirmed']);
});

test('cancel: CAS, terminal, read back by a fresh client', async () => {
  const row = saved[2];
  assert.deepEqual(await storeA().cancel(row.reservationId, 7), { ok: false, code: 'POSTONA_RESV_STALE_REVISION' });
  const cancelled = await storeA().cancel(row.reservationId, 1);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.value.status, 'cancelled');
  assert.deepEqual(await storeA().cancel(row.reservationId, 2), { ok: false, code: 'POSTONA_RESV_ALREADY_FINAL' });
  assert.equal((await listRows(storeA())).find((r) => r.reservationId === row.reservationId).status, 'cancelled');
});

test('tenants: another user, a member (not owner), a Threads account and an ineligible brand never see or change anything', async () => {
  assert.deepEqual(await storeB().list('x_a'), { ok: false, code: 'POSTONA_RESV_ACCOUNT_NOT_FOUND' });
  assert.deepEqual(await storeB().get(saved[1].reservationId), { ok: false, code: 'POSTONA_RESV_NOT_FOUND' });
  assert.deepEqual(await storeB().cancel(saved[1].reservationId, 1), { ok: false, code: 'POSTONA_RESV_NOT_FOUND' });
  assert.deepEqual(await storeC().list('x_a'), { ok: false, code: 'POSTONA_RESV_ACCOUNT_NOT_FOUND' });
  assert.deepEqual(await storeA().list('th_a'), { ok: false, code: 'POSTONA_RESV_ACCOUNT_NOT_FOUND' });
  assert.deepEqual(await storeA().list('x_kabu'), { ok: false, code: 'POSTONA_RESV_BRAND_NOT_ELIGIBLE' });
  assert.deepEqual(await listRows(storeB(), 'x_b'), [], 'B sees only B');
  // B saving into A's account is refused and stores nothing.
  const intoA = await confirmedRequest(exactPlan('6f1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e04', 12));
  assert.deepEqual(await storeB().save(intoA), { kind: 'failed', code: 'POSTONA_RESV_ACCOUNT_NOT_FOUND' });
  assert.equal(saved[1].status, 'planned');
  assert.equal((await listRows(storeA())).find((r) => r.reservationId === saved[1].reservationId).status, 'planned');
});

test('authentication: no token never reaches the transport; an unknown token is refused by the API', async () => {
  let sent = 0;
  const noToken = createRemoteReservationStore({ transport: async (...args) => { sent += 1; return httpTransport(...args); }, getAccessToken: () => Promise.resolve(null) });
  assert.deepEqual(await noToken.list('x_a'), { ok: false, code: 'AUTH_REQUIRED' });
  assert.equal(sent, 0);
  assert.deepEqual(await storeFor('token-unknown-0000000000').list('x_a'), { ok: false, code: 'AUTH_REQUIRED' });
});

test('interval: the cadence from the planner request is saved; a moved instant is refused atomically by the server', async () => {
  const planned = planBatch({ mode: 'manual_interval', texts: ['間隔1', '間隔2', '間隔3'], startDate: dayAhead(20), startTime: '09:00', every: { unit: 'days', value: 2 } },
    { owner: OWNER_A, now: new Date(), batchId: '6f1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e05' });
  const request = await confirmedRequest(planned);
  assert.deepEqual(request.items.map((item) => item.slot), [0, 1, 2]);
  const before = (await listRows(storeA())).length;
  const tampered = structuredClone(request);
  tampered.clientBatchId = '6f1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e06';
  tampered.items[2].scheduled_at = new Date(Date.parse(tampered.items[2].scheduled_at) + 90 * 60 * 1000).toISOString();
  assert.deepEqual(await storeA().save(tampered), { kind: 'failed', code: 'POSTONA_RESV_INTERVAL_MISMATCH' });
  assert.equal((await listRows(storeA())).length, before, 'nothing stored');
  const ok = await storeA().save(request);
  assert.equal(ok.kind, 'saved');
  assert.ok(ok.reservations.every((row) => row.mode === 'manual_interval'));
});

test('random: 10 posts inside their band are saved; AI: "これで覚えて" is not consent, only the saved auto_post_preference', async () => {
  const texts = Array.from({ length: 10 }, (_, i) => `ランダム${i + 1}`);
  const random = planBatch({ mode: 'manual_random_batch', texts, dateFrom: dayAhead(30), dateTo: dayAhead(40), window: { start: '09:00', end: '21:00' } },
    { owner: OWNER_A, now: new Date(), batchId: '6f1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e07' });
  assert.equal((await storeA().save(await confirmedRequest(random))).kind, 'saved');
  const ai = planBatch({ mode: 'ai_flexible', frequencyTargetPerWeek: 3, publishWindow: { start: '18:00', end: '22:00' }, dateFrom: dayAhead(50), dateTo: dayAhead(56), approvalMode: 'auto_post_preference' },
    { owner: OWNER_A, now: new Date(), batchId: '6f1c0f4e-3b0a-4f2b-9a51-0a0b0c0d0e08' });
  // The client is told the owner opted in, but the server reads the brand's own setting: none saved yet.
  const request = await confirmedRequest(ai, { source: 'saved', approvalMode: 'auto_post_preference' });
  assert.deepEqual(await storeA().save(request), { kind: 'failed', code: 'POSTONA_RESV_AI_NOT_OPTED_IN' });
  asOwner(`insert into public.social_mobile_content_settings values ('brand_a', '{"approvalMode":"auto_post_preference"}')`);
  const aiSaved = await storeA().save(request);
  assert.equal(aiSaved.kind, 'saved');
  assert.ok(aiSaved.reservations.every((row) => row.origin === 'ai_generated' && row.body === null && row.consentState === 'ai_owner_opt_in'));
});

test('MOCK_ONLY G5 / G4 revoked in the database: refused even though the TS permission layer said allow', async () => {
  asOwner(`update t.mock_entitlement set status = 'ended' where user_id = '${A}'`);
  assert.deepEqual(await storeA().list('x_a'), { ok: false, code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE' });
  assert.deepEqual(await storeA().cancel(saved[1].reservationId, 1), { ok: false, code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE' });
  asOwner(`update t.mock_entitlement set status = 'active' where user_id = '${A}'`);
  asOwner(`delete from t.mock_verified where social_account_id = 'x_a'`);
  assert.deepEqual(await storeA().list('x_a'), { ok: false, code: 'POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED' });
  asOwner(`insert into t.mock_verified values ('${A}', 'x_a')`);
  assert.equal((await storeA().list('x_a')).ok, true);
});

test('active delivery: a claimed row cannot be cancelled; a permission lost after the claim stops the send (pre-publish gate)', async () => {
  const target = saved[1].reservationId;
  // Worker side (owner role, test-only time travel): make the row due and claim it.
  asOwner(`update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute' where id = '${target}'`);
  const claimed = asOwner(`select reservation_id || ' ' || lease_token from postona_x_resv.claim_due('worker-e2e', 120, 50)`).split('\n').filter(Boolean);
  assert.equal(claimed.length, 1);
  const [claimedId, lease] = claimed[0].split(' ');
  assert.equal(claimedId, target);
  assert.deepEqual(await storeA().cancel(target, 1), { ok: false, code: 'POSTONA_RESV_CANCEL_TOO_LATE' });
  asOwner(`update t.mock_entitlement set status = 'ended' where user_id = '${A}'`);
  assert.equal(asOwner(`select postona_x_resv.pre_publish_check('${target}', '${lease}')`), 'NOT_PUBLISHABLE');
  asOwner(`update t.mock_entitlement set status = 'active' where user_id = '${A}'`);
  const row = (await listRows(storeA())).find((r) => r.reservationId === target);
  assert.equal(row.status, 'failed', 'never sent; shown as not posted');
});
