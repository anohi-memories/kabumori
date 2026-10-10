// Behavior of the common-account lifecycle boundary over a fake of the lifecycle database (with the
// PR112 H2 corrective's ownership lease, external-step intents and release gate), Auth, Storage, Apple and
// the X saga. The real database half is proven in supabase/tests (disposable PostgreSQL); here every
// external step, its order, its retry, its failure and true overlap (barriers, not sequential calls) is
// exercised.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPLE_CODE,
  b64,
  bearer,
  deferred,
  deleteBody,
  EMAIL,
  NOW,
  OTHER,
  SETTLE_SECONDS,
  signIn,
  USER,
  world,
  type Hook,
  type World,
  type WorldOptions,
} from './fake_lifecycle.ts';
import {
  DELETE_CONFIRMATION,
  handleDeleteCommonAccount,
  handlePreview,
  handleWithdrawKabumori,
  LEASE_SECONDS,
  RECENT_AUTH_SECONDS,
  STORAGE_PASSES,
  WITHDRAW_CONFIRMATION,
  type LifecycleResponse,
} from './lifecycle_logic.ts';


const preview = (w: World, token: string) => handlePreview({ authorization: bearer(token) }, w.deps);
const withdraw = (w: World, token: string, body: Record<string, unknown> = { confirmation: WITHDRAW_CONFIRMATION }) =>
  handleWithdrawKabumori({ authorization: bearer(token), body }, w.deps);
const remove = (w: World, token: string, body: Record<string, unknown> = deleteBody(w.state.version)) =>
  handleDeleteCommonAccount({ authorization: bearer(token), body }, w.deps);
const error = (response: LifecycleResponse) => (response.body.ok ? null : response.body.error);
const readOnly = ['auth:user', 'rpc:release_gate', 'rpc:eligibility', 'x:preview', 'rpc:storage_objects'];
const writes = (effects: string[]) => effects.filter((e) => !readOnly.includes(e));

// --- preview --------------------------------------------------------------------------------------------

test('preview: services, X cleanup support, availability and Apple needs, without any id or address', async () => {
  const w = world({ x: 'active' });
  const response = await preview(w, signIn());
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true, account_status: 'active', lifecycle_version: 5,
    services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status: 'active' }],
    blockers: [], deletion_in_progress: false, deletion_available: true,
    apple: { required: false, supported: true, code_required: false }, x_cleanup: 'supported',
  });
  assert.deepEqual(writes(w.effects), []);
  assert.equal(((await preview(world({ gate: 'blocked' }), signIn())).body as Record<string, unknown>).deletion_available, false, 'R3: the release gate is shown');
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
  const gateUnreadable = await preview(world({ rpcError: 'release_gate' }), signIn());
  assert.equal((gateUnreadable.body as Record<string, unknown>).deletion_available, false, 'an unreadable gate is blocked');
  assert.equal(error(await handlePreview({ authorization: null }, world().deps)), 'AUTH_REQUIRED');
  assert.equal(error(await handlePreview({ authorization: 'Bearer' }, world().deps)), 'AUTH_REQUIRED');
});

// --- recent authentication (H2 C1) ----------------------------------------------------------------------

test('C1: a future authentication time is refused (+1, +30, +60); the 600-second boundary is exact', async () => {
  for (const [authAt, ok] of [
    [NOW + 1, false], [NOW + 30, false], [NOW + 60, false], [NOW + 3600, false],
    [NOW, true], [NOW - RECENT_AUTH_SECONDS, true], [NOW - RECENT_AUTH_SECONDS - 1, false],
  ] as const) {
    const w = world();
    const withdrawn = await withdraw(w, signIn(authAt));
    assert.equal(withdrawn.body.ok, ok, `withdraw at now${authAt - NOW >= 0 ? '+' : ''}${authAt - NOW}`);
    if (!ok) {
      assert.equal(error(withdrawn), 'REAUTH_REQUIRED');
      assert.deepEqual(writes(w.effects), []);
    }
    const v = world();
    const deleted = await remove(v, signIn(authAt));
    assert.equal(deleted.body.ok, ok, `delete at now${authAt - NOW >= 0 ? '+' : ''}${authAt - NOW}`);
    if (!ok) {
      assert.equal(error(deleted), 'REAUTH_REQUIRED');
      assert.deepEqual(writes(v.effects), []);
    }
  }
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
});

// --- 共通アカウントを削除: the canonical sequence -------------------------------------------------------

