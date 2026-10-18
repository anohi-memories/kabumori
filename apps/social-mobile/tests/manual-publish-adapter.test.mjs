// F1 manual X single post: the F3 contract adapter (single-post-port.ts) driven with a SCRIPTED transport, and the
// whole attempt cycle (reducer + flow + adapter) for retries. Offline: the transport is a test double, the global
// network entry points are booby-trapped, and nothing is ever sent to X.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as adapter from '../src/features/manual-publish/single-post-port.ts';
import * as flow from '../src/features/manual-publish/manual-publish-flow.ts';
import * as m from '../src/features/manual-publish/manual-publish-model.ts';
import * as port from '../src/features/manual-publish/manual-publish-port.ts';

const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];
const saved = new Map();
let trapped = 0;
test.before(() => {
  for (const name of NETWORK) {
    saved.set(name, globalThis[name]);
    globalThis[name] = function forbidden() { trapped += 1; throw new Error(`network entry point ${name} must not be used`); };
  }
});
test.after(() => {
  for (const name of NETWORK) {
    if (saved.get(name) === undefined) delete globalThis[name];
    else globalThis[name] = saved.get(name);
  }
});

import { createAttemptStore } from '../src/features/manual-publish/manual-publish-store.ts';

/** A device storage that can fail in every way: a thrown read / write / remove, or a write that silently stores nothing. */
function fakeKV() {
  const data = new Map();
  const fail = { get: false, set: false, remove: false, drop: false };
  return {
    data,
    fail,
    getItem: async (key) => { if (fail.get) throw new Error('read failed'); return data.has(key) ? data.get(key) : null; },
    setItem: async (key, value) => { if (fail.set) throw new Error('write failed'); if (!fail.drop) data.set(key, value); },
    removeItem: async (key) => { if (fail.remove) throw new Error('remove failed'); data.delete(key); },
  };
}

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RESERVATION = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.SECRET-ACCESS-TOKEN-OF-THE-PERSON.signature';

const target = (over = {}) => ({
  targetId: ID(1),
  provider: 'x',
  connectedAccountId: 'sa_x_1',
  renderedText: 'こんにちは',
  media: [],
  consent: { confirmed: true, contentSha256: sha('こんにちは') },
  ...over,
});

