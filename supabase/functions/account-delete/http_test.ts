// The HTTP layer over a stubbed network: routing (the legacy no-body call deletes nothing), which
// credential goes where, the X saga adapter contract, and that no server message or secret leaks.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIRMATION as X_DELETE_CONFIRMATION } from '../social-mobile-account-delete/delete_logic.ts';
import { createHandler, X_DELETION_FUNCTION, xOutcomeOf } from './http.ts';
import { DELETE_CONFIRMATION, WITHDRAW_CONFIRMATION } from './lifecycle_logic.ts';

const URL_ = 'https://fixture.supabase.co';
const ANON = 'fixture-anon-key';
const SERVICE = 'fixture-service-role-key';
const USER = '11111111-1111-4111-8111-111111111111';
const OP = '00000000-0000-4000-8000-000000000001';
const XOP = '00000000-0000-4000-8000-000000000002';
const LEASE = '00000000-0000-4000-8000-000000000003';
const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const TOKEN = `${b64({ alg: 'HS256' })}.${b64({ sub: USER, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 30 }] })}.sig`;
const env = (values: Record<string, string> = { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE }) =>
  ({ get: (name: string) => values[name] });

type Seen = { url: string; method: string; credential: 'person' | 'service' | 'none'; body: unknown };

/** A fake network for one person with Kabumori and X, one Storage object, ending in a verified deletion. */
function network(overrides: Record<string, (seen: Seen) => Response> = {}) {
  const seen: Seen[] = [];
  let eligibilityCalls = 0;
  let storageCalls = 0;
  const rpc: Record<string, () => unknown> = {
    common_account_deletion_eligibility: () => (++eligibilityCalls === 1
      ? { account_status: 'active', lifecycle_version: 5, services: [{ service_key: 'kabumori', status: 'active' }, { service_key: 'x_autopost', status: 'active' }], blockers: [], required_checkpoints: ['session_revocation', 'storage_cleanup'], managed_ownership: [], operation: null }
      : { account_status: 'deleting', lifecycle_version: 9, services: [{ service_key: 'kabumori', status: 'ended' }, { service_key: 'x_autopost', status: 'ended' }], blockers: [], required_checkpoints: ['session_revocation', 'storage_cleanup'], managed_ownership: [], operation: { operation_id: OP, step: 'cleanup', recorded_checkpoints: [] } }),
    begin_common_account_deletion: () => ({ status: 'started', operation_id: OP, lifecycle_version: 6 }),
    begin_service_deletion: () => ({ status: 'started', operation_id: XOP }),
    finish_service_deletion: () => ({ status: 'ended' }),
    withdraw_kabumori_service: () => ({ status: 'ended' }),
    common_account_deletion_release_gate: () => ({ managed_auth_delete: { state: 'open', reason: 'TEST' } }),
    claim_common_account_deletion: () => ({ status: 'acquired', lease: LEASE, fence: 1, recorded_checkpoints: [] }),
    renew_common_account_deletion_claim: () => ({ status: 'owned', fence: 1 }),
    release_common_account_deletion_claim: () => ({ status: 'released' }),
    set_owned_common_account_deletion_checkpoint: () => ({ status: 'recorded' }),
    begin_common_account_deletion_external_step: () => ({ status: 'owned', fence: 1 }),
    settle_common_account_deletion_external_step: () => ({ status: 'cleared' }),
    common_account_deletion_storage_objects: () => (++storageCalls === 1
      ? { status: 'ok', objects: [{ bucket_id: 'avatars', name: 'p/a.png' }], more: false, buckets_owned: false }
      : { status: 'ok', objects: [], more: false, buckets_owned: false }),
    prepare_owned_common_account_auth_delete: () => ({ status: 'ready_for_managed_auth_delete', operation_id: OP, login_deleted: false }),
    complete_common_account_deletion: () => ({ status: 'completed', operation_id: OP, login_deleted: true }),
    record_common_account_deletion_error: () => ({ status: 'recorded' }),
  };
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const authorization = headers.get('Authorization');
    const credential = authorization === `Bearer ${TOKEN}` && headers.get('apikey') === ANON ? 'person'
      : authorization === `Bearer ${SERVICE}` && headers.get('apikey') === SERVICE ? 'service' : 'none';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const entry: Seen = { url: input, method: init.method ?? 'GET', credential, body };
    seen.push(entry);
    const path = input.slice(URL_.length);
    for (const [prefix, respond] of Object.entries(overrides)) if (path.startsWith(prefix)) return respond(entry);
    if (path === '/auth/v1/user') return Response.json({ id: USER, email: 'person@example.invalid', identities: [{ provider: 'email', id: 'identity-1' }] });
    if (path === '/auth/v1/logout?scope=global') return new Response(null, { status: 204 });
    if (path === `/functions/v1/${X_DELETION_FUNCTION}`) {
      return body?.action === 'preview'
        ? Response.json({ ok: true, scope: 'social_only', state: 'none', apple_supported: true, apple_code_required: false })
        : Response.json({ ok: true, login_deleted: false });
    }
    if (path.startsWith('/rest/v1/rpc/')) {
      const answer = rpc[path.slice('/rest/v1/rpc/'.length)];
      return answer ? Response.json(answer()) : Response.json({ message: 'unknown function' }, { status: 404 });
    }
    if (path.startsWith('/storage/v1/object/')) return Response.json([{ name: 'p/a.png' }]);
    if (path.startsWith('/auth/v1/admin/users/')) return Response.json({});
    return Response.json({ message: 'not in fixture' }, { status: 404 });
  };
  return { seen, fetchImpl };
}

