// F1 manual X single post, M3: the result marks of the F3 contract (Draft PR #278) -- `simulated` and `afterFreeze`.
//   simulated    false ONLY when the server says the result came from the real X transport; a missing / malformed
//                mark is TRUE: a simulated `sent` is a test result and is never shown as a real post.
//   afterFreeze  true when the result was recorded after the workspace / service stopped being active: a real `sent`
//                is shown as posted with a note; it never turns an unknown result into a success.
// Proven offline with scripted transports and a device storage that can fail; the global network entry points are
// booby-trapped. Nothing is sent to X, and the send port of this build stays unconnected.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as flow from '../src/features/manual-publish/manual-publish-flow.ts';
import * as m from '../src/features/manual-publish/manual-publish-model.ts';
import * as port from '../src/features/manual-publish/manual-publish-port.ts';
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

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RID = '33333333-3333-4333-8333-333333333333';
const POST = '1790000000000000001';
const REAL = { simulated: false, afterFreeze: false };
const TEXT = 'こんにちは、世界';

function fakeKV() {
  const data = new Map();
  return {
    data,
    getItem: async (key) => (data.has(key) ? data.get(key) : null),
    setItem: async (key, value) => { data.set(key, value); },
    removeItem: async (key) => { data.delete(key); },
  };
}
const KEY = store.storeKeyOf('U1');
const READY = (checkedAt = 9_000) => ({ accountId: 'sa_x_1', checkedAt, result: { kind: 'ready' } });
const apply = (state, ...actions) => actions.reduce((s, a) => m.manualPublishReducer(s, a), state);
const sending = () => apply(
  m.createInitialState(),
  { type: 'account_selected', accountId: 'sa_x_1' }, { type: 'draft_changed', text: TEXT }, { type: 'confirm_opened' },
  { type: 'readiness_received', record: READY() }, { type: 'consent_changed', checked: true },
  { type: 'send_started', requestId: ID(1), now: 10_000 },
);
const settle = (state, outcome) => apply(state, { type: 'send_settled', requestId: ID(1), outcome: { targetId: ID(1), ...outcome } });
const gateOf = (state) => m.sendGate({ now: 10_000, signedIn: true, dataStatus: 'ready', account: { id: 'sa_x_1', platform: 'x', connectionStatus: 'connected', profile: {} }, state });

// ---- the mapping: only an explicit `simulated: false` is a real post --------------------------------------------------------

test('resultOf: a published answer is "sent" ONLY with an explicit simulated:false; every other reading is a test result', () => {
  const published = (marks) => ({ kind: 'published', targetId: ID(1), providerPostId: POST, ...(marks === undefined ? {} : { marks }) });
  const sent = m.resultOf(ID(1), published({ simulated: false, afterFreeze: false }));
  assert.deepEqual(sent, { kind: 'sent', requestId: ID(1), providerPostId: POST, marks: REAL });
  for (const [label, marks] of [
    ['no marks at all', undefined],
    ['empty marks', {}],
    ['simulated true', { simulated: true, afterFreeze: false }],
    ['simulated missing', { afterFreeze: false }],
    ['simulated "false" (a string)', { simulated: 'false', afterFreeze: false }],
    ['simulated 0', { simulated: 0, afterFreeze: false }],
    ['simulated null', { simulated: null, afterFreeze: false }],
    ['simulated undefined', { simulated: undefined }],
    ['marks null', null],
    ['marks a string', 'real'],
    ['marks an array', [false]],
  ]) {
    const result = m.resultOf(ID(1), published(marks));
    assert.equal(result.kind, 'simulated', label);
    assert.ok(!('providerPostId' in result), `${label}: a test result shows no post id`);
    assert.equal(result.marks.simulated, true, label);
  }
});

test('resultOf: afterFreeze is true only for an explicit true -- and never changes the kind of an answer', () => {
  const real = (afterFreeze) => m.resultOf(ID(1), { kind: 'published', targetId: ID(1), providerPostId: POST, marks: { simulated: false, afterFreeze } });
  assert.equal(real(true).kind, 'sent');
  assert.equal(real(true).marks.afterFreeze, true);
  for (const value of [false, 'true', 1, null, undefined]) assert.equal(real(value).marks.afterFreeze, false, String(value));
  // afterFreeze on an unknown result never makes it a success; on a simulated one it never makes it real.
  for (const [outcome, kind] of [
    [{ kind: 'pending', code: null }, 'pending'],
    [{ kind: 'uncertain', code: 'X_TIMEOUT' }, 'uncertain'],
    [{ kind: 'rejected', code: 'X_REJECTED_403' }, 'failed'],
  ]) {
    for (const simulated of [true, false]) {
      const result = m.resultOf(ID(1), { targetId: ID(1), ...outcome, marks: { simulated, afterFreeze: true } });
      assert.equal(result.kind, kind, `${kind} simulated=${simulated}`);
      assert.deepEqual(result.marks, { simulated, afterFreeze: true });
    }
  }
  assert.equal(m.resultOf(ID(1), { kind: 'published', targetId: ID(1), providerPostId: POST, marks: { simulated: true, afterFreeze: true } }).kind, 'simulated');
});

