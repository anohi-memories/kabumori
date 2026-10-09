// Kabumori's common-account lifecycle boundary: end Kabumori ("かぶモリの利用を終了"), preview and delete
// the whole common account ("共通アカウントを削除"). SOURCE CANDIDATE -- not deployed; independent review
// is mandatory before deploy. Design: docs/common-account/phase3a-deletion-orchestrator.md.
//
// Security model:
//   * The person is whoever the caller's own bearer token belongs to (GET /auth/v1/user). The request body
//     never names a user; every RPC receives the verified id only.
//   * Withdrawal and deletion need a recent authentication (the X saga's rule: newest `amr` timestamp at
//     most RECENT_AUTH_SECONDS old, `sub` == verified user) and an explicit confirmation constant. A
//     deletion is also bound to the lifecycle_version the person was shown; any change refuses it.
//   * Whole-account deletion is the Phase 1 section 10 sequence, every step behind the lifecycle RPCs:
//     begin (version-bound) -> X through its existing saga (scope social_only, so the saga never removes
//     the login) -> Kabumori withdrawal -> session revocation -> Apple grant revocation -> Storage through
//     its API, re-listed until empty -> prepare -> revalidate (Storage again + prepare again) -> managed
//     Auth Admin delete -> post-delete read-back. The login is removed only after prepare answered
//     ready twice; success is reported only after the read-back verified the deletion.
//   * Retries resume from the durable state: the lifecycle operation, its checkpoints and the X saga's own
//     tombstone. An external step that cannot be repeated (Apple's single-use code) is skipped once its
//     checkpoint exists; repeatable ones (session revocation, Storage) run again.
//   * Every failure is a fixed code. Tokens, keys, ids, e-mail addresses, object names and server messages
//     are never returned or logged.
import { lastAuthenticatedAt, RECENT_AUTH_SECONDS } from '../social-mobile-account-delete/delete_logic.ts';

export { RECENT_AUTH_SECONDS };

export const WITHDRAW_CONFIRMATION = 'END_KABUMORI_SERVICE';
export const DELETE_CONFIRMATION = 'DELETE_COMMON_ACCOUNT';
/** Storage list -> remove passes per request before the request gives up (and a retry continues). */
export const STORAGE_PASSES = 3;
const STORAGE_REMOVE_CHUNK = 100;

export type LifecycleRpcName =
  | 'eligibility' | 'withdraw_kabumori' | 'begin_service_deletion' | 'finish_service_deletion'
  | 'begin_account_deletion' | 'record_checkpoint' | 'clear_checkpoint' | 'prepare'
  | 'storage_objects' | 'complete' | 'record_error';
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
  /** null when Sign in with Apple revocation is not configured on the server. */
  revokeApple: ((authorizationCode: string, expectedSubjects: readonly string[]) => Promise<boolean>) | null;
  x: XServiceCleaner;
  /** Managed Auth Admin delete of the verified login. */
  deleteLogin(userId: string): Promise<'deleted' | 'not_found' | 'failed'>;
  /** Managed Auth Admin read of the verified login. */
  loginState(userId: string): Promise<'present' | 'absent' | 'unknown'>;
  nowSeconds(): number;
};

export type LifecycleErrorCode =
  | 'AUTH_REQUIRED' | 'ACTION_REQUIRED' | 'CONFIRMATION_REQUIRED' | 'REAUTH_REQUIRED'
  | 'LIFECYCLE_VERSION_REQUIRED' | 'LIFECYCLE_CHANGED' | 'DELETION_BLOCKED'
  | 'APPLE_REAUTH_REQUIRED' | 'APPLE_REVOCATION_UNAVAILABLE' | 'APPLE_REVOKE_FAILED'
  | 'X_CLEANUP_UNSUPPORTED' | 'X_CLEANUP_IN_PROGRESS' | 'X_CLEANUP_BLOCKED' | 'X_CLEANUP_FAILED'
  | 'SERVICE_CLEANUP_INCOMPLETE' | 'SESSION_REVOKE_FAILED'
  | 'STORAGE_CLEANUP_FAILED' | 'STORAGE_NOT_EMPTY' | 'STORAGE_BUCKET_OWNED'
  | 'NOT_READY' | 'AUTH_DELETE_FAILED' | 'AUTH_DELETE_UNCONFIRMED' | 'DELETION_VERIFICATION_PENDING'
  | 'WITHDRAW_BLOCKED' | 'WITHDRAW_INTERRUPTED' | 'WITHDRAW_INCOMPLETE' | 'FAILED';

