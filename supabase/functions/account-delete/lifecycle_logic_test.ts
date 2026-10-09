// Behavior of the common-account lifecycle boundary over a fake of the lifecycle database, Auth, Storage,
// Apple and the X saga. The real database half is proven in supabase/tests (disposable PostgreSQL);
// here every external step, its order, its retry and its failure is exercised.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELETE_CONFIRMATION,
  handleDeleteCommonAccount,
  handlePreview,
  handleWithdrawKabumori,
  RECENT_AUTH_SECONDS,
  STORAGE_PASSES,
  WITHDRAW_CONFIRMATION,
  type LifecycleDeps,
  type LifecycleResponse,
  type LifecycleRpcName,
  type XCleanupOutcome,
} from './lifecycle_logic.ts';

const NOW = 1_800_000_000;
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'person@example.invalid';
const APPLE_CODE = 'fixture-apple-code';
const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
let sessions = 0;
/** A token of a new sign-in (its own session) authenticated at `authAt`. */
const signIn = (authAt = NOW - 60, sub = USER) =>
  `${b64({ alg: 'HS256' })}.${b64({ sub, email: EMAIL, session_id: `session-${++sessions}`, amr: [{ method: 'password', timestamp: authAt }] })}.sig`;
const bearer = (token: string) => `Bearer ${token}`;
const deleteBody = (version: number, extra: Record<string, unknown> = {}) =>
  ({ action: 'delete_common_account', confirmation: DELETE_CONFIRMATION, expected_lifecycle_version: version, ...extra });

type Svc = 'active' | 'deleting' | 'ended' | null;
type StorageObject = { bucketId: string; name: string };
type DeleteLoginStep = 'deleted' | 'not_found' | 'failed' | 'failed_but_deleted' | 'throw';
type WorldOptions = {
  kabumori?: Svc;
  x?: Svc;
  accountStatus?: 'active' | 'locked';
  blockers?: string[];
  apple?: boolean;
  appleConfigured?: boolean;
  storage?: StorageObject[];
  bucketsOwned?: boolean;
  xRun?: XCleanupOutcome[];
  xPreviewFails?: boolean;
  sessionRevoke?: boolean[];
  appleRevoke?: boolean[];
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
  /** Between the first prepare and the revalidation, an object is uploaded. */
  uploadBeforeRevalidation?: boolean;
};

