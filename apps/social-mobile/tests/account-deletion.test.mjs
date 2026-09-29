import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  ACCOUNT_DELETION_FUNCTION,
  deletionAvailability,
  deletionErrorMessage,
  deletionItems,
  deletionNeedsFreshReauth,
  deletionPlatformSupport,
  deletionResultMessage,
  parseDeletionPreview,
  parseDeletionResponse,
  reauthMethods,
  sameDeletionContext,
} from '../src/domain/account-deletion.ts';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const read = (path) => readFile(join(root, path), 'utf8');
const serverLogic = () => readFile(join(repo, 'supabase/functions/social-mobile-account-delete/delete_logic.ts'), 'utf8');

test('availability: only an explicit build flag with a configured backend', () => {
  assert.equal(deletionAvailability({ enabledFlag: 'true', backendAvailable: true }), 'available');
  for (const [enabledFlag, backendAvailable] of [[undefined, true], ['', true], ['1', true], ['yes', true], ['true', false]]) {
    assert.equal(deletionAvailability({ enabledFlag, backendAvailable }), 'setup_pending', `${enabledFlag}/${backendAvailable}`);
  }
});

test('H2 R2: copy matches the scope exactly; かぶモリ data is never implied deleted', () => {
  const full = deletionItems('social_and_login');
  assert.ok(full.deleted[0].startsWith('ログイン用のアカウント'));
  assert.ok(!full.deleted.join().includes('かぶモリ'));
  const social = deletionItems('social_only');
  assert.ok(!social.deleted.some((item) => item.includes('ログイン用のアカウント')));
  assert.match(social.kept[0], /ログイン用アカウントと「かぶモリ」のデータは削除されません/u);
  for (const scope of ['social_only', 'social_and_login']) {
    assert.ok(deletionItems(scope).kept.some((item) => item.includes('X上にすでに公開された投稿')));
  }
  assert.match(deletionResultMessage({ loginDeleted: true }), /アカウントを削除しました/u);
  assert.match(deletionResultMessage({ loginDeleted: false }), /ログイン用アカウントと「かぶモリ」のデータは残っています/u);
});

test('preview and result parsing: only explicit server answers count', () => {
  assert.deepEqual(parseDeletionPreview(200, { ok: true, scope: 'social_only', state: 'none', apple_supported: true, apple_code_required: false }),
    { ok: true, scope: 'social_only', state: 'none', appleSupported: true, appleCodeRequired: false });
  assert.deepEqual(parseDeletionPreview(200, { ok: true, scope: 'everything' }), { ok: false, code: 'FAILED' });
  assert.deepEqual(parseDeletionPreview(401, { ok: false, error: 'AUTH_REQUIRED' }), { ok: false, code: 'AUTH_REQUIRED' });
  assert.deepEqual(parseDeletionResponse(200, { ok: true, login_deleted: true }), { ok: true, loginDeleted: true, loginKept: false });
  assert.deepEqual(parseDeletionResponse(200, { ok: true, login_deleted: false }), { ok: true, loginDeleted: false, loginKept: true });
  assert.deepEqual(parseDeletionResponse(200, {}), { ok: false, code: 'FAILED' });
  assert.deepEqual(parseDeletionResponse(204, { ok: true }), { ok: false, code: 'FAILED' });
  assert.deepEqual(parseDeletionResponse(409, { ok: false, error: 'DELETION_OPERATOR_REQUIRED' }), { ok: false, code: 'DELETION_OPERATOR_REQUIRED' });
  assert.deepEqual(parseDeletionResponse(500, { ok: false, error: '<b>server</b>' }), { ok: false, code: 'FAILED' });
});

