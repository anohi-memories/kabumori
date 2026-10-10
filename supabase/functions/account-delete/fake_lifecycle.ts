// A fake of the Phase 1/2/3a lifecycle database (with the PR112 corrective's ownership lease, external-step
// intents and release gate), Auth, Storage, Apple and the X saga, shared by the orchestrator tests and the
// HTTP-level (production wiring) tests. The real database half is proven in supabase/tests (disposable
// PostgreSQL); this fake answers the same way for the cases the TypeScript tests need.
import assert from 'node:assert/strict';

import type { AppleRevocationOutcome } from './apple_outcome.ts';
import { DELETE_CONFIRMATION, type LifecycleDeps, type LifecycleRpcName, type XCleanupOutcome } from './lifecycle_logic.ts';

export const NOW = 1_800_000_000;
export const USER = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const EMAIL = 'person@example.invalid';
export const APPLE_CODE = 'fixture-apple-code';
export const SETTLE_SECONDS = 900;
export const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
let sessions = 0;
/** A token of a new sign-in (its own session) authenticated at `authAt`. */
export const signIn = (authAt = NOW - 60, sub = USER) =>
  `${b64({ alg: 'HS256' })}.${b64({ sub, email: EMAIL, session_id: `session-${++sessions}`, amr: [{ method: 'password', timestamp: authAt }] })}.sig`;
export const bearer = (token: string) => `Bearer ${token}`;
export const deleteBody = (version: number, extra: Record<string, unknown> = {}) =>
  ({ action: 'delete_common_account', confirmation: DELETE_CONFIRMATION, expected_lifecycle_version: version, ...extra });

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export type Svc = 'active' | 'deleting' | 'ended' | null;
export type StorageObject = { bucketId: string; name: string };
export type DeleteLoginStep = 'deleted' | 'not_found' | 'failed' | 'failed_but_deleted' | 'throw';
export type Hook = 'x' | 'sessions' | 'apple' | 'storage' | 'delete';
export type WorldOptions = {
  kabumori?: Svc;
  x?: Svc;
  accountStatus?: 'active' | 'locked';
  blockers?: string[];
  apple?: boolean;
  appleConfigured?: boolean;
  gate?: 'open' | 'blocked';
  storage?: StorageObject[];
  bucketsOwned?: boolean;
  xRun?: XCleanupOutcome[];
  xPreviewFails?: boolean;
  sessionRevoke?: boolean[];
  appleRevoke?: (AppleRevocationOutcome | 'throw')[];
  storageRemove?: boolean[];
  /** Objects come back this many times after being removed (a still-valid token uploading again). */
  storageReappear?: number;
  prepareOverride?: (Record<string, unknown> | 'error')[];
  deleteLogin?: DeleteLoginStep[];
  loginStateAnswer?: 'present' | 'absent' | 'unknown';
  /** Right before the managed delete, a still-valid token uploads an object / re-creates an X workspace. */
  lateUpload?: 'removable' | 'stuck';
  lateWorkspace?: boolean;
  completeOverride?: (Record<string, unknown> | 'error')[];
  rpcError?: LifecycleRpcName;
  /** The named RPC fails (database error) this many times, then works. */
  rpcFailOnce?: Partial<Record<LifecycleRpcName, number>>;
  /** Between the first prepare and the revalidation, an object is uploaded. */
  uploadBeforeRevalidation?: boolean;
  /** Awaited at the entry of an external step (barriers for true overlap). */
  hooks?: Partial<Record<Hook, () => Promise<void>>>;
};

