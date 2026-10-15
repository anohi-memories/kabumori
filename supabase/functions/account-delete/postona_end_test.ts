// Phase 6: ending POSTONA as one owned operation -- alone ("POSTONAの利用を終了") and, in provider_cleanup_flow_test.ts,
// inside the whole-account deletion. Over the same fake lifecycle database as lifecycle_logic_test.ts; the real
// database half (leases, results, acknowledgement) is proven in supabase/tests/common_account_service_deletion_*.
import assert from 'node:assert/strict';
import test from 'node:test';

import { bearer, deferred, deleteBody, signIn, USER, world, type World, type WorldOptions } from './fake_lifecycle.ts';
import {
  END_POSTONA_CONFIRMATION,
  handleDeleteCommonAccount,
  handleWithdrawPostona,
  LEASE_SECONDS,
  type LifecycleResponse,
} from './lifecycle_logic.ts';
import type { ProviderCleanupAdapter, ProviderOutcome } from './provider_cleanup.ts';

const withdraw = (w: World, body: Record<string, unknown> = {}, token = signIn()) =>
  handleWithdrawPostona({ authorization: bearer(token), body: { confirmation: END_POSTONA_CONFIRMATION, ...body } }, w.deps);
const error = (response: LifecycleResponse) => (response.body.ok ? null : response.body.error);
const bodyOf = (response: LifecycleResponse) => response.body as Record<string, unknown>;
const lose = (w: World) => { w.state.clock += LEASE_SECONDS + 1; };
const ACK = { acknowledged_remote_unverified: ['threads'] };
/** Names of X evidence sets (F3 PR #204 snapshots: 64 lowercase hex). */
const SNAP_A = 'a'.repeat(64);
const SNAP_B = 'b'.repeat(64);
const SNAP_C = 'c'.repeat(64);
const pair = (count: number, snapshot: string) => ({ outcome: 'done' as const, unconfirmedPosts: count, unconfirmedSnapshot: snapshot });

/** A Threads adapter that removes the (fake) connection and answers as the real one does: never "remote revoked". */
function threads(w: World, answer: () => ProviderOutcome | 'throw' = () => 'local_removed_remote_unverified'): ProviderCleanupAdapter {
  return {
    provider: 'threads',
    hasConnection: async () => { w.effects.push('provider:threads:has'); return w.state.threads; },
    cleanup: async () => {
      w.effects.push('provider:threads:cleanup');
      const result = answer();
      if (result === 'throw') throw new Error('token=secret');
      if (result === 'local_removed_remote_unverified' || result === 'confirmed_remote_revoked') w.state.threads = false;
      return result;
    },
  };
}
const withThreads = (options: WorldOptions = {}) => {
  const w = world({ x: 'active', threads: true, ...options });
  w.deps.providers = [threads(w)];
  return w;
};

test('POSTONA alone: X and Threads, the acknowledgement on the record BEFORE the removal; the login, Kabumori and the account stay', async () => {
  const w = world({ x: 'active', threads: true });
  let ackAtRemoval: string[] | null = null;
  w.deps.providers = [{
    ...threads(w),
    cleanup: async () => {
      ackAtRemoval = w.state.svc?.ack ?? null;
      w.state.threads = false;
      return 'local_removed_remote_unverified';
    },
  }];
  const response = await withdraw(w, ACK);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true, outcome: 'ended', providers: { threads: 'local_removed_remote_unverified', x: 'done' }, remote_unverified: ['threads'],
  });
  assert.deepEqual(ackAtRemoval, ['threads'], 'the person\'s acknowledgement was recorded before the cleanup that makes it so');
  assert.equal(w.state.services.x_autopost, 'ended');
  assert.equal(w.state.services.kabumori, 'active', 'the other service is untouched');
  assert.equal(w.state.account, 'active');
  assert.equal(w.state.login, true);
  assert.equal(w.state.profile, true);
  const order = ['rpc:begin_service_deletion', 'rpc:claim_service', 'provider:threads:has', 'x:run', 'rpc:finish_owned_service', 'rpc:release_service']
    .map((e) => w.effects.indexOf(e));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the owned order');
  assert.ok(order.every((index) => index >= 0));
  for (const never of ['rpc:begin_account_deletion', 'auth:delete', 'auth:revoke_sessions', 'rpc:withdraw_kabumori']) {
    assert.ok(!w.effects.includes(never), `${never} is not part of ending POSTONA alone`);
  }
});

test('without the acknowledgement nothing changes: refused before the service deletion even begins', async () => {
  const w = withThreads();
  const response = await withdraw(w);
  assert.equal(response.status, 409);
  assert.equal(error(response), 'REMOTE_UNVERIFIED_ACK_REQUIRED');
  assert.deepEqual(bodyOf(response).providers, [{ provider: 'threads', result: 'pending' }]);
  assert.equal(w.state.services.x_autopost, 'active');
  assert.ok(!w.effects.includes('rpc:begin_service_deletion') && !w.effects.includes('x:run'));
  assert.equal(w.state.threads, true, 'the Threads connection is still there');
});

test('a connected provider with no adapter, or an unknown one, stops everything before anything changes', async () => {
  const none = world({ x: 'active', threads: true });
  const first = await withdraw(none, ACK);
  assert.equal(error(first), 'PROVIDER_ADAPTER_MISSING');
  assert.deepEqual(bodyOf(first).providers, [{ provider: 'threads', result: 'blocked' }]);
  assert.ok(!none.effects.includes('rpc:begin_service_deletion'));
  assert.equal(none.state.services.x_autopost, 'active');

  const other = world({ x: 'active', threads: true, otherPlatforms: ['instagram'] });
  other.deps.providers = [threads(other)];
  const second = await withdraw(other, { acknowledged_remote_unverified: ['threads', 'instagram'] });
  assert.equal(error(second), 'PROVIDER_ADAPTER_MISSING');
  assert.deepEqual(bodyOf(second).providers, [{ provider: 'instagram', result: 'blocked' }]);
  assert.ok(!other.effects.includes('x:run') && other.state.services.x_autopost === 'active');
});

