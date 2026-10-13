// Kabumori's common-account lifecycle boundary: end Kabumori ("かぶモリの利用を終了"), preview and delete
// the whole common account ("共通アカウントを削除"). SOURCE CANDIDATE -- not deployed; independent review
// is mandatory before deploy. Design: docs/common-account/phase3a-deletion-orchestrator.md.
//
// Security model:
//   * The person is whoever the caller's own bearer token belongs to (GET /auth/v1/user). The request body
//     never names a user; every RPC receives the verified id only.
//   * Withdrawal and deletion need a recent authentication (the X saga's rule: newest `amr` timestamp at
//     most RECENT_AUTH_SECONDS old, `sub` == verified user; a timestamp in the future is refused) and an
//     explicit confirmation constant. A deletion is also bound to the lifecycle_version the person was
//     shown; any change refuses it.
//   * Whole-account deletion is the Phase 1 section 10 sequence, every step behind the lifecycle RPCs:
//     release-gate pre-check -> begin (version-bound) -> claim the durable ownership -> X through its
//     existing saga (scope social_only, so the saga never removes the login) -> Kabumori withdrawal ->
//     session revocation -> Apple grant revocation -> Storage through its API, re-listed until empty ->
//     prepare -> revalidate (Storage again + prepare again) -> managed delete intent (release gate, full
//     re-evaluation under the exclusive login lock) -> managed Auth Admin delete -> post-delete read-back.
//     Success is reported only after the read-back verified the deletion.
//   * One owner (H2 R1): after `begin`, a durable lease with a fence is taken before any external action;
//     every step re-checks it in the database (renew, owned checkpoint, owned prepare, step intent). A
//     second request is told 'in progress'; an owner that lost its lease stops before acting.
//   * Steps that must not be repeated blindly (H2 R1/R2) -- the Apple revocation (single-use code) and the
//     managed Auth delete -- are recorded as in flight before the call and settled after it. An outcome
//     that cannot be recorded or is unknown is never replayed: it waits for reconciliation.
//   * The managed Auth delete is release-blocked by a database gate (H2 R3): until it opens, a deletion
//     is refused before anything changes (COMMON_ACCOUNT_DELETION_UNAVAILABLE).
//   * POSTONA (Phase 6): ending it -- inside a whole-account deletion, or alone ("withdraw_postona") -- is
//     one owned operation (endPostona): the service deletion's own lease, X through its saga (typed outcome,
//     never edited), every other connected provider through its registered adapter, each answer recorded
//     durably, and the entitlement ended only by the owner, only when every recorded answer is settled and
//     every "the remote grant was not verified revoked" is acknowledged by the person (recorded BEFORE the
//     cleanup that makes it so). A connected provider without an adapter, or without the acknowledgement,
//     stops everything before anything changes.
//   * Every failure is a fixed code. Tokens, keys, ids, e-mail addresses, object names and server messages
//     are never returned or logged.
import { lastAuthenticatedAt, RECENT_AUTH_SECONDS } from '../social-mobile-account-delete/delete_logic.ts';
import type { AppleRevocationOutcome } from './apple_outcome.ts';
import { runProviderCleanups, type ProviderCleanupAdapter } from './provider_cleanup.ts';

export { RECENT_AUTH_SECONDS };

export const WITHDRAW_CONFIRMATION = 'END_KABUMORI_SERVICE';
export const DELETE_CONFIRMATION = 'DELETE_COMMON_ACCOUNT';
export const END_POSTONA_CONFIRMATION = 'END_POSTONA_SERVICE';
const PROVIDER_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/u;
/** Storage list -> remove passes per request before the request gives up (and a retry continues). */
export const STORAGE_PASSES = 3;
/** Ownership lease (seconds). Longer than any Edge request; the database also refuses a stale owner. */
export const LEASE_SECONDS = 600;
const STORAGE_REMOVE_CHUNK = 100;

export type LifecycleRpcName =
  | 'release_gate' | 'eligibility' | 'withdraw_kabumori' | 'begin_service_deletion' | 'finish_service_deletion'
  | 'begin_account_deletion' | 'claim' | 'renew' | 'release' | 'owned_checkpoint' | 'owned_prepare'
  | 'begin_external_step' | 'settle_external_step' | 'storage_objects' | 'complete' | 'record_error'
  | 'claim_service' | 'renew_service' | 'release_service' | 'record_provider_result' | 'acknowledge_unverified'
  | 'finish_owned_service' | 'provider_snapshot';
export type RpcResult = { ok: true; data: unknown } | { ok: false };

/** providers and Apple subjects come from the server's view of the person's identities. */
export type VerifiedUser = { id: string; providers: readonly string[]; appleSubjects: readonly string[] };

/**
 * The narrow adapter to the existing X deletion saga (`social-mobile-account-delete`). It is called with
 * the person's own token, exactly as the X app calls it, and always in scope `social_only`.
 */
export type XCleanupOutcome = 'done' | 'scope_refused' | 'in_progress' | 'blocked' | 'failed' | 'login_deleted';
export type XServiceCleaner = {
  /** The saga's read-only preview for this person, or null when it could not be read. */
  preview(token: string): Promise<{ scope: string; state: string } | null>;
  /** Runs (or resumes) the saga in scope social_only. */
  run(token: string): Promise<XCleanupOutcome>;
};

export type LifecycleDeps = {
  getUser(token: string): Promise<VerifiedUser | null>;
  rpc(name: LifecycleRpcName, args: Record<string, unknown>): Promise<RpcResult>;
  /** Revokes every session of the login (Auth logout, scope global). true only when Auth confirmed. */
  revokeSessions(token: string): Promise<boolean>;
  /** Removes objects through the Storage API. true only when Storage confirmed. */
  removeStorageObjects(bucketId: string, names: readonly string[]): Promise<boolean>;
  /**
   * null when Sign in with Apple revocation is not configured on the server. 'unknown' (also any other
   * answer, or a throw) is never treated as a failure: the code may already be consumed (H2 rereview R2).
   */
  revokeApple: ((authorizationCode: string, expectedSubjects: readonly string[]) => Promise<AppleRevocationOutcome>) | null;
  x: XServiceCleaner;
  /**
   * Other providers a service connected (Threads, later Instagram), each cleaned through the adapter its
   * owner registered (provider_cleanup.ts). Empty/absent today: the step then does nothing.
   */
  providers?: readonly ProviderCleanupAdapter[];
  /**
   * What each registered adapter can confirm of the REMOTE grant. A provider not listed is treated as
   * 'unsupported': the person must acknowledge, before anything changes, that the remote authorization
   * stays (REMOTE_UNVERIFIED_ACK_REQUIRED). Threads is 'unsupported' (no app-side revoke exists).
   */
  providerRemoteRevoke?: Readonly<Record<string, 'supported' | 'unsupported'>>;
  /**
   * An operator-level override: an unexpected "local removed, remote unverified" answer from a provider the
   * person did not acknowledge still stops (PROVIDER_REMOTE_UNVERIFIED) unless this is true; when true the
   * acknowledgement is recorded as given by the operator path, never silently. Default false.
   */
  acceptRemoteUnverified?: boolean;
  /** Managed Auth Admin delete of the verified login. */
  deleteLogin(userId: string): Promise<'deleted' | 'not_found' | 'failed'>;
  /** Managed Auth Admin read of the verified login. */
  loginState(userId: string): Promise<'present' | 'absent' | 'unknown'>;
  nowSeconds(): number;
};

