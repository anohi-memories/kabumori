// F1 manual X single post: the async steps (readiness check, the one send) and the memory of an unresolved attempt.
// Offline: every external thing is injected; the global network entry points are booby-trapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as flow from '../src/features/manual-publish/manual-publish-flow.ts';
import * as port from '../src/features/manual-publish/manual-publish-port.ts';
import * as model from '../src/features/manual-publish/manual-publish-model.ts';
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
  await flow.runSend(h.deps, args({ retry: true })); // a send of the unresolved attempt's id is a re-ask, and says so
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

// ---- the registry of the send that is not finished ----------------------------------------------------------------------------------------------------

const ATT = (n = 1, over = {}) => ({ accountId: 'X_A', requestId: ID(n), contentSha256: sha('hello'), text: 'hello', kind: 'in_flight', ...over });
const later = () => new Promise((resolve) => setImmediate(resolve));
/** True if the promise has not settled after a few turns of the event loop. */
async function stillPending(promise) {
  const mark = Symbol('pending');
  const first = await Promise.race([promise, later().then(() => mark)]);
  return first === mark;
}

test('inflight: begin gives a handle; the send is out until its end; ids, users and null are kept apart', async () => {
  const reg = flow.createInFlightSends();
  assert.equal(reg.isOut('U1', ID(1)), false);
  assert.equal(reg.takeOver('U1'), null);
  assert.equal(reg.takeOver(null), null);
  const handle = reg.begin('U1', ATT(1), false);
  assert.deepEqual({ userId: handle.userId, requestId: handle.requestId }, { userId: 'U1', requestId: ID(1) });
  assert.equal(reg.isOut('U1', ID(1)), true);
  assert.equal(reg.isOut('U1', ID(2)), false, 'another id is not out');
  assert.equal(reg.isOut('U2', ID(1)), false, 'another user is not out');
  assert.equal(reg.isOut(null, ID(1)), false);
  assert.equal(reg.takeOver('U2'), null, 'another user has nothing to take over');
  const taken = reg.takeOver('U1');
  assert.deepEqual(taken.attempt, ATT(1));
  assert.equal(taken.retry, false);
  const other = reg.begin('U2', ATT(2), true);
  assert.ok(other, 'another user is never blocked');
  assert.equal(reg.takeOver('U2').retry, true, 'a re-ask is told apart');
  assert.notEqual(other.generation, handle.generation, 'every send has its own generation');
});

test('inflight: end tells every waiter the answer, once; a late holder of the promise still gets it', async () => {
  const reg = flow.createInFlightSends();
  const handle = reg.begin('U1', ATT(1), false);
  const a = reg.takeOver('U1').answer;
  const b = reg.takeOver('U1').answer;
  assert.equal(await stillPending(a), true);
  const answer = { kind: 'pending', targetId: ID(1), code: null };
  reg.end({ ...handle, userId: 'U2' }, { kind: 'published', targetId: ID(1), providerPostId: '1' }); // another user's handle: ignored
  reg.end({ ...handle, generation: handle.generation + 1 }, { kind: 'published', targetId: ID(1), providerPostId: '1' }); // another generation: ignored
  assert.equal(reg.isOut('U1', ID(1)), true);
  assert.equal(await stillPending(a), true, 'not settled by a handle that is not its own');
  reg.end(handle, answer);
  assert.equal(reg.isOut('U1', ID(1)), false);
  assert.equal(reg.takeOver('U1'), null, 'a finished send is forgotten (no text is kept)');
  assert.deepEqual(await a, answer);
  assert.deepEqual(await b, answer);
  reg.end(handle, { kind: 'published', targetId: ID(1), providerPostId: '9' });
  assert.deepEqual(await a, answer, 'an answer is not overwritten by a second end');
});

test('inflight: an unfinished send is never replaced -- a second begin of the same user is refused (same id or another), nothing changes', async () => {
  const reg = flow.createInFlightSends();
  const first = reg.begin('U1', ATT(1), false);
  const taken = reg.takeOver('U1');
  assert.equal(reg.begin('U1', ATT(1), true), null, 'a re-ask with the same id while the first is unfinished');
  assert.equal(reg.begin('U1', ATT(2), false), null, 'another attempt while the first is unfinished');
  assert.equal(reg.isOut('U1', ID(1)), true);
  assert.equal(reg.isOut('U1', ID(2)), false);
  assert.deepEqual(reg.takeOver('U1').attempt, ATT(1), 'the first send is still the one that is out');
  assert.equal(await stillPending(taken.answer), true);
  const answer = { kind: 'uncertain', targetId: ID(1), code: 'X_TIMEOUT' };
  reg.end(first, answer);
  assert.deepEqual(await taken.answer, answer, 'its waiter is not lost');
  assert.ok(reg.begin('U1', ATT(2), false), 'only after it ended may the user start another');
});

test('inflight: an old send can never end or answer a newer one with the same id (A/B/A)', async () => {
  const reg = flow.createInFlightSends();
  const a = reg.begin('U1', ATT(1), false);
  const waitA = reg.takeOver('U1').answer;
  const first = { kind: 'pending', targetId: ID(1), code: 'FIRST_PENDING' };
  reg.end(a, first);
  const b = reg.begin('U1', ATT(1), true); // the re-ask: the same id, another send
  assert.notEqual(b.generation, a.generation);
  const taken = reg.takeOver('U1');
  assert.equal(taken.retry, true);
  reg.end(a, { kind: 'pending', targetId: ID(1), code: 'LATE_OLD_END' }); // the old holder ends AGAIN, late
  assert.equal(reg.isOut('U1', ID(1)), true, 'the newer send is still out');
  assert.equal(await stillPending(taken.answer), true, 'its waiter was not released with the old answer');
  const real = { kind: 'published', targetId: ID(1), providerPostId: '98765' };
  reg.end(b, real);
  assert.deepEqual(await taken.answer, real, 'the real answer reaches the waiter of the newer send');
  assert.deepEqual(await waitA, first, 'the waiter of the old send keeps the old answer');
});

// ---- runSend with the registry ---------------------------------------------------------------------------------------------------------------------

/** A device storage whose writes (and reads) can be held back, and that counts what was written. */
function heldKV(h) {
  const realSet = h.kv.setItem;
  const realGet = h.kv.getItem;
  const ctl = { writes: [], holdSet: false, holdRead: false, held: [] };
  const hold = () => new Promise((resolve) => { ctl.held.push(resolve); });
  h.kv.setItem = async (key, value) => { ctl.writes.push(value); if (ctl.holdSet) await hold(); return realSet(key, value); };
  h.kv.getItem = async (key) => { if (ctl.holdRead) await hold(); return realGet(key); };
  ctl.release = () => { ctl.holdSet = false; ctl.holdRead = false; for (const resolve of ctl.held.splice(0)) resolve(); };
  return ctl;
}
const withRegistry = (h) => { h.deps.inflight = flow.createInFlightSends(); return h; };

test('inflight: runSend registers the send BEFORE its first await -- while the record is still being written the user already has that send', async () => {
  const h = withRegistry(harness());
  const device = heldKV(h);
  device.holdSet = true;
  const done = flow.runSend(h.deps, args());
  assert.equal(h.deps.inflight.isOut('U1', ID(1)), true, 'registered synchronously');
  assert.deepEqual(h.deps.inflight.takeOver('U1').attempt, ATT(1), 'with the text, so a screen that opens now can show it');
  assert.equal(h.memory.get('U1'), null, 'the memory is not written yet');
  assert.equal(h.calls.send.length, 0, 'nothing is sent before the record is confirmed');
  device.release();
  const outcome = await done;
  assert.equal(outcome.kind, 'published');
  assert.equal(h.calls.send.length, 1);
  assert.equal(h.deps.inflight.isOut('U1', ID(1)), false);
});

