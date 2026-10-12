// The app's remote reservation store against scripted transports (no network). The end-to-end proof against
// the real handler and a disposable PostgreSQL is supabase/candidates/postona_x_reservations/api_e2e_run.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { createFetchTransport, createRemoteReservationStore, UNCERTAIN } from '../src/features/schedule/remote-reservation-store.ts';
import * as reservationFlow from '../src/domain/reservation-flow.ts';
import * as planner from '../src/domain/schedule-planner.ts';

const BATCH = '0f9d2a52-8c1b-4b6a-9d55-1a2b3c4d5e6f';
const AT = ['2026-10-20T00:30:00.000Z', '2026-10-20T03:00:00.000Z'];
const SHA = 'a'.repeat(64);
const REQUEST = {
  socialAccountId: 'x_a', clientBatchId: BATCH, revision: 1, mode: 'manual_exact', band: null,
  items: AT.map((at, i) => ({ draft_id: `${BATCH}:${i}`, scheduled_at: at, body: `本文${i}`, consent: { confirmed: true, content_sha256: SHA } })),
};
const row = (i, over = {}) => ({
  reservationId: `11111111-2222-4333-8444-55555555555${i}`, batchId: 'b-server', draftId: `${BATCH}:${i}`, position: i, origin: 'user_authored',
  mode: 'manual_exact', body: `本文${i}`, scheduledAt: AT[i] ?? AT[0], fixed: true, status: 'planned', revision: 1, consentState: 'confirmed', ...over,
});
const ok = (rows) => ({ status: 200, body: { ok: true, reservations: rows } });
const refused = (status, code) => ({ status, body: { ok: false, code } });

/** Scripted transport: each action answers from its own queue (a function may throw = unknown outcome). */
function scripted(script) {
  const calls = [];
  const transport = async (call, token) => {
    calls.push({ action: call.action, payload: call.payload, token });
    const queue = script[call.action];
    const next = Array.isArray(queue) ? queue.shift() : queue;
    if (next === undefined) throw new Error(`unscripted ${call.action}`);
    return typeof next === 'function' ? next() : structuredClone(next);
  };
  return { transport, calls };
}
const store = (transport, token = 'token-user-a-0123456789') => createRemoteReservationStore({ transport, getAccessToken: () => Promise.resolve(token) });
const boom = () => { throw new Error('connection reset'); };

test('saved only after an independent read-back matches every item; the request is sent as built, with the token', async () => {
  const { transport, calls } = scripted({ create: ok([row(0), row(1)]), list: ok([row(0), row(1)]) });
  const outcome = await store(transport).save(REQUEST);
  assert.equal(outcome.kind, 'saved');
  assert.deepEqual(calls.map((c) => c.action), ['create', 'list']);
  assert.deepEqual(calls[0].payload, REQUEST);
  assert.deepEqual(calls[1].payload, { socialAccountId: 'x_a' });
  assert.ok(calls.every((c) => c.token === 'token-user-a-0123456789'));
});

test('a positive write answer is not enough: a read-back that misses or disagrees is a failure, never saved', async () => {
  for (const [readBack, code] of [
    [[row(0)], 'READ_BACK_MISSING'],
    [[row(0), row(1, { status: 'cancelled' })], 'READ_BACK_NOT_PLANNED'],
    [[row(0), row(1, { scheduledAt: '2026-10-21T00:00:00.000Z' })], 'READ_BACK_TIME_MISMATCH'],
    [[row(0), row(1, { consentState: 'needs_reconfirm' })], 'READ_BACK_CONSENT_MISMATCH'],
  ]) {
    const { transport } = scripted({ create: ok([row(0), row(1)]), list: ok(readBack) });
    assert.deepEqual(await store(transport).save(REQUEST), { kind: 'failed', code });
  }
});