test('the acknowledgement is exact: provider keys only, never X, never a malformed or oversized list', async () => {
  for (const value of [['x'], ['Threads'], 'threads', [1], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], { threads: true }]) {
    const w = withThreads();
    const response = await withdraw(w, { acknowledged_remote_unverified: value });
    assert.equal(error(response), 'ACKNOWLEDGEMENT_INVALID', JSON.stringify(value));
    assert.equal(response.status, 400);
    assert.deepEqual(w.effects.filter((e) => e.startsWith('rpc:') && e !== 'rpc:eligibility'), [], 'nothing was called');
  }
});

test('confirmation, a recent sign-in and a valid caller are required; the person is the token, never a body field', async () => {
  const w = withThreads();
  assert.equal(error(await handleWithdrawPostona({ authorization: bearer(signIn()), body: { confirmation: 'yes' } }, w.deps)), 'CONFIRMATION_REQUIRED');
  assert.equal(error(await withdraw(w, ACK, signIn(0))), 'REAUTH_REQUIRED');
  assert.equal(error(await handleWithdrawPostona({ authorization: null, body: { confirmation: END_POSTONA_CONFIRMATION } }, w.deps)), 'AUTH_REQUIRED');
  const named = await withdraw(w, { ...ACK, user_id: '22222222-2222-4222-8222-222222222222', p_user_id: '22222222-2222-4222-8222-222222222222' });
  assert.equal(named.status, 200, 'a body field naming another person is ignored');
  assert.equal(w.state.services.x_autopost, 'ended');
});

test('never started and already ended are answered without changing anything', async () => {
  const never = world({ x: null });
  assert.deepEqual((await withdraw(never)).body, { ok: true, outcome: 'not_registered' });
  const ended = world({ x: 'ended' });
  assert.deepEqual((await withdraw(ended)).body, { ok: true, outcome: 'already_ended' });
  for (const w of [never, ended]) assert.ok(!w.effects.includes('rpc:begin_service_deletion'));
});

test('the X saga\'s typed outcomes are never turned into success; the answer is recorded; a retry resumes the same operation', async () => {
  const cases: [WorldOptions['xRun'] extends (infer T)[] | undefined ? T : never, number, string, string][] = [
    ['in_progress', 409, 'X_CLEANUP_IN_PROGRESS', 'reconciliation_required'],
    ['blocked', 409, 'X_CLEANUP_BLOCKED', 'blocked'],
    ['failed', 502, 'X_CLEANUP_FAILED', 'reconciliation_required'],
    ['scope_refused', 409, 'X_CLEANUP_UNSUPPORTED', 'reconciliation_required'],
  ];
  for (const [outcome, status, code, recorded] of cases) {
    const w = world({ x: 'active', xRun: [outcome, 'done'] });
    const first = await withdraw(w);
    assert.equal(first.status, status, outcome);
    assert.equal(error(first), code, outcome);
    assert.equal(w.state.services.x_autopost, 'deleting', `${outcome}: POSTONA is not ended`);
    assert.equal(w.state.svc?.results.x, recorded, `${outcome}: the answer is on the record`);
    assert.ok(!w.effects.includes('rpc:finish_owned_service'), `${outcome}: not finished`);
    assert.equal(w.state.svc?.lease, null, `${outcome}: the lease was given back`);
    const operation = w.state.xServiceOp;
    const second = await withdraw(w);
    assert.equal(second.status, 200, `${outcome}: the retry completes`);
    assert.equal(w.state.xServiceOp, operation, `${outcome}: the same operation`);
    assert.equal(w.state.svc?.fence, 2, `${outcome}: a new owner, a new fence`);
  }
  // The saga removed the login itself (it must not): nothing can be verified, and nothing is ended.
  const gone = world({ x: 'active', xRun: ['login_deleted'] });
  const response = await withdraw(gone);
  assert.equal(error(response), 'DELETION_VERIFICATION_PENDING');
  assert.equal(gone.state.services.x_autopost, 'deleting');
});

test('crash and takeover: the stale first owner stops at its next step; the entitlement ends once', async () => {
  const arrived = deferred();
  const go = deferred();
  let paused = false;
  const w = world({ x: 'active', hooks: { x: async () => { if (!paused) { paused = true; arrived.resolve(); await go.promise; } } } });
  const first = withdraw(w);
  await arrived.promise;                                                  // the first owner hangs inside the X saga
  const within = await withdraw(w, {}, signIn());
  assert.equal(error(within), 'DELETION_IN_PROGRESS', 'while its lease is live a second request is told so and calls nothing external');
  lose(w);
  const takeover = await withdraw(w);
  assert.equal(takeover.status, 200, 'after the lease ended a new owner completes');
  assert.equal(w.state.svc?.fence, 2);
  go.resolve();
  const stale = await first;
  assert.equal(error(stale), 'DELETION_IN_PROGRESS', 'the stale owner never reports success');
  assert.equal(w.effects.filter((e) => e === 'rpc:finish_owned_service').length, 1, 'the entitlement ended once');
  assert.equal(w.state.services.x_autopost, 'ended');
});

