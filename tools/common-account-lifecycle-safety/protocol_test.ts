// Decision-table regressions for the closure logic (Phase 3i). Synthetic facts only; no environment is touched.
// These test the PROPOSED logic. They are not evidence of how managed Supabase behaves.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOUNDARIES, claimedInvariants, decide, findOrphans, gate, LIMITS, unmetBoundaries, validate,
  type BoundaryName, type Decision, type Facts,
} from './protocol.ts';

const clone = <T>(v: T): T => structuredClone(v);

/** A closure that has everything done except the delete (the "ready" point). */
function ready(overrides: Partial<Facts> = {}): Facts {
  return {
    boundaries: Object.fromEntries(BOUNDARIES.map((b) => [b, 'attested'])) as Facts['boundaries'],
    account: 'deleting',
    operation: 'open',
    reauth: 'fresh',
    containment: { sessions: 'done', ban: 'done' },
    serviceData: 'clean',
    storage: { remaining: 0, consecutiveZeroReads: 2 },
    providers: { email: 'not_applicable', apple: 'revoked' },
    identities: { snapshot: ['email', 'apple'], current: ['email', 'apple'] },
    authDelete: 'not_attempted',
    postDelete: { serviceResidue: null, storageResidue: null, lateIdentityEvents: null },
    attempts: { cleanup: 0, delete: 0, orphan: 0 },
    elapsedSinceFreezeSec: 0,
    ...overrides,
  };
}
const started = (o: Partial<Facts> = {}): Facts => ready({ identities: { snapshot: null, current: ['email', 'apple'] }, ...o });
const after = (o: Partial<Facts> = {}): Facts => ready({ account: 'absent', authDelete: 'confirmed', identities: { snapshot: ['email', 'apple'], current: [] }, ...o });
const step = (d: Decision) => (d.kind === 'RUN' ? d.step : `${d.kind}:${'code' in d ? d.code : ''}`);

test('baseline: everything done and verified before the delete -> the delete, once', () => {
  assert.equal(step(decide(ready())), 'auth_delete');
});

test('a boundary that is not attested STOPs the closure before anything runs (F4: nothing else denies the old token)', () => {
  for (const name of ['state_predicate', 'writer_guard', 'person_token_edge_checks', 'orphan_sweeper'] as BoundaryName[]) {
    for (const status of ['missing', 'unknown'] as const) {
      const f = ready({ account: 'active', operation: 'none' });
      f.boundaries[name] = status;
      const d = decide(f);
      assert.deepEqual([d.kind, 'code' in d ? d.code : ''], ['STOP', 'BOUNDARY_UNPROVEN'], `${name}=${status}`);
      assert.ok('detail' in d && d.detail.includes(name));
    }
  }
});

test('F6: the orphan sweeper is always required; the Storage write policy only widens what may be claimed', () => {
  const b = (policy: 'attested' | 'missing', sweeper: 'attested' | 'missing') => ({
    ...ready().boundaries, storage_write_policy: policy, orphan_sweeper: sweeper,
  });
  assert.deepEqual(unmetBoundaries(b('attested', 'attested')), []);
  assert.deepEqual(unmetBoundaries(b('missing', 'attested')), [], 'no Storage policy: the closure may run, I3 is simply not claimed');
  assert.deepEqual(unmetBoundaries(b('attested', 'missing')), ['orphan_sweeper'], 'a policy is not a substitute for the sweeper');
  assert.deepEqual(unmetBoundaries(b('missing', 'missing')), ['orphan_sweeper']);
});