test('unknown write outcome (network / 5xx / malformed answer): the read-back decides, otherwise uncertain', async () => {
  // Lost answer, but stored: saved.
  assert.equal((await store(scripted({ create: boom, list: ok([row(0), row(1)]) }).transport).save(REQUEST)).kind, 'saved');
  // Lost answer and nothing visible yet (it may still be in flight): uncertain, never failed.
  assert.deepEqual(await store(scripted({ create: boom, list: ok([]) }).transport).save(REQUEST), { kind: 'uncertain', code: UNCERTAIN });
  // Lost answer and the read-back is not available either.
  assert.deepEqual(await store(scripted({ create: boom, list: boom }).transport).save(REQUEST), { kind: 'uncertain', code: UNCERTAIN });
  // A 503 with a code is not a refusal.
  assert.deepEqual(await store(scripted({ create: refused(503, 'STORE_UNAVAILABLE'), list: ok([]) }).transport).save(REQUEST), { kind: 'uncertain', code: UNCERTAIN });
  // A 4xx without a fixed code (e.g. a proxy page) is not a refusal either.
  assert.deepEqual(await store(scripted({ create: { status: 400, body: null }, list: ok([]) }).transport).save(REQUEST), { kind: 'uncertain', code: UNCERTAIN });
  // A malformed row in the answer is never trusted.
  assert.deepEqual(await store(scripted({ create: ok([{ reservationId: 1 }]), list: ok([{ draftId: 3 }]) }).transport).save(REQUEST), { kind: 'uncertain', code: UNCERTAIN });
  // Even a 200 whose rows look fine is re-read: a stored-then-cancelled race is reported, not hidden.
  assert.deepEqual(await store(scripted({ create: boom, list: ok([row(0, { status: 'cancelled' }), row(1)]) }).transport).save(REQUEST), { kind: 'uncertain', code: UNCERTAIN });
});

test('an explicit refusal means nothing was written: failed with its code, and no read-back is needed', async () => {
  for (const [status, code] of [[409, 'POSTONA_RESV_SLOT_CONFLICT'], [403, 'POSTONA_RESV_SERVICE_NOT_ACTIVE'], [422, 'POSTONA_RESV_INTERVAL_MISMATCH'], [401, 'AUTH_REQUIRED']]) {
    const { transport, calls } = scripted({ create: refused(status, code) });
    assert.deepEqual(await store(transport).save(REQUEST), { kind: 'failed', code });
    assert.deepEqual(calls.map((c) => c.action), ['create']);
  }
});

test('no access token: nothing is sent at all', async () => {
  const { transport, calls } = scripted({});
  for (const getAccessToken of [() => Promise.resolve(null), () => Promise.resolve(''), () => Promise.reject(new Error('no session'))]) {
    const s = createRemoteReservationStore({ transport, getAccessToken });
    assert.deepEqual(await s.save(REQUEST), { kind: 'failed', code: 'AUTH_REQUIRED' });
    assert.deepEqual(await s.list('x_a'), { ok: false, code: 'AUTH_REQUIRED' });
    assert.deepEqual(await s.cancel(row(0).reservationId, 1), { ok: false, code: 'AUTH_REQUIRED' });
  }
  assert.equal(calls.length, 0);
});

test('read-back picks the planned row of a draft over an older cancelled row of the same draft', async () => {
  const old = row(0, { reservationId: '99999999-2222-4333-8444-555555555550', status: 'cancelled', batchId: 'older' });
  const { transport } = scripted({ create: ok([row(0), row(1)]), list: ok([row(0), old, row(1)]) });
  const outcome = await store(transport).save(REQUEST);
  assert.equal(outcome.kind, 'saved');
  assert.deepEqual(outcome.reservations.map((r) => r.reservationId), [row(0).reservationId, row(1).reservationId]);
});

test('changes are CAS and confirmed by a read of the row; unknown outcomes are UNCERTAIN, refusals keep their code', async () => {
  const id = row(0).reservationId;
  const moved = row(0, { scheduledAt: '2026-10-21T01:00:00.000Z', revision: 2, consentState: 'needs_reconfirm' });
  let s = scripted({ reschedule: ok([moved]), get: ok([moved]) });
  const { position: _p, fixed: _f, ...movedParsed } = moved; // the client keeps only the fields it uses
  assert.deepEqual(await store(s.transport).reschedule(id, 1, '2026-10-21T01:00:00.000Z'), { ok: true, value: movedParsed });
  assert.deepEqual(s.calls.map((c) => [c.action, c.payload]), [
    ['reschedule', { reservationId: id, expectedRevision: 1, scheduledAt: '2026-10-21T01:00:00.000Z' }], ['get', { reservationId: id }]]);
  // Lost answer, applied: ok. Lost answer, not visible: UNCERTAIN.
  assert.equal((await store(scripted({ reschedule: boom, get: ok([moved]) }).transport).reschedule(id, 1, '2026-10-21T01:00:00.000Z')).ok, true);
  assert.deepEqual(await store(scripted({ reschedule: boom, get: ok([row(0)]) }).transport).reschedule(id, 1, '2026-10-21T01:00:00.000Z'), { ok: false, code: UNCERTAIN });
  // A positive answer whose read-back does not show the change is not trusted.
  assert.deepEqual(await store(scripted({ cancel: ok([row(0, { status: 'cancelled' })]), get: ok([row(0)]) }).transport).cancel(id, 1), { ok: false, code: UNCERTAIN });
  s = scripted({ cancel: refused(409, 'POSTONA_RESV_CANCEL_TOO_LATE') });
  assert.deepEqual(await store(s.transport).cancel(id, 1), { ok: false, code: 'POSTONA_RESV_CANCEL_TOO_LATE' });
  assert.deepEqual(s.calls.map((c) => c.action), ['cancel']);
  const confirmed = row(0, { revision: 2 });
  assert.equal((await store(scripted({ reconfirm: ok([confirmed]), get: ok([confirmed]) }).transport).reconfirm(id, 2, SHA)).ok, true);
  assert.deepEqual(await store(scripted({ reconfirm: ok([confirmed]), get: ok([row(0, { revision: 2, consentState: 'needs_reconfirm' })]) }).transport).reconfirm(id, 2, SHA),
    { ok: false, code: UNCERTAIN });
  // get(): a refusal keeps its code; a wrong row is not accepted.
  assert.deepEqual(await store(scripted({ get: refused(404, 'POSTONA_RESV_NOT_FOUND') }).transport).get(id), { ok: false, code: 'POSTONA_RESV_NOT_FOUND' });
  assert.deepEqual(await store(scripted({ get: ok([row(1)]) }).transport).get(id), { ok: false, code: UNCERTAIN });
});