test('resultOf: a bad post id is uncertain even when the answer says it is real; marks never rescue a broken answer', () => {
  for (const providerPostId of ['', 'abc', undefined, 5]) {
    const result = m.resultOf(ID(1), { kind: 'published', targetId: ID(1), providerPostId, marks: REAL });
    assert.equal(result.kind, 'uncertain', String(providerPostId));
    assert.equal(result.code, 'OUTCOME_INVALID');
  }
  const other = m.resultOf(ID(1), { kind: 'published', targetId: ID(7), providerPostId: POST, marks: REAL });
  assert.equal(other.kind, 'uncertain');
  assert.equal(other.code, 'OUTCOME_TARGET_MISMATCH');
  assert.equal(m.marksOf({ kind: 'refused', targetId: ID(1), code: 'X', retryable: false }).simulated, true, 'an answer without marks is read cautiously');
});

// ---- the state machine -----------------------------------------------------------------------------------------------------------

test('a simulated published answer stays UNRESOLVED as uncertain: no retry, no other text, only the explicit acknowledgement', () => {
  const state = settle(sending(), { kind: 'published', providerPostId: POST, marks: { simulated: true, afterFreeze: false } });
  assert.equal(state.result.kind, 'simulated');
  assert.equal(state.phase, 'result');
  assert.deepEqual(state.unresolved, { accountId: 'sa_x_1', requestId: ID(1), contentSha256: state.unresolved.contentSha256, text: TEXT, kind: 'uncertain' });
  assert.equal(state.draft, TEXT, 'nothing was posted for real: the text is kept');
  assert.equal(m.surfaceOf({ dataStatus: 'ready', xAccountCount: 1, account: null, state }), 'simulated');
  assert.equal(apply(state, { type: 'retry_requested' }), state, 'a simulated result is never re-asked');
  assert.equal(apply(state, { type: 'result_dismissed' }), state);
  assert.equal(apply(state, { type: 'confirm_opened' }), state);
  assert.equal(gateOf(state).reason, 'unresolved_attempt');
  const unlocked = apply(state, { type: 'unresolved_acknowledged' });
  assert.equal(unlocked.phase, 'editing');
  assert.equal(unlocked.unresolved, null);
});

test('a real published answer clears the draft and stays resolved -- afterFreeze or not; a real answer with afterFreeze is "sent" with the flag', () => {
  for (const afterFreeze of [false, true]) {
    const state = settle(sending(), { kind: 'published', providerPostId: POST, marks: { simulated: false, afterFreeze } });
    assert.equal(state.result.kind, 'sent');
    assert.equal(state.result.marks.afterFreeze, afterFreeze);
    assert.equal(state.unresolved, null);
    assert.equal(state.draft, '');
  }
});

test('afterFreeze never turns pending / uncertain / failed into a success, and keeps their resend rules', () => {
  const pending = settle(sending(), { kind: 'pending', code: null, marks: { simulated: false, afterFreeze: true } });
  assert.equal(pending.result.kind, 'pending');
  assert.equal(pending.unresolved.kind, 'pending');
  assert.equal(apply(pending, { type: 'retry_requested' }).phase, 'confirming', 'pending is still retried with the same id');
  const uncertain = settle(sending(), { kind: 'uncertain', code: 'X_TIMEOUT', marks: { simulated: false, afterFreeze: true } });
  assert.equal(uncertain.result.kind, 'uncertain');
  assert.equal(apply(uncertain, { type: 'retry_requested' }), uncertain, 'uncertain is never resent');
  const failed = settle(sending(), { kind: 'rejected', code: 'X_REJECTED_403', marks: { simulated: false, afterFreeze: true } });
  assert.equal(failed.result.kind, 'failed');
  assert.equal(failed.unresolved, null);
  const unavailable = settle(sending(), { kind: 'unavailable', code: 'NOT_AVAILABLE' });
  assert.equal(unavailable.result.kind, 'unconfirmed');
  assert.equal(apply(unavailable, { type: 'retry_requested' }).phase, 'confirming');
});