test('inflight: the send stays registered through the write, the read-back, the answer and the record of the answer -- and ends only then', async () => {
  for (const [label, answer, memoryAfter, recordAfter] of [
    ['pending', { kind: 'pending', code: null, marks: REAL }, 'pending', 'pending'],
    ['unavailable', { kind: 'unavailable', code: 'TRANSPORT_FAILED' }, 'unconfirmed', 'unconfirmed'],
    ['uncertain', { kind: 'uncertain', code: 'X_TIMEOUT', marks: REAL }, 'uncertain', 'uncertain'],
    ['simulated', { kind: 'published', providerPostId: '1' }, 'uncertain', 'uncertain'],
    ['published', { kind: 'published', providerPostId: '1', marks: REAL }, null, null],
    ['rejected', { kind: 'rejected', code: 'X_REJECTED_403', marks: REAL }, null, null],
  ]) {
    const h = withRegistry(harness({ send: async (t) => ({ targetId: t.targetId, ...answer }) }));
    const device = heldKV(h);
    let outDuringSend = null;
    const original = h.deps.port.send;
    h.deps.port.send = async (t) => { outDuringSend = h.deps.inflight.isOut('U1', t.targetId); return original(t); };
    const done = flow.runSend(h.deps, args());
    const waiter = h.deps.inflight.takeOver('U1').answer.then(() => ({
      memory: h.memory.get('U1')?.kind ?? null,
      record: h.kv.data.get(storeKeyOf('U1')) === undefined ? null : JSON.parse(h.kv.data.get(storeKeyOf('U1'))).kind,
    }));
    const outcome = await done;
    assert.equal(outDuringSend, true, `${label}: registered while the port was called`);
    assert.equal(h.deps.inflight.isOut('U1', ID(1)), false, `${label}: ended`);
    // the moment a waiter is released, memory and the device record already say what the answer is
    assert.deepEqual(await waiter, { memory: memoryAfter, record: recordAfter }, label);
    assert.ok(device.writes.length >= 1);
    assert.ok(outcome);
  }
});

test('inflight: while the answer is being recorded the send is still out (the memory already has it, the device record does not)', async () => {
  const h = withRegistry(harness({ send: async (t) => ({ targetId: t.targetId, kind: 'pending', code: 'FIRST_PENDING', marks: REAL }) }));
  const device = heldKV(h);
  let writes = 0;
  const realSet = h.kv.setItem;
  h.kv.setItem = async (key, value) => { writes += 1; if (writes === 2) device.holdSet = true; return realSet(key, value); };
  const done = flow.runSend(h.deps, args());
  for (let i = 0; i < 20 && h.memory.get('U1')?.kind !== 'pending'; i += 1) await later();
  assert.equal(h.memory.get('U1').kind, 'pending', 'the memory has the answer');
  assert.equal(JSON.parse(h.kv.data.get(storeKeyOf('U1'))).kind, 'in_flight', 'the device record is still the old one');
  assert.equal(h.deps.inflight.isOut('U1', ID(1)), true, 'so the send is not finished: nobody may re-ask yet');
  assert.ok(h.deps.inflight.takeOver('U1'));
  device.release();
  await done;
  assert.equal(h.deps.inflight.isOut('U1', ID(1)), false);
  assert.equal(JSON.parse(h.kv.data.get(storeKeyOf('U1'))).kind, 'pending');
});

test('inflight: a start while the user\'s earlier send is unfinished is refused without touching memory, record, port or registry', async () => {
  const sends = [];
  const h = withRegistry(harness({ send: (t) => new Promise((resolve) => { sends.push({ t, resolve }); }) }));
  const device = heldKV(h);
  const first = flow.runSend(h.deps, args());
  for (let i = 0; i < 20 && sends.length === 0; i += 1) await later();
  assert.equal(sends.length, 1);
  const writesBefore = device.writes.length;
  const memoryBefore = h.memory.get('U1');
  const reAsk = await flow.runSend(h.deps, args({ retry: true }));
  assert.deepEqual(reAsk, { kind: 'unavailable', targetId: ID(1), code: 'LOCAL_SEND_IN_PROGRESS' }, 'a re-ask stays unresolved (unavailable), never "refused"');
  const fresh = await flow.runSend(h.deps, args({ requestId: ID(2) }));
  assert.deepEqual(fresh, { kind: 'refused', targetId: ID(2), code: 'LOCAL_SEND_IN_PROGRESS', retryable: false });
  const sameIdFresh = await flow.runSend(h.deps, args());
  assert.equal(sameIdFresh.code, 'LOCAL_SEND_IN_PROGRESS');
  assert.equal(sends.length, 1, 'the port was called once');
  assert.equal(device.writes.length, writesBefore, 'the record on the device was not touched');
  assert.deepEqual(h.memory.get('U1'), memoryBefore, 'the memory was not touched');
  assert.equal(h.deps.inflight.isOut('U1', ID(1)), true, 'the first send is still the one that is out');
  assert.equal(h.deps.inflight.isOut('U1', ID(2)), false);
  sends[0].resolve({ targetId: ID(1), kind: 'pending', code: null, marks: REAL });
  assert.equal((await first).kind, 'pending');
  const again = flow.runSend(h.deps, args({ retry: true })); // only after it ended: the re-ask with the same id
  for (let i = 0; i < 20 && sends.length < 2; i += 1) await later();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].t.targetId, ID(1));
  sends[1].resolve({ targetId: ID(1), kind: 'published', providerPostId: '98765', marks: REAL });
  assert.equal((await again).kind, 'published', 'the re-ask of the finished send goes out');
});

test('inflight: a start while the first record is still being WRITTEN is refused too (nothing is sent twice, nothing is written twice)', async () => {
  const h = withRegistry(harness());
  const device = heldKV(h);
  device.holdSet = true;
  const first = flow.runSend(h.deps, args());
  await later();
  const second = await flow.runSend(h.deps, args({ retry: true }));
  assert.equal(second.code, 'LOCAL_SEND_IN_PROGRESS');
  assert.equal(device.writes.length, 1, 'one write: the first attempt\'s');
  assert.equal(h.calls.send.length, 0);
  device.release();
  assert.equal((await first).kind, 'published');
  assert.equal(h.calls.send.length, 1, 'exactly one request');
});

test('inflight: another user is never blocked by this user\'s unfinished send', async () => {
  const sends = [];
  const h = withRegistry(harness({ send: (t) => new Promise((resolve) => { sends.push({ t, resolve }); }) }));
  const first = flow.runSend(h.deps, args());
  for (let i = 0; i < 20 && sends.length === 0; i += 1) await later();
  const other = flow.runSend(h.deps, args({ userId: 'U2', requestId: ID(2) }));
  for (let i = 0; i < 20 && sends.length < 2; i += 1) await later();
  assert.equal(sends.length, 2, 'both users\' requests are out');
  sends[0].resolve({ targetId: ID(1), kind: 'rejected', code: 'X_REJECTED_403', marks: REAL });
  sends[1].resolve({ targetId: ID(2), kind: 'rejected', code: 'X_REJECTED_403', marks: REAL });
  assert.equal((await first).kind, 'rejected');
  assert.equal((await other).kind, 'rejected');
});

