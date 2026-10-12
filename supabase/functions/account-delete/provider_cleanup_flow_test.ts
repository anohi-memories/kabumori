// The provider cleanup step inside the whole-account deletion (Phase 4, T10): over the same fake lifecycle
// database as lifecycle_logic_test.ts. No real adapter exists yet; these are fakes of the port.
import assert from 'node:assert/strict';
import test from 'node:test';

import { bearer, deferred, deleteBody, signIn, world, type World } from './fake_lifecycle.ts';
import { handleDeleteCommonAccount, LEASE_SECONDS, type LifecycleResponse } from './lifecycle_logic.ts';
import type { ProviderCleanupAdapter, ProviderOutcome } from './provider_cleanup.ts';

const remove = (w: World) =>
  handleDeleteCommonAccount({ authorization: bearer(signIn()), body: deleteBody(w.state.version) }, w.deps);
const error = (response: LifecycleResponse) => (response.body.ok ? null : response.body.error);

function threads(w: World, outcome: () => ProviderOutcome | 'throw', connected: () => boolean | null = () => true): ProviderCleanupAdapter {
  return {
    provider: 'threads',
    hasConnection: async () => { w.effects.push('provider:threads:has'); return connected(); },
    cleanup: async () => {
      w.effects.push('provider:threads:cleanup');
      const answer = outcome();
      if (answer === 'throw') throw new Error('token=secret-value');
      return answer;
    },
  };
}
const at = (w: World, effect: string) => w.effects.indexOf(effect);

test('no provider adapter registered: the flow is the one without a provider step', async () => {
  const w = world({ x: 'active' });
  const response = await remove(w);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, outcome: 'deleted' });
  assert.ok(!w.effects.some((e) => e.startsWith('provider:')));
});