export type LifecycleErrorCode =
  | 'AUTH_REQUIRED' | 'ACTION_REQUIRED' | 'CONFIRMATION_REQUIRED' | 'REAUTH_REQUIRED'
  | 'LIFECYCLE_VERSION_REQUIRED' | 'LIFECYCLE_CHANGED' | 'DELETION_BLOCKED' | 'COMMON_ACCOUNT_DELETION_UNAVAILABLE'
  | 'DELETION_IN_PROGRESS' | 'RECONCILIATION_REQUIRED'
  | 'APPLE_REAUTH_REQUIRED' | 'APPLE_REVOCATION_UNAVAILABLE' | 'APPLE_REVOKE_FAILED'
  | 'X_CLEANUP_UNSUPPORTED' | 'X_CLEANUP_IN_PROGRESS' | 'X_CLEANUP_BLOCKED' | 'X_CLEANUP_FAILED'
  | 'PROVIDER_CLEANUP_BLOCKED' | 'PROVIDER_REMOTE_UNVERIFIED' | 'PROVIDER_ADAPTER_MISSING'
  | 'REMOTE_UNVERIFIED_ACK_REQUIRED' | 'ACKNOWLEDGEMENT_INVALID'
  | 'SERVICE_CLEANUP_INCOMPLETE' | 'SESSION_REVOKE_FAILED'
  | 'STORAGE_CLEANUP_FAILED' | 'STORAGE_NOT_EMPTY' | 'STORAGE_BUCKET_OWNED'
  | 'NOT_READY' | 'AUTH_DELETE_FAILED' | 'AUTH_DELETE_UNCONFIRMED' | 'DELETION_VERIFICATION_PENDING'
  | 'WITHDRAW_BLOCKED' | 'WITHDRAW_INTERRUPTED' | 'WITHDRAW_INCOMPLETE' | 'FAILED';

type FailureBody = {
  ok: false; error: LifecycleErrorCode; reasons?: string[]; sessions_revoked?: true;
  /** Fixed provider keys and fixed result codes of the provider cleanup step (provider_cleanup.ts). */
  providers?: { provider: string; result: string }[];
};
type Body = FailureBody | ({ ok: true } & Record<string, unknown>);
export type LifecycleResponse = { status: number; body: Body };

/** The only reason codes that ever leave the server; anything else is reported as UNKNOWN. */
export const REASON_CODES = [
  'ADMIN_ACCOUNT', 'ACCOUNT_LOCKED', 'X_WORKSPACE_NOT_SELF_SERVICE', 'UNREGISTERED_SERVICE_FOOTPRINT',
  'SERVICE_NOT_DELETABLE', 'LIFECYCLE_STATE_INCONSISTENT', 'ACCOUNT_DELETION_IN_PROGRESS',
  'SERVICES_REMAIN', 'LIFECYCLE_SETTINGS_INVALID', 'MANAGED_CHECKPOINT_REGISTRY_INVALID',
  'MANAGED_CHECKPOINTS_MISSING', 'MANAGED_OWNERSHIP_REMAINS', 'ACCOUNT_DELETION_NOT_IN_PROGRESS',
  'REQUIRED_CHECKPOINTS_CHANGED', 'LIFECYCLE_VERSION_CHANGED', 'REQUIREMENT_EPOCH_CHANGED', 'NOT_READY', 'UNKNOWN',
] as const;
const reasonCode = (value: unknown) => ((REASON_CODES as readonly unknown[]).includes(value) ? value as string : 'UNKNOWN');
const reasonCodes = (value: unknown) => [...new Set((Array.isArray(value) && value.length ? value : ['UNKNOWN']).map(reasonCode))];

const fail = (
  status: number,
  error: LifecycleErrorCode,
  extra: { reasons?: string[]; sessionsRevoked?: boolean; providers?: { provider: string; result: string }[] } = {},
): LifecycleResponse => ({
  status,
  body: {
    ok: false,
    error,
    ...(extra.reasons ? { reasons: extra.reasons } : {}),
    ...(extra.sessionsRevoked ? { sessions_revoked: true as const } : {}),
    ...(extra.providers ? { providers: extra.providers } : {}),
  },
});
const record = (value: unknown) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
const asRecord = record;
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function bearerToken(header: string | null): string | null {
  const match = header ? /^Bearer\s+(\S+)$/iu.exec(header.trim()) : null;
  return match ? match[1] : null;
}

async function verifiedCaller(authorization: string | null, deps: LifecycleDeps): Promise<{ token: string; user: VerifiedUser } | null> {
  const token = bearerToken(authorization);
  if (!token) return null;
  try {
    const user = await deps.getUser(token);
    return user && typeof user.id === 'string' && UUID.test(user.id) ? { token, user } : null;
  } catch {
    return null;
  }
}

/** H2 C1: the newest authentication must be in [now - RECENT_AUTH_SECONDS, now]; the clock is read once. */
export function recentlyAuthenticated(token: string, userId: string, nowSeconds: number): boolean {
  const at = lastAuthenticatedAt(token, userId);
  return at !== null && at <= nowSeconds && nowSeconds - at <= RECENT_AUTH_SECONDS;
}

async function call(deps: LifecycleDeps, name: LifecycleRpcName, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const result = await deps.rpc(name, args);
    return result.ok ? record(result.data) : null;
  } catch {
    return null;
  }
}

type ServiceState = { service: 'kabumori' | 'x_autopost'; status: string };
type Eligibility = {
  accountStatus: string;
  lifecycleVersion: number;
  services: ServiceState[];
  blockers: string[];
  requiredCheckpoints: string[];
  operation: { id: string; step: string; recordedCheckpoints: string[] } | null;
};