test('inflight: a record that cannot be written releases the waiters with the refusal (a fresh attempt) or "unavailable" (a re-ask), and frees the user', async () => {
  const fresh = withRegistry(harness());
  const device = heldKV(fresh);
  device.holdSet = true;
  const done = flow.runSend(fresh.deps, args());
  const waiter = fresh.deps.inflight.takeOver('U1').answer;
  fresh.kv.fail.set = true;
  device.release();
  const outcome = await done;
  assert.deepEqual(outcome, { kind: 'refused', targetId: ID(1), code: 'LOCAL_STORE_UNAVAILABLE', retryable: false });
  assert.deepEqual(await waiter, outcome);
  assert.equal(fresh.calls.send.length, 0, 'nothing was sent');
  assert.equal(fresh.deps.inflight.isOut('U1', ID(1)), false, 'the user is free again');
  assert.equal(fresh.memory.get('U1'), null);
  const retry = withRegistry(harness());
  retry.memory.mark('U1', { ...ATT(1), kind: 'pending' }); // a re-ask is of an attempt the process knows
  const d2 = heldKV(retry);
  d2.holdSet = true;
  const done2 = flow.runSend(retry.deps, args({ retry: true }));
  const waiter2 = retry.deps.inflight.takeOver('U1').answer;
  retry.kv.fail.set = true;
  d2.release();
  const outcome2 = await done2;
  assert.deepEqual(outcome2, { kind: 'unavailable', targetId: ID(1), code: 'LOCAL_STORE_UNAVAILABLE' });
  assert.deepEqual(await waiter2, outcome2);
  assert.equal(retry.memory.get('U1').kind, 'unconfirmed', 'a failed local write proves nothing about the earlier send');
  assert.equal(retry.deps.inflight.isOut('U1', ID(1)), false);
});

test('inflight: a thrown step anywhere never leaves the registry or a waiter hanging, and the attempt is remembered as uncertain', async () => {
  // the device storage object itself throws
  const broken = withRegistry(harness());
  broken.deps.store = { ...broken.store, write: async () => { throw new Error('storage exploded'); } };
  const done = flow.runSend(broken.deps, args());
  const waiter = broken.deps.inflight.takeOver('U1').answer;
  const lost = await done;
  assert.deepEqual(lost, { kind: 'uncertain', targetId: ID(1), code: 'SEND_STATE_LOST' });
  assert.deepEqual(await waiter, lost);
  assert.equal(broken.deps.inflight.isOut('U1', ID(1)), false);
  assert.equal(broken.memory.get('U1').kind, 'uncertain', 'the screen shows uncertain, so the memory must not say otherwise');
  assert.equal(broken.calls.send.length, 0);
  // a memory that fails while the answer is recorded
  const memoryBroken = withRegistry(harness({ send: async (t) => ({ targetId: t.targetId, kind: 'pending', code: null }) }));
  const mark = memoryBroken.memory.mark;
  let calls = 0;
  memoryBroken.memory.mark = (userId, entry) => { calls += 1; if (calls > 1 && calls < 4) throw new Error('memory failed'); return mark(userId, entry); };
  const lost2 = await flow.runSend(memoryBroken.deps, args());
  assert.deepEqual(lost2, { kind: 'uncertain', targetId: ID(1), code: 'SEND_STATE_LOST' });
  assert.equal(memoryBroken.deps.inflight.isOut('U1', ID(1)), false);
  // the clear after a failed fresh write throws
  const clearBroken = withRegistry(harness());
  clearBroken.kv.fail.set = true;
  clearBroken.deps.store = { ...clearBroken.store, write: async () => false, clear: async () => { throw new Error('clear exploded'); } };
  assert.equal((await flow.runSend(clearBroken.deps, args())).code, 'SEND_STATE_LOST');
  assert.equal(clearBroken.deps.inflight.isOut('U1', ID(1)), false);
});

test('inflight: a thrown port, an invalid answer and a local refusal never leave a waiter hanging; a refusal before the port is not registered at all', async () => {
  const thrown = withRegistry(harness({ send: async () => { throw new Error('boom'); } }));
  const doneThrown = flow.runSend(thrown.deps, args());
  const waitThrown = thrown.deps.inflight.takeOver('U1').answer;
  const outcome = await doneThrown;
  assert.equal(outcome.code, 'SEND_THREW');
  assert.deepEqual(await waitThrown, outcome);
  assert.equal(thrown.deps.inflight.isOut('U1', ID(1)), false);
  const invalid = withRegistry(harness({ send: async () => null }));
  assert.equal((await flow.runSend(invalid.deps, args())).code, 'OUTCOME_INVALID');
  assert.equal(invalid.deps.inflight.isOut('U1', ID(1)), false);
  const refused = withRegistry(harness());
  const doneRefused = flow.runSend(refused.deps, args({ text: 'hello ' }));
  assert.equal(refused.deps.inflight.takeOver('U1'), null, 'nothing was sent, nothing is registered');
  assert.equal((await doneRefused).code, 'LOCAL_CONSENT_MISMATCH');
  const badId = withRegistry(harness());
  const doneBadId = flow.runSend(badId.deps, args({ requestId: 'not-a-uuid' }));
  assert.equal(badId.deps.inflight.takeOver('U1'), null);
  assert.equal((await doneBadId).code, 'LOCAL_ATTEMPT_ID_INVALID');
});

test('inflight: without a registry nothing changes (the registry is optional, runSend works as before)', async () => {
  const h = harness();
  assert.equal(h.deps.inflight, undefined);
  assert.equal((await flow.runSend(h.deps, args())).kind, 'published');
});

test('inflight: the text-less record of an earlier run never replaces what this process knows, nor a send that is being prepared', async () => {
  const h = withRegistry(harness());
  const record = { v: 1, accountId: 'X_A', requestId: ID(9), contentSha256: sha('older'), kind: 'in_flight', savedAt: 1 };
  h.kv.data.set(storeKeyOf('U1'), JSON.stringify(record));
  // (a) memory already has this process's attempt (with its text)
  h.memory.mark('U1', { ...ATT(1), kind: 'pending' });
  assert.equal((await flow.loadPersistedAttempt(h.deps, 'U1')).kind, 'found');
  assert.equal(h.memory.get('U1').text, 'hello', 'the attempt of this process is kept');
  assert.equal(h.memory.get('U1').requestId, ID(1));
  // (b) a send of this user is being prepared right now
  h.memory.clear('U1');
  const handle = h.deps.inflight.begin('U1', ATT(2), false);
  assert.equal((await flow.loadPersistedAttempt(h.deps, 'U1')).kind, 'found');
  assert.equal(h.memory.get('U1'), null, 'nothing is put into the memory while a send is being prepared');
  h.deps.inflight.end(handle, { kind: 'refused', targetId: ID(2), code: 'X', retryable: false });
  // (c) otherwise the record is put into the memory, as before
  assert.equal((await flow.loadPersistedAttempt(h.deps, 'U1')).kind, 'found');
  assert.deepEqual(h.memory.get('U1'), { accountId: 'X_A', requestId: ID(9), contentSha256: sha('older'), text: null, kind: 'in_flight' });
});

