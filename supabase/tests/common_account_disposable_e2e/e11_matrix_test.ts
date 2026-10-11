// E11 Admin-vs-SQL matrix (Phase 3e, H2 R1 [P1] / R2): every row, denominator, failure branch and token case must be
// measured; nothing is inferred; the probe is labelled as what it is.
import assert from 'node:assert/strict';
import test from 'node:test';

import { E11_DENOMINATORS, E11_FAILURE_BRANCHES, E11_NOT_PROVEN, E11_PROBE_SCOPE, E11_ROWS, E11_TOKEN_CASES, E11_TOKEN_TARGETS, evaluateE11, OPTION_D_FULL_DECISION_PROOF, type E11Evidence } from './e11_matrix.ts';
import { completeE11 } from './test_support.ts';

const check = (mutate: (e: E11Evidence) => void) => { const e = completeE11(); mutate(e); return evaluateE11(e); };
const expectOutcome = (outcome: string, reason: string, mutate: (e: E11Evidence) => void, label = reason) => {
  const r = check(mutate);
  assert.equal(r.outcome, outcome, `${label}: ${r.reasons.join(', ')}`);
  assert.ok(r.reasons.includes(reason), `${label}: expected ${reason}, got ${r.reasons.join(', ')}`);
};

test('the complete matrix passes, and the scope says exactly what E11 is', () => {
  assert.deepEqual(evaluateE11(completeE11()), { outcome: 'PASS', reasons: [], residue: [] });
  assert.equal(E11_PROBE_SCOPE, 'platform_permission_fk_cascade_row_latch_probe');
  assert.deepEqual(E11_ROWS.map((r) => r.id), ['A_AUDIT', 'B_STORAGE', 'C_FAILURE_PATHS', 'D_SESSIONS_REFRESH', 'E_TOKENS_WRITERS']);
  assert.ok(E11_NOT_PROVEN.some((n) => n.includes('atomic')));
  assert.ok(E11_NOT_PROVEN.some((n) => n.includes('provider grant')));
  assert.ok(E11_NOT_PROVEN.some((n) => n.includes('user_deleted')));
  assert.ok(OPTION_D_FULL_DECISION_PROOF.requires.some((r) => r.includes('no lock released')));
  assert.ok(OPTION_D_FULL_DECISION_PROOF.requires.some((r) => r.includes('PKCE')));
  assert.ok(OPTION_D_FULL_DECISION_PROOF.requires.some((r) => r.includes('both lock orders')));
});

test('no matrix, a mislabelled scope, or a missing cohort is UNKNOWN', () => {
  assert.deepEqual(evaluateE11(undefined), { outcome: 'UNKNOWN', reasons: ['E11_MATRIX_MISSING'], residue: [] });
  expectOutcome('UNKNOWN', 'E11_SCOPE_MISLABELLED', (e) => { e.scope = 'option_d_full_proof'; });
  expectOutcome('UNKNOWN', 'E11_COHORT_MISSING:admin', (e) => { delete (e.cohorts as Partial<E11Evidence['cohorts']>).admin; });
  expectOutcome('UNKNOWN', 'E11_COHORT_METHOD:sql', (e) => { e.cohorts.sql.method = 'admin_api_delete'; });
  expectOutcome('UNKNOWN', 'E11_COHORT_EMPTY:admin', (e) => { e.cohorts.admin.fakeUsers = 0; });
  expectOutcome('UNKNOWN', 'E11_CORRELATION_NOT_MASKED:sql', (e) => { e.cohorts.sql.maskedCorrelation = false; });
});

test('cohorts must share one schema and config fingerprint', () => {
  expectOutcome('UNKNOWN', 'E11_COHORTS_NOT_COMPARABLE', (e) => { e.cohorts.sql.schemaFingerprintSha256 = 'c'.repeat(64); });
  expectOutcome('UNKNOWN', 'E11_COHORTS_NOT_COMPARABLE', (e) => { e.cohorts.admin.configFingerprintSha256 = 'd'.repeat(64); });
  expectOutcome('UNKNOWN', 'E11_COHORTS_NOT_COMPARABLE', (e) => { e.cohorts.admin.schemaFingerprintSha256 = 'x'; e.cohorts.sql.schemaFingerprintSha256 = 'x'; }, 'equal but not a hash');
});

