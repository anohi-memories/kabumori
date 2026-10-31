// G3-02 #5: the app's Threads reservation store against scripted transports (no network). The end-to-end proof against the real local
// Supabase runtime (GoTrue / Kong / Edge / Postgres) is supabase/candidates/postona_reservations_rollout/local_stack/run.sh (L13 / L14).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createRemoteThreadsReservationStore,
  createThreadsReservationStore,
  DISABLED_THREADS_RESERVATION_STORE,
  POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED,
} from '../src/features/schedule/remote-threads-reservation-store.ts';
import { UNCERTAIN } from '../src/features/schedule/remote-reservation-store.ts';

const RID = '11111111-2222-4333-8444-555555555555';
const CRID = '00000000-0000-4000-8000-0000000000e1';
const REQUEST = { socialAccountId: 'th_a', clientRequestId: CRID, text: '本文', contentSha256: 'a'.repeat(64), scheduledAt: '2026-11-03T00:30:00.000Z' };
const receipt = (state, over = {}) => ({ reservationId: RID, state, providerPostId: null, outcomeCode: null, afterFreeze: false, simulated: true, ...over });
const ok = (body) => ({ status: 200, body: { ok: true, ...body } });
const refused = (status, code) => ({ status, body: { ok: false, code } });
const boom = () => { throw new Error('socket closed'); };

function scripted(answers) {
  const calls = [];
  const transport = async (call, token) => {
    calls.push({ ...call, token });
    const answer = answers[call.action];
    if (typeof answer === 'function') return answer();
    return answer;
  };
  return { transport, calls };
}
const store = (transport, token = 'token-user-a-0123456789') => createRemoteThreadsReservationStore({ transport, getAccessToken: () => Promise.resolve(token) });

test('gate OFF: the factory answers the disabled store even with a live client; the constant is a literal false', async () => {
  assert.equal(POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED, false);
  const live = { supabaseUrl: 'https://project.example.invalid', session: { auth: { getSession: async () => ({ data: { session: { access_token: 't' } }, error: null }) } } };
  assert.equal(createThreadsReservationStore(undefined, live), DISABLED_THREADS_RESERVATION_STORE);
  assert.deepEqual(await DISABLED_THREADS_RESERVATION_STORE.create(REQUEST), { kind: 'not_available' });
  assert.equal(createThreadsReservationStore(true, live).enabled, true, 'only gate ON + a live client builds it');
  assert.throws(() => createThreadsReservationStore(true, { ...live, supabaseUrl: 'http://project.example.invalid' }), /HTTPS/u);
});

test('create is saved only when a separate receipt reads pending; the request is sent as built with the token', async () => {
  const { transport, calls } = scripted({ create: ok({ reservation: { reservationId: RID, status: 'planned', created: true } }), receipt: ok({ receipt: receipt('pending') }) });
  assert.deepEqual(await store(transport).create(REQUEST), { kind: 'saved', receipt: receipt('pending') });
  assert.deepEqual(calls.map((c) => [c.action, c.payload, c.token]), [
    ['create', REQUEST, 'token-user-a-0123456789'],
    ['receipt', { socialAccountId: 'th_a', clientRequestId: CRID }, 'token-user-a-0123456789'],
  ]);
});

test('U8 / G4 / G5 refusals are definite failures with their code and no receipt; gate OFF on the server is not_available', async () => {
  for (const [status, code] of [[403, 'POSTONA_THREADS_RESV_PUBLISH_DISABLED'], [403, 'POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED'], [403, 'POSTONA_RESV_SERVICE_NOT_ACTIVE'],
    [404, 'POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND'], [409, 'POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT'], [422, 'POSTONA_THREADS_RESV_CONSENT_REQUIRED']]) {
    const { transport, calls } = scripted({ create: refused(status, code) });
    assert.deepEqual(await store(transport).create(REQUEST), { kind: 'failed', code }, code);
    assert.deepEqual(calls.map((c) => c.action), ['create']);
  }
  assert.deepEqual(await store(scripted({ create: refused(503, 'NOT_AVAILABLE') }).transport).create(REQUEST), { kind: 'not_available' });
  assert.deepEqual(await store(scripted({ create: { status: 401, body: { code: 401, message: 'Invalid JWT' } } }).transport).create(REQUEST), { kind: 'failed', code: 'AUTH_REQUIRED' },
    "the gateway's own 401 body is a definite sign-in refusal");
  assert.deepEqual(await store(scripted({ create: { status: 429, body: null } }).transport).create(REQUEST), { kind: 'failed', code: 'RATE_LIMITED' });
});

