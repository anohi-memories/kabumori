// E11 independent deletion-evidence matrix (Phase 3e, H2 E11 review R1 [P1] and R2). OFFLINE ONLY.
//
// What E11 is (R2): a PLATFORM PERMISSION / FK CASCADE / ROW-LATCH probe -- `select ... from auth.users where id = $1
// for update; delete from auth.users where id = $1` on one fake user of a disposable project. It is NOT a proof that
// a lifecycle decision and the delete are atomic: the Phase 3a full authorization, required-checkpoint and provider
// snapshot and the owner lease are not evaluated inside that transaction. That proof is a separate, future,
// separately reviewed item (OPTION_D_FULL_DECISION_PROOF) and Option D cannot be reviewed without it.
//
// What E11 must compare (R1): two independent fake-user cohorts under the identical schema and config --
// a CONTROL cohort deleted through the Auth Admin API and a TEST cohort deleted by the SQL row-latch probe -- each
// with non-zero before-state fixtures captured BEFORE the delete as denominators (target ids hashed). E11 is PASS
// only when every row below is measured; nothing is inferred from auth.users disappearing or from a catalog hash,
// and no external provider revocation is assumed for either path.
import type { Outcome } from './evidence.ts';

export const E11_PROBE_SCOPE = 'platform_permission_fk_cascade_row_latch_probe' as const;

/** What E11 does NOT prove, whatever its outcome (printed with the plan). */
export const E11_NOT_PROVEN: readonly string[] = [
  'that a lifecycle decision (full authorization, required checkpoints, provider snapshot, owner lease) and the delete are one atomic transaction',
  'ordering against manual, automatic or PKCE identity-link callbacks already in flight',
  'ordering against PostgREST writers of other roles, in both lock orders',
  'that no lock is released between the decision and the delete',
  'any revocation of an external provider grant (neither the Admin API nor SQL revokes one)',
  'that GoTrue writes a user_deleted audit row for the SQL path (it is not assumed)',
];

/** The future proof Option D needs before it can be reviewed (not one of PR121's E1-E12). */
export const OPTION_D_FULL_DECISION_PROOF = {
  id: 'option_d_full_decision_proof',
  requires: [
    'the Phase 3a full decision (authorization, required checkpoints, provider snapshot, owner lease) evaluated in the same transaction that deletes, with no lock released in between',
    'an identity link committed first is seen and refuses the delete; a delete committed first makes the link fail (both orders, with manual, automatic and PKCE callbacks)',
    'PostgREST writers of other roles in both lock orders (login KEY SHARE -> account -> entitlement)',
    'cross-role execution limits: only the owner role can run it; no grant to authenticated or service_role',
    'the managed_auth_delete gate stays blocked in normal candidates; no proof-only gate DDL without separate approval',
  ],
} as const;

export const E11_DENOMINATORS = ['sessions', 'refresh_tokens', 'identities', 'identity_linked_audit', 'owned_objects', 'guarded_rows', 'unguarded_rows'] as const;
export type E11Denominator = typeof E11_DENOMINATORS[number];

export const E11_FAILURE_BRANCHES = [
  'fk_restrict_denied', 'trigger_denied', 'role_acl_denied', 'lock_timeout', 'statement_timeout', 'explicit_rollback_before_commit', 'ambiguous_commit_readback',
] as const;
export type E11FailureBranch = typeof E11_FAILURE_BRANCHES[number];

export const E11_TOKEN_CASES = ['valid_old_jwt', 'expired_old_jwt'] as const;
export const E11_TOKEN_TARGETS = ['guarded_writer', 'unguarded_writer', 'storage_upload', 'auth_get_user'] as const;
export type E11TokenKey = `${typeof E11_TOKEN_CASES[number]}:${typeof E11_TOKEN_TARGETS[number]}`;
export type E11TokenOutcome = 'REFUSED' | 'ACCEPTED_RESIDUE_RECORDED' | 'ACCEPTED_UNRECORDED' | 'UNKNOWN';

