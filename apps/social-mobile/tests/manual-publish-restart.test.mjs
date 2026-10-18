// F1 manual X single post, M2: what happens when the app restarts while an attempt is unresolved.
// The process-local memory is gone after a restart; only a hash-only record on the device is left. These tests
// prove (offline, with a device storage that can fail in every way and a scripted F3 transport) that:
//  - the record holds no text / token / consent and is only trusted when it is exactly what was written;
//  - a send is never started unless its record was written AND read back (a failed write => nothing is sent);
//  - after a restart nothing can be sent while the record is being read or cannot be read;
//  - a restored attempt can only be re-asked with the SAME id, the SAME account and the SAME text (by hash);
//  - uncertain is never resent, another user / account / text / id never inherits an attempt;
//  - local storage proves neither "posted" nor "not posted": it only blocks.
// No network, no secret, no X post: the global network entry points are booby-trapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as flow from '../src/features/manual-publish/manual-publish-flow.ts';
import * as m from '../src/features/manual-publish/manual-publish-model.ts';
import * as adapter from '../src/features/manual-publish/single-post-port.ts';
import * as store from '../src/features/manual-publish/manual-publish-store.ts';

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

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REAL = { simulated: false, afterFreeze: false };
const RESERVATION = '33333333-3333-4333-8333-333333333333';
const TEXT = 'こんにちは、世界';

/** A device storage that can fail in every way: a thrown read / write / remove, or a write that silently stores nothing. */
function fakeKV() {
  const data = new Map();
  const fail = { get: false, set: false, remove: false, drop: false };
  const log = { sets: 0, removes: 0 };
  return {
    data,
    fail,
    log,
    getItem: async (key) => { if (fail.get) throw new Error('read failed'); return data.has(key) ? data.get(key) : null; },
    setItem: async (key, value) => { log.sets += 1; if (fail.set) throw new Error('write failed'); if (!fail.drop) data.set(key, value); },
    removeItem: async (key) => { log.removes += 1; if (fail.remove) throw new Error('remove failed'); data.delete(key); },
  };
}
const KEY = (userId = 'U1') => store.storeKeyOf(userId);
const RECORD = (over = {}) => ({ accountId: 'sa_x_1', requestId: ID(1), contentSha256: sha(TEXT), kind: 'pending', savedAt: 1_000, ...over });
const stored = (over = {}) => JSON.stringify({ v: 1, ...RECORD(over) });

// ---- the record ---------------------------------------------------------------------------------------------------------------

test('record: it round-trips and holds exactly id, account, hash, kind and time -- no text, no token, no consent', async () => {
  const kv = fakeKV();
  const s = store.createAttemptStore(kv);
  assert.equal(await s.write('U1', RECORD()), true);
  assert.deepEqual(JSON.parse(kv.data.get(KEY())), { v: 1, accountId: 'sa_x_1', requestId: ID(1), contentSha256: sha(TEXT), kind: 'pending', savedAt: 1_000 });
  assert.ok(!kv.data.get(KEY()).includes('こんにちは'), 'the post text is not on the device');
  assert.deepEqual(await s.read('U1'), { kind: 'found', attempt: RECORD() });
  // Extra fields handed to write() are not stored (an explicit whitelist).
  assert.equal(await s.write('U1', { ...RECORD(), text: TEXT, accessToken: 'SECRET', consent: { confirmed: true } }), true);
  const raw = kv.data.get(KEY());
  assert.ok(!raw.includes('こんにちは') && !raw.includes('SECRET') && !raw.includes('consent'), raw);
});

test('record: one per signed-in user -- another user never sees it, and it has no expiry', async () => {
  const kv = fakeKV();
  const s = store.createAttemptStore(kv);
  await s.write('U1', RECORD({ savedAt: 1 }));
  assert.deepEqual(await s.read('U2'), { kind: 'none' });
  assert.equal((await s.read('U1')).attempt.savedAt, 1, 'an ancient record is read like a new one');
  assert.notEqual(KEY('U1'), KEY('U2'));
  assert.equal(await s.clear('U2'), true);
  assert.equal((await s.read('U1')).kind, 'found', "clearing another user's record does not touch this one");
});