/** Fake of the Phase 1/2/3a lifecycle database plus Auth/Storage/Apple/X, with the same answers. */
function world(options: WorldOptions = {}) {
  const effects: string[] = [];
  const shift = <T>(list: T[] | undefined, fallback: T): T => (list && list.length ? list.shift() as T : fallback);
  const xRun = [...(options.xRun ?? [])];
  const sessionRevoke = [...(options.sessionRevoke ?? [])];
  const appleRevoke = [...(options.appleRevoke ?? [])];
  const storageRemove = [...(options.storageRemove ?? [])];
  const prepareOverride = [...(options.prepareOverride ?? [])];
  const deleteLogin = [...(options.deleteLogin ?? [])];
  const completeOverride = [...(options.completeOverride ?? [])];
  let reappear = options.storageReappear ?? 0;
  let ids = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
  const state = {
    login: true,
    account: (options.accountStatus ?? 'active') as 'active' | 'deleting' | 'locked',
    version: 5,
    services: { kabumori: options.kabumori === undefined ? 'active' : options.kabumori, x_autopost: options.x ?? null } as Record<'kabumori' | 'x_autopost', Svc>,
    profile: (options.kabumori === undefined ? 'active' : options.kabumori) !== null && options.kabumori !== 'ended',
    xWorkspace: options.x === 'active' || options.x === 'deleting',
    storage: [...(options.storage ?? [])],
    bucketsOwned: options.bucketsOwned ?? false,
    op: null as null | { id: string; checkpoints: Set<string>; step: 'cleanup' | 'ready'; status: 'in_progress' | 'login_removed' | 'completed' | 'aborted'; errors: string[] },
    xServiceOp: null as string | null,
    revokedTokens: new Set<string>(),
    lateUploadDone: false,
  };
  const required = () => ['session_revocation', 'storage_cleanup', ...(options.apple ? ['apple_revocation'] : [])].sort();
  const removeLogin = () => {
    state.login = false;
    // The Phase 1 guard: an open operation is closed as an (unverified) login removal.
    if (state.op?.status === 'in_progress') state.op.status = 'login_removed';
    state.account = 'active';
  };
  const serviceList = () => (['kabumori', 'x_autopost'] as const)
    .filter((key) => state.services[key] !== null).map((key) => ({ service_key: key, status: state.services[key] }));

  const answers: Record<LifecycleRpcName, (args: Record<string, unknown>) => unknown> = {
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
      state.op = { id: newId(), checkpoints: new Set(), step: 'cleanup', status: 'in_progress', errors: [] };
      return { status: 'started', operation_id: state.op.id, lifecycle_version: state.version, required_checkpoints: required() };
    },
    record_checkpoint: (args) => {
      if (!state.op || state.op.status !== 'in_progress' || args.p_operation_id !== state.op.id) return { status: 'not_found' };
      state.op.checkpoints.add(String(args.p_checkpoint));
      return { status: 'recorded', checkpoint: args.p_checkpoint };
    },
    clear_checkpoint: (args) => {
      if (!state.op || state.op.status !== 'in_progress') return { status: 'not_found' };
      state.op.checkpoints.delete(String(args.p_checkpoint));
      state.op.step = 'cleanup';
      return { status: 'cleared', checkpoint: args.p_checkpoint };
    },
    prepare: (args) => {
      const override = prepareOverride.shift();
      if (override === 'error') throw new Error('fixture database error');
      if (override) return override;
      if (!state.op || args.p_operation_id !== state.op.id) return { status: 'not_found' };
      if (state.op.status !== 'in_progress') return { status: 'not_ready', reason: 'ACCOUNT_DELETION_NOT_IN_PROGRESS' };
      const remaining = serviceList().filter((s) => s.status !== 'ended').map((s) => s.service_key);
      if (remaining.length) { state.op.step = 'cleanup'; return { status: 'not_ready', reason: 'SERVICES_REMAIN', services: remaining }; }
      const missing = required().filter((key) => !state.op!.checkpoints.has(key));
      if (missing.length) { state.op.step = 'cleanup'; return { status: 'not_ready', reason: 'MANAGED_CHECKPOINTS_MISSING', missing_checkpoints: missing }; }
      if (state.storage.length || state.bucketsOwned) { state.op.step = 'cleanup'; return { status: 'not_ready', reason: 'MANAGED_OWNERSHIP_REMAINS' }; }
      state.op.step = 'ready';
      const answer = { status: 'ready_for_managed_auth_delete', operation_id: state.op.id, login_deleted: false };
      if (options.uploadBeforeRevalidation && !state.lateUploadDone) {
        state.lateUploadDone = true;
        state.storage.push({ bucketId: 'avatars', name: 'between-prepare-and-recheck.png' });
      }
      return answer;
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
      if (!state.op || args.p_operation_id !== state.op.id || state.op.status === 'aborted') return { status: 'not_found' };
      if (state.op.status === 'completed') return { status: 'completed', operation_id: state.op.id, login_deleted: true };
      if (state.login) return { status: 'login_present', login_deleted: false };
      const reason = state.op.status !== 'login_removed' ? 'LIFECYCLE_STATE_INCONSISTENT'
        : state.op.step !== 'ready' ? 'LOGIN_REMOVED_BEFORE_READY'
        : state.xWorkspace || state.profile ? 'RESIDUAL_SERVICE_DATA'
        : state.storage.length ? 'MANAGED_STORAGE_OWNED' : null;
      if (reason) return { status: 'not_verified', reason, login_deleted: true };
      state.op.status = 'completed';
      return { status: 'completed', operation_id: state.op.id, login_deleted: true };
    },
    record_error: (args) => {
      if (!state.login || !state.op || state.op.status !== 'in_progress') return { status: 'not_found' };
      state.op.errors.push(String(args.p_error_code));
      return { status: 'recorded' };
    },
  };

  const deps: LifecycleDeps = {
    getUser: async (token) => {
      effects.push('auth:user');
      if (state.revokedTokens.has(token) || !state.login) return null;
      const claims = JSON.parse(atob(token.split('.')[1].replace(/-/gu, '+').replace(/_/gu, '/')));
      return { id: claims.sub, providers: options.apple ? ['email', 'apple'] : ['email'], appleSubjects: options.apple ? ['apple-subject'] : [] };
    },
    rpc: async (name, args) => {
      effects.push(`rpc:${name}`);
      assert.equal(args.p_user_id, USER, `${name} gets the verified person only`);
      if (options.rpcError === name) return { ok: false };
      try {
        return { ok: true, data: answers[name](args) };
      } catch {
        return { ok: false };
      }
    },
    revokeSessions: async (token) => {
      effects.push('auth:revoke_sessions');
      const ok = shift(sessionRevoke, true);
      if (ok) state.revokedTokens.add(token);
      return ok;
    },
    removeStorageObjects: async (bucketId, names) => {
      effects.push('storage:remove');
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
      assert.equal(code, APPLE_CODE);
      assert.deepEqual(subjects, ['apple-subject']);
      return shift(appleRevoke, true);
    },
    x: {
      preview: async () => {
        effects.push('x:preview');
        if (options.xPreviewFails) throw new Error('fixture network failure');
        return { scope: state.profile ? 'social_only' : 'social_and_login', state: 'none' };
      },
      run: async () => {
        effects.push('x:run');
        const outcome = shift(xRun, 'done' as XCleanupOutcome);
        if (outcome === 'done') state.xWorkspace = false;
        if (outcome === 'login_deleted') { state.xWorkspace = false; removeLogin(); }
        return outcome;
      },
    },
    deleteLogin: async (userId) => {
      effects.push('auth:delete');
      assert.equal(userId, USER);
      if (options.lateUpload && !state.lateUploadDone) {
        state.lateUploadDone = true;
        state.storage.push({ bucketId: 'avatars', name: 'late.png' });
      }
      if (options.lateWorkspace) state.xWorkspace = true;
      const step = shift(deleteLogin, 'deleted' as DeleteLoginStep);
      if (step === 'throw') throw new Error('fixture network failure');
      if (step === 'failed') return 'failed';
      removeLogin();
      return step === 'failed_but_deleted' ? 'failed' : step;
    },
    loginState: async () => {
      effects.push('auth:read');
      return options.loginStateAnswer ?? (state.login ? 'present' : 'absent');
    },
    nowSeconds: () => NOW,
  };
  return { deps, state, effects };
}

