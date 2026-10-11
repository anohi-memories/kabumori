// Fake, complete evidence shapes for the offline tests (Phase 3e). Every value is invented; nothing here was observed
// on a real or disposable project.
import type { E4BoundEvidence } from './e4_bound.ts';
import { E11_DENOMINATORS, E11_FAILURE_BRANCHES, E11_PROBE_SCOPE, E11_ROWS, E11_TOKEN_CASES, E11_TOKEN_TARGETS, type CohortEvidence, type E11Evidence, type E11TokenKey } from './e11_matrix.ts';
import { WITNESS_CHECKS, type WitnessRecord } from './witness.ts';

export const RUN = 'p3c-run-20261011-01';
const FP = 'a'.repeat(64);
const CONFIG = 'b'.repeat(64);

export function completeWitness(runId = RUN): WitnessRecord[] {
  return WITNESS_CHECKS.map((c) => ({
    id: c.id,
    run_id: runId,
    observed_by: 'operator',
    ...(c.twoPerson ? { second_observer: 'user' as const } : {}),
    method: c.methods[0],
    observed_at: '2026-10-11T10:00:00+09:00',
    result: 'MATCH',
    evidence: [`${c.id}.redacted.json`],
    self_declared: false,
  }));
}

function cohort(method: CohortEvidence['method']): CohortEvidence {
  const tokens = {} as Record<E11TokenKey, CohortEvidence['tokens'][E11TokenKey]>;
  for (const kind of E11_TOKEN_CASES) for (const target of E11_TOKEN_TARGETS) tokens[`${kind}:${target}`] = 'REFUSED';
  return {
    method, fakeUsers: 3, schemaFingerprintSha256: FP, configFingerprintSha256: CONFIG, maskedCorrelation: true,
    denominators: Object.fromEntries(E11_DENOMINATORS.map((d) => [d, 2])) as CohortEvidence['denominators'],
    tokens,
  };
}

export function completeE11(): E11Evidence {
  return {
    scope: E11_PROBE_SCOPE,
    cohorts: { admin: cohort('admin_api_delete'), sql: cohort('sql_delete_row_latch') },
    rows: Object.fromEntries(E11_ROWS.map((r) => [r.id, 'PASS'])) as E11Evidence['rows'],
    failureBranches: Object.fromEntries(E11_FAILURE_BRANCHES.map((b) => [b, 'UNCHANGED_READBACK'])) as E11Evidence['failureBranches'],
    ambiguousCommit: { blindRetry: false, resolvedByReadback: true },
    cleanupInferredFromUsersRowOrCatalog: false,
    providerRevocationAssumed: false,
  };
}

export function completeBound(): E4BoundEvidence {
  return {
    gotrueVersion: 'v2.197.0',
    configuredFlowExpirySeconds: 300,
    configuredFlowExpirySource: 'project_config',
    expiredCallbackAttemptDelaySeconds: 420,
    expiredCallbackRejected: true,
    lastSuccessfulCallbackDelaySeconds: 240,
    requestDurationMaxSeconds: 10,
    clockSkewMarginSeconds: 5,
    settleSeconds: 330,
    inFlightDrainVerified: true,
    exclusiveRecheckVerified: true,
    sequence: ['revoke_sessions', 'ban', 'drain', 'exclusive_recheck', 'admin_delete'],
    evidence: ['E4-bound.redacted.json'],
  };
}