test('record: a write counts only when it reads back identical -- a throw, a silent drop or an unreadable read-back is a failure', async () => {
  for (const mode of ['set', 'drop', 'get']) {
    const kv = fakeKV();
    kv.fail[mode] = true;
    assert.equal(await store.createAttemptStore(kv).write('U1', RECORD()), false, mode);
  }
  const kv = fakeKV();
  kv.getItem = async (key) => (kv.data.has(key) ? kv.data.get(key).replace('"pending"', '"uncertain"') : null);
  assert.equal(await store.createAttemptStore(kv).write('U1', RECORD()), false, 'a record that reads back different is not written');
});

test('record: a clear counts only when the record is really gone', async () => {
  for (const mode of ['remove', 'get']) {
    const kv = fakeKV();
    await store.createAttemptStore(kv).write('U1', RECORD());
    kv.fail[mode] = true;
    assert.equal(await store.createAttemptStore(kv).clear('U1'), false, mode);
  }
  const kv = fakeKV();
  await store.createAttemptStore(kv).write('U1', RECORD());
  kv.removeItem = async () => {}; // "removed" but still there
  assert.equal(await store.createAttemptStore(kv).clear('U1'), false);
});

test('record: anything that is not exactly what was written is unreadable, never "nothing" and never trusted', async () => {
  const cases = [
    ['not json', '{oops', 'corrupt'],
    ['null', 'null', 'corrupt'],
    ['array', '[]', 'corrupt'],
    ['string', '"x"', 'corrupt'],
    ['empty object', '{}', 'corrupt'],
    ['missing field', JSON.stringify({ v: 1, accountId: 'sa_x_1', requestId: ID(1), contentSha256: sha(TEXT), kind: 'pending' }), 'corrupt'],
    ['extra field (a text)', JSON.stringify({ v: 1, ...RECORD(), text: TEXT }), 'corrupt'],
    ['bad request id', stored({ requestId: 'req-1' }), 'corrupt'],
    ['uppercase request id', stored({ requestId: ID(1).toUpperCase().replace(/0/gu, 'A') }), 'corrupt'],
    ['bad hash', stored({ contentSha256: 'abc' }), 'corrupt'],
    ['uppercase hash', stored({ contentSha256: sha(TEXT).toUpperCase() }), 'corrupt'],
    ['bad kind', stored({ kind: 'sent' }), 'corrupt'],
    ['kind sent is never stored', stored({ kind: 'failed' }), 'corrupt'],
    ['bad account', stored({ accountId: 'a b' }), 'corrupt'],
    ['bad time', stored({ savedAt: 'now' }), 'corrupt'],
    ['infinite time', '{"v":1,"accountId":"sa_x_1","requestId":"' + ID(1) + '","contentSha256":"' + sha(TEXT) + '","kind":"pending","savedAt":1e999}', 'corrupt'],
    ['newer version', JSON.stringify({ ...RECORD(), v: 2 }), 'version'],
    ['older version', JSON.stringify({ ...RECORD(), v: 0 }), 'version'],
    ['version as text', JSON.stringify({ ...RECORD(), v: '1' }), 'corrupt'],
  ];
  for (const [label, raw, reason] of cases) {
    const kv = fakeKV();
    kv.data.set(KEY(), raw);
    assert.deepEqual(await store.createAttemptStore(kv).read('U1'), { kind: 'unreadable', reason }, label);
  }
  const kv = fakeKV();
  kv.fail.get = true;
  assert.deepEqual(await store.createAttemptStore(kv).read('U1'), { kind: 'unreadable', reason: 'io' });
  kv.fail.get = false;
  kv.getItem = async () => 42;
  assert.deepEqual(await store.createAttemptStore(kv).read('U1'), { kind: 'unreadable', reason: 'corrupt' }, 'a non-string value');
});

test('record: a user id that cannot be a key is never read, written or cleared', async () => {
  const s = store.createAttemptStore(fakeKV());
  for (const userId of ['', 'a/b', 'x'.repeat(65), 'u 1']) {
    assert.equal((await s.read(userId)).kind, 'unreadable', userId);
    assert.equal(await s.write(userId, RECORD()), false, userId);
    assert.equal(await s.clear(userId), false, userId);
  }
});

// ---- the send writes the record first ------------------------------------------------------------------------------------------

