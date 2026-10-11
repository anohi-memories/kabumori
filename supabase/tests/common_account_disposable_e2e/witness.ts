// Manual witness checks for a FUTURE disposable-Supabase proof run (Phase 3e, H2 E11 review R4). OFFLINE ONLY.
//
// The guard (guard.ts) only decides dry-run plan eligibility from SELF-DECLARED inputs: a marker, a ledger, a typed
// sentence and approval reference strings. None of that proves the real destination, the reviewer, the fake-only
// users or the prior evidence. These checks are what a person must actually observe, at the window, before the
// matching destructive step -- recorded per run, never self-declared by the requester, and fail-closed: a missing,
// mismatching, unreadable or self-declared record blocks. They are human attestations, not machine verification;
// nothing here connects anywhere.
import type { ExperimentId } from './catalog.ts';

export type WitnessId =
  | 'W1_NEW_DISPOSABLE_PROJECT'
  | 'W2_PROTECTED_PROJECTS_EXCLUDED'
  | 'W3_CONNECTION_TARGET'
  | 'W4_FAKE_USER_PROVENANCE'
  | 'W5_SINGLE_ROW_DELETE_TARGET'
  | 'W6_APPROVAL_PROVENANCE'
  | 'W7_PRIOR_EVIDENCE';
export type WitnessRole = 'operator' | 'user' | 'independent_reviewer';
export type WitnessMethod = 'dashboard_view' | 'sql_readback' | 'document_review';

export interface WitnessCheck {
  id: WitnessId;
  /** Every destructive experiment, or E11 only. */
  appliesTo: 'every_destructive_experiment' | 'E11';
  what: string;
  how: string;
  methods: readonly WitnessMethod[];
  /** A second, different person must confirm (the requester's own declaration is not enough). */
  twoPerson: boolean;
}

export const WITNESS_CHECKS: readonly WitnessCheck[] = [
  {
    id: 'W1_NEW_DISPOSABLE_PROJECT',
    appliesTo: 'every_destructive_experiment',
    what: 'The target is the project created for THIS run: created after the user approval, empty except the run\'s fake fixtures, named like the marker.',
    how: 'Operator and user look at the dashboard together and compare name, creation time (JST) and the ref shown with the marker; the ref is never written to the repository.',
    methods: ['dashboard_view'],
    twoPerson: true,
  },
  {
    id: 'W2_PROTECTED_PROJECTS_EXCLUDED',
    appliesTo: 'every_destructive_experiment',
    what: 'The target is neither of the two running app projects (stock-x-autopost, anohi-memories) nor the inactive historical common-account-gateb-20261005.',
    how: 'Operator and user read the refs of the three protected projects from the dashboard at the window and confirm each differs from the target (compared on screen; only a run-salted hash prefix is recorded).',
    methods: ['dashboard_view'],
    twoPerson: true,
  },
  {
    id: 'W3_CONNECTION_TARGET',
    appliesTo: 'every_destructive_experiment',
    what: 'The SQL / HTTP client is connected to the W1 project and nothing else.',
    how: 'Before the first write of the run: the connection host\'s ref equals W1, and a read-back of the run\'s fake fixture marker row succeeds only there.',
    methods: ['sql_readback', 'dashboard_view'],
    twoPerson: false,
  },
  {
    id: 'W4_FAKE_USER_PROVENANCE',
    appliesTo: 'every_destructive_experiment',
    what: 'Every user the step touches was created by the operator in this run (run-scoped allowlist): created after the run start, on the run\'s fake mail domain, recorded by hashed id before use.',
    how: 'SQL read-back of auth.users created_at / e-mail domain for the allowlisted ids; any user outside the allowlist stops the run.',
    methods: ['sql_readback'],
    twoPerson: false,
  },
  {
    id: 'W5_SINGLE_ROW_DELETE_TARGET',
    appliesTo: 'E11',
    what: 'The E11 DELETE targets exactly one allowlisted fake user: count = 1 before, predicate is the id only, row_count = 1 after, otherwise rollback.',
    how: 'In the same transaction: select count(*) where id = <target> = 1 and the id is in the W4 allowlist; DELETE ... WHERE id = <target>; GET DIAGNOSTICS row_count = 1 before COMMIT.',
    methods: ['sql_readback'],
    twoPerson: false,
  },
  {
    id: 'W6_APPROVAL_PROVENANCE',
    appliesTo: 'E11',
    what: 'The user approval and the independent security review exist as real documents that name this run, this scenario and the reviewed runbook head -- not just reference strings in the request.',
    how: 'Operator opens both documents; the user confirms the approval is theirs and current; the review names the exact runbook head it approved.',
    methods: ['document_review'],
    twoPerson: true,
  },
  {
    id: 'W7_PRIOR_EVIDENCE',
    appliesTo: 'E11',
    what: 'E1, E8, E9, E10 and E12 of this project have redacted PASS evidence reviewed by the operator before E11 starts.',
    how: 'Operator reviews each evidence file and the verdict() rows for those experiments.',
    methods: ['document_review'],
    twoPerson: false,
  },
];