const preview = (w: ReturnType<typeof world>, token: string) => handlePreview({ authorization: bearer(token) }, w.deps);
const withdraw = (w: ReturnType<typeof world>, token: string, body: Record<string, unknown> = { confirmation: WITHDRAW_CONFIRMATION }) =>
  handleWithdrawKabumori({ authorization: bearer(token), body }, w.deps);
const remove = (w: ReturnType<typeof world>, token: string, body: Record<string, unknown> = deleteBody(w.state.version)) =>
  handleDeleteCommonAccount({ authorization: bearer(token), body }, w.deps);
const error = (response: LifecycleResponse) => (response.body.ok ? null : response.body.error);
const writes = (effects: string[]) => effects.filter((e) => !['auth:user', 'rpc:eligibility', 'x:preview', 'rpc:storage_objects'].includes(e));

// --- preview --------------------------------------------------------------------------------------------

test('preview: services, X cleanup support and Apple needs, without any id or address', async () => {
  const w = world({ x: 'active' });
  const token = signIn();
  const response = await preview(w, token);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true, account_status: 'active', lifecycle_version: 5,
    services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status: 'active' }],
    blockers: [], deletion_in_progress: false,
    apple: { required: false, supported: true, code_required: false }, x_cleanup: 'supported',
  });
  assert.deepEqual(writes(w.effects), []);
});

test('preview: Apple, X scope and blockers are reported as fixed values', async () => {
  const appleUnconfigured = await preview(world({ apple: true, appleConfigured: false }), signIn());
  assert.deepEqual((appleUnconfigured.body as Record<string, unknown>).apple, { required: true, supported: false, code_required: true });
  const xWithoutKabumori = await preview(world({ kabumori: 'ended', x: 'active' }), signIn());
  assert.equal((xWithoutKabumori.body as Record<string, unknown>).x_cleanup, 'unsupported');
  const xUnreachable = await preview(world({ x: 'active', xPreviewFails: true }), signIn());
  assert.equal((xUnreachable.body as Record<string, unknown>).x_cleanup, 'unsupported');
  const blocked = await preview(world({ blockers: ['ADMIN_ACCOUNT', 'SOMETHING_NEW'] }), signIn());
  assert.deepEqual((blocked.body as Record<string, unknown>).blockers, ['ADMIN_ACCOUNT', 'UNKNOWN']);
  assert.equal(error(await handlePreview({ authorization: null }, world().deps)), 'AUTH_REQUIRED');
  assert.equal(error(await handlePreview({ authorization: 'Bearer' }, world().deps)), 'AUTH_REQUIRED');
});

// --- かぶモリの利用を終了 ----------------------------------------------------------------------------

test('withdraw: a Kabumori-only person ends Kabumori and keeps the login', async () => {
  const w = world();
  const response = await withdraw(w, signIn());
  assert.deepEqual(response, { status: 200, body: { ok: true, outcome: 'ended' } });
  assert.equal(w.state.services.kabumori, 'ended');
  assert.equal(w.state.login, true);
  assert.equal(w.state.account, 'active');
  assert.deepEqual(writes(w.effects), ['rpc:withdraw_kabumori']);
  assert.deepEqual(await withdraw(w, signIn()), { status: 200, body: { ok: true, outcome: 'already_ended' } }, 'idempotent');
});

test('withdraw: a person with both services keeps X (entitlement, workspace, posting) and the login', async () => {
  const w = world({ x: 'active' });
  assert.equal((await withdraw(w, signIn())).status, 200);
  assert.equal(w.state.services.x_autopost, 'active');
  assert.equal(w.state.xWorkspace, true);
  assert.equal(w.state.login, true);
  assert.ok(!w.effects.some((e) => e.startsWith('x:') || e.startsWith('auth:revoke') || e === 'auth:delete'));
});

test('withdraw: confirmation and a recent re-authentication are required; nothing changes without them', async () => {
  for (const [token, body, code] of [
    [signIn(), {}, 'CONFIRMATION_REQUIRED'],
    [signIn(), { confirmation: DELETE_CONFIRMATION }, 'CONFIRMATION_REQUIRED'],
    [signIn(NOW - RECENT_AUTH_SECONDS - 1), { confirmation: WITHDRAW_CONFIRMATION }, 'REAUTH_REQUIRED'],
    [`${b64({ alg: 'HS256' })}.${b64({ sub: USER, amr: [] })}.sig`, { confirmation: WITHDRAW_CONFIRMATION }, 'REAUTH_REQUIRED'],
    [signIn(NOW + 3600), { confirmation: WITHDRAW_CONFIRMATION }, 'REAUTH_REQUIRED'],
  ] as const) {
    const w = world();
    assert.equal(error(await withdraw(w, token, body)), code);
    assert.deepEqual(writes(w.effects), []);
    assert.equal(w.state.services.kabumori, 'active');
  }
});