function world({ kv = fakeKV(), send, clock = { t: 5_000 } } = {}) {
  const calls = { send: [] };
  const memory = flow.createAttemptMemory();
  const deps = {
    port: {
      checkReadiness: async () => ({ kind: 'ready' }),
      send: send ?? (async (target) => { calls.send.push(target); return { kind: 'published', marks: REAL, targetId: target.targetId, providerPostId: '123' }; }),
    },
    now: () => clock.t,
    newRequestId: () => ID(1),
    memory,
    store: store.createAttemptStore(kv),
  };
  return { kv, calls, memory, deps, clock };
}
const sendArgs = (over = {}) => ({ userId: 'U1', accountId: 'sa_x_1', text: TEXT, requestId: ID(1), consent: { confirmed: true, contentSha256: sha(TEXT) }, retry: false, ...over });

test('send: the record is on the device BEFORE the port is called, with the hash and no text', async () => {
  let during = null;
  const w = world();
  const original = w.deps.port.send;
  w.deps.port.send = async (target) => { during = w.kv.data.get(KEY()); return original(target); };
  await flow.runSend(w.deps, sendArgs());
  assert.deepEqual(JSON.parse(during), { v: 1, accountId: 'sa_x_1', requestId: ID(1), contentSha256: sha(TEXT), kind: 'in_flight', savedAt: 5_000 });
  assert.ok(!during.includes('こんにちは'));
  assert.equal(w.kv.data.has(KEY()), false, 'a proven end (published) removes the record');
});

test('send: every unresolved answer leaves a durable record of its kind; every proven end removes it', async () => {
  for (const [answer, kind] of [
    [{ kind: 'pending', code: 'IN_PROGRESS' }, 'pending'],
    [{ kind: 'unavailable', code: 'TRANSPORT_FAILED' }, 'unconfirmed'],
    [{ kind: 'uncertain', code: 'X_TIMEOUT' }, 'uncertain'],
  ]) {
    const w = world({ send: async (t) => ({ targetId: t.targetId, ...answer }) });
    await flow.runSend(w.deps, sendArgs());
    assert.equal(JSON.parse(w.kv.data.get(KEY())).kind, kind, answer.kind);
  }
  for (const throws of [async () => { throw new Error('boom'); }, async () => null, async () => ({ kind: 'sent' })]) {
    const w = world({ send: throws });
    await flow.runSend(w.deps, sendArgs());
    assert.equal(JSON.parse(w.kv.data.get(KEY())).kind, 'uncertain', 'a throw or nonsense may have posted');
  }
  for (const answer of [{ kind: 'rejected', code: 'X_REJECTED_403' }, { kind: 'refused', code: 'X', retryable: false }, { kind: 'published', marks: REAL, providerPostId: '9' }]) {
    const w = world({ send: async (t) => ({ targetId: t.targetId, ...answer }) });
    await flow.runSend(w.deps, sendArgs());
    assert.equal(w.kv.data.size, 0, answer.kind);
  }
});

test('send: a record that cannot be written and read back means NOTHING is sent (fresh attempt: a plain refusal)', async () => {
  for (const mode of ['set', 'drop', 'get']) {
    const w = world();
    w.kv.fail[mode] = true;
    const outcome = await flow.runSend(w.deps, sendArgs());
    assert.deepEqual(outcome, { kind: 'refused', targetId: ID(1), code: 'LOCAL_STORE_UNAVAILABLE', retryable: false }, mode);
    assert.equal(w.calls.send.length, 0, `${mode}: the port was never called`);
    assert.equal(w.memory.get('U1'), null, `${mode}: nothing was started, nothing is remembered`);
    assert.equal(w.kv.data.size, 0, `${mode}: no half-written record is left behind`);
  }
});

test('send: the same failure on a RETRY keeps the attempt unresolved -- never "refused", and the old record stays', async () => {
  for (const mode of ['set', 'drop', 'get']) {
    const w = world();
    w.kv.data.set(KEY(), stored({ kind: 'pending' }));
    w.kv.fail[mode] = true;
    const outcome = await flow.runSend(w.deps, sendArgs({ retry: true }));
    assert.deepEqual(outcome, { kind: 'unavailable', targetId: ID(1), code: 'LOCAL_STORE_UNAVAILABLE' }, mode);
    assert.equal(w.calls.send.length, 0, mode);
    assert.equal(w.memory.get('U1').kind, 'unconfirmed', mode);
    // A write that landed but could not be read back may have replaced the record with `in_flight` of the SAME
    // attempt, which blocks exactly as `pending` does; a write that failed or was dropped leaves it untouched.
    const kept = JSON.parse(w.kv.data.get(KEY()));
    assert.equal(kept.requestId, ID(1), `${mode}: the record of this attempt is still there`);
    assert.ok(['pending', 'in_flight'].includes(kept.kind), mode);
    if (mode !== 'get') assert.equal(w.kv.data.get(KEY()), stored({ kind: 'pending' }), `${mode}: the earlier record is untouched`);
  }
});