async function eligibility(deps: LifecycleDeps, userId: string): Promise<Eligibility | null> {
  const data = await call(deps, 'eligibility', { p_user_id: userId });
  if (!data) return null;
  const version = data.lifecycle_version;
  const services = Array.isArray(data.services) ? data.services.map(record) : null;
  const blockers = strings(data.blockers);
  // Null when the checkpoint registry is invalid: the deletion would never become ready anyway.
  const required = data.required_checkpoints === null ? [] : strings(data.required_checkpoints);
  const operation = data.operation === null || data.operation === undefined ? null : record(data.operation);
  if (typeof data.account_status !== 'string' || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0
      || !services || !blockers || !required) return null;
  if (!services.every((s) => (s.service_key === 'kabumori' || s.service_key === 'x_autopost') && typeof s.status === 'string')) return null;
  let parsedOperation: Eligibility['operation'] = null;
  if (operation) {
    const recorded = strings(operation.recorded_checkpoints);
    if (typeof operation.operation_id !== 'string' || !UUID.test(operation.operation_id) || typeof operation.step !== 'string' || !recorded) return null;
    parsedOperation = { id: operation.operation_id, step: operation.step, recordedCheckpoints: recorded };
  }
  return {
    accountStatus: data.account_status,
    lifecycleVersion: version,
    services: services.map((s) => ({ service: s.service_key as ServiceState['service'], status: s.status as string })),
    blockers,
    requiredCheckpoints: required,
    operation: parsedOperation,
  };
}

/** Whether the managed Auth delete is released (H2 R3). Anything unreadable is blocked. */
async function managedDeleteReleased(deps: LifecycleDeps): Promise<boolean> {
  const gate = await call(deps, 'release_gate', {});
  return record(gate?.managed_auth_delete).state === 'open';
}

const appleNeeded = (user: VerifiedUser, state: Eligibility) =>
  state.requiredCheckpoints.includes('apple_revocation') || user.providers.includes('apple');
const remaining = (state: Eligibility, service: ServiceState['service']) => {
  const found = state.services.find((s) => s.service === service);
  return found !== undefined && found.status !== 'ended';
};

async function xPreview(deps: LifecycleDeps, token: string) {
  try {
    return await deps.x.preview(token);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// POSTONA end (Phase 6): the ONE owned operation behind both "POSTONAの利用を終了" and the whole-account deletion's
// POSTONA step. Order, with the reason for each:
//   begin (entitlement `deleting`: new connections and writes are refused by the guards) -> claim the service
//   deletion's own lease -> snapshot of what is connected -> a connected provider without an adapter stops
//   here -> the person's acknowledgement is recorded BEFORE any removal that cannot be revoked remotely -> the
//   other providers through their adapters (the X saga takes every social account of the workspace for X
//   material and would send a Threads account to an operator, so they go first) -> X through its saga ->
//   every answer recorded durably -> the owner ends the entitlement (database: owner, settled answers,
//   acknowledgement, footprint read-back).
// A lease lost anywhere stops with nothing recorded after the loss and nothing ended. Never a fabricated
// cancellation: `done` is the X saga's own word, and Threads is never reported as revoked remotely.

type Snapshot = { platforms: string[] };

async function providerSnapshot(deps: LifecycleDeps, userId: string): Promise<Snapshot | null> {
  const data = await call(deps, 'provider_snapshot', { p_user_id: userId });
  const platforms = data ? strings(data.platforms) : null;
  if (!platforms || !platforms.every((p) => PROVIDER_KEY_RE.test(p) || p === 'x')) return null;
  return { platforms: [...new Set(platforms)].sort() };
}

/** The acknowledgement list of a request: absent -> none; otherwise exactly provider keys (never `x`), or null. */
function parseAcknowledged(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) return null;
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !PROVIDER_KEY_RE.test(item) || item === 'x') return null;
    keys.push(item);
  }
  return [...new Set(keys)].sort();
}

const adapterKeys = (deps: LifecycleDeps) => new Set((deps.providers ?? []).map((a) => a.provider));
const remoteRevokeOf = (deps: LifecycleDeps, provider: string) => deps.providerRemoteRevoke?.[provider] ?? 'unsupported';

/**
 * What would stop a POSTONA end before anything changes (read-only): a connected provider with no adapter, and
 * a provider whose remote grant cannot be revoked that the person has not acknowledged.
 */
function postonaPreflight(deps: LifecycleDeps, snapshot: Snapshot, acknowledged: readonly string[]): LifecycleResponse | null {
  const others = snapshot.platforms.filter((p) => p !== 'x');
  const adapters = adapterKeys(deps);
  const missing = others.filter((p) => !adapters.has(p));
  if (missing.length > 0) {
    return fail(409, 'PROVIDER_ADAPTER_MISSING', { providers: missing.map((provider) => ({ provider, result: 'blocked' as const })) });
  }
  const needsAck = others.filter((p) => remoteRevokeOf(deps, p) !== 'supported' && !acknowledged.includes(p));
  if (needsAck.length > 0) {
    return fail(409, 'REMOTE_UNVERIFIED_ACK_REQUIRED', { providers: needsAck.map((provider) => ({ provider, result: 'pending' as const })) });
  }
  return null;
}

type EndScope =
  | { kind: 'service_only' }
  | { kind: 'account'; operationId: string; lease: string; owned: () => Promise<boolean> };
type PostonaEnd =
  | { ok: false; response: LifecycleResponse }
  | { ok: true; outcome: 'ended' | 'already_ended' | 'not_registered'; providers: Record<string, string>; remoteUnverified: string[] };

const DURABLE_RESULT: Record<string, string> = {
  not_connected: 'not_connected', confirmed_remote_revoked: 'confirmed_remote_revoked',
  local_removed_remote_unverified: 'local_removed_remote_unverified', reconciliation_required: 'reconciliation_required',
  blocked: 'blocked', unreadable: 'reconciliation_required', invalid: 'blocked',
};

