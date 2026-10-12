import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runProviderCleanups,
  type ProviderCleanupAdapter,
  type ProviderOutcome,
} from './provider_cleanup.ts';

const USER = '11111111-1111-4111-8111-111111111111';
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
  const report = await runProviderCleanups([], USER);
  assert.deepEqual(report, { decision: 'proceed', providers: [], remoteUnverified: [] });
});

test('a person without a connection is not cleaned and not blocked', async () => {
  const calls: string[] = [];
  const report = await runProviderCleanups([adapter('threads', false, 'confirmed_remote_revoked', calls)], USER);
  assert.equal(report.decision, 'proceed');
  assert.deepEqual(report.providers, [{ provider: 'threads', result: 'not_connected' }]);
  assert.deepEqual(calls, ['threads:has']);
});

test('a confirmed revoke proceeds; a local-only removal proceeds but is reported as remote unverified', async () => {
  const confirmed = await runProviderCleanups([adapter('threads', true, 'confirmed_remote_revoked')], USER);
  assert.equal(confirmed.decision, 'proceed');
  assert.deepEqual(confirmed.remoteUnverified, []);
  const local = await runProviderCleanups([adapter('threads', true, 'local_removed_remote_unverified')], USER);
  assert.equal(local.decision, 'proceed');
  assert.deepEqual(local.remoteUnverified, ['threads']);
});

test('blocked and reconciliation: reconciliation wins, and every adapter still runs in a fixed order', async () => {
  const calls: string[] = [];
  const report = await runProviderCleanups([
    adapter('instagram', true, 'blocked', calls),
    adapter('threads', true, 'reconciliation_required', calls),
    adapter('zeta', true, 'confirmed_remote_revoked', calls),
  ], USER);
  assert.equal(report.decision, 'reconciliation_required');
  assert.deepEqual(calls, ['instagram:has', 'instagram:cleanup', 'threads:has', 'threads:cleanup', 'zeta:has', 'zeta:cleanup']);
  const onlyBlocked = await runProviderCleanups([adapter('instagram', true, 'blocked'), adapter('threads', true, 'confirmed_remote_revoked')], USER);
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
    const report = await runProviderCleanups([candidate], USER, { timeoutMs: 30 });
    assert.equal(report.decision, 'reconciliation_required');
    assert.ok(!JSON.stringify(report).includes('secret-detail'), 'no adapter message leaves the module');
  }
});

test('configuration errors are blocked: reserved, malformed and duplicate keys never run', async () => {
  const calls: string[] = [];
  for (const keys of [['x'], ['kabumori'], ['Threads'], ['t'], ['threads', 'threads'], ['a-b']]) {
    const report = await runProviderCleanups(keys.map((key) => adapter(key, true, 'confirmed_remote_revoked', calls)), USER);
    assert.equal(report.decision, 'blocked', keys.join(','));
  }
  assert.deepEqual(calls, [], 'an invalid registry runs nothing it could mis-route');
  const mixed = await runProviderCleanups([adapter('threads', true, 'confirmed_remote_revoked', calls), adapter('x', true)], USER);
  assert.equal(mixed.decision, 'blocked');
  assert.deepEqual(calls, ['threads:has', 'threads:cleanup'], 'a valid adapter beside an invalid one still cleans');
});

test('the report carries only fixed keys and fixed result codes', async () => {
  const report = await runProviderCleanups([adapter('threads', true, 'local_removed_remote_unverified')], USER);
  assert.deepEqual(Object.keys(report).sort(), ['decision', 'providers', 'remoteUnverified']);
  assert.deepEqual(Object.keys(report.providers[0]).sort(), ['provider', 'result']);
});
