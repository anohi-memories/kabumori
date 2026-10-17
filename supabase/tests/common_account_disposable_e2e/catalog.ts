// The E1-E12 disposable-Supabase experiments of PR121 (docs/common-account/phase3b-identity-writer-fence-feasibility.md
// section 8 at exact head 76b50e1e03f82faaa3460bab1603afa8fef3ce44), as data. `what` and `pass` are the PR121 table
// cells verbatim (pinned by pr121_e1_e12_rows.md and its sha256); everything else is the Phase 3c readiness model.
// OFFLINE ONLY: this module describes experiments, it runs none and contains no network code.

export const PR121_HEAD = '76b50e1e03f82faaa3460bab1603afa8fef3ce44';
export const PR121_ROWS_SHA256 = '8678d45539fa25e3373a29318770e0313999c411949d719e8b7cdbc2679f7b66';

export type ExperimentId = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8' | 'E9' | 'E10' | 'E11' | 'E12';
export const EXPERIMENT_IDS: readonly ExperimentId[] = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11', 'E12'];

/** observation: reads only. destructive: changes users, sessions, identities, config or schema of the disposable project. */
export type Kind = 'observation' | 'destructive';
/** How the timing that matters can be controlled. */
export type Forcing = 'none_needed' | 'operator_paced_barrier' | 'database_lock_latch' | 'statistical_only';
/** Which candidate fence the experiment informs (never a choice between them). */
export type Informs = 'A+B' | 'D' | 'both';
/** Approvals beyond the run approval and the per-scenario destructive consent. */
export type ExtraApproval = 'option_d_security_approval' | 'project_auth_config_change';

export interface Experiment {
  id: ExperimentId;
  what: string;
  pass: string;
  kind: Kind;
  /** What the experiment does to the disposable project (empty for an observation). */
  destructiveOperations: readonly string[];
  extraApprovals: readonly ExtraApproval[];
  forcing: Forcing;
  informs: Informs;
  /** Non-secret inputs the operator must supply (names only; values never live in the repository). */
  inputs: readonly string[];
  /** Evidence the experiment must record (redacted). */
  observables: readonly string[];
  /** Conditions under which the outcome is UNKNOWN (fail closed), never PASS. */
  unknownWhen: readonly string[];
}

const RUN_INPUTS = ['approved disposable project ref', 'run_id', 'fake test identities created for this run'];