test('withdraw: refused while a whole-account deletion is in progress, and fails closed on server answers', async () => {
  const w = world({ x: 'active', xRun: ['failed'] });
  assert.equal(error(await remove(w, signIn(), deleteBody(5))), 'X_CLEANUP_FAILED', 'an X failure leaves the deletion open');
  const during = await withdraw(w, signIn());
  assert.deepEqual(during.body, { ok: false, error: 'WITHDRAW_BLOCKED', reasons: ['ACCOUNT_DELETION_IN_PROGRESS'] });
  assert.equal(error(await withdraw(world({ accountStatus: 'locked' }), signIn())), 'WITHDRAW_BLOCKED');
  assert.equal(error(await withdraw(world({ rpcError: 'withdraw_kabumori' }), signIn())), 'FAILED');
  assert.equal(error(await withdraw(world({ rpcError: 'eligibility' }), signIn())), 'FAILED');
}, );

// --- 共通アカウントを削除: the canonical sequence -------------------------------------------------------

test('delete: a Kabumori-only person, in the canonical order, reported only after the read-back', async () => {
  const w = world();
  const response = await remove(w, signIn());
  assert.deepEqual(response, { status: 200, body: { ok: true, outcome: 'deleted' } });
  assert.deepEqual(w.effects, [
    'auth:user', 'rpc:eligibility', 'rpc:begin_account_deletion',
    'rpc:begin_service_deletion', 'rpc:withdraw_kabumori', 'rpc:eligibility',
    'auth:revoke_sessions', 'rpc:record_checkpoint',
    'rpc:storage_objects', 'rpc:record_checkpoint',
    'rpc:prepare', 'rpc:storage_objects', 'rpc:prepare',
    'auth:delete', 'rpc:complete',
  ]);
  assert.equal(w.state.login, false);
  assert.equal(w.state.op?.status, 'completed');
});

test('delete: both services -- X through its saga first (login kept by it), then Kabumori, Storage emptied through the API', async () => {
  const w = world({ x: 'active', storage: [{ bucketId: 'avatars', name: 'p/a.png' }, { bucketId: 'reports', name: 'p/b.pdf' }] });
  const response = await remove(w, signIn());
  assert.equal(response.status, 200);
  const order = (step: string) => w.effects.indexOf(step);
  assert.ok(order('x:preview') < order('rpc:begin_account_deletion'), 'X scope checked before anything changes');
  assert.ok(order('x:run') < order('rpc:withdraw_kabumori'), 'X ends before Kabumori (its scope depends on the profile)');
  assert.ok(order('rpc:finish_service_deletion') < order('rpc:withdraw_kabumori'));
  assert.equal(w.effects.filter((e) => e === 'storage:remove').length, 2, 'one request per bucket');
  assert.ok(order('storage:remove') < order('rpc:prepare'));
  assert.equal(w.state.storage.length, 0);
  assert.equal(w.state.op?.status, 'completed');
});

test('delete: confirmation, recent re-authentication and the shown version are required; nothing changes without them', async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    [signIn(), { action: 'delete_common_account', expected_lifecycle_version: 5 }, 'CONFIRMATION_REQUIRED'],
    [signIn(), { confirmation: WITHDRAW_CONFIRMATION, expected_lifecycle_version: 5 }, 'CONFIRMATION_REQUIRED'],
    [signIn(NOW - RECENT_AUTH_SECONDS - 1), deleteBody(5), 'REAUTH_REQUIRED'],
    [signIn(NOW - 60, OTHER), deleteBody(5), 'REAUTH_REQUIRED'],
    [signIn(), { confirmation: DELETE_CONFIRMATION }, 'LIFECYCLE_VERSION_REQUIRED'],
    [signIn(), { confirmation: DELETE_CONFIRMATION, expected_lifecycle_version: '5' }, 'LIFECYCLE_VERSION_REQUIRED'],
    [signIn(), { confirmation: DELETE_CONFIRMATION, expected_lifecycle_version: -1 }, 'LIFECYCLE_VERSION_REQUIRED'],
  ];
  for (const [token, body, code] of cases) {
    const w = world();
    // The OTHER token verifies as OTHER; it never reaches an RPC because the amr check is against sub.
    w.deps.getUser = async () => ({ id: USER, providers: ['email'], appleSubjects: [] });
    assert.equal(error(await remove(w, token, body)), code, code);
    assert.deepEqual(writes(w.effects), []);
    assert.equal(w.state.account, 'active');
  }
});

test('delete: a stale confirmation version fails closed, also when resuming', async () => {
  const w = world();
  assert.equal(error(await remove(w, signIn(), deleteBody(4))), 'LIFECYCLE_CHANGED');
  assert.equal(w.state.op, null, 'nothing begun');
  const v = world({ storageRemove: [false], storage: [{ bucketId: 'avatars', name: 'x.png' }] });
  assert.equal(error(await remove(v, signIn(), deleteBody(5))), 'STORAGE_CLEANUP_FAILED');
  assert.equal(error(await remove(v, signIn(), deleteBody(5))), 'LIFECYCLE_CHANGED', 'the version moved since that confirmation');
  assert.equal((await remove(v, signIn(), deleteBody(v.state.version))).status, 200, 'resumed at the version shown now');
});