test('messages are fixed Japanese; every code the server can return has a specific or safe message', async () => {
  const logic = await serverLogic();
  const codes = [...logic.matchAll(/(?:fail|stop)\(\d{3}, '([A-Z_]+)'/gu)].map((match) => match[1]);
  const reasons = JSON.parse(logic.match(/BLOCK_REASONS = (\[[\s\S]*?\]) as const/u)[1].replace(/'/gu, '"').replace(/,\s*\]/u, ']'));
  assert.ok(codes.length >= 12 && reasons.length >= 9);
  for (const code of [...codes, ...reasons.map((reason) => `DELETION_BLOCKED_${reason}`), 'SESSION_CHANGED']) {
    const text = deletionErrorMessage(code);
    assert.ok(text.length > 0 && !/[A-Z]{3,}_/u.test(text), code);
  }
  for (const code of ['DELETION_OPERATOR_REQUIRED', 'CREDENTIALS_CHANGED', 'DELETION_IN_PROGRESS', 'SCOPE_CHANGED', 'SESSION_CHANGED', 'FINALIZE_FAILED']) {
    assert.notEqual(deletionErrorMessage(code), deletionErrorMessage('SOMETHING_UNKNOWN'), `${code} has a specific message`);
  }
  assert.doesNotMatch(deletionErrorMessage('WHATEVER'), /WHATEVER/u);
});

test('H2 R5: after any code that consumes or invalidates the re-auth, a fresh one is required', () => {
  for (const code of ['APPLE_REVOKE_FAILED', 'APPLE_REAUTH_REQUIRED', 'REAUTH_REQUIRED', 'SESSION_CHANGED', 'SCOPE_CHANGED', 'AUTH_REQUIRED']) {
    assert.equal(deletionNeedsFreshReauth(code), true, code);
  }
  for (const code of ['X_REVOKE_FAILED', 'DELETION_IN_PROGRESS', 'FAILED']) assert.equal(deletionNeedsFreshReauth(code), false, code);
});

test('H2 R6: platform support is declared, Apple login deletion needs the native app', () => {
  assert.equal(deletionPlatformSupport({ appleCodeRequired: false, appleSupported: false, nativeAppleAvailable: false }), 'supported');
  assert.equal(deletionPlatformSupport({ appleCodeRequired: true, appleSupported: true, nativeAppleAvailable: true }), 'supported');
  assert.equal(deletionPlatformSupport({ appleCodeRequired: true, appleSupported: true, nativeAppleAvailable: false }), 'apple_native_required');
  assert.equal(deletionPlatformSupport({ appleCodeRequired: true, appleSupported: false, nativeAppleAvailable: true }), 'apple_unavailable');
});

test('client context pinning: exact user and session only', () => {
  const context = { userId: 'u1', sessionId: 's1' };
  assert.equal(sameDeletionContext(context, { userId: 'u1', sessionId: 's1' }), true);
  assert.equal(sameDeletionContext(context, { userId: 'u2', sessionId: 's1' }), false);
  assert.equal(sameDeletionContext(context, { userId: 'u1', sessionId: 's2' }), false);
  assert.equal(sameDeletionContext(context, { userId: 'u1', sessionId: null }), false);
  assert.equal(sameDeletionContext(null, { userId: 'u1', sessionId: 's1' }), false);
});

test('client and server agree on constants', async () => {
  assert.match(await serverLogic(), new RegExp(`CONFIRMATION = '${ACCOUNT_DELETION_CONFIRMATION}'`, 'u'));
  assert.equal(ACCOUNT_DELETION_FUNCTION, 'social-mobile-account-delete');
  assert.deepEqual(reauthMethods(['email', 'x'], () => true), ['email', 'x']);
  assert.deepEqual(reauthMethods(['x', 'apple'], (method) => method !== 'apple'), ['x']);
});

test('deletion screen: pinned confirmation gates the button; Apple code is dropped after every attempt', async () => {
  const screen = await read('src/app/account-deletion.tsx');
  assert.match(screen, /const pinned = reauthed && sameDeletionContext\(reauthed\.context, \{ userId, sessionId \}\) \? reauthed : null;/u);
  assert.match(screen, /const canSubmit = Boolean\(pinned && ready && platform === 'supported' && phrase\.trim\(\) === ACCOUNT_DELETION_CONFIRM_PHRASE && busy === null\);/u);
  assert.match(screen, /disabled=\{!canSubmit\}/u);
  const submit = screen.slice(screen.indexOf('async function submit()'), screen.indexOf('return (\n'));
  const drop = submit.indexOf('setReauthed((current) => (current ? { context: current.context } : null));');
  assert.ok(drop > 0 && drop < submit.indexOf('if (outcome.ok)'), 'code dropped before any branch');
  assert.match(screen, /scope: ready\.scope/u, 'the scope shown is the scope sent');
  assert.doesNotMatch(screen, /provider_token|refresh_token|access_token|service_role|user_metadata/u);
  const provider = await read('src/providers/auth-provider.tsx');
  const del = provider.slice(provider.indexOf('const deleteAccount = useCallback'), provider.indexOf('const value = useMemo'));
  const pin = del.indexOf("return { ok: false, code: 'SESSION_CHANGED' }");
  assert.ok(pin > 0 && pin < del.indexOf('callDeletion('), 'pinning checked before the request');
  const confirmed = del.indexOf('if (!outcome.ok) return outcome;');
  assert.ok(confirmed > 0 && confirmed < del.indexOf("signOut({ scope: 'local' })"), 'local sign-out only after a confirmed deletion');
  assert.doesNotMatch(del, /user_id|p_user_id/u, 'the request body never names a user');
});
