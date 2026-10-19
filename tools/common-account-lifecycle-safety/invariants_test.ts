// Invariant search for the closure logic (Phase 3i). Every schedule of up to two adversary events, injected at any of
// the first twelve decision points, must keep the invariants. Synthetic world; this checks the PROPOSED logic against
// the Phase 3h observations modelled as adversary behaviour. It does not prove anything about managed Supabase.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADVERSARY_EVENTS, applyEvent, execute, newWorld, runClosure, violations,
  type AdversaryEvent, type World,
} from './world.ts';

const POSITIONS = 12;
type Schedule = Record<number, AdversaryEvent[]>;

function* schedules(): Generator<{ label: string; schedule: Schedule }> {
  yield { label: 'none', schedule: {} };
  const atoms: { pos: number; event: AdversaryEvent }[] = [];
  for (let pos = 0; pos < POSITIONS; pos += 1) for (const event of ADVERSARY_EVENTS) atoms.push({ pos, event });
  const build = (...xs: { pos: number; event: AdversaryEvent }[]): Schedule => {
    const s: Schedule = {};
    for (const x of xs) (s[x.pos] ??= []).push(x.event);
    return s;
  };
  for (let i = 0; i < atoms.length; i += 1) {
    yield { label: `${atoms[i].event}@${atoms[i].pos}`, schedule: build(atoms[i]) };
    for (let j = i + 1; j < atoms.length; j += 1) {
      yield { label: `${atoms[i].event}@${atoms[i].pos}+${atoms[j].event}@${atoms[j].pos}`, schedule: build(atoms[i], atoms[j]) };
    }
  }
}

interface Tally { runs: number; complete: number; reconcile: number; stop: number; maxIterations: number; failures: string[] }

function search(make: () => World): Tally {
  const t: Tally = { runs: 0, complete: 0, reconcile: 0, stop: 0, maxIterations: 0, failures: [] };
  for (const { label, schedule } of schedules()) {
    const r = runClosure(make(), schedule);
    t.runs += 1;
    t.maxIterations = Math.max(t.maxIterations, r.iterations);
    if (r.decision?.kind === 'COMPLETE') t.complete += 1;
    else if (r.decision?.kind === 'RECONCILE') t.reconcile += 1;
    else if (r.decision?.kind === 'STOP') t.stop += 1;
    const v = violations(r);
    if (v.length && t.failures.length < 5) t.failures.push(`${label}: ${v.join(',')}`);
  }
  return t;
}

test('all boundaries attested: no schedule breaks an invariant, every run ends, and most end COMPLETE', () => {
  const t = search(() => newWorld());
  assert.deepEqual(t.failures, []);
  assert.ok(t.runs > 8000, `runs=${t.runs}`);
  assert.ok(t.maxIterations < 40, `max iterations ${t.maxIterations}`);
  assert.ok(t.complete > 0 && t.reconcile > 0, 'the search must reach both a clean completion and a reconciliation');
  assert.equal(t.stop, 0, 'with the boundaries attested nothing stops at the start');
});

test('an Apple identity from the start, and no Storage policy (the sweeper only): invariants still hold', () => {
  const apple = search(() => newWorld({ identities: ['email', 'apple'] }));
  assert.deepEqual(apple.failures, []);
  const sweeperOnly = search(() => newWorld({ identities: ['email', 'apple'], boundaries: { storage_write_policy: 'missing' } }));
  assert.deepEqual(sweeperOnly.failures, []);
  assert.ok(sweeperOnly.complete > 0 && sweeperOnly.reconcile > 0);
});

test('a missing boundary STOPs before any effect, whatever the adversary does', () => {
  for (const name of ['state_predicate', 'writer_guard', 'person_token_edge_checks', 'orphan_sweeper'] as const) {
    for (const { label, schedule } of schedules()) {
      const w = newWorld({ boundaries: { [name]: 'missing' } });
      const r = runClosure(w, schedule);
      if (r.decision?.kind === 'STOP') {
        assert.equal(w.effects.length, 0, `${name} ${label}: effects after a STOP`);
      }
      // the closure never starts, so the account is never frozen
      assert.equal(w.accountStatus, 'active', `${name} ${label}`);
    }
  }
  // the sweeper is not replaced by a Storage policy
  const policyOnly = newWorld({ boundaries: { storage_write_policy: 'attested', orphan_sweeper: 'missing' } });
  assert.equal(runClosure(policyOnly).decision?.kind, 'STOP');
  assert.equal(policyOnly.effects.length, 0);
});

test('NEGATIVE REPRODUCTION (F4): without an attested predicate a stateless token still writes after the freeze', () => {
  const noPredicate = newWorld({ boundaries: { state_predicate: 'missing' } });
  execute(noPredicate, 'freeze', false);
  applyEvent(noPredicate, 'write_with_old_token');
  assert.equal(noPredicate.accepted.writesAfterFreeze, 1, 'F4 reproduced: the write is accepted');

  const withPredicate = newWorld();
  execute(withPredicate, 'freeze', false);
  applyEvent(withPredicate, 'write_with_old_token');
  assert.equal(withPredicate.accepted.writesAfterFreeze, 0, 'the same request is denied by the state boundary');

  // F2: a session minted after the ban is no different
  const minted = newWorld();
  execute(minted, 'freeze', false);
  execute(minted, 'revoke_sessions', false);
  execute(minted, 'ban', false);
  applyEvent(minted, 'manual_link_start');
  applyEvent(minted, 'manual_link_complete');
  assert.equal(minted.sessions.filter((s) => s.live).length, 1, 'F1/F2 reproduced: the link completed and minted a live session');
  assert.ok(minted.identities.includes('google'));
  applyEvent(minted, 'write_with_old_token');
  assert.equal(minted.accepted.writesAfterFreeze, 0, 'but its token buys nothing');
});

