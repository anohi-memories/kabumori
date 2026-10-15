// F4 (postona-f4-pr197-p2-response-warning-preservation-20261015): J4 V4 P2-R1 / P2-R2 on PR197's POSTONA
// service-end client. Reproduces each finding first (these tests FAIL on PR197 2171ee4c) and pins the fix:
//   R1  a success answer is accepted only in F5 PR193's exact variant shape (fresh `ended` carries its provider
//       summary with X `done`; `remote_unverified` and the provider results agree in BOTH directions, by F5's own
//       rule; `not_registered` carries nothing); anything else is RESULT_UNCONFIRMED, never a completion.
//   R2  once this person's own valid answer arrived, its warnings (the Threads remote-authorization line and the X
//       uncertainty count) survive every later failure to confirm -- a rejected session read, a failed read-back,
//       an exception -- without a completion line; after a switch to ANOTHER person none of them is attached.
// Synthetic transport and sessions only; no server, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { POSTONA_END_CONFIRM_PHRASE, POSTONA_END_SOURCE_ENABLED, parseEndResult } from '../src/domain/postona-service-end.ts';
import { createPostonaEndClient } from '../src/lib/postona-service-end-client.ts';
import { REMOTE_UNVERIFIED } from '../src/domain/postona-end-notices.ts';

const previewBody = (status = 'active') => ({ ok: true, account_status: 'active', lifecycle_version: 7,
  services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status }], blockers: [], deletion_in_progress: false,
  deletion_available: false, apple: { required: false, supported: true, code_required: false }, x_cleanup: 'supported',
  providers: [{ provider: 'x', adapter: 'saga', remote_revoke: 'saga' }, { provider: 'threads', adapter: 'registered', remote_revoke: 'unsupported' }],
  acknowledgement_required: ['threads'], postona_end_available: true });
// F5 PR193's actual fresh end for a connected Threads account and two X posts whose result was never known.
const ended = { ok: true, outcome: 'ended', providers: { x: 'done', threads: 'local_removed_remote_unverified' }, remote_unverified: ['threads'], x_posts_unconfirmed: 2 };
const context = { userId: 'synthetic-user', sessionId: 'synthetic-session' };
const answer = (body, status = 200) => ({ status, body });
const THREADS_LINE = REMOTE_UNVERIFIED.threads.remote;
const hasThreads = (r) => r.lines.includes(THREADS_LINE);
const hasCount = (r, n) => r.lines.some((s) => s.includes(`予約が${n}件`));
const completed = (r) => r.lines.some((s) => s.includes('利用を終了しました') || s.includes('すでに終了'));

/**
 * The real client with a synthetic transport. `sessions` scripts each session() call in order (a value, an Error to
 * throw, or a function); after the script runs out the last value repeats.
 */
function harness({ responses, sessions } = {}) {
  const calls = []; const queue = [...(responses ?? [answer(previewBody()), answer(ended), answer(previewBody('ended'))])];
  const script = [...(sessions ?? [])]; let last = { ...context, accessToken: 'synthetic-token' }; let reads = 0;
  const client = createPostonaEndClient({
    enabled: true,
    session: async () => {
      reads += 1;
      const next = script.length ? script.shift() : last;
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next();
      last = next; return next;
    },
    call: async (body, token) => {
      calls.push({ body, token }); const next = queue.shift();
      if (typeof next === 'function') return next(); if (next instanceof Error) throw next; if (!next) throw new Error('offline'); return next;
    },
  });
  return { client, calls, reads: () => reads };
}
const input = (preview, extra = {}) => ({ context, preview, phrase: POSTONA_END_CONFIRM_PHRASE, acknowledged: ['threads'], ...extra });
const me = { ...context, accessToken: 'synthetic-token' };

test('the shipped source flag stays OFF', () => {
  assert.equal(POSTONA_END_SOURCE_ENABLED, false);
});

// ---------------------------------------------------------------- R1

