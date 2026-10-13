// Phase 6: ending POSTONA as one owned operation -- alone ("POSTONAの利用を終了") and, in provider_cleanup_flow_test.ts,
// inside the whole-account deletion. Over the same fake lifecycle database as lifecycle_logic_test.ts; the real
// database half (leases, results, acknowledgement) is proven in supabase/tests/common_account_service_deletion_*.
import assert from 'node:assert/strict';
import test from 'node:test';

import { bearer, deferred, deleteBody, signIn, world, type World, type WorldOptions } from './fake_lifecycle.ts';
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
  const order = ['rpc:begin_service_deletion', 'rpc:claim_service', 'x:run', 'provider:threads:has', 'rpc:finish_owned_service', 'rpc:release_service']
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
