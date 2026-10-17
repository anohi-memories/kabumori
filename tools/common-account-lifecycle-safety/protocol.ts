// Account-closure decision logic (Phase 3i, G5). SYNTHETIC / OFFLINE ONLY.
//
// This is the PROPOSED decision logic of the closure orchestrator as a pure function of observed facts, so that it can
// be regression-tested without a database, Supabase or any provider. It is not proof of how managed Supabase behaves
// and nothing here is wired to anything. The design and the guarantee table are in
// docs/common-account/phase3i-lifecycle-safety-design.md.
//
// Principles (each is exercised by protocol_test.ts / invariants_test.ts):
//   * Only enforceable boundaries are claimed. A BAN, a token hook, a fixed waiting period or an Auth delete is
//     NEVER an input that makes a decision safer: the decision depends on read-back facts, not on elapsed time.
//   * Anything unknown fails closed: STOP before the closure starts, RECONCILE once it has begun. Never "assume".
//   * Resume is a pure re-derivation: the same facts always give the same decision; a single-use external step is
//     never repeated, and an ambiguous Auth delete is only ever read back.
//   * COMPLETE needs verification facts that were READ AFTER the delete; "the delete call returned" is not one.

export const BOUNDARIES = ['state_predicate', 'writer_guard', 'person_token_edge_checks', 'storage_write_policy', 'orphan_sweeper'] as const;
export type BoundaryName = typeof BOUNDARIES[number];
/** attested: an installed, read-back-verified boundary of the CURRENT manifest. missing/unknown never count. */
export type BoundaryStatus = 'attested' | 'missing' | 'unknown';

export type StepState = 'not_attempted' | 'done' | 'failed';
export type ProviderState = 'revoked' | 'remote_unverified' | 'pending' | 'failed' | 'not_applicable' | 'unknown';

export interface Facts {
  boundaries: Record<BoundaryName, BoundaryStatus>;
  account: 'active' | 'deleting' | 'locked' | 'absent' | 'unknown';
  operation: 'none' | 'open' | 'aborted';
  reauth: 'fresh' | 'stale' | 'unknown';
  /** Best-effort Auth containment. Recorded, never required, never a guarantee. */
  containment: { sessions: StepState; ban: StepState };
  serviceData: 'clean' | 'residue' | 'unknown';
  storage: { remaining: number | null; consecutiveZeroReads: number };
  /** Keyed by the provider of every identity known so far. */
  providers: Record<string, ProviderState>;
  /** Taken under the exclusive login lock by the decision step. */
  identities: { snapshot: string[] | null; current: string[] | null };
  authDelete: 'not_attempted' | 'confirmed' | 'failed_before_commit' | 'ambiguous';
  /** Read AFTER the delete. null = not read yet. */
  postDelete: { serviceResidue: number | null; storageResidue: number | null; lateIdentityEvents: number | null };
  attempts: { cleanup: number; delete: number; orphan: number };
  /** Carried only to prove that waiting is not evidence. decide() must ignore it. */
  elapsedSinceFreezeSec: number;
}

export type Step =
  | 'freeze' | 'revoke_sessions' | 'ban' | 'read_footprint' | 'cleanup_service_data' | 'cleanup_storage'
  | 'record_snapshot' | 'auth_delete' | 'readback_user' | 'verify' | 'cleanup_orphans'
  | `revoke_provider:${string}`;

export type Decision =
  | { kind: 'RUN'; step: Step; why: string }
  | { kind: 'STOP'; code: StopCode; detail: string[] }
  | { kind: 'RECONCILE'; code: ReconcileCode; detail: string[] }
  | { kind: 'COMPLETE'; disclosures: string[] };

export type StopCode =
  | 'FACTS_INVALID' | 'BOUNDARY_UNPROVEN' | 'ACCOUNT_LOCKED' | 'ACCOUNT_STATE_UNKNOWN' | 'REAUTH_REQUIRED' | 'LIFECYCLE_INCONSISTENT';
export type ReconcileCode =
  | 'LOGIN_REMOVED_WITHOUT_INTENT' | 'LATE_IDENTITY_DETECTED' | 'RESIDUE_AFTER_DELETE' | 'CLEANUP_NOT_CONVERGING'
  | 'DELETE_NOT_CONFIRMED' | 'PROVIDER_UNRESOLVED' | 'UNKNOWN_AFTER_START';

export const LIMITS = { cleanup: 4, delete: 2, orphan: 3, stableStorageReads: 2 } as const;