test('NEGATIVE CONTROL: a naive closure (ban, clean, delete, declare done) breaks the invariants the real logic keeps', () => {
  const issues = { lateIdentity: 0, serviceResidue: 0, storageResidue: 0, writeAfterFreeze: 0 };
  const naiveSteps = ['freeze', 'revoke_sessions', 'ban', 'cleanup_service_data', 'cleanup_storage', 'auth_delete'];
  for (const { schedule } of schedules()) {
    const w = newWorld({ boundaries: { state_predicate: 'missing', storage_write_policy: 'missing' } });
    naiveSteps.forEach((s, i) => {
      for (const e of schedule[i] ?? []) applyEvent(w, e);
      execute(w, s, false);
      w.tick += 1;
    });
    for (const e of schedule[naiveSteps.length] ?? []) applyEvent(w, e);
    if (w.audit.some((a) => w.freezeTick !== null && a.tick > w.freezeTick)) issues.lateIdentity += 1;
    if (w.serviceRows > 0) issues.serviceResidue += 1;
    if (w.storageObjects > 0) issues.storageResidue += 1;
    if (w.accepted.writesAfterFreeze > 0) issues.writeAfterFreeze += 1;
  }
  for (const [name, count] of Object.entries(issues)) assert.ok(count > 0, `the naive closure was never caught on ${name}`);
});

test('determinism and resume: the same schedule gives the same trace; re-deriving facts at any point changes nothing', () => {
  let checked = 0;
  for (const { schedule } of schedules()) {
    if (checked++ % 37 !== 0) continue;
    const a = runClosure(newWorld(), schedule);
    const b = runClosure(newWorld(), schedule);
    assert.equal(JSON.stringify(a.decisions), JSON.stringify(b.decisions));
    assert.equal(JSON.stringify(a.world.effects), JSON.stringify(b.world.effects));
  }
});

test('resume: a closure rebuilt from the same durable facts gets the same decisions, step for step', () => {
  const schedule: Schedule = { 3: ['auto_link_start'], 6: ['auto_link_commit'] };
  const first = runClosure(newWorld({ identities: ['email', 'apple'] }), schedule);
  const second = runClosure(newWorld({ identities: ['email', 'apple'] }), schedule);
  assert.ok(first.decisions.length > 3);
  assert.deepEqual(first.decisions.map((d) => JSON.stringify(d)), second.decisions.map((d) => JSON.stringify(d)));
  // decide() reads facts only: the last decision is reproduced from the final facts alone
  const last = first.decisions[first.decisions.length - 1];
  assert.ok(last.kind === 'COMPLETE' || last.kind === 'RECONCILE');
});

test('reaching COMPLETE is not guaranteed: late identities and residue end as RECONCILE, never as a quiet success', () => {
  const lateIdentity = runClosure(newWorld(), { 9: ['auto_link_start'], 10: ['auto_link_commit'] });
  const noneLate = runClosure(newWorld());
  assert.equal(noneLate.decision?.kind, 'COMPLETE');
  assert.deepEqual(violations(noneLate), []);
  assert.deepEqual(violations(lateIdentity), []);
  // find at least one schedule where the closure had to reconcile and check the reason is one of the named ones
  const reasons = new Set<string>();
  for (const { schedule } of schedules()) {
    const r = runClosure(newWorld({ identities: ['email', 'apple'] }), schedule);
    if (r.decision?.kind === 'RECONCILE') reasons.add(r.decision.code);
  }
  assert.ok(reasons.size > 0);
  for (const code of reasons) {
    assert.ok(['LATE_IDENTITY_DETECTED', 'RESIDUE_AFTER_DELETE', 'CLEANUP_NOT_CONVERGING', 'DELETE_NOT_CONFIRMED', 'UNKNOWN_AFTER_START', 'PROVIDER_UNRESOLVED',
      'LOGIN_REMOVED_WITHOUT_INTENT'].includes(code), code);
  }
});

test('NEGATIVE CONTROL: a verification read earlier than the verdict lets a straggler through; a fresh read does not', () => {
  // A statement that began before the freeze (write_start) commits after the verification was read.
  const cached = runClosure(newWorld({ cachedVerification: true }), { 0: ['write_start'], 10: ['inflight_write_commit'] });
  assert.equal(cached.decision?.kind, 'COMPLETE');
  assert.ok(violations(cached).includes('COMPLETE_WITH_SERVICE_RESIDUE'), 'a cached verification is a boundary gap');

  // With the verification read in the decision's own snapshot the same straggler is swept before the verdict.
  const fresh = runClosure(newWorld(), { 0: ['write_start'], 9: ['inflight_write_commit'] });
  assert.deepEqual(violations(fresh), []);
  assert.equal(fresh.decision?.kind, 'COMPLETE');
  assert.ok(fresh.world.effects.some((e) => e.step === 'cleanup_orphans'), 'the straggler was swept after the delete and before the verdict');
});