const post = (body: unknown, token: string | null = TOKEN) =>
  new Request('https://edge.fixture/account-delete', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('the legacy call (POST, no body) and any unknown action delete nothing and reach nothing', async () => {
  for (const body of [undefined, {}, { action: 'delete' }, { action: 'DELETE_COMMON_ACCOUNT' }, { confirmation: DELETE_CONFIRMATION }, 'delete']) {
    const { seen, fetchImpl } = network();
    const response = await createHandler(env(), fetchImpl)(post(body));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'ACTION_REQUIRED' });
    assert.deepEqual(seen, [], `no request for ${JSON.stringify(body)}`);
  }
  const { seen, fetchImpl } = network();
  const notPost = await createHandler(env(), fetchImpl)(new Request('https://edge.fixture/account-delete', { method: 'GET' }));
  assert.equal(notPost.status, 405);
  const missing = await createHandler(env({ SUPABASE_URL: URL_ }), fetchImpl)(post({ action: 'preview' }));
  assert.deepEqual([missing.status, await missing.json()], [500, { ok: false, error: 'FAILED' }]);
  assert.deepEqual(seen, []);
});

test('delete over the network: each credential goes only where it belongs, and the login is removed last', async () => {
  const { seen, fetchImpl } = network();
  const response = await createHandler(env(), fetchImpl)(post({ action: 'delete_common_account', confirmation: DELETE_CONFIRMATION, expected_lifecycle_version: 5 }));
  assert.deepEqual([response.status, await response.json()], [200, { ok: true, outcome: 'deleted' }]);
  const path = (s: Seen) => s.url.slice(URL_.length);
  for (const s of seen) {
    const p = path(s);
    if (p === '/auth/v1/user' || p === '/auth/v1/logout?scope=global' || p === `/functions/v1/${X_DELETION_FUNCTION}`) {
      assert.equal(s.credential, 'person', p);
    } else {
      assert.ok(p.startsWith('/rest/v1/rpc/') || p.startsWith('/storage/v1/object/') || p.startsWith('/auth/v1/admin/users/'), p);
      assert.equal(s.credential, 'service', p);
    }
    if (s.body && typeof s.body === 'object' && 'p_user_id' in s.body) assert.equal((s.body as Record<string, unknown>).p_user_id, USER);
  }
  const xRun = seen.find((s) => path(s) === `/functions/v1/${X_DELETION_FUNCTION}` && (s.body as Record<string, unknown>)?.action === 'delete');
  assert.deepEqual(xRun?.body, { action: 'delete', confirmation: X_DELETE_CONFIRMATION, expected_scope: 'social_only' });
  const storageDelete = seen.find((s) => path(s).startsWith('/storage/v1/object/'));
  assert.deepEqual([storageDelete?.method, path(storageDelete!), storageDelete?.body], ['DELETE', '/storage/v1/object/avatars', { prefixes: ['p/a.png'] }]);
  const admin = seen.filter((s) => path(s).startsWith('/auth/v1/admin/users/'));
  assert.deepEqual(admin.map((s) => [s.method, path(s)]), [['DELETE', `/auth/v1/admin/users/${USER}`]]);
  const adminAt = seen.indexOf(admin[0]);
  const prepares = seen.map((s, i) => (path(s) === '/rest/v1/rpc/prepare_owned_common_account_auth_delete' ? i : -1)).filter((i) => i >= 0);
  assert.equal(prepares.length, 2);
  const intentAt = seen.findIndex((s) => path(s) === '/rest/v1/rpc/begin_common_account_deletion_external_step'
    && (s.body as Record<string, unknown>).p_step === 'managed_auth_delete');
  assert.ok(prepares.every((i) => i < intentAt) && intentAt < adminAt, 'two ready answers, then the recorded intent, precede the managed delete');
  const owned = seen.filter((s) => (s.body as Record<string, unknown> | null)?.p_lease !== undefined);
  assert.ok(owned.length >= 8 && owned.every((s) => (s.body as Record<string, unknown>).p_lease === LEASE), 'every owned step carries the lease');
  assert.ok(seen.findIndex((s) => path(s) === '/rest/v1/rpc/claim_common_account_deletion') < seen.findIndex((s) => path(s).startsWith(`/functions/v1/`) && (s.body as Record<string, unknown>)?.action === 'delete'),
    'owned before the first external action');
  assert.equal(path(seen.at(-2)!), '/rest/v1/rpc/complete_common_account_deletion', 'the read-back is the last step');
  assert.equal(path(seen.at(-1)!), '/rest/v1/rpc/release_common_account_deletion_claim', 'then ownership is given back');
  // The unowned Phase 1 checkpoint / readiness calls and the operator reconciliation are never used here.
  for (const unowned of ['record_common_account_deletion_checkpoint', 'clear_common_account_deletion_checkpoint',
    'prepare_common_account_auth_delete', 'resolve_common_account_deletion_external_step']) {
    assert.ok(!seen.some((s) => path(s) === `/rest/v1/rpc/${unowned}`), unowned);
  }
  const logoutAt = seen.findIndex((s) => path(s) === '/auth/v1/logout?scope=global');
  const xRunAt = seen.indexOf(xRun!);
  assert.ok(xRunAt < logoutAt, 'the X saga still has the person\'s session when it runs');
});

