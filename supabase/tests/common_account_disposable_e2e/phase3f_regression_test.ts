// Phase 3f regressions for the H2 PR130 rereview residuals (R1, R4). Each test reproduces one H2 case that the PR130
// head accepted and must now fail closed, plus a clean control that must still pass. Fake shapes only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPERIMENT_IDS, type ExperimentId } from './catalog.ts';
import { E11_AFTER_STATE, evaluateE11, type E11Evidence } from './e11_matrix.ts';
import { verdict, type ExperimentResult, type RunContext } from './evidence.ts';
import { completeE11, completeWitness, RUN } from './test_support.ts';
import { evaluateWitness, WITNESS_CHECKS, type WitnessRecord } from './witness.ts';

const pass = (id: ExperimentId, e11?: E11Evidence): ExperimentResult => ({
  id, outcome: 'PASS', evidence: [`${id}.redacted.json`],
  ...(id === 'E4' ? { e4Finding: 'REFUSED' as const } : {}),
  ...(id === 'E11' ? { e11: e11 ?? completeE11() } : {}),
});
const context = (witness: unknown = completeWitness()): RunContext => ({
  runId: RUN,
  witness: witness as WitnessRecord[],
  additionalProofs: [{ id: 'option_d_full_decision_proof', evidence: ['dfull.redacted.json'], independentlyReviewed: true }],
});
const dVerdict = (e11: E11Evidence, witness?: unknown) => verdict(EXPERIMENT_IDS.map((id) => pass(id, id === 'E11' ? e11 : undefined)), context(witness)).candidates.D;
const mutated = (f: (e: E11Evidence) => void) => { const e = completeE11(); f(e); return e; };