test('delete: blocked people are refused before anything changes', async () => {
  const w = world({ blockers: ['ADMIN_ACCOUNT'] });
  const response = await remove(w, signIn());
  assert.deepEqual(response.body, { ok: false, error: 'DELETION_BLOCKED', reasons: ['ADMIN_ACCOUNT'] });
  assert.equal(w.state.op, null);
});

test('delete: the login is never removed while any service remains', async () => {
  // X cleanup fails: X stays "deleting", nothing after it runs.
  const w = world({ x: 'active', xRun: ['failed'] });
  const response = await remove(w, signIn());
  assert.equal(error(response), 'X_CLEANUP_FAILED');
  assert.equal(w.state.services.x_autopost, 'deleting');
  assert.ok(!w.effects.includes('rpc:withdraw_kabumori') && !w.effects.includes('rpc:prepare') && !w.effects.includes('auth:delete'));
  assert.deepEqual(w.state.op?.errors, ['X_CLEANUP_FAILED'], 'kept for an operator as a fixed code');
  // The saga answered done but the workspace is still there: the entitlement cannot end.
  const v = world({ x: 'active' });
  v.deps.x.run = async () => 'done';
  assert.equal(error(await remove(v, signIn())), 'SERVICE_CLEANUP_INCOMPLETE');
  assert.ok(!v.effects.includes('auth:delete'));
  // prepare itself still sees a service: not ready, no delete.
  const u = world({ prepareOverride: [{ status: 'not_ready', reason: 'SERVICES_REMAIN', services: ['kabumori'] }] });
  assert.deepEqual((await remove(u, signIn())).body, { ok: false, error: 'NOT_READY', reasons: ['SERVICES_REMAIN'], sessions_revoked: true });
  assert.ok(!u.effects.includes('auth:delete'));
});

test('delete: only two consecutive ready answers for this operation authorize the managed delete', async () => {
  const notReady: (Record<string, unknown> | 'error')[][] = [
    [{ status: 'not_ready', reason: 'MANAGED_CHECKPOINTS_MISSING' }],
    [{ status: 'not_ready', reason: 'MANAGED_OWNERSHIP_REMAINS' }],
    [{ status: 'blocked', reasons: ['UNREGISTERED_SERVICE_FOOTPRINT'] }],
    [{ status: 'not_found' }],
    ['error'],
    [{ status: 'ready_for_managed_auth_delete', operation_id: OTHER, login_deleted: false }],
    [{ status: 'ready_for_managed_auth_delete', login_deleted: false }],
    [{ status: 'ready_for_managed_auth_delete', operation_id: 'OP', login_deleted: true }],
    [{ status: 'ready' }],
  ];
  for (const answers of notReady) {
    for (const position of ['first', 'revalidation'] as const) {
      const w = world();
      const fixed = answers.map((a) => (a !== 'error' && a.operation_id === 'OP' ? { ...a, operation_id: '00000000-0000-4000-8000-000000000001' } : a));
      w.deps.rpc = ((original) => async (name, args) => {
        if (name === 'prepare' && (position === 'first' || w.effects.filter((e) => e === 'rpc:prepare').length >= 1)) {
          w.effects.push('rpc:prepare');
          const answer = fixed.shift();
          if (answer !== undefined) return answer === 'error' ? { ok: false } : { ok: true, data: answer };
        }
        return original(name, args);
      })(w.deps.rpc);
      const response = await remove(w, signIn());
      assert.equal(response.body.ok, false, `${JSON.stringify(answers)} at ${position}`);
      assert.ok(!w.effects.includes('auth:delete'), `no delete after ${JSON.stringify(answers)} at ${position}`);
      assert.equal(w.state.login, true);
    }
  }
});

test('delete: concurrent requests -- a second request resumes the same operation; a start in between makes the confirmation stale', async () => {
  const w = world({ x: 'active', xRun: ['in_progress'] });
  const first = await remove(w, signIn());
  assert.equal(error(first), 'X_CLEANUP_IN_PROGRESS', 'the other request holds the X saga lease');
  const operation = w.state.op?.id;
  const second = await remove(w, signIn(), deleteBody(w.state.version));
  assert.equal(second.status, 200);
  assert.equal(w.state.op?.id, operation, 'the same durable operation');
  const v = world();
  const shown = v.state.version;
  v.state.version += 1; // a service start (or any lifecycle change) committed after the preview
  assert.equal(error(await remove(v, signIn(), deleteBody(shown))), 'LIFECYCLE_CHANGED');
  assert.equal(v.state.op, null);
});

// --- retries resume from the durable state -------------------------------------------------------------