test('claims never exceed the attested boundaries', () => {
  const all = ready().boundaries;
  assert.deepEqual(claimedInvariants(all), ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7']);
  assert.deepEqual(claimedInvariants({ ...all, storage_write_policy: 'missing' }), ['I1', 'I2', 'I4', 'I5', 'I6', 'I7'], 'I3 needs the Storage policy');
  assert.deepEqual(claimedInvariants({ ...all, state_predicate: 'unknown' }), ['I4', 'I5', 'I6', 'I7'], 'no data-plane claim without the predicate');
  assert.deepEqual(claimedInvariants({ ...all, writer_guard: 'missing' }), ['I4', 'I5', 'I6', 'I7']);
  assert.deepEqual(claimedInvariants({ ...all, person_token_edge_checks: 'missing' }), ['I4', 'I5', 'I6', 'I7']);
  assert.deepEqual(claimedInvariants({ ...all, orphan_sweeper: 'missing' }), ['I1', 'I2', 'I3', 'I4', 'I5', 'I6']);
});

test('malformed or incomplete facts are never interpreted', () => {
  const bad: unknown[] = [null, 'x', 7, {}, { ...ready(), account: 'deactivated' }, { ...ready(), storage: { remaining: -1, consecutiveZeroReads: 0 } },
    { ...ready(), providers: { apple: 'maybe' } }, { ...ready(), attempts: { cleanup: -1, delete: 0, orphan: 0 } },
    { ...ready(), elapsedSinceFreezeSec: Number.NaN }, { ...ready(), boundaries: { ...ready().boundaries, writer_guard: 'present' } }];
  for (const f of bad) {
    assert.ok(validate(f).length > 0, JSON.stringify(f));
    assert.equal(decide(f as Facts).kind, 'STOP');
  }
});

test('starting needs a fresh sign-in; a stale or unknown one STOPs', () => {
  const idle = ready({ account: 'active', operation: 'none' });
  assert.equal(step(decide(idle)), 'freeze');
  for (const reauth of ['stale', 'unknown'] as const) assert.equal(step(decide({ ...idle, reauth })), 'STOP:REAUTH_REQUIRED');
  assert.equal(step(decide({ ...idle, operation: 'aborted' })), 'freeze', 'an aborted closure is simply not started');
  assert.equal(step(decide({ ...idle, account: 'locked' })), 'STOP:ACCOUNT_LOCKED');
  assert.equal(step(decide({ ...idle, account: 'unknown' })), 'STOP:ACCOUNT_STATE_UNKNOWN');
  assert.equal(step(decide(ready({ account: 'active', operation: 'open' }))), 'STOP:LIFECYCLE_INCONSISTENT');
});

test('time is not evidence: the decision never depends on how long ago the freeze was', () => {
  const sets: Facts[] = [ready(), started(), ready({ serviceData: 'residue' }), after(), after({ postDelete: { serviceResidue: 0, storageResidue: 0, lateIdentityEvents: 0 } }),
    ready({ authDelete: 'ambiguous' }), ready({ storage: { remaining: null, consecutiveZeroReads: 0 } }),
    ready({ serviceData: 'unknown' }), ready({ storage: { remaining: 3, consecutiveZeroReads: 0 } }),
    ready({ providers: { email: 'not_applicable', apple: 'unknown' } }), ready({ providers: { email: 'not_applicable', apple: 'pending' } }),
    started(), ready({ identities: { snapshot: ['email'], current: ['email', 'apple'] } }),
    ready({ authDelete: 'failed_before_commit', attempts: { cleanup: 0, delete: 1, orphan: 0 } })];
  for (const f of sets) {
    const base = JSON.stringify(decide(f));
    for (const elapsed of [0, 1, 599, 600, 3600, 86_400 * 30, Number.MAX_SAFE_INTEGER]) {
      assert.equal(JSON.stringify(decide({ ...clone(f), elapsedSinceFreezeSec: elapsed })), base, `elapsed=${elapsed}`);
    }
  }
});

test('Auth containment (ban, session revocation) is best effort: not required, never a reason to stop, never a substitute', () => {
  for (const containment of [{ sessions: 'failed', ban: 'failed' }, { sessions: 'done', ban: 'failed' }, { sessions: 'failed', ban: 'done' }] as const) {
    assert.equal(step(decide(ready({ containment: { ...containment } }))), 'auth_delete', JSON.stringify(containment));
  }
  assert.equal(step(decide(started({ containment: { sessions: 'not_attempted', ban: 'not_attempted' } }))), 'revoke_sessions');
  assert.equal(step(decide(started({ containment: { sessions: 'done', ban: 'not_attempted' } }))), 'ban');
  // a done ban does not skip cleanup, residue or verification
  assert.equal(step(decide(ready({ containment: { sessions: 'done', ban: 'done' }, serviceData: 'residue' }))), 'cleanup_service_data');
});

test('F1/F3: an identity that appears after the snapshot is re-decided, bounded, and never silently deleted', () => {
  const late = ready({ identities: { snapshot: ['email', 'apple'], current: ['email', 'apple', 'google'] } });
  assert.equal(step(decide(late)), 'revoke_provider:google', 'the new identity gets a provider outcome first');
  const handled = ready({ providers: { email: 'not_applicable', apple: 'revoked', google: 'revoked' },
    identities: { snapshot: ['email', 'apple'], current: ['email', 'apple', 'google'] } });
  assert.equal(step(decide(handled)), 'record_snapshot', 'then the snapshot is taken again');
  const looping = ready({ providers: { email: 'not_applicable', apple: 'revoked', google: 'revoked' }, attempts: { cleanup: LIMITS.cleanup, delete: 0, orphan: 0 },
    identities: { snapshot: ['email', 'apple'], current: ['email', 'apple', 'google'] } });
  assert.equal(step(decide(looping)), 'RECONCILE:CLEANUP_NOT_CONVERGING');
});

test('F1/F3: a late identity event seen after the delete is never COMPLETE', () => {
  const f = after({ postDelete: { serviceResidue: 0, storageResidue: 0, lateIdentityEvents: 1 } });
  assert.equal(step(decide(f)), 'RECONCILE:LATE_IDENTITY_DETECTED');
});

test('F6: Auth delete does not clean Storage; residue after the delete is cleaned, then verified, then bounded', () => {
  assert.equal(step(decide(after({ postDelete: { serviceResidue: 0, storageResidue: 2, lateIdentityEvents: 0 } }))), 'cleanup_orphans');
  assert.equal(step(decide(after({ postDelete: { serviceResidue: 1, storageResidue: 0, lateIdentityEvents: 0 } }))), 'cleanup_orphans');
  assert.equal(step(decide(after({ postDelete: { serviceResidue: 0, storageResidue: 2, lateIdentityEvents: 0 }, attempts: { cleanup: 0, delete: 1, orphan: LIMITS.orphan } }))),
    'RECONCILE:RESIDUE_AFTER_DELETE');
  assert.equal(step(decide(after({ postDelete: { serviceResidue: null, storageResidue: null, lateIdentityEvents: null } }))), 'verify');
});

test('Storage reads: unreadable is not empty and a single empty read is not stable', () => {
  assert.equal(step(decide(ready({ storage: { remaining: null, consecutiveZeroReads: 5 } }))), 'cleanup_storage');
  assert.equal(step(decide(ready({ storage: { remaining: 0, consecutiveZeroReads: 1 } }))), 'cleanup_storage');
  assert.equal(step(decide(ready({ storage: { remaining: 3, consecutiveZeroReads: 0 } }))), 'cleanup_storage');
  assert.equal(step(decide(ready({ storage: { remaining: 0, consecutiveZeroReads: 2 } }))), 'auth_delete');
  assert.equal(step(decide(ready({ storage: { remaining: null, consecutiveZeroReads: 0 }, attempts: { cleanup: LIMITS.cleanup, delete: 0, orphan: 0 } }))), 'RECONCILE:UNKNOWN_AFTER_START');
});

test('service data unknown or present blocks the delete', () => {
  assert.equal(step(decide(ready({ serviceData: 'unknown' }))), 'read_footprint');
  assert.equal(step(decide(ready({ serviceData: 'residue' }))), 'cleanup_service_data');
  assert.equal(step(decide(ready({ serviceData: 'residue', attempts: { cleanup: LIMITS.cleanup, delete: 0, orphan: 0 } }))), 'RECONCILE:CLEANUP_NOT_CONVERGING');
});

test('providers: every known identity needs an outcome; unknown / failed / pending never reach the delete; unverified is disclosed', () => {
  assert.equal(step(decide(ready({ providers: { email: 'not_applicable' } }))), 'revoke_provider:apple');
  assert.equal(step(decide(ready({ providers: { email: 'not_applicable', apple: 'pending' } }))), 'revoke_provider:apple');
  assert.equal(step(decide(ready({ providers: { email: 'not_applicable', apple: 'failed' } }))), 'revoke_provider:apple');
  assert.equal(step(decide(ready({ providers: { email: 'not_applicable', apple: 'unknown' } }))), 'RECONCILE:PROVIDER_UNRESOLVED');
  assert.equal(step(decide(ready({ providers: { email: 'not_applicable', apple: 'remote_unverified' } }))), 'auth_delete');
  const done = after({ providers: { email: 'not_applicable', apple: 'remote_unverified' }, postDelete: { serviceResidue: 0, storageResidue: 0, lateIdentityEvents: 0 } });
  const d = decide(done);
  assert.deepEqual(d, { kind: 'COMPLETE', disclosures: ['remote_unverified:apple'] });
  for (const bad of ['pending', 'failed', 'unknown'] as const) {
    const f = after({ providers: { email: 'not_applicable', apple: bad }, postDelete: { serviceResidue: 0, storageResidue: 0, lateIdentityEvents: 0 } });
    assert.equal(step(decide(f)), 'RECONCILE:PROVIDER_UNRESOLVED', bad);
  }
});

test('an ambiguous delete is only ever read back; it is never repeated', () => {
  const f = ready({ authDelete: 'ambiguous' });
  assert.equal(step(decide(f)), 'readback_user');
  // even with every other fact bad, nothing else runs first
  assert.equal(step(decide({ ...f, serviceData: 'residue', storage: { remaining: 9, consecutiveZeroReads: 0 } })), 'readback_user');
  // after a read-back: applied -> verify; not applied -> a bounded fresh decision
  assert.equal(step(decide(after({ authDelete: 'ambiguous' }))), 'verify');
  assert.equal(step(decide(ready({ authDelete: 'failed_before_commit', attempts: { cleanup: 0, delete: 1, orphan: 0 } }))), 'auth_delete');
  assert.equal(step(decide(ready({ authDelete: 'failed_before_commit', attempts: { cleanup: 0, delete: LIMITS.delete, orphan: 0 } }))), 'RECONCILE:DELETE_NOT_CONFIRMED');
});

test('a login removed by another route (operator, dashboard, X saga SQL delete) is not our verified closure', () => {
  for (const authDelete of ['not_attempted', 'failed_before_commit'] as const) {
    assert.equal(step(decide(after({ authDelete }))), 'RECONCILE:LOGIN_REMOVED_WITHOUT_INTENT', authDelete);
  }
  assert.equal(step(decide(after({ identities: { snapshot: null, current: [] } }))), 'RECONCILE:LOGIN_REMOVED_WITHOUT_INTENT');
});

test('COMPLETE needs every post-delete fact, read after the delete', () => {
  const clean = { serviceResidue: 0, storageResidue: 0, lateIdentityEvents: 0 };
  assert.equal(decide(after({ postDelete: clean })).kind, 'COMPLETE');
  for (const key of ['serviceResidue', 'storageResidue', 'lateIdentityEvents'] as const) {
    assert.equal(step(decide(after({ postDelete: { ...clean, [key]: null } }))), 'verify', key);
  }
  // the delete call returning is not verification
  assert.equal(decide(ready({ authDelete: 'confirmed' })).kind, 'RECONCILE');
});

test('F2/F4: the data-plane gate judges the state now; token age, a minted-after-ban token and a refreshed token are all alike', () => {
  const closing = { account: 'deleting', entitlement: 'ended', sessionLive: true } as const;
  assert.equal(gate('attested', closing), 'DENY_ACCOUNT', 'F2: a session minted after the ban');
  assert.equal(gate('attested', { ...closing, sessionLive: false }), 'DENY_ACCOUNT');
  assert.equal(gate('attested', { account: 'absent', entitlement: 'missing', sessionLive: false }), 'DENY_ACCOUNT', 'F4: a still-valid token after the delete');
  assert.equal(gate('attested', { account: 'active', entitlement: 'ended', sessionLive: true }), 'DENY_ENTITLEMENT');
  assert.equal(gate('attested', { account: 'active', entitlement: 'active', sessionLive: false }), 'DENY_SESSION');
  assert.equal(gate('attested', { account: 'active', entitlement: 'active', sessionLive: 'unknown' }), 'DENY_SESSION', 'unknown fails closed');
  assert.equal(gate('attested', { account: 'unknown', entitlement: 'active', sessionLive: true }), 'DENY_ACCOUNT');
  assert.equal(gate('attested', { account: 'active', entitlement: 'unknown', sessionLive: true }), 'DENY_ENTITLEMENT');
  assert.equal(gate('attested', { account: 'active', entitlement: 'active', sessionLive: true }), 'ALLOW');
  // without an attested boundary the answer is "the platform decides", which is reported as such, not as safe
  for (const status of ['missing', 'unknown'] as const) assert.equal(gate(status, closing), 'NO_BOUNDARY');
});

test('the orphan sweeper fails closed on an incomplete owner list and respects the grace period', () => {
  const rows = [
    { table: 'notes', id: 'a', ownerId: 'gone', createdAt: 100 },
    { table: 'notes', id: 'b', ownerId: 'live', createdAt: 100 },
    { table: 'objects', id: 'c', ownerId: 'gone', createdAt: 990 },
  ];
  const base = { rows, liveOwners: ['live'], liveOwnersComplete: true, now: 1000, graceSec: 60 };
  assert.deepEqual(findOrphans(base), { ok: true, orphans: [rows[0]] });
  assert.deepEqual(findOrphans({ ...base, liveOwnersComplete: false }), { ok: false, code: 'OWNER_LIST_INCOMPLETE' });
  assert.deepEqual(findOrphans({ ...base, liveOwners: [] }), { ok: false, code: 'OWNER_LIST_EMPTY' });
  assert.deepEqual(findOrphans({ ...base, graceSec: -1 }), { ok: false, code: 'BAD_GRACE' });
  assert.deepEqual(findOrphans({ ...base, graceSec: Number.NaN }), { ok: false, code: 'BAD_GRACE' });
});

test('F7: no hook, ban or token input exists in the facts; a hook outage cannot change a decision', () => {
  const keys = new Set(Object.keys(ready()));
  for (const forbidden of ['hook', 'hookEnabled', 'banned', 'tokenValid', 'jwtExp', 'tokenAge']) assert.ok(!keys.has(forbidden), forbidden);
  assert.deepEqual(Object.keys(ready().containment).sort(), ['ban', 'sessions']);
});