type FailureBody = { ok: false; error: LifecycleErrorCode; reasons?: string[]; sessions_revoked?: true };
type Body = FailureBody | ({ ok: true } & Record<string, unknown>);
export type LifecycleResponse = { status: number; body: Body };

/** The only reason codes that ever leave the server; anything else is reported as UNKNOWN. */
export const REASON_CODES = [
  'ADMIN_ACCOUNT', 'ACCOUNT_LOCKED', 'X_WORKSPACE_NOT_SELF_SERVICE', 'UNREGISTERED_SERVICE_FOOTPRINT',
  'SERVICE_NOT_DELETABLE', 'LIFECYCLE_STATE_INCONSISTENT', 'ACCOUNT_DELETION_IN_PROGRESS',
  'SERVICES_REMAIN', 'LIFECYCLE_SETTINGS_INVALID', 'MANAGED_CHECKPOINT_REGISTRY_INVALID',
  'MANAGED_CHECKPOINTS_MISSING', 'MANAGED_OWNERSHIP_REMAINS', 'ACCOUNT_DELETION_NOT_IN_PROGRESS', 'UNKNOWN',
] as const;
const reasonCode = (value: unknown) => ((REASON_CODES as readonly unknown[]).includes(value) ? value as string : 'UNKNOWN');
const reasonCodes = (value: unknown) => [...new Set((Array.isArray(value) && value.length ? value : ['UNKNOWN']).map(reasonCode))];

const fail = (status: number, error: LifecycleErrorCode, extra: { reasons?: string[]; sessionsRevoked?: boolean } = {}): LifecycleResponse => ({
  status,
  body: {
    ok: false,
    error,
    ...(extra.reasons ? { reasons: extra.reasons } : {}),
    ...(extra.sessionsRevoked ? { sessions_revoked: true as const } : {}),
  },
});
const record = (value: unknown) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
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

const recentlyAuthenticated = (token: string, user: VerifiedUser, deps: LifecycleDeps) => {
  const at = lastAuthenticatedAt(token, user.id);
  return at !== null && deps.nowSeconds() - at <= RECENT_AUTH_SECONDS && at <= deps.nowSeconds() + 60;
};

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
// Preview (read-only): what a whole-account deletion would do now. Shown before the confirmation.