test('every denominator of both cohorts must be non-zero before the delete', () => {
  for (const cohort of ['admin', 'sql'] as const) {
    for (const d of E11_DENOMINATORS) {
      expectOutcome('UNKNOWN', `E11_DENOMINATOR_ZERO:${cohort}:${d}`, (e) => { e.cohorts[cohort].denominators[d] = 0; }, `${cohort} ${d}`);
    }
  }
});

test('failure branches: a changed state is FAIL, an unexercised one UNKNOWN; a blind retry is FAIL', () => {
  for (const b of E11_FAILURE_BRANCHES) {
    expectOutcome('FAIL', `E11_FAILURE_BRANCH_CHANGED_STATE:${b}`, (e) => { e.failureBranches[b] = 'CHANGED'; }, `${b} changed`);
    expectOutcome('UNKNOWN', `E11_FAILURE_BRANCH_NOT_READ_BACK:${b}`, (e) => { e.failureBranches[b] = 'UNKNOWN'; }, `${b} unknown`);
  }
  expectOutcome('FAIL', 'E11_BLIND_RETRY', (e) => { e.ambiguousCommit.blindRetry = true; });
  expectOutcome('UNKNOWN', 'E11_AMBIGUOUS_COMMIT_UNRESOLVED', (e) => { e.ambiguousCommit.resolvedByIndependentReadback = false; });
});

test('tokens: guarded writer, GET /user and every expired-token case must refuse; an accepted write needs a read-back', () => {
  for (const cohort of ['admin', 'sql'] as const) {
    for (const kind of E11_TOKEN_CASES) {
      for (const target of E11_TOKEN_TARGETS) {
        const key = `${kind}:${target}` as const;
        const mustRefuse = kind === 'expired_old_jwt' || target === 'guarded_writer' || target === 'auth_get_user';
        const accepted = check((e) => { e.cohorts[cohort].tokens[key] = 'ACCEPTED_RESIDUE_RECORDED'; });
        if (mustRefuse) assert.ok(accepted.outcome === 'FAIL' && accepted.reasons.includes(`E11_TOKEN_ACCEPTED:${cohort}:${key}`), `${cohort} ${key} accepted`);
        else assert.deepEqual([accepted.outcome, accepted.residue], ['PASS', [`STALE_TOKEN_RESIDUE_RECORDED:${cohort}:${key}`]], `${cohort} ${key}: accepted with read-back is recorded residue`);
        expectOutcome('UNKNOWN', `E11_TOKEN_NOT_MEASURED:${cohort}:${key}`, (e) => { e.cohorts[cohort].tokens[key] = 'UNKNOWN'; }, `${cohort} ${key} unknown`);
        if (!mustRefuse) {
          expectOutcome('UNKNOWN', `E11_TOKEN_ACCEPTED_WITHOUT_READBACK:${cohort}:${key}`, (e) => { e.cohorts[cohort].tokens[key] = 'ACCEPTED_UNRECORDED'; }, `${cohort} ${key} unrecorded`);
        }
      }
    }
  }
});

test('nothing inferred: cleanup from users-row / catalog alone and assumed provider revocation are UNKNOWN; rows decide', () => {
  expectOutcome('UNKNOWN', 'E11_CLEANUP_INFERRED_NOT_MEASURED', (e) => { e.cleanupInferredFromUsersRowOrCatalog = true; });
  expectOutcome('UNKNOWN', 'E11_PROVIDER_REVOCATION_ASSUMED', (e) => { e.providerRevocationAssumed = true; });
  for (const row of E11_ROWS) {
    expectOutcome('FAIL', `E11_ROW_FAIL:${row.id}`, (e) => { e.rows[row.id] = 'FAIL'; });
    expectOutcome('UNKNOWN', `E11_ROW_UNKNOWN:${row.id}`, (e) => { e.rows[row.id] = 'UNKNOWN'; });
    expectOutcome('UNKNOWN', `E11_ROW_MISSING:${row.id}`, (e) => { delete (e.rows as Partial<E11Evidence['rows']>)[row.id]; });
  }
});