test('a lease lost while an adapter works: nothing is ended, nothing recorded after the loss', async () => {
  const w = world({ x: 'active', threads: true });
  w.deps.providers = [{
    provider: 'threads',
    hasConnection: async () => true,
    cleanup: async () => { lose(w); w.state.threads = false; return 'local_removed_remote_unverified'; },
  }];
  const response = await withdraw(w, ACK);
  assert.equal(error(response), 'DELETION_IN_PROGRESS');
  assert.equal(w.state.services.x_autopost, 'deleting');
  assert.ok(!w.effects.includes('rpc:finish_owned_service'));
  assert.notEqual(w.state.svc?.results.threads, 'local_removed_remote_unverified', 'the answer of an owner that lost the lease is not recorded as settled');
});

test('an unsettled or unknown provider answer is never success; once fixed the same operation completes', async () => {
  let answer: ProviderOutcome | 'throw' = 'throw';
  const w = world({ x: 'active', threads: true });
  w.deps.providers = [threads(w, () => answer)];
  const first = await withdraw(w, ACK);
  assert.equal(error(first), 'RECONCILIATION_REQUIRED');
  assert.ok(!JSON.stringify(first).includes('secret'));
  assert.equal(w.state.svc?.results.threads, 'reconciliation_required');
  assert.equal(w.state.services.x_autopost, 'deleting');
  answer = 'blocked';
  assert.equal(error(await withdraw(w, ACK)), 'PROVIDER_CLEANUP_BLOCKED');
  assert.equal(w.state.svc?.results.threads, 'blocked');
  answer = 'local_removed_remote_unverified';
  const done = await withdraw(w, ACK);
  assert.equal(done.status, 200);
  assert.equal(w.state.services.x_autopost, 'ended');
});

test('a retry cannot erase the fact that the remote grant was not verified revoked', async () => {
  const w = withThreads({ rpcFailOnce: { finish_owned_service: 1 } });
  const first = await withdraw(w, ACK);
  assert.equal(first.status, 500, 'the end itself failed once');
  assert.equal(w.state.threads, false, 'the local connection is gone');
  assert.equal(w.state.svc?.results.threads, 'local_removed_remote_unverified');
  // The retry: the adapter now only sees "not connected"; the record keeps the stronger fact.
  const second = await withdraw(w, ACK);
  assert.equal(second.status, 200);
  assert.deepEqual(bodyOf(second).providers, { threads: 'local_removed_remote_unverified', x: 'done' });
  assert.deepEqual(bodyOf(second).remote_unverified, ['threads']);
  assert.equal(w.state.svc?.results.threads, 'local_removed_remote_unverified');
});

test('a removal already on record needs the person\'s consent, taken from the retry itself; none is asked twice', async () => {
  // The registration says "supported" (nothing is asked up front), the adapter answers "unverified": the first
  // attempt stops after the removal; the end is stuck unless the retry can bring the consent.
  const w = withThreads();
  w.deps.providerRemoteRevoke = { threads: 'supported' };
  const first = await withdraw(w);
  assert.equal(error(first), 'PROVIDER_REMOTE_UNVERIFIED');
  assert.equal(w.state.threads, false);
  assert.equal(w.state.svc?.results.threads, 'local_removed_remote_unverified');
  assert.equal(w.state.svc?.ack ?? null, null, 'no acknowledgement was given');
  // A retry without consent: stopped again at once, X is not touched, the lease is given back.
  const xBefore = w.state.calls.x;
  const second = await withdraw(w);
  assert.equal(error(second), 'REMOTE_UNVERIFIED_ACK_REQUIRED');
  assert.deepEqual(bodyOf(second).providers, [{ provider: 'threads', result: 'local_removed_remote_unverified' }]);
  assert.equal(w.state.calls.x, xBefore, 'X is not run before the consent');
  assert.equal(w.state.svc?.lease, null);
  assert.equal(w.state.services.x_autopost, 'deleting');
  // A retry with the person\'s consent: recorded, then the same operation ends; the fact stays reported.
  const third = await withdraw(w, ACK);
  assert.equal(third.status, 200);
  assert.deepEqual(w.state.svc?.ack, ['threads']);
  assert.deepEqual(bodyOf(third).remote_unverified, ['threads']);
  assert.equal(w.state.services.x_autopost, 'ended');
});

test('consent given earlier stays: a retry that brings none is not asked again when the answer is on record', async () => {
  const w = withThreads({ rpcFailOnce: { finish_owned_service: 1 } });
  const first = await withdraw(w, ACK);
  assert.equal(first.status, 500, 'the end itself failed once, after the removal and its answer were recorded');
  assert.equal(w.state.svc?.results.threads, 'local_removed_remote_unverified');
  assert.deepEqual(w.state.svc?.ack, ['threads']);
  const second = await withdraw(w); // no acknowledgement in this request: the earlier one is on the record
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(bodyOf(second).remote_unverified, ['threads']);
});

test('consent given earlier stays: a resumed end after a crash does not ask again, and still reports the grant as unverified', async () => {
  const w = withThreads();
  // First attempt: acknowledged, removed, then the process "dies" before the answer was recorded.
  const adapter = w.deps.providers![0];
  w.deps.providers = [{
    ...adapter,
    cleanup: async () => {
      w.state.threads = false;
      lose(w); // the lease ends while the removal runs; its answer is not used
      return 'local_removed_remote_unverified';
    },
  }];
  const first = await withdraw(w, ACK);
  assert.equal(error(first), 'DELETION_IN_PROGRESS');
  assert.deepEqual(w.state.svc?.ack, ['threads']);
  assert.equal(w.state.svc?.results.threads, 'pending', 'its answer was never recorded');
  // The retry brings no consent (the preview no longer lists a connection): none is needed, it is on the record.
  w.deps.providers = [threads(w)];
  const second = await withdraw(w);
  assert.equal(second.status, 200);
  assert.deepEqual(bodyOf(second).providers, { threads: 'not_connected', x: 'done' });
  assert.deepEqual(bodyOf(second).remote_unverified, ['threads'], 'acknowledged + only "not connected" is still unverified');
});

