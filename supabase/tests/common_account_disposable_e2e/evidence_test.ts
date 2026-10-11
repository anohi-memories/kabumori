// Outcome model (Phase 3c, corrected in Phase 3e): unknown never passes, a destructive PASS needs the run's manual
// witness checks, E11 needs its full matrix, A+B's E4 mitigation needs an upper bound, Option D needs the separate
// full-decision proof -- and neither candidate is chosen.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPERIMENT_IDS, REQUIRED_FOR, type ExperimentId } from './catalog.ts';
import { verdict, type ExperimentResult, type Outcome, type RunContext } from './evidence.ts';
import { completeBound, completeE11, completeWitness, RUN } from './test_support.ts';

const pass = (id: ExperimentId, extra: Partial<ExperimentResult> = {}): ExperimentResult => ({
  id, outcome: 'PASS', evidence: [`${id}.redacted.json`],
  ...(id === 'E4' ? { e4Finding: 'REFUSED' as const } : {}),
  ...(id === 'E11' ? { e11: completeE11() } : {}),
  ...extra,
});
const allPass = () => EXPERIMENT_IDS.map((id) => pass(id));
const FULL: RunContext = {
  runId: RUN,
  witness: completeWitness(),
  additionalProofs: [{ id: 'option_d_full_decision_proof', evidence: ['dfull.redacted.json', 'review-reference'], independentlyReviewed: true }],
};

test('nothing run: everything blocked', () => {
  const v = verdict([]);
  assert.equal(v.overall, 'BLOCKED');
  assert.equal(v.candidates['A+B'].verdict, 'BLOCKED');
  assert.equal(v.candidates.D.verdict, 'BLOCKED');
  assert.ok(v.candidates['A+B'].reasons.includes('E1:NOT_RUN'));
});