const ENUMS = {
  boundary: ['attested', 'missing', 'unknown'],
  account: ['active', 'deleting', 'locked', 'absent', 'unknown'],
  operation: ['none', 'open', 'aborted'],
  reauth: ['fresh', 'stale', 'unknown'],
  step: ['not_attempted', 'done', 'failed'],
  serviceData: ['clean', 'residue', 'unknown'],
  provider: ['revoked', 'remote_unverified', 'pending', 'failed', 'not_applicable', 'unknown'],
  authDelete: ['not_attempted', 'confirmed', 'failed_before_commit', 'ambiguous'],
} as const;

const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isIn = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v);

/** Structural validation. A malformed fact set is never "interpreted": it is a STOP. */
export function validate(f: unknown): string[] {
  const issues: string[] = [];
  if (typeof f !== 'object' || f === null) return ['FACTS_NOT_OBJECT'];
  const x = f as Facts;
  for (const b of BOUNDARIES) if (!isIn(ENUMS.boundary, x.boundaries?.[b])) issues.push(`BOUNDARY_STATUS:${b}`);
  if (!isIn(ENUMS.account, x.account)) issues.push('ACCOUNT');
  if (!isIn(ENUMS.operation, x.operation)) issues.push('OPERATION');
  if (!isIn(ENUMS.reauth, x.reauth)) issues.push('REAUTH');
  if (!isIn(ENUMS.step, x.containment?.sessions) || !isIn(ENUMS.step, x.containment?.ban)) issues.push('CONTAINMENT');
  if (!isIn(ENUMS.serviceData, x.serviceData)) issues.push('SERVICE_DATA');
  if (!(x.storage && (x.storage.remaining === null || isCount(x.storage.remaining)) && isCount(x.storage.consecutiveZeroReads))) issues.push('STORAGE');
  if (typeof x.providers !== 'object' || x.providers === null || Array.isArray(x.providers)
    || !Object.values(x.providers).every((p) => isIn(ENUMS.provider, p))) issues.push('PROVIDERS');
  const ids = x.identities;
  const idList = (v: unknown) => v === null || (Array.isArray(v) && v.every((p) => typeof p === 'string'));
  if (!ids || !idList(ids.snapshot) || !idList(ids.current)) issues.push('IDENTITIES');
  if (!isIn(ENUMS.authDelete, x.authDelete)) issues.push('AUTH_DELETE');
  const pd = x.postDelete;
  if (!pd || ![pd.serviceResidue, pd.storageResidue, pd.lateIdentityEvents].every((v) => v === null || isCount(v))) issues.push('POST_DELETE');
  const at = x.attempts;
  if (!at || !isCount(at.cleanup) || !isCount(at.delete) || !isCount(at.orphan)) issues.push('ATTEMPTS');
  if (typeof x.elapsedSinceFreezeSec !== 'number' || !Number.isFinite(x.elapsedSinceFreezeSec) || x.elapsedSinceFreezeSec < 0) issues.push('ELAPSED');
  return issues;
}

/**
 * Boundaries that must be attested before a closure may start. The orphan sweeper is always required: writers that no
 * request-time boundary reaches (service-role jobs, a table outside the manifest, a straggler after the delete) can only
 * be found by it. The Storage write policy is not required; it decides whether I3 may be claimed (claimedInvariants).
 */
export const REQUIRED_TO_START = ['state_predicate', 'writer_guard', 'person_token_edge_checks', 'orphan_sweeper'] as const;

export function unmetBoundaries(b: Record<BoundaryName, BoundaryStatus>): BoundaryName[] {
  return REQUIRED_TO_START.filter((name) => b[name] !== 'attested');
}

/** The invariants of the design document that this manifest lets the closure CLAIM. Never more than the boundaries give. */
export function claimedInvariants(b: Record<BoundaryName, BoundaryStatus>): string[] {
  const claimed = ['I4', 'I5', 'I6']; // pure logic: verified completion, no replay of single-use steps, provider outcomes
  const dataPlane = ['state_predicate', 'writer_guard', 'person_token_edge_checks'].every((n) => b[n as BoundaryName] === 'attested');
  if (dataPlane) claimed.push('I1', 'I2');
  if (dataPlane && b.storage_write_policy === 'attested') claimed.push('I3');
  if (b.orphan_sweeper === 'attested') claimed.push('I7');
  return claimed.sort();
}

const run = (step: Step, why: string): Decision => ({ kind: 'RUN', step, why });
const stop = (code: StopCode, ...detail: string[]): Decision => ({ kind: 'STOP', code, detail });
const reconcile = (code: ReconcileCode, ...detail: string[]): Decision => ({ kind: 'RECONCILE', code, detail });