test('R1: a truncated fresh `ended` answer is never a completion (actual flow, read-back says ended)', async () => {
  for (const body of [{ ok: true, outcome: 'ended' }, { ok: true, outcome: 'ended', x_posts_unconfirmed: 2 },
    { ok: true, outcome: 'ended', remote_unverified: ['threads'] }]) {
    const h = harness({ responses: [answer(previewBody()), answer(body), answer(previewBody('ended'))] });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.code, 'RESULT_UNCONFIRMED');
    assert.ok(!completed(result), 'no completion sentence');
  }
});

test('R1: the warnings a truncated body does state are still shown, never a completion', async () => {
  const h = harness({ responses: [answer(previewBody()), answer({ ok: true, outcome: 'ended', remote_unverified: ['threads'], x_posts_unconfirmed: 2 }), answer(previewBody('ended'))] });
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(hasThreads(result)); assert.ok(hasCount(result, 2)); assert.ok(!completed(result));
});

test('R1: remote_unverified and provider results must agree in BOTH directions', () => {
  // The J4 inverse case: a remote-unverified provider with no (or another) recorded result.
  for (const body of [
    { ok: true, outcome: 'ended', providers: { x: 'done' }, remote_unverified: ['threads'] },
    { ok: true, outcome: 'ended', providers: { x: 'done', threads: 'confirmed_remote_revoked' }, remote_unverified: ['threads'] },
    { ok: true, outcome: 'already_ended', providers: { x: 'done' }, remote_unverified: ['threads'] },
    { ok: true, outcome: 'already_ended', remote_unverified: ['threads'] },
    // ... and the forward case (already covered before; kept as a pair).
    { ok: true, outcome: 'ended', providers: { x: 'done', threads: 'local_removed_remote_unverified' } },
  ]) assert.equal(parseEndResult(200, body, ['threads']).code, 'RESULT_UNCONFIRMED', JSON.stringify(body));
});

test('R1: a fresh end needs X `done` and an answer for every provider the person consented about', () => {
  for (const body of [
    { ok: true, outcome: 'ended', providers: {} },
    { ok: true, outcome: 'ended', providers: { threads: 'local_removed_remote_unverified' }, remote_unverified: ['threads'] },
    { ok: true, outcome: 'ended', providers: { x: 'done' } },                       // Threads consented, not accounted for
    { ok: true, outcome: 'ended', providers: null }, { ok: true, outcome: 'ended', providers: ['x'] },
    { ...ended, remote_unverified: [] }, { ...ended, x_posts_unconfirmed: 0 },      // F5 omits empty values
    { ok: true, outcome: 'not_registered', providers: {} }, { ok: true, outcome: 'not_registered', remote_unverified: ['threads'] },
    { ok: true, outcome: 'not_registered', x_posts_unconfirmed: 1 },
  ]) assert.equal(parseEndResult(200, body, ['threads']).ok, false, JSON.stringify(body));
});

test('R1: F5 PR193\'s legitimate variants are kept', () => {
  const ok = (body, acknowledged) => parseEndResult(200, body, acknowledged);
  assert.equal(ok(ended, ['threads']).ok, true);
  assert.equal(ok({ ok: true, outcome: 'ended', providers: { x: 'done' } }, []).ok, true);
  // F5's rule: an acknowledged provider whose only recorded answer is "not connected" (its removal's answer was lost).
  const lost = ok({ ok: true, outcome: 'ended', providers: { x: 'done', threads: 'not_connected' }, remote_unverified: ['threads'] }, ['threads']);
  assert.equal(lost.ok, true); assert.ok(hasThreads(lost));
  assert.equal(ok({ ok: true, outcome: 'ended', providers: { x: 'done', threads: 'not_connected' } }, ['threads']).ok, true);
  for (const body of [{ ok: true, outcome: 'already_ended' }, { ok: true, outcome: 'already_ended', x_posts_unconfirmed: 2 },
    { ok: true, outcome: 'already_ended', providers: { x: 'done', threads: 'local_removed_remote_unverified' }, remote_unverified: ['threads'], x_posts_unconfirmed: 2 },
    { ok: true, outcome: 'not_registered' }]) assert.equal(ok(body, []).ok, true, JSON.stringify(body));
});

