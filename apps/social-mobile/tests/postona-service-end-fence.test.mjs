// F4 (postona-f4-pr217-concurrent-preview-identity-fence-p2-20261016): J4 V4 P2 on PR217's POSTONA service-end
// client. A public preview() running on the SAME client instance while person A's end() is in flight may positively
// observe another person (B) or nobody. That observation must reach A's end: no later stale read of A (or a read that
// throws) may bring back A's completion, X unconfirmed count or Threads remote-authorization line. A read that throws is
// unknown, never a logout; A seen on another session keeps A's warnings without a completion; a read begun inside one
// end never affects a later end. The J4 orderings FAIL on PR217 d4bcd09e. Synthetic transport and sessions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as endDomain from '../src/domain/postona-service-end.ts';
import * as notices from '../src/domain/postona-end-notices.ts';
import { createPostonaEndClient } from '../src/lib/postona-service-end-client.ts';

const { POSTONA_END_CONFIRM_PHRASE, POSTONA_END_SOURCE_ENABLED } = endDomain;
const previewBody = (status = 'active') => ({ ok: true, account_status: 'active', lifecycle_version: 7,
  services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status }], blockers: [], deletion_in_progress: false,
  deletion_available: false, apple: { required: false, supported: true, code_required: false }, x_cleanup: 'supported',
  providers: [{ provider: 'x', adapter: 'saga', remote_revoke: 'saga' }, { provider: 'threads', adapter: 'registered', remote_revoke: 'unsupported' }],
  acknowledgement_required: ['threads'], postona_end_available: true });
const ended = { ok: true, outcome: 'ended', providers: { x: 'done', threads: 'local_removed_remote_unverified' }, remote_unverified: ['threads'], x_posts_unconfirmed: 2 };
const A = { userId: 'person-a', sessionId: 'session-a', accessToken: 'token-a' };
const A2 = { userId: 'person-a', sessionId: 'session-a-2', accessToken: 'token-a-2' };   // A, another session
const B = { userId: 'person-b', sessionId: 'session-b', accessToken: 'token-b' };
const context = { userId: A.userId, sessionId: A.sessionId };
const answer = (body, status = 200) => ({ status, body });
const refusedB = answer({ ok: false, error: 'AUTH_REQUIRED' }, 401);   // what F5 answers B's synthetic token
const THREADS_LINE = notices.REMOTE_UNVERIFIED.threads.remote;
const aFacts = (r) => r.lines.some((s) => s === THREADS_LINE || s.includes('予約が2件'));
const both = (r) => r.lines.includes(THREADS_LINE) && r.lines.some((s) => s.includes('予約が2件'));
const completed = (r) => r.lines.some((s) => s.includes('利用を終了しました') || s.includes('すでに終了'));
const tick = () => new Promise((r) => setImmediate(r));

/** A session read held until `open()`; it then answers the value captured when it was made (an Error rejects). */
function gate(value) {
  let open; const opened = new Promise((r) => { open = r; });
  let reached; const requested = new Promise((r) => { reached = r; });
  return { read: async () => { reached(); await opened; if (value instanceof Error) throw value; return value; }, open: () => open(), requested };
}
/** A response held until `open()`. */
function held(response) {
  let open; const opened = new Promise((r) => { open = r; });
  let reached; const requested = new Promise((r) => { reached = r; });
  return { respond: async () => { reached(); await opened; if (response instanceof Error) throw response; return response; }, open: () => open(), requested };
}

/** The real client. `sessions[i]` answers the i-th session() read (an Error throws; a function is called); after the
 *  script the CURRENT value (set by `switchTo`) is answered. Responses are queued (a function may await). */