function afterDelete(f: Facts): Decision {
  if (f.authDelete === 'not_attempted' || f.authDelete === 'failed_before_commit') {
    // The login disappeared by another route (operator, dashboard, an X saga SQL delete): not our verified delete.
    return reconcile('LOGIN_REMOVED_WITHOUT_INTENT', `authDelete=${f.authDelete}`);
  }
  if (f.identities.snapshot === null) return reconcile('LOGIN_REMOVED_WITHOUT_INTENT', 'no decision snapshot was recorded');
  const pd = f.postDelete;
  if (pd.serviceResidue === null || pd.storageResidue === null || pd.lateIdentityEvents === null) return run('verify', 'post-delete facts not read yet');
  if (pd.lateIdentityEvents > 0) return reconcile('LATE_IDENTITY_DETECTED', `events=${pd.lateIdentityEvents}`);
  if (pd.serviceResidue > 0 || pd.storageResidue > 0) {
    if (f.attempts.orphan >= LIMITS.orphan) return reconcile('RESIDUE_AFTER_DELETE', `service=${pd.serviceResidue}`, `storage=${pd.storageResidue}`);
    return run('cleanup_orphans', 'residue after the delete');
  }
  const unresolved = Object.entries(f.providers).filter(([, s]) => s === 'pending' || s === 'failed' || s === 'unknown').map(([p]) => p);
  if (unresolved.length) return reconcile('PROVIDER_UNRESOLVED', ...unresolved);
  const disclosures = Object.entries(f.providers).filter(([, s]) => s === 'remote_unverified').map(([p]) => `remote_unverified:${p}`);
  return { kind: 'COMPLETE', disclosures };
}

/**
 * The next action for one closure, from facts alone. Pure: same facts, same decision.
 * `elapsedSinceFreezeSec` is deliberately never read.
 */
export function decide(f: Facts): Decision {
  const issues = validate(f);
  if (issues.length) return stop('FACTS_INVALID', ...issues);

  if (f.account === 'absent') return afterDelete(f);

  const unmet = unmetBoundaries(f.boundaries);
  if (unmet.length) return stop('BOUNDARY_UNPROVEN', ...unmet);

  if (f.account === 'locked') return stop('ACCOUNT_LOCKED', 'a locked account is never closed by the self-service path');
  if (f.account === 'unknown') {
    return f.operation === 'open' ? reconcile('UNKNOWN_AFTER_START', 'account state unreadable after the closure began') : stop('ACCOUNT_STATE_UNKNOWN', 'before the closure');
  }

  if (f.account === 'active') {
    if (f.operation === 'open') return stop('LIFECYCLE_INCONSISTENT', 'an open closure on an active account');
    if (f.reauth !== 'fresh') return stop('REAUTH_REQUIRED', `reauth=${f.reauth}`);
    return run('freeze', 'start: state transition that every data-plane boundary reads');
  }
  // account === 'deleting' from here on
  if (f.operation !== 'open') return stop('LIFECYCLE_INCONSISTENT', 'deleting without an open operation');

  // After an ambiguous delete only a read-back is allowed, and nothing else may happen first.
  if (f.authDelete === 'ambiguous') return run('readback_user', 'ambiguous delete: read back, never repeat');

  // Best-effort containment, once. A failure is recorded and tolerated: it is not a boundary.
  if (f.containment.sessions === 'not_attempted') return run('revoke_sessions', 'containment (best effort, before the ban)');
  if (f.containment.ban === 'not_attempted') return run('ban', 'containment (best effort)');

  if (f.serviceData === 'unknown') {
    return f.attempts.cleanup >= LIMITS.cleanup ? reconcile('UNKNOWN_AFTER_START', 'service data unreadable') : run('read_footprint', 'service data state unknown');
  }
  if (f.serviceData === 'residue') {
    return f.attempts.cleanup >= LIMITS.cleanup ? reconcile('CLEANUP_NOT_CONVERGING', 'service data') : run('cleanup_service_data', 'service data present');
  }

  // Known identities: every provider grant must be resolved before the delete.
  const knownNow = new Set<string>([...(f.identities.current ?? []), ...(f.identities.snapshot ?? [])]);
  for (const provider of knownNow) {
    if (!(provider in f.providers)) {
      return f.attempts.cleanup >= LIMITS.cleanup ? reconcile('PROVIDER_UNRESOLVED', provider) : run(`revoke_provider:${provider}`, 'identity seen without a provider outcome');
    }
  }
  for (const [provider, state] of Object.entries(f.providers)) {
    if (state === 'pending' || state === 'failed') return run(`revoke_provider:${provider}`, `provider grant ${state}`);
    if (state === 'unknown') return reconcile('PROVIDER_UNRESOLVED', provider);
  }

  // Storage: removed through the Storage API and read until stable. null / unreadable never means "empty".
  if (f.storage.remaining === null) {
    return f.attempts.cleanup >= LIMITS.cleanup ? reconcile('UNKNOWN_AFTER_START', 'storage unreadable') : run('cleanup_storage', 'storage state unknown');
  }
  if (f.storage.remaining > 0) {
    return f.attempts.cleanup >= LIMITS.cleanup ? reconcile('CLEANUP_NOT_CONVERGING', 'storage') : run('cleanup_storage', 'objects remain');
  }
  if (f.storage.consecutiveZeroReads < LIMITS.stableStorageReads) return run('cleanup_storage', 'read again: one empty read is not stable');

  // The decision under the exclusive login lock: fresh identity snapshot, fresh residue.
  if (f.identities.snapshot === null) return run('record_snapshot', 'decision under the exclusive lock');
  if (f.identities.current === null) return run('record_snapshot', 'identities unreadable');
  const late = f.identities.current.filter((p) => !f.identities.snapshot!.includes(p));
  if (late.length) {
    return f.attempts.cleanup >= LIMITS.cleanup ? reconcile('CLEANUP_NOT_CONVERGING', `identity change: ${late.join(',')}`) : run('record_snapshot', `identity set changed: ${late.join(',')}`);
  }

  // Delete: exactly once per decision. A failure before commit re-decides; it never loops unbounded.
  if (f.authDelete === 'failed_before_commit' && f.attempts.delete >= LIMITS.delete) return reconcile('DELETE_NOT_CONFIRMED', 'delete failed repeatedly');
  if (f.authDelete === 'not_attempted' || f.authDelete === 'failed_before_commit') return run('auth_delete', 'verified, snapshotted, cleaned');
  // confirmed but the login is still readable: inconsistent, verify by read-back
  return reconcile('DELETE_NOT_CONFIRMED', 'delete reported done but the login is still present');
}