test('delete: a Kabumori-only person, in the canonical order, owned throughout, reported only after the read-back', async () => {
  const w = world();
  const response = await remove(w, signIn());
  assert.deepEqual(response, { status: 200, body: { ok: true, outcome: 'deleted' } });
  assert.deepEqual(w.effects, [
    'auth:user', 'rpc:release_gate', 'rpc:eligibility', 'rpc:begin_account_deletion', 'rpc:claim',
    'rpc:renew', 'rpc:begin_service_deletion',
    'rpc:renew', 'rpc:withdraw_kabumori', 'rpc:eligibility',
    'rpc:renew', 'auth:revoke_sessions', 'rpc:owned_checkpoint',
    'rpc:renew', 'rpc:storage_objects', 'rpc:owned_checkpoint',
    'rpc:owned_prepare', 'rpc:storage_objects', 'rpc:owned_prepare',
    'rpc:begin_external_step', 'auth:delete', 'rpc:complete', 'rpc:release',
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
  assert.ok(order('rpc:claim') < order('x:run'), 'owned before the first external action');
  assert.ok(order('x:run') < order('rpc:withdraw_kabumori'), 'X ends before Kabumori (its scope depends on the profile)');
  assert.ok(order('rpc:finish_service_deletion') < order('rpc:withdraw_kabumori'));
  assert.equal(w.effects.filter((e) => e === 'storage:remove').length, 2, 'one request per bucket');
  assert.ok(order('storage:remove') < order('rpc:owned_prepare'));
  assert.equal(w.state.storage.length, 0);
  assert.equal(w.state.op?.status, 'completed');
});

test('R3: while the managed delete is release-blocked, a deletion is refused before anything changes', async () => {
  const w = world({ gate: 'blocked', x: 'active' });
  const response = await remove(w, signIn());
  assert.deepEqual(response, { status: 409, body: { ok: false, error: 'COMMON_ACCOUNT_DELETION_UNAVAILABLE' } });
  assert.deepEqual(writes(w.effects), [], 'no begin, no claim, no external call');
  assert.equal(w.state.op, null);
  assert.equal(w.state.account, 'active');
  assert.equal(error(await remove(world({ rpcError: 'release_gate' }), signIn())), 'COMMON_ACCOUNT_DELETION_UNAVAILABLE', 'unreadable = blocked');
  // The gate closes between the pre-check and the managed delete (a reviewed rollback): no delete.
  const v = world();
  const original = v.deps.rpc;
  v.deps.rpc = async (name, args) => {
    if (name === 'begin_external_step' && args.p_step === 'managed_auth_delete') v.state.gate = 'blocked';
    return original(name, args);
  };
  const late = await remove(v, signIn());
  assert.deepEqual(late.body, { ok: false, error: 'COMMON_ACCOUNT_DELETION_UNAVAILABLE', sessions_revoked: true });
  assert.equal(v.state.calls.delete, 0);
  assert.equal(v.state.login, true);
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
  const w = world({ x: 'active', xRun: ['failed'] });
  const response = await remove(w, signIn());
  assert.equal(error(response), 'X_CLEANUP_FAILED');
  assert.equal(w.state.services.x_autopost, 'deleting');
  assert.ok(!w.effects.includes('rpc:withdraw_kabumori') && !w.effects.includes('rpc:owned_prepare') && !w.effects.includes('auth:delete'));
  assert.deepEqual(w.state.op?.errors, ['X_CLEANUP_FAILED'], 'kept for an operator as a fixed code');
  assert.equal(w.state.op?.lease, null, 'ownership given back');
  const v = world({ x: 'active' });
  v.deps.x.run = async () => 'done';
  assert.equal(error(await remove(v, signIn())), 'SERVICE_CLEANUP_INCOMPLETE');
  assert.ok(!v.effects.includes('auth:delete'));
  const u = world({ prepareOverride: [{ status: 'not_ready', reason: 'SERVICES_REMAIN', services: ['kabumori'] }] });
  assert.deepEqual((await remove(u, signIn())).body, { ok: false, error: 'NOT_READY', reasons: ['SERVICES_REMAIN'], sessions_revoked: true });
  assert.ok(!u.effects.includes('auth:delete'));
});

test('delete: only two consecutive ready answers for this operation authorize the managed delete intent', async () => {
  const notReady: (Record<string, unknown> | 'error')[][] = [
    [{ status: 'not_ready', reason: 'MANAGED_CHECKPOINTS_MISSING' }],
    [{ status: 'not_ready', reason: 'MANAGED_OWNERSHIP_REMAINS' }],
    [{ status: 'blocked', reasons: ['UNREGISTERED_SERVICE_FOOTPRINT'] }],
    [{ status: 'not_found' }],
    [{ status: 'lease_lost' }],
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
      let prepares = 0;
      w.deps.rpc = ((original) => async (name, args) => {
        if (name === 'owned_prepare' && (position === 'first' || prepares++ >= 1)) {
          w.effects.push('rpc:owned_prepare');
          const answer = fixed.shift();
          if (answer !== undefined) return answer === 'error' ? { ok: false } : { ok: true, data: answer };
        }
        return original(name, args);
      })(w.deps.rpc);
      const response = await remove(w, signIn());
      assert.equal(response.body.ok, false, `${JSON.stringify(answers)} at ${position}`);
      assert.ok(!w.effects.includes('rpc:begin_external_step') && !w.effects.includes('auth:delete'), `no intent, no delete after ${JSON.stringify(answers)} at ${position}`);
      assert.equal(w.state.login, true);
    }
  }
});

test('delete: the managed delete intent itself decides last (not ready, lost, in flight, unreadable): no delete', async () => {
  for (const answer of [
    { status: 'not_ready', reasons: ['REQUIRED_CHECKPOINTS_CHANGED', 'MANAGED_CHECKPOINTS_MISSING'] },
    { status: 'lease_lost' }, { status: 'step_in_flight', step: 'apple_revocation' }, { status: 'release_blocked' }, 'error', {},
  ] as (Record<string, unknown> | 'error')[]) {
    const w = world();
    w.deps.rpc = ((original) => async (name, args) => {
      if (name === 'begin_external_step' && args.p_step === 'managed_auth_delete') {
        w.effects.push('rpc:begin_external_step');
        return answer === 'error' ? { ok: false } : { ok: true, data: answer };
      }
      return original(name, args);
    })(w.deps.rpc);
    const response = await remove(w, signIn());
    assert.equal(response.body.ok, false, JSON.stringify(answer));
    assert.equal(w.state.calls.delete, 0, JSON.stringify(answer));
  }
});

// --- R1: one owner, true overlap ---------------------------------------------------------------------

async function overlap(options: WorldOptions, hookName: Hook, extra: Record<string, unknown> = {}) {
  const arrived = deferred();
  const go = deferred();
  const w = world({ ...options, hooks: { [hookName]: async () => { arrived.resolve(); await go.promise; } } });
  const version = w.state.version;
  const first = remove(w, signIn(), deleteBody(version, extra));
  await arrived.promise;
  // A second request of the same person (a fresh sign-in, the version shown now) while the first is
  // inside an external step.
  const second = await remove(w, signIn(), deleteBody(w.state.version, extra));
  go.resolve();
  return { w, first: await first, second };
}

test('R1: a second request during any external step is told "in progress" and calls nothing external', async () => {
  for (const [label, options, hookName, extra] of [
    ['Kabumori-only, inside the session revocation', {}, 'sessions', {}],
    ['both services, inside the X saga', { x: 'active' }, 'x', {}],
    ['Kabumori-only, inside the Storage removal', { storage: [{ bucketId: 'a', name: 'n' }] }, 'storage', {}],
    ['Apple identity, inside the Apple revocation', { apple: true }, 'apple', { apple_authorization_code: APPLE_CODE }],
    ['inside the managed Auth delete', {}, 'delete', {}],
  ] as [string, WorldOptions, Hook, Record<string, unknown>][]) {
    const { w, first, second } = await overlap(options, hookName, extra);
    assert.deepEqual(second.body.ok, false, label);
    assert.equal(error(second), 'DELETION_IN_PROGRESS', label);
    assert.deepEqual(first, { status: 200, body: { ok: true, outcome: 'deleted' } }, `${label}: the owner finishes`);
    assert.equal(w.state.calls.delete, 1, `${label}: one managed delete`);
    assert.equal(w.state.calls.apple, options.apple ? 1 : 0, `${label}: Apple at most once`);
    assert.equal(w.state.calls.x, options.x ? 1 : 0, `${label}: X saga once`);
    assert.equal(w.state.calls.sessions, 1, `${label}: sessions revoked once`);
  }
});

test('R1: an owner that crashed is taken over only after its lease expired; the stale owner then stops without acting', async () => {
  const arrived = deferred();
  const go = deferred();
  let paused = false;
  const w = world({ storage: [{ bucketId: 'a', name: 'n' }], hooks: { storage: async () => { if (!paused) { paused = true; arrived.resolve(); await go.promise; } } } });
  const first = remove(w, signIn());
  await arrived.promise; // the first owner hangs inside the Storage API (crashed, from everyone else's view)
  assert.equal(error(await remove(w, signIn(), deleteBody(w.state.version))), 'DELETION_IN_PROGRESS', 'within the lease: in progress');
  w.state.clock += LEASE_SECONDS + 1;
  const takeover = await remove(w, signIn(), deleteBody(w.state.version));
  assert.deepEqual(takeover.body, { ok: true, outcome: 'deleted' }, 'a new owner (fence 2) completes');
  assert.equal(w.state.op?.fence, 2);
  go.resolve();
  const stale = await first;
  assert.equal(error(stale), 'DELETION_IN_PROGRESS', 'the stale owner stops at its next owned step and never reports success');
  assert.equal(w.state.calls.delete, 1, 'one managed delete in total');
});

test('R1: a stale owner inside the Apple step is never replaced by a second Apple call (reconciliation instead)', async () => {
  const arrived = deferred();
  const go = deferred();
  const w = world({ apple: true, hooks: { apple: async () => { arrived.resolve(); await go.promise; } } });
  const body = () => deleteBody(w.state.version, { apple_authorization_code: APPLE_CODE });
  const first = remove(w, signIn(), body());
  await arrived.promise;
  w.state.clock += LEASE_SECONDS + 1; // the lease expired; the Apple step may still be running
  assert.equal(error(await remove(w, signIn(), body())), 'DELETION_IN_PROGRESS', 'within the settle window: in progress');
  w.state.clock += SETTLE_SECONDS;
  assert.equal(error(await remove(w, signIn(), body())), 'RECONCILIATION_REQUIRED', 'afterwards: reconciliation, never a replay');
  go.resolve();
  const stale = await first; // Apple answered true, but the owner lost its lease: nothing recorded
  assert.equal(error(stale), 'RECONCILIATION_REQUIRED');
  assert.equal(w.state.calls.apple, 1);
  assert.equal(w.state.calls.delete, 0);
  assert.equal(w.state.op?.checkpoints.has('apple_revocation'), false, 'not assumed either way');
});

test('R1: a start committed after the preview makes the confirmation stale; a busy X saga is reported as such', async () => {
  const v = world();
  const shown = v.state.version;
  v.state.version += 1; // a service start (or any lifecycle change) committed after the preview
  assert.equal(error(await remove(v, signIn(), deleteBody(shown))), 'LIFECYCLE_CHANGED');
  assert.equal(v.state.op, null);
  const w = world({ x: 'active', xRun: ['in_progress'] });
  assert.equal(error(await remove(w, signIn())), 'X_CLEANUP_IN_PROGRESS', 'the X app holds the X saga lease');
  const operation = w.state.op?.id;
  assert.equal((await remove(w, signIn(), deleteBody(w.state.version))).status, 200);
  assert.equal(w.state.op?.id, operation, 'the same durable operation');
});

// --- R2: the Apple step -------------------------------------------------------------------------------

test('R2: Apple succeeded but its checkpoint could not be written -- never a second Apple call; reconciliation', async () => {
  const w = world({ apple: true, rpcFailOnce: { settle_external_step: 1 } });
  const body = () => deleteBody(w.state.version, { apple_authorization_code: APPLE_CODE });
  const first = await remove(w, signIn(), body());
  assert.deepEqual(first.body, { ok: false, error: 'RECONCILIATION_REQUIRED', sessions_revoked: true });
  assert.equal(w.state.op?.external, 'apple_revocation', 'the intent stays');
  assert.equal(error(await remove(w, signIn(), body())), 'DELETION_IN_PROGRESS', 'right after: the step may still be settling');
  w.state.clock += SETTLE_SECONDS + 1;
  assert.equal(error(await remove(w, signIn(), body())), 'RECONCILIATION_REQUIRED');
  assert.equal(w.state.calls.apple, 1, 'the single-use code was used once');
  assert.equal(w.state.calls.delete, 0, 'no managed delete while unsettled');
  // An operator confirms the revocation out of band; the person resumes without a new Apple call.
  w.resolveApple(true);
  assert.deepEqual((await remove(w, signIn(), deleteBody(w.state.version))).body, { ok: true, outcome: 'deleted' });
  assert.equal(w.state.calls.apple, 1);
});

test('R2: the Apple call broke off (unknown outcome) -- reconciliation, the intent stays', async () => {
  const w = world({ apple: true, appleRevoke: ['throw'] });
  const response = await remove(w, signIn(), deleteBody(5, { apple_authorization_code: APPLE_CODE }));
  assert.deepEqual(response.body, { ok: false, error: 'RECONCILIATION_REQUIRED', sessions_revoked: true });
  assert.equal(w.state.op?.external, 'apple_revocation');
  assert.equal(w.state.calls.delete, 0);
  // An operator finds it not revoked: a new code may be used.
  w.state.clock += SETTLE_SECONDS + 1;
  w.resolveApple(false);
  assert.equal((await remove(w, signIn(), deleteBody(w.state.version, { apple_authorization_code: APPLE_CODE }))).status, 200);
  assert.equal(w.state.calls.apple, 2);
});

test('R2 (rereview): an ambiguous Apple answer (gateway / 5xx / anything after the code was accepted) is never a failure', async () => {
  for (const answer of ['unknown', true, false, undefined, 'failed'] as unknown[]) {
    const w = world({ apple: true });
    w.deps.revokeApple = async () => answer as 'unknown';
    const body = () => deleteBody(w.state.version, { apple_authorization_code: APPLE_CODE });
    const first = await remove(w, signIn(), body());
    assert.deepEqual(first.body, { ok: false, error: 'RECONCILIATION_REQUIRED', sessions_revoked: true }, String(answer));
    assert.equal(w.state.op?.external, 'apple_revocation', `${String(answer)}: the intent stays`);
    w.state.clock += SETTLE_SECONDS + 1;
    let calls = 0;
    w.deps.revokeApple = async () => { calls += 1; return 'succeeded'; };
    assert.equal(error(await remove(w, signIn(), body())), 'RECONCILIATION_REQUIRED', `${String(answer)}: the consumed code is never sent again`);
    assert.equal(calls, 0);
    assert.equal(w.state.calls.delete, 0);
  }
});

test('R2: Apple refused (definitive) -- cleared, a new code may be used; a recorded revocation is never repeated', async () => {
  const w = world({ apple: true, appleRevoke: ['definitively_failed'], deleteLogin: ['failed'] });
  const body = () => deleteBody(w.state.version, { apple_authorization_code: APPLE_CODE });
  assert.equal(error(await remove(w, signIn(), body())), 'APPLE_REVOKE_FAILED');
  assert.equal(w.state.op?.external, null);
  assert.equal(error(await remove(w, signIn(), body())), 'AUTH_DELETE_FAILED');
  assert.equal(w.state.op?.checkpoints.has('apple_revocation'), true);
  const applesBefore = w.state.calls.apple;
  assert.equal((await remove(w, signIn(), deleteBody(w.state.version))).status, 200, 'the spent code is not needed again');
  assert.equal(w.state.calls.apple, applesBefore);
});

test('delete: Apple required -- no code or not configured is refused before anything changes', async () => {
  const noCode = world({ apple: true });
  assert.equal(error(await remove(noCode, signIn())), 'APPLE_REAUTH_REQUIRED');
  assert.equal(noCode.state.op, null);
  const unconfigured = world({ apple: true, appleConfigured: false });
  assert.equal(error(await remove(unconfigured, signIn(), deleteBody(5, { apple_authorization_code: APPLE_CODE }))), 'APPLE_REVOCATION_UNAVAILABLE');
  assert.equal(unconfigured.state.op, null);
});

// --- retries resume from the durable state -------------------------------------------------------------

test('delete: a retry after a failure at each step resumes and never repeats a finished external step', async () => {
  const steps: [string, WorldOptions, string][] = [
    ['X saga', { x: 'active', xRun: ['failed'] }, 'X_CLEANUP_FAILED'],
    ['session revocation', { x: 'active', sessionRevoke: [false] }, 'SESSION_REVOKE_FAILED'],
    ['Apple', { x: 'active', apple: true, appleRevoke: ['definitively_failed'] }, 'APPLE_REVOKE_FAILED'],
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
    assert.equal(w.state.op?.lease, null, `${label}: ownership given back at once`);
    const xRunsBefore = w.state.calls.x;
    const appleBefore = w.state.calls.apple;
    const xDone = w.state.services.x_autopost === 'ended';
    const appleDone = w.state.op?.checkpoints.has('apple_revocation') ?? false;
    const second = await remove(w, signIn(), body());
    assert.deepEqual(second, { status: 200, body: { ok: true, outcome: 'deleted' } }, `${label}: retry completes`);
    assert.equal(w.state.calls.x - xRunsBefore, xDone ? 0 : 1, `${label}: X saga not repeated after it ended`);
    assert.equal(w.state.calls.apple - appleBefore, appleDone || !options.apple ? 0 : 1, `${label}: Apple not repeated after its checkpoint`);
    assert.equal(w.state.op?.fence, 2, `${label}: one owner per attempt`);
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
  assert.ok(!w.effects.includes('rpc:owned_prepare') && !w.effects.includes('auth:delete'));
  assert.equal(w.state.op?.checkpoints.has('storage_cleanup'), false);
});

test('delete: an upload between prepare and the revalidation is caught before the managed delete', async () => {
  const w = world({ uploadBeforeRevalidation: true });
  const response = await remove(w, signIn());
  assert.equal(error(response), 'STORAGE_NOT_EMPTY');
  assert.ok(!w.effects.includes('rpc:begin_external_step') && !w.effects.includes('auth:delete'));
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
  assert.equal(failing.state.op?.external, null, 'a failed delete with the login present is settled');
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
  assert.equal(thrown.state.op?.external, 'managed_auth_delete', 'an unconfirmed delete stays recorded');
});

// --- post-delete verification (R4) -----------------------------------------------------------------------

test('delete: post-delete verification failures never return success', async () => {
  for (const override of [
    ['error'],
    [{ status: 'not_verified', reason: 'RESIDUAL_SERVICE_DATA', login_deleted: true }],
    [{ status: 'not_verified', reason: 'LOGIN_REMOVED_WITHOUT_MANAGED_INTENT', login_deleted: true }],
    [{ status: 'residue_found', reason: 'RESIDUAL_SERVICE_DATA', login_deleted: true }],
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
  // A residue reported on a completed deletion (re-asked) is cleaned once more, then verified again.
  const again = world({ lateUpload: 'removable', completeOverride: [{ status: 'residue_found', reason: 'MANAGED_STORAGE_OWNED', login_deleted: true }] });
  assert.deepEqual((await remove(again, signIn())).body, { ok: true, outcome: 'deleted' });
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

test('nothing is logged and no response carries a token, id, address, code, lease or object name', async () => {
  const logged: unknown[] = [];
  const original = { ...console };
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = (...args: unknown[]) => { logged.push(args); };
  const bodies: string[] = [];
  const tokens: string[] = [];
  const leases: string[] = [];
  try {
    const flows: [WorldOptions, 'preview' | 'withdraw' | 'delete', Record<string, unknown>?][] = [
      [{ x: 'active', apple: true, storage: [{ bucketId: 'avatars', name: 'secret-name.png' }] }, 'delete', { apple_authorization_code: APPLE_CODE }],
      [{ apple: true, rpcFailOnce: { settle_external_step: 1 } }, 'delete', { apple_authorization_code: APPLE_CODE }],
      [{ x: 'active', xRun: ['failed'] }, 'delete'],
      [{ deleteLogin: ['failed'] }, 'delete'],
      [{ lateUpload: 'stuck' }, 'delete'],
      [{ completeOverride: ['error'] }, 'delete'],
      [{ blockers: ['ADMIN_ACCOUNT'] }, 'delete'],
      [{ gate: 'blocked' }, 'delete'],
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
      if (w.state.op) leases.push(w.state.op.id);
      bodies.push(JSON.stringify(response.body));
    }
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logged, []);
  for (const body of bodies) {
    for (const secret of [USER, OTHER, EMAIL, APPLE_CODE, 'secret-name.png', 'apple-subject', 'session-', '00000000-0000-4000-8000', ...tokens, ...leases]) {
      assert.ok(!body.includes(secret), `response leaks ${secret.slice(0, 12)}: ${body}`);
    }
  }
});

test('the module itself has no logging and no direct network access', async () => {
  const source = await Deno.readTextFile(new URL('./lifecycle_logic.ts', import.meta.url));
  assert.ok(!/console\./u.test(source));
  assert.ok(!/\bfetch\(/u.test(source));
  assert.ok(!/Deno\.env/u.test(source));
  // The managed delete is reachable from exactly one place, after the managed delete intent.
  assert.equal(source.match(/deps\.deleteLogin\(/gu)?.length, 1);
  const deleteAt = source.indexOf('deps.deleteLogin(');
  const intentAt = source.indexOf("call(deps, 'begin_external_step', { ...owner, p_step: 'managed_auth_delete' })");
  assert.ok(intentAt > 0 && deleteAt > intentAt);
});