async function endPostona(args: {
  deps: LifecycleDeps;
  token: string;
  userId: string;
  scope: EndScope;
  acknowledged: readonly string[];
  /** Records the failure where the caller keeps one (the account deletion) and returns it. */
  stop: (response: LifecycleResponse) => Promise<LifecycleResponse>;
  lost: () => LifecycleResponse;
}): Promise<PostonaEnd> {
  const { deps, token, userId, scope, acknowledged } = args;
  const refuse = async (response: LifecycleResponse): Promise<PostonaEnd> => ({ ok: false, response: await args.stop(response) });

  const begun = await call(deps, 'begin_service_deletion', { p_user_id: userId, p_service_key: 'x_autopost' });
  if (!begun) return refuse(fail(500, 'FAILED'));
  if (begun.status === 'blocked') return refuse(fail(409, 'DELETION_BLOCKED', { reasons: [reasonCode(begun.reason)] }));
  if (begun.status === 'not_registered' || begun.status === 'already_ended') {
    return { ok: true, outcome: begun.status, providers: {}, remoteUnverified: [] };
  }
  const operationId = begun.operation_id;
  if ((begun.status !== 'started' && begun.status !== 'in_progress') || typeof operationId !== 'string' || !UUID.test(operationId)) {
    return refuse(fail(500, 'FAILED'));
  }

  // Ownership of this one service deletion; inside an account deletion it presents that deletion's own lease.
  const claimed = await call(deps, 'claim_service', {
    p_user_id: userId, p_service_key: 'x_autopost', p_operation_id: operationId, p_lease_seconds: LEASE_SECONDS,
    ...(scope.kind === 'account' ? { p_account_operation_id: scope.operationId, p_account_lease: scope.lease } : {}),
  });
  if (!claimed) return refuse(fail(500, 'FAILED'));
  if (claimed.status === 'in_progress') return { ok: false, response: fail(409, 'DELETION_IN_PROGRESS') };
  if (claimed.status === 'lease_lost') return { ok: false, response: args.lost() };
  if (claimed.status === 'blocked') {
    return refuse(fail(409, scope.kind === 'account' ? 'DELETION_BLOCKED' : 'WITHDRAW_BLOCKED', { reasons: [reasonCode(claimed.reason)] }));
  }
  const lease = claimed.lease;
  if (claimed.status !== 'acquired' || typeof lease !== 'string' || !UUID.test(lease)) return refuse(fail(500, 'FAILED'));
  const own = { p_user_id: userId, p_service_key: 'x_autopost', p_operation_id: operationId, p_lease: lease };
  const owned = async () => {
    if (scope.kind === 'account' && !(await scope.owned())) return false;
    return (await call(deps, 'renew_service', { ...own, p_lease_seconds: LEASE_SECONDS }))?.status === 'owned';
  };
  const record = async (provider: string, result: string) =>
    (await call(deps, 'record_provider_result', { ...own, p_provider: provider, p_result: result }))?.status === 'recorded';

  try {
    const snapshot = await providerSnapshot(deps, userId);
    if (!snapshot) return refuse(fail(500, 'FAILED'));
    const others = snapshot.platforms.filter((p) => p !== 'x');

    // A connected provider nobody can clean is recorded and stops the end before anything is removed.
    const adapters = adapterKeys(deps);
    const missing = others.filter((p) => !adapters.has(p));
    if (missing.length > 0) {
      for (const provider of missing) await record(provider, 'blocked');
      return refuse(fail(409, 'PROVIDER_ADAPTER_MISSING', { providers: missing.map((provider) => ({ provider, result: 'blocked' as const })) }));
    }
    // The acknowledgement is part of the record before the removal that cannot be revoked remotely.
    const needsAck = others.filter((p) => remoteRevokeOf(deps, p) !== 'supported');
    const lacking = needsAck.filter((p) => !acknowledged.includes(p));
    if (lacking.length > 0) {
      return refuse(fail(409, 'REMOTE_UNVERIFIED_ACK_REQUIRED', { providers: lacking.map((provider) => ({ provider, result: 'pending' as const })) }));
    }
    if (needsAck.length > 0) {
      const ack = await call(deps, 'acknowledge_unverified', { ...own, p_providers: needsAck });
      if (ack?.status === 'lease_lost') return { ok: false, response: args.lost() };
      if (ack?.status !== 'recorded') return refuse(fail(500, 'FAILED'));
    }

    // The other providers first, each through its owner's adapter; ownership is asked at every boundary inside.
    if ((deps.providers ?? []).length > 0) {
      if (!(await owned())) return { ok: false, response: args.lost() };
      const report = await runProviderCleanups(deps.providers ?? [], userId, { stillOwned: owned });
      if (report.decision === 'lease_lost') return { ok: false, response: args.lost() };
      for (const item of report.providers) {
        const durable = DURABLE_RESULT[item.result];
        if (durable && !(await record(item.provider, durable))) return { ok: false, response: args.lost() };
      }
      if (report.decision === 'reconciliation_required') {
        return refuse(fail(409, 'RECONCILIATION_REQUIRED', { providers: report.providers }));
      }
      if (report.decision === 'blocked') return refuse(fail(409, 'PROVIDER_CLEANUP_BLOCKED', { providers: report.providers }));
      const unexpected = report.remoteUnverified.filter((p) => !acknowledged.includes(p) && !needsAck.includes(p));
      if (unexpected.length > 0) {
        if (deps.acceptRemoteUnverified !== true) {
          return refuse(fail(409, 'PROVIDER_REMOTE_UNVERIFIED', { providers: report.providers }));
        }
        const ack = await call(deps, 'acknowledge_unverified', { ...own, p_providers: unexpected });
        if (ack?.status !== 'recorded') return refuse(fail(500, 'FAILED'));
      }
    }

    // X second, through its own saga (typed outcome; its code is not ours to change). The saga treats every
    // social account of the workspace as X material and sends a non-X account to an operator, so the other
    // providers are removed first; and nothing is removed before the read-only checks above have passed.
    if (!(await owned())) return { ok: false, response: args.lost() };
    let outcome: XCleanupOutcome = 'failed';
    try {
      outcome = await deps.x.run(token);
    } catch {
      outcome = 'failed';
    }
    // The saga removed the login itself (it must not in social_only): nothing can be verified any more.
    if (outcome === 'login_deleted') return { ok: false, response: fail(500, 'DELETION_VERIFICATION_PENDING') };
    const xRecorded = await record('x', outcome === 'done' ? 'done' : outcome === 'blocked' ? 'blocked' : 'reconciliation_required');
    if (!xRecorded) return { ok: false, response: args.lost() };
    if (outcome === 'scope_refused') return refuse(fail(409, 'X_CLEANUP_UNSUPPORTED'));
    if (outcome === 'in_progress') return refuse(fail(409, 'X_CLEANUP_IN_PROGRESS'));
    if (outcome === 'blocked') return refuse(fail(409, 'X_CLEANUP_BLOCKED'));
    if (outcome !== 'done') return refuse(fail(502, 'X_CLEANUP_FAILED'));

    // The end: the database checks, in the transaction of the end itself, that this is still the owner (its lease,
    // on the wall clock, after its locks), that every answer is settled and acknowledged, and reads the footprint
    // back. A separate ownership question here would only be a second, weaker copy of that check.
    const finished = await call(deps, 'finish_owned_service', own);
    if (finished?.status === 'lease_lost') return { ok: false, response: args.lost() };
    if (finished?.status === 'not_ready') {
      const providers = (strings(finished.providers) ?? []).filter((p) => p === 'x' || PROVIDER_KEY_RE.test(p));
      return refuse(fail(409, 'SERVICE_CLEANUP_INCOMPLETE', {
        reasons: [reasonCode(finished.reason)], providers: providers.map((provider) => ({ provider, result: 'pending' as const })),
      }));
    }
    if (finished?.status !== 'ended') return refuse(fail(500, 'SERVICE_CLEANUP_INCOMPLETE'));
    const results = asRecord(finished.provider_results);
    const summary: Record<string, string> = {};
    for (const [provider, result] of Object.entries(results)) {
      if ((provider === 'x' || PROVIDER_KEY_RE.test(provider)) && typeof result === 'string') summary[provider] = result;
    }
    const unverified = (strings(finished.remote_unverified) ?? []).filter((p) => PROVIDER_KEY_RE.test(p));
    return { ok: true, outcome: 'ended', providers: summary, remoteUnverified: unverified };
  } finally {
    // Ownership is given back on every path out (a no-op when it was lost or the end cleared it).
    await call(deps, 'release_service', own);
  }
}

