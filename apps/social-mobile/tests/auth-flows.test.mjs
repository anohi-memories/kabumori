import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_CALLBACK_URL, POSTING_CALLBACK_URL, SIGN_UP_CHECK_EMAIL_MESSAGE, authFlowMessage, classifyBrowserResult, classifySignUp,
  emailCapabilities, isAllowedLinkUrl, isAllowedSignInUrl, isAppleCancel, parseAuthCallbackUrl, parseAuthSettings,
  parseConfiguredProviders, providerReadiness, shouldShowNewAccountNotice, signUpErrorIsNeutral, validateNewPassword,
} from '../src/domain/auth-flows.ts';
import { bindRecovery, nextRecoveryBinding, recoveryMatches } from '../src/domain/recovery-binding.ts';
import { inputForCurrentUser } from '../src/domain/onboarding.ts';

const FLOW = 'a1b2c3d4e5f60718';
const HOST = 'proj.supabase.co';

test('callback: PKCE code with its flow id, e-mail token hash, provider error', () => {
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW}&code=abc-123`), { kind: 'code', code: 'abc-123', flowId: FLOW });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?token_hash=h1&type=recovery&sb_flow_id=${FLOW}`), { kind: 'token_hash', tokenHash: 'h1', type: 'recovery', flowId: FLOW });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?token_hash=h1&type=signup`), { kind: 'token_hash', tokenHash: 'h1', type: 'signup', flowId: null });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW}#error=access_denied&error_code=access_denied&error_description=x`), { kind: 'error', errorCode: 'access_denied', flowId: FLOW });
  assert.deepEqual(parseAuthCallbackUrl(`${AUTH_CALLBACK_URL}?error=<script>`), { kind: 'error', errorCode: 'unknown_error', flowId: null });
});

test('callback: exact authority only — no userinfo, no port, no other path/scheme/host, not the posting callback', () => {
  for (const url of [
    `kabumori-social://user:pw@auth-callback?sb_flow_id=${FLOW}&code=c`,
    `kabumori-social://evil@auth-callback?sb_flow_id=${FLOW}&code=c`,
    `kabumori-social://auth-callback:8080?sb_flow_id=${FLOW}&code=c`,
    `kabumori-social://auth-callback/extra?sb_flow_id=${FLOW}&code=c`,
    `${POSTING_CALLBACK_URL}?code=abc&state=s`,
    `evil://auth-callback?sb_flow_id=${FLOW}&code=abc`,
    `https://example.com/auth-callback?sb_flow_id=${FLOW}&code=abc`,
    'not a url',
  ]) assert.deepEqual(parseAuthCallbackUrl(url), { kind: 'invalid' }, url);
});

test('callback: duplicates, conflicts, unknown/implicit fields, missing flow id all fail closed', () => {
  for (const url of [
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW}&code=a&code=b`,
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW}&code=a#code=b`,
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW}&code=a#sb_flow_id=${FLOW}`,
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW}&sb_flow_id=${FLOW}x&code=a`,
    `${AUTH_CALLBACK_URL}?token_hash=h&type=recovery&type=signup`,
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW}&code=a&token_hash=h&type=recovery`,
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW}&code=a&error=access_denied`,
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW}&code=a&type=recovery`,
    `${AUTH_CALLBACK_URL}#access_token=t&refresh_token=r&type=recovery`,
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW}&code=a&state=x`,
    `${AUTH_CALLBACK_URL}?code=a`,
    `${AUTH_CALLBACK_URL}?sb_flow_id=short&code=a`,
    `${AUTH_CALLBACK_URL}?sb_flow_id=${'x'.repeat(65)}&code=a`,
    `${AUTH_CALLBACK_URL}?sb_flow_id=${FLOW}&code=a%20b`,
    `${AUTH_CALLBACK_URL}?token_hash=h&type=admin`,
    `${AUTH_CALLBACK_URL}?type=recovery`,
    AUTH_CALLBACK_URL,
  ]) assert.deepEqual(parseAuthCallbackUrl(url), { kind: 'invalid' }, url);
});

test('browser destinations: sign-in only at the project authorize endpoint; linking only at the provider with our Supabase callback', () => {
  assert.equal(isAllowedSignInUrl(`https://${HOST}/auth/v1/authorize?provider=x`, HOST), true);
  for (const url of [`https://${HOST}/auth/v1/user`, `http://${HOST}/auth/v1/authorize`, `https://evil.example/auth/v1/authorize`,
    `https://user@${HOST}/auth/v1/authorize`, `https://${HOST}:444/auth/v1/authorize`]) assert.equal(isAllowedSignInUrl(url, HOST), false, url);
  const cb = encodeURIComponent(`https://${HOST}/auth/v1/callback`);
  assert.equal(isAllowedLinkUrl(`https://accounts.google.com/o/oauth2/v2/auth?client_id=c&redirect_uri=${cb}&state=s`, 'google', HOST), true);
  assert.equal(isAllowedLinkUrl(`https://x.com/i/oauth2/authorize?redirect_uri=${cb}`, 'x', HOST), true);
  assert.equal(isAllowedLinkUrl(`https://twitter.com/i/oauth2/authorize?redirect_uri=${cb}`, 'x', HOST), true);
  assert.equal(isAllowedLinkUrl(`https://appleid.apple.com/auth/authorize?redirect_uri=${cb}`, 'apple', HOST), true);
  for (const [url, provider] of [
    [`https://accounts.google.com.evil.example/auth?redirect_uri=${cb}`, 'google'],
    [`https://accounts.google.com/auth?redirect_uri=${encodeURIComponent('https://evil.example/auth/v1/callback')}`, 'google'],
    [`https://accounts.google.com/auth?redirect_uri=${cb}&redirect_uri=${cb}`, 'google'],
    ['https://accounts.google.com/auth', 'google'],
    [`https://x.com/i/oauth2/authorize?redirect_uri=${cb}`, 'google'],
    [`http://accounts.google.com/auth?redirect_uri=${cb}`, 'google'],
    [`https://a:b@accounts.google.com/auth?redirect_uri=${cb}`, 'google'],
    [`https://${HOST}/auth/v1/authorize?redirect_uri=${cb}`, 'google'],
    ['javascript:alert(1)', 'x'],
  ]) assert.equal(isAllowedLinkUrl(url, provider, HOST), false, url);
});

