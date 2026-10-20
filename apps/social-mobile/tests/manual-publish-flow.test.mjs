// F1 manual X single post: the async steps (readiness check, the one send) and the memory of an unresolved attempt.
// Offline: every external thing is injected; the global network entry points are booby-trapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as flow from '../src/features/manual-publish/manual-publish-flow.ts';
import * as port from '../src/features/manual-publish/manual-publish-port.ts';
import { createAttemptStore, storeKeyOf } from '../src/features/manual-publish/manual-publish-store.ts';

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

// ---- the registry of the send that is out ----------------------------------------------------------------------------------------------------

test('inflight: begin -> out -> end tells every waiter the answer, and keeps it for a late waiter', async () => {
  const reg = flow.createInFlightSends();
  assert.equal(reg.isOut('U1', ID(1)), false);
  assert.equal(reg.wait('U1', ID(1)), null);
  reg.begin('U1', ID(1));
  assert.equal(reg.isOut('U1', ID(1)), true);
  assert.equal(reg.isOut('U1', ID(2)), false, 'another id is not out');
  assert.equal(reg.isOut('U2', ID(1)), false, 'another user is not out');
  assert.equal(reg.isOut(null, ID(1)), false);
  const a = reg.wait('U1', ID(1));
  const b = reg.wait('U1', ID(1));
  assert.equal(reg.wait('U1', ID(2)), null);
  const answer = { kind: 'pending', targetId: ID(1), code: null };
  reg.end('U1', ID(2), { kind: 'published', targetId: ID(2), providerPostId: '1' }); // another id: ignored
  reg.end('U2', ID(1), { kind: 'published', targetId: ID(1), providerPostId: '1' }); // another user: ignored
  assert.equal(reg.isOut('U1', ID(1)), true);
  reg.end('U1', ID(1), answer);
  assert.equal(reg.isOut('U1', ID(1)), false);
  assert.deepEqual(await a, answer);
  assert.deepEqual(await b, answer);
  assert.deepEqual(await reg.wait('U1', ID(1)), answer, 'a late waiter still gets the answer');
  reg.end('U1', ID(1), { kind: 'published', targetId: ID(1), providerPostId: '9' });
  assert.deepEqual(await reg.wait('U1', ID(1)), answer, 'an answer is not overwritten by a second end');
});

test('inflight: runSend registers the send before the port is called and ends it AFTER memory and device record are final, whatever the answer', async () => {
  for (const [label, answer, memoryAfter, recordAfter] of [
    ['pending', { kind: 'pending', code: null, marks: REAL }, 'pending', 'pending'],
    ['unavailable', { kind: 'unavailable', code: 'TRANSPORT_FAILED' }, 'unconfirmed', 'unconfirmed'],
    ['uncertain', { kind: 'uncertain', code: 'X_TIMEOUT', marks: REAL }, 'uncertain', 'uncertain'],
    ['simulated', { kind: 'published', providerPostId: '1' }, 'uncertain', 'uncertain'],
    ['published', { kind: 'published', providerPostId: '1', marks: REAL }, null, null],
    ['rejected', { kind: 'rejected', code: 'X_REJECTED_403', marks: REAL }, null, null],
  ]) {
    const h = harness({ send: async (t) => ({ targetId: t.targetId, ...answer }) });
    h.deps.inflight = flow.createInFlightSends();
    let outDuringSend = null;
    const original = h.deps.port.send;
    h.deps.port.send = async (t) => { outDuringSend = h.deps.inflight.isOut('U1', t.targetId); return original(t); };
    const waiting = (async () => {
      let promise = null;
      for (let i = 0; i < 50 && promise === null; i += 1) {
        promise = h.deps.inflight.wait('U1', ID(1));
        if (promise === null) await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(promise, 'the send was registered');
      await promise;
      // the moment a waiter is released, memory and the device record already say what the answer is
      return { memory: h.memory.get('U1')?.kind ?? null, record: h.kv.data.get(storeKeyOf('U1')) === undefined ? null : JSON.parse(h.kv.data.get(storeKeyOf('U1'))).kind };
    })();
    const outcome = await flow.runSend(h.deps, args());
    assert.equal(outDuringSend, true, `${label}: registered before the port was called`);
    assert.equal(h.deps.inflight.isOut('U1', ID(1)), false, `${label}: ended`);
    assert.deepEqual(await h.deps.inflight.wait('U1', ID(1)), outcome, label);
    assert.deepEqual(await waiting, { memory: memoryAfter, record: recordAfter }, label);
  }
});

test('inflight: a thrown port, an invalid answer and a local refusal never leave a waiter hanging; a refusal before the port is not registered at all', async () => {
  const thrown = harness({ send: async () => { throw new Error('boom'); } });
  thrown.deps.inflight = flow.createInFlightSends();
  const outcome = await flow.runSend(thrown.deps, args());
  assert.equal(outcome.code, 'SEND_THREW');
  assert.deepEqual(await thrown.deps.inflight.wait('U1', ID(1)), outcome);
  const invalid = harness({ send: async () => null });
  invalid.deps.inflight = flow.createInFlightSends();
  assert.equal((await flow.runSend(invalid.deps, args())).code, 'OUTCOME_INVALID');
  assert.equal(invalid.deps.inflight.isOut('U1', ID(1)), false);
  const refused = harness();
  refused.deps.inflight = flow.createInFlightSends();
  assert.equal((await flow.runSend(refused.deps, args({ text: 'hello ' }))).code, 'LOCAL_CONSENT_MISMATCH');
  assert.equal(refused.deps.inflight.wait('U1', ID(1)), null, 'nothing was sent, nothing is registered');
  const noStore = harness();
  noStore.deps.inflight = flow.createInFlightSends();
  noStore.kv.fail.set = true;
  assert.equal((await flow.runSend(noStore.deps, args())).code, 'LOCAL_STORE_UNAVAILABLE');
  assert.equal(noStore.deps.inflight.wait('U1', ID(1)), null);
  // A memory that fails while the answer is recorded still releases the waiter (as uncertain).
  const broken = harness({ send: async (t) => ({ targetId: t.targetId, kind: 'pending', code: null }) });
  broken.deps.inflight = flow.createInFlightSends();
  const mark = broken.memory.mark;
  let calls = 0;
  broken.memory.mark = (userId, entry) => { calls += 1; if (calls > 1) throw new Error('memory failed'); return mark(userId, entry); };
  const lost = await flow.runSend(broken.deps, args());
  assert.deepEqual(lost, { kind: 'uncertain', targetId: ID(1), code: 'SEND_STATE_LOST' });
  assert.deepEqual(await broken.deps.inflight.wait('U1', ID(1)), lost);
});

test('inflight: without a registry nothing changes (the registry is optional, runSend works as before)', async () => {
  const h = harness();
  assert.equal(h.deps.inflight, undefined);
  assert.equal((await flow.runSend(h.deps, args())).kind, 'published');
});