test('a restored result carries no marks (the device keeps only the kind), and shows nothing it does not know', () => {
  const restored = m.createInitialState({ accountId: 'sa_x_1', requestId: ID(1), contentSha256: 'a'.repeat(64), text: null, kind: 'uncertain' });
  assert.equal(restored.result.kind, 'uncertain');
  assert.equal(restored.result.marks, null);
  assert.equal(m.createInitialState({ accountId: 'sa_x_1', requestId: ID(1), contentSha256: 'a'.repeat(64), text: null, kind: 'pending' }).result.marks, null);
});

// ---- flow + durable record ---------------------------------------------------------------------------------------------------------

function world(answer) {
  const kv = fakeKV();
  const calls = [];
  const deps = {
    port: { checkReadiness: async () => ({ kind: 'ready' }), send: async (target) => { calls.push(target); return { targetId: target.targetId, ...answer }; } },
    now: () => 5_000,
    newRequestId: () => ID(1),
    memory: flow.createAttemptMemory(),
    store: store.createAttemptStore(kv),
  };
  return { kv, calls, deps };
}
const args = () => ({ userId: 'U1', accountId: 'sa_x_1', text: TEXT, requestId: ID(1), consent: { confirmed: true, contentSha256: '' }, retry: false });
async function runWith(answer) {
  const w = world(answer);
  const { sha256Hex } = await import('../src/features/manual-publish/manual-publish-hash.ts');
  const a = args();
  const outcome = await flow.runSend(w.deps, { ...a, consent: { confirmed: true, contentSha256: sha256Hex(TEXT) } });
  return { ...w, outcome };
}

test('flow: a simulated published answer leaves a durable UNCERTAIN record; a real one removes it (afterFreeze or not)', async () => {
  const simulated = await runWith({ kind: 'published', providerPostId: POST, marks: { simulated: true, afterFreeze: false } });
  assert.equal(JSON.parse(simulated.kv.data.get(KEY)).kind, 'uncertain');
  assert.equal(simulated.deps.memory.get('U1').kind, 'uncertain');
  const unmarked = await runWith({ kind: 'published', providerPostId: POST });
  assert.equal(JSON.parse(unmarked.kv.data.get(KEY)).kind, 'uncertain', 'no marks: the same cautious reading');
  for (const afterFreeze of [false, true]) {
    const real = await runWith({ kind: 'published', providerPostId: POST, marks: { simulated: false, afterFreeze } });
    assert.equal(real.kv.data.size, 0, `real sent (afterFreeze=${afterFreeze}) is a proven end`);
    assert.equal(real.deps.memory.get('U1'), null);
  }
  const frozenUncertain = await runWith({ kind: 'uncertain', code: 'X_TIMEOUT', marks: { simulated: false, afterFreeze: true } });
  assert.equal(JSON.parse(frozenUncertain.kv.data.get(KEY)).kind, 'uncertain');
  const frozenPending = await runWith({ kind: 'pending', code: null, marks: { simulated: false, afterFreeze: true } });
  assert.equal(JSON.parse(frozenPending.kv.data.get(KEY)).kind, 'pending');
});

// ---- the whole cycle through the F3 adapter ---------------------------------------------------------------------------------------

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.SECRET.signature';
const answerOf = (body) => ({ status: 200, body: { ok: true, reservationId: RID, ...body } });

async function cycle(...answers) {
  const calls = [];
  const queue = [...answers];
  const transport = async (call) => { calls.push(call); return queue.length > 1 ? queue.shift() : queue[0]; };
  const kv = fakeKV();
  const deps = {
    port: adapter.createSinglePostPort({ transport, getAccessToken: async () => TOKEN, checkReadiness: async () => ({ kind: 'ready' }) }),
    now: () => 10_000,
    newRequestId: () => ID(1),
    memory: flow.createAttemptMemory(),
    store: store.createAttemptStore(kv),
  };
  let state = m.createInitialState();
  const act = (...actions) => { state = apply(state, ...actions); return state; };
  const send = async () => {
    const retry = state.unresolved !== null;
    const requestId = retry ? state.unresolved.requestId : deps.newRequestId();
    if (act({ type: 'send_started', requestId, now: 10_000 }).phase !== 'sending') return null;
    const outcome = await flow.runSend(deps, { userId: 'U1', accountId: 'sa_x_1', text: m.checkDraft(state.draft).text, requestId, consent: m.consentForSend(state), retry });
    act({ type: 'send_settled', requestId, outcome });
    return outcome;
  };
  return {
    calls, kv, deps,
    get state() { return state; },
    act, send,
    async first() {
      act({ type: 'account_selected', accountId: 'sa_x_1' }, { type: 'draft_changed', text: TEXT }, { type: 'confirm_opened' }, { type: 'readiness_received', record: READY() }, { type: 'consent_changed', checked: true });
      return send();
    },
    async retry() {
      act({ type: 'retry_requested' }, { type: 'readiness_received', record: READY() }, { type: 'consent_changed', checked: true });
      return send();
    },
  };
}

