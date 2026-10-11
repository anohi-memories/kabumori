// Manual witness checks (Phase 3e, H2 R4): declarations are not verification. Each destructive step needs per-run,
// non-self-declared, matching records; W1/W2/W6 need a second, different person; E11 adds W5-W7.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPERIMENT_IDS, experiment, type ExperimentId } from './catalog.ts';
import { completeWitness, RUN } from './test_support.ts';
import { evaluateWitness, requiredWitness, WITNESS_CHECKS, type WitnessRecord } from './witness.ts';

const destructive = (id: ExperimentId) => experiment(id)?.kind === 'destructive';
const ALL = WITNESS_CHECKS.map((c) => c.id);
const BASE = ['W1_NEW_DISPOSABLE_PROJECT', 'W2_PROTECTED_PROJECTS_EXCLUDED', 'W3_CONNECTION_TARGET', 'W4_FAKE_USER_PROVENANCE'];

test('which checks each scenario needs', () => {
  assert.deepEqual(requiredWitness(['E1'], destructive), [], 'E1 is an observation');
  for (const id of EXPERIMENT_IDS.filter((x) => x !== 'E1' && x !== 'E11')) assert.deepEqual(requiredWitness([id], destructive), BASE, id);
  assert.deepEqual(requiredWitness(['E11'], destructive), ALL);
  assert.ok(WITNESS_CHECKS.find((c) => c.id === 'W2_PROTECTED_PROJECTS_EXCLUDED')!.what.includes('anohi-memories'));
  assert.ok(WITNESS_CHECKS.find((c) => c.id === 'W2_PROTECTED_PROJECTS_EXCLUDED')!.what.includes('stock-x-autopost'));
  assert.ok(WITNESS_CHECKS.find((c) => c.id === 'W2_PROTECTED_PROJECTS_EXCLUDED')!.what.includes('common-account-gateb-20261005'));
  assert.ok(WITNESS_CHECKS.find((c) => c.id === 'W5_SINGLE_ROW_DELETE_TARGET')!.what.includes('exactly one'));
});

test('complete, matching, two-person records of this run satisfy the checks', () => {
  assert.deepEqual(evaluateWitness(completeWitness(), RUN, ALL), { complete: true, reasons: [] });
});

test('fail closed: missing, other run, duplicated, self-declared, mismatching, unreadable, wrong method, no evidence, one person', () => {
  const run = (mutate: (records: WitnessRecord[]) => WitnessRecord[] | void, runId = RUN) => {
    const records = completeWitness();
    const out = mutate(records) ?? records;
    return evaluateWitness(out, runId, ALL);
  };
  const expects = (reason: string, r: ReturnType<typeof evaluateWitness>) => {
    assert.equal(r.complete, false, reason);
    assert.ok(r.reasons.includes(reason), `expected ${reason}, got ${r.reasons.join(', ')}`);
  };
  expects('WITNESS_MISSING:W3_CONNECTION_TARGET', run((rs) => rs.filter((r) => r.id !== 'W3_CONNECTION_TARGET')));
  expects('WITNESS_MISSING:W1_NEW_DISPOSABLE_PROJECT', run(() => undefined, 'p3c-run-20261011-02'));
  expects('WITNESS_RUN_ID_MISSING', evaluateWitness(completeWitness(), undefined, ALL));
  expects('WITNESS_AMBIGUOUS:W4_FAKE_USER_PROVENANCE', run((rs) => [...rs, rs.find((r) => r.id === 'W4_FAKE_USER_PROVENANCE')!]));
  expects('WITNESS_SELF_DECLARED:W6_APPROVAL_PROVENANCE', run((rs) => { rs.find((r) => r.id === 'W6_APPROVAL_PROVENANCE')!.self_declared = true; }));
  expects('WITNESS_MISMATCH:W2_PROTECTED_PROJECTS_EXCLUDED', run((rs) => { rs.find((r) => r.id === 'W2_PROTECTED_PROJECTS_EXCLUDED')!.result = 'MISMATCH'; }));
  expects('WITNESS_UNREADABLE:W5_SINGLE_ROW_DELETE_TARGET', run((rs) => { rs.find((r) => r.id === 'W5_SINGLE_ROW_DELETE_TARGET')!.result = 'UNREADABLE'; }));
  expects('WITNESS_METHOD:W5_SINGLE_ROW_DELETE_TARGET', run((rs) => { rs.find((r) => r.id === 'W5_SINGLE_ROW_DELETE_TARGET')!.method = 'document_review'; }));
  expects('WITNESS_NO_EVIDENCE:W7_PRIOR_EVIDENCE', run((rs) => { rs.find((r) => r.id === 'W7_PRIOR_EVIDENCE')!.evidence = []; }));
  expects('WITNESS_TIME:W3_CONNECTION_TARGET', run((rs) => { rs.find((r) => r.id === 'W3_CONNECTION_TARGET')!.observed_at = 'yesterday'; }));
  for (const id of ['W1_NEW_DISPOSABLE_PROJECT', 'W2_PROTECTED_PROJECTS_EXCLUDED', 'W6_APPROVAL_PROVENANCE'] as const) {
    expects(`WITNESS_NOT_TWO_PERSON:${id}`, run((rs) => { delete rs.find((r) => r.id === id)!.second_observer; }));
    expects(`WITNESS_NOT_TWO_PERSON:${id}`, run((rs) => { rs.find((r) => r.id === id)!.second_observer = 'operator'; }));
  }
});