test('a server error message never reaches the client, and no response carries a credential', async () => {
  const leaky = () => Response.json({ message: 'duplicate key person@example.invalid 11111111-1111-4111-8111-111111111111' }, { status: 500 });
  for (const action of ['preview', 'withdraw_kabumori', 'delete_common_account']) {
    const { fetchImpl } = network({ '/rest/v1/rpc/': leaky });
    const response = await createHandler(env(), fetchImpl)(post({ action, confirmation: action === 'withdraw_kabumori' ? WITHDRAW_CONFIRMATION : DELETE_CONFIRMATION, expected_lifecycle_version: 5 }));
    const text = await response.text();
    assert.equal(JSON.parse(text).ok, false);
    for (const secret of ['person@example.invalid', USER, TOKEN, SERVICE, ANON, 'duplicate key']) assert.ok(!text.includes(secret), `${action} leaks ${secret.slice(0, 10)}`);
  }
});

test('an Auth Admin failure is checked by reading the login back; a 404 is verified, not assumed', async () => {
  const failing = network({ '/auth/v1/admin/users/': (s) => (s.method === 'DELETE' ? new Response('{}', { status: 500 }) : Response.json({ id: USER })) });
  const failed = await createHandler(env(), failing.fetchImpl)(post({ action: 'delete_common_account', confirmation: DELETE_CONFIRMATION, expected_lifecycle_version: 5 }));
  assert.deepEqual([failed.status, await failed.json()], [502, { ok: false, error: 'AUTH_DELETE_FAILED', sessions_revoked: true }]);
  assert.deepEqual(failing.seen.filter((s) => s.url.includes('/admin/users/')).map((s) => s.method), ['DELETE', 'GET']);
  const settled = failing.seen.find((s) => s.url.endsWith('/rpc/settle_common_account_deletion_external_step'));
  assert.deepEqual([(settled?.body as Record<string, unknown>)?.p_step, (settled?.body as Record<string, unknown>)?.p_outcome], ['managed_auth_delete', 'failed']);
  const gone = network({ '/auth/v1/admin/users/': () => new Response('{}', { status: 404 }) });
  const deleted = await createHandler(env(), gone.fetchImpl)(post({ action: 'delete_common_account', confirmation: DELETE_CONFIRMATION, expected_lifecycle_version: 5 }));
  assert.deepEqual(await deleted.json(), { ok: true, outcome: 'deleted' });
  assert.ok(gone.seen.some((s) => s.url.endsWith('/rpc/complete_common_account_deletion')));
});

