// F1 manual X single post: the async steps (readiness check, the one send) and the memory of an unresolved attempt.
// Offline: every external thing is injected; the global network entry points are booby-trapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as flow from '../src/features/manual-publish/manual-publish-flow.ts';
import * as port from '../src/features/manual-publish/manual-publish-port.ts';
import { createAttemptStore } from '../src/features/manual-publish/manual-publish-store.ts';

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
const REAL = { simulated: false, afterFreeze: false };

function harness(portOver = {}) {
  const calls = { check: [], send: [] };
  const memory = flow.createAttemptMemory();
  const kv = fakeKV();
  const store = createAttemptStore(kv);
  const fakePort = {
    checkReadiness: async (accountId) => { calls.check.push(accountId); return { kind: 'ready' }; },
    send: async (target) => { calls.send.push(target); return { kind: 'published', marks: REAL, targetId: target.targetId, providerPostId: '1234567890' }; },
    ...portOver,
  };
  let clock = 5_000;
  let n = 0;
  const deps = { port: fakePort, now: () => clock, newRequestId: () => ID(++n), memory, store };
  return { calls, memory, kv, store, deps, tick: (ms) => { clock += ms; } };
}
const args = (over = {}) => ({
  userId: 'U1',
  accountId: 'X_A',
  text: 'hello',
  requestId: ID(1),
  consent: { confirmed: true, contentSha256: sha('hello') },
  retry: false,
  ...over,
});
const ENTRY = { accountId: 'X_A', requestId: ID(1), contentSha256: sha('hello'), text: 'hello' };

// ---- readiness ------------------------------------------------------------------------------------------------------

test('readiness: the answer is bound to the asked account and the time it was received', async () => {
  const h = harness();
  const record = await flow.runReadinessCheck(h.deps, 'X_A');
  assert.deepEqual(record, { accountId: 'X_A', checkedAt: 5_000, result: { kind: 'ready' } });
  assert.deepEqual(h.calls.check, ['X_A']);
});

test('readiness: a port failure or a nonsense answer is never "ready"', async () => {
  for (const [label, impl, code] of [
    ['throws', async () => { throw new Error('boom'); }, 'READINESS_CHECK_FAILED'],
    ['rejects', () => Promise.reject(new Error('boom')), 'READINESS_CHECK_FAILED'],
    ['null', async () => null, 'READINESS_INVALID'],
    ['string', async () => 'ready', 'READINESS_INVALID'],
    ['unknown kind', async () => ({ kind: 'READY' }), 'READINESS_INVALID'],
    ['boolean', async () => ({ ready: true }), 'READINESS_INVALID'],
  ]) {
    const h = harness({ checkReadiness: impl });
    const record = await flow.runReadinessCheck(h.deps, 'X_A');
    assert.equal(record.result.kind, 'unavailable', label);
    assert.equal(record.result.code, code, label);
  }
  const h = harness({ checkReadiness: async () => ({ kind: 'unavailable' }) });
  assert.equal((await flow.runReadinessCheck(h.deps, 'X_A')).result.code, 'UNAVAILABLE', 'a missing code gets a stable one');
});

test('readiness: the port of this build says not_connected and refuses a send without posting anything', async () => {
  assert.equal(port.getManualPublishPort(), port.UNCONNECTED_MANUAL_PUBLISH_PORT);
  assert.deepEqual(await port.UNCONNECTED_MANUAL_PUBLISH_PORT.checkReadiness('X_A'), { kind: 'not_connected' });
  const refused = await port.UNCONNECTED_MANUAL_PUBLISH_PORT.send({ targetId: ID(1), provider: 'x', connectedAccountId: 'X_A', renderedText: 'hi', media: [], consent: { confirmed: true, contentSha256: sha('hi') } });
  assert.deepEqual(refused, { kind: 'refused', targetId: ID(1), code: 'PORT_NOT_CONNECTED', retryable: false });
  assert.ok(Object.isFrozen(port.UNCONNECTED_MANUAL_PUBLISH_PORT));
});

// ---- send ----------------------------------------------------------------------------------------------------------------

test('send: the target carries the attempt id as its idempotency key, the text unchanged and the consent', async () => {
  const h = harness();
  const outcome = await flow.runSend(h.deps, args());
  assert.deepEqual(outcome, { kind: 'published', marks: REAL, targetId: ID(1), providerPostId: '1234567890' });
  assert.deepEqual(h.calls.send, [{ targetId: ID(1), provider: 'x', connectedAccountId: 'X_A', renderedText: 'hello', media: [], consent: { confirmed: true, contentSha256: sha('hello') } }]);
});