test('inflight: send_adopted switches only a visit that is still reading the record; any other state stays as it is', () => {
  const attempt = ATT(1);
  const loading = model.createInitialState(null, { kind: 'loading' });
  const adopted = model.manualPublishReducer(loading, { type: 'send_adopted', attempt, retrying: true });
  assert.equal(adopted.phase, 'sending');
  assert.equal(adopted.requestId, ID(1));
  assert.equal(adopted.retrying, true);
  assert.equal(adopted.draft, 'hello');
  assert.equal(adopted.consent, null);
  assert.equal(adopted.store.kind, 'ready');
  const ready = model.createInitialState(null);
  assert.deepEqual(model.manualPublishReducer(ready, { type: 'send_adopted', attempt, retrying: false }), ready, 'a visit that is ready is not replaced');
  const typing = model.manualPublishReducer(ready, { type: 'draft_changed', text: 'my own words' });
  assert.deepEqual(model.manualPublishReducer(typing, { type: 'send_adopted', attempt, retrying: false }), typing, 'nothing typed is thrown away');
  const result = model.createInitialState({ ...ATT(2), kind: 'pending' });
  assert.deepEqual(model.manualPublishReducer(result, { type: 'send_adopted', attempt, retrying: false }), result, 'a result is not replaced');
  const unreadable = model.manualPublishReducer(loading, { type: 'store_unreadable', reason: 'io' });
  assert.deepEqual(model.manualPublishReducer(unreadable, { type: 'send_adopted', attempt, retrying: false }), unreadable);
});

// ---- send time: an unresolved attempt of this process blocks a start with ANOTHER id (fail closed even if a screen is stale) ------------------------------------

test('unresolved: a fresh start (another id) while this process has an unresolved attempt is refused before the port, the record and the memory', async () => {
  for (const kind of ['uncertain', 'pending', 'unconfirmed']) {
    const h = withRegistry(harness());
    h.memory.mark('U1', { ...ATT(1), kind });
    const outcome = await flow.runSend(h.deps, args({ requestId: ID(2) }));
    assert.deepEqual(outcome, { kind: 'refused', targetId: ID(2), code: 'LOCAL_UNRESOLVED_ATTEMPT', retryable: false }, kind);
    assert.equal(h.calls.send.length, 0, `${kind}: the port was not called`);
    assert.equal(h.kv.data.size, 0, `${kind}: nothing was written to the device`);
    assert.equal(h.memory.get('U1').requestId, ID(1), `${kind}: the unresolved attempt is untouched`);
    assert.equal(h.deps.inflight.takeOver('U1'), null, `${kind}: nothing stays registered`);
  }
});

test('unresolved: only a re-ask of THAT attempt may start; another id is refused whether it says "retry" or not, and a refusal frees the registry', async () => {
  const h = withRegistry(harness());
  h.memory.mark('U1', { ...ATT(1), kind: 'pending' });
  const retryOther = await flow.runSend(h.deps, args({ requestId: ID(2), retry: true }));
  assert.deepEqual(retryOther, { kind: 'unavailable', targetId: ID(2), code: 'LOCAL_UNRESOLVED_ATTEMPT' }, 'a re-ask with another id stays unresolved');
  const freshSame = await flow.runSend(h.deps, args());
  assert.deepEqual(freshSame, { kind: 'refused', targetId: ID(1), code: 'LOCAL_UNRESOLVED_ATTEMPT', retryable: false }, 'a "fresh" send with the unresolved id is not a re-ask');
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.kv.data.size, 0);
  assert.equal(h.deps.inflight.takeOver('U1'), null, 'the refusal frees the registry');
  assert.equal(h.deps.inflight.isOut('U1', ID(2)), false);
  const reAsk = await flow.runSend(h.deps, args({ retry: true }));
  assert.equal(reAsk.kind, 'published', 'the re-ask of the same attempt goes out');
  assert.equal(h.calls.send.length, 1);
  assert.equal(h.calls.send[0].targetId, ID(1));
});

test('unresolved: the refusal happens with and without a registry, and another user is never refused by it', async () => {
  const bare = harness();
  bare.memory.mark('U1', { ...ATT(1), kind: 'uncertain' });
  assert.equal((await flow.runSend(bare.deps, args({ requestId: ID(2) }))).code, 'LOCAL_UNRESOLVED_ATTEMPT');
  assert.equal(bare.calls.send.length, 0);
  assert.equal((await flow.runSend(bare.deps, args({ userId: 'U2', requestId: ID(3) }))).kind, 'published', 'another user');
  const sends = [];
  const busy = withRegistry(harness({ send: (t) => new Promise((resolve) => { sends.push({ t, resolve }); }) }));
  const first = flow.runSend(busy.deps, args());
  for (let i = 0; i < 20 && sends.length === 0; i += 1) await later();
  const second = await flow.runSend(busy.deps, args({ requestId: ID(2) }));
  assert.equal(second.code, 'LOCAL_SEND_IN_PROGRESS', 'while a send is unfinished, THAT is the reason given');
  sends[0].resolve({ targetId: ID(1), kind: 'uncertain', code: 'OFFLINE', marks: REAL });
  assert.equal((await first).kind, 'uncertain');
  const third = await flow.runSend(busy.deps, args({ requestId: ID(2) }));
  assert.equal(third.code, 'LOCAL_UNRESOLVED_ATTEMPT', 'after it ended unresolved, a start with another id is refused');
  assert.equal(sends.length, 1);
});

test('reconcile: what the process knows NOW wins over a snapshot -- a send that is out, then the memory, only then the snapshot', async () => {
  const none = { kind: 'none' };
  const found = { kind: 'found', attempt: { v: 1, accountId: 'X_A', requestId: ID(9), contentSha256: sha('older'), kind: 'pending', savedAt: 1 } };
  const unreadable = { kind: 'unreadable', reason: 'io' };
  const h = withRegistry(harness());
  for (const read of [none, found, unreadable]) {
    assert.deepEqual(flow.reconcileLoadedRead(h.deps, 'U1', read), { kind: 'record', read }, 'the process knows nothing: the snapshot as it is');
  }
  h.memory.mark('U1', { ...ATT(2), kind: 'uncertain' });
  for (const read of [none, found, unreadable]) {
    assert.deepEqual(flow.reconcileLoadedRead(h.deps, 'U1', read), { kind: 'memory', attempt: { ...ATT(2), kind: 'uncertain' } }, 'the memory beats the snapshot');
  }
  assert.deepEqual(flow.reconcileLoadedRead(h.deps, 'U2', none), { kind: 'record', read: none }, 'another user is not affected');
  const handle = h.deps.inflight.begin('U1', ATT(3), true);
  const view = flow.reconcileLoadedRead(h.deps, 'U1', none);
  assert.equal(view.kind, 'send', 'a send that is out beats the memory');
  assert.equal(view.takeOver.attempt.requestId, ID(3));
  assert.equal(view.takeOver.retry, true);
  h.deps.inflight.end(handle, { kind: 'uncertain', targetId: ID(3), code: 'X' });
  assert.equal(flow.reconcileLoadedRead(h.deps, 'U1', none).kind, 'memory');
  const bare = harness();
  assert.deepEqual(flow.reconcileLoadedRead(bare.deps, 'U1', none), { kind: 'record', read: none }, 'without a registry too');
});

// ---- send time: the unresolved attempt must be RE-ASKABLE NOW, not only have the same id ----------------------------------------------------------------

