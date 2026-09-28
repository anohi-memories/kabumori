import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOnboardingStep, onboardingStorageKey, reconnectReason } from '../src/domain/onboarding.ts';

const account = (overrides = {}) => ({ id: 'sa_1', brandId: 'u_1', handle: 'me', connectionStatus: 'identity_verified', lastConnectionErrorCode: null, ...overrides });
const loaded = (overrides = {}) => ({ kind: 'loaded', brandIds: ['u_1'], xAccounts: [account()], settings: 'not_saved', settingsDeferred: false, ...overrides });

test('mock preview is never gated; loading and errors are explicit', () => {
  assert.deepEqual(deriveOnboardingStep({ kind: 'mock' }), { step: 'preview' });
  assert.deepEqual(deriveOnboardingStep({ kind: 'loading' }), { step: 'loading' });
  assert.deepEqual(deriveOnboardingStep({ kind: 'error', reason: 'x' }), { step: 'error', reason: 'x' });
});

test('first run: no workspace or no X account -> connect X', () => {
  assert.deepEqual(deriveOnboardingStep(loaded({ brandIds: [], xAccounts: [] })), { step: 'connect_x', resume: false });
  assert.deepEqual(deriveOnboardingStep(loaded({ xAccounts: [] })), { step: 'connect_x', resume: false });
});

test('interrupted connection resumes; failed connection asks to reconnect with a fixed reason', () => {
  for (const connectionStatus of ['authorization_pending', 'unconnected', 'connected']) {
    assert.deepEqual(deriveOnboardingStep(loaded({ xAccounts: [account({ connectionStatus })] })), { step: 'connect_x', resume: true });
  }
  const failed = deriveOnboardingStep(loaded({ xAccounts: [account({ connectionStatus: 'failed', lastConnectionErrorCode: 'X_REFRESH_GRANT_REJECTED' })] }));
  assert.equal(failed.step, 'reconnect_x');
  assert.equal(failed.reason, reconnectReason('X_REFRESH_GRANT_REJECTED'));
  assert.equal(reconnectReason('SOMETHING_ELSE'), reconnectReason(null));
});

test('verified account: settings step until saved or deferred; backend availability is surfaced', () => {
  assert.deepEqual(deriveOnboardingStep(loaded()), { step: 'settings', account: account(), backendAvailable: true });
  assert.deepEqual(deriveOnboardingStep(loaded({ settings: 'unavailable' })), { step: 'settings', account: account(), backendAvailable: false });
  assert.deepEqual(deriveOnboardingStep(loaded({ settings: 'saved' })), { step: 'done', account: account() });
  assert.deepEqual(deriveOnboardingStep(loaded({ settingsDeferred: true })), { step: 'done', account: account() });
});

test('ambiguity fails closed: never picks the first workspace or X account', () => {
  assert.equal(deriveOnboardingStep(loaded({ brandIds: ['u_1', 'u_2'] })).step, 'ambiguous');
  assert.equal(deriveOnboardingStep(loaded({ xAccounts: [account(), account({ id: 'sa_2' })] })).step, 'ambiguous');
});

test('accounts of another brand are ignored (wrong user/account binding)', () => {
  assert.deepEqual(deriveOnboardingStep(loaded({ xAccounts: [account({ brandId: 'u_other' })] })), { step: 'connect_x', resume: false });
});

test('the local "settings later" flag is scoped to one user id', () => {
  const id = '0b5e6a7c-1d2e-4f3a-8b9c-0d1e2f3a4b5c';
  assert.equal(onboardingStorageKey(id), `social-mobile:onboarding:v1:${id}`);
  assert.throws(() => onboardingStorageKey('../../etc'), /ONBOARDING_USER_ID_INVALID/u);
  assert.throws(() => onboardingStorageKey(''), /ONBOARDING_USER_ID_INVALID/u);
});
