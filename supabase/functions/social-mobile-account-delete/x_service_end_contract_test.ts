import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCK_REASONS } from './delete_logic.ts';
import { createHandler } from './http.ts';
import { X_UNCONFIRMED_ACK_RPC, xServiceEndOutcomeOf, xServiceEndRequest, xUnconfirmedAckArgs, xUnconfirmedAckOutcomeOf } from './x_service_end_contract.ts';

const SA = 'a'.repeat(64);

test('done only for a social_only success; unconfirmed X posts travel with it; a deleted login is never done', () => {
  assert.deepEqual(xServiceEndOutcomeOf(200, { ok: true, login_deleted: false }), { status: 'done', unconfirmedPosts: 0, unconfirmedSnapshot: null });
  assert.deepEqual(xServiceEndOutcomeOf(200, { ok: true, login_deleted: false, x_posts_unconfirmed: 2, x_unconfirmed_snapshot: SA }), { status: 'done', unconfirmedPosts: 2, unconfirmedSnapshot: SA });
  assert.deepEqual(xServiceEndOutcomeOf(200, { ok: true, login_deleted: true }), { status: 'login_deleted' });
  for (const body of [{ ok: true }, { ok: true, login_deleted: 'no' }, { ok: true, login_deleted: false, x_posts_unconfirmed: -1, x_unconfirmed_snapshot: SA },
    { ok: true, login_deleted: false, x_posts_unconfirmed: 0, x_unconfirmed_snapshot: SA },
    // R1a: a count without the snapshot it belongs to (or the reverse, or a malformed one) is never a done.
    { ok: true, login_deleted: false, x_posts_unconfirmed: 2 }, { ok: true, login_deleted: false, x_unconfirmed_snapshot: SA },
    { ok: true, login_deleted: false, x_posts_unconfirmed: 2, x_unconfirmed_snapshot: 'A'.repeat(64) }, null, [], 'ok']) {
    assert.deepEqual(xServiceEndOutcomeOf(200, body), { status: 'failed' }, JSON.stringify(body));
  }
  assert.deepEqual(xServiceEndOutcomeOf(201, { ok: true, login_deleted: false }), { status: 'failed' });
});

test('typed blocks keep their reason; only in-flight / refresh / non-X are retryable; an unknown reason is a failure', () => {
  for (const reason of BLOCK_REASONS) {
    const outcome = xServiceEndOutcomeOf(409, { ok: false, error: `DELETION_BLOCKED_${reason}` });
    assert.equal(outcome.status, 'blocked', reason);
    assert.equal(outcome.status === 'blocked' && outcome.reason, reason);
    assert.equal(outcome.status === 'blocked' && outcome.retryable, ['POSTING_IN_PROGRESS', 'CREDENTIAL_REFRESH_IN_PROGRESS', 'NON_X_ACCOUNT_PRESENT'].includes(reason), reason);
  }
  assert.deepEqual(xServiceEndOutcomeOf(409, { ok: false, error: 'DELETION_BLOCKED_SOMETHING_NEW' }), { status: 'failed' });
});

test('a remote revoke that X did not confirm, changed material or an unfinished finalize need reconciliation, never success', () => {
  for (const reason of ['X_REVOKE_FAILED', 'CREDENTIALS_CHANGED', 'FINALIZE_FAILED'] as const) {
    assert.deepEqual(xServiceEndOutcomeOf(reason === 'X_REVOKE_FAILED' ? 502 : 500, { ok: false, error: reason }), { status: 'reconciliation_required', reason });
  }
  assert.deepEqual(xServiceEndOutcomeOf(409, { ok: false, error: 'DELETION_OPERATOR_REQUIRED' }), { status: 'operator_required' });
  assert.deepEqual(xServiceEndOutcomeOf(409, { ok: false, error: 'DELETION_IN_PROGRESS' }), { status: 'in_progress' });
  assert.deepEqual(xServiceEndOutcomeOf(409, { ok: false, error: 'SCOPE_CHANGED' }), { status: 'scope_refused' });
  assert.deepEqual(xServiceEndOutcomeOf(403, { ok: false, error: 'REAUTH_REQUIRED' }), { status: 'auth_required' });
  assert.deepEqual(xServiceEndOutcomeOf(500, { ok: false, error: 'FAILED' }), { status: 'failed' });
  assert.deepEqual(xServiceEndOutcomeOf(502, null), { status: 'failed' });
});

test('the request is the X app\'s own complete social_only delete request (no user id, no other scope)', () => {
  assert.deepEqual(xServiceEndRequest(), { action: 'delete', confirmation: 'DELETE_MY_ACCOUNT', expected_scope: 'social_only' });
});