test('fetch transport: HTTPS only, bearer token, JSON, no redirects, a hard timeout, a non-JSON answer as null', async () => {
  assert.throws(() => createFetchTransport({ url: 'http://example.invalid/x', fetch }), /HTTPS/u);
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return { status: 200, json: async () => ({ ok: true, reservations: [] }) };
  };
  const transport = createFetchTransport({ url: 'https://example.invalid/functions/v1/reservations', fetch: fakeFetch });
  assert.deepEqual(await transport({ action: 'list', payload: { socialAccountId: 'x_a' } }, 'tok'), { status: 200, body: { ok: true, reservations: [] } });
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen[0].init.body), { action: 'list', payload: { socialAccountId: 'x_a' } });
  const html = createFetchTransport({ url: 'https://example.invalid/x', fetch: async () => ({ status: 502, json: async () => { throw new SyntaxError('html'); } }) });
  assert.deepEqual(await html({ action: 'list', payload: {} }, 't'), { status: 502, body: null });
  const hanging = createFetchTransport({
    url: 'https://example.invalid/x', timeoutMs: 20,
    fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  await assert.rejects(hanging({ action: 'list', payload: {} }, 't'), /aborted/u);
});

test('source: the remote store has no Supabase client, storage or service key; the gate constant is a literal false', async () => {
  const source = await readFile(new URL('../src/features/schedule/remote-reservation-store.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
  assert.doesNotMatch(code, /supabase|AsyncStorage|localStorage|SecureStore|service_role|SERVICE_ROLE|EXPO_PUBLIC/iu);
  const factory = await readFile(new URL('../src/features/schedule/reservation-store.ts', import.meta.url), 'utf8');
  assert.match(factory, /export const POSTONA_RESERVATION_PERSISTENCE_ENABLED = false as const;/u);
  assert.match(factory, /if \(gate !== true \|\| !live\) return DISABLED_RESERVATION_STORE;/u);
  const live = await readFile(new URL('../src/features/schedule/live-reservation-store.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(live.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, ''), /service_role|SERVICE_ROLE|AsyncStorage|SecureStore|console\./iu);
});

test('factory: gate OFF -> the disabled store even with a live client; gate ON + live client -> the live store on the real function path', async () => {
  const { createReservationStore, DISABLED_RESERVATION_STORE } = await import('../src/features/schedule/reservation-store.ts');
  let reads = 0;
  const session = { auth: { getSession: async () => { reads += 1; return { data: { session: { access_token: 'tok-live' } }, error: null }; } } };
  const sent = [];
  const fakeFetch = async (url, init) => { sent.push({ url, init }); return { status: 200, json: async () => ({ ok: true, reservations: [] }) }; };
  const live = { supabaseUrl: 'https://project.example.invalid', session, fetch: fakeFetch };
  assert.equal(createReservationStore(), DISABLED_RESERVATION_STORE);
  assert.equal(createReservationStore(false, live), DISABLED_RESERVATION_STORE);
  assert.equal(createReservationStore(true, null), DISABLED_RESERVATION_STORE, 'no live client: still disabled');
  assert.equal(reads, 0);
  const store = createReservationStore(true, live);
  assert.equal(store.enabled, true);
  assert.deepEqual(await store.list('x_a'), { ok: true, value: [] });
  assert.equal(sent[0].url, 'https://project.example.invalid/functions/v1/postona-x-reservations');
  assert.equal(sent[0].init.headers.authorization, 'Bearer tok-live');
  assert.equal(reads, 1, 'the CURRENT session token is read per call');
  assert.throws(() => createReservationStore(true, { ...live, supabaseUrl: 'http://project.example.invalid' }), /HTTPS/u);
});

test('live token: no session, an empty token or a session error sends nothing', async () => {
  const { createLiveReservationStore } = await import('../src/features/schedule/live-reservation-store.ts');
  let sent = 0;
  const fakeFetch = async () => { sent += 1; return { status: 200, json: async () => ({ ok: true, reservations: [] }) }; };
  for (const answer of [{ data: { session: null }, error: null }, { data: { session: { access_token: '' } }, error: null }, { data: { session: { access_token: 'x' } }, error: new Error('refresh failed') }]) {
    const store = createLiveReservationStore({ supabaseUrl: 'https://p.example.invalid', session: { auth: { getSession: async () => answer } }, fetch: fakeFetch });
    assert.deepEqual(await store.list('x_a'), { ok: false, code: 'AUTH_REQUIRED' });
  }
  assert.equal(sent, 0);
});

// ---------------------------------------------------------------------------------------------------
// The server reservation card, rendered from its real source with stubbed React Native
// ---------------------------------------------------------------------------------------------------

async function loadCard() {
  const source = await readFile(new URL('../src/features/schedule/server-reservation-card.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const stubs = {
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { Text: 'Text', TextInput: 'TextInput', View: 'View' },
    '@/constants/theme': { colors: { border: 'b', ink: 'i' } },
    '@/components/ui': { Card: 'Card', Pill: 'Pill', styles: { muted: {} } },
    '@/domain/reservation-flow': reservationFlow,
    '@/domain/schedule-planner': planner,
    '@/features/schedule/schedule-composer': { SmallButton: 'SmallButton' },
  };
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } });
  return module.exports.ServerReservationCard;
}
const textOf = (tree) => {
  const out = [];
  const visit = (node) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') visit(node.props?.children);
  };
  visit(tree);
  return out.join(' | ');
};
const buttons = (tree) => {
  const out = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'SmallButton') out.push(node.props);
    visit(node.props?.children);
  };
  visit(tree);
  return out;
};
const noop = () => {};
const cardProps = (over = {}) => ({
  row: row(0), account: { displayName: 'かぶモリ公式', handle: '@kabumori' }, busy: false, retiming: null,
  onRetime: noop, onRetimeChange: noop, onRetimeApply: noop, onRetimeCancel: noop, onReconfirm: noop, onCancel: noop, ...over,
});

