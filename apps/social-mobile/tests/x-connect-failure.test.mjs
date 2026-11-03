import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyXConnectFailure, classifyXDisconnectFailure, isRetryableOAuthError } from '../src/lib/x-oauth-onboarding.ts';

// supabase-js FunctionsHttpError carries the Edge response as `context`
const edgeError = (status) => ({ name: 'FunctionsHttpError', context: { status } });

test('connect failures: x-oauth-connect-user statuses map to what the person can do', () => {
  assert.equal(classifyXConnectFailure(edgeError(401)), 'session_required');
  assert.equal(classifyXConnectFailure(edgeError(409)), 'workspace_blocked');
  assert.equal(classifyXConnectFailure(edgeError(400)), 'restart');
  assert.equal(classifyXConnectFailure(edgeError(403)), 'restart');
  assert.equal(classifyXConnectFailure(edgeError(503)), 'retryable');
  assert.equal(classifyXConnectFailure(edgeError(429)), 'retryable');
  assert.equal(classifyXConnectFailure({ name: 'FunctionsFetchError' }), 'retryable');
  assert.equal(classifyXConnectFailure(new Error('OAUTH_STATE_MISMATCH')), 'restart');
  assert.equal(classifyXConnectFailure(null), 'restart');
});

test('connect failures: the retry rule itself is unchanged', () => {
  assert.equal(isRetryableOAuthError(edgeError(401)), false);
  assert.equal(isRetryableOAuthError(edgeError(409)), false);
  assert.equal(isRetryableOAuthError({ status: 502 }), true);
});

test('disconnect failures: classified by the RPC code and PostgREST status', () => {
  assert.equal(classifyXDisconnectFailure('SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE', 400), 'session_required');
  assert.equal(classifyXDisconnectFailure('SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED', 400), 'session_required');
  assert.equal(classifyXDisconnectFailure('JWT expired', 401), 'session_required');
  assert.equal(classifyXDisconnectFailure('OWN_WORKSPACE_CONFLICT', 400), 'workspace_blocked');
  assert.equal(classifyXDisconnectFailure('WORKSPACE_OWNER_UNKNOWN', 400), 'workspace_blocked');
  assert.equal(classifyXDisconnectFailure('X_DISCONNECT_NOT_ENABLED', 400), 'restart');
  assert.equal(classifyXDisconnectFailure('X_CONNECTION_NOT_FOUND', 400), 'restart');
  assert.equal(classifyXDisconnectFailure('anything', 503), 'retryable');
});