test('every experiment PASS with evidence, witness and the D decision proof: both PENDING independent review -- never a release', () => {
  const v = verdict(allPass(), FULL);
  assert.deepEqual(v.candidates['A+B'], { verdict: 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW', reasons: [] });
  assert.deepEqual(v.candidates.D, { verdict: 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW', reasons: [] });
  assert.equal(v.overall, 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW');
  assert.ok(!JSON.stringify(v).match(/READY|RELEASE|OPEN/u));
});

test('UNKNOWN, FAIL, NOT_RUN or a missing result block every candidate that needs it', () => {
  for (const id of EXPERIMENT_IDS) {
    for (const outcome of ['UNKNOWN', 'FAIL', 'NOT_RUN'] as Outcome[]) {
      const v = verdict(allPass().map((r) => r.id === id ? { ...r, outcome } : r), FULL);
      for (const candidate of ['A+B', 'D'] as const) {
        const needs = REQUIRED_FOR[candidate].includes(id);
        assert.equal(v.candidates[candidate].verdict === 'BLOCKED', needs, `${id} ${outcome} for ${candidate}`);
        if (needs) assert.ok(v.candidates[candidate].reasons.includes(`${id}:${outcome}`));
      }
    }
    const missing = verdict(allPass().filter((r) => r.id !== id), FULL);
    for (const candidate of ['A+B', 'D'] as const) {
      if (REQUIRED_FOR[candidate].includes(id)) assert.ok(missing.candidates[candidate].reasons.includes(`${id}:NOT_RUN`), `${id} missing`);
    }
  }
});

test('a PASS without evidence is UNKNOWN', () => {
  const v = verdict(allPass().map((r) => r.id === 'E8' ? { ...r, evidence: [] } : r), FULL);
  assert.ok(v.candidates.D.reasons.includes('E8:UNKNOWN'));
  assert.ok(v.downgraded.includes('E8:NO_EVIDENCE'));
});

test('R4: a destructive PASS without the run\'s witness checks is UNKNOWN; E1 (observation) does not need them', () => {
  const v = verdict(allPass(), { ...FULL, witness: [] });
  for (const id of EXPERIMENT_IDS.filter((x) => x !== 'E1')) assert.ok(v.downgraded.includes(`${id}:WITNESS_MISSING:W1_NEW_DISPOSABLE_PROJECT`), id);
  assert.ok(!v.downgraded.some((d) => d.startsWith('E1:')));
  assert.equal(v.overall, 'BLOCKED');
  const otherRun = verdict(allPass(), { ...FULL, runId: 'p3c-run-20261011-09' });
  assert.equal(otherRun.overall, 'BLOCKED', 'witness records of another run do not count');
  const selfDeclared = verdict(allPass(), { ...FULL, witness: completeWitness().map((w) => ({ ...w, self_declared: true })) });
  assert.ok(selfDeclared.downgraded.includes('E2:WITNESS_SELF_DECLARED:W1_NEW_DISPOSABLE_PROJECT'));
  const noE11Witness = verdict(allPass(), { ...FULL, witness: completeWitness().filter((w) => w.id !== 'W5_SINGLE_ROW_DELETE_TARGET') });
  assert.deepEqual(noE11Witness.candidates.D.reasons, ['E11:UNKNOWN']);
  assert.ok(noE11Witness.downgraded.includes('E11:WITNESS_MISSING:W5_SINGLE_ROW_DELETE_TARGET'));
  assert.equal(noE11Witness.candidates['A+B'].verdict, 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW', 'W5-W7 concern E11 only');
});

test('R1: E11 PASS without the full matrix is UNKNOWN; a matrix FAIL is FAIL; recorded residue blocks D', () => {
  const noMatrix = verdict(allPass().map((r) => r.id === 'E11' ? { ...r, e11: undefined } : r), FULL);
  assert.ok(noMatrix.candidates.D.reasons.includes('E11:UNKNOWN'));
  assert.ok(noMatrix.downgraded.includes('E11:E11_MATRIX_MISSING'));
  const blind = completeE11();
  blind.ambiguousCommit.blindRetry = true;
  const failed = verdict(allPass().map((r) => r.id === 'E11' ? { ...r, e11: blind } : r), FULL);
  assert.ok(failed.candidates.D.reasons.includes('E11:FAIL'));
  const residue = completeE11();
  residue.cohorts.sql.tokens['valid_old_jwt:storage_upload'] = 'ACCEPTED_RESIDUE_RECORDED';
  const withResidue = verdict(allPass().map((r) => r.id === 'E11' ? { ...r, e11: residue } : r), FULL);
  assert.deepEqual(withResidue.candidates.D.reasons, ['E11:STALE_TOKEN_RESIDUE_RECORDED:sql:valid_old_jwt:storage_upload']);
});

test('R2: Option D needs the separate full-decision proof, independently reviewed; E11 alone never suffices', () => {
  const none = verdict(allPass(), { ...FULL, additionalProofs: [] });
  assert.deepEqual(none.candidates.D.reasons, ['option_d_full_decision_proof:MISSING']);
  assert.equal(none.candidates['A+B'].verdict, 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW');
  const unreviewed = verdict(allPass(), { ...FULL, additionalProofs: [{ id: 'option_d_full_decision_proof', evidence: ['x'], independentlyReviewed: false }] });
  assert.deepEqual(unreviewed.candidates.D.reasons, ['option_d_full_decision_proof:MISSING']);
  const noEvidence = verdict(allPass(), { ...FULL, additionalProofs: [{ id: 'option_d_full_decision_proof', evidence: [], independentlyReviewed: true }] });
  assert.deepEqual(noEvidence.candidates.D.reasons, ['option_d_full_decision_proof:MISSING']);
});

test('R3: E4 LINKED -- a mitigation label alone never qualifies A+B; only an evidenced upper bound does', () => {
  const linked = (extra: Partial<ExperimentResult>) => verdict(allPass().map((r) => r.id === 'E4' ? pass('E4', { e4Finding: 'LINKED', ...extra }) : r), FULL);
  const undecided = verdict(allPass().map((r) => r.id === 'E4' ? { id: 'E4', outcome: 'PASS', evidence: ['E4.json'] } : r), FULL);
  assert.ok(undecided.candidates['A+B'].reasons.includes('E4:UNKNOWN'));
  assert.deepEqual(linked({}).candidates['A+B'].reasons, ['E4:LINKED_WITHOUT_PROVEN_MITIGATION']);
  for (const label of ['settle_exceeds_measured_flow_expiry', 'manual_linking_disabled_verified'] as const) {
    assert.deepEqual(linked({ e4Mitigation: label }).candidates['A+B'].reasons, ['E4:E4_BOUND_MISSING'], `${label} alone`);
    assert.equal(linked({ e4Mitigation: label, e4Bound: completeBound() }).candidates['A+B'].verdict, 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW', `${label} with a bound`);
  }
  // The longest successful delay is a LOWER bound: a "bound" that rests on it alone fails.
  const lowerOnly = { ...completeBound(), configuredFlowExpirySeconds: 600, lastSuccessfulCallbackDelaySeconds: 600, expiredCallbackAttemptDelaySeconds: 600 };
  assert.ok(linked({ e4Mitigation: 'settle_exceeds_measured_flow_expiry', e4Bound: lowerOnly }).candidates['A+B'].reasons.includes('E4:E4_BOUND_NO_CALLBACK_AFTER_EXPIRY'));
  assert.equal(linked({ e4Mitigation: 'settle_exceeds_measured_flow_expiry' }).candidates.D.verdict, 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW', 'D does not depend on E4');
});

test('malformed results block everything', () => {
  for (const bad of [
    [...allPass(), pass('E2')],
    [...allPass(), { id: 'E13', outcome: 'PASS', evidence: ['x'] } as unknown as ExperimentResult],
    allPass().map((r) => r.id === 'E1' ? { ...r, outcome: 'MAYBE' as Outcome } : r),
  ]) {
    const v = verdict(bad, FULL);
    assert.equal(v.overall, 'BLOCKED');
    assert.ok(v.invalid.length > 0);
  }
});