test('delete: a retry after a failure at each step resumes and never repeats a finished external step', async () => {
  const steps: [string, WorldOptions, string][] = [
    ['X saga', { x: 'active', xRun: ['failed'] }, 'X_CLEANUP_FAILED'],
    ['session revocation', { x: 'active', sessionRevoke: [false] }, 'SESSION_REVOKE_FAILED'],
    ['Apple', { x: 'active', apple: true, appleRevoke: [false] }, 'APPLE_REVOKE_FAILED'],
    ['Storage', { x: 'active', storage: [{ bucketId: 'a', name: 'n' }], storageRemove: [false] }, 'STORAGE_CLEANUP_FAILED'],
    ['prepare', { x: 'active', prepareOverride: [{ status: 'not_ready', reason: 'MANAGED_CHECKPOINTS_MISSING' }] }, 'NOT_READY'],
    ['Auth delete', { x: 'active', deleteLogin: ['failed'] }, 'AUTH_DELETE_FAILED'],
  ];
  for (const [label, options, code] of steps) {
    const w = world(options);
    const body = () => deleteBody(w.state.version, options.apple ? { apple_authorization_code: APPLE_CODE } : {});
    const first = await remove(w, signIn(), body());
    assert.equal(error(first), code, label);
    assert.equal(w.state.login, true, `${label}: login kept`);
    const xRunsBefore = w.effects.filter((e) => e === 'x:run').length;
    const appleBefore = w.effects.filter((e) => e === 'apple:revoke').length;
    const xDone = w.state.services.x_autopost === 'ended';
    const appleDone = w.state.op?.checkpoints.has('apple_revocation') ?? false;
    // The person signs in again (a revoked session cannot call) and retries with the version shown now.
    const second = await remove(w, signIn(), body());
    assert.deepEqual(second, { status: 200, body: { ok: true, outcome: 'deleted' } }, `${label}: retry completes`);
    assert.equal(w.effects.filter((e) => e === 'x:run').length - xRunsBefore, xDone ? 0 : 1, `${label}: X saga not repeated after it ended`);
    assert.equal(w.effects.filter((e) => e === 'apple:revoke').length - appleBefore, appleDone || !options.apple ? 0 : 1, `${label}: Apple not repeated after its checkpoint`);
  }
});

test('delete: after the sessions are revoked, the old token can no longer act (the person must sign in again)', async () => {
  const w = world({ storage: [{ bucketId: 'a', name: 'n' }], storageRemove: [false] });
  const token = signIn();
  const first = await remove(w, token);
  assert.deepEqual(first.body, { ok: false, error: 'STORAGE_CLEANUP_FAILED', sessions_revoked: true });
  assert.equal(error(await remove(w, token, deleteBody(w.state.version))), 'AUTH_REQUIRED');
  assert.equal(error(await preview(w, token)), 'AUTH_REQUIRED');
  assert.equal((await remove(w, signIn(), deleteBody(w.state.version))).status, 200);
});

// --- Storage -------------------------------------------------------------------------------------------

test('delete: Storage still non-empty after the first pass is listed and removed again', async () => {
  const w = world({ storage: [{ bucketId: 'avatars', name: 'a.png' }], storageReappear: 1 });
  assert.equal((await remove(w, signIn())).status, 200);
  assert.equal(w.effects.filter((e) => e === 'storage:remove').length, 2);
});

test('delete: Storage that keeps refilling stops the deletion before readiness and withdraws the checkpoint', async () => {
  const w = world({ storage: [{ bucketId: 'avatars', name: 'a.png' }], storageReappear: 100 });
  const response = await remove(w, signIn());
  assert.deepEqual(response.body, { ok: false, error: 'STORAGE_NOT_EMPTY', sessions_revoked: true });
  assert.equal(response.status, 503);
  assert.equal(w.effects.filter((e) => e === 'storage:remove').length, STORAGE_PASSES);
  assert.ok(!w.effects.includes('rpc:prepare') && !w.effects.includes('auth:delete'));
  assert.ok(w.effects.includes('rpc:clear_checkpoint'));
  assert.equal(w.state.op?.checkpoints.has('storage_cleanup'), false);
});

test('delete: an upload between prepare and the revalidation is caught before the managed delete', async () => {
  const w = world({ uploadBeforeRevalidation: true });
  const response = await remove(w, signIn());
  assert.equal(error(response), 'STORAGE_NOT_EMPTY');
  assert.ok(!w.effects.includes('auth:delete'));
  assert.equal(w.state.op?.checkpoints.has('storage_cleanup'), false);
  assert.equal((await remove(w, signIn(), deleteBody(w.state.version))).status, 200, 'a retry cleans it');
});

test('delete: an owned bucket and an unreadable Storage inventory fail closed', async () => {
  assert.equal(error(await remove(world({ bucketsOwned: true }), signIn())), 'STORAGE_BUCKET_OWNED');
  const w = world();
  w.deps.rpc = ((original) => async (name, args) =>
    name === 'storage_objects' ? { ok: true, data: { status: 'probe_failed' } } : original(name, args))(w.deps.rpc);
  assert.equal(error(await remove(w, signIn())), 'STORAGE_CLEANUP_FAILED');
  const v = world();
  v.deps.rpc = ((original) => async (name, args) =>
    name === 'storage_objects' ? { ok: true, data: { status: 'ok', objects: [{ bucket_id: 'a', name: null }], more: false, buckets_owned: false } } : original(name, args))(v.deps.rpc);
  assert.equal(error(await remove(v, signIn())), 'STORAGE_CLEANUP_FAILED');
  for (const t of [w, v]) assert.ok(!t.effects.includes('auth:delete'));
});

// --- Apple ---------------------------------------------------------------------------------------------