test('send: if updating the record after the answer fails, the earlier in_flight record stays -- still blocked after a restart', async () => {
  const w = world({ send: async (t) => { w.kv.fail.set = true; return { kind: 'uncertain', targetId: t.targetId, code: 'X_TIMEOUT' }; } });
  const outcome = await flow.runSend(w.deps, sendArgs());
  assert.equal(outcome.kind, 'uncertain');
  assert.equal(JSON.parse(w.kv.data.get(KEY())).kind, 'in_flight');
  assert.equal(w.memory.get('U1').kind, 'uncertain', 'this process still knows it is uncertain');
  const restarted = await flow.loadPersistedAttempt({ ...w.deps, memory: flow.createAttemptMemory() }, 'U1');
  assert.equal(restarted.kind, 'found');
  assert.equal(m.createInitialState(flow.restoredAttemptOf(restarted.attempt)).unresolved.kind, 'unconfirmed');
});

test('send: if removing the record after a proven end fails, the record stays and a restart shows it as unconfirmed (never the reverse)', async () => {
  const w = world({ send: async (t) => { w.kv.fail.remove = true; return { kind: 'published', marks: REAL, targetId: t.targetId, providerPostId: '9' }; } });
  await flow.runSend(w.deps, sendArgs());
  assert.equal(w.memory.get('U1'), null);
  assert.equal(JSON.parse(w.kv.data.get(KEY())).kind, 'in_flight');
});

// ---- reading and acknowledging ---------------------------------------------------------------------------------------------------

test('load: a found record is restored WITHOUT text and also put in the process memory; a throwing store is unreadable', async () => {
  const w = world();
  w.kv.data.set(KEY(), stored({ kind: 'uncertain' }));
  const read = await flow.loadPersistedAttempt(w.deps, 'U1');
  assert.equal(read.kind, 'found');
  assert.deepEqual(w.memory.get('U1'), { accountId: 'sa_x_1', requestId: ID(1), contentSha256: sha(TEXT), text: null, kind: 'uncertain' });
  assert.equal(w.calls.send.length, 0, 'reading never sends');
  assert.deepEqual(await flow.loadPersistedAttempt({ ...w.deps, store: { read: async () => { throw new Error('boom'); } } }, 'U1'), { kind: 'unreadable', reason: 'io' });
  const empty = world();
  assert.deepEqual(await flow.loadPersistedAttempt(empty.deps, 'U1'), { kind: 'none' });
  assert.equal(empty.memory.get('U1'), null);
});

test('acknowledge: the record is removed first; if it cannot be removed nothing is unlocked and the memory keeps blocking', async () => {
  const w = world();
  w.kv.data.set(KEY(), stored());
  w.memory.mark('U1', flow.restoredAttemptOf(RECORD()));
  w.kv.fail.remove = true;
  assert.equal(await flow.runAcknowledge(w.deps, 'U1'), false);
  assert.notEqual(w.memory.get('U1'), null);
  assert.equal(w.kv.data.has(KEY()), true);
  assert.equal(await flow.runAcknowledge({ ...w.deps, store: { clear: async () => { throw new Error('boom'); } } }, 'U1'), false);
  w.kv.fail.remove = false;
  assert.equal(await flow.runAcknowledge(w.deps, 'U1'), true);
  assert.equal(w.memory.get('U1'), null);
  assert.equal(w.kv.data.has(KEY()), false);
});