function harness({ responses = [answer(previewBody()), answer(ended), answer(previewBody('ended'))], sessions = [] } = {}) {
  const calls = []; const queue = [...responses]; const script = [...sessions]; let current = A;
  const client = createPostonaEndClient({
    enabled: true,
    session: async () => {
      const next = script.length ? script.shift() : current;
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : next;
    },
    call: async (body, token) => {
      calls.push({ action: body.action, token });
      const next = queue.shift();
      if (typeof next === 'function') return next();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('offline');
      return next;
    },
  });
  const withdrawals = () => calls.filter((c) => c.action === 'withdraw_postona').length;
  return { client, calls, withdrawals, switchTo: (s) => { current = s; } };
}
const input = (preview) => ({ context, preview, phrase: POSTONA_END_CONFIRM_PHRASE, acknowledged: ['threads'] });
// Session reads of one end: preview (1: before, 2: after), end (3: before the mutation), 4: right after the mutation,
// own read-back preview (5: before its request, 6: after it), 7: the last check before the answer is returned.

/** A's end with read 7 (the last check) held; while it is held, a public preview() on the SAME client observes `other`. */
async function lastCheckRace(other, lastRead, { responses } = {}) {
  const last = gate(lastRead);
  const h = harness({ responses: responses ?? [answer(previewBody()), answer(ended), answer(previewBody('ended')), refusedB], sessions: [A, A, A, A, A, A, last.read] });
  const ending = h.client.end(input(await h.client.preview()));
  await last.requested;
  h.switchTo(other);
  const concurrent = await h.client.preview();
  last.open();
  return { result: await ending, concurrent, h };
}

test('the shipped source flag stays OFF', () => assert.equal(POSTONA_END_SOURCE_ENABLED, false));

// ---------------------------------------------------------------- J4's four orderings (fail on PR217)

for (const [label, other] of [['another person (B)', B], ['nobody', null]]) {
  test(`J4: concurrent preview observes ${label}; the held last check then answers stale A -> no completion, none of A's facts`, async () => {
    const { result, concurrent, h } = await lastCheckRace(other, A);
    assert.equal(concurrent.ok, false, 'the concurrent preview itself is not A\'s');
    assert.equal(result.ok, false); assert.equal(result.code, 'SESSION_CHANGED');
    assert.ok(!aFacts(result), 'no X count, no Threads line of A'); assert.ok(!completed(result));
    assert.equal(h.withdrawals(), 1, 'no extra mutation');
  });

  test(`J4: concurrent preview observes ${label}; the held last check then throws -> none of A's facts`, async () => {
    const { result, h } = await lastCheckRace(other, new Error('synthetic session store'));
    assert.equal(result.ok, false); assert.equal(result.code, 'SESSION_CHANGED');
    assert.ok(!aFacts(result)); assert.ok(!completed(result));
    assert.equal(h.withdrawals(), 1);
  });
}

// ---------------------------------------------------------------- same-person controls

test('control: the concurrent preview observes A (same login) -> the end still completes with both warnings', async () => {
  const { result, concurrent, h } = await lastCheckRace(A, A, { responses: [answer(previewBody()), answer(ended), answer(previewBody('ended')), answer(previewBody('ended'))] });
  assert.equal(concurrent.ok, true);
  assert.equal(result.ok, true); assert.ok(completed(result)); assert.ok(both(result));
  assert.equal(h.withdrawals(), 1);
});

test('control: the concurrent preview observes A, the held last check throws (unknown) -> both warnings, no completion', async () => {
  const { result } = await lastCheckRace(A, new Error('synthetic session store'), { responses: [answer(previewBody()), answer(ended), answer(previewBody('ended')), answer(previewBody('ended'))] });
  assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(both(result)); assert.ok(!completed(result));
});

test('a concurrent preview whose session read throws is unknown, not a logout: A\'s end still completes', async () => {
  const { result } = await lastCheckRace(new Error('synthetic session store'), A);
  assert.equal(result.ok, true); assert.ok(completed(result)); assert.ok(both(result));
});

test('A on another session seen by the concurrent preview keeps A\'s warnings, without a completion', async () => {
  const { result } = await lastCheckRace(A2, A, { responses: [answer(previewBody()), answer(ended), answer(previewBody('ended')), answer(previewBody('ended'))] });
  assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(both(result)); assert.ok(!completed(result));
});

// ---------------------------------------------------------------- other points of the end, nested previews, switch-back