test('a confirmed provider is cleaned after the X saga and before POSTONA and Kabumori end; success is unchanged', async () => {
  const w = world({ x: 'active' });
  w.deps.providers = [threads(w, () => 'confirmed_remote_revoked')];
  const response = await remove(w);
  assert.deepEqual(response.body, { ok: true, outcome: 'deleted' });
  const order = ['x:run', 'provider:threads:has', 'provider:threads:cleanup', 'rpc:finish_service_deletion', 'rpc:withdraw_kabumori', 'auth:delete'].map((e) => at(w, e));
  assert.ok(order.every((index) => index >= 0), `all steps ran: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the canonical order');
});

test('a blocked provider stops before POSTONA ends, before sessions are revoked and before any delete', async () => {
  const w = world({ x: 'active' });
  w.deps.providers = [threads(w, () => 'blocked')];
  const response = await remove(w);
  assert.equal(response.status, 409);
  assert.equal(error(response), 'PROVIDER_CLEANUP_BLOCKED');
  assert.deepEqual((response.body as { providers: unknown }).providers, [{ provider: 'threads', result: 'blocked' }]);
  assert.equal(w.state.services.x_autopost, 'deleting', 'the POSTONA entitlement is not ended');
  assert.equal(w.state.services.kabumori, 'active');
  assert.equal(w.state.calls.sessions, 0);
  assert.equal(w.state.calls.delete, 0);
  assert.ok(w.state.op?.errors.includes('PROVIDER_CLEANUP_BLOCKED'), 'the fixed code is kept on the operation');
});

test('an unsettled provider is reconciliation, never replayed; after it is fixed the same operation resumes', async () => {
  const w = world({ x: 'active' });
  let answer: ProviderOutcome | 'throw' = 'throw';
  w.deps.providers = [threads(w, () => answer)];
  const first = await remove(w);
  assert.equal(error(first), 'RECONCILIATION_REQUIRED');
  assert.ok(!JSON.stringify(first).includes('secret-value'), 'the adapter message never leaves');
  assert.equal(w.state.services.x_autopost, 'deleting');
  assert.equal(w.state.calls.delete, 0);
  answer = 'confirmed_remote_revoked';
  const second = await remove(w);
  assert.deepEqual(second.body, { ok: true, outcome: 'deleted' });
  assert.equal(w.state.calls.delete, 1);
});

test('a provider that removed its local data but cannot confirm the remote grant stops by default', async () => {
  const w = world({ x: 'active' });
  w.deps.providers = [threads(w, () => 'local_removed_remote_unverified')];
  const response = await remove(w);
  assert.equal(error(response), 'PROVIDER_REMOTE_UNVERIFIED');
  assert.deepEqual((response.body as { providers: unknown }).providers, [{ provider: 'threads', result: 'local_removed_remote_unverified' }]);
  assert.equal(w.state.services.x_autopost, 'deleting');
  assert.equal(w.state.calls.delete, 0);
});

test('when remote-unverified is explicitly accepted the deletion completes and says which provider to revoke by hand', async () => {
  const w = world({ x: 'active' });
  w.deps.providers = [threads(w, () => 'local_removed_remote_unverified')];
  w.deps.acceptRemoteUnverified = true;
  const response = await remove(w);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, outcome: 'deleted', remote_unverified: ['threads'] });
});

test('a provider credential left behind a POSTONA that is already ended is still cleaned (or blocks)', async () => {
  const cleaned = world({ x: 'ended' });
  cleaned.deps.providers = [threads(cleaned, () => 'confirmed_remote_revoked')];
  assert.deepEqual((await remove(cleaned)).body, { ok: true, outcome: 'deleted' });
  assert.ok(cleaned.effects.includes('provider:threads:cleanup'));
  const blocked = world({ x: null });
  blocked.deps.providers = [threads(blocked, () => 'blocked')];
  assert.equal(error(await remove(blocked)), 'PROVIDER_CLEANUP_BLOCKED');
  assert.equal(blocked.state.calls.delete, 0);
});

test('a person with no connection is not touched and the deletion proceeds', async () => {
  const w = world({ x: 'active' });
  w.deps.providers = [threads(w, () => 'blocked', () => false)];
  const response = await remove(w);
  assert.deepEqual(response.body, { ok: true, outcome: 'deleted' });
  assert.ok(!w.effects.includes('provider:threads:cleanup'));
});

test('an unreadable presence is reconciliation (it is not assumed absent)', async () => {
  const w = world({ x: 'active' });
  w.deps.providers = [threads(w, () => 'confirmed_remote_revoked', () => null)];
  assert.equal(error(await remove(w)), 'RECONCILIATION_REQUIRED');
  assert.equal(w.state.calls.delete, 0);
});

test('an owner that lost its lease never calls a provider adapter and never reports success', async () => {
  const arrived = deferred();
  const go = deferred();
  let paused = false;
  const w = world({ x: 'active', hooks: { x: async () => { if (!paused) { paused = true; arrived.resolve(); await go.promise; } } } });
  w.deps.providers = [threads(w, () => 'confirmed_remote_revoked')];
  const first = remove(w);
  await arrived.promise; // the owner hangs inside the X saga (a crash, from everyone else's view)
  w.state.clock += LEASE_SECONDS + 1;
  go.resolve();
  const stale = await first;
  assert.equal(error(stale), 'DELETION_IN_PROGRESS');
  assert.ok(!w.effects.includes('provider:threads:cleanup') && !w.effects.includes('provider:threads:has'),
    'the provider was not touched at all by a stale owner (not even read)');
  assert.equal(w.state.calls.delete, 0);
});

// --- H4-P4-R1: the lease is re-checked at every awaited boundary of the provider step ------------------------
// A lease lost while an adapter awaits (the synthetic clock moves past the lease) must stop the next
// destructive call, the next provider and the end of the POSTONA entitlement; the stale owner never
// reports success. The HTTP 409 alone is not enough: nothing external may have run after the loss.
const lose = (w: World) => { w.state.clock += LEASE_SECONDS + 1; };

test('R1-A: the lease is lost while hasConnection awaits -- no cleanup, POSTONA is not ended', async () => {
  const w = world({ x: 'active' });
  const calls: string[] = [];
  w.deps.providers = [{
    provider: 'threads',
    hasConnection: async () => { calls.push('has'); lose(w); return true; },
    cleanup: async () => { calls.push('cleanup'); return 'confirmed_remote_revoked'; },
  }];
  const response = await remove(w);
  assert.equal(error(response), 'DELETION_IN_PROGRESS');
  assert.deepEqual(calls, ['has'], 'the destructive cleanup was never called by a stale owner');
  assert.equal(w.state.services.x_autopost, 'deleting', 'the POSTONA entitlement was not ended');
  assert.equal(w.state.calls.delete, 0);
});

test('R1-B: the lease is lost during the first provider\'s cleanup -- the next provider is never called', async () => {
  const w = world({ x: 'active' });
  const calls: string[] = [];
  const named = (provider: string, onCleanup?: () => void): ProviderCleanupAdapter => ({
    provider,
    hasConnection: async () => { calls.push(`${provider}:has`); return true; },
    cleanup: async () => { calls.push(`${provider}:cleanup`); onCleanup?.(); return 'confirmed_remote_revoked'; },
  });
  w.deps.providers = [named('instagram', () => lose(w)), named('threads')];
  const response = await remove(w);
  assert.equal(error(response), 'DELETION_IN_PROGRESS');
  assert.deepEqual(calls, ['instagram:has', 'instagram:cleanup'], 'the second provider was not touched by a stale owner');
  assert.equal(w.state.services.x_autopost, 'deleting');
  assert.equal(w.state.calls.delete, 0);
});

test('R1-C: the lease is lost during the LAST cleanup -- the entitlement is not ended on its answer', async () => {
  const w = world({ x: 'active' });
  const calls: string[] = [];
  w.deps.providers = [{
    provider: 'threads',
    hasConnection: async () => true,
    cleanup: async () => { calls.push('cleanup'); lose(w); return 'confirmed_remote_revoked'; },
  }];
  const response = await remove(w);
  assert.equal(error(response), 'DELETION_IN_PROGRESS');
  assert.deepEqual(calls, ['cleanup']);
  assert.equal(w.state.services.x_autopost, 'deleting', 'finish_service_deletion was not called');
  assert.ok(!w.effects.includes('rpc:finish_service_deletion'));
});

test('R1-D: a POSTONA that was never started: a stale owner still never cleans a leftover provider', async () => {
  const w = world({ x: null });
  const calls: string[] = [];
  w.deps.providers = [{
    provider: 'threads',
    hasConnection: async () => { calls.push('has'); lose(w); return true; },
    cleanup: async () => { calls.push('cleanup'); return 'confirmed_remote_revoked'; },
  }];
  const response = await remove(w);
  assert.equal(error(response), 'DELETION_IN_PROGRESS');
  assert.deepEqual(calls, ['has']);
  assert.equal(w.state.calls.delete, 0);
});

test('R1-E: the adapter is given a live ownership check: true while owned, false after the loss', async () => {
  const w = world({ x: 'active' });
  const seen: boolean[] = [];
  w.deps.providers = [{
    provider: 'threads',
    hasConnection: async () => true,
    cleanup: async (_user: string, context?: { stillOwned(): Promise<boolean>; signal: AbortSignal }) => {
      assert.ok(context, 'a context is passed');
      seen.push(await context.stillOwned());
      lose(w);
      seen.push(await context.stillOwned());
      seen.push(context.signal.aborted);
      return 'confirmed_remote_revoked';
    },
  } as ProviderCleanupAdapter];
  const response = await remove(w);
  assert.equal(error(response), 'DELETION_IN_PROGRESS');
  assert.deepEqual(seen, [true, false, false], 'owned before the loss, not owned after it; the signal is aborted only once the port stops waiting');
});

test('R1-F: a transient database failure of the ownership question is a stop, never a skip', async () => {
  const w = world({ x: 'active' });
  const original = w.answers.renew;
  let renews = 0;
  // 1: the step's own ownership check, 2: the provider step's entry, 3: right after the first read.
  w.answers.renew = (args) => {
    renews += 1;
    if (renews === 3) throw new Error('database unavailable');
    return original(args);
  };
  const calls: string[] = [];
  w.deps.providers = [{
    provider: 'threads',
    hasConnection: async () => { calls.push('has'); return true; },
    cleanup: async () => { calls.push('cleanup'); return 'confirmed_remote_revoked'; },
  }];
  const response = await remove(w);
  assert.equal(error(response), 'DELETION_IN_PROGRESS');
  assert.deepEqual(calls, ['has'], 'an unanswered ownership question never lets the destructive call through');
  assert.equal(w.state.services.x_autopost, 'deleting');
  assert.ok(!w.effects.includes('rpc:finish_service_deletion'), 'the entitlement was not ended after the early stop');
});