// ---- the whole cycle across a restart (reducer + flow + F3 adapter + device record) -------------------------------------------------

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.SECRET.signature';
const ANSWER = {
  sent: { status: 200, body: { ok: true, status: 'sent', reservationId: RESERVATION, xPostId: '1790000000000000001', simulated: false } },
  pending: { status: 200, body: { ok: true, status: 'pending', reservationId: RESERVATION, code: 'IN_PROGRESS', simulated: false } },
  uncertain: { status: 200, body: { ok: true, status: 'uncertain', reservationId: RESERVATION, code: 'X_TIMEOUT', simulated: false } },
  lost: new Error('connection lost'),
};
const ACCOUNT = (id = 'sa_x_1', over = {}) => ({ id, brandId: 'A', platform: 'x', profile: { displayName: id, handle: `@${id}`, avatarColor: '#000000' }, connectionStatus: 'connected', postingState: 'active', ...over });
const READY = (accountId = 'sa_x_1', checkedAt = 9_000) => ({ accountId, checkedAt, result: { kind: 'ready' } });
const apply = (state, ...actions) => actions.reduce((s, a) => m.manualPublishReducer(s, a), state);
const gateOf = (state, over = {}) => m.sendGate({ now: 10_000, signedIn: true, dataStatus: 'ready', account: ACCOUNT(), state, ...over });