for (const [label, other] of [['B', B], ['nobody', null]]) {
  test(`concurrent preview observes ${label} while the mutation is on its way -> no read-back request, none of A's facts`, async () => {
    const mutation = held(answer(ended));
    const h = harness({ responses: [answer(previewBody()), mutation.respond, refusedB] });
    const ending = h.client.end(input(await h.client.preview()));
    await mutation.requested;
    h.switchTo(other); await h.client.preview(); h.switchTo(A);   // stale or switched-back A answers every later read
    mutation.open();
    const result = await ending;
    assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result)); assert.ok(!completed(result));
    assert.equal(h.calls.filter((c) => c.action === 'preview' && c.token === A.accessToken).length, 1, 'the end makes no read-back request');
    assert.equal(h.withdrawals(), 1);
  });

  test(`concurrent preview observes ${label} while the own read-back is on its way; later reads say A -> none of A's facts`, async () => {
    const readBack = held(answer(previewBody('ended')));
    const h = harness({ responses: [answer(previewBody()), answer(ended), readBack.respond, refusedB] });
    const ending = h.client.end(input(await h.client.preview()));
    await readBack.requested;
    h.switchTo(other); await h.client.preview(); h.switchTo(A);
    readBack.open();
    const result = await ending;
    assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result)); assert.ok(!completed(result));
  });

  test(`concurrent preview observes ${label} before the mutation is sent -> nothing is sent`, async () => {
    const first = gate(A);
    const h = harness({ responses: [answer(previewBody()), refusedB], sessions: [A, A, first.read] });
    const p = await h.client.preview();
    const ending = h.client.end(input(p));
    await first.requested;
    h.switchTo(other); await h.client.preview(); h.switchTo(A);
    first.open();
    const result = await ending;
    assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result));
    assert.equal(h.withdrawals(), 0, 'no mutation after another login was seen');
  });
}

test('nested concurrent previews: B seen by one, A by the next, the held last check stale A -> still none of A\'s facts', async () => {
  const last = gate(A);
  const h = harness({ responses: [answer(previewBody()), answer(ended), answer(previewBody('ended')), refusedB, answer(previewBody('ended'))], sessions: [A, A, A, A, A, A, last.read] });
  const ending = h.client.end(input(await h.client.preview()));
  await last.requested;
  h.switchTo(B);
  const inner = h.client.preview();
  h.switchTo(A);
  const outer = h.client.preview();   // switched back: A again
  await Promise.all([inner, outer]);
  last.open();
  const result = await ending;
  assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result)); assert.ok(!completed(result));
});

test('a concurrent preview\'s read answering B late (stale, after A is current again) still counts for the end in flight', async () => {
  const stale = gate(B); const last = gate(A);
  const h = harness({ responses: [answer(previewBody()), answer(ended), answer(previewBody('ended')), refusedB], sessions: [A, A, A, A, A, A, last.read, stale.read] });
  const ending = h.client.end(input(await h.client.preview()));
  await last.requested;
  const concurrent = h.client.preview();
  await stale.requested; stale.open(); await concurrent;
  last.open();
  const result = await ending;
  assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result));
});

// ---------------------------------------------------------------- network failure, double submission

test('the own read-back transport fails while a concurrent preview saw B -> none of A\'s facts; with A -> both warnings', async () => {
  for (const [other, code, keeps] of [[B, 'SESSION_CHANGED', false], [A, 'RESULT_UNCONFIRMED', true]]) {
    const readBack = held(new Error('offline'));
    const h = harness({ responses: [answer(previewBody()), answer(ended), readBack.respond, other === B ? refusedB : answer(previewBody('ended'))] });
    const ending = h.client.end(input(await h.client.preview()));
    await readBack.requested;
    h.switchTo(other); await h.client.preview(); h.switchTo(A);
    readBack.open();
    const result = await ending;
    assert.equal(result.code, code); assert.equal(both(result), keeps); assert.equal(aFacts(result), keeps); assert.ok(!completed(result));
  }
});