test('live kind: a re-ask of an attempt that is uncertain now is refused as uncertain (never downgraded) before the port, the record and the memory', async () => {
  for (const withRegistry_ of [true, false]) {
    const h = withRegistry_ ? withRegistry(harness()) : harness();
    h.memory.mark('U1', { ...ATT(1), kind: 'uncertain' });
    const outcome = await flow.runSend(h.deps, args({ retry: true }));
    assert.deepEqual(outcome, { kind: 'uncertain', targetId: ID(1), code: 'LOCAL_UNRESOLVED_ATTEMPT' }, `registry=${withRegistry_}`);
    assert.equal(h.calls.send.length, 0);
    assert.equal(h.kv.data.size, 0);
    assert.deepEqual(h.memory.get('U1'), { ...ATT(1), kind: 'uncertain' });
    if (withRegistry_) assert.equal(h.deps.inflight.takeOver('U1'), null, 'the registry entry is released');
  }
});

test('live kind: mayRetryAttempt is the rule of mayRetrySameId applied to the attempt -- pending / unconfirmed / an attempt left in_flight may be re-asked, uncertain never', () => {
  assert.equal(model.mayRetryAttempt({ kind: 'pending' }), true);
  assert.equal(model.mayRetryAttempt({ kind: 'unconfirmed' }), true);
  assert.equal(model.mayRetryAttempt({ kind: 'in_flight' }), true, 'shown (and re-asked) as unconfirmed after a restart');
  assert.equal(model.mayRetryAttempt({ kind: 'uncertain' }), false);
  for (const kind of ['pending', 'unconfirmed', 'uncertain']) assert.equal(model.mayRetryAttempt({ kind }), model.mayRetrySameId(kind), kind);
});

test('live kind: a re-ask of an attempt that may be re-asked NOW goes out, with and without a registry, for every re-askable kind', async () => {
  for (const kind of ['pending', 'unconfirmed', 'in_flight']) {
    for (const registry of [true, false]) {
      const h = registry ? withRegistry(harness()) : harness();
      h.memory.mark('U1', { ...ATT(1), kind, ...(kind === 'in_flight' ? { text: null } : {}) });
      const outcome = await flow.runSend(h.deps, args({ retry: true }));
      assert.equal(outcome.kind, 'published', `${kind} / registry=${registry}`);
      assert.equal(h.calls.send.length, 1, `${kind} / registry=${registry}`);
      assert.equal(h.calls.send[0].targetId, ID(1), 'the SAME id');
    }
  }
});

test('live kind: the other refusals keep their shape -- another id (re-ask or not) and a "fresh" send with the uncertain id', async () => {
  const h = withRegistry(harness());
  h.memory.mark('U1', { ...ATT(1), kind: 'uncertain' });
  assert.deepEqual(await flow.runSend(h.deps, args({ requestId: ID(2), retry: true })), { kind: 'unavailable', targetId: ID(2), code: 'LOCAL_UNRESOLVED_ATTEMPT' });
  assert.deepEqual(await flow.runSend(h.deps, args({ requestId: ID(2) })), { kind: 'refused', targetId: ID(2), code: 'LOCAL_UNRESOLVED_ATTEMPT', retryable: false });
  assert.deepEqual(await flow.runSend(h.deps, args()), { kind: 'refused', targetId: ID(1), code: 'LOCAL_UNRESOLVED_ATTEMPT', retryable: false });
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.kv.data.size, 0);
  assert.equal(h.memory.get('U1').kind, 'uncertain');
  assert.equal(flow.UNRESOLVED_REFUSAL_CODE, 'LOCAL_UNRESOLVED_ATTEMPT');
});

test('live kind: send_not_started brings a sending screen to the attempt as the process knows it, and does nothing in any other state', () => {
  const uncertain = { ...ATT(1), kind: 'uncertain' };
  const confirming = (() => {
    let s = model.createInitialState({ ...ATT(1), kind: 'pending' });
    s = model.manualPublishReducer(s, { type: 'retry_requested' });
    return s;
  })();
  assert.equal(confirming.phase, 'confirming');
  const sending = model.createSendingState({ ...ATT(1), kind: 'pending' }, true);
  const resynced = model.manualPublishReducer(sending, { type: 'send_not_started', requestId: ID(1), attempt: uncertain });
  assert.equal(resynced.phase, 'result');
  assert.equal(resynced.result.kind, 'uncertain');
  assert.equal(resynced.unresolved.kind, 'uncertain', 'not downgraded');
  assert.equal(resynced.unresolved.requestId, ID(1));
  assert.equal(resynced.consent, null);
  assert.equal(resynced.retrying, false);
  assert.equal(resynced.draft, 'hello');
  assert.deepEqual(model.manualPublishReducer(sending, { type: 'send_not_started', requestId: ID(2), attempt: uncertain }), sending, 'another request id');
  assert.deepEqual(model.manualPublishReducer(confirming, { type: 'send_not_started', requestId: ID(1), attempt: uncertain }), confirming, 'not sending');
  const done = model.manualPublishReducer(sending, { type: 'send_settled', requestId: ID(1), outcome: { kind: 'pending', targetId: ID(1), code: null } });
  assert.deepEqual(model.manualPublishReducer(done, { type: 'send_not_started', requestId: ID(1), attempt: uncertain }), done, 'already settled');
});

// ---- acknowledge: one operation per user, shared with the send ------------------------------------------------------------------------------------

test('ack registry: an acknowledge and a send exclude each other; an acknowledge is no send; only its own handle releases it', async () => {
  const reg = flow.createInFlightSends();
  const ack = reg.beginAcknowledge('U1');
  assert.ok(ack);
  assert.equal(reg.begin('U1', ATT(1), false), null, 'no send under a clear that is running');
  assert.equal(reg.beginAcknowledge('U1'), null, 'no second acknowledge');
  assert.equal(reg.takeOver('U1'), null, 'a screen never "takes over" an acknowledge');
  assert.equal(reg.isOut('U1', ID(1)), false);
  assert.ok(reg.beginAcknowledge('U2'), 'another user is never blocked');
  reg.end(ack, { kind: 'uncertain', targetId: ID(1), code: 'X' }); // end() is for sends
  assert.equal(reg.begin('U1', ATT(1), false), null, 'still reserved: end() does not release an acknowledge');
  reg.release({ ...ack, generation: ack.generation + 100 });
  reg.release({ ...ack, userId: 'U3' });
  assert.equal(reg.beginAcknowledge('U1'), null, 'a handle of another generation or user releases nothing');
  reg.release(ack);
  reg.release(ack); // twice: ignored
  const send = reg.begin('U1', ATT(1), false);
  assert.ok(send, 'free again');
  reg.release(send); // release() is for acknowledges
  assert.equal(reg.isOut('U1', ID(1)), true, 'release() does not end a send');
  assert.equal(reg.beginAcknowledge('U1'), null, 'no acknowledge while a send is unfinished');
  reg.release(ack); // the old handle can never release the newer operation
  assert.equal(reg.isOut('U1', ID(1)), true);
  reg.end(send, { kind: 'uncertain', targetId: ID(1), code: 'X' });
  assert.ok(reg.beginAcknowledge('U1'));
});

const ackDeps = (h) => h.deps;

test('acknowledge: a normal acknowledge clears the device record and then the memory, and frees the user', async () => {
  const h = withRegistry(harness());
  for (const expected of [null, ID(1)]) {
    h.memory.mark('U1', { ...ATT(1), kind: 'pending' });
    h.kv.data.set(storeKeyOf('U1'), JSON.stringify({ v: 1, accountId: 'X_A', requestId: ID(1), contentSha256: sha('hello'), kind: 'pending', savedAt: 1 }));
    assert.deepEqual(await flow.acknowledgeAttempt(ackDeps(h), 'U1', expected), { kind: 'cleared' }, String(expected));
    assert.equal(h.memory.get('U1'), null);
    assert.equal(h.kv.data.has(storeKeyOf('U1')), false);
    const free = h.deps.inflight.beginAcknowledge('U1');
    assert.ok(free, 'the reservation was released');
    h.deps.inflight.release(free);
  }
});