export type E11RowId = 'A_AUDIT' | 'B_STORAGE' | 'C_FAILURE_PATHS' | 'D_SESSIONS_REFRESH' | 'E_TOKENS_WRITERS';
export interface E11Row { id: E11RowId; compares: string; pass: string; fail: string; unknown: string }

export const E11_ROWS: readonly E11Row[] = [
  {
    id: 'A_AUDIT',
    compares: 'Admin cohort: a user_deleted audit row per deleted user. SQL cohort: whether any deletion audit row exists (never assumed). Both: the identity_linked rows captured before survive.',
    pass: 'Both cohorts measured against their before-counts; identity_linked rows equal before and after in both; the SQL path\'s deletion-audit count recorded as observed.',
    fail: 'identity_linked rows lost in either cohort.',
    unknown: 'audit table absent or unreadable, or no identity_linked denominator.',
  },
  {
    id: 'B_STORAGE',
    compares: 'Users with owned Storage objects vs users without, in both cohorts: does the delete succeed or refuse, what happens to object metadata rows and to the physical blob (service read-back).',
    pass: 'Every variant classified (refused / succeeded with zero owned rows and no blob / succeeded leaving rows or blobs) with metadata and blob read-back.',
    fail: 'An owned object left with no metadata trace, or a blob readable with no metadata row.',
    unknown: 'no owned-object denominator, or metadata / blob not readable.',
  },
  {
    id: 'C_FAILURE_PATHS',
    compares: 'SQL cohort failure branches: FK RESTRICT, trigger refusal, role/ACL refusal, lock_timeout, statement_timeout, explicit ROLLBACK before COMMIT, and a COMMIT whose answer is lost.',
    pass: 'Each refused / rolled-back branch leaves the user and every captured child row unchanged (read-back equals before); the lost-COMMIT branch is resolved by read-back only.',
    fail: 'Any partial change after a refusal or rollback, or a blind retry of the DELETE.',
    unknown: 'a branch not exercised or not read back.',
  },
  {
    id: 'D_SESSIONS_REFRESH',
    compares: 'Session and refresh-token rows looked up by the target ids captured BEFORE the delete (never by joining from the deleted user).',
    pass: 'Non-zero before-counts by id; after-counts by the same ids recorded for both cohorts.',
    fail: 'none by itself: remaining rows are recorded facts; they block Option D through the residue rule.',
    unknown: 'zero denominators, ids not captured before the delete, or rows unreadable.',
  },
  {
    id: 'E_TOKENS_WRITERS',
    compares: 'After each cohort\'s delete: a still-valid old JWT and an explicitly expired old JWT against the guarded writer, an unguarded PostgREST writer, a Storage upload and GET /auth/v1/user, each with a read-back.',
    pass: 'Guarded writer and GET /user refuse both tokens; the expired token is refused everywhere; any accepted unguarded or Storage write is found by read-back (residue recorded).',
    fail: 'The guarded writer or GET /user accepts an old token, or any target accepts the expired token.',
    unknown: 'a case not run, or an accepted write without a read-back.',
  },
];

export interface CohortEvidence {
  method: 'admin_api_delete' | 'sql_delete_row_latch';
  fakeUsers: number;
  schemaFingerprintSha256: string;
  configFingerprintSha256: string;
  denominators: Record<E11Denominator, number>;
  /** Correlation ids are run-salted placeholders, never raw ids. */
  maskedCorrelation: boolean;
  tokens: Record<E11TokenKey, E11TokenOutcome>;
}