test('clean control: a complete matrix with nothing remaining and complete witness keeps D pending review', () => {
  assert.deepEqual(evaluateE11(completeE11()).residue, []);
  assert.deepEqual(dVerdict(completeE11()), { verdict: 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW', reasons: [] });
});

test('H2_R1_NON_TOKEN_REMAINS_BUT_D_PENDING: remaining rows, metadata or blobs block D although the matrix passes', () => {
  for (const cohort of ['sql', 'admin'] as const) {
    for (const kind of E11_AFTER_STATE) {
      const e = mutated((x) => { x.cohorts[cohort].afterState[kind].remaining = 1; });
      assert.equal(evaluateE11(e).outcome, 'PASS', `${cohort} ${kind}: still a measured matrix`);
      assert.deepEqual(dVerdict(e), { verdict: 'BLOCKED', reasons: [`E11:NON_TOKEN_RESIDUE_RECORDED:${cohort}:${kind}`] }, `${cohort} ${kind}`);
    }
  }
});

test('missing or wrongly sourced after-state is UNKNOWN, never inferred clean', () => {
  for (const kind of E11_AFTER_STATE) {
    const missing = mutated((x) => { delete (x.cohorts.sql.afterState as Partial<E11Evidence['cohorts']['sql']['afterState']>)[kind]; });
    assert.ok(evaluateE11(missing).reasons.includes(`E11_AFTER_STATE_MISSING:sql:${kind}`), kind);
    assert.deepEqual(dVerdict(missing).reasons, ['E11:UNKNOWN'], `${kind}: D blocked by an unmeasured E11`);
    for (const bad of [-1, 0.5, '0', null]) {
      const e = mutated((x) => { (x.cohorts.sql.afterState[kind] as { remaining: unknown }).remaining = bad; });
      assert.ok(evaluateE11(e).reasons.includes(`E11_AFTER_STATE_MISSING:sql:${kind}`), `${kind} remaining=${String(bad)}`);
    }
    const noEvidence = mutated((x) => { x.cohorts.sql.afterState[kind].evidence = []; });
    assert.equal(evaluateE11(noEvidence).outcome, 'UNKNOWN', `${kind} without read-back evidence`);
  }
  // The physical blob is only a Storage-service read-back -- never inferred from a metadata count.
  const inferredBlob = mutated((x) => { x.cohorts.sql.afterState.owned_objects_blob.provenance = 'target_readback'; });
  assert.ok(evaluateE11(inferredBlob).reasons.includes('E11_BLOB_NOT_OBSERVED_BY_STORAGE_READBACK:sql'));
  const tooMany = mutated((x) => { x.cohorts.sql.afterState.refresh_tokens.remaining = 3; });
  assert.ok(evaluateE11(tooMany).reasons.includes('E11_AFTER_STATE_EXCEEDS_BEFORE:sql:refresh_tokens'));
  // Expected history is not residue: identity_linked audit rows are not an after-state category.
  assert.ok(!(E11_AFTER_STATE as readonly string[]).includes('identity_linked_audit'));
});

test('H2_R1_INVALID_NOT_RUN_TOKEN_PASSES: only the four token outcomes count; anything else is UNKNOWN and blocks D', () => {
  for (const target of ['unguarded_writer', 'storage_upload'] as const) {
    for (const bad of ['NOT_RUN', 'MAYBE', 'refused', '', null, 42, true]) {
      const e = mutated((x) => { (x.cohorts.sql.tokens as Record<string, unknown>)[`valid_old_jwt:${target}`] = bad; });
      const r = evaluateE11(e);
      assert.equal(r.outcome, 'UNKNOWN', `${target}=${String(bad)}`);
      assert.ok(r.reasons.includes(`E11_TOKEN_INVALID:sql:valid_old_jwt:${target}`), `${target}=${String(bad)}`);
      assert.deepEqual(dVerdict(e).reasons, ['E11:UNKNOWN']);
    }
  }
});

test('H2_R1_RESOLVED_COMMIT_APPLIED_IS_FAIL: a lost COMMIT resolved by independent read-back is not a failed rollback', () => {
  for (const resolution of ['APPLIED', 'NOT_APPLIED'] as const) {
    const e = mutated((x) => { x.ambiguousCommit.resolution = resolution; });
    assert.equal(evaluateE11(e).outcome, 'PASS', resolution);
  }
  const unresolved = mutated((x) => { x.ambiguousCommit.resolution = 'UNKNOWN'; });
  assert.deepEqual([evaluateE11(unresolved).outcome, evaluateE11(unresolved).reasons], ['UNKNOWN', ['E11_AMBIGUOUS_COMMIT_UNRESOLVED']]);
  for (const f of [
    (x: E11Evidence) => { x.ambiguousCommit.resolvedByIndependentReadback = false; },
    (x: E11Evidence) => { x.ambiguousCommit.evidence = []; },
    (x: E11Evidence) => { (x.ambiguousCommit as { resolution: unknown }).resolution = 'MAYBE'; },
    (x: E11Evidence) => { delete (x as Partial<E11Evidence>).ambiguousCommit; },
  ]) assert.ok(evaluateE11(mutated(f)).reasons.includes('E11_AMBIGUOUS_COMMIT_UNRESOLVED'));
  // No blind retry, whatever the resolution.
  for (const resolution of ['APPLIED', 'NOT_APPLIED', 'UNKNOWN'] as const) {
    const retried = mutated((x) => { x.ambiguousCommit.resolution = resolution; x.ambiguousCommit.blindRetry = true; });
    assert.equal(evaluateE11(retried).outcome, 'FAIL', `${resolution} with a retry`);
    assert.ok(evaluateE11(retried).reasons.includes('E11_BLIND_RETRY'));
  }
  // Refused / rolled-back branches still require UNCHANGED.
  const changed = mutated((x) => { x.failureBranches.explicit_rollback_before_commit = 'CHANGED'; });
  assert.equal(evaluateE11(changed).outcome, 'FAIL');
});

test('H2_R4_MISSING_SELF_DECLARED_IS_ACCEPTED: only self_declared === false counts', () => {
  const ids = WITNESS_CHECKS.map((c) => c.id);
  const stripped = JSON.parse(JSON.stringify(completeWitness(), (k, v) => k === 'self_declared' ? undefined : v));
  const r = evaluateWitness(stripped, RUN, ids);
  assert.equal(r.complete, false);
  for (const id of ids) assert.ok(r.reasons.includes(`WITNESS_MALFORMED:${id}:self_declared`), id);
  for (const bad of [null, 'false', 0, 'no', true]) {
    const records = completeWitness().map((w) => ({ ...w, self_declared: bad })) as unknown as WitnessRecord[];
    assert.equal(evaluateWitness(records, RUN, ids).complete, false, `self_declared=${String(bad)}`);
  }
  // End to end: the verdict no longer accepts them for any destructive experiment.
  const v = verdict(EXPERIMENT_IDS.map((id) => pass(id)), context(stripped));
  assert.equal(v.overall, 'BLOCKED');
  assert.ok(v.downgraded.includes('E2:WITNESS_MALFORMED:W1_NEW_DISPOSABLE_PROJECT:self_declared'));
  assert.deepEqual(v.candidates.D.reasons.filter((x) => x.startsWith('E11')), ['E11:UNKNOWN']);
});

test('malformed witness records of any shape fail closed', () => {
  const ids = WITNESS_CHECKS.map((c) => c.id);
  const base = () => completeWitness();
  const cases: [string, unknown][] = [
    ['records not an array', { 0: base()[0] }],
    ['records null', null],
    ['a record that is a string', ['W1_NEW_DISPOSABLE_PROJECT', ...base().slice(1)]],
    ['unknown observer role', base().map((w) => ({ ...w, observed_by: 'bot' }))],
    ['unknown second observer', base().map((w) => ({ ...w, second_observer: 'robot' }))],
    ['unknown result', base().map((w) => ({ ...w, result: 'OK' }))],
    ['evidence not strings', base().map((w) => ({ ...w, evidence: [1] }))],
    ['observed_at not a string', base().map((w) => ({ ...w, observed_at: 20261011 }))],
  ];
  for (const [label, records] of cases) {
    assert.equal(evaluateWitness(records as WitnessRecord[], RUN, ids).complete, false, label);
  }
  assert.equal(evaluateWitness(base(), RUN, ids).complete, true, 'the valid control still passes');
});