test('acknowledge: refused (nothing cleared) while a send of the user is unfinished -- the record and the memory of the send stay', async () => {
  const sends = [];
  const h = withRegistry(harness({ send: (t) => new Promise((resolve) => { sends.push({ t, resolve }); }) }));
  h.memory.mark('U1', { ...ATT(1), kind: 'pending' });
  const done = flow.runSend(h.deps, args({ retry: true }));
  for (let i = 0; i < 20 && sends.length === 0; i += 1) await later();
  const recordBefore = h.kv.data.get(storeKeyOf('U1'));
  assert.equal(JSON.parse(recordBefore).kind, 'in_flight');
  for (const expected of [null, ID(1), ID(2)]) {
    assert.deepEqual(await flow.acknowledgeAttempt(h.deps, 'U1', expected), { kind: 'refused', reason: 'in_progress' }, String(expected));
  }
  assert.equal(await flow.runAcknowledge(h.deps, 'U1'), false, 'the boolean wrapper does not claim a clear either');
  assert.equal(h.kv.data.get(storeKeyOf('U1')), recordBefore, 'the record on the device is untouched');
  assert.equal(h.memory.get('U1').kind, 'in_flight');
  assert.equal(h.deps.inflight.isOut('U1', ID(1)), true);
  sends[0].resolve({ targetId: ID(1), kind: 'uncertain', code: 'OFFLINE', marks: REAL });
  assert.equal((await done).kind, 'uncertain');
  assert.deepEqual(await flow.acknowledgeAttempt(h.deps, 'U1', ID(1)), { kind: 'cleared' }, 'once the send ended, the acknowledge works');
});

test('acknowledge: an acknowledge that names another attempt than the process knows is refused as stale and clears nothing', async () => {
  const h = withRegistry(harness());
  h.memory.mark('U1', { ...ATT(2), kind: 'uncertain' });
  h.kv.data.set(storeKeyOf('U1'), JSON.stringify({ v: 1, accountId: 'X_A', requestId: ID(2), contentSha256: sha('hello'), kind: 'uncertain', savedAt: 1 }));
  assert.deepEqual(await flow.acknowledgeAttempt(h.deps, 'U1', ID(1)), { kind: 'refused', reason: 'stale' });
  assert.equal(h.memory.get('U1').requestId, ID(2));
  assert.equal(JSON.parse(h.kv.data.get(storeKeyOf('U1'))).requestId, ID(2));
  assert.ok(h.deps.inflight.beginAcknowledge('U1'), 'the reservation was released');
});

test('acknowledge: a record that cannot be removed keeps blocking (memory kept) and frees the user; a thrown clear is the same', async () => {
  for (const mode of ['false', 'throws']) {
    const h = withRegistry(harness());
    h.memory.mark('U1', { ...ATT(1), kind: 'pending' });
    h.kv.data.set(storeKeyOf('U1'), JSON.stringify({ v: 1, accountId: 'X_A', requestId: ID(1), contentSha256: sha('hello'), kind: 'pending', savedAt: 1 }));
    if (mode === 'false') h.kv.fail.drop = true; else h.deps.store = { ...h.store, clear: async () => { throw new Error('boom'); } };
    if (mode === 'false') { const realRemove = h.kv.removeItem; h.kv.removeItem = async () => {}; h.kv.removeItem.real = realRemove; }
    assert.deepEqual(await flow.acknowledgeAttempt(h.deps, 'U1', ID(1)), { kind: 'failed' }, mode);
    assert.equal(h.memory.get('U1').requestId, ID(1), `${mode}: still unresolved`);
    assert.ok(h.deps.inflight.beginAcknowledge('U1'), `${mode}: the user is free again`);
  }
});

test('acknowledge: while a clear is running no send can start (the reverse order), and nothing is written or sent', async () => {
  const h = withRegistry(harness());
  h.memory.mark('U1', { ...ATT(1), kind: 'pending' });
  h.kv.data.set(storeKeyOf('U1'), JSON.stringify({ v: 1, accountId: 'X_A', requestId: ID(1), contentSha256: sha('hello'), kind: 'pending', savedAt: 1 }));
  const realRemove = h.kv.removeItem;
  const held = [];
  h.kv.removeItem = async (key) => { await new Promise((resolve) => { held.push(resolve); }); return realRemove(key); };
  const writes = [];
  const realSet = h.kv.setItem;
  h.kv.setItem = async (key, value) => { writes.push(value); return realSet(key, value); };
  const ack = flow.acknowledgeAttempt(h.deps, 'U1', ID(1));
  for (let i = 0; i < 20 && held.length === 0; i += 1) await later();
  assert.equal(held.length, 1, 'the clear is running');
  const reAsk = await flow.runSend(h.deps, args({ retry: true }));
  assert.deepEqual(reAsk, { kind: 'unavailable', targetId: ID(1), code: 'LOCAL_SEND_IN_PROGRESS' });
  const fresh = await flow.runSend(h.deps, args({ requestId: ID(2) }));
  assert.equal(fresh.code, 'LOCAL_SEND_IN_PROGRESS');
  assert.equal(h.calls.send.length, 0);
  assert.equal(writes.length, 0, 'no record was written under the clear');
  assert.deepEqual(await flow.acknowledgeAttempt(h.deps, 'U1', ID(1)), { kind: 'refused', reason: 'in_progress' }, 'no second acknowledge either');
  for (const resolve of held.splice(0)) resolve();
  assert.deepEqual(await ack, { kind: 'cleared' });
  assert.equal(h.memory.get('U1'), null);
  assert.equal(h.kv.data.has(storeKeyOf('U1')), false);
});

test('acknowledge: another user is not touched, and without a registry the acknowledge still works as before', async () => {
  const h = withRegistry(harness());
  h.memory.mark('U1', { ...ATT(1), kind: 'pending' });
  h.memory.mark('U2', { ...ATT(2), kind: 'pending' });
  h.kv.data.set(storeKeyOf('U1'), JSON.stringify({ v: 1, accountId: 'X_A', requestId: ID(1), contentSha256: sha('hello'), kind: 'pending', savedAt: 1 }));
  h.kv.data.set(storeKeyOf('U2'), JSON.stringify({ v: 1, accountId: 'X_A', requestId: ID(2), contentSha256: sha('hello'), kind: 'pending', savedAt: 1 }));
  assert.deepEqual(await flow.acknowledgeAttempt(h.deps, 'U1', ID(1)), { kind: 'cleared' });
  assert.equal(h.memory.get('U2').requestId, ID(2), 'the other user\'s attempt is kept');
  assert.ok(h.kv.data.has(storeKeyOf('U2')), 'and so is the other user\'s record');
  const bare = harness();
  bare.memory.mark('U1', { ...ATT(1), kind: 'pending' });
  assert.equal(bare.deps.inflight, undefined);
  assert.equal(await flow.runAcknowledge(bare.deps, 'U1'), true);
  assert.equal(bare.memory.get('U1'), null);
});