test('X posts whose result was never known are a durable fact: reported, never hidden behind the end, kept by a retry', async () => {
  const w = world({ x: 'active', xRun: [pair(3, SNAP_A)] });
  const first = await withdraw(w);
  assert.equal(first.status, 200);
  assert.deepEqual(bodyOf(first).providers, { x: 'done' });
  assert.equal(bodyOf(first).x_posts_unconfirmed, 3);
  assert.deepEqual(w.state.svc?.recon, { x_posts_unconfirmed: 3, x_unconfirmed_snapshots: [SNAP_A] }, 'the pair is on the record before the end');
  assert.equal(w.state.services.x_autopost, 'ended');
  // A second request (another device, a retry after a lost answer) reads the same answer back.
  const again = await withdraw(w);
  assert.equal(again.status, 200);
  assert.equal(bodyOf(again).outcome, 'already_ended');
  assert.equal(bodyOf(again).x_posts_unconfirmed, 3);
});

test('the unconfirmed-post count is sticky at its maximum: a saga that forgot on a retry cannot lower it', async () => {
  const w = world({ x: 'active', xRun: [pair(4, SNAP_A)], rpcFailOnce: { finish_owned_service: 1 } });
  const first = await withdraw(w);
  assert.equal(first.status, 500, 'the end itself failed once, after X answered');
  assert.deepEqual(w.state.svc?.recon, { x_posts_unconfirmed: 4, x_unconfirmed_snapshots: [SNAP_A] });
  // The retry: the saga (purged, finalize pending) now answers a plain done -- the record keeps the count.
  w.state.xWorkspace = true;
  const second = await withdraw(w);
  assert.equal(second.status, 200);
  assert.equal(bodyOf(second).x_posts_unconfirmed, 4);
  assert.deepEqual(w.state.svc?.recon, { x_posts_unconfirmed: 4, x_unconfirmed_snapshots: [SNAP_A] }, 'and the named set stays on record');
});

test('a database that cannot answer the record of an end (migration not applied / rolled back under newer code): nothing is touched', async () => {
  const w = withThreads({ rpcError: 'service_end_result' });
  const response = await withdraw(w, ACK);
  assert.equal(response.status, 500);
  assert.equal(error(response), 'FAILED');
  assert.ok(!w.effects.includes('x:run'), 'the X saga did not run');
  assert.ok(!w.effects.some((e) => e.startsWith('provider:')), 'no provider was read or cleaned');
  assert.ok(!w.effects.includes('rpc:record_provider_result') && !w.effects.includes('rpc:finish_owned_service'));
  assert.equal(w.state.services.x_autopost, 'deleting', 'begun, never ended; the lease was given back');
  assert.equal(w.state.threads, true, 'the Threads connection is intact');
  // an answer that is not an answer is as unreadable as no answer
  const strange = withThreads({ malformedEndResult: true });
  const refused = await withdraw(strange, ACK);
  assert.equal(refused.status, 500);
  assert.ok(!strange.effects.includes('x:run') && !strange.effects.some((e) => e.startsWith('provider:')));
  // the person's other device asking about an end that already happened does not get a "clean" answer from a missing record
  const ended = world({ x: 'ended', rpcError: 'service_end_result' });
  const again = await withdraw(ended);
  assert.equal(again.status, 500);
  assert.equal(error(again), 'FAILED');
});

test('a transient failure to record the unconfirmed pair is retried; a lasting one never lets X be "done" without it', async () => {
  const transient = world({ x: 'active', xRun: [pair(2, SNAP_A)], rpcFailOnce: { record_x_unconfirmed: 2 } });
  const ok = await withdraw(transient);
  assert.equal(ok.status, 200);
  assert.equal(bodyOf(ok).x_posts_unconfirmed, 2);
  assert.deepEqual(transient.state.svc?.recon, { x_posts_unconfirmed: 2, x_unconfirmed_snapshots: [SNAP_A] });
  assert.equal(transient.effects.filter((e) => e === 'rpc:record_x_unconfirmed').length, 3, 'two failures, one success');

  const lasting = world({ x: 'active', xRun: [pair(2, SNAP_A)], rpcError: 'record_x_unconfirmed' });
  const failed = await withdraw(lasting);
  assert.equal(failed.status, 500);
  assert.equal(error(failed), 'FAILED');
  assert.equal(bodyOf(failed).x_posts_unconfirmed, 2, 'the person is told the count in this answer');
  assert.equal(lasting.state.svc?.results?.x, 'reconciliation_required', 'X is not on record as done');
  assert.equal(lasting.state.services.x_autopost, 'deleting', 'nothing ended');
  assert.ok(!lasting.effects.includes('rpc:finish_owned_service'));
  assert.equal(lasting.effects.filter((e) => e === 'rpc:record_x_unconfirmed').length, 3, 'bounded');
  assert.deepEqual(lasting.state.xAcks, [], 'and the saga was never told it may forget the set');
});