export async function handlePreview(input: { authorization: string | null }, deps: LifecycleDeps): Promise<LifecycleResponse> {
  const caller = await verifiedCaller(input.authorization, deps);
  if (!caller) return fail(401, 'AUTH_REQUIRED');
  const state = await eligibility(deps, caller.user.id);
  if (!state) return fail(500, 'FAILED');
  const apple = appleNeeded(caller.user, state);
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
      apple: {
        required: apple,
        supported: !apple || deps.revokeApple !== null,
        code_required: apple && !(state.operation?.recordedCheckpoints.includes('apple_revocation') ?? false),
      },
      x_cleanup: xCleanup,
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
  if (!recentlyAuthenticated(token, user, deps)) return fail(403, 'REAUTH_REQUIRED');
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
  if (!recentlyAuthenticated(token, user, deps)) return fail(403, 'REAUTH_REQUIRED');
  const expected = body.expected_lifecycle_version;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) return fail(400, 'LIFECYCLE_VERSION_REQUIRED');
  const appleCode = typeof body.apple_authorization_code === 'string' && body.apple_authorization_code.length > 0 ? body.apple_authorization_code : null;

  // 1. Read-only pre-checks: nothing changes when a requirement of a later step is already unmet.
  const before = await eligibility(deps, userId);
  if (!before) return fail(500, 'FAILED');
  const apple = appleNeeded(user, before);
  const appleDone = before.operation?.recordedCheckpoints.includes('apple_revocation') ?? false;
  if (apple && !appleDone) {
    if (!deps.revokeApple) return fail(409, 'APPLE_REVOCATION_UNAVAILABLE');
    if (!appleCode) return fail(400, 'APPLE_REAUTH_REQUIRED');
  }
  if (remaining(before, 'x_autopost')) {
    // The X saga keeps the login only in scope social_only (while the Kabumori profile exists). It must
    // never remove the login itself: that is the managed delete at the end of this flow.
    const preview = await xPreview(deps, token);
    if (preview?.scope !== 'social_only') return fail(409, 'X_CLEANUP_UNSUPPORTED');
  }

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

  let sessionsRevoked = false;
  // Every failure from here on is kept on the operation as a fixed code for an operator (best effort).
  const stop = async (response: LifecycleResponse): Promise<LifecycleResponse> => {
    if (!response.body.ok) {
      await call(deps, 'record_error', { p_user_id: userId, p_operation_id: operationId, p_error_code: response.body.error });
    }
    return response;
  };
  const checkpoint = async (key: 'session_revocation' | 'apple_revocation' | 'storage_cleanup') =>
    (await call(deps, 'record_checkpoint', { p_user_id: userId, p_operation_id: operationId, p_checkpoint: key }))?.status === 'recorded';
  const withdrawStorageCheckpoint = () =>
    call(deps, 'clear_checkpoint', { p_user_id: userId, p_operation_id: operationId, p_checkpoint: 'storage_cleanup' });

  // 3a. X first, through its own saga, wrapped by the lifecycle service deletion.
  const xBegun = await call(deps, 'begin_service_deletion', { p_user_id: userId, p_service_key: 'x_autopost' });
  if (!xBegun) return stop(fail(500, 'FAILED'));
  if (xBegun.status === 'blocked') return stop(fail(409, 'DELETION_BLOCKED', { reasons: [reasonCode(xBegun.reason)] }));
  if (xBegun.status === 'started' || xBegun.status === 'in_progress') {
    const xOperation = xBegun.operation_id;
    if (typeof xOperation !== 'string' || !UUID.test(xOperation)) return stop(fail(500, 'FAILED'));
    let outcome: XCleanupOutcome = 'failed';
    try {
      outcome = await deps.x.run(token);
    } catch {
      outcome = 'failed';
    }
    // The saga removed the login itself (it must not in social_only): nothing can be verified any more.
    if (outcome === 'login_deleted') return fail(500, 'DELETION_VERIFICATION_PENDING');
    if (outcome === 'scope_refused') return stop(fail(409, 'X_CLEANUP_UNSUPPORTED'));
    if (outcome === 'in_progress') return stop(fail(409, 'X_CLEANUP_IN_PROGRESS'));
    if (outcome === 'blocked') return stop(fail(409, 'X_CLEANUP_BLOCKED'));
    if (outcome !== 'done') return stop(fail(502, 'X_CLEANUP_FAILED'));
    const finished = await call(deps, 'finish_service_deletion', { p_user_id: userId, p_service_key: 'x_autopost', p_operation_id: xOperation });
    if (finished?.status !== 'ended') return stop(fail(500, 'SERVICE_CLEANUP_INCOMPLETE'));
  } else if (xBegun.status !== 'not_registered' && xBegun.status !== 'already_ended') {
    return stop(fail(500, 'FAILED'));
  }

  // 3b. Kabumori (one transaction: entitlement deleting -> profile cascade -> ended).
  const kabumori = await call(deps, 'withdraw_kabumori', { p_user_id: userId });
  if (!kabumori) return stop(fail(500, 'FAILED'));
  if (kabumori.status === 'blocked') return stop(fail(409, 'DELETION_BLOCKED', { reasons: [reasonCode(kabumori.reason)] }));
  if (kabumori.status !== 'ended' && kabumori.status !== 'already_ended' && kabumori.status !== 'not_registered') {
    return stop(fail(500, 'SERVICE_CLEANUP_INCOMPLETE'));
  }
  const afterServices = await eligibility(deps, userId);
  if (!afterServices) return stop(fail(500, 'FAILED'));
  if (afterServices.services.some((s) => s.status !== 'ended')) return stop(fail(500, 'SERVICE_CLEANUP_INCOMPLETE'));

  // 4. Sessions: every refresh token of the login. Repeated on a retry (a retry needed a new sign-in).
  //    Access tokens already issued stay valid until they expire; the lifecycle state, the revalidation
  //    and the post-delete read-back are what stop them (see the stale-token policy in the design doc).
  let revoked = false;
  try {
    revoked = await deps.revokeSessions(token);
  } catch {
    revoked = false;
  }
  if (!revoked) return stop(fail(502, 'SESSION_REVOKE_FAILED'));
  sessionsRevoked = true;
  if (!(await checkpoint('session_revocation'))) return stop(fail(500, 'FAILED', { sessionsRevoked }));

  // 5. Apple: once. The code is single-use; the checkpoint makes a retry skip this step.
  if (apple && !appleDone) {
    let ok = false;
    try {
      ok = deps.revokeApple !== null && appleCode !== null && await deps.revokeApple(appleCode, user.appleSubjects);
    } catch {
      ok = false;
    }
    if (!ok) return stop(fail(502, 'APPLE_REVOKE_FAILED', { sessionsRevoked }));
    if (!(await checkpoint('apple_revocation'))) return stop(fail(500, 'FAILED', { sessionsRevoked }));
  }

  // 6. Storage through its API, re-listed until empty.
  const storage = await cleanStorage(deps, userId);
  if (storage !== 'clean') {
    await withdrawStorageCheckpoint();
    return stop(storageFailure(storage, sessionsRevoked));
  }
  if (!(await checkpoint('storage_cleanup'))) return stop(fail(500, 'FAILED', { sessionsRevoked }));

  // 7. prepare, then 8. revalidate immediately before the delete: Storage listed again, prepare again.
  const prepare = async (): Promise<LifecycleResponse | null> => {
    const answer = await call(deps, 'prepare', { p_user_id: userId, p_operation_id: operationId });
    if (!answer) return fail(500, 'FAILED', { sessionsRevoked });
    if (answer.status === 'ready_for_managed_auth_delete' && answer.operation_id === operationId && answer.login_deleted === false) return null;
    if (answer.status === 'not_ready') return fail(409, 'NOT_READY', { reasons: [reasonCode(answer.reason)], sessionsRevoked });
    if (answer.status === 'blocked') return fail(409, 'DELETION_BLOCKED', { reasons: reasonCodes(answer.reasons), sessionsRevoked });
    return fail(500, 'FAILED', { sessionsRevoked });
  };
  const notReady = await prepare();
  if (notReady) return stop(notReady);
  const recheck = await storageInventory(deps, userId);
  if (!recheck || recheck.bucketsOwned || recheck.objects.length > 0 || recheck.more) {
    await withdrawStorageCheckpoint();
    return stop(!recheck ? storageFailure('failed', true) : recheck.bucketsOwned ? storageFailure('bucket_owned', true) : storageFailure('not_empty', true));
  }
  const stale = await prepare();
  if (stale) return stop(stale);

  // 9. Managed Auth Admin delete -- never SQL against auth.users.
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
    if (state === 'present') return stop(fail(502, 'AUTH_DELETE_FAILED', { sessionsRevoked }));
    if (state !== 'absent') return fail(500, 'AUTH_DELETE_UNCONFIRMED', { sessionsRevoked });
  }

  // 10. Post-delete read-back. Only a verified completion is reported as success. A Storage object a
  //     still-valid token uploaded after the revalidation is removed once more and verified again.
  for (let attempt = 0; attempt < 2; attempt++) {
    const done = await call(deps, 'complete', { p_user_id: userId, p_operation_id: operationId });
    if (done?.status === 'completed' && done.login_deleted === true) {
      return { status: 200, body: { ok: true, outcome: 'deleted' } };
    }
    if (done?.status === 'login_present') return fail(500, 'AUTH_DELETE_UNCONFIRMED', { sessionsRevoked });
    if (attempt === 0 && done?.status === 'not_verified' && done.reason === 'MANAGED_STORAGE_OWNED'
        && (await cleanStorage(deps, userId)) === 'clean') {
      continue;
    }
    break;
  }
  return fail(500, 'DELETION_VERIFICATION_PENDING', { sessionsRevoked });
}