test('the X saga adapter maps only the saga\'s fixed answers, and anything unknown is a failure', () => {
  assert.equal(xOutcomeOf(200, { ok: true, login_deleted: false }), 'done');
  assert.equal(xOutcomeOf(200, { ok: true, login_deleted: true }), 'login_deleted');
  assert.equal(xOutcomeOf(200, { ok: true }), 'failed');
  assert.equal(xOutcomeOf(500, { ok: true, login_deleted: false }), 'failed');
  assert.equal(xOutcomeOf(409, { ok: false, error: 'DELETION_IN_PROGRESS' }), 'in_progress');
  assert.equal(xOutcomeOf(409, { ok: false, error: 'SCOPE_CHANGED' }), 'scope_refused');
  assert.equal(xOutcomeOf(400, { ok: false, error: 'SCOPE_REQUIRED' }), 'scope_refused');
  assert.equal(xOutcomeOf(409, { ok: false, error: 'DELETION_BLOCKED_ADMIN_ACCOUNT' }), 'blocked');
  assert.equal(xOutcomeOf(409, { ok: false, error: 'DELETION_OPERATOR_REQUIRED' }), 'blocked');
  for (const error of ['X_REVOKE_FAILED', 'FINALIZE_FAILED', 'REAUTH_REQUIRED', 'AUTH_REQUIRED', 'FAILED', 'SOMETHING_NEW']) {
    assert.equal(xOutcomeOf(500, { ok: false, error }), 'failed', error);
  }
  assert.equal(xOutcomeOf(404, null), 'failed', 'the X function is not deployed');
});

test('a blocked release gate refuses a deletion before any write, over the network too', async () => {
  const { seen, fetchImpl } = network({ '/rest/v1/rpc/common_account_deletion_release_gate': () => Response.json({ managed_auth_delete: { state: 'blocked', reason: 'IDENTITY_CHANGE_FENCE_MISSING' } }) });
  const response = await createHandler(env(), fetchImpl)(post({ action: 'delete_common_account', confirmation: DELETE_CONFIRMATION, expected_lifecycle_version: 5 }));
  assert.deepEqual([response.status, await response.json()], [409, { ok: false, error: 'COMMON_ACCOUNT_DELETION_UNAVAILABLE' }]);
  assert.deepEqual(seen.map((s) => s.url.slice(URL_.length)), ['/auth/v1/user', '/rest/v1/rpc/common_account_deletion_release_gate']);
});

test('withdraw over the network touches only the Kabumori withdrawal', async () => {
  const { seen, fetchImpl } = network();
  const response = await createHandler(env(), fetchImpl)(post({ action: 'withdraw_kabumori', confirmation: WITHDRAW_CONFIRMATION }));
  assert.deepEqual(await response.json(), { ok: true, outcome: 'ended' });
  assert.deepEqual(seen.map((s) => s.url.slice(URL_.length)), [
    '/auth/v1/user', '/rest/v1/rpc/common_account_deletion_eligibility', '/rest/v1/rpc/withdraw_kabumori_service',
  ]);
});