test('server card: a planned, confirmed row reads as reserved (server-verified) and offers change and cancel only', async () => {
  const Card = await loadCard();
  const tree = Card(cardProps());
  const text = textOf(tree);
  assert.match(text, /予約済み/u, 'the label comes from the server row');
  assert.match(text, /投稿先: かぶモリ公式（@kabumori）・日本時間/u);
  assert.match(text, /X への投稿はまだ行われません/u);
  assert.deepEqual(buttons(tree).map((b) => b.label), ['日時を変更', '予約を取り消す']);
});

test('server card: needs_reconfirm is not shown as reserved and offers the reconfirmation; finished rows offer nothing', async () => {
  const Card = await loadCard();
  let reconfirmed = 0;
  const stale = Card(cardProps({ row: row(0, { revision: 2, consentState: 'needs_reconfirm' }), onReconfirm: () => { reconfirmed += 1; } }));
  assert.match(textOf(stale), /再確認が必要/u);
  assert.doesNotMatch(textOf(stale), /予約済み/u);
  buttons(stale).find((b) => b.label === 'この内容で再確認').onPress();
  assert.equal(reconfirmed, 1);
  for (const status of ['cancelled', 'claimed', 'published', 'failed', 'uncertain', 'expired']) {
    assert.deepEqual(buttons(Card(cardProps({ row: row(0, { status }) }))), [], status);
  }
  const busy = Card(cardProps({ busy: true }));
  assert.ok(buttons(busy).every((b) => b.disabled === true));
  assert.match(textOf(busy), /サーバーに確認しています/u);
  const ai = Card(cardProps({ row: row(0, { origin: 'ai_generated', body: null, consentState: 'ai_owner_opt_in', mode: 'ai_flexible' }) }));
  assert.match(textOf(ai), /AIが投稿の直前に本文を作成します/u);
  assert.ok(!buttons(ai).some((b) => b.label === 'この内容で再確認'));
  const retiming = Card(cardProps({ retiming: { date: '2026-10-20', time: '09:30' } }));
  assert.deepEqual(buttons(retiming).map((b) => b.label), ['予約の日時を変更する', 'やめる', '予約を取り消す']);
});
