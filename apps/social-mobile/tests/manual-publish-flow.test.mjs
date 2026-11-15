// F1 manual X single post: the async steps (readiness check, the one send) and the memory of an attempt that
// may have posted. Offline: every external thing is injected; the global network entry points are booby-trapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as flow from '../src/features/manual-publish/manual-publish-flow.ts';
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

function harness(portOver = {}) {
  const calls = { check: [], send: [] };
  const memory = flow.createAttemptMemory();
  const fakePort = {
    checkReadiness: async (accountId) => { calls.check.push(accountId); return { kind: 'ready' }; },
    send: async (target) => { calls.send.push(target); return { kind: 'published', targetId: target.targetId, providerPostId: '1234567890' }; },
    ...portOver,
  };
  let clock = 5_000;
  let n = 0;
  const deps = { port: fakePort, now: () => clock, newRequestId: () => `req-${++n}`, memory };
  return { calls, memory, deps, tick: (ms) => { clock += ms; } };
}
const args = (over = {}) => ({ userId: 'U1', accountId: 'X_A', text: 'hello', requestId: 'req-1', ...over });

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
  const refused = await port.UNCONNECTED_MANUAL_PUBLISH_PORT.send({ targetId: 't', provider: 'x', connectedAccountId: 'X_A', renderedText: 'hi', media: [] });
  assert.deepEqual(refused, { kind: 'rejected', targetId: 't', code: 'PORT_NOT_CONNECTED' });
  assert.ok(Object.isFrozen(port.UNCONNECTED_MANUAL_PUBLISH_PORT));
});

// ---- send ----------------------------------------------------------------------------------------------------------------

test('send: the target carries the request id as its idempotency key and the text unchanged', async () => {
  const h = harness();
  const outcome = await flow.runSend(h.deps, args());
  assert.deepEqual(outcome, { kind: 'published', targetId: 'req-1', providerPostId: '1234567890' });
  assert.deepEqual(h.calls.send, [{ targetId: 'req-1', provider: 'x', connectedAccountId: 'X_A', renderedText: 'hello', media: [] }]);
});

test('send: the attempt is remembered BEFORE the port is called, and forgotten only by a proven answer', async () => {
  let during = null;
  const h = harness({ send: async (target) => { during = h.memory.get('U1'); return { kind: 'published', targetId: target.targetId, providerPostId: '1' }; } });
  await flow.runSend(h.deps, args());
  assert.deepEqual(during, { accountId: 'X_A', requestId: 'req-1' }, 'marked while in flight');
  assert.equal(h.memory.get('U1'), null, 'published clears it');

  const rejected = harness({ send: async (t) => ({ kind: 'rejected', targetId: t.targetId, code: 'X_REJECTED_403' }) });
  await flow.runSend(rejected.deps, args());
  assert.equal(rejected.memory.get('U1'), null, 'a proven rejection clears it');

  const unknown = harness({ send: async (t) => ({ kind: 'uncertain', targetId: t.targetId, code: 'X_TIMEOUT' }) });
  const outcome = await flow.runSend(unknown.deps, args());
  assert.equal(outcome.kind, 'uncertain');
  assert.deepEqual(unknown.memory.get('U1'), { accountId: 'X_A', requestId: 'req-1' }, 'an unknown outcome stays remembered');
});

test('send: a throwing port is "uncertain" (it may have sent), never "rejected"', async () => {
  for (const send of [async () => { throw new Error('boom'); }, () => Promise.reject(new Error('boom')), () => { throw new Error('sync boom'); }]) {
    const h = harness({ send });
    const outcome = await flow.runSend(h.deps, args());
    assert.deepEqual(outcome, { kind: 'uncertain', targetId: 'req-1', code: 'SEND_THREW' });
    assert.notEqual(h.memory.get('U1'), null, 'still remembered');
  }
});

test('send: an answer that proves nothing is "uncertain" and stays remembered', async () => {
  for (const answer of [null, undefined, 'published', { kind: 'PUBLISHED' }, {}, 42]) {
    const h = harness({ send: async () => answer });
    const outcome = await flow.runSend(h.deps, args());
    assert.deepEqual(outcome, { kind: 'uncertain', targetId: 'req-1', code: 'OUTCOME_INVALID' }, String(answer));
    assert.notEqual(h.memory.get('U1'), null);
  }
  // "published" for another target, or without a post id, is not a proof either.
  for (const answer of [
    { kind: 'published', targetId: 'req-OTHER', providerPostId: '1' },
    { kind: 'published', targetId: 'req-1', providerPostId: '' },
  ]) {
    const h = harness({ send: async () => answer });
    await flow.runSend(h.deps, args());
    assert.notEqual(h.memory.get('U1'), null, JSON.stringify(answer));
  }
});

test('send: a target the provider cannot take is refused before the port is called', async () => {
  const h = harness();
  const outcome = await flow.runSend(h.deps, args({ text: '   ' }));
  assert.deepEqual(outcome, { kind: 'rejected', targetId: 'req-1', code: 'TARGET_NOT_SENDABLE' });
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.memory.get('U1'), null);
});

test('memory: one entry per signed-in user; another user never sees it', () => {
  const memory = flow.createAttemptMemory();
  memory.mark('U1', { accountId: 'X_A', requestId: 'r' });
  assert.deepEqual(memory.get('U1'), { accountId: 'X_A', requestId: 'r' });
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
