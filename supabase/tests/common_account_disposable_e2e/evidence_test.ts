// Outcome model (Phase 3c offline readiness): unknown never passes, and neither candidate is chosen.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPERIMENT_IDS, REQUIRED_FOR, type ExperimentId } from './catalog.ts';
import { verdict, type ExperimentResult, type Outcome } from './evidence.ts';

const pass = (id: ExperimentId, extra: Partial<ExperimentResult> = {}): ExperimentResult =>
  ({ id, outcome: 'PASS', evidence: [`${id}.redacted.json`], ...(id === 'E4' ? { e4Finding: 'REFUSED' as const } : {}), ...extra });
const allPass = () => EXPERIMENT_IDS.map((id) => pass(id));

test('nothing run: everything blocked', () => {
  const v = verdict([]);
  assert.equal(v.overall, 'BLOCKED');
  assert.equal(v.candidates['A+B'].verdict, 'BLOCKED');
  assert.equal(v.candidates.D.verdict, 'BLOCKED');
  assert.ok(v.candidates['A+B'].reasons.includes('E1:NOT_RUN'));
});

test('every experiment PASS with evidence: both candidates complete PENDING independent review -- never a release', () => {
  const v = verdict(allPass());
  assert.equal(v.overall, 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW');
  assert.deepEqual(v.candidates['A+B'], { verdict: 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW', reasons: [] });
  assert.deepEqual(v.candidates.D, { verdict: 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW', reasons: [] });
  assert.ok(!JSON.stringify(v).match(/READY|RELEASE|OPEN/u));
});

test('UNKNOWN, FAIL, NOT_RUN or a missing result block every candidate that needs it', () => {
  for (const id of EXPERIMENT_IDS) {
    for (const outcome of ['UNKNOWN', 'FAIL', 'NOT_RUN'] as Outcome[]) {
      const v = verdict(allPass().map((r) => r.id === id ? { ...r, outcome } : r));
      for (const candidate of ['A+B', 'D'] as const) {
        const needs = REQUIRED_FOR[candidate].includes(id);
        assert.equal(v.candidates[candidate].verdict === 'BLOCKED', needs, `${id} ${outcome} for ${candidate}`);
        if (needs) assert.ok(v.candidates[candidate].reasons.includes(`${id}:${outcome}`));
      }
    }
    const missing = verdict(allPass().filter((r) => r.id !== id));
    for (const candidate of ['A+B', 'D'] as const) {
      if (REQUIRED_FOR[candidate].includes(id)) assert.ok(missing.candidates[candidate].reasons.includes(`${id}:NOT_RUN`), `${id} missing`);
    }
  }
});

test('a PASS without evidence is UNKNOWN', () => {
  const v = verdict(allPass().map((r) => r.id === 'E8' ? { ...r, evidence: [] } : r));
  assert.ok(v.candidates.D.reasons.includes('E8:UNKNOWN'));
  assert.equal(v.overall, 'BLOCKED');
});

test('E4: the counterexample must be decided; LINKED blocks A+B unless a mitigation is evidenced', () => {
  const undecided = verdict(allPass().map((r) => r.id === 'E4' ? { id: 'E4', outcome: 'PASS', evidence: ['E4.json'] } : r));
  assert.ok(undecided.candidates['A+B'].reasons.includes('E4:UNKNOWN'));
  const linked = verdict(allPass().map((r) => r.id === 'E4' ? pass('E4', { e4Finding: 'LINKED' }) : r));
  assert.deepEqual(linked.candidates['A+B'].reasons, ['E4:LINKED_WITHOUT_PROVEN_MITIGATION']);
  assert.equal(linked.candidates.D.verdict, 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW', 'D does not depend on E4');
  const mitigated = verdict(allPass().map((r) => r.id === 'E4' ? pass('E4', { e4Finding: 'LINKED', e4Mitigation: 'manual_linking_disabled_verified' }) : r));
  assert.equal(mitigated.candidates['A+B'].verdict, 'EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW');
});

test('malformed results block everything', () => {
  for (const bad of [
    [...allPass(), pass('E2')],
    [...allPass(), { id: 'E13', outcome: 'PASS', evidence: ['x'] } as unknown as ExperimentResult],
    allPass().map((r) => r.id === 'E1' ? { ...r, outcome: 'MAYBE' as Outcome } : r),
  ]) {
    const v = verdict(bad);
    assert.equal(v.overall, 'BLOCKED');
    assert.ok(v.invalid.length > 0);
  }
});