test('ack_refused: brings a result screen to the attempt as the process knows it now, and does nothing in any other state', () => {
  const pendingView = model.createInitialState({ ...ATT(1), kind: 'pending' });
  const send = { attempt: ATT(1), retry: true };
  const sending = model.manualPublishReducer(pendingView, { type: 'ack_refused', send, attempt: { ...ATT(1), kind: 'in_flight' } });
  assert.equal(sending.phase, 'sending');
  assert.equal(sending.retrying, true);
  assert.equal(sending.requestId, ID(1));
  const uncertain = model.manualPublishReducer(pendingView, { type: 'ack_refused', send: null, attempt: { ...ATT(2), kind: 'uncertain' } });
  assert.equal(uncertain.phase, 'result');
  assert.equal(uncertain.result.kind, 'uncertain');
  assert.equal(uncertain.unresolved.requestId, ID(2));
  assert.deepEqual(model.manualPublishReducer(pendingView, { type: 'ack_refused', send: null, attempt: null }), pendingView, 'nothing known: unchanged, never an empty editor');
  const editing = model.createInitialState(null);
  assert.deepEqual(model.manualPublishReducer(editing, { type: 'ack_refused', send, attempt: null }), editing, 'not a result screen');
  assert.deepEqual(model.manualPublishReducer(sending, { type: 'ack_refused', send: null, attempt: { ...ATT(2), kind: 'uncertain' } }), sending, 'a sending screen is left alone');
});

// ---- send time: a re-ask needs the attempt in the memory of THIS process now (acknowledged or ended elsewhere = gone) -----------------------------------

test('post-ack: a re-ask while the process memory has no attempt of this user is refused before the port, the record and the memory (with and without a registry)', async () => {
  for (const registry of [true, false]) {
    const h = registry ? withRegistry(harness()) : harness();
    const outcome = await flow.runSend(h.deps, args({ retry: true }));
    assert.deepEqual(outcome, { kind: 'refused', targetId: ID(1), code: 'LOCAL_ATTEMPT_CLEARED', retryable: false }, `registry=${registry}`);
    assert.equal(h.calls.send.length, 0);
    assert.equal(h.kv.data.size, 0);
    assert.equal(h.memory.get('U1'), null);
    if (registry) assert.equal(h.deps.inflight.takeOver('U1'), null, 'the reservation is released');
  }
});

const RECORD = (over = {}) => JSON.stringify({ v: 1, accountId: 'X_A', requestId: ID(1), contentSha256: sha('hello'), kind: 'pending', savedAt: 1, ...over });

test('post-ack: with an empty memory the DEVICE record decides -- this attempt re-askable -> it goes out; none / another id -> refused as cleared', async () => {
  for (const kind of ['pending', 'unconfirmed', 'in_flight']) {
    const h = withRegistry(harness());
    h.kv.data.set(storeKeyOf('U1'), RECORD({ kind }));
    const outcome = await flow.runSend(h.deps, args({ retry: true }));
    assert.equal(outcome.kind, 'published', `${kind}: a restart re-ask of the recorded attempt goes out`);
    assert.equal(h.calls.send.length, 1, kind);
    assert.equal(h.calls.send[0].targetId, ID(1), `${kind}: the SAME id`);
  }
  for (const [label, record] of [['none', null], ['another id', RECORD({ requestId: ID(7) })]]) {
    const h = withRegistry(harness());
    if (record !== null) h.kv.data.set(storeKeyOf('U1'), record);
    const outcome = await flow.runSend(h.deps, args({ retry: true }));
    assert.deepEqual(outcome, { kind: 'refused', targetId: ID(1), code: 'LOCAL_ATTEMPT_CLEARED', retryable: false }, label);
    assert.equal(h.calls.send.length, 0, label);
    assert.equal(h.kv.data.get(storeKeyOf('U1')) ?? null, record, `${label}: the device is untouched`);
    assert.equal(h.memory.get('U1'), null, `${label}: the memory stays empty`);
    assert.equal(h.deps.inflight.takeOver('U1'), null, `${label}: the reservation is released`);
  }
  assert.equal(flow.ATTEMPT_CLEARED_CODE, 'LOCAL_ATTEMPT_CLEARED');
});

test('post-ack: a recorded attempt that is uncertain, or of another account or text, is not re-asked; it is put into the memory as it is', async () => {
  const h = withRegistry(harness());
  h.kv.data.set(storeKeyOf('U1'), RECORD({ kind: 'uncertain' }));
  assert.deepEqual(await flow.runSend(h.deps, args({ retry: true })), { kind: 'uncertain', targetId: ID(1), code: 'LOCAL_UNRESOLVED_ATTEMPT' });
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.memory.get('U1').kind, 'uncertain', 'the process now knows the attempt (text-less, as after a restart)');
  assert.equal(h.memory.get('U1').text, null);
  assert.equal(JSON.parse(h.kv.data.get(storeKeyOf('U1'))).kind, 'uncertain', 'the record is untouched');
  for (const [label, over] of [['another text', { contentSha256: sha('other') }], ['another account', { accountId: 'X_B' }]]) {
    const w = withRegistry(harness());
    w.kv.data.set(storeKeyOf('U1'), RECORD(over));
    assert.deepEqual(await flow.runSend(w.deps, args({ retry: true })), { kind: 'unavailable', targetId: ID(1), code: 'LOCAL_UNRESOLVED_ATTEMPT' }, label);
    assert.equal(w.calls.send.length, 0, label);
    assert.equal(w.memory.get('U1').requestId, ID(1), label);
  }
});

test('post-ack: an unreadable device record fails closed (unavailable, kept unresolved), nothing is sent or written', async () => {
  for (const mode of ['get-throws', 'corrupt']) {
    const h = withRegistry(harness());
    if (mode === 'get-throws') h.kv.fail.get = true;
    else h.kv.data.set(storeKeyOf('U1'), '{not json');
    const before = h.kv.data.get(storeKeyOf('U1'));
    assert.deepEqual(await flow.runSend(h.deps, args({ retry: true })), { kind: 'unavailable', targetId: ID(1), code: 'LOCAL_STORE_UNAVAILABLE' }, mode);
    assert.equal(h.calls.send.length, 0, mode);
    assert.equal(h.memory.get('U1').kind, 'unconfirmed', `${mode}: blocks like a failed write of a re-ask`);
    assert.equal(h.kv.data.get(storeKeyOf('U1')), before, `${mode}: the device is untouched`);
    assert.equal(h.deps.inflight.takeOver('U1'), null);
  }
  const thrown = withRegistry(harness());
  thrown.deps.store = { ...thrown.store, read: async () => { throw new Error('boom'); } };
  assert.equal((await flow.runSend(thrown.deps, args({ retry: true }))).code, 'LOCAL_STORE_UNAVAILABLE', 'a thrown read too');
  assert.equal(thrown.calls.send.length, 0);
});

test('post-ack: the device check runs under the reservation -- an acknowledge cannot run while it reads, and a fresh send is unaffected', async () => {
  const h = withRegistry(harness());
  h.kv.data.set(storeKeyOf('U1'), RECORD());
  const realGet = h.kv.getItem;
  const held = [];
  let hold = true;
  h.kv.getItem = async (key) => { if (hold) { hold = false; await new Promise((resolve) => { held.push(resolve); }); } return realGet(key); };
  const reAsk = flow.runSend(h.deps, args({ retry: true }));
  for (let i = 0; i < 20 && held.length === 0; i += 1) await later();
  assert.equal(held.length, 1, 'the record is being read');
  assert.deepEqual(await flow.acknowledgeAttempt(h.deps, 'U1', ID(1)), { kind: 'refused', reason: 'in_progress' }, 'no clear meanwhile');
  for (const resolve of held.splice(0)) resolve();
  assert.equal((await reAsk).kind, 'published');
  assert.equal(h.calls.send.length, 1);
  const fresh = withRegistry(harness());
  assert.equal((await flow.runSend(fresh.deps, args())).kind, 'published', 'a fresh attempt never reads the record first');
});