/** A scripted transport: answers are consumed in order; every call is recorded. */
function transportOf(...answers) {
  const calls = [];
  const queue = [...answers];
  const transport = async (call) => {
    calls.push(call);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(call);
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}
const ANSWER = {
  sent: (id = '1790000000000000001') => ({ status: 200, body: { ok: true, status: 'sent', reservationId: RESERVATION, xPostId: id } }),
  pending: { status: 200, body: { ok: true, status: 'pending', reservationId: RESERVATION, code: 'IN_PROGRESS' } },
  failed: { status: 200, body: { ok: true, status: 'failed', reservationId: RESERVATION, code: 'X_REJECTED_403' } },
  uncertain: { status: 200, body: { ok: true, status: 'uncertain', reservationId: RESERVATION, code: 'X_TIMEOUT' } },
  refused: { status: 403, body: { ok: false, code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE' } },
  gateOff: { status: 503, body: { ok: false, code: 'NOT_AVAILABLE' } },
};
const make = (transport, over = {}) => adapter.createSinglePostPort({ transport, getAccessToken: async () => TOKEN, ...over });

// ---- the request ---------------------------------------------------------------------------------------------------

test('the request carries exactly the F3 body: the attempt id as clientRequestId, the exact text and its hash as consent', async () => {
  const t = transportOf(ANSWER.sent());
  const outcome = await make(t.transport).send(target());
  assert.deepEqual(outcome, { kind: 'published', targetId: ID(1), providerPostId: '1790000000000000001' });
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0], {
    functionName: 'postona-x-single-post',
    accessToken: TOKEN,
    body: { socialAccountId: 'sa_x_1', clientRequestId: ID(1), text: 'こんにちは', consent: { confirmed: true, contentSha256: sha('こんにちは') } },
  });
});

test('the access token goes to the transport only: it is in no outcome, code or error', async () => {
  for (const answer of [ANSWER.sent(), ANSWER.pending, ANSWER.failed, ANSWER.uncertain, ANSWER.refused, ANSWER.gateOff, new Error(`boom ${TOKEN}`), { status: 200, body: { echo: TOKEN } }]) {
    const outcome = await make(transportOf(answer).transport).send(target());
    assert.ok(!JSON.stringify(outcome).includes('SECRET-ACCESS-TOKEN'), JSON.stringify(outcome));
  }
});

// ---- every F3 answer lands in its own class -------------------------------------------------------------------------------

test('F3 answers map one to one; pending is never uncertain, unavailable is never failed, nothing but a stored id is published', async () => {
  const send = async (answer) => make(transportOf(answer).transport).send(target());
  assert.deepEqual(await send(ANSWER.pending), { kind: 'pending', targetId: ID(1), code: 'IN_PROGRESS' });
  assert.deepEqual(await send(ANSWER.failed), { kind: 'rejected', targetId: ID(1), code: 'X_REJECTED_403' });
  assert.deepEqual(await send(ANSWER.uncertain), { kind: 'uncertain', targetId: ID(1), code: 'X_TIMEOUT' });
  assert.deepEqual(await send(ANSWER.refused), { kind: 'refused', targetId: ID(1), code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE', retryable: false });
  assert.deepEqual(await send({ status: 401, body: { ok: false, code: 'AUTH_REQUIRED' } }), { kind: 'refused', targetId: ID(1), code: 'AUTH_REQUIRED', retryable: true });
  assert.deepEqual(await send(ANSWER.gateOff), { kind: 'unavailable', targetId: ID(1), code: 'NOT_AVAILABLE' });
  for (const unreadable of [
    { status: 200, body: { ok: true, status: 'sent', reservationId: RESERVATION } },
    { status: 200, body: { ok: true, status: 'sent', reservationId: RESERVATION, xPostId: 'not-a-number' } },
    { status: 200, body: { ok: true, status: 'posted', reservationId: RESERVATION } },
    { status: 200, body: 'ok' },
    { status: 500, body: null },
    { status: 'x', body: {} },
    undefined,
    null,
  ]) {
    const outcome = await send(unreadable);
    assert.equal(outcome.kind, 'unavailable', JSON.stringify(unreadable));
    assert.notEqual(outcome.kind, 'published');
  }
});

test('a transport that throws is "unavailable" (the server may have acted): same-id retry, never published, never "not posted"', async () => {
  for (const failure of [new Error('network request failed'), new TypeError('Failed to fetch'), 'string failure']) {
    const t = transportOf(async () => { throw failure; });
    const outcome = await make(t.transport).send(target());
    assert.deepEqual(outcome, { kind: 'unavailable', targetId: ID(1), code: 'TRANSPORT_FAILED' });
  }
});

// ---- local refusals: nothing is sent ----------------------------------------------------------------------------------------

test('a target the server would refuse, or a consent that does not match the exact text, is refused locally -- the transport is never called', async () => {
  const bad = [
    ['LOCAL_ATTEMPT_ID_INVALID', { targetId: 'req-1' }],
    ['LOCAL_ATTEMPT_ID_INVALID', { targetId: `manual-${ID(1)}` }],
    ['LOCAL_ATTEMPT_ID_INVALID', { targetId: 'ABCDEF00-0000-4000-8000-000000000001' }],
    ['LOCAL_TARGET_INVALID', { provider: 'threads' }],
    ['LOCAL_TARGET_INVALID', { connectedAccountId: 'a b' }],
    ['LOCAL_TARGET_INVALID', { connectedAccountId: '' }],
    ['LOCAL_TARGET_INVALID', { renderedText: '' }],
    ['LOCAL_TARGET_INVALID', { renderedText: 'a'.repeat(2001), consent: { confirmed: true, contentSha256: sha('a'.repeat(2001)) } }],
    ['LOCAL_TARGET_INVALID', { media: [{ assetId: 'a', kind: 'image' }] }],
    ['LOCAL_CONSENT_REQUIRED', { consent: undefined }],
    ['LOCAL_CONSENT_REQUIRED', { consent: { confirmed: false, contentSha256: sha('こんにちは') } }],
    ['LOCAL_CONSENT_REQUIRED', { consent: { confirmed: true, contentSha256: 'ABC' } }],
    ['LOCAL_CONSENT_REQUIRED', { consent: { confirmed: true, contentSha256: sha('こんにちは').toUpperCase() } }],
    ['LOCAL_CONSENT_MISMATCH', { renderedText: 'こんにちは ' }],
    ['LOCAL_CONSENT_MISMATCH', { renderedText: 'こんにちは\n' }],
    ['LOCAL_CONSENT_MISMATCH', { consent: { confirmed: true, contentSha256: sha('別の本文') } }],
  ];
  for (const [code, over] of bad) {
    const t = transportOf(ANSWER.sent());
    const outcome = await make(t.transport).send(target(over));
    assert.equal(outcome.kind, 'refused', code);
    assert.equal(outcome.code, code);
    assert.equal(outcome.retryable, false);
    assert.equal(t.calls.length, 0, `${code}: nothing was sent`);
  }
});

test('no access token => no request at all; the refusal is retryable once signed in', async () => {
  for (const getAccessToken of [async () => null, async () => '', async () => { throw new Error('storage'); }]) {
    const t = transportOf(ANSWER.sent());
    const outcome = await make(t.transport, { getAccessToken }).send(target());
    assert.deepEqual(outcome, { kind: 'refused', targetId: ID(1), code: 'LOCAL_AUTH_REQUIRED', retryable: true });
    assert.equal(t.calls.length, 0);
  }
});

test('readiness: with no preflight supplied the adapter says not_connected (the send stays disabled); a supplied one is passed through', async () => {
  assert.deepEqual(await make(transportOf(ANSWER.sent()).transport).checkReadiness('sa_x_1'), { kind: 'not_connected' });
  const asked = [];
  const p = make(transportOf(ANSWER.sent()).transport, { checkReadiness: async (id) => { asked.push(id); return { kind: 'ready' }; } });
  assert.deepEqual(await p.checkReadiness('sa_x_1'), { kind: 'ready' });
  assert.deepEqual(asked, ['sa_x_1']);
});

test('this build still uses the unconnected port: the adapter is prepared, not wired', () => {
  assert.equal(port.getManualPublishPort(), port.UNCONNECTED_MANUAL_PUBLISH_PORT);
});

// ---- the whole attempt cycle: identity across retries ---------------------------------------------------------------------

/** Drives reducer + flow + adapter like the screen does, with a scripted transport and a ready port. */
function cycle(transport, { text = 'こんにちは', accountId = 'sa_x_1' } = {}) {
  const memory = flow.createAttemptMemory();
  const store = createAttemptStore(fakeKV());
  let clock = 10_000;
  let n = 0;
  const sendPort = make(transport, { checkReadiness: async () => ({ kind: 'ready' }) });
  const deps = { port: sendPort, now: () => clock, newRequestId: () => ID(++n), memory, store };
  let state = m.createInitialState();
  const act = (a) => { state = m.manualPublishReducer(state, a); return state; };
  const api = {
    get state() { return state; },
    act,
    memory,
    deps,
    compose() { act({ type: 'account_selected', accountId }); act({ type: 'draft_changed', text }); return act({ type: 'confirm_opened' }); },
    async confirmAndSend() {
      act({ type: 'confirm_opened' });
      act({ type: 'readiness_received', record: await flow.runReadinessCheck(deps, accountId) });
      act({ type: 'consent_changed', checked: true });
      return api.send();
    },
    async send() {
      const requestId = state.unresolved ? state.unresolved.requestId : deps.newRequestId();
      const retry = state.unresolved !== null;
      const start = act({ type: 'send_started', requestId, now: clock });
      if (start.phase !== 'sending') return null;
      const outcome = await flow.runSend(deps, { userId: 'U1', accountId, text: m.checkDraft(state.draft).text, requestId, consent: m.consentForSend(state), retry });
      act({ type: 'send_settled', requestId, outcome });
      return { requestId, outcome };
    },
    async retry() {
      act({ type: 'retry_requested' });
      act({ type: 'readiness_received', record: await flow.runReadinessCheck(deps, accountId) });
      act({ type: 'consent_changed', checked: true });
      return api.send();
    },
  };
  return api;
}

test('a lost answer is retried with the SAME attempt id and the same body; the server then says sent', async () => {
  const t = transportOf(async () => { throw new Error('connection lost'); }, ANSWER.sent());
  const c = cycle(t.transport);
  c.compose();
  const first = await c.confirmAndSend();
  assert.equal(c.state.result.kind, 'unconfirmed');
  assert.equal(c.state.unresolved.kind, 'unconfirmed');
  const second = await c.retry();
  assert.equal(second.requestId, first.requestId, 'the SAME attempt id');
  assert.equal(t.calls.length, 2);
  assert.deepEqual(t.calls[1].body, t.calls[0].body, 'the same request, byte for byte');
  assert.equal(t.calls[1].body.clientRequestId, first.requestId);
  assert.equal(c.state.result.kind, 'sent');
  assert.equal(c.state.unresolved, null);
  assert.equal(c.memory.get('U1'), null);
});

test('pending is retried with the same id until the server answers; pending is never shown as posted or as uncertain', async () => {
  const t = transportOf(ANSWER.pending, ANSWER.pending, ANSWER.sent('42'));
  const c = cycle(t.transport);
  c.compose();
  await c.confirmAndSend();
  assert.equal(c.state.result.kind, 'pending');
  assert.equal(c.memory.get('U1').kind, 'pending');
  await c.retry();
  assert.equal(c.state.result.kind, 'pending');
  await c.retry();
  assert.equal(c.state.result.kind, 'sent');
  assert.deepEqual([...new Set(t.calls.map((call) => call.body.clientRequestId))], [ID(1)], 'one id for the whole cycle');
});

test('uncertain is never resent -- not by retry, not by a new send -- until the user acknowledges', async () => {
  const t = transportOf(ANSWER.uncertain, ANSWER.sent());
  const c = cycle(t.transport);
  c.compose();
  await c.confirmAndSend();
  assert.equal(c.state.result.kind, 'uncertain');
  assert.equal(c.memory.get('U1').kind, 'uncertain');
  assert.equal(await c.retry(), null, 'retry is refused for an uncertain attempt');
  assert.equal(await c.confirmAndSend(), null, 'and so is a new send');
  assert.equal(t.calls.length, 1);
  assert.equal(c.act({ type: 'unresolved_acknowledged' }).phase, 'editing', 'only the acknowledgement unlocks it');
});

test('after a proven end a NEW attempt gets a NEW id: failed and refused never reuse the old one', async () => {
  const t = transportOf(ANSWER.failed, ANSWER.refused, ANSWER.sent());
  const c = cycle(t.transport);
  c.compose();
  await c.confirmAndSend();
  assert.equal(c.state.result.kind, 'failed');
  assert.equal(c.state.unresolved, null);
  c.act({ type: 'result_dismissed' });
  assert.equal(c.state.draft, 'こんにちは', 'the text is kept for the next attempt');
  await c.confirmAndSend();
  assert.equal(c.state.result.kind, 'refused');
  c.act({ type: 'result_dismissed' });
  await c.confirmAndSend();
  assert.equal(c.state.result.kind, 'sent');
  assert.deepEqual(t.calls.map((call) => call.body.clientRequestId), [ID(1), ID(2), ID(3)]);
});

test('different text or another account is a different attempt: one id is never shared', async () => {
  const t = transportOf(ANSWER.sent('1'), ANSWER.sent('2'));
  const bodies = [];
  for (const [text, accountId] of [['最初の投稿', 'sa_x_1'], ['最初の投稿', 'sa_x_2'], ['別の投稿', 'sa_x_1']]) {
    const c = cycle(t.transport, { text, accountId });
    c.compose();
    await c.confirmAndSend();
    bodies.push(t.calls.at(-1).body);
  }
  assert.equal(new Set(bodies.map((b) => `${b.socialAccountId}|${b.consent.contentSha256}`)).size, 3);
  // The consent hash follows the text; the account follows the choice.
  assert.equal(bodies[0].consent.contentSha256, sha('最初の投稿'));
  assert.equal(bodies[1].socialAccountId, 'sa_x_2');
  assert.equal(bodies[2].consent.contentSha256, sha('別の投稿'));
});

test('a tampered consent never reaches the transport: a hash for other text is refused before sending', async () => {
  const t = transportOf(ANSWER.sent());
  const sendPort = make(t.transport);
  const memory = flow.createAttemptMemory();
  const deps = { port: sendPort, now: () => 1, newRequestId: () => ID(1), memory, store: createAttemptStore(fakeKV()) };
  const outcome = await flow.runSend(deps, { userId: 'U1', accountId: 'sa_x_1', text: 'こんにちは', requestId: ID(1), consent: { confirmed: true, contentSha256: sha('別の本文') }, retry: false });
  assert.deepEqual(outcome, { kind: 'refused', targetId: ID(1), code: 'LOCAL_CONSENT_MISMATCH', retryable: false });
  assert.equal(t.calls.length, 0);
  assert.equal(memory.get('U1'), null, 'nothing was started, nothing is remembered');
});

test('no network entry point was touched by any step', () => {
  assert.equal(trapped, 0);
});