test('the saga\'s checkpoint is acknowledged by its SNAPSHOT, only after the pair is on record here; a failed acknowledgement ends nothing wrong', async () => {
  const w = world({ x: 'active', xRun: [pair(2, SNAP_A)] });
  const response = await withdraw(w);
  assert.equal(response.status, 200);
  assert.deepEqual(w.state.xAcks, [SNAP_A]);
  assert.deepEqual(w.state.xAckArgs, [{ p_user_id: USER, p_snapshot: SNAP_A }], 'exactly the person and the snapshot: no count');
  const order = w.effects.filter((e) => e === 'rpc:record_x_unconfirmed' || e === 'rpc:ack_x_unconfirmed');
  assert.deepEqual(order, ['rpc:record_x_unconfirmed', 'rpc:ack_x_unconfirmed'], 'recorded first, then acknowledged');
  assert.ok(!w.effects.includes('rpc:record_reconciliation'), 'the count-only recorder is not used for a named set');
  // an acknowledgement that fails (the saga has no such function, or it answers an error) leaves the saga over-reporting
  const lacking = world({ x: 'active', xRun: [pair(2, SNAP_A)], rpcError: 'ack_x_unconfirmed' });
  const ended = await withdraw(lacking);
  assert.equal(ended.status, 200);
  assert.equal(bodyOf(ended).x_posts_unconfirmed, 2);
  assert.deepEqual(lacking.state.svc?.recon, { x_posts_unconfirmed: 2, x_unconfirmed_snapshots: [SNAP_A] });
  // nothing unconfirmed: nothing to acknowledge, nothing recorded
  const clean = world({ x: 'active' });
  assert.equal((await withdraw(clean)).status, 200);
  assert.deepEqual(clean.state.xAcks, []);
  assert.deepEqual(clean.state.svc?.recon, {});
  // the pair could not be recorded: the saga's checkpoint is NOT acknowledged (it is then the only copy left)
  const unrecorded = world({ x: 'active', xRun: [pair(2, SNAP_A)], rpcError: 'record_x_unconfirmed' });
  assert.equal((await withdraw(unrecorded)).status, 500);
  assert.deepEqual(unrecorded.state.xAcks, []);
});

test('the saga\'s set changed under the acknowledgement: the NEW pair is recorded first, then acknowledged; never blindly the old one', async () => {
  const w = world({
    x: 'active', xRun: [pair(2, SNAP_A)],
    xAckAnswers: [{ status: 'snapshot_changed', x_posts_unconfirmed: 5, x_unconfirmed_snapshot: SNAP_B }],
  });
  const response = await withdraw(w);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(bodyOf(response).x_posts_unconfirmed, 5, 'the larger set is what the person is told');
  assert.deepEqual(w.state.xAcks, [SNAP_A, SNAP_B]);
  assert.deepEqual(w.effects.filter((e) => e === 'rpc:record_x_unconfirmed' || e === 'rpc:ack_x_unconfirmed'),
    ['rpc:record_x_unconfirmed', 'rpc:ack_x_unconfirmed', 'rpc:record_x_unconfirmed', 'rpc:ack_x_unconfirmed']);
  assert.deepEqual(w.state.svc?.recon, { x_posts_unconfirmed: 5, x_unconfirmed_snapshots: [SNAP_A, SNAP_B] }, 'both sets stay on record');
  // a changing set is followed a bounded number of times, and the last one seen is still RECORDED (never lost)
  const names = ['d', 'e', 'f', 'g', 'h'].map((c) => c.repeat(64));
  const churn = world({
    x: 'active', xRun: [pair(1, SNAP_A)],
    xAckAnswers: names.map((snapshot, i) => ({ status: 'snapshot_changed', x_posts_unconfirmed: 2 + i, x_unconfirmed_snapshot: snapshot })),
  });
  const churned = await withdraw(churn);
  assert.equal(churned.status, 200);
  assert.equal(churn.state.xAcks.length, 3, 'three rounds, no more');
  assert.deepEqual(churn.state.svc?.recon?.x_unconfirmed_snapshots, [SNAP_A, names[0], names[1], names[2]], 'the fourth set is recorded, not acknowledged');
  assert.equal(bodyOf(churned).x_posts_unconfirmed, 4);
});

const SNAP_D = 'd'.repeat(64);
const SNAP_E = 'e'.repeat(64);
const changed = (count: number, snapshot: string) => ({ status: 'snapshot_changed', x_posts_unconfirmed: count, x_unconfirmed_snapshot: snapshot });
/** Makes recording of the named evidence sets fail (a database error), counting the attempts per name. */
function failRecordOf(w: World, names: string[]) {
  const attempts: Record<string, number> = {};
  const original = w.deps.rpc;
  w.deps.rpc = (name, args) => {
    if (name === 'record_x_unconfirmed' && typeof args.p_snapshot === 'string' && names.includes(args.p_snapshot)) {
      attempts[args.p_snapshot] = (attempts[args.p_snapshot] ?? 0) + 1;
      w.effects.push(`rpc:${name}`);
      return Promise.resolve({ ok: false });
    }
    return original(name, args);
  };
  return attempts;
}

test('J3 V3 P2 R1: a larger set learned from the saga is shown even when it cannot be recorded; nothing unrecorded is acknowledged or ended', async () => {
  // the saga answers 1 / S1 (recorded); at the acknowledgement it reports 9 / S2; recording S2 fails every time
  const w = world({ x: 'active', xRun: [pair(1, SNAP_A)], xAckAnswers: [changed(9, SNAP_B)] });
  const attempts = failRecordOf(w, [SNAP_B]);
  const response = await withdraw(w);
  assert.equal(response.status, 500, JSON.stringify(response.body));
  assert.equal(error(response), 'FAILED');
  assert.equal(bodyOf(response).x_posts_unconfirmed, 9, 'the person is told the count the saga reported, not the older recorded one');
  assert.equal(attempts[SNAP_B], 3, 'bounded: three tries to record S2');
  assert.deepEqual(w.state.svc?.recon, { x_posts_unconfirmed: 1, x_unconfirmed_snapshots: [SNAP_A] }, 'the durable record is exactly the old one');
  assert.deepEqual(w.state.xAcks, [SNAP_A], 'S2 was never acknowledged');
  assert.equal(w.state.svc?.results.x, 'reconciliation_required', 'X is not recorded as done');
  assert.ok(!w.effects.includes('rpc:finish_owned_service'), 'the service is not finished');
  assert.equal(w.state.services.x_autopost, 'deleting');
  assert.equal(w.state.login, true, 'the login is untouched');
  // the same for the whole account: the person's login is NOT deleted, and the larger count is in the answer
  const whole = world({ x: 'active', xRun: [pair(1, SNAP_A)], xAckAnswers: [changed(9, SNAP_B)], gate: 'open' });
  failRecordOf(whole, [SNAP_B]);
  const refused = await handleDeleteCommonAccount({ authorization: bearer(signIn()), body: deleteBody(whole.state.version) }, whole.deps);
  assert.equal(refused.status, 500, JSON.stringify(refused.body));
  assert.equal(bodyOf(refused).x_posts_unconfirmed, 9);
  assert.equal(whole.state.login, true, 'the common login is not deleted');
  assert.equal(whole.state.calls.delete, 0);
});