test('delete: Apple required -- no code, not configured, revoke failure; once revoked it is not repeated', async () => {
  const noCode = world({ apple: true });
  assert.equal(error(await remove(noCode, signIn())), 'APPLE_REAUTH_REQUIRED');
  assert.equal(noCode.state.op, null, 'refused before anything changes');
  const unconfigured = world({ apple: true, appleConfigured: false });
  assert.equal(error(await remove(unconfigured, signIn(), deleteBody(5, { apple_authorization_code: APPLE_CODE }))), 'APPLE_REVOCATION_UNAVAILABLE');
  assert.equal(unconfigured.state.op, null);
  const failing = world({ apple: true, appleRevoke: [false], deleteLogin: ['failed'] });
  assert.equal(error(await remove(failing, signIn(), deleteBody(5, { apple_authorization_code: APPLE_CODE }))), 'APPLE_REVOKE_FAILED');
  assert.equal(failing.state.op?.checkpoints.has('apple_revocation'), false);
  assert.ok(!failing.effects.includes('auth:delete'));
  assert.equal(error(await remove(failing, signIn(), deleteBody(failing.state.version, { apple_authorization_code: APPLE_CODE }))), 'AUTH_DELETE_FAILED');
  assert.equal(failing.state.op?.checkpoints.has('apple_revocation'), true);
  const applesBefore = failing.effects.filter((e) => e === 'apple:revoke').length;
  // The single-use code is spent; the retry needs none.
  assert.equal((await remove(failing, signIn(), deleteBody(failing.state.version))).status, 200);
  assert.equal(failing.effects.filter((e) => e === 'apple:revoke').length, applesBefore);
});

// --- X -------------------------------------------------------------------------------------------------

test('delete: X cleanup that would remove the login, is busy, blocked, or removed the login fails closed', async () => {
  const noProfile = world({ kabumori: null, x: 'active' });
  assert.equal(error(await remove(noProfile, signIn())), 'X_CLEANUP_UNSUPPORTED');
  assert.equal(noProfile.state.op, null, 'refused before anything changes');
  assert.equal(error(await remove(world({ x: 'active', xPreviewFails: true }), signIn())), 'X_CLEANUP_UNSUPPORTED');
  for (const [outcome, code] of [['in_progress', 'X_CLEANUP_IN_PROGRESS'], ['blocked', 'X_CLEANUP_BLOCKED'], ['scope_refused', 'X_CLEANUP_UNSUPPORTED'], ['failed', 'X_CLEANUP_FAILED']] as const) {
    const w = world({ x: 'active', xRun: [outcome] });
    assert.equal(error(await remove(w, signIn())), code);
    assert.equal(w.state.services.kabumori, 'active', 'Kabumori is not ended before X');
    assert.ok(!w.effects.includes('auth:delete'));
  }
  const saga = world({ x: 'active', xRun: ['login_deleted'] });
  const response = await remove(saga, signIn());
  assert.equal(error(response), 'DELETION_VERIFICATION_PENDING');
  assert.ok(!saga.effects.includes('auth:delete') && !saga.effects.includes('rpc:complete'));
  const thrown = world({ x: 'active' });
  thrown.deps.x.run = async () => { throw new Error('fixture network failure'); };
  assert.equal(error(await remove(thrown, signIn())), 'X_CLEANUP_FAILED');
});

// --- sessions ------------------------------------------------------------------------------------------

test('delete: a session revocation failure records nothing and removes nothing', async () => {
  const w = world({ sessionRevoke: [false] });
  const response = await remove(w, signIn());
  assert.deepEqual(response.body, { ok: false, error: 'SESSION_REVOKE_FAILED' });
  assert.equal(w.state.op?.checkpoints.has('session_revocation'), false);
  assert.ok(!w.effects.includes('auth:delete'));
  const thrown = world();
  thrown.deps.revokeSessions = async () => { throw new Error('fixture network failure'); };
  assert.equal(error(await remove(thrown, signIn())), 'SESSION_REVOKE_FAILED');
});

// --- the managed Auth delete --------------------------------------------------------------------------

test('delete: Auth Admin delete failure, 404 and an unconfirmed answer', async () => {
  const failing = world({ deleteLogin: ['failed'] });
  assert.equal(error(await remove(failing, signIn())), 'AUTH_DELETE_FAILED');
  assert.equal(failing.state.login, true);
  assert.equal(failing.state.op?.status, 'in_progress');
  assert.equal((await remove(failing, signIn(), deleteBody(failing.state.version))).status, 200, 'idempotent retry');

  const gone = world({ deleteLogin: ['not_found'] });
  assert.deepEqual((await remove(gone, signIn())).body, { ok: true, outcome: 'deleted' }, '404 is verified, not assumed');
  assert.ok(gone.effects.includes('rpc:complete'));

  const lostAnswer = world({ deleteLogin: ['failed_but_deleted'] });
  assert.equal((await remove(lostAnswer, signIn())).status, 200);
  assert.ok(lostAnswer.effects.includes('auth:read'));

  for (const answer of ['unknown', 'absent'] as const) {
    const w = world({ deleteLogin: ['failed'], loginStateAnswer: answer });
    const response = await remove(w, signIn());
    assert.equal(response.body.ok, false, `login state ${answer} is never success`);
  }
  const thrown = world({ deleteLogin: ['throw'], loginStateAnswer: 'unknown' });
  assert.equal(error(await remove(thrown, signIn())), 'AUTH_DELETE_UNCONFIRMED');
});

// --- post-delete verification ---------------------------------------------------------------------------