test('send: the attempt is remembered (id, exact text, hash) BEFORE the port is called, and forgotten only by a proven end', async () => {
  let during = null;
  const h = harness({ send: async (target) => { during = h.memory.get('U1'); return { kind: 'published', marks: REAL, targetId: target.targetId, providerPostId: '1' }; } });
  await flow.runSend(h.deps, args());
  assert.deepEqual(during, { ...ENTRY, kind: 'in_flight' }, 'marked while in flight');
  assert.equal(h.memory.get('U1'), null, 'published clears it');

  for (const [outcome, label] of [
    [{ kind: 'rejected', code: 'X_REJECTED_403' }, 'rejected'],
    [{ kind: 'refused', code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE', retryable: false }, 'refused'],
  ]) {
    const done = harness({ send: async (t) => ({ targetId: t.targetId, ...outcome }) });
    await flow.runSend(done.deps, args());
    assert.equal(done.memory.get('U1'), null, `${label} is a proven end`);
  }
  for (const [outcome, kind] of [
    [{ kind: 'pending', code: 'IN_PROGRESS' }, 'pending'],
    [{ kind: 'unavailable', code: 'TRANSPORT_FAILED' }, 'unconfirmed'],
    [{ kind: 'uncertain', code: 'X_TIMEOUT' }, 'uncertain'],
  ]) {
    const open = harness({ send: async (t) => ({ targetId: t.targetId, ...outcome }) });
    const got = await flow.runSend(open.deps, args());
    assert.equal(got.kind, outcome.kind);
    assert.deepEqual(open.memory.get('U1'), { ...ENTRY, kind }, `${outcome.kind} stays remembered as ${kind}`);
  }
});

test('send: a retry of the same attempt overwrites the same memory entry (same id), never adds a second one', async () => {
  let answer = { kind: 'pending', code: null };
  const h = harness({ send: async (t) => ({ targetId: t.targetId, ...answer }) });
  await flow.runSend(h.deps, args());
  assert.equal(h.memory.get('U1').kind, 'pending');
  answer = { kind: 'published', marks: REAL, providerPostId: '77' };
  await flow.runSend(h.deps, args());
  assert.equal(h.memory.get('U1'), null);
});

test('send: a throwing port is "uncertain" (it may have sent), never "rejected"; it stays remembered as uncertain', async () => {
  for (const send of [async () => { throw new Error('boom'); }, () => Promise.reject(new Error('boom')), () => { throw new Error('sync boom'); }]) {
    const h = harness({ send });
    const outcome = await flow.runSend(h.deps, args());
    assert.deepEqual(outcome, { kind: 'uncertain', targetId: ID(1), code: 'SEND_THREW' });
    assert.deepEqual(h.memory.get('U1'), { ...ENTRY, kind: 'uncertain' });
  }
});

test('send: an answer that proves nothing is "uncertain" and stays remembered', async () => {
  for (const answer of [null, undefined, 'published', { kind: 'PUBLISHED' }, {}, 42, { kind: 'sent', targetId: ID(1) }]) {
    const h = harness({ send: async () => answer });
    const outcome = await flow.runSend(h.deps, args());
    assert.deepEqual(outcome, { kind: 'uncertain', targetId: ID(1), code: 'OUTCOME_INVALID' }, String(answer));
    assert.equal(h.memory.get('U1').kind, 'uncertain');
  }
  // "published" for another target, or without a numeric post id, is not a proof either.
  for (const answer of [
    { kind: 'published', marks: REAL, targetId: ID(9), providerPostId: '1' },
    { kind: 'published', marks: REAL, targetId: ID(1), providerPostId: '' },
    { kind: 'published', marks: REAL, targetId: ID(1), providerPostId: 'abc' },
  ]) {
    const h = harness({ send: async () => answer });
    await flow.runSend(h.deps, args());
    assert.notEqual(h.memory.get('U1'), null, JSON.stringify(answer));
  }
});

test('send: a target the provider cannot take, or a consent that does not match the exact text, is refused before the port', async () => {
  for (const [over, code] of [
    [{ text: '   ', consent: { confirmed: true, contentSha256: sha('   ') } }, 'LOCAL_TARGET_INVALID'],
    [{ requestId: 'req-1' }, 'LOCAL_ATTEMPT_ID_INVALID'],
    [{ text: 'hello ' }, 'LOCAL_CONSENT_MISMATCH'],
    [{ consent: { confirmed: true, contentSha256: sha('another') } }, 'LOCAL_CONSENT_MISMATCH'],
    [{ consent: { confirmed: false, contentSha256: sha('hello') } }, 'LOCAL_TARGET_INVALID'],
  ]) {
    const h = harness();
    const outcome = await flow.runSend(h.deps, args(over));
    assert.equal(outcome.kind, 'refused', code);
    assert.equal(outcome.code, code);
    assert.equal(h.calls.send.length, 0, code);
    assert.equal(h.memory.get('U1'), null, `${code}: nothing was started`);
  }
});

test('memory: one entry per signed-in user; another user never sees it', () => {
  const memory = flow.createAttemptMemory();
  memory.mark('U1', { ...ENTRY, kind: 'pending' });
  assert.deepEqual(memory.get('U1'), { ...ENTRY, kind: 'pending' });
  assert.equal(memory.get('U2'), null);
  assert.equal(memory.get(null), null);
  memory.clear('U1');
  assert.equal(memory.get('U1'), null);
  assert.equal(flow.attemptMemory.get('nobody'), null, 'the shared instance starts empty');
});

test('no network entry point was touched by any step', async () => {
  const h = harness();
  await flow.runReadinessCheck(h.deps, 'X_A');
  await flow.runSend(h.deps, args());
  await flow.runReadinessCheck({ ...h.deps, port: port.UNCONNECTED_MANUAL_PUBLISH_PORT }, 'X_A');
  assert.equal(trapped, 0, 'no booby-trapped network entry point was called');
});