test('J3 V3 P2 R1: the record failure of the LAST bounded attempt reports the largest count observed', async () => {
  // three acknowledgements each follow a changed set (2, 3, 4); the fourth pair is the one that is only recorded
  const w = world({
    x: 'active', xRun: [pair(1, SNAP_A)],
    xAckAnswers: [changed(2, SNAP_B), changed(3, SNAP_C), changed(4, SNAP_D), changed(9, SNAP_E)],
  });
  failRecordOf(w, [SNAP_D]);
  const response = await withdraw(w);
  assert.equal(response.status, 500, JSON.stringify(response.body));
  assert.equal(bodyOf(response).x_posts_unconfirmed, 4, 'the count of the pair that could not be recorded is not lost');
  assert.deepEqual(w.state.svc?.recon, { x_posts_unconfirmed: 3, x_unconfirmed_snapshots: [SNAP_A, SNAP_B, SNAP_C] });
  assert.deepEqual(w.state.xAcks, [SNAP_A, SNAP_B, SNAP_C], 'three acknowledgements; the unrecorded set is never acknowledged');
  assert.ok(!w.effects.includes('rpc:finish_owned_service'));
  assert.equal(w.state.services.x_autopost, 'deleting');
});

test('J3 V3 P2 R1: a changed answer with a malformed name is neither recorded nor acknowledged, and an observed count is never lowered', async () => {
  const w = world({ x: 'active', xRun: [pair(5, SNAP_A)], xAckAnswers: [changed(9, 'NOT-A-SNAPSHOT')] });
  const response = await withdraw(w);
  // characterized, unchanged: an unusable answer clears nothing; the end completes non-clean with what is on record
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(bodyOf(response).x_posts_unconfirmed, 5);
  assert.deepEqual(w.state.svc?.recon, { x_posts_unconfirmed: 5, x_unconfirmed_snapshots: [SNAP_A] }, 'no malformed name was recorded');
  assert.deepEqual(w.state.xAcks, [SNAP_A], 'and none was acknowledged');
  assert.equal(w.effects.filter((e) => e === 'rpc:record_x_unconfirmed').length, 1);
  // a later changed answer with a SMALLER count never lowers what was observed or recorded
  const lower = world({ x: 'active', xRun: [pair(5, SNAP_A)], xAckAnswers: [changed(2, SNAP_B)] });
  failRecordOf(lower, [SNAP_B]);
  const stopped = await withdraw(lower);
  assert.equal(stopped.status, 500);
  assert.equal(bodyOf(stopped).x_posts_unconfirmed, 5, 'the maximum observed, even though the later set was smaller');
});

test('an acknowledgement that clears nothing never loses or lowers the evidence', async () => {
  const answers: [string, Record<string, unknown> | 'error'][] = [
    ['deletion in progress', { status: 'deletion_in_progress' }],
    ['the count-only refusal', { status: 'snapshot_required' }],
    ['an empty set (cleared elsewhere)', { status: 'snapshot_changed', x_posts_unconfirmed: 0, x_unconfirmed_snapshot: null }],
    ['an unreadable answer', { weird: true }],
    ['an acknowledgement without a cleared count', { status: 'acknowledged', replay: false }],
    ['a changed set with a malformed name', { status: 'snapshot_changed', x_posts_unconfirmed: 2, x_unconfirmed_snapshot: 'XYZ' }],
    ['a failed call', 'error'],
  ];
  for (const [label, answer] of answers) {
    const w = world({ x: 'active', xRun: [pair(3, SNAP_A)], xAckAnswers: [answer] });
    const response = await withdraw(w);
    assert.equal(response.status, 200, label);
    assert.equal(bodyOf(response).x_posts_unconfirmed, 3, label);
    assert.deepEqual(w.state.svc?.recon, { x_posts_unconfirmed: 3, x_unconfirmed_snapshots: [SNAP_A] }, label);
    assert.deepEqual(w.state.xAcks, [SNAP_A], `${label}: asked once for that snapshot, nothing else`);
  }
  // a replay of an acknowledgement that already happened is an acknowledgement
  const replay = world({ x: 'active', xRun: [pair(3, SNAP_A)], xAckAnswers: [{ status: 'acknowledged', replay: true, cleared: 3 }] });
  assert.equal((await withdraw(replay)).status, 200);
});