// ---------------------------------------------------------------- R2

test('R2 (J4 repro A): the session read right after the mutation rejects -> both warnings kept, no completion', async () => {
  // session() calls: preview before/after (1, 2), end current (3), right after the mutation (4: rejects).
  const h = harness({ sessions: [me, me, me, new Error('session store unavailable')] });
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.ok, false); assert.equal(result.code, 'RESULT_UNCONFIRMED');
  assert.ok(hasThreads(result), 'Threads remote-authorization line kept'); assert.ok(hasCount(result, 2), 'X count kept');
  assert.ok(!completed(result)); assert.equal(h.calls.length, 2, 'no read-back after the rejected session read');
});

test('R2 (J4 repro B): the final read-back transport fails -> both warnings kept, no completion', async () => {
  const h = harness({ responses: [answer(previewBody()), answer(ended), new Error('offline')] });
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(hasThreads(result)); assert.ok(hasCount(result, 2)); assert.ok(!completed(result));
});

test('R2: every other read-back refusal keeps both warnings too', async () => {
  for (const after of [answer(previewBody()), answer({ ok: false, error: 'AUTH_REQUIRED' }, 401), answer({ ...previewBody('ended'), account_status: 'none' }), answer(null)]) {
    const h = harness({ responses: [answer(previewBody()), answer(ended), after] });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(hasThreads(result)); assert.ok(hasCount(result, 2)); assert.ok(!completed(result));
  }
});

test('R2: a session read that rejects inside the read-back keeps both warnings', async () => {
  // 5th session() call = the read-back preview's own first read.
  const h = harness({ sessions: [me, me, me, me, new Error('session store unavailable')] });
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(hasThreads(result)); assert.ok(hasCount(result, 2));
});

test('R2: after a switch to ANOTHER person none of the previous person\'s facts is attached', async () => {
  for (const other of [{ userId: 'another-user', sessionId: 'another-session', accessToken: 't2' }, null]) {
    const h = harness({ sessions: [me, me, me, other] });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.code, 'SESSION_CHANGED');
    assert.ok(!hasThreads(result) && !hasCount(result, 2), 'no previous-person warnings');
    assert.ok(!completed(result));
  }
  // The same person on a new session (not a different person) still sees their own warnings.
  const h = harness({ sessions: [me, me, me, { ...context, sessionId: 'synthetic-session-2', accessToken: 't3' }] });
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(hasThreads(result)); assert.ok(hasCount(result, 2));
});

test('R2: a malformed answer gives no facts to keep (only what it states), then the read-back is not even needed', async () => {
  const h = harness({ responses: [answer(previewBody()), answer({ ok: true, outcome: 'ended' }), answer(previewBody('ended'))] });
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(!hasThreads(result) && !hasCount(result, 2)); assert.equal(h.calls.length, 2);
});

// ---------------------------------------------------------------- double tap / retry

test('double tap sends one mutation; a retry after an unconfirmed result needs a fresh preview', async () => {
  let finish; const pending = new Promise((resolve) => { finish = resolve; });
  const h = harness({ responses: [answer(previewBody()), () => pending, new Error('offline')] });
  const p = await h.client.preview();
  const first = h.client.end(input(p));
  assert.equal((await h.client.end(input(p))).code, 'DELETION_IN_PROGRESS');
  finish(answer(ended));
  const result = await first;
  assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(hasThreads(result)); assert.ok(hasCount(result, 2));
  assert.equal((await h.client.end(input(p))).code, 'LIFECYCLE_CHANGED', 'the consumed preview cannot be replayed');
  assert.equal(h.calls.filter((c) => c.body.action === 'withdraw_postona').length, 1);
});