/** Fake of the Phase 1/2/3a lifecycle database plus Auth/Storage/Apple/X, with the same answers. */
export function world(options: WorldOptions = {}) {
  const effects: string[] = [];
  const shift = <T>(list: T[] | undefined, fallback: T): T => (list && list.length ? list.shift() as T : fallback);
  const xRun = [...(options.xRun ?? [])];
  const sessionRevoke = [...(options.sessionRevoke ?? [])];
  const appleRevoke = [...(options.appleRevoke ?? [])];
  const storageRemove = [...(options.storageRemove ?? [])];
  const prepareOverride = [...(options.prepareOverride ?? [])];
  const deleteLogin = [...(options.deleteLogin ?? [])];
  const completeOverride = [...(options.completeOverride ?? [])];
  const failOnce: Partial<Record<LifecycleRpcName, number>> = { ...(options.rpcFailOnce ?? {}) };
  let reappear = options.storageReappear ?? 0;
  let ids = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
  const state = {
    /** The database clock (seconds); tests move it to let leases and settle windows pass. */
    clock: NOW,
    gate: options.gate ?? 'open',
    login: true,
    apple: options.apple ?? false,
    account: (options.accountStatus ?? 'active') as 'active' | 'deleting' | 'locked',
    version: 5,
    services: { kabumori: options.kabumori === undefined ? 'active' : options.kabumori, x_autopost: options.x ?? null } as Record<'kabumori' | 'x_autopost', Svc>,
    profile: (options.kabumori === undefined ? 'active' : options.kabumori) !== null && options.kabumori !== 'ended',
    xWorkspace: options.x === 'active' || options.x === 'deleting',
    storage: [...(options.storage ?? [])],
    bucketsOwned: options.bucketsOwned ?? false,
    op: null as null | {
      id: string; checkpoints: Set<string>; step: 'cleanup' | 'ready'; status: 'in_progress' | 'login_removed' | 'completed' | 'aborted';
      errors: string[]; lease: string | null; leaseExpires: number; fence: number;
      external: null | 'apple_revocation' | 'managed_auth_delete'; externalStarted: number; intent: null | string[];
    },
    xServiceOp: null as string | null,
    revokedTokens: new Set<string>(),
    lateUploadDone: false,
    calls: { apple: 0, delete: 0, x: 0, sessions: 0 },
  };
  const required = () => ['session_revocation', 'storage_cleanup', ...(state.apple ? ['apple_revocation'] : [])].sort();
  const removeLogin = () => {
    state.login = false;
    // The Phase 1 guard: an open operation is closed as an (unverified) login removal.
    if (state.op?.status === 'in_progress') state.op.status = 'login_removed';
    state.account = 'active';
  };
  const serviceList = () => (['kabumori', 'x_autopost'] as const)
    .filter((key) => state.services[key] !== null).map((key) => ({ service_key: key, status: state.services[key] }));
  const remainingServices = () => serviceList().filter((s) => s.status !== 'ended').map((s) => s.service_key);
  /** The open operation when `lease` is its unexpired lease (private.account_lifecycle_owned_operation). */
  const owned = (args: Record<string, unknown>) => {
    const op = state.op;
    return op && state.login && op.status === 'in_progress' && args.p_operation_id === op.id && op.lease === args.p_lease && op.leaseExpires > state.clock ? op : null;
  };
  const prepareDecision = (op: NonNullable<typeof state.op>): Record<string, unknown> => {
    const remaining = remainingServices();
    if (remaining.length) { op.step = 'cleanup'; return { status: 'not_ready', reason: 'SERVICES_REMAIN', services: remaining }; }
    const missing = required().filter((key) => !op.checkpoints.has(key));
    if (missing.length) { op.step = 'cleanup'; return { status: 'not_ready', reason: 'MANAGED_CHECKPOINTS_MISSING', missing_checkpoints: missing }; }
    if (state.storage.length || state.bucketsOwned) { op.step = 'cleanup'; return { status: 'not_ready', reason: 'MANAGED_OWNERSHIP_REMAINS' }; }
    op.step = 'ready';
    return { status: 'ready_for_managed_auth_delete', operation_id: op.id, login_deleted: false };
  };
  const residue = () => (state.xWorkspace || state.profile ? 'RESIDUAL_SERVICE_DATA' : state.storage.length ? 'MANAGED_STORAGE_OWNED' : null);

  const answers: Record<LifecycleRpcName, (args: Record<string, unknown>) => unknown> = {
    release_gate: () => ({ managed_auth_delete: { state: state.gate, reason: 'IDENTITY_CHANGE_FENCE_MISSING' } }),
    eligibility: () => ({
      account_status: state.login ? state.account : 'none',
      lifecycle_version: state.login ? state.version : 0,
      requirement_epoch: 1,
      services: state.login ? serviceList() : [],
      blockers: state.account === 'deleting' ? [] : (options.blockers ?? []),
      required_checkpoints: required(),
      managed_ownership: state.storage.length ? ['MANAGED_STORAGE_OWNED'] : [],
      operation: state.op?.status === 'in_progress'
        ? { operation_id: state.op.id, step: state.op.step, recorded_checkpoints: [...state.op.checkpoints].sort() } : null,
      authorization: { state: 'none' },
    }),
    withdraw_kabumori: () => {
      if (state.account === 'locked') return { status: 'blocked', reason: 'ACCOUNT_LOCKED' };
      if (state.services.kabumori === null) return { status: 'not_registered' };
      if (state.services.kabumori === 'ended') return { status: 'already_ended' };
      state.services.kabumori = 'ended';
      state.profile = false;
      state.version += 2;
      return { status: 'ended' };
    },
    begin_service_deletion: (args) => {
      assert.equal(args.p_service_key, 'x_autopost');
      if (state.services.x_autopost === null) return { status: 'not_registered' };
      if (state.services.x_autopost === 'ended') return { status: 'already_ended' };
      if (state.services.x_autopost === 'deleting') return { status: 'in_progress', operation_id: state.xServiceOp ??= newId() };
      state.services.x_autopost = 'deleting';
      state.version += 1;
      state.xServiceOp = newId();
      return { status: 'started', operation_id: state.xServiceOp };
    },
    finish_service_deletion: (args) => {
      assert.equal(args.p_operation_id, state.xServiceOp);
      if (state.xWorkspace) return { status: 'not_ready', reason: 'SERVICE_FOOTPRINT_REMAINS' };
      state.services.x_autopost = 'ended';
      state.version += 1;
      return { status: 'ended' };
    },
    begin_account_deletion: (args) => {
      if (state.account === 'deleting' && state.op) return { status: 'in_progress', operation_id: state.op.id, lifecycle_version: state.version };
      if (args.p_expected_lifecycle_version !== state.version) return { status: 'lifecycle_changed', lifecycle_version: state.version };
      if (options.blockers?.length) return { status: 'blocked', reasons: options.blockers };
      state.account = 'deleting';
      state.version += 1;
      state.op = {
        id: newId(), checkpoints: new Set(), step: 'cleanup', status: 'in_progress', errors: [],
        lease: null, leaseExpires: 0, fence: 0, external: null, externalStarted: 0, intent: null,
      };
      return { status: 'started', operation_id: state.op.id, lifecycle_version: state.version, required_checkpoints: required() };
    },
    claim: (args) => {
      const op = state.op;
      if (!op || args.p_operation_id !== op.id || !state.login) return { status: 'not_found' };
      if (op.status !== 'in_progress') return { status: 'not_in_progress' };
      if (op.lease && op.leaseExpires > state.clock) return { status: 'in_progress' };
      if (op.external) {
        if (op.externalStarted > state.clock - SETTLE_SECONDS) return { status: 'in_progress', step: op.external };
        if (op.external === 'apple_revocation') {
          op.lease = null;
          op.errors.push('APPLE_REVOCATION_OUTCOME_UNKNOWN');
          return { status: 'reconciliation_required', step: 'apple_revocation' };
        }
        op.external = null; // the login is still here: that managed delete did not happen
      }
      op.lease = newId();
      op.leaseExpires = state.clock + Number(args.p_lease_seconds);
      op.fence += 1;
      return { status: 'acquired', lease: op.lease, fence: op.fence, recorded_checkpoints: [...op.checkpoints].sort() };
    },
    renew: (args) => {
      const op = owned(args);
      if (!op) return { status: 'lease_lost' };
      op.leaseExpires = state.clock + Number(args.p_lease_seconds);
      return { status: 'owned', fence: op.fence };
    },
    release: (args) => {
      if (state.op && state.op.id === args.p_operation_id && state.op.lease === args.p_lease) {
        state.op.lease = null;
        return { status: 'released' };
      }
      return { status: 'not_owned' };
    },
    owned_checkpoint: (args) => {
      assert.ok(args.p_checkpoint === 'session_revocation' || args.p_checkpoint === 'storage_cleanup', 'the Apple checkpoint is never a plain checkpoint');
      const op = owned(args);
      if (!op) return { status: 'lease_lost' };
      if (args.p_recorded) {
        op.checkpoints.add(String(args.p_checkpoint));
        return { status: 'recorded', checkpoint: args.p_checkpoint };
      }
      op.checkpoints.delete(String(args.p_checkpoint));
      op.step = 'cleanup';
      return { status: 'cleared', checkpoint: args.p_checkpoint };
    },
    owned_prepare: (args) => {
      const override = prepareOverride.shift();
      if (override === 'error') throw new Error('fixture database error');
      if (override) return override;
      const op = owned(args);
      if (!op) return { status: 'lease_lost' };
      return prepareDecision(op);
    },
    begin_external_step: (args) => {
      const op = owned(args);
      if (!op) return { status: 'lease_lost' };
      if (op.external) return { status: 'step_in_flight', step: op.external };
      if (args.p_step === 'apple_revocation') {
        if (op.checkpoints.has('apple_revocation')) return { status: 'already_recorded' };
      } else {
        if (state.gate !== 'open') return { status: 'release_blocked', reason: 'IDENTITY_CHANGE_FENCE_MISSING' };
        if (op.step !== 'ready') return { status: 'not_ready', reasons: ['NOT_READY'] };
        const decision = prepareDecision(op);
        if (decision.status !== 'ready_for_managed_auth_delete') return { status: 'not_ready', reasons: [decision.reason] };
        op.intent = required();
      }
      op.external = args.p_step as 'apple_revocation' | 'managed_auth_delete';
      op.externalStarted = state.clock;
      return { status: 'owned', fence: op.fence };
    },
    settle_external_step: (args) => {
      const op = owned(args);
      if (!op) return { status: 'lease_lost' };
      if (op.external !== args.p_step) return { status: 'step_mismatch' };
      if (args.p_outcome === 'succeeded') op.checkpoints.add('apple_revocation');
      op.external = null;
      return { status: args.p_outcome === 'succeeded' ? 'recorded' : 'cleared' };
    },
    storage_objects: () => ({
      status: 'ok',
      objects: state.storage.slice(0, 1000).map((o) => ({ bucket_id: o.bucketId, name: o.name })),
      more: state.storage.length > 1000,
      buckets_owned: state.bucketsOwned,
    }),
    complete: (args) => {
      const override = completeOverride.shift();
      if (override === 'error') throw new Error('fixture database error');
      if (override) return override;
      const op = state.op;
      if (!op || args.p_operation_id !== op.id || op.status === 'aborted') return { status: 'not_found' };
      if (state.login) return { status: 'login_present', login_deleted: false };
      if (op.status === 'completed') {
        const found = residue();
        return found ? { status: 'residue_found', reason: found, login_deleted: true } : { status: 'completed', operation_id: op.id, login_deleted: true };
      }
      const reason = op.status !== 'login_removed' ? 'LIFECYCLE_STATE_INCONSISTENT'
        : !op.intent || op.external !== 'managed_auth_delete' ? 'LOGIN_REMOVED_WITHOUT_MANAGED_INTENT'
        : op.step !== 'ready' ? 'LOGIN_REMOVED_BEFORE_READY'
        : op.intent.some((key) => !op.checkpoints.has(key)) ? 'MANAGED_CHECKPOINTS_MISSING'
        : residue();
      if (reason) return { status: 'not_verified', reason, login_deleted: true };
      op.status = 'completed';
      op.external = null;
      op.lease = null;
      return { status: 'completed', operation_id: op.id, login_deleted: true };
    },
    record_error: (args) => {
      if (!state.login || !state.op || state.op.status !== 'in_progress') return { status: 'not_found' };
      state.op.errors.push(String(args.p_error_code));
      return { status: 'recorded' };
    },
  };

  const hook = async (name: Hook) => {
    const pause = options.hooks?.[name];
    if (pause) await pause();
  };
  const deps: LifecycleDeps = {
    getUser: async (token) => {
      effects.push('auth:user');
      if (state.revokedTokens.has(token) || !state.login) return null;
      const claims = JSON.parse(atob(token.split('.')[1].replace(/-/gu, '+').replace(/_/gu, '/')));
      return { id: claims.sub, providers: state.apple ? ['email', 'apple'] : ['email'], appleSubjects: state.apple ? ['apple-subject'] : [] };
    },
    rpc: async (name, args) => {
      effects.push(`rpc:${name}`);
      if (name !== 'release_gate') assert.equal(args.p_user_id, USER, `${name} gets the verified person only`);
      if (options.rpcError === name) return { ok: false };
      if ((failOnce[name] ?? 0) > 0) {
        failOnce[name] = (failOnce[name] ?? 0) - 1;
        return { ok: false };
      }
      try {
        return { ok: true, data: answers[name](args) };
      } catch {
        return { ok: false };
      }
    },
    revokeSessions: async (token) => {
      effects.push('auth:revoke_sessions');
      state.calls.sessions += 1;
      await hook('sessions');
      const ok = shift(sessionRevoke, true);
      if (ok) state.revokedTokens.add(token);
      return ok;
    },
    removeStorageObjects: async (bucketId, names) => {
      effects.push('storage:remove');
      await hook('storage');
      if (!shift(storageRemove, true)) return false;
      const removed = state.storage.filter((o) => o.bucketId === bucketId && names.includes(o.name));
      if (options.lateUpload === 'stuck' && removed.some((o) => o.name === 'late.png')) return false;
      state.storage = state.storage.filter((o) => !(o.bucketId === bucketId && names.includes(o.name)));
      if (reappear > 0) {
        reappear -= 1;
        state.storage.push(...removed);
      }
      return true;
    },
    revokeApple: options.appleConfigured === false ? null : async (code, subjects) => {
      effects.push('apple:revoke');
      state.calls.apple += 1;
      await hook('apple');
      assert.equal(code, APPLE_CODE);
      assert.deepEqual(subjects, ['apple-subject']);
      const outcome = shift(appleRevoke, 'succeeded' as AppleRevocationOutcome | 'throw');
      if (outcome === 'throw') throw new Error('fixture network failure');
      return outcome;
    },
    x: {
      preview: async () => {
        effects.push('x:preview');
        if (options.xPreviewFails) throw new Error('fixture network failure');
        return { scope: state.profile ? 'social_only' : 'social_and_login', state: 'none' };
      },
      run: async () => {
        effects.push('x:run');
        state.calls.x += 1;
        await hook('x');
        const outcome = shift(xRun, 'done' as XCleanupOutcome);
        if (outcome === 'done') state.xWorkspace = false;
        if (outcome === 'login_deleted') { state.xWorkspace = false; removeLogin(); }
        return outcome;
      },
    },
    deleteLogin: async (userId) => {
      effects.push('auth:delete');
      state.calls.delete += 1;
      await hook('delete');
      assert.equal(userId, USER);
      if (options.lateUpload && !state.lateUploadDone) {
        state.lateUploadDone = true;
        state.storage.push({ bucketId: 'avatars', name: 'late.png' });
      }
      if (options.lateWorkspace) state.xWorkspace = true;
      const step = shift(deleteLogin, 'deleted' as DeleteLoginStep);
      if (step === 'throw') throw new Error('fixture network failure');
      if (step === 'failed') return 'failed';
      if (!state.login && step !== 'not_found') return 'not_found';
      removeLogin();
      return step === 'failed_but_deleted' ? 'failed' : step;
    },
    loginState: async () => {
      effects.push('auth:read');
      return options.loginStateAnswer ?? (state.login ? 'present' : 'absent');
    },
    nowSeconds: () => NOW,
  };
  // Upload between the two readiness decisions (a still-valid token).
  if (options.uploadBeforeRevalidation) {
    const original = answers.owned_prepare;
    answers.owned_prepare = (args) => {
      const answer = original(args) as Record<string, unknown>;
      if (answer.status === 'ready_for_managed_auth_delete' && !state.lateUploadDone) {
        state.lateUploadDone = true;
        state.storage.push({ bucketId: 'avatars', name: 'between-prepare-and-recheck.png' });
      }
      return answer;
    };
  }
  /** Operator reconciliation of an Apple step (never called by the function). */
  const resolveApple = (revoked: boolean) => {
    const op = state.op!;
    assert.equal(op.external, 'apple_revocation');
    if (revoked) op.checkpoints.add('apple_revocation');
    op.external = null;
  };
  return { deps, state, effects, resolveApple, answers, removeLogin };
}

export type World = ReturnType<typeof world>;
