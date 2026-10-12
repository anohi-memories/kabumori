import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runProviderCleanups,
  type ProviderCleanupAdapter,
  type ProviderCleanupContext,
  type ProviderOutcome,
} from './provider_cleanup.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const owned = { stillOwned: async () => true };
const adapter = (
  provider: string,
  connected: boolean | null | 'throw',
  outcome: ProviderOutcome | 'throw' | 'garbage' | 'hang' = 'confirmed_remote_revoked',
  calls: string[] = [],
): ProviderCleanupAdapter => ({
  provider,
  hasConnection: async () => {
    calls.push(`${provider}:has`);
    if (connected === 'throw') throw new Error('secret-detail');
    return connected;
  },
  cleanup: async () => {
    calls.push(`${provider}:cleanup`);
    if (outcome === 'throw') throw new Error('secret-detail');
    if (outcome === 'hang') return await new Promise<ProviderOutcome>(() => {});
    return outcome as ProviderOutcome;
  },
});

test('no adapter registered: nothing is called and the deletion proceeds', async () => {
  const report = await runProviderCleanups([], USER, owned);
  assert.deepEqual(report, { decision: 'proceed', providers: [], remoteUnverified: [] });
});

test('a person without a connection is not cleaned and not blocked', async () => {
  const calls: string[] = [];
  const report = await runProviderCleanups([adapter('threads', false, 'confirmed_remote_revoked', calls)], USER, owned);
  assert.equal(report.decision, 'proceed');
  assert.deepEqual(report.providers, [{ provider: 'threads', result: 'not_connected' }]);
  assert.deepEqual(calls, ['threads:has']);
});

test('a confirmed revoke proceeds; a local-only removal proceeds but is reported as remote unverified', async () => {
  const confirmed = await runProviderCleanups([adapter('threads', true, 'confirmed_remote_revoked')], USER, owned);
  assert.equal(confirmed.decision, 'proceed');
  assert.deepEqual(confirmed.remoteUnverified, []);
  const local = await runProviderCleanups([adapter('threads', true, 'local_removed_remote_unverified')], USER, owned);
  assert.equal(local.decision, 'proceed');
  assert.deepEqual(local.remoteUnverified, ['threads']);
});

test('blocked and reconciliation: reconciliation wins, and every adapter still runs in a fixed order', async () => {
  const calls: string[] = [];
  const report = await runProviderCleanups([
    adapter('instagram', true, 'blocked', calls),
    adapter('threads', true, 'reconciliation_required', calls),
    adapter('zeta', true, 'confirmed_remote_revoked', calls),
  ], USER, owned);
  assert.equal(report.decision, 'reconciliation_required');
  assert.deepEqual(calls, ['instagram:has', 'instagram:cleanup', 'threads:has', 'threads:cleanup', 'zeta:has', 'zeta:cleanup']);
  const onlyBlocked = await runProviderCleanups([adapter('instagram', true, 'blocked'), adapter('threads', true, 'confirmed_remote_revoked')], USER, owned);
  assert.equal(onlyBlocked.decision, 'blocked');
});

test('an unreadable presence, a throw, an unknown answer and a hang are never success', async () => {
  for (const candidate of [
    adapter('threads', null),
    adapter('threads', 'throw'),
    adapter('threads', true, 'throw'),
    adapter('threads', true, 'garbage'),
    adapter('threads', true, 'hang'),
  ]) {
    const report = await runProviderCleanups([candidate], USER, { ...owned, timeoutMs: 30 });
    assert.equal(report.decision, 'reconciliation_required');
    assert.ok(!JSON.stringify(report).includes('secret-detail'), 'no adapter message leaves the module');
  }
});

test('configuration errors are blocked: reserved, malformed and duplicate keys never run', async () => {
  const calls: string[] = [];
  for (const keys of [['x'], ['kabumori'], ['Threads'], ['t'], ['threads', 'threads'], ['a-b']]) {
    const report = await runProviderCleanups(keys.map((key) => adapter(key, true, 'confirmed_remote_revoked', calls)), USER, owned);
    assert.equal(report.decision, 'blocked', keys.join(','));
  }
  assert.deepEqual(calls, [], 'an invalid registry runs nothing it could mis-route');
  const mixed = await runProviderCleanups([adapter('threads', true, 'confirmed_remote_revoked', calls), adapter('x', true)], USER, owned);
  assert.equal(mixed.decision, 'blocked');
  assert.deepEqual(calls, ['threads:has', 'threads:cleanup'], 'a valid adapter beside an invalid one still cleans');
});