test('sign-up: new and existing addresses get the identical neutral outcome; enumeration errors too', () => {
  assert.equal(classifySignUp({ session: { access_token: 'x' }, user: {} }), 'signed_in');
  const fresh = classifySignUp({ session: null, user: { identities: [{ id: '1' }] } });
  const existing = classifySignUp({ session: null, user: { identities: [] } });
  assert.equal(fresh, 'check_email');
  assert.equal(existing, fresh);
  for (const code of ['email_exists', 'user_already_exists', 'identity_already_exists']) assert.equal(signUpErrorIsNeutral(code), true, code);
  assert.equal(signUpErrorIsNeutral('weak_password'), false);
  assert.doesNotMatch(SIGN_UP_CHECK_EMAIL_MESSAGE, /すでに登録済み|already/u);
});

test('browser and Apple cancel/error contracts', () => {
  assert.deepEqual(classifyBrowserResult({ type: 'success', url: `${AUTH_CALLBACK_URL}?code=c` }), { kind: 'callback', url: `${AUTH_CALLBACK_URL}?code=c` });
  assert.deepEqual(classifyBrowserResult({ type: 'cancel' }), { kind: 'cancelled' });
  assert.deepEqual(classifyBrowserResult({ type: 'dismiss' }), { kind: 'cancelled' });
  assert.deepEqual(classifyBrowserResult({ type: 'locked' }), { kind: 'failed' });
  assert.equal(isAppleCancel({ code: 'ERR_REQUEST_CANCELED' }), true);
  assert.equal(isAppleCancel({ code: 'ERR_REQUEST_FAILED' }), false);
});

const settings = (external, signupDisabled = false) => parseAuthSettings({ external, disable_signup: signupDisabled });
const build = (configured, overrides = {}) => ({ configured: parseConfiguredProviders(configured), platform: 'ios', nativeAppleAvailable: true, iosBundleIdentifier: 'com.example.app', ...overrides });

test('provider readiness: enabled in Supabase AND configured for the build; never claims E2E', () => {
  const all = settings({ x: true, apple: true, google: true, email: true });
  assert.deepEqual(providerReadiness('x', all, build('email,x')), { enabledInSupabase: true, configuredForBuild: true, e2eVerified: false, usable: true });
  assert.equal(providerReadiness('google', all, build('email,x')).usable, false, 'enabled but not configured for this build');
  assert.equal(providerReadiness('x', settings({ x: false, email: true }), build('email,x')).usable, false, 'configured but disabled');
  assert.equal(providerReadiness('x', null, build('email,x')).usable, false, 'settings unknown');
  assert.equal(providerReadiness('apple', all, build('email,apple')).usable, true, 'iOS native Apple');
  assert.equal(providerReadiness('apple', all, build('email,apple', { iosBundleIdentifier: null })).usable, false, 'no bundle id');
  assert.equal(providerReadiness('apple', all, build('email,apple', { nativeAppleAvailable: false })).usable, false, 'native API unavailable');
  assert.equal(providerReadiness('apple', all, build('email,apple', { platform: 'android' })).usable, false, 'browser Apple needs apple_web (Services ID)');
  assert.equal(providerReadiness('apple', all, build('email,apple_web', { platform: 'android' })).usable, true);
  assert.deepEqual([...parseConfiguredProviders(undefined)], ['email'], 'default build: only the pre-existing e-mail login');
  assert.deepEqual([...parseConfiguredProviders('email, x ,bogus')].sort(), ['email', 'x']);
});