/** The scripted F3 transport; answers are consumed in order and the last one repeats. */
function transportOf(...answers) {
  const calls = [];
  const queue = [...answers];
  return {
    calls,
    transport: async (call) => {
      calls.push(call);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** One app process: a fresh memory, the SAME device storage, and the reducer driven the way the screen drives it. */
async function boot(kv, t, { userId = 'U1', ids = [ID(1)] } = {}) {
  const memory = flow.createAttemptMemory();
  let n = 0;
  const deps = {
    port: adapter.createSinglePostPort({ transport: t.transport, getAccessToken: async () => TOKEN, checkReadiness: async () => ({ kind: 'ready' }) }),
    now: () => 10_000,
    newRequestId: () => ids[Math.min(n++, ids.length - 1)],
    memory,
    store: store.createAttemptStore(kv),
  };
  let state = m.createInitialState(null, { kind: 'loading' });
  const read = await flow.loadPersistedAttempt(deps, userId);
  state = m.manualPublishReducer(
    state,
    read.kind === 'none' ? { type: 'store_loaded', unresolved: null }
      : read.kind === 'found' ? { type: 'store_loaded', unresolved: flow.restoredAttemptOf(read.attempt) }
        : { type: 'store_unreadable', reason: read.reason },
  );
  const api = {
    deps, memory, userId,
    get state() { return state; },
    act: (...actions) => { state = apply(state, ...actions); return state; },
    /** compose + confirm + consent + send (like the screen); returns null when the reducer refuses the start. */
    async sendFresh(text = TEXT, accountId = 'sa_x_1') {
      api.act({ type: 'account_selected', accountId }, { type: 'draft_changed', text }, { type: 'confirm_opened' }, { type: 'readiness_received', record: READY(accountId) }, { type: 'consent_changed', checked: true });
      return api.send();
    },
    async send() {
      const retry = state.unresolved !== null;
      const requestId = retry ? state.unresolved.requestId : deps.newRequestId();
      const started = api.act({ type: 'send_started', requestId, now: 10_000 });
      if (started.phase !== 'sending') return null;
      const draft = m.checkDraft(state.draft);
      const outcome = await flow.runSend(deps, { userId, accountId: state.accountId, text: draft.text, requestId, consent: m.consentForSend(state), retry });
      api.act({ type: 'send_settled', requestId, outcome });
      return { requestId, outcome };
    },
    /** After a restart: ask again by re-entering `text`. */
    reenter(text, accountId = 'sa_x_1') {
      return api.act({ type: 'retry_requested' }, { type: 'draft_changed', text }, { type: 'readiness_received', record: READY(accountId) }, { type: 'consent_changed', checked: true });
    },
  };
  return api;
}

test('restart after a LOST ANSWER: nothing can be sent, and the text re-entered later is re-asked with the SAME id and the SAME request', async () => {
  const kv = fakeKV();
  const t = transportOf(ANSWER.lost, ANSWER.sent);
  const first = await boot(kv, t);
  const sent = await first.sendFresh();
  assert.equal(sent.outcome.kind, 'unavailable');
  assert.equal(first.state.unresolved.kind, 'unconfirmed');
  assert.equal(t.calls.length, 1);

  const second = await boot(kv, t, { ids: [ID(2), ID(3)] }); // the app was restarted: new memory, same device
  assert.equal(second.state.phase, 'result');
  assert.equal(second.state.result.kind, 'unconfirmed');
  assert.equal(second.state.result.code, m.UNRESOLVED_AFTER_RESTART);
  assert.equal(second.state.unresolved.text, null, 'the text is not on the device');
  assert.equal(second.state.draft, '');
  assert.equal(second.state.unresolved.requestId, ID(1));
  assert.equal(gateOf(second.state).allowed, false);
  assert.equal(gateOf(second.state).reason, 'unresolved_attempt');
  assert.equal(await second.send(), null, 'nothing is sent from the restored result');
  assert.equal(t.calls.length, 1);

  second.act({ type: 'retry_requested' });
  assert.equal(gateOf(second.state).reason, 'restored_text_mismatch', 'waiting for the same text');
  assert.equal(await second.send(), null);
  second.reenter('  ' + TEXT + '\r\n'); // padding / line ending are normalised like in any send
  assert.deepEqual(gateOf(second.state), { allowed: true });
  const retried = await second.send();
  assert.equal(retried.requestId, ID(1), 'the SAME attempt id, not a new one');
  assert.equal(second.state.result.kind, 'sent');
  assert.equal(t.calls.length, 2);
  assert.deepEqual(t.calls[1].body, t.calls[0].body, 'the same request, byte for byte');
  assert.equal(kv.data.size, 0, 'a proven end removes the record');
});

test('restart while pending: the same cycle; the server decides, the screen never calls it posted', async () => {
  const kv = fakeKV();
  const t = transportOf(ANSWER.pending, ANSWER.pending, ANSWER.sent);
  const first = await boot(kv, t);
  await first.sendFresh();
  assert.equal(first.state.result.kind, 'pending');
  const second = await boot(kv, t);
  assert.equal(second.state.result.kind, 'pending');
  assert.equal(second.state.result.code, m.UNRESOLVED_AFTER_RESTART);
  second.reenter(TEXT);
  await second.send();
  assert.equal(second.state.result.kind, 'pending', 'still pending: not sent, not uncertain');
  assert.equal(JSON.parse(kv.data.get(KEY())).kind, 'pending');
  const third = await boot(kv, t); // another restart in between
  third.reenter(TEXT);
  await third.send();
  assert.equal(third.state.result.kind, 'sent');
  assert.deepEqual([...new Set(t.calls.map((c) => c.body.clientRequestId))], [ID(1)], 'one id for the whole life of the attempt');
});

test('restart after uncertain: it is NEVER resent -- no retry, no new send, no typing; only the explicit acknowledgement unlocks', async () => {
  const kv = fakeKV();
  const t = transportOf(ANSWER.uncertain, ANSWER.sent);
  const first = await boot(kv, t);
  await first.sendFresh();
  const second = await boot(kv, t);
  assert.equal(second.state.result.kind, 'uncertain');
  const before = second.state;
  assert.equal(second.act({ type: 'retry_requested' }), before, 'no retry for uncertain');
  assert.equal(second.act({ type: 'draft_changed', text: TEXT }), before);
  assert.equal(await second.send(), null);
  assert.equal(await second.sendFresh(TEXT), null, 'not even a brand new send of the same text');
  assert.equal(t.calls.length, 1);
  assert.equal(await flow.runAcknowledge(second.deps, 'U1'), true);
  second.act({ type: 'unresolved_acknowledged' });
  assert.equal(second.state.phase, 'editing');
  const third = await boot(kv, t, { ids: [ID(7)] });
  assert.equal(third.state.unresolved, null, 'acknowledged: the next launch starts clean');
  assert.equal((await third.sendFresh(TEXT)).requestId, ID(7), 'only now a NEW attempt, with a NEW id');
});

test('restart while a send was in flight (the process died): shown as unconfirmed, retryable only with the same id', async () => {
  const kv = fakeKV();
  await store.createAttemptStore(kv).write('U1', RECORD({ kind: 'in_flight' }));
  const t = transportOf(ANSWER.sent);
  const app = await boot(kv, t);
  assert.equal(app.state.result.kind, 'unconfirmed');
  assert.equal(app.state.unresolved.kind, 'unconfirmed');
  assert.equal(await app.sendFresh('something else'), null);
  app.reenter(TEXT);
  assert.equal((await app.send()).requestId, ID(1));
});

test('restored attempt: a different text, a swapped text after consent, or a made-up id is never accepted', async () => {
  const kv = fakeKV();
  await store.createAttemptStore(kv).write('U1', RECORD());
  const app = await boot(kv, transportOf(ANSWER.sent), { ids: [ID(5)] });
  app.reenter(TEXT + '!');
  assert.equal(gateOf(app.state).reason, 'restored_text_mismatch');
  assert.equal(await app.send(), null, 'a different text is a different post');
  app.reenter(TEXT);
  assert.deepEqual(gateOf(app.state), { allowed: true });
  app.act({ type: 'draft_changed', text: 'a swapped text' });
  assert.equal(app.state.consent, null, 'the consent belonged to the old text');
  assert.equal(gateOf(app.state).reason, 'restored_text_mismatch');
  assert.equal(await app.send(), null);
  app.act({ type: 'draft_changed', text: TEXT }, { type: 'consent_changed', checked: true }, { type: 'readiness_received', record: READY() });
  assert.equal(app.act({ type: 'send_started', requestId: ID(5), now: 10_000 }).phase, 'confirming', 'a new/made-up id is refused');
  assert.equal(app.act({ type: 'send_started', requestId: ID(1), now: 10_000 }).phase, 'sending', 'only the stored id starts');
});

test('restored attempt: another X account, or an account that is gone, can never re-ask it', async () => {
  const kv = fakeKV();
  await store.createAttemptStore(kv).write('U1', RECORD());
  const app = await boot(kv, transportOf(ANSWER.sent));
  app.reenter(TEXT);
  assert.equal(gateOf(app.state, { account: ACCOUNT('sa_x_2') }).reason, 'no_account', 'another account');
  assert.equal(gateOf(app.state, { account: null }).reason, 'no_account', 'the account vanished');
  assert.equal(app.act({ type: 'accounts_changed', accountIds: [] }).accountId, 'sa_x_1', 'the attempt stays bound to its account');
  assert.equal(app.act({ type: 'account_selected', accountId: 'sa_x_2' }).accountId, 'sa_x_1', 'and cannot be re-pointed');
  assert.equal(app.state.unresolved.accountId, 'sa_x_1');
});

test('another user, a sign-out and a new sign-in: the record belongs to the person who made the attempt', async () => {
  const kv = fakeKV();
  await store.createAttemptStore(kv).write('U1', RECORD());
  const other = await boot(kv, transportOf(ANSWER.sent), { userId: 'U2' });
  assert.equal(other.state.unresolved, null, 'U2 does not inherit it');
  assert.equal(other.state.store.kind, 'ready');
  assert.equal((await other.sendFresh('hello')).outcome.kind, 'published', 'and is not blocked by it');
  assert.equal(JSON.parse(kv.data.get(KEY('U1'))).kind, 'pending', "U2's send did not touch U1's record");
  const again = await boot(kv, transportOf(ANSWER.sent), { userId: 'U1' });
  assert.equal(again.state.unresolved.requestId, ID(1), 'U1 signing in again meets it again');
  assert.equal(gateOf(again.state, { signedIn: false }).reason, 'not_signed_in');
});

test('a stale or foreign record never unlocks anything: no expiry, and its own id stays the only id', async () => {
  const kv = fakeKV();
  await store.createAttemptStore(kv).write('U1', RECORD({ savedAt: 1, kind: 'uncertain' }));
  const app = await boot(kv, transportOf(ANSWER.sent));
  assert.equal(app.state.result.kind, 'uncertain', 'years old, still blocking');
  assert.equal(gateOf(app.state, { account: ACCOUNT('sa_x_2') }).allowed, false);
});

// ---- the record cannot be read ----------------------------------------------------------------------------------------------------

test('while the record is being read, and when it cannot be read, nothing can be typed, selected, confirmed or sent', async () => {
  const kv = fakeKV();
  kv.fail.get = true;
  const t = transportOf(ANSWER.sent);
  const app = await boot(kv, t);
  assert.deepEqual(app.state.store, { kind: 'unreadable', reason: 'io' });
  assert.equal(gateOf(app.state).reason, 'store_unreadable');
  const frozen = app.state;
  assert.equal(app.act({ type: 'account_selected', accountId: 'sa_x_1' }), frozen);
  assert.equal(app.act({ type: 'draft_changed', text: 'hi' }), frozen);
  assert.equal(app.act({ type: 'confirm_opened' }), frozen);
  assert.equal(m.surfaceOf({ dataStatus: 'ready', xAccountCount: 1, account: ACCOUNT(), state: frozen }), 'record_unchecked');
  assert.equal(await app.sendFresh(), null);
  assert.equal(t.calls.length, 0);

  const loading = m.createInitialState(null, { kind: 'loading' });
  assert.equal(gateOf(loading).reason, 'store_loading');
  assert.equal(apply(loading, { type: 'account_selected', accountId: 'sa_x_1' }), loading);
  assert.equal(apply(loading, { type: 'draft_changed', text: 'hi' }), loading);
  assert.equal(m.surfaceOf({ dataStatus: 'ready', xAccountCount: 1, account: ACCOUNT(), state: loading }), 'record_unchecked');
  const composed = apply(m.createInitialState(), { type: 'account_selected', accountId: 'sa_x_1' }, { type: 'draft_changed', text: 'hi' });
  for (const unknown of [{ kind: 'loading' }, { kind: 'unreadable', reason: 'io' }]) {
    const blocked = { ...composed, store: unknown };
    assert.equal(apply(blocked, { type: 'confirm_opened' }), blocked, `no confirmation while the record is ${unknown.kind}`);
  }
  // Even if every other part of a send were in place, a state whose record is unknown never starts one.
  const forced = { ...apply(m.createInitialState(), { type: 'account_selected', accountId: 'sa_x_1' }, { type: 'draft_changed', text: 'hi' }, { type: 'confirm_opened' }, { type: 'readiness_received', record: READY() }, { type: 'consent_changed', checked: true }), store: { kind: 'loading' } };
  assert.equal(m.manualPublishReducer(forced, { type: 'send_started', requestId: ID(1), now: 10_000 }).phase, 'confirming');
});

test('an I/O failure can only be read again; a corrupt or newer-version record needs the explicit acknowledgement, which clears it first', async () => {
  const kv = fakeKV();
  kv.fail.get = true;
  const t = transportOf(ANSWER.sent);
  const app = await boot(kv, t);
  assert.equal(app.act({ type: 'store_unreadable_acknowledged' }), app.state, 'io is never acknowledged away');
  const frozen = app.state;
  assert.equal(app.act({ type: 'store_reload_requested' }).store.kind, 'loading');
  kv.fail.get = false;
  assert.equal(app.act({ type: 'store_loaded', unresolved: null }).store.kind, 'ready');
  assert.notEqual(app.state, frozen);

  for (const [raw, reason] of [['{broken', 'corrupt'], [JSON.stringify({ ...RECORD(), v: 9 }), 'version']]) {
    const bad = fakeKV();
    bad.data.set(KEY(), raw);
    const x = await boot(bad, transportOf(ANSWER.sent));
    assert.deepEqual(x.state.store, { kind: 'unreadable', reason });
    assert.equal(await x.sendFresh(), null, `${reason}: blocked`);
    bad.fail.remove = true;
    assert.equal(await flow.runAcknowledge(x.deps, 'U1'), false, 'a record that cannot be cleared keeps blocking');
    assert.equal(x.state.store.kind, 'unreadable');
    bad.fail.remove = false;
    assert.equal(await flow.runAcknowledge(x.deps, 'U1'), true);
    assert.equal(x.act({ type: 'store_unreadable_acknowledged' }).store.kind, 'ready');
    assert.equal((await x.sendFresh()).outcome.kind, 'published', `${reason}: after the acknowledgement a NEW attempt may start`);
  }
});

test('the reducer ignores store answers it did not ask for', () => {
  const ready = m.createInitialState();
  assert.equal(apply(ready, { type: 'store_loaded', unresolved: flow.restoredAttemptOf(RECORD()) }), ready, 'a late answer cannot overwrite a live state');
  assert.equal(apply(ready, { type: 'store_unreadable', reason: 'io' }), ready);
  assert.equal(apply(ready, { type: 'store_reload_requested' }), ready);
  assert.equal(apply(ready, { type: 'store_unreadable_acknowledged' }), ready);
  const loading = m.createInitialState(null, { kind: 'loading' });
  assert.equal(apply(loading, { type: 'store_unreadable_acknowledged' }), loading);
  assert.equal(apply(loading, { type: 'store_reload_requested' }), loading);
  const restored = apply(loading, { type: 'store_loaded', unresolved: flow.restoredAttemptOf(RECORD({ kind: 'in_flight' })) });
  assert.equal(restored.unresolved.kind, 'unconfirmed');
  assert.equal(restored.store.kind, 'ready');
  assert.equal(restored.phase, 'result');
});

test('no network entry point was touched by any step', () => {
  assert.equal(trapped, 0);
});