test('adapter cycle: an unmarked F3 sent is a test result -- kept unresolved, never re-sent, never a post', async () => {
  const c = await cycle(answerOf({ status: 'sent', xPostId: POST }));
  await c.first();
  assert.equal(c.state.result.kind, 'simulated');
  assert.equal(c.state.unresolved.kind, 'uncertain');
  assert.equal(await c.retry(), null, 'no retry');
  assert.equal(await c.first(), null, 'and no new send of the same text');
  assert.equal(c.calls.length, 1, 'the transport was called once');
  assert.equal(JSON.parse(c.kv.data.get(KEY)).kind, 'uncertain');
});

test('adapter cycle: simulated:false is a real post; afterFreeze only adds the flag', async () => {
  const c = await cycle(answerOf({ status: 'sent', xPostId: POST, simulated: false, afterFreeze: true }));
  await c.first();
  assert.equal(c.state.result.kind, 'sent');
  assert.equal(c.state.result.providerPostId, POST);
  assert.deepEqual(c.state.result.marks, { simulated: false, afterFreeze: true });
  assert.equal(c.kv.data.size, 0);
});

test('adapter cycle: pending (simulated) is retried with the SAME id until the answer; an unmarked sent then ends as a test result', async () => {
  const c = await cycle(answerOf({ status: 'pending', code: 'IN_PROGRESS', simulated: true }), answerOf({ status: 'sent', xPostId: POST }));
  await c.first();
  assert.equal(c.state.result.kind, 'pending');
  assert.deepEqual(c.state.result.marks, { simulated: true, afterFreeze: false });
  await c.retry();
  assert.equal(c.state.result.kind, 'simulated');
  assert.deepEqual([...new Set(c.calls.map((call) => call.body.clientRequestId))], [ID(1)]);
  assert.deepEqual(c.calls[1].body, c.calls[0].body, 'the same request, byte for byte');
});

test('adapter cycle: afterFreeze uncertain / pending are never successes; uncertain is never resent', async () => {
  const uncertain = await cycle(answerOf({ status: 'uncertain', code: 'X_TIMEOUT', simulated: false, afterFreeze: true }));
  await uncertain.first();
  assert.equal(uncertain.state.result.kind, 'uncertain');
  assert.equal(await uncertain.retry(), null);
  assert.equal(uncertain.calls.length, 1);
  const pending = await cycle(answerOf({ status: 'pending', simulated: false, afterFreeze: true }));
  await pending.first();
  assert.equal(pending.state.result.kind, 'pending');
  const failed = await cycle(answerOf({ status: 'failed', code: 'X_REJECTED_403', simulated: false, afterFreeze: true }));
  await failed.first();
  assert.equal(failed.state.result.kind, 'failed');
  assert.equal(failed.state.unresolved, null);
});

test('restart after a simulated answer: it comes back as uncertain, with no retry; acknowledging removes the record first', async () => {
  const c = await cycle(answerOf({ status: 'sent', xPostId: POST }));
  await c.first();
  const memory = flow.createAttemptMemory();
  const deps = { ...c.deps, memory };
  const read = await flow.loadPersistedAttempt(deps, 'U1');
  assert.equal(read.kind, 'found');
  let state = m.createInitialState(null, { kind: 'loading' });
  state = m.manualPublishReducer(state, { type: 'store_loaded', unresolved: flow.restoredAttemptOf(read.attempt) });
  assert.equal(state.result.kind, 'uncertain');
  assert.equal(state.result.marks, null);
  assert.equal(m.manualPublishReducer(state, { type: 'retry_requested' }), state);
  assert.equal(await flow.runAcknowledge(deps, 'U1'), true);
  assert.equal(c.kv.data.size, 0);
});

test('this build: the port is still the unconnected one; nothing reached a network', () => {
  assert.equal(port.getManualPublishPort(), port.UNCONNECTED_MANUAL_PUBLISH_PORT);
  assert.equal(trapped, 0);
});