test('an unknown create outcome: the receipt decides; otherwise uncertain (the same clientRequestId may be sent again), never saved', async () => {
  assert.equal((await store(scripted({ create: boom, receipt: ok({ receipt: receipt('pending') }) }).transport).create(REQUEST)).kind, 'saved');
  for (const create of [boom, refused(503, 'STORE_UNAVAILABLE'), refused(500, 'INTERNAL'), { status: 502, body: null }]) {
    assert.deepEqual(await store(scripted({ create, receipt: refused(404, 'POSTONA_THREADS_RESV_NOT_FOUND') }).transport).create(REQUEST), { kind: 'uncertain', code: UNCERTAIN });
    assert.deepEqual(await store(scripted({ create, receipt: boom }).transport).create(REQUEST), { kind: 'uncertain', code: UNCERTAIN });
  }
  assert.deepEqual(await store(scripted({ create: ok({ reservation: { reservationId: RID } }), receipt: ok({ receipt: receipt('uncertain') }) }).transport).create(REQUEST),
    { kind: 'failed', code: 'READ_BACK_UNCERTAIN' }, "an uncertain receipt is never saved (it may have reached Threads)");
  assert.deepEqual(await store(scripted({ create: boom, receipt: ok({ receipt: { reservationId: RID, state: 'weird' } }) }).transport).create(REQUEST), { kind: 'uncertain', code: UNCERTAIN });
});

test('cancel is confirmed by a receipt reading cancelled; a refusal keeps its code; unknown is UNCERTAIN', async () => {
  const done = scripted({ cancel: ok({ reservation: { reservationId: RID, status: 'cancelled' } }), receipt: ok({ receipt: receipt('cancelled') }) });
  assert.deepEqual(await store(done.transport).cancel(RID, 'th_a', CRID), { ok: true, value: receipt('cancelled') });
  assert.deepEqual(done.calls.map((c) => c.action), ['cancel', 'receipt']);
  assert.deepEqual(await store(scripted({ cancel: refused(409, 'POSTONA_THREADS_RESV_NOT_CANCELLABLE') }).transport).cancel(RID, 'th_a', CRID), { ok: false, code: 'POSTONA_THREADS_RESV_NOT_CANCELLABLE' });
  assert.deepEqual(await store(scripted({ cancel: boom, receipt: ok({ receipt: receipt('pending') }) }).transport).cancel(RID, 'th_a', CRID), { ok: false, code: UNCERTAIN });
});

test('no access token: nothing is sent at all', async () => {
  const { transport, calls } = scripted({});
  const s = createRemoteThreadsReservationStore({ transport, getAccessToken: () => Promise.resolve(null) });
  assert.deepEqual(await s.create(REQUEST), { kind: 'failed', code: 'AUTH_REQUIRED' });
  assert.deepEqual(await s.receipt('th_a', CRID), { ok: false, code: 'AUTH_REQUIRED' });
  assert.equal(calls.length, 0);
});

test('source: no Supabase client, storage, logging or provider call in the Threads store', async () => {
  const source = await readFile(new URL('../src/features/schedule/remote-threads-reservation-store.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
  assert.doesNotMatch(code, /createClient|AsyncStorage|localStorage|SecureStore|service_role|SERVICE_ROLE|console\.|graph\.threads|threads\.net/iu);
  assert.match(code, /export const POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED = false as const;/u);
});