test('e-mail capabilities fail closed: disabled e-mail, disabled sign-up, unknown settings', () => {
  assert.deepEqual(emailCapabilities(settings({ email: true }), build('email')), { signIn: true, signUp: true, reset: true });
  assert.deepEqual(emailCapabilities(settings({ email: true }, true), build('email')), { signIn: true, signUp: false, reset: true });
  assert.deepEqual(emailCapabilities(settings({ email: false }), build('email')), { signIn: false, signUp: false, reset: false });
  assert.deepEqual(emailCapabilities(null, build('email')), { signIn: true, signUp: false, reset: false }, 'existing users can still sign in; nothing new is offered');
  assert.deepEqual(emailCapabilities(settings({ email: true }), build('x')), { signIn: false, signUp: false, reset: false });
  assert.equal(parseAuthSettings({ external: { email: true } }).signupDisabled, true, 'missing disable_signup is treated as disabled');
});

const token = (userId, sessionId) => `h.${Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId })).toString('base64url')}.s`;
const sess = (userId, sessionId) => ({ access_token: token(userId, sessionId), user: { id: userId } });

test('recovery is bound to the exact user and session; any other session ends it', () => {
  const recoveryA = nextRecoveryBinding(null, 'PASSWORD_RECOVERY', sess('user-a', 's1'));
  assert.deepEqual(recoveryA, { userId: 'user-a', sessionId: 's1' });
  assert.equal(recoveryMatches(recoveryA, sess('user-a', 's1')), true);
  assert.deepEqual(nextRecoveryBinding(recoveryA, 'TOKEN_REFRESHED', sess('user-a', 's1')), recoveryA, 'refresh of the same session keeps it');
  assert.equal(nextRecoveryBinding(recoveryA, 'SIGNED_IN', sess('user-b', 's2')), null, 'recovery A -> login B');
  assert.equal(nextRecoveryBinding(recoveryA, 'SIGNED_IN', sess('user-a', 's9')), null, 'new session of the same user');
  assert.equal(nextRecoveryBinding(recoveryA, 'SIGNED_OUT', null), null);
  assert.equal(nextRecoveryBinding(null, 'SIGNED_IN', sess('user-a', 's1')), null, 'only PASSWORD_RECOVERY starts recovery');
  assert.equal(recoveryMatches(recoveryA, sess('user-b', 's1')), false, 'recheck before update refuses another user');
  assert.equal(bindRecovery({ access_token: 'garbage', user: { id: 'user-a' } }), null, 'no session id -> no recovery');
  const recoveryB = nextRecoveryBinding(recoveryA, 'PASSWORD_RECOVERY', sess('user-b', 's3'));
  assert.deepEqual(recoveryB, { userId: 'user-b', sessionId: 's3' }, 'a newer recovery link replaces the older binding');
});

test('onboarding state never crosses users; new-account notice has no time limit and is per-user acknowledged', () => {
  const loaded = { userId: 'user-a', input: { kind: 'loaded', brandIds: [], xAccounts: [], settings: 'not_saved', settingsDeferred: true } };
  assert.equal(inputForCurrentUser(loaded, 'user-a'), loaded.input);
  assert.deepEqual(inputForCurrentUser(loaded, 'user-b'), { kind: 'loading' }, 'user switch');
  assert.deepEqual(inputForCurrentUser(loaded, null), { kind: 'loading' });
  assert.deepEqual(inputForCurrentUser({ userId: null, input: { kind: 'mock' } }, 'user-b'), { kind: 'mock' });
  const base = { identities: [{ provider: 'x' }], hasWorkspace: false, acknowledged: false };
  assert.equal(shouldShowNewAccountNotice(base), true, 'still shown long after creation while no workspace/ack');
  assert.equal(shouldShowNewAccountNotice({ ...base, acknowledged: true }), false);
  assert.equal(shouldShowNewAccountNotice({ ...base, hasWorkspace: true }), false);
  assert.equal(shouldShowNewAccountNotice({ ...base, identities: [{ provider: 'email' }] }), false);
  assert.equal(shouldShowNewAccountNotice({ ...base, identities: [{ provider: 'x' }, { provider: 'email' }] }), false);
});

test('fixed messages and password validation', () => {
  assert.match(authFlowMessage('identity_already_exists'), /別のアカウントで使われています/u);
  assert.match(authFlowMessage('link_user_mismatch'), /もう一度ログイン/u);
  assert.match(authFlowMessage('recovery_context_lost'), /再設定のリンク/u);
  assert.equal(authFlowMessage('Database error: secret'), authFlowMessage(null));
  assert.equal(validateNewPassword('short', 'short').ok, false);
  assert.equal(validateNewPassword('longenough1', 'different1').ok, false);
  assert.deepEqual(validateNewPassword('longenough1', 'longenough1'), { ok: true });
});