export interface WitnessRecord {
  id: WitnessId;
  run_id: string;
  observed_by: WitnessRole;
  second_observer?: WitnessRole;
  method: WitnessMethod;
  /** ISO instant of the observation. */
  observed_at: string;
  result: 'MATCH' | 'MISMATCH' | 'UNREADABLE';
  /** Redacted evidence file names. */
  evidence: string[];
  /** True when the record only repeats what the run request declared. Such a record never counts. */
  self_declared: boolean;
}

/** The witness checks a set of scenarios needs. */
export function requiredWitness(scenarios: readonly ExperimentId[], destructive: (id: ExperimentId) => boolean): WitnessId[] {
  const needed = new Set<WitnessId>();
  for (const id of scenarios) {
    if (destructive(id)) for (const c of WITNESS_CHECKS) if (c.appliesTo === 'every_destructive_experiment') needed.add(c.id);
    if (id === 'E11') for (const c of WITNESS_CHECKS) if (c.appliesTo === 'E11') needed.add(c.id);
  }
  return WITNESS_CHECKS.map((c) => c.id).filter((id) => needed.has(id));
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u;
const ROLES: readonly unknown[] = ['operator', 'user', 'independent_reviewer'];
const RESULTS: readonly unknown[] = ['MATCH', 'MISMATCH', 'UNREADABLE'];

/**
 * Fail closed on every record shape (Phase 3f, H2 rereview R4): a record counts only when `self_declared` is the
 * boolean false -- missing, null, a string, a number or true never count -- and every other field has its declared
 * type. A well-formed record is still only an attestation, not proof that a person observed anything.
 */
export function evaluateWitness(records: readonly WitnessRecord[] | undefined, runId: string | undefined, required: readonly WitnessId[]) {
  const reasons: string[] = [];
  if (typeof runId !== 'string' || runId.length === 0) reasons.push('WITNESS_RUN_ID_MISSING');
  const list: readonly unknown[] = Array.isArray(records) ? records : [];
  for (const id of required) {
    const check = WITNESS_CHECKS.find((c) => c.id === id)!;
    const mine = list.filter((r): r is WitnessRecord =>
      typeof r === 'object' && r !== null && (r as WitnessRecord).id === id && (r as WitnessRecord).run_id === runId);
    if (mine.length === 0) { reasons.push(`WITNESS_MISSING:${id}`); continue; }
    if (mine.length > 1) { reasons.push(`WITNESS_AMBIGUOUS:${id}`); continue; }
    const r = mine[0] as unknown as Record<string, unknown>;
    if (r.self_declared === true) reasons.push(`WITNESS_SELF_DECLARED:${id}`);
    else if (r.self_declared !== false) reasons.push(`WITNESS_MALFORMED:${id}:self_declared`);
    if (!ROLES.includes(r.observed_by)) reasons.push(`WITNESS_MALFORMED:${id}:observed_by`);
    if (r.second_observer !== undefined && !ROLES.includes(r.second_observer)) reasons.push(`WITNESS_MALFORMED:${id}:second_observer`);
    if (!RESULTS.includes(r.result)) reasons.push(`WITNESS_MALFORMED:${id}:result`);
    else if (r.result === 'MISMATCH') reasons.push(`WITNESS_MISMATCH:${id}`);
    else if (r.result !== 'MATCH') reasons.push(`WITNESS_UNREADABLE:${id}`);
    if (!(check.methods as readonly unknown[]).includes(r.method)) reasons.push(`WITNESS_METHOD:${id}`);
    if (typeof r.observed_at !== 'string' || !ISO.test(r.observed_at) || Number.isNaN(new Date(r.observed_at).getTime())) reasons.push(`WITNESS_TIME:${id}`);
    if (!Array.isArray(r.evidence) || r.evidence.length === 0 || !r.evidence.every((x) => typeof x === 'string' && x.length > 0)) reasons.push(`WITNESS_NO_EVIDENCE:${id}`);
    if (check.twoPerson && (r.second_observer === undefined || r.second_observer === r.observed_by)) reasons.push(`WITNESS_NOT_TWO_PERSON:${id}`);
  }
  return { complete: reasons.length === 0, reasons };
}