test('post-ack: the device check reads the record of THIS user only -- another user\'s record of the same id never lets a re-ask through', async () => {
  const h = withRegistry(harness());
  h.kv.data.set(storeKeyOf('U1'), RECORD());
  const outcome = await flow.runSend(h.deps, args({ userId: 'U2', retry: true }));
  assert.deepEqual(outcome, { kind: 'refused', targetId: ID(1), code: 'LOCAL_ATTEMPT_CLEARED', retryable: false });
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.memory.get('U2'), null);
  assert.equal(h.memory.get('U1'), null, 'the other user\'s record is not put into any memory');
});

// ---- a read of the device record is a snapshot: it never re-creates an attempt the memory dropped while it was being read --------------------------------

test('delayed read: loadPersistedAttempt never puts back an attempt that was acknowledged while the record was being read', async () => {
  const h = withRegistry(harness());
  h.kv.data.set(storeKeyOf('U1'), JSON.stringify({ v: 1, accountId: 'X_A', requestId: ID(1), contentSha256: sha('hello'), kind: 'pending', savedAt: 1 }));
  const realGet = h.kv.getItem;
  const held = [];
  let hold = true;
  h.kv.getItem = async (key) => { const value = await realGet(key); if (hold) { hold = false; await new Promise((resolve) => { held.push(resolve); }); } return value; };
  const load = flow.loadPersistedAttempt(h.deps, 'U1');
  for (let i = 0; i < 20 && held.length === 0; i += 1) await later();
  assert.equal(held.length, 1, 'the snapshot (R1 found) is held');
  // meanwhile another screen restores R1 and the user acknowledges it
  h.memory.mark('U1', { ...ATT(1), text: null, kind: 'pending' });
  assert.deepEqual(await flow.acknowledgeAttempt(h.deps, 'U1', ID(1)), { kind: 'cleared' });
  for (const resolve of held.splice(0)) resolve();
  await load;
  assert.equal(h.memory.get('U1'), null, 'the acknowledged attempt is not brought back');
  assert.equal(h.kv.data.has(storeKeyOf('U1')), false);
});

const R_REC = (id, over = {}) => JSON.stringify({ v: 1, accountId: 'X_A', requestId: id, contentSha256: sha('hello'), kind: 'pending', savedAt: 1, ...over });

/** Hold the RETURN of the next read (the value is read first): a snapshot delivered late. */
function lateRead(h) {
  const realGet = h.kv.getItem;
  const ctl = { held: [], holdNext: false, reads: 0 };
  h.kv.getItem = async (key) => {
    const value = await realGet(key);
    ctl.reads += 1;
    if (ctl.holdNext) { ctl.holdNext = false; await new Promise((resolve) => { ctl.held.push(resolve); }); }
    return value;
  };
  ctl.release = () => { for (const resolve of ctl.held.splice(0)) resolve(); };
  return ctl;
}
const heldOnce = async (ctl) => { for (let i = 0; i < 20 && ctl.held.length === 0; i += 1) await later(); assert.equal(ctl.held.length, 1, 'the snapshot is held'); };

test('memory version: moves on every mark and every clear (also a clear of nothing), per user', () => {
  const memory = flow.createAttemptMemory();
  assert.equal(memory.version('U1'), 0);
  memory.mark('U1', ATT(1));
  assert.equal(memory.version('U1'), 1);
  memory.mark('U1', ATT(1));
  assert.equal(memory.version('U1'), 2, 'the same entry again still moves it');
  memory.clear('U1');
  assert.equal(memory.version('U1'), 3);
  memory.clear('U1');
  assert.equal(memory.version('U1'), 4, 'a clear of nothing moves it too');
  assert.equal(memory.version('U2'), 0, 'another user is independent');
});

test('delayed read: the memory knows ANOTHER attempt now -- the old snapshot is returned but never put into the memory (old R1 / new R2)', async () => {
  const h = withRegistry(harness());
  h.kv.data.set(storeKeyOf('U1'), R_REC(ID(1)));
  const ctl = lateRead(h);
  ctl.holdNext = true;
  const load = flow.loadPersistedAttempt(h.deps, 'U1');
  await heldOnce(ctl);
  h.memory.mark('U1', { ...ATT(2), kind: 'pending' }); // R1 was acknowledged and a new attempt R2 began meanwhile
  ctl.release();
  const read = await load;
  assert.equal(read.kind, 'found');
  assert.equal(h.memory.get('U1').requestId, ID(2), 'the newer attempt stays');
  assert.equal(flow.reconcileLoadedRead(h.deps, 'U1', read).kind, 'memory', 'and is what the visit shows');
  assert.equal(ctl.reads, 1, 'no second read is needed: the memory decides');
});

test('delayed read: the memory was emptied meanwhile -- the record is read AGAIN, and what is there now decides', async () => {
  const h = withRegistry(harness());
  h.kv.data.set(storeKeyOf('U1'), R_REC(ID(1)));
  const ctl = lateRead(h);
  ctl.holdNext = true;
  const load = flow.loadPersistedAttempt(h.deps, 'U1');
  await heldOnce(ctl);
  h.memory.mark('U1', { ...ATT(1), text: null, kind: 'pending' });
  h.memory.clear('U1');
  h.kv.data.set(storeKeyOf('U1'), R_REC(ID(3))); // a record of another attempt is on the device by now
  ctl.release();
  const read = await load;
  assert.equal(read.kind, 'found');
  assert.equal(read.attempt.requestId, ID(3), 'the fresh read, not the old snapshot');
  assert.equal(h.memory.get('U1').requestId, ID(3));
  assert.equal(ctl.reads, 2, 'read twice');
});

test('delayed read: a memory that keeps changing under every read is treated as unreadable (fail closed), nothing is put into it', async () => {
  const h = withRegistry(harness());
  h.kv.data.set(storeKeyOf('U1'), R_REC(ID(1)));
  const realGet = h.kv.getItem;
  h.kv.getItem = async (key) => { const value = await realGet(key); h.memory.clear('U1'); return value; };
  assert.deepEqual(await flow.loadPersistedAttempt(h.deps, 'U1'), { kind: 'unreadable', reason: 'io' });
  assert.equal(h.memory.get('U1'), null);
});

test('delayed read: an unchanged memory keeps the earlier behaviour -- a restart record is put into the memory once, another user is independent', async () => {
  const h = withRegistry(harness());
  h.kv.data.set(storeKeyOf('U1'), R_REC(ID(1)));
  h.kv.data.set(storeKeyOf('U9'), R_REC(ID(9)));
  h.memory.mark('U1', { ...ATT(1), kind: 'pending' }); // U1 has a history of its own before U9 reads
  h.memory.clear('U1');
  const ctl = lateRead(h);
  ctl.holdNext = true;
  const load = flow.loadPersistedAttempt(h.deps, 'U9');
  await heldOnce(ctl);
  h.memory.mark('U1', { ...ATT(1), kind: 'pending' });
  h.memory.clear('U1'); // only U1 changes
  ctl.release();
  const read = await load;
  assert.equal(read.kind, 'found');
  assert.equal(h.memory.get('U9').requestId, ID(9), 'U9\'s record is restored');
  assert.equal(ctl.reads, 1, 'read once');
  assert.equal(h.memory.get('U1'), null);
});