test('the report carries only fixed keys and fixed result codes', async () => {
  const report = await runProviderCleanups([adapter('threads', true, 'local_removed_remote_unverified')], USER, owned);
  assert.deepEqual(Object.keys(report).sort(), ['decision', 'providers', 'remoteUnverified']);
  assert.deepEqual(Object.keys(report.providers[0]).sort(), ['provider', 'result']);
});

// --- H4-P4-R1: ownership is asked at every awaited boundary --------------------------------------------------
function counting(lostAfter: number | null) {
  let asked = 0;
  return {
    get asked() { return asked; },
    stillOwned: async () => { asked += 1; return lostAfter === null || asked <= lostAfter; },
  };
}

test('R1: ownership is asked after the read and after the cleanup of every adapter, never zero times', async () => {
  const owner = counting(null);
  const calls: string[] = [];
  const report = await runProviderCleanups([adapter('instagram', true, 'confirmed_remote_revoked', calls), adapter('threads', true, 'confirmed_remote_revoked', calls)], USER, owner);
  assert.equal(report.decision, 'proceed');
  assert.equal(owner.asked, 4, 'read + cleanup, for each of the two adapters');
});

test('R1: a lease lost after the read stops before the destructive call, and no later adapter is called', async () => {
  const owner = counting(0); // lost at the first question (after the read)
  const calls: string[] = [];
  const report = await runProviderCleanups([adapter('instagram', true, 'confirmed_remote_revoked', calls), adapter('threads', true, 'confirmed_remote_revoked', calls)], USER, owner);
  assert.equal(report.decision, 'lease_lost');
  assert.deepEqual(calls, ['instagram:has']);
  assert.deepEqual(report.providers, [{ provider: 'instagram', result: 'lease_lost' }]);
});

test('R1: a lease lost right after a cleanup discards its answer and stops before the next adapter', async () => {
  const calls: string[] = [];
  // Question 1 (after the read) is owned; question 2 (after the cleanup) is not: even a blocked answer is not used.
  const first = await runProviderCleanups([adapter('instagram', true, 'blocked', calls), adapter('threads', true, 'confirmed_remote_revoked', calls)], USER, counting(1));
  assert.equal(first.decision, 'lease_lost');
  assert.deepEqual(calls, ['instagram:has', 'instagram:cleanup'], 'the second adapter is never called');
});

test('R1: a lease lost at the next adapter\'s read: its destructive call is never made', async () => {
  const calls: string[] = [];
  const report = await runProviderCleanups([adapter('instagram', true, 'confirmed_remote_revoked', calls), adapter('threads', true, 'confirmed_remote_revoked', calls)], USER, counting(2));
  assert.equal(report.decision, 'lease_lost');
  assert.deepEqual(calls, ['instagram:has', 'instagram:cleanup', 'threads:has']);
});

test('R1: an ownership question that throws or answers anything but true is a lost lease', async () => {
  for (const stillOwned of [async () => { throw new Error('db down'); }, async () => false, async () => 'true' as unknown as boolean]) {
    const calls: string[] = [];
    const report = await runProviderCleanups([adapter('threads', true, 'confirmed_remote_revoked', calls)], USER, { stillOwned });
    assert.equal(report.decision, 'lease_lost');
    assert.deepEqual(calls, ['threads:has']);
  }
});

test('R1: after a timeout the abandoned adapter can neither see ownership nor ignore the signal', async () => {
  let captured: ProviderCleanupContext | undefined;
  const hanging: ProviderCleanupAdapter = {
    provider: 'threads',
    hasConnection: async () => true,
    cleanup: async (_user, context) => {
      captured = context;
      return await new Promise<ProviderOutcome>(() => {});
    },
  };
  const report = await runProviderCleanups([hanging], USER, { ...owned, timeoutMs: 20 });
  assert.equal(report.decision, 'reconciliation_required');
  assert.ok(captured, 'the adapter was handed a context');
  assert.equal(captured.signal.aborted, true, 'the signal is aborted when the port stops waiting');
  assert.equal(await captured.stillOwned(), false, 'a late continuation is told it does not own the deletion');
});

test('R1: while the port waits, the adapter sees the live answer of the database', async () => {
  const owner = counting(null);
  const seen: boolean[] = [];
  const probe: ProviderCleanupAdapter = {
    provider: 'threads',
    hasConnection: async () => true,
    cleanup: async (_user, context) => { seen.push(await context.stillOwned(), context.signal.aborted); return 'confirmed_remote_revoked'; },
  };
  const report = await runProviderCleanups([probe], USER, owner);
  assert.equal(report.decision, 'proceed');
  assert.deepEqual(seen, [true, false]);
});
