import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCK_REASONS } from './delete_logic.ts';
import { xServiceEndOutcomeOf, xServiceEndRequest } from './x_service_end_contract.ts';

test('done only for a social_only success; unconfirmed X posts travel with it; a deleted login is never done', () => {
  assert.deepEqual(xServiceEndOutcomeOf(200, { ok: true, login_deleted: false }), { status: 'done', unconfirmedPosts: 0 });
  assert.deepEqual(xServiceEndOutcomeOf(200, { ok: true, login_deleted: false, x_posts_unconfirmed: 2 }), { status: 'done', unconfirmedPosts: 2 });
  assert.deepEqual(xServiceEndOutcomeOf(200, { ok: true, login_deleted: true }), { status: 'login_deleted' });
  for (const body of [{ ok: true }, { ok: true, login_deleted: 'no' }, { ok: true, login_deleted: false, x_posts_unconfirmed: -1 }, { ok: true, login_deleted: false, x_posts_unconfirmed: 0 }, null, [], 'ok']) {
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

test('the request is the X app\'s own social_only deletion request (no user id, no other scope)', () => {
  assert.deepEqual(xServiceEndRequest(), { confirmation: 'DELETE_MY_ACCOUNT', expected_scope: 'social_only' });
});
