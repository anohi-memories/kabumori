import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  ACCOUNT_DELETION_FUNCTION,
  DELETED_ITEMS,
  deletionAvailability,
  deletionErrorMessage,
  parseDeletionResponse,
  reauthMethods,
  RETAINED_ITEMS,
} from '../src/domain/account-deletion.ts';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const read = (path) => readFile(join(root, path), 'utf8');

test('availability: only an explicit build flag with a configured backend', () => {
  assert.equal(deletionAvailability({ enabledFlag: 'true', backendAvailable: true }), 'available');
  for (const [enabledFlag, backendAvailable] of [[undefined, true], ['', true], ['1', true], ['TRUE ', true], ['yes', true], ['true', false]]) {
    assert.equal(deletionAvailability({ enabledFlag, backendAvailable }), 'setup_pending', `${enabledFlag}/${backendAvailable}`);
  }
});

test('only 200 with ok:true is success; codes are sanitized', () => {
  assert.deepEqual(parseDeletionResponse(200, { ok: true }), { ok: true });
  assert.deepEqual(parseDeletionResponse(200, {}), { ok: false, code: 'FAILED' });
  assert.deepEqual(parseDeletionResponse(200, { ok: 'true' }), { ok: false, code: 'FAILED' });
  assert.deepEqual(parseDeletionResponse(204, { ok: true }), { ok: false, code: 'FAILED' });
  assert.deepEqual(parseDeletionResponse(409, { ok: false, error: 'DELETION_BLOCKED_SHARED_WORKSPACE' }), { ok: false, code: 'DELETION_BLOCKED_SHARED_WORKSPACE' });
  assert.deepEqual(parseDeletionResponse(500, { ok: false, error: '<b>server said</b>' }), { ok: false, code: 'FAILED' });
  assert.deepEqual(parseDeletionResponse(500, null), { ok: false, code: 'FAILED' });
});

test('messages are fixed Japanese; unknown codes never echo server text', () => {
  assert.match(deletionErrorMessage('DELETION_BLOCKED_SHARED_WORKSPACE'), /ほかの人も参加/u);
  assert.match(deletionErrorMessage('X_REVOKE_FAILED'), /投稿はすでに停止/u);
  assert.equal(deletionErrorMessage('DELETION_BLOCKED_SOMETHING_NEW'), 'このアカウントは、ここでは削除できません。お問い合わせください。');
  assert.equal(deletionErrorMessage('WHATEVER'), 'アカウントを削除できませんでした。時間をおいてもう一度お試しください。');
  assert.doesNotMatch(deletionErrorMessage('WHATEVER'), /WHATEVER/u);
});

test('every code the server can return has a specific or safe message', async () => {
  const logic = await readFile(join(repo, 'supabase/functions/social-mobile-account-delete/delete_logic.ts'), 'utf8');
  const codes = [...logic.matchAll(/fail\(\d{3}, '([A-Z_]+)'\)/gu)].map((match) => match[1]);
  const reasons = JSON.parse(logic.match(/BLOCK_REASONS = (\[[\s\S]*?\]) as const/u)[1].replace(/'/gu, '"').replace(/,\s*\]/u, ']'));
  assert.ok(codes.length >= 8 && reasons.length >= 8);
  for (const code of [...codes, ...reasons.map((reason) => `DELETION_BLOCKED_${reason}`)]) {
    assert.ok(deletionErrorMessage(code).length > 0, code);
    assert.doesNotMatch(deletionErrorMessage(code), /[A-Z]{3,}_/u, code);
  }
});

test('client and server agree on the confirmation constant and function name', async () => {
  const logic = await readFile(join(repo, 'supabase/functions/social-mobile-account-delete/delete_logic.ts'), 'utf8');
  assert.match(logic, new RegExp(`CONFIRMATION = '${ACCOUNT_DELETION_CONFIRMATION}'`, 'u'));
  assert.equal(ACCOUNT_DELETION_FUNCTION, 'social-mobile-account-delete');
});

test('re-authentication uses only the user\'s own, currently usable methods', () => {
  assert.deepEqual(reauthMethods(['email', 'x'], () => true), ['email', 'x']);
  assert.deepEqual(reauthMethods(['x', 'apple'], (method) => method !== 'apple'), ['x']);
  assert.deepEqual(reauthMethods(['google'], () => false), []);
  assert.deepEqual(reauthMethods([], () => true), []);
});

test('deleted/retained lists are explicit, including what the app cannot delete', () => {
  assert.ok(DELETED_ITEMS.some((item) => item.includes('投稿用のX接続')));
  assert.ok(RETAINED_ITEMS.some((item) => item.includes('X上にすでに公開された投稿')));
});

test('deletion screen: confirmation + fresh re-auth gate the button; only this screen deletes', async () => {
  const screen = await read('src/app/account-deletion.tsx');
  assert.match(screen, /disabled=\{busy !== null \|\| !reauthed \|\| phrase\.trim\(\) !== ACCOUNT_DELETION_CONFIRM_PHRASE\}/u);
  assert.match(screen, /if \(!reauthed \|\| phrase\.trim\(\) !== ACCOUNT_DELETION_CONFIRM_PHRASE\) return;/u);
  assert.match(screen, /accountDeletion !== 'available'/u, 'setup-pending state is rendered');
  assert.doesNotMatch(screen, /provider_token|refresh_token|access_token|service_role|user_metadata/u);
  const provider = await read('src/providers/auth-provider.tsx');
  const del = provider.slice(provider.indexOf('const deleteAccount = useCallback'), provider.indexOf('const value = useMemo'));
  assert.ok(del.indexOf('if (!outcome.ok) return outcome;') < del.indexOf("signOut({ scope: 'local' })"), 'local sign-out only after a confirmed deletion');
  assert.doesNotMatch(del, /user_id|userId|p_user_id/u, 'the request body never names a user');
});