// ---------------------------------------------------------------------------------------------------
// Preview (read-only): what a whole-account deletion would do now. Shown before the confirmation.

export async function handlePreview(input: { authorization: string | null }, deps: LifecycleDeps): Promise<LifecycleResponse> {
  const caller = await verifiedCaller(input.authorization, deps);
  if (!caller) return fail(401, 'AUTH_REQUIRED');
  const state = await eligibility(deps, caller.user.id);
  if (!state) return fail(500, 'FAILED');
  const apple = appleNeeded(caller.user, state);
  // Which providers hold a connection, whether this server can clean each, and which need the person's
  // acknowledgement that the remote authorization stays (shown before the confirmation; nothing changes).
  const snapshot = await providerSnapshot(deps, caller.user.id);
  if (!snapshot) return fail(500, 'FAILED');
  const adapters = adapterKeys(deps);
  const others = snapshot.platforms.filter((p) => p !== 'x');
  let xCleanup: 'not_needed' | 'supported' | 'unsupported' = 'not_needed';
  if (remaining(state, 'x_autopost')) {
    const preview = await xPreview(deps, caller.token);
    xCleanup = preview?.scope === 'social_only' ? 'supported' : 'unsupported';
  }
  return {
    status: 200,
    body: {
      ok: true,
      account_status: ['active', 'deleting', 'locked', 'none'].includes(state.accountStatus) ? state.accountStatus : 'unknown',
      lifecycle_version: state.lifecycleVersion,
      services: state.services.map((s) => ({ service: s.service, status: s.status })),
      blockers: state.blockers.length ? reasonCodes(state.blockers) : [],
      deletion_in_progress: state.operation !== null,
      deletion_available: await managedDeleteReleased(deps),
      apple: {
        required: apple,
        supported: !apple || deps.revokeApple !== null,
        code_required: apple && !(state.operation?.recordedCheckpoints.includes('apple_revocation') ?? false),
      },
      x_cleanup: xCleanup,
      providers: snapshot.platforms.map((provider) => provider === 'x'
        ? { provider, adapter: 'saga' as const, remote_revoke: 'saga' as const }
        : { provider, adapter: adapters.has(provider) ? 'registered' as const : 'missing' as const, remote_revoke: remoteRevokeOf(deps, provider) }),
      acknowledgement_required: others.filter((p) => adapters.has(p) && remoteRevokeOf(deps, p) !== 'supported'),
      postona_end_available: others.every((p) => adapters.has(p)),
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// かぶモリの利用を終了: ends the Kabumori entitlement and its data (profiles cascade) in one lifecycle
// transaction. The login, the X entitlement and the X workspace are not touched.

export async function handleWithdrawKabumori(input: { authorization: string | null; body: unknown }, deps: LifecycleDeps): Promise<LifecycleResponse> {
  const caller = await verifiedCaller(input.authorization, deps);
  if (!caller) return fail(401, 'AUTH_REQUIRED');
  const { token, user } = caller;
  if (record(input.body).confirmation !== WITHDRAW_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');
  if (!recentlyAuthenticated(token, user.id, deps.nowSeconds())) return fail(403, 'REAUTH_REQUIRED');
  // A whole-account deletion ends Kabumori itself, after X: ending it here first would change the X
  // saga's scope underneath that deletion.
  const state = await eligibility(deps, user.id);
  if (!state) return fail(500, 'FAILED');
  if (state.accountStatus === 'deleting') return fail(409, 'WITHDRAW_BLOCKED', { reasons: ['ACCOUNT_DELETION_IN_PROGRESS'] });

  const result = await call(deps, 'withdraw_kabumori', { p_user_id: user.id });
  if (!result) return fail(500, 'FAILED');
  switch (result.status) {
    case 'ended':
    case 'already_ended':
    case 'not_registered':
      return { status: 200, body: { ok: true, outcome: result.status } };
    case 'blocked':
      return fail(409, 'WITHDRAW_BLOCKED', { reasons: [reasonCode(result.reason)] });
    case 'not_ready':
      return fail(500, 'WITHDRAW_INCOMPLETE');
    case 'aborted':
    case 'not_found':
      return fail(409, 'WITHDRAW_INTERRUPTED');
    default:
      return fail(500, 'FAILED');
  }
}

// ---------------------------------------------------------------------------------------------------
// POSTONAの利用を終了: ends POSTONA only (X and every connected provider), keeps the login, Kabumori and every
// other service. The X saga is the existing one (scope social_only); this function owns the ordering.

export async function handleWithdrawPostona(input: { authorization: string | null; body: unknown }, deps: LifecycleDeps): Promise<LifecycleResponse> {
  const caller = await verifiedCaller(input.authorization, deps);
  if (!caller) return fail(401, 'AUTH_REQUIRED');
  const { token, user } = caller;
  const body = record(input.body);
  if (body.confirmation !== END_POSTONA_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');
  if (!recentlyAuthenticated(token, user.id, deps.nowSeconds())) return fail(403, 'REAUTH_REQUIRED');
  const acknowledged = parseAcknowledged(body.acknowledged_remote_unverified);
  if (acknowledged === null) return fail(400, 'ACKNOWLEDGEMENT_INVALID');

  const state = await eligibility(deps, user.id);
  if (!state) return fail(500, 'FAILED');
  if (state.accountStatus === 'deleting') return fail(409, 'WITHDRAW_BLOCKED', { reasons: ['ACCOUNT_DELETION_IN_PROGRESS'] });
  if (state.accountStatus === 'locked') return fail(409, 'WITHDRAW_BLOCKED', { reasons: ['ACCOUNT_LOCKED'] });
  const postona = state.services.find((s) => s.service === 'x_autopost');
  if (!postona) return { status: 200, body: { ok: true, outcome: 'not_registered' } };
  if (postona.status === 'ended') return { status: 200, body: { ok: true, outcome: 'already_ended' } };

  // The X saga keeps the login only in scope social_only; a person whose login it would remove is refused.
  const preview = await xPreview(deps, token);
  if (preview?.scope !== 'social_only') return fail(409, 'X_CLEANUP_UNSUPPORTED');
  // A saga that already waits for an operator cannot finish: refused before another provider is touched.
  if (preview.state === 'operator_required') return fail(409, 'X_CLEANUP_BLOCKED');
  // Read-only checks first: nothing changes when a connected provider cannot be cleaned or is unacknowledged.
  const snapshot = await providerSnapshot(deps, user.id);
  if (!snapshot) return fail(500, 'FAILED');
  const refusal = postonaPreflight(deps, snapshot, acknowledged);
  if (refusal) return refusal;

  const ended = await endPostona({
    deps, token, userId: user.id, scope: { kind: 'service_only' }, acknowledged,
    stop: async (response) => response,
    lost: () => fail(409, 'DELETION_IN_PROGRESS'),
  });
  if (!ended.ok) return ended.response;
  return {
    status: 200,
    body: {
      ok: true,
      outcome: ended.outcome,
      providers: ended.providers,
      ...(ended.remoteUnverified.length ? { remote_unverified: ended.remoteUnverified } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// 共通アカウントを削除: the whole person.

type StorageInventory = { objects: { bucketId: string; name: string }[]; more: boolean; bucketsOwned: boolean };

async function storageInventory(deps: LifecycleDeps, userId: string): Promise<StorageInventory | null> {
  const data = await call(deps, 'storage_objects', { p_user_id: userId });
  if (!data || data.status !== 'ok' || !Array.isArray(data.objects) || typeof data.more !== 'boolean' || typeof data.buckets_owned !== 'boolean') return null;
  const objects = data.objects.map(record);
  // An object without a usable bucket/name cannot be removed through the API: never treat it as gone.
  if (!objects.every((o) => typeof o.bucket_id === 'string' && o.bucket_id && typeof o.name === 'string' && o.name)) return null;
  return { objects: objects.map((o) => ({ bucketId: o.bucket_id as string, name: o.name as string })), more: data.more, bucketsOwned: data.buckets_owned };
}

/** Lists the person's Storage objects and removes them through the Storage API until the list is empty. */
async function cleanStorage(deps: LifecycleDeps, userId: string): Promise<'clean' | 'not_empty' | 'bucket_owned' | 'failed'> {
  for (let pass = 0; pass <= STORAGE_PASSES; pass++) {
    const inventory = await storageInventory(deps, userId);
    if (!inventory) return 'failed';
    if (inventory.bucketsOwned) return 'bucket_owned';
    if (inventory.objects.length === 0) return inventory.more ? 'failed' : 'clean';
    if (pass === STORAGE_PASSES) return 'not_empty';
    const byBucket = new Map<string, string[]>();
    for (const object of inventory.objects) byBucket.set(object.bucketId, [...(byBucket.get(object.bucketId) ?? []), object.name]);
    for (const [bucketId, names] of byBucket) {
      for (let start = 0; start < names.length; start += STORAGE_REMOVE_CHUNK) {
        let removed = false;
        try {
          removed = await deps.removeStorageObjects(bucketId, names.slice(start, start + STORAGE_REMOVE_CHUNK));
        } catch {
          removed = false;
        }
        if (!removed) return 'failed';
      }
    }
  }
  return 'not_empty';
}

const storageFailure = (outcome: 'not_empty' | 'bucket_owned' | 'failed', sessionsRevoked: boolean): LifecycleResponse =>
  outcome === 'bucket_owned' ? fail(409, 'STORAGE_BUCKET_OWNED', { sessionsRevoked })
    : outcome === 'not_empty' ? fail(503, 'STORAGE_NOT_EMPTY', { sessionsRevoked })
    : fail(502, 'STORAGE_CLEANUP_FAILED', { sessionsRevoked });

export async function handleDeleteCommonAccount(input: { authorization: string | null; body: unknown }, deps: LifecycleDeps): Promise<LifecycleResponse> {
  const caller = await verifiedCaller(input.authorization, deps);
  if (!caller) return fail(401, 'AUTH_REQUIRED');
  const { token, user } = caller;
  const userId = user.id;
  const body = record(input.body);
  if (body.confirmation !== DELETE_CONFIRMATION) return fail(400, 'CONFIRMATION_REQUIRED');
  if (!recentlyAuthenticated(token, userId, deps.nowSeconds())) return fail(403, 'REAUTH_REQUIRED');
  const expected = body.expected_lifecycle_version;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) return fail(400, 'LIFECYCLE_VERSION_REQUIRED');
  const appleCode = typeof body.apple_authorization_code === 'string' && body.apple_authorization_code.length > 0 ? body.apple_authorization_code : null;
  const acknowledged = parseAcknowledged(body.acknowledged_remote_unverified);
  if (acknowledged === null) return fail(400, 'ACKNOWLEDGEMENT_INVALID');

  // 1. Read-only pre-checks: nothing changes when a requirement of a later step is already unmet.
  if (!(await managedDeleteReleased(deps))) return fail(409, 'COMMON_ACCOUNT_DELETION_UNAVAILABLE');
  const before = await eligibility(deps, userId);
  if (!before) return fail(500, 'FAILED');
  const apple = appleNeeded(user, before);
  if (apple && !(before.operation?.recordedCheckpoints.includes('apple_revocation') ?? false)) {
    if (!deps.revokeApple) return fail(409, 'APPLE_REVOCATION_UNAVAILABLE');
    if (!appleCode) return fail(400, 'APPLE_REAUTH_REQUIRED');
  }
  if (remaining(before, 'x_autopost')) {
    // The X saga keeps the login only in scope social_only (while the Kabumori profile exists). It must
    // never remove the login itself: that is the managed delete at the end of this flow.
    const preview = await xPreview(deps, token);
    if (preview?.scope !== 'social_only') return fail(409, 'X_CLEANUP_UNSUPPORTED');
    if (preview.state === 'operator_required') return fail(409, 'X_CLEANUP_BLOCKED');
  }
  // Connected providers: an adapter for each, and the person's acknowledgement where the remote grant cannot be
  // revoked -- decided now, before anything changes (the same check runs again under the lease).
  const providers = await providerSnapshot(deps, userId);
  if (!providers) return fail(500, 'FAILED');
  const providerRefusal = postonaPreflight(deps, providers, acknowledged);
  if (providerRefusal) return providerRefusal;

  // 2. Begin, bound to the version the person confirmed. A retry resumes the same operation, but only at
  //    the version the person was shown now.
  const begun = await call(deps, 'begin_account_deletion', { p_user_id: userId, p_expected_lifecycle_version: expected });
  if (!begun) return fail(500, 'FAILED');
  if (begun.status === 'lifecycle_changed') return fail(409, 'LIFECYCLE_CHANGED');
  if (begun.status === 'blocked') return fail(409, 'DELETION_BLOCKED', { reasons: reasonCodes(begun.reasons) });
  if (begun.status !== 'started' && begun.status !== 'in_progress') return fail(500, 'FAILED');
  if (begun.status === 'in_progress' && begun.lifecycle_version !== expected) return fail(409, 'LIFECYCLE_CHANGED');
  const operationId = begun.operation_id;
  if (typeof operationId !== 'string' || !UUID.test(operationId)) return fail(500, 'FAILED');

  // 3. One owner (H2 R1): before any external action. A second request is told the truth.
  const claimed = await call(deps, 'claim', { p_user_id: userId, p_operation_id: operationId, p_lease_seconds: LEASE_SECONDS });
  if (!claimed) return fail(500, 'FAILED');
  if (claimed.status === 'in_progress') return fail(409, 'DELETION_IN_PROGRESS');
  if (claimed.status === 'reconciliation_required') return fail(409, 'RECONCILIATION_REQUIRED');
  const lease = claimed.lease;
  const recorded = strings(claimed.recorded_checkpoints);
  if (claimed.status !== 'acquired' || typeof lease !== 'string' || !UUID.test(lease) || !recorded) return fail(500, 'FAILED');
  const owner = { p_user_id: userId, p_operation_id: operationId, p_lease: lease };
  try {
    return await ownedDeletion({ deps, token, user, operationId, owner, appleCode, apple, appleDone: recorded.includes('apple_revocation'), acknowledged });
  } finally {
    // Gives ownership back whatever happened (a no-op when it was lost or the read-back closed it). An
    // unsettled external step stays recorded.
    await call(deps, 'release', owner);
  }
}

type Owned = {
  deps: LifecycleDeps;
  token: string;
  user: VerifiedUser;
  operationId: string;
  owner: { p_user_id: string; p_operation_id: string; p_lease: string };
  appleCode: string | null;
  apple: boolean;
  appleDone: boolean;
  acknowledged: readonly string[];
};

async function ownedDeletion({ deps, token, user, operationId, owner, appleCode, apple, appleDone, acknowledged }: Owned): Promise<LifecycleResponse> {
  const userId = user.id;
  let sessionsRevoked = false;
  // Every failure from here on is kept on the operation as a fixed code for an operator (best effort).
  const stop = async (response: LifecycleResponse): Promise<LifecycleResponse> => {
    if (!response.body.ok) {
      await call(deps, 'record_error', { p_user_id: userId, p_operation_id: operationId, p_error_code: response.body.error });
    }
    return response;
  };
  // Another request owns the deletion now: stop without acting and say so.
  const lost = () => fail(409, 'DELETION_IN_PROGRESS', { sessionsRevoked });
  const owned = async () => (await call(deps, 'renew', { ...owner, p_lease_seconds: LEASE_SECONDS }))?.status === 'owned';
  const ownedCheckpoint = async (key: 'session_revocation' | 'storage_cleanup', present: boolean) =>
    (await call(deps, 'owned_checkpoint', { ...owner, p_checkpoint: key, p_recorded: present }))?.status;
  const recordStorage = (present: boolean) => ownedCheckpoint('storage_cleanup', present);

  // POSTONA, one owned operation (see endPostona): the service deletion's own lease inside this deletion's
  // lease, X through its saga, the other providers through their adapters, every answer recorded, the end by
  // the owner. A lost lease anywhere stops here with nothing ended.
  let remoteUnverified: string[] = [];
  let providerSummary: Record<string, string> = {};
  // 4a. X and the other providers.
  if (!(await owned())) return lost();
  const ended = await endPostona({
    deps, token, userId, scope: { kind: 'account', operationId, lease: owner.p_lease, owned }, acknowledged,
    stop, lost,
  });
  if (!ended.ok) return ended.response;
  remoteUnverified = ended.remoteUnverified;
  providerSummary = ended.providers;
  if (ended.outcome !== 'ended') {
    // POSTONA was never started or was already ended: a provider credential may still be there (T10). There is
    // no service deletion to record into, so the adapters run under this deletion's lease and an unverified
    // remote grant needs the person's acknowledgement (or the operator override) as before.
    const adapters = deps.providers ?? [];
    if (adapters.length > 0) {
      if (!(await owned())) return lost();
      const report = await runProviderCleanups(adapters, userId, { stillOwned: owned });
      if (report.decision === 'lease_lost') return lost();
      if (report.decision === 'reconciliation_required') {
        return stop(fail(409, 'RECONCILIATION_REQUIRED', { sessionsRevoked, providers: report.providers }));
      }
      if (report.decision === 'blocked') return stop(fail(409, 'PROVIDER_CLEANUP_BLOCKED', { sessionsRevoked, providers: report.providers }));
      const unexpected = report.remoteUnverified.filter((p) => !acknowledged.includes(p));
      if (unexpected.length > 0 && deps.acceptRemoteUnverified !== true) {
        return stop(fail(409, 'PROVIDER_REMOTE_UNVERIFIED', { sessionsRevoked, providers: report.providers }));
      }
      remoteUnverified = report.remoteUnverified;
      if (!(await owned())) return lost();
    }
  }

  // 4b. Kabumori (one transaction: entitlement deleting -> profile cascade -> ended).
  if (!(await owned())) return lost();
  const kabumori = await call(deps, 'withdraw_kabumori', { p_user_id: userId });
  if (!kabumori) return stop(fail(500, 'FAILED'));
  if (kabumori.status === 'blocked') return stop(fail(409, 'DELETION_BLOCKED', { reasons: [reasonCode(kabumori.reason)] }));
  if (kabumori.status !== 'ended' && kabumori.status !== 'already_ended' && kabumori.status !== 'not_registered') {
    return stop(fail(500, 'SERVICE_CLEANUP_INCOMPLETE'));
  }
  const afterServices = await eligibility(deps, userId);
  if (!afterServices) return stop(fail(500, 'FAILED'));
  if (afterServices.services.some((s) => s.status !== 'ended')) return stop(fail(500, 'SERVICE_CLEANUP_INCOMPLETE'));

  // 5. Sessions: every refresh token of the login. Repeated on a retry (a retry needed a new sign-in).
  //    Access tokens already issued stay valid until they expire; the lifecycle state, the revalidation
  //    and the post-delete read-back are what stop them (see the stale-token policy in the design doc).
  if (!(await owned())) return lost();
  let revoked = false;
  try {
    revoked = await deps.revokeSessions(token);
  } catch {
    revoked = false;
  }
  if (!revoked) return stop(fail(502, 'SESSION_REVOKE_FAILED'));
  sessionsRevoked = true;
  const sessionCheckpoint = await ownedCheckpoint('session_revocation', true);
  if (sessionCheckpoint === 'lease_lost') return lost();
  if (sessionCheckpoint !== 'recorded') return stop(fail(500, 'FAILED', { sessionsRevoked }));

  // 6. Apple (H2 R2): the intent is recorded before the call and settled after it. An outcome that is
  //    unknown, or known but not recorded, is never replayed: it waits for reconciliation.
  if (apple && !appleDone) {
    // Checked before anything is recorded: an intent is only ever written right before the call.
    if (!deps.revokeApple || !appleCode) return stop(fail(400, 'APPLE_REAUTH_REQUIRED', { sessionsRevoked }));
    const intent = await call(deps, 'begin_external_step', { ...owner, p_step: 'apple_revocation' });
    if (intent?.status === 'lease_lost') return lost();
    if (intent?.status === 'step_in_flight') return stop(fail(409, 'RECONCILIATION_REQUIRED', { sessionsRevoked }));
    if (intent?.status !== 'already_recorded') {
      if (intent?.status !== 'owned') return stop(fail(500, 'FAILED', { sessionsRevoked }));
      let outcome: AppleRevocationOutcome = 'unknown';
      try {
        const answer = await deps.revokeApple(appleCode, user.appleSubjects);
        outcome = answer === 'succeeded' || answer === 'definitively_failed' ? answer : 'unknown';
      } catch {
        outcome = 'unknown';
      }
      // Unknown (sent, then broke off, a gateway or 5xx answer, or anything after Apple accepted the code):
      // the code may be consumed and the grant revoked or not. The intent stays; never replayed.
      if (outcome === 'unknown') return stop(fail(500, 'RECONCILIATION_REQUIRED', { sessionsRevoked }));
      const settled = await call(deps, 'settle_external_step', {
        ...owner, p_step: 'apple_revocation', p_outcome: outcome === 'succeeded' ? 'succeeded' : 'failed',
      });
      // Known but not recorded (lease lost, database failure): the intent stays; never replayed.
      if (settled?.status !== (outcome === 'succeeded' ? 'recorded' : 'cleared')) {
        return stop(fail(500, 'RECONCILIATION_REQUIRED', { sessionsRevoked }));
      }
      // Apple refused the token request itself: the code was not exchanged; a new code may be used.
      if (outcome === 'definitively_failed') return stop(fail(502, 'APPLE_REVOKE_FAILED', { sessionsRevoked }));
    }
  }

  // 7. Storage through its API, re-listed until empty.
  if (!(await owned())) return lost();
  const storage = await cleanStorage(deps, userId);
  if (storage !== 'clean') {
    if ((await recordStorage(false)) === 'lease_lost') return lost();
    return stop(storageFailure(storage, sessionsRevoked));
  }
  const storageCheckpoint = await recordStorage(true);
  if (storageCheckpoint === 'lease_lost') return lost();
  if (storageCheckpoint !== 'recorded') return stop(fail(500, 'FAILED', { sessionsRevoked }));

  // 8. prepare, then revalidate immediately before the delete: Storage listed again, prepare again.
  const prepare = async (): Promise<LifecycleResponse | 'lost' | null> => {
    const answer = await call(deps, 'owned_prepare', owner);
    if (!answer) return fail(500, 'FAILED', { sessionsRevoked });
    if (answer.status === 'lease_lost') return 'lost';
    if (answer.status === 'ready_for_managed_auth_delete' && answer.operation_id === operationId && answer.login_deleted === false) return null;
    if (answer.status === 'not_ready') return fail(409, 'NOT_READY', { reasons: [reasonCode(answer.reason)], sessionsRevoked });
    if (answer.status === 'blocked') return fail(409, 'DELETION_BLOCKED', { reasons: reasonCodes(answer.reasons), sessionsRevoked });
    return fail(500, 'FAILED', { sessionsRevoked });
  };
  const notReady = await prepare();
  if (notReady === 'lost') return lost();
  if (notReady) return stop(notReady);
  const recheck = await storageInventory(deps, userId);
  if (!recheck || recheck.bucketsOwned || recheck.objects.length > 0 || recheck.more) {
    if ((await recordStorage(false)) === 'lease_lost') return lost();
    return stop(!recheck ? storageFailure('failed', true) : recheck.bucketsOwned ? storageFailure('bucket_owned', true) : storageFailure('not_empty', true));
  }
  const stale = await prepare();
  if (stale === 'lost') return lost();
  if (stale) return stop(stale);

  // 9. The managed delete intent (H2 R1/R3): the release gate and a full re-evaluation under the
  //    exclusive login lock, recorded before the call.
  const intent = await call(deps, 'begin_external_step', { ...owner, p_step: 'managed_auth_delete' });
  if (intent?.status === 'lease_lost') return lost();
  if (intent?.status === 'release_blocked') return stop(fail(409, 'COMMON_ACCOUNT_DELETION_UNAVAILABLE', { sessionsRevoked }));
  if (intent?.status === 'not_ready') return stop(fail(409, 'NOT_READY', { reasons: reasonCodes(intent.reasons), sessionsRevoked }));
  if (intent?.status === 'step_in_flight') return fail(409, 'RECONCILIATION_REQUIRED', { sessionsRevoked });
  if (intent?.status !== 'owned') return stop(fail(500, 'FAILED', { sessionsRevoked }));

  // 10. Managed Auth Admin delete -- never SQL against auth.users.
  let deleted: 'deleted' | 'not_found' | 'failed' = 'failed';
  try {
    deleted = await deps.deleteLogin(userId);
  } catch {
    deleted = 'failed';
  }
  if (deleted === 'failed') {
    let state: 'present' | 'absent' | 'unknown' = 'unknown';
    try {
      state = await deps.loginState(userId);
    } catch {
      state = 'unknown';
    }
    if (state === 'present') {
      // The login is still there: this delete did not happen. Settled so a later owner may try again.
      await call(deps, 'settle_external_step', { ...owner, p_step: 'managed_auth_delete', p_outcome: 'failed' });
      return stop(fail(502, 'AUTH_DELETE_FAILED', { sessionsRevoked }));
    }
    if (state !== 'absent') return fail(500, 'AUTH_DELETE_UNCONFIRMED', { sessionsRevoked });
  }

  // 11. Post-delete read-back. Only a verified completion is reported as success. A Storage object a
  //     still-valid token uploaded after the revalidation is removed once more and verified again.
  for (let attempt = 0; attempt < 2; attempt++) {
    const done = await call(deps, 'complete', { p_user_id: userId, p_operation_id: operationId });
    if (done?.status === 'completed' && done.login_deleted === true) {
      return { status: 200, body: { ok: true, outcome: 'deleted', ...(Object.keys(providerSummary).length ? { providers: providerSummary } : {}), ...(remoteUnverified.length ? { remote_unverified: remoteUnverified } : {}) } };
    }
    if (done?.status === 'login_present') return fail(500, 'AUTH_DELETE_UNCONFIRMED', { sessionsRevoked });
    if (attempt === 0 && (done?.status === 'not_verified' || done?.status === 'residue_found') && done.reason === 'MANAGED_STORAGE_OWNED'
        && (await cleanStorage(deps, userId)) === 'clean') {
      continue;
    }
    break;
  }
  return fail(500, 'DELETION_VERIFICATION_PENDING', { sessionsRevoked });
}
