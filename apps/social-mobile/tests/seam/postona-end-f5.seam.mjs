// F4 R2c seam: THIS branch's POSTONA service-end client against F5 PR #193's ACTUAL lifecycle handlers
// (handlePreview / handleWithdrawPostona over F5's own synthetic world: fake lifecycle, Auth and providers), extracted
// read-only from git by run-postona-end-f5-seam.sh into $F5_DIR. Same scenario as J4's late-switch probe. Not part of
// `node --test tests/*.test.mjs` (it needs the F5 extraction). Synthetic only: no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostonaEndClient } from '../../src/lib/postona-service-end-client.ts';
import { POSTONA_END_CONFIRM_PHRASE } from '../../src/domain/postona-service-end.ts';
import { REMOTE_UNVERIFIED } from '../../src/domain/postona-end-notices.ts';

const dir = process.env.F5_DIR;
assert.ok(dir, 'F5_DIR (the read-only extraction of F5 PR #193) is required');
const f5 = `${dir}/supabase/functions/account-delete`;
const { world, signIn, USER, bearer } = await import(`${f5}/fake_lifecycle.ts`);
const { handlePreview, handleWithdrawPostona } = await import(`${f5}/lifecycle_logic.ts`);

const token = signIn();
const A = { userId: USER, sessionId: 'synthetic-session', accessToken: token };
const ctx = { userId: A.userId, sessionId: A.sessionId };
const input = (p) => ({ context: ctx, preview: p, phrase: POSTONA_END_CONFIRM_PHRASE, acknowledged: ['threads'] });
const THREADS_LINE = REMOTE_UNVERIFIED.threads.remote;
const aFacts = (r) => r.lines.some((s) => s === THREADS_LINE || s.includes('予約が2件'));
const both = (r) => r.lines.includes(THREADS_LINE) && r.lines.some((s) => s.includes('予約が2件'));
const completed = (r) => r.lines.some((s) => s.includes('利用を終了しました'));

function harness({ hold, breakCallAt, sessions = [] } = {}) {
  const w = world({ x: 'active', threads: true, xRun: [{ outcome: 'done', unconfirmedPosts: 2 }] });
  w.deps.providers = [{ provider: 'threads', hasConnection: async () => w.state.threads,
    cleanup: async () => { w.state.threads = false; return 'local_removed_remote_unverified'; } }];
  let current = A; let calls = 0; const script = [...sessions]; const requests = [];
  const client = createPostonaEndClient({
    enabled: true,
    session: async () => { const next = script.length ? script.shift() : current; if (next instanceof Error) throw next; return next; },
    call: async (payload, t) => {
      calls += 1; requests.push(payload.action);
      if (calls === breakCallAt) throw new Error('synthetic connection loss');
      const response = payload.action === 'preview'
        ? await handlePreview({ authorization: bearer(t) }, w.deps)
        : await handleWithdrawPostona({ authorization: bearer(t), body: payload }, w.deps);
      if (hold && calls === hold.at) await hold.promise;
      return response;
    },
  });
  return { client, w, requests, switchTo: (s) => { current = s; } };
}

test('actual F5: normal end keeps login and Kabumori, completes with the Threads line and count 2', async () => {
  const h = harness();
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.ok, true); assert.ok(completed(result)); assert.ok(both(result));
  assert.deepEqual(h.requests, ['preview', 'withdraw_postona', 'preview']);
});

for (const [label, other] of [['another person', { userId: 'other-user', sessionId: 'other-session', accessToken: 'other-token' }], ['nobody', null]]) {
  test(`actual F5 (J4 R2c): the final read-back answer is held, the login switches to ${label} -> none of A's facts`, async () => {
    let release; const promise = new Promise((r) => { release = r; });
    const h = harness({ hold: { at: 3, promise } });
    const ending = h.client.end(input(await h.client.preview()));
    await new Promise((r) => setImmediate(r)); h.switchTo(other); release();
    const result = await ending;
    assert.equal(result.ok, false); assert.equal(result.code, 'SESSION_CHANGED');
    assert.equal(aFacts(result), false, 'previous-person facts suppressed'); assert.ok(!completed(result));
  });
}

test('actual F5: the immediate post-mutation switch control still suppresses A\'s facts', async () => {
  const h = harness({ sessions: [A, A, A, { userId: 'other-user', sessionId: 'other-session', accessToken: 'other-token' }] });
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.code, 'SESSION_CHANGED'); assert.ok(!aFacts(result));
});

test('actual F5: A still signed in, the read-back connection fails -> both warnings, no completion', async () => {
  const h = harness({ breakCallAt: 3 });
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(both(result)); assert.ok(!completed(result));
});

test('actual F5: the session read right after the mutation throws -> both warnings, no completion', async () => {
  const h = harness({ sessions: [A, A, A, new Error('synthetic Auth storage failure')] });
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.code, 'RESULT_UNCONFIRMED'); assert.ok(both(result)); assert.ok(!completed(result));
});

test('actual F5: A on a refreshed session during the read-back keeps both warnings, no completion', async () => {
  const h = harness({ sessions: [A, A, A, A, { ...A, sessionId: 'synthetic-session-2' }] });
  const result = await h.client.end(input(await h.client.preview()));
  assert.equal(result.ok, false); assert.ok(both(result)); assert.ok(!completed(result));
});

test('actual F5: double submission sends one mutation', async () => {
  const h = harness();
  const p = await h.client.preview();
  const [first, second] = await Promise.all([h.client.end(input(p)), h.client.end(input(p))]);
  assert.equal([first, second].filter((r) => r.code === 'DELETION_IN_PROGRESS').length, 1);
  assert.equal(h.requests.filter((a) => a === 'withdraw_postona').length, 1);
});