// ---------------------------------------------------------------------------------------------------------------------
// The data-plane gate: what an enforceable boundary decides for ONE request, whatever the token says.

export interface DbView {
  account: 'active' | 'deleting' | 'locked' | 'absent' | 'unknown';
  entitlement: 'active' | 'deleting' | 'ended' | 'missing' | 'unknown';
  sessionLive: boolean | 'unknown';
}
export type GateAnswer = 'ALLOW' | 'DENY_ACCOUNT' | 'DENY_ENTITLEMENT' | 'DENY_SESSION' | 'NO_BOUNDARY';

/**
 * A request is judged by the lifecycle state read NOW, never by how fresh or valid its token is. A token minted after
 * a ban (F2), an old one (F4) and a refreshed one are treated alike. Without an attested boundary the platform decides,
 * which this model reports as NO_BOUNDARY (not as a safe answer).
 */
export function gate(boundary: BoundaryStatus, db: DbView): GateAnswer {
  if (boundary !== 'attested') return 'NO_BOUNDARY';
  if (db.account !== 'active') return 'DENY_ACCOUNT';
  if (db.entitlement !== 'active') return 'DENY_ENTITLEMENT';
  if (db.sessionLive !== true) return 'DENY_SESSION';
  return 'ALLOW';
}

// ---------------------------------------------------------------------------------------------------------------------
// The orphan sweeper: rows / objects whose owner is gone. Compensating control for tables without a foreign key.

export interface OwnedRow { table: string; id: string; ownerId: string; createdAt: number }
export interface SweepInput { rows: OwnedRow[]; liveOwners: string[]; liveOwnersComplete: boolean; now: number; graceSec: number }
export type SweepResult = { ok: true; orphans: OwnedRow[] } | { ok: false; code: 'OWNER_LIST_INCOMPLETE' | 'OWNER_LIST_EMPTY' | 'BAD_GRACE' };

export function findOrphans(input: SweepInput): SweepResult {
  if (!input.liveOwnersComplete) return { ok: false, code: 'OWNER_LIST_INCOMPLETE' };
  if (input.liveOwners.length === 0) return { ok: false, code: 'OWNER_LIST_EMPTY' };
  if (!(input.graceSec >= 0) || !Number.isFinite(input.graceSec)) return { ok: false, code: 'BAD_GRACE' };
  const live = new Set(input.liveOwners);
  return { ok: true, orphans: input.rows.filter((r) => !live.has(r.ownerId) && input.now - r.createdAt >= input.graceSec) };
}
