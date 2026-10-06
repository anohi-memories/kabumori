import test from 'node:test';
import assert from 'node:assert/strict';
import { base64ToBase64Url, bytesToHex, isRetryableOAuthError, parseOAuthReturn } from '../src/lib/x-oauth-onboarding.ts';

const REDIRECT = 'kabumori-social://oauth-callback';

test('valid deep-link callback returns code and the exact state', () => {
  assert.deepEqual(parseOAuthReturn(`${REDIRECT}?code=abc&state=s1`, REDIRECT, 's1'), { kind: 'success', code: 'abc', state: 's1' });
});

test('state mismatch, other redirect, missing code, provider error fail closed', () => {
  assert.throws(() => parseOAuthReturn(`${REDIRECT}?code=abc&state=other`, REDIRECT, 's1'), /OAUTH_STATE_MISMATCH/u);
  assert.throws(() => parseOAuthReturn(`${REDIRECT}?code=abc`, REDIRECT, 's1'), /OAUTH_STATE_MISMATCH/u);
  assert.throws(() => parseOAuthReturn('evil-scheme://oauth-callback?code=abc&state=s1', REDIRECT, 's1'), /OAUTH_CALLBACK_REDIRECT_MISMATCH/u);
  assert.throws(() => parseOAuthReturn(`kabumori-social://other?code=abc&state=s1`, REDIRECT, 's1'), /OAUTH_CALLBACK_REDIRECT_MISMATCH/u);
  assert.throws(() => parseOAuthReturn(`${REDIRECT}?state=s1`, REDIRECT, 's1'), /OAUTH_CALLBACK_CODE_MISSING/u);
  assert.throws(() => parseOAuthReturn(`${REDIRECT}?state=s1&error=server_error`, REDIRECT, 's1'), /OAUTH_PROVIDER_RETURNED_ERROR/u);
  assert.throws(() => parseOAuthReturn('not a url', REDIRECT, 's1'), /OAUTH_CALLBACK_URL_INVALID/u);
});

test('user cancellation at X is a normal outcome, not an error', () => {
  assert.deepEqual(parseOAuthReturn(`${REDIRECT}?state=s1&error=access_denied`, REDIRECT, 's1'), { kind: 'cancelled' });
});

test('retryable classification and PKCE helpers', () => {
  assert.equal(isRetryableOAuthError({ context: { status: 503 } }), true);
  assert.equal(isRetryableOAuthError({ status: 429 }), true);
  assert.equal(isRetryableOAuthError({ name: 'FunctionsFetchError' }), true);
  assert.equal(isRetryableOAuthError({ context: { status: 400 } }), false);
  assert.equal(isRetryableOAuthError(new Error('OAUTH_STATE_MISMATCH')), false);
  assert.equal(bytesToHex(new Uint8Array([0, 15, 255])), '000fff');
  assert.equal(base64ToBase64Url('a+b/c=='), 'a-b_c');
});
