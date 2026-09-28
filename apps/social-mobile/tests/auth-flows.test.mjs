import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_CALLBACK_URL, POSTING_CALLBACK_URL, authFlowMessage, classifyBrowserResult, classifySignUp, isAppleCancel,
  parseAuthCallbackUrl, providerAvailability, shouldShowNewAccountNotice, validateNewPassword,
} from '../src/domain/auth-flows.ts';

test('auth callback: PKCE code, e-mail token hash, provider error, from query or fragment', () => {
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?code=abc-123`), { kind: 'code', code: 'abc-123' });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?token_hash=h1&type=recovery`), { kind: 'token_hash', tokenHash: 'h1', type: 'recovery' });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?token_hash=h1&type=signup`), { kind: 'token_hash', tokenHash: 'h1', type: 'signup' });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}#error=access_denied&error_code=access_denied`), { kind: 'error', errorCode: 'access_denied' });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?error_code=otp_expired&error_description=Email+link+is+invalid`), { kind: 'error', errorCode: 'otp_expired' });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?error=<script>`), { kind: 'error', errorCode: 'unknown_error' });
});

test('auth callback rejects the posting callback, other schemes/paths, and junk', () => {
  assert.deepEqual(parseAuthCallbackUrl(`${POSTING_CALLBACK_URL}?code=abc&state=s`), { kind: 'invalid' });
  assert.deepEqual(parseAuthCallbackUrl('evil://auth-callback?code=abc'), { kind: 'invalid' });
  assert.deepEqual(parseAuthCallbackUrl('https://example.com/auth-callback?code=abc'), { kind: 'invalid' });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?token_hash=h1&type=admin`), { kind: 'invalid' });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?code=a%20b`), { kind: 'invalid' });
  assert.deepEqual(parseAuthCallbackUrl(AUTH_CALLBACK_URL), { kind: 'invalid' });
  assert.deepEqual(parseAuthCallbackUrl('not a url'), { kind: 'invalid' });
});

test('email sign-up states never reveal whether an address exists', () => {
  assert.equal(classifySignUp({ session: { access_token: 'x' }, user: { identities: [{}] } }), 'signed_in');
  assert.equal(classifySignUp({ session: null, user: { identities: [{}] } }), 'confirmation_sent');
  assert.equal(classifySignUp({ session: null, user: { identities: [] } }), 'check_inbox_or_sign_in');
  assert.equal(classifySignUp({ session: null, user: null }), 'confirmation_sent');
});

test('browser (X / Google / Apple web) success, cancel and error contracts', () => {
  assert.deepEqual(classifyBrowserResult({ type: 'success', url: `${AUTH_CALLBACK_URL}?code=c` }), { kind: 'callback', url: `${AUTH_CALLBACK_URL}?code=c` });
  assert.deepEqual(classifyBrowserResult({ type: 'cancel' }), { kind: 'cancelled' });
  assert.deepEqual(classifyBrowserResult({ type: 'dismiss' }), { kind: 'cancelled' });
  assert.deepEqual(classifyBrowserResult({ type: 'locked' }), { kind: 'failed' });
  assert.deepEqual(classifyBrowserResult({ type: 'success' }), { kind: 'failed' });
});

test('Apple native cancel vs error', () => {
  assert.equal(isAppleCancel({ code: 'ERR_REQUEST_CANCELED' }), true);
  assert.equal(isAppleCancel({ code: 'ERR_REQUEST_FAILED' }), false);
  assert.equal(isAppleCancel(new Error('boom')), false);
});

test('provider availability comes only from the project settings; unknown = nothing enabled', () => {
  assert.deepEqual(providerAvailability({ external: { x: true, apple: false, google: true, email: true }, disable_signup: false }),
    { x: true, apple: false, google: true, email: true, signupDisabled: false });
  assert.deepEqual(providerAvailability({ external: { twitter: true } }), { x: false, apple: false, google: false, email: false, signupDisabled: false });
  for (const bad of [null, 'x', {}, { external: null }]) {
    assert.deepEqual(providerAvailability(bad), { x: false, apple: false, google: false, email: false, signupDisabled: true });
  }
});

test('fixed messages: linking conflicts, disabled providers, recovery; unknown codes generic', () => {
  assert.match(authFlowMessage('identity_already_exists'), /別のアカウントで使われています/u);
  assert.match(authFlowMessage('manual_linking_disabled'), /まだ有効になっていません/u);
  assert.match(authFlowMessage('provider_disabled'), /まだ有効になっていません/u);
  assert.match(authFlowMessage('otp_expired'), /有効期限/u);
  assert.equal(authFlowMessage('Database error: secret'), authFlowMessage(null));
});

test('new password validation', () => {
  assert.equal(validateNewPassword('short', 'short').ok, false);
  assert.equal(validateNewPassword('longenough1', 'different1').ok, false);
  assert.equal(validateNewPassword('a'.repeat(73), 'a'.repeat(73)).ok, false);
  assert.deepEqual(validateNewPassword('longenough1', 'longenough1'), { ok: true });
});

test('duplicate-account guard: a just-created social account without workspace is shown before anything is created', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const base = { identities: [{ provider: 'x' }], userCreatedAt: '2026-09-28T11:55:00Z', hasWorkspace: false, acknowledged: false, now };
  assert.equal(shouldShowNewAccountNotice(base), true);
  assert.equal(shouldShowNewAccountNotice({ ...base, identities: [{ provider: 'google' }] }), true);
  assert.equal(shouldShowNewAccountNotice({ ...base, identities: [{ provider: 'email' }] }), false, 'e-mail sign-up is explicit');
  assert.equal(shouldShowNewAccountNotice({ ...base, identities: [{ provider: 'x' }, { provider: 'email' }] }), false, 'already linked');
  assert.equal(shouldShowNewAccountNotice({ ...base, hasWorkspace: true }), false, 'existing user');
  assert.equal(shouldShowNewAccountNotice({ ...base, acknowledged: true }), false);
  assert.equal(shouldShowNewAccountNotice({ ...base, userCreatedAt: '2026-09-20T00:00:00Z' }), false, 'old account');
  assert.equal(shouldShowNewAccountNotice({ ...base, userCreatedAt: null }), false);
});