test('double submission sends one mutation and does not drop the fence of the end in flight', async () => {
  const last = gate(A);
  const h = harness({ responses: [answer(previewBody()), answer(ended), answer(previewBody('ended')), refusedB], sessions: [A, A, A, A, A, A, last.read] });
  const p = await h.client.preview();
  const ending = h.client.end(input(p));
  assert.equal((await h.client.end(input(p))).code, 'DELETION_IN_PROGRESS');
  await last.requested;
  assert.equal((await h.client.end(input(p))).code, 'DELETION_IN_PROGRESS');
  h.switchTo(B); await h.client.preview();
  last.open();
  const result = await ending;
  assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result));
  assert.equal(h.withdrawals(), 1);
  h.switchTo(A);
  assert.equal((await h.client.end(input(p))).code, 'LIFECYCLE_CHANGED', 'the consumed preview cannot be replayed');
});

// ---------------------------------------------------------------- fence lifecycle: no false positive across ends

test('B observed between two ends (no end in flight) does not affect the next end of A', async () => {
  const h = harness({ responses: [answer(previewBody()), answer(ended), answer(previewBody('ended')), refusedB, answer(previewBody()), answer(ended), answer(previewBody('ended'))] });
  const first = await h.client.end(input(await h.client.preview()));
  assert.equal(first.ok, true);
  h.switchTo(B); await h.client.preview(); h.switchTo(A);
  const second = await h.client.end(input(await h.client.preview()));
  assert.equal(second.ok, true); assert.ok(completed(second)); assert.ok(both(second));
});

test('a read begun inside an earlier end that answers B during the next end does not affect the next end', async () => {
  const lateB = gate(B); const hold = held(answer(ended));
  // Requests in order: preview 1, end 1 (mutation, read-back), preview 2, end 2's mutation (held), the late read's
  // preview request with B's token, end 2's read-back.
  const h = harness({ responses: [answer(previewBody()), answer(ended), answer(previewBody('ended')), answer(previewBody()), hold.respond, refusedB, answer(previewBody('ended'))] });
  const p1 = await h.client.preview();
  // End 1 is in flight (its mutation answers at once); a public preview's session read starts inside it and is held.
  const ending1 = h.client.end(input(p1));
  h.switchTo(lateB.read);
  const orphan = h.client.preview();
  await lateB.requested;
  h.switchTo(A);
  assert.equal((await ending1).ok, true);
  // End 2 of A; while its mutation is on its way, the read begun inside end 1 finally answers B.
  const ending2 = h.client.end(input(await h.client.preview()));
  await hold.requested;
  lateB.open(); await orphan;
  hold.open();
  const second = await ending2;
  assert.equal(second.ok, true, 'a read of an earlier end never fences a later end'); assert.ok(completed(second)); assert.ok(both(second));
});

test('a read begun before the end (no end in flight) that answers B during the end counts for it (fail closed)', async () => {
  const early = gate(B); const hold = held(answer(ended));
  const h = harness({ responses: [answer(previewBody()), hold.respond, refusedB] });
  const p = await h.client.preview();
  h.switchTo(early.read);
  const pending = h.client.preview();
  await early.requested;
  h.switchTo(A);
  const ending = h.client.end(input(p));
  await hold.requested;
  early.open(); await pending;
  hold.open();
  const result = await ending;
  assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result)); assert.ok(!completed(result));
  assert.equal(h.withdrawals(), 1);
});

test('after an earlier end returned, a read begun before the next end that answers B during it counts for the next end', async () => {
  const early = gate(B); const hold = held(answer(ended));
  const h = harness({ responses: [answer(previewBody()), answer(ended), answer(previewBody('ended')), answer(previewBody()), hold.respond, refusedB] });
  assert.equal((await h.client.end(input(await h.client.preview()))).ok, true, 'the earlier end completes and drops its fence');
  const p = await h.client.preview();
  h.switchTo(early.read);
  const pending = h.client.preview();
  await early.requested;
  h.switchTo(A);
  const ending = h.client.end(input(p));
  await hold.requested;
  early.open(); await pending;
  hold.open();
  const result = await ending;
  assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result));
});