test('delete: post-delete verification failures never return success', async () => {
  for (const override of [
    ['error'],
    [{ status: 'not_verified', reason: 'RESIDUAL_SERVICE_DATA', login_deleted: true }],
    [{ status: 'not_verified', reason: 'LOGIN_REMOVED_BEFORE_READY', login_deleted: true }],
    [{ status: 'not_found' }],
    [{ status: 'completed' }],
    [{ status: 'completed', login_deleted: false }],
    [{ status: 'login_present', login_deleted: false }],
    [{}],
  ] as (Record<string, unknown> | 'error')[][]) {
    const w = world({ completeOverride: [...override] });
    const response = await remove(w, signIn());
    assert.equal(response.body.ok, false, JSON.stringify(override));
    assert.ok(['DELETION_VERIFICATION_PENDING', 'AUTH_DELETE_UNCONFIRMED'].includes(error(response) ?? ''), JSON.stringify(override));
  }
});

test('delete: a still-valid token acting after the revalidation -- removable residue is cleaned and verified, anything else stays unverified', async () => {
  const removable = world({ lateUpload: 'removable' });
  assert.deepEqual((await remove(removable, signIn())).body, { ok: true, outcome: 'deleted' });
  assert.equal(removable.state.storage.length, 0);
  const stuck = world({ lateUpload: 'stuck' });
  const response = await remove(stuck, signIn());
  assert.deepEqual(response.body, { ok: false, error: 'DELETION_VERIFICATION_PENDING', sessions_revoked: true });
  assert.notEqual(stuck.state.op?.status, 'completed');
  const workspace = world({ lateWorkspace: true });
  assert.equal(error(await remove(workspace, signIn())), 'DELETION_VERIFICATION_PENDING');
  assert.notEqual(workspace.state.op?.status, 'completed');
});

// --- identity, logging --------------------------------------------------------------------------------

test('no request can name another person: body ids are ignored, every step uses the verified id', async () => {
  const w = world({ x: 'active' });
  const body = deleteBody(5, { user_id: OTHER, p_user_id: OTHER, userId: OTHER, target: OTHER });
  assert.equal((await remove(w, signIn(), body)).status, 200);
  const v = world();
  assert.equal((await withdraw(v, signIn(), { confirmation: WITHDRAW_CONFIRMATION, user_id: OTHER, p_user_id: OTHER })).status, 200);
  // (The fake's rpc() asserts p_user_id === USER on every call; deleteLogin asserts USER.)
  const unverified = world();
  unverified.deps.getUser = async () => null;
  assert.equal(error(await remove(unverified, signIn())), 'AUTH_REQUIRED');
  assert.deepEqual(unverified.effects, []);
  const malformed = world();
  malformed.deps.getUser = async () => ({ id: 'not-a-uuid', providers: [], appleSubjects: [] });
  assert.equal(error(await remove(malformed, signIn())), 'AUTH_REQUIRED');
});

test('nothing is logged and no response carries a token, id, address, code or object name', async () => {
  const logged: unknown[] = [];
  const original = { ...console };
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = (...args: unknown[]) => { logged.push(args); };
  const bodies: string[] = [];
  const tokens: string[] = [];
  try {
    const flows: [WorldOptions, 'preview' | 'withdraw' | 'delete', Record<string, unknown>?][] = [
      [{ x: 'active', apple: true, storage: [{ bucketId: 'avatars', name: 'secret-name.png' }] }, 'delete', { apple_authorization_code: APPLE_CODE }],
      [{ x: 'active', xRun: ['failed'] }, 'delete'],
      [{ deleteLogin: ['failed'] }, 'delete'],
      [{ lateUpload: 'stuck' }, 'delete'],
      [{ completeOverride: ['error'] }, 'delete'],
      [{ blockers: ['ADMIN_ACCOUNT'] }, 'delete'],
      [{ x: 'active' }, 'preview'],
      [{}, 'withdraw'],
      [{ rpcError: 'withdraw_kabumori' }, 'withdraw'],
    ];
    for (const [options, kind, extra] of flows) {
      const w = world(options);
      const token = signIn();
      tokens.push(token);
      const response = kind === 'preview' ? await preview(w, token)
        : kind === 'withdraw' ? await withdraw(w, token)
        : await remove(w, token, deleteBody(5, extra ?? {}));
      bodies.push(JSON.stringify(response.body));
    }
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logged, []);
  for (const body of bodies) {
    for (const secret of [USER, OTHER, EMAIL, APPLE_CODE, 'secret-name.png', 'apple-subject', 'session-', ...tokens]) {
      assert.ok(!body.includes(secret), `response leaks ${secret.slice(0, 12)}: ${body}`);
    }
  }
});

test('the module itself has no logging and no direct network access', async () => {
  const source = await Deno.readTextFile(new URL('./lifecycle_logic.ts', import.meta.url));
  assert.ok(!/console\./u.test(source));
  assert.ok(!/\bfetch\(/u.test(source));
  assert.ok(!/Deno\.env/u.test(source));
  // The managed delete is reachable from exactly one place, after the second ready answer.
  assert.equal(source.match(/deps\.deleteLogin\(/gu)?.length, 1);
  const deleteAt = source.indexOf('deps.deleteLogin(');
  const staleAt = source.indexOf('const stale = await prepare();');
  assert.ok(staleAt > 0 && deleteAt > staleAt);
});