// R2 (J3 V3): the exported request must reach the REAL router (createHandler), not only the pure deletion handler.
// MOCK_ONLY: Auth and PostgREST answers are canned; no network.
const FULL = { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', X_CLIENT_ID: 'x-id', X_CLIENT_SECRET: 'x-secret' };
const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const callerToken = (sub: string) => `${b64url({ alg: 'none' })}.${b64url({ sub, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 5 }] })}.sig`;

function routedDeletion(body: unknown) {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get('Authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/auth/v1/user')) return Promise.resolve(Response.json({ id: 'user-1', identities: [{ provider: 'email', id: 'user-1' }] }));
    if (url.endsWith('/rpc/social_mobile_account_deletion_preview')) return Promise.resolve(Response.json({ state: 'none', scope: 'social_only', apple_revoked: false }));
    if (url.endsWith('/rpc/social_mobile_account_deletion_x_precheck')) return Promise.resolve(Response.json({ non_x_accounts: 0, x_posts_unconfirmed: 0, x_unconfirmed_snapshot: null }));
    if (url.endsWith('/rpc/social_mobile_account_deletion_record')) return Promise.resolve(Response.json(null));
    if (url.endsWith('/rpc/social_mobile_account_deletion_acquire')) return Promise.resolve(Response.json({ status: 'blocked', reason: 'SHARED_WORKSPACE' }));
    return Promise.resolve(new Response(null, { status: 500 }));
  };
  const request = new Request('https://fn.example/social-mobile-account-delete', {
    method: 'POST', headers: { Authorization: `Bearer ${callerToken('user-1')}` }, body: JSON.stringify(body),
  });
  return createHandler({ get: (name: string) => (FULL as Record<string, string>)[name] }, fetchImpl)(request)
    .then(async (response) => ({ status: response.status, json: await response.json(), calls }));
}

test('R2: the exported request reaches Auth and the saga through the real router; identity is the bearer token only', async () => {
  const routed = await routedDeletion({ ...xServiceEndRequest(), user_id: 'victim', p_user_id: 'victim' });
  assert.deepEqual(routed.json, { ok: false, error: 'DELETION_BLOCKED_SHARED_WORKSPACE' });
  assert.equal(routed.status, 409);
  const auth = routed.calls.find((call) => call.url.endsWith('/auth/v1/user'));
  assert.equal(auth?.auth, `Bearer ${callerToken('user-1')}`);
  const rpcUsers = routed.calls.filter((call) => call.url.includes('/rpc/')).map((call) => (call.body as Record<string, unknown>).p_user_id);
  assert.ok(rpcUsers.length >= 3);
  assert.ok(rpcUsers.every((user) => user === 'user-1'), JSON.stringify(rpcUsers));
  assert.deepEqual(xServiceEndOutcomeOf(routed.status, routed.json), { status: 'blocked', reason: 'SHARED_WORKSPACE', retryable: false });
});

test('R2: a body without action: delete (the old exported shape) or with another action is refused before Auth', async () => {
  const { action: _action, ...withoutAction } = xServiceEndRequest();
  for (const body of [withoutAction, { ...withoutAction, action: 'Delete' }, { ...withoutAction, action: 'delete_all' }, { ...withoutAction, action: ['delete'] }]) {
    const routed = await routedDeletion(body);
    assert.equal(routed.status, 400, JSON.stringify(body));
    assert.deepEqual(routed.json, { ok: false, error: 'ACTION_REQUIRED' });
    assert.equal(routed.calls.length, 0, JSON.stringify(body));
  }
});

test('R1a: the ACK names the exact snapshot (never a bare count); every ACK answer is typed and only acknowledged clears', () => {
  assert.equal(X_UNCONFIRMED_ACK_RPC, 'social_mobile_account_deletion_x_unconfirmed_ack');
  assert.deepEqual(xUnconfirmedAckArgs('user-1', SA), { p_user_id: 'user-1', p_snapshot: SA });
  for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), `${SA}0`]) assert.throws(() => xUnconfirmedAckArgs('user-1', bad), /X_UNCONFIRMED_SNAPSHOT_INVALID/u);
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'acknowledged', replay: false, cleared: 2 }), { status: 'acknowledged', cleared: 2, replay: false });
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'acknowledged', replay: true, cleared: 1 }), { status: 'acknowledged', cleared: 1, replay: true });
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'snapshot_changed', x_posts_unconfirmed: 1, x_unconfirmed_snapshot: SA, reconciliation_required: true }), { status: 'snapshot_changed', count: 1, snapshot: SA });
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'snapshot_changed', x_posts_unconfirmed: 0, x_unconfirmed_snapshot: null }), { status: 'snapshot_changed', count: 0, snapshot: null });
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'deletion_in_progress' }), { status: 'deletion_in_progress' });
  assert.deepEqual(xUnconfirmedAckOutcomeOf({ status: 'snapshot_required' }), { status: 'snapshot_required' });
  for (const bad of [null, {}, { status: 'acknowledged' }, { status: 'acknowledged', cleared: 0, replay: false }, { status: 'acknowledged', cleared: 1 },
    { status: 'snapshot_changed', x_posts_unconfirmed: 1, x_unconfirmed_snapshot: null }, { status: 'snapshot_changed', x_posts_unconfirmed: 0, x_unconfirmed_snapshot: SA },
    { status: 'cleared' }, 'acknowledged']) {
    assert.deepEqual(xUnconfirmedAckOutcomeOf(bad), { status: 'failed' }, JSON.stringify(bad));
  }
});