test('a count whose evidence set has no name is kept, never acknowledged and never "done"', async () => {
  const w = world({ x: 'active', xRun: [{ outcome: 'done', unconfirmedPosts: 3 }] });
  const response = await withdraw(w);
  assert.equal(response.status, 502);
  assert.equal(error(response), 'X_CLEANUP_FAILED');
  assert.equal(bodyOf(response).x_posts_unconfirmed, 3);
  assert.deepEqual(w.state.svc?.recon, { x_posts_unconfirmed: 3 }, 'the count is kept (count-only record)');
  assert.deepEqual(w.state.xAcks, [], 'and nothing is acknowledged');
  assert.equal(w.state.svc?.results.x, 'reconciliation_required');
  assert.equal(w.state.services.x_autopost, 'deleting');
  // a malformed name is the same as none
  const malformed = world({ x: 'active', xRun: [{ outcome: 'done', unconfirmedPosts: 3, unconfirmedSnapshot: 'NOT-HEX' }] });
  assert.equal(error(await withdraw(malformed)), 'X_CLEANUP_FAILED');
  assert.deepEqual(malformed.state.xAcks, []);
});

test('a lease lost while the unconfirmed pair is recorded: nothing is acknowledged, nothing is ended', async () => {
  const w = world({ x: 'active', xRun: [pair(2, SNAP_A)] });
  w.deps.x.run = () => { lose(w); return Promise.resolve(pair(2, SNAP_A)); };
  const response = await withdraw(w);
  assert.equal(error(response), 'DELETION_IN_PROGRESS');
  assert.equal(w.state.services.x_autopost, 'deleting');
  assert.deepEqual(w.state.xAcks, [], 'the saga still holds the set: the next owner records and acknowledges it');
  assert.deepEqual(w.state.svc?.recon, {}, 'nothing was written by the stale owner');
});

test('a lease lost between the record and the acknowledgement: the set IS on record, so nothing is lost; the next owner ends it', async () => {
  const w = world({ x: 'active', xRun: [pair(2, SNAP_A)] });
  const original = w.deps.rpc;
  w.deps.rpc = async (name, args) => {
    const result = await original(name, args);
    if (name === 'record_x_unconfirmed') lose(w);   // the lease runs out right after the pair was recorded
    return result;
  };
  const first = await withdraw(w);
  assert.equal(error(first), 'DELETION_IN_PROGRESS');
  assert.deepEqual(w.state.svc?.recon, { x_posts_unconfirmed: 2, x_unconfirmed_snapshots: [SNAP_A] });
  assert.equal(w.state.services.x_autopost, 'deleting');
  w.deps.rpc = original;
  w.state.xWorkspace = true;
  const second = await withdraw(w);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(bodyOf(second).x_posts_unconfirmed, 2);
  assert.ok(w.state.xAcks.includes(SNAP_A), 'acknowledged by the owner that finished');
});

test('another app\'s entitlement neither breaks nor is touched by ending POSTONA; the whole-account deletion cannot complete past a service it cannot end', async () => {
  const other = [{ service_key: 'future_app', status: 'active' }];
  const w = world({ x: 'active', xRun: [pair(2, SNAP_A)], otherServices: other });
  const response = await withdraw(w);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(bodyOf(response).outcome, 'ended');
  assert.equal(w.state.services.x_autopost, 'ended');
  assert.equal(w.state.services.kabumori, 'active', 'Kabumori is untouched');
  assert.deepEqual(other, [{ service_key: 'future_app', status: 'active' }], 'the other app\'s entitlement is untouched');
  assert.equal(w.state.login, true, 'the login stays');
  // a key that is not a service key at all is still an unreadable answer (nothing is touched)
  const strange = world({ x: 'active', otherServices: [{ service_key: 'Bad Key!', status: 'active' }] });
  assert.equal((await withdraw(strange)).status, 500);
  assert.ok(!strange.effects.includes('x:run'));
  // the whole account: the unknown service is not ended by this code, so the login is never deleted
  const whole = world({ x: 'active', kabumori: 'active', gate: 'open', otherServices: [{ service_key: 'future_app', status: 'active' }] });
  const refused = await handleDeleteCommonAccount({ authorization: bearer(signIn()), body: deleteBody(whole.state.version) }, whole.deps);
  assert.notEqual(refused.status, 200, JSON.stringify(refused.body));
  assert.equal(whole.state.login, true, 'the login is not deleted');
  assert.equal(whole.calls?.delete ?? whole.state.calls.delete, 0);
});

test('the saga\'s typed answers keep their reason; none of them is a success', async () => {
  for (const [answer, code, status, reason] of [
    [{ outcome: 'blocked', reason: 'POSTING_IN_PROGRESS' }, 'X_CLEANUP_BLOCKED', 409, 'POSTING_IN_PROGRESS'],
    [{ outcome: 'blocked', reason: 'NON_X_ACCOUNT_PRESENT' }, 'X_CLEANUP_BLOCKED', 409, 'NON_X_ACCOUNT_PRESENT'],
    [{ outcome: 'failed', reason: 'X_REVOKE_FAILED' }, 'X_CLEANUP_FAILED', 502, 'X_REVOKE_FAILED'],
    [{ outcome: 'failed', reason: 'FINALIZE_FAILED' }, 'X_CLEANUP_FAILED', 502, 'FINALIZE_FAILED'],
    [{ outcome: 'blocked', reason: 'SOMETHING_NEW' }, 'X_CLEANUP_BLOCKED', 409, 'UNKNOWN'],
  ] as const) {
    const w = world({ x: 'active', xRun: [answer] });
    const response = await withdraw(w);
    assert.equal(error(response), code, JSON.stringify(answer));
    assert.equal(response.status, status);
    assert.deepEqual((response.body as { reasons?: string[] }).reasons, [reason], JSON.stringify(answer));
    assert.equal(w.state.services.x_autopost, 'deleting', 'never ended');
    assert.equal(w.state.svc?.results.x, answer.outcome === 'blocked' ? 'blocked' : 'reconciliation_required');
  }
});