export const EXPERIMENTS: readonly Experiment[] = [
  {
    id: 'E1',
    what: 'Version and config',
    pass: 'GoTrue ≥ v2.195.0 recorded. Manual linking, flow-state expiry, request duration, JWT expiry, session time-box and audit-to-Postgres recorded.',
    kind: 'observation',
    destructiveOperations: [],
    extraApprovals: [],
    forcing: 'none_needed',
    informs: 'both',
    inputs: [...RUN_INPUTS, 'read-only Management API access for the disposable project (operator-held, never stored)'],
    observables: [
      'GET /auth/v1/health version string',
      'allowlisted auth config fields: security_manual_linking_enabled, api_max_request_duration, jwt_exp, sessions_timebox, sessions_inactivity_timeout, hook_custom_access_token_enabled, refresh_token_rotation_enabled',
      'flow-state expiry and audit-to-Postgres are not exposed by the Management API: recorded as "not exposed" and measured in E4 / E10',
      'catalog fingerprint (catalog_fingerprint.sql) sha256',
    ],
    unknownWhen: ['the version string is missing or unparsable', 'an allowlisted field is absent from the config answer'],
  },
  {
    id: 'E2',
    what: 'Ban vs OAuth callback with automatic linking (same verified email)',
    pass: '403 `user_banned`; no `auth.identities` row; no session',
    kind: 'destructive',
    destructiveOperations: ['create fake user', 'Admin ban of the fake user', 'OAuth sign-in with a fake provider account sharing the verified email'],
    extraApprovals: [],
    forcing: 'operator_paced_barrier',
    informs: 'A+B',
    inputs: [...RUN_INPUTS, 'fake test OAuth/OIDC provider account (dummy only)'],
    observables: ['callback HTTP status and error code', 'auth.identities rows of the fake user (count, providers)', 'auth.sessions rows of the fake user (count)', 'ban commit time (banned_until, updated_at)'],
    unknownWhen: ['the provider account email is not verified at the provider', 'the callback did not reach GoTrue (provider error)'],
  },
  {
    id: 'E3',
    what: 'Ban vs manual link **started after** the ban',
    pass: '`/user/identities/authorize` gives 403',
    kind: 'destructive',
    destructiveOperations: ['create fake user', 'Admin ban of the fake user', 'manual link attempt with a pre-ban access token'],
    extraApprovals: [],
    forcing: 'operator_paced_barrier',
    informs: 'A+B',
    inputs: [...RUN_INPUTS, 'fake test OAuth/OIDC provider account (dummy only)'],
    observables: ['/user/identities/authorize HTTP status and error code', 'auth.identities rows of the fake user'],
    unknownWhen: ['manual linking is disabled on the project (then the endpoint refuses for another reason: recorded, not PASS)'],
  },
  {
    id: 'E4',
    what: '**Manual link started before the ban, callback after it (V11)**',
    pass: 'Expected to **link**: confirms or refutes the counterexample. If it links, Option A needs manual linking off, or a settle time longer than the flow-state expiry.',
    kind: 'destructive',
    destructiveOperations: ['create fake user', 'start a manual link', 'Admin ban while the provider consent is paused', 'complete the provider consent after the ban'],
    extraApprovals: [],
    forcing: 'operator_paced_barrier',
    informs: 'A+B',
    inputs: [...RUN_INPUTS, 'fake test OAuth/OIDC provider account (dummy only)'],
    observables: [
      'link start time, ban commit time, callback time (UTC + JST) with one correlation id',
      'auth.identities row created_at relative to the ban commit',
      'finding: LINKED or REFUSED',
      'flow-state lifetime: the latest callback delay that still links (measures the expiry)',
    ],
    unknownWhen: ['the ban commit time cannot be read back', 'the callback failed for a provider-side reason', 'manual linking is disabled (the counterexample path cannot be exercised)'],
  },
  {
    id: 'E5',
    what: 'Ban vs refresh and ID-token grant; logout ordering',
    pass: 'Refresh 400 `user_banned`; ID-token sign-in 403; `/logout` refused after the ban (so revoke before the ban)',
    kind: 'destructive',
    destructiveOperations: ['create fake user', 'sign in', 'Admin ban', 'refresh / ID-token / logout attempts'],
    extraApprovals: [],
    forcing: 'operator_paced_barrier',
    informs: 'A+B',
    inputs: [...RUN_INPUTS, 'fake test OIDC issuer for the ID-token grant if supported'],
    observables: ['HTTP status and error code of each grant and of /logout', 'auth.sessions and auth.refresh_tokens counts before and after'],
    unknownWhen: ['no test OIDC issuer is available for the ID-token grant (that half stays UNKNOWN)'],
  },
  {
    id: 'E6',
    what: 'Concurrency: about 200 parallel link and sign-in attempts fired around the ban commit, repeated',
    pass: 'The maximum time from ban commit to a committed identity is measured, and it is ≤ the configured request duration',
    kind: 'destructive',
    destructiveOperations: ['create fake users', 'about 200 parallel link / sign-in attempts per round', 'Admin ban during the burst', 'repeat'],
    extraApprovals: [],
    forcing: 'statistical_only',
    informs: 'A+B',
    inputs: [...RUN_INPUTS, 'fake test OAuth/OIDC provider accounts (dummy only)', 'rate-limit headroom on the disposable project'],
    observables: ['per attempt: correlation id, send time, HTTP status, identity created_at', 'ban commit time', 'maximum (identity commit - ban commit) over all rounds'],
    unknownWhen: [
      'no attempt was in flight across the ban commit (the window was never exercised)',
      'rate limiting or provider throttling rejected attempts before GoTrue',
      'clock skew between the operator host and the database is not bounded',
    ],
  },
  {
    id: 'E7',
    what: 'Custom Access Token hook refusing a `deleting` account',
    pass: 'Refuses password, refresh, PKCE exchange and ID token. A PKCE link before the exchange **is** committed (V10). Measure latency, and the behaviour when the hook errors.',
    kind: 'destructive',
    destructiveOperations: ['enable a test Custom Access Token hook on the disposable project', 'create fake users', 'grant attempts', 'make the hook error on purpose'],
    extraApprovals: ['project_auth_config_change'],
    forcing: 'operator_paced_barrier',
    informs: 'A+B',
    inputs: [...RUN_INPUTS, 'test hook function (disposable database only)'],
    observables: ['HTTP status and error of each grant with the hook refusing', 'auth.identities after a PKCE link with a refused exchange', 'hook latency', 'grant behaviour when the hook raises'],
    unknownWhen: ['the hook could not be enabled on the project plan'],
  },
  {
    id: 'E8',
    what: 'Admin delete cascades on the project\'s schema',
    pass: 'Every `auth` child row is gone. Phase 1\'s shadow guard records `login_removed`. Public foreign keys behave as in the fixtures.',
    kind: 'destructive',
    destructiveOperations: ['apply Phase 1/2/3a migrations to the disposable database', 'create fake users with sessions, identities, factors and service rows', 'Admin delete of a fake user'],
    extraApprovals: [],
    forcing: 'none_needed',
    informs: 'both',
    inputs: [...RUN_INPUTS],
    observables: ['per auth table: rows of the fake user before and after (counts only)', 'Phase 1 operation status and last_error_code', 'public rows of the fake user before and after', 'catalog fingerprint sha256 before and after'],
    unknownWhen: ['an auth table could not be read by the inspecting role'],
  },
  {
    id: 'E9',
    what: 'Stale tokens after logout, ban and delete, against PostgREST and Storage',
    pass: 'Guarded writer codes match §6. Unguarded writer and Storage-upload outcomes are recorded. `auth.sessions` is readable by `postgres` (H5).',
    kind: 'destructive',
    destructiveOperations: ['apply the PR121 guard and a G4-shaped test writer in the disposable database', 'create a fake test bucket and policy', 'logout, ban and delete fake users', 'replay their old access tokens'],
    extraApprovals: [],
    forcing: 'operator_paced_barrier',
    informs: 'both',
    inputs: [...RUN_INPUTS, 'fake test bucket created for this run'],
    observables: ['guarded writer error code per state', 'unguarded writer outcome per state', 'Storage upload outcome and storage.objects owner_id read-back', 'has_table_privilege(postgres, auth.sessions, SELECT)'],
    unknownWhen: ['the access token expired before the replay (JWT expiry shorter than the experiment)'],
  },
  {
    id: 'E10',
    what: 'Audit log',
    pass: '`identity_linked` rows (actor, provider) persist after the user\'s deletion and can be read by `postgres` (H4)',
    kind: 'destructive',
    destructiveOperations: ['link an identity to a fake user', 'Admin delete of the fake user'],
    extraApprovals: [],
    forcing: 'none_needed',
    informs: 'both',
    inputs: [...RUN_INPUTS],
    observables: ['auth.audit_log_entries rows for the fake actor before and after deletion (action, provider; ids hashed)', 'has_table_privilege(postgres, auth.audit_log_entries, SELECT)'],
    unknownWhen: ['the audit table is absent or unreadable (audit-to-Postgres disabled or no privilege)'],
  },
  {
    id: 'E11',
    what: 'Option D',
    pass: 'Can `postgres` `DELETE FROM auth.users` under our lock? Differences from the Admin delete. GoTrue\'s view of the user\'s tokens afterwards.',
    kind: 'destructive',
    destructiveOperations: ['SQL DELETE of a fake user row in auth.users under the lifecycle lock (disposable database only)'],
    extraApprovals: ['option_d_security_approval'],
    forcing: 'database_lock_latch',
    informs: 'D',
    inputs: [...RUN_INPUTS],
    observables: ['permission outcome of the DELETE', 'per auth table rows before and after, compared with E8', 'GoTrue answers for the deleted user\'s access and refresh tokens', 'catalog fingerprint sha256 before and after'],
    unknownWhen: ['E8 has no comparable result'],
  },
  {
    id: 'E12',
    what: 'Apply the guard migration on the disposable database',
    pass: 'Preflight and postcondition pass. Catalog read-back. A G4-shaped writer wired **in the disposable database only** passes 6a–6g against real PostgREST.',
    kind: 'destructive',
    destructiveOperations: ['apply 20261010051938_common_account_service_write_guard.sql (PR121 head) to the disposable database', 'create a G4-shaped test writer there', 'race 6a-6g through PostgREST with fake users'],
    extraApprovals: [],
    forcing: 'database_lock_latch',
    informs: 'both',
    inputs: [...RUN_INPUTS, 'PR121 exact head checkout (read-only)'],
    observables: ['preflight / postcondition notices', 'catalog fingerprint sha256 after apply', 'per race 6a-6g: outcome, lock-wait observation, footprint count'],
    unknownWhen: ['the migration owner on the project differs from the writer owner (the guard is then unreachable by design: recorded, not PASS)'],
  },
];

export function experiment(id: string): Experiment | undefined {
  return EXPERIMENTS.find((e) => e.id === id);
}

/** Experiments each candidate fence needs before it can even be reviewed. Neither is chosen here. */
export const REQUIRED_FOR: Readonly<Record<'A+B' | 'D', readonly ExperimentId[]>> = {
  'A+B': ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E12'],
  'D': ['E1', 'E8', 'E9', 'E10', 'E11', 'E12'],
};