export interface E11Evidence {
  scope: string;
  cohorts: { admin: CohortEvidence; sql: CohortEvidence };
  rows: Record<E11RowId, Outcome>;
  failureBranches: Record<E11FailureBranch, 'UNCHANGED_READBACK' | 'CHANGED' | 'UNKNOWN'>;
  ambiguousCommit: { blindRetry: boolean; resolvedByReadback: boolean };
  /** True when "cleanup" was concluded from auth.users disappearing or a catalog hash alone. Must be false. */
  cleanupInferredFromUsersRowOrCatalog: boolean;
  /** True when either path was taken to revoke external provider grants. Must be false. */
  providerRevocationAssumed: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/u;

export function evaluateE11(e: E11Evidence | undefined): { outcome: Outcome; reasons: string[]; residue: boolean } {
  const fail: string[] = [];
  const unknown: string[] = [];
  let residue = false;
  if (!e) return { outcome: 'UNKNOWN', reasons: ['E11_MATRIX_MISSING'], residue };
  if (e.scope !== E11_PROBE_SCOPE) unknown.push('E11_SCOPE_MISLABELLED');
  const pairs = [['admin', 'admin_api_delete'], ['sql', 'sql_delete_row_latch']] as const;
  for (const [name, method] of pairs) {
    const c = e.cohorts?.[name];
    if (!c) { unknown.push(`E11_COHORT_MISSING:${name}`); continue; }
    if (c.method !== method) unknown.push(`E11_COHORT_METHOD:${name}`);
    if (!(c.fakeUsers >= 1)) unknown.push(`E11_COHORT_EMPTY:${name}`);
    if (!c.maskedCorrelation) unknown.push(`E11_CORRELATION_NOT_MASKED:${name}`);
    for (const d of E11_DENOMINATORS) if (!(c.denominators?.[d] > 0)) unknown.push(`E11_DENOMINATOR_ZERO:${name}:${d}`);
    for (const kind of E11_TOKEN_CASES) {
      for (const target of E11_TOKEN_TARGETS) {
        const key = `${kind}:${target}` as E11TokenKey;
        const got = c.tokens?.[key];
        const mustRefuse = kind === 'expired_old_jwt' || target === 'guarded_writer' || target === 'auth_get_user';
        if (got === undefined || got === 'UNKNOWN') unknown.push(`E11_TOKEN_NOT_MEASURED:${name}:${key}`);
        else if (mustRefuse && got !== 'REFUSED') fail.push(`E11_TOKEN_ACCEPTED:${name}:${key}`);
        else if (got === 'ACCEPTED_UNRECORDED') unknown.push(`E11_TOKEN_ACCEPTED_WITHOUT_READBACK:${name}:${key}`);
        else if (got === 'ACCEPTED_RESIDUE_RECORDED') residue = true;
      }
    }
  }
  const a = e.cohorts?.admin;
  const s = e.cohorts?.sql;
  if (a && s && (!HEX64.test(a.schemaFingerprintSha256) || a.schemaFingerprintSha256 !== s.schemaFingerprintSha256
    || !HEX64.test(a.configFingerprintSha256) || a.configFingerprintSha256 !== s.configFingerprintSha256)) {
    unknown.push('E11_COHORTS_NOT_COMPARABLE');
  }
  for (const b of E11_FAILURE_BRANCHES) {
    const got = e.failureBranches?.[b];
    if (got === 'CHANGED') fail.push(`E11_FAILURE_BRANCH_CHANGED_STATE:${b}`);
    else if (got !== 'UNCHANGED_READBACK') unknown.push(`E11_FAILURE_BRANCH_NOT_READ_BACK:${b}`);
  }
  if (e.ambiguousCommit?.blindRetry !== false) fail.push('E11_BLIND_RETRY');
  if (e.ambiguousCommit?.resolvedByReadback !== true) unknown.push('E11_AMBIGUOUS_COMMIT_NOT_RESOLVED');
  if (e.cleanupInferredFromUsersRowOrCatalog !== false) unknown.push('E11_CLEANUP_INFERRED_NOT_MEASURED');
  if (e.providerRevocationAssumed !== false) unknown.push('E11_PROVIDER_REVOCATION_ASSUMED');
  for (const row of E11_ROWS) {
    const got = e.rows?.[row.id];
    if (got === 'FAIL') fail.push(`E11_ROW_FAIL:${row.id}`);
    else if (got !== 'PASS') unknown.push(`E11_ROW_${got ?? 'MISSING'}:${row.id}`);
  }
  const outcome: Outcome = fail.length ? 'FAIL' : unknown.length ? 'UNKNOWN' : 'PASS';
  return { outcome, reasons: [...fail, ...unknown], residue };
}