test('the whole account reports the unconfirmed X posts too', async () => {
  const w = world({ x: 'active', xRun: [pair(5, SNAP_C)], gate: 'open' });
  const response = await handleDeleteCommonAccount({ authorization: bearer(signIn()), body: deleteBody(w.state.version) }, w.deps);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(bodyOf(response).outcome, 'deleted');
  assert.equal(bodyOf(response).x_posts_unconfirmed, 5);
});

test('an answer nobody expected: the operator override records an acknowledgement; without it everything stops', async () => {
  // World without a connected Threads row in the snapshot: no acknowledgement was asked, yet the adapter answers
  // "local removed, remote unverified" (a leftover credential).
  const stopped = world({ x: 'active' });
  stopped.deps.providers = [{ ...threads(stopped), hasConnection: async () => true }];
  const refusal = await withdraw(stopped);
  assert.equal(error(refusal), 'PROVIDER_REMOTE_UNVERIFIED');
  assert.equal(stopped.state.services.x_autopost, 'deleting');
  const overridden = world({ x: 'active' });
  overridden.deps.providers = [{ ...threads(overridden), hasConnection: async () => true }];
  overridden.deps.acceptRemoteUnverified = true;
  const done = await withdraw(overridden);
  assert.equal(done.status, 200);
  assert.deepEqual(overridden.state.svc?.ack, ['threads'], 'the override is on the record, not silent');
});

test('POSTONA alone is refused while a whole-account deletion is open; the account deletion is told about a live POSTONA owner', async () => {
  const w = world({ x: 'active' });
  const deleting = await handleDeleteCommonAccount({ authorization: bearer(signIn()), body: deleteBody(w.state.version) }, w.deps);
  assert.equal(deleting.status, 200);
  const blocked = world({ x: 'active', accountStatus: 'locked' });
  assert.deepEqual((await withdraw(blocked)).body, { ok: false, error: 'WITHDRAW_BLOCKED', reasons: ['ACCOUNT_LOCKED'] });

  // A POSTONA-only owner is running (its lease is live); an account deletion that starts meanwhile does not take it over.
  const arrived = deferred();
  const go = deferred();
  let paused = false;
  const racing = world({ x: 'active', hooks: { x: async () => { if (!paused) { paused = true; arrived.resolve(); await go.promise; } } } });
  const first = withdraw(racing);
  await arrived.promise;
  const account = await handleDeleteCommonAccount({ authorization: bearer(signIn()), body: deleteBody(racing.state.version) }, racing.deps);
  assert.equal(error(account), 'DELETION_IN_PROGRESS');
  go.resolve();
  assert.equal((await first).status, 200);
  assert.equal(racing.state.services.x_autopost, 'ended');
});

test('the service operation is the person\'s own: a revoked token reaches nothing', async () => {
  const w = withThreads();
  const token = signIn();
  w.state.revokedTokens.add(token);
  const response = await withdraw(w, ACK, token);
  assert.equal(error(response), 'AUTH_REQUIRED');
  assert.deepEqual(w.effects.filter((e) => e.startsWith('rpc:')), []);
});

test('an unreadable connection is not "not connected": it is on the record as unreconciled and stops the end', async () => {
  const w = world({ x: 'active', threads: true });
  w.deps.providers = [{ provider: 'threads', hasConnection: async () => null, cleanup: async () => 'blocked' }];
  const response = await withdraw(w, ACK);
  assert.equal(error(response), 'RECONCILIATION_REQUIRED');
  assert.equal(w.state.svc?.results.threads, 'reconciliation_required');
  assert.equal(w.state.services.x_autopost, 'deleting');
});

test('a person with only X: ended through the saga alone; no provider is asked for an acknowledgement', async () => {
  const w = world({ x: 'active' });
  const response = await withdraw(w);
  assert.deepEqual(response.body, { ok: true, outcome: 'ended', providers: { x: 'done' } });
  assert.equal(w.state.services.kabumori, 'active');
});

test('a connection that appears between the read-only check and the claim is caught under the lease, before any removal', async () => {
  // The first snapshot (the preflight) shows only X; the second (under the lease) shows Threads as well.
  const w = world({ x: 'active' });
  let calls = 0;
  w.answers.provider_snapshot = () => ({ workspace: 'u_fixture', platforms: ++calls === 1 ? ['x'] : ['x', 'threads'] });
  w.deps.providers = [threads(w)];
  const unacknowledged = await withdraw(w);
  assert.equal(error(unacknowledged), 'REMOTE_UNVERIFIED_ACK_REQUIRED');
  assert.deepEqual(bodyOf(unacknowledged).providers, [{ provider: 'threads', result: 'pending' }]);
  assert.equal(w.state.services.x_autopost, 'deleting', 'it began, so new connections are refused; nothing was removed');
  assert.ok(!w.effects.includes('x:run') && !w.effects.includes('provider:threads:cleanup'));
  assert.equal(w.state.svc?.lease, null, 'the lease was given back');

  const bare = world({ x: 'active' });
  let n = 0;
  bare.answers.provider_snapshot = () => ({ workspace: 'u_fixture', platforms: ++n === 1 ? ['x'] : ['x', 'threads'] });
  const missing = await withdraw(bare, ACK);
  assert.equal(error(missing), 'PROVIDER_ADAPTER_MISSING');
  assert.equal(bare.state.svc?.results.threads, 'blocked', 'recorded durably');
  assert.ok(!bare.effects.includes('x:run'));
});

test('an account deletion that is open stops POSTONA alone before anything is called', async () => {
  const w = world({ x: 'active' });
  w.state.account = 'deleting';
  const response = await withdraw(w);
  assert.deepEqual(response.body, { ok: false, error: 'WITHDRAW_BLOCKED', reasons: ['ACCOUNT_DELETION_IN_PROGRESS'] });
  assert.ok(!w.effects.includes('rpc:begin_service_deletion') && !w.effects.includes('x:run'));
});
