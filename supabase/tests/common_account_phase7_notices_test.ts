// Phase 7 (F5): the user-facing notices of the POSTONA end and the common-account deletion are a CONTRACT. Pure, no
// database. Run by common_account_release_preflight_run.sh (section notices).
//
// Pins: every server error code has a notice; a remote authorization that could not be revoked is never described as
// revoked and is a SEPARATE line that says where to remove it; the two acts are never presented as one; and which
// server answers each app's real client does not map yet (the expected/actual error list for the app owners).
import assert from 'node:assert/strict';
import test from 'node:test';

import { X_BLOCK_REASONS } from '../functions/account-delete/http.ts';
import {
  ERROR_NOTICES,
  POSTONA_END_VS_ACCOUNT_DELETE,
  REMOTE_UNVERIFIED,
  resultLines,
  UNKNOWN_CODE_NOTICE,
  X_REASON_NOTICES,
  xPostsUnconfirmedLine,
} from '../functions/account-delete/user_notices.ts';

const read = (path: string) => Deno.readTextFileSync(new URL(path, import.meta.url));
const logic = read('../functions/account-delete/lifecycle_logic.ts');
const serverCodes = (() => {
  const match = /export type LifecycleErrorCode =([\s\S]*?);\n/u.exec(logic);
  assert.ok(match, 'LifecycleErrorCode union found');
  return [...match[1].matchAll(/'([A-Z_]+)'/gu)].map((m) => m[1]);
})();

// Words that would say the remote authorization is gone. None may appear in any text about a provider's remote side.
const CLAIMS_OF_REVOCATION = [/取り消しました/u, /取り消されました/u, /解除しました/u, /解除されました/u, /無効にしました/u, /revoked/iu, /失効しました/u];
const hasCjk = (text: string) => /[぀-ヿ一-鿿]/u.test(text);

test('every server error code has a Japanese notice, and nothing else is in the table', () => {
  assert.ok(serverCodes.length >= 30, `parsed ${serverCodes.length} codes`);
  assert.deepEqual(Object.keys(ERROR_NOTICES).sort(), [...serverCodes].sort());
  for (const [code, notice] of Object.entries(ERROR_NOTICES)) {
    assert.ok(notice.ja.length > 0 && hasCjk(notice.ja), `${code}: a Japanese text`);
    assert.ok(!/[A-Z]{2,}_[A-Z_]+/u.test(notice.ja), `${code}: the text never shows a code`);
    assert.ok(!/(token|secret|password=)/iu.test(notice.ja), `${code}: no credential words`);
  }
  assert.ok(UNKNOWN_CODE_NOTICE.retryable && hasCjk(UNKNOWN_CODE_NOTICE.ja));
});

test('a notice that asks for consent says plainly that the remote authorization stays', () => {
  const ack = ERROR_NOTICES.REMOTE_UNVERIFIED_ACK_REQUIRED;
  assert.equal(ack.kind, 'consent');
  assert.match(ack.ja, /Threads/u);
  assert.match(ack.ja, /取り消せません/u);
  assert.match(ack.ja, /設定/u, 'says where to remove it');
  assert.equal(ERROR_NOTICES.PROVIDER_REMOTE_UNVERIFIED.kind, 'consent');
});

test('no text about a provider\'s remote side claims the authorization was revoked', () => {
  const texts: string[] = [];
  for (const provider of Object.values(REMOTE_UNVERIFIED)) texts.push(provider.local, provider.remote, provider.consent);
  for (const code of ['REMOTE_UNVERIFIED_ACK_REQUIRED', 'PROVIDER_REMOTE_UNVERIFIED', 'PROVIDER_CLEANUP_BLOCKED', 'PROVIDER_ADAPTER_MISSING'] as const) {
    texts.push(ERROR_NOTICES[code].ja);
  }
  texts.push(...POSTONA_END_VS_ACCOUNT_DELETE.postona_end.removes, ...POSTONA_END_VS_ACCOUNT_DELETE.account_delete.keeps);
  for (const text of texts) {
    for (const claim of CLAIMS_OF_REVOCATION) assert.ok(!claim.test(text), `"${text}" must not claim a revocation (${claim})`);
  }
  // the local line and the remote line are different lines
  const threads = REMOTE_UNVERIFIED.threads;
  assert.notEqual(threads.local, threads.remote);
  assert.match(threads.local, /削除します/u);
  assert.doesNotMatch(threads.local, /Threads（Meta）側/u, 'the local line makes no statement about the remote side');
});

test('ending POSTONA and deleting the common account are different acts, each stated completely', () => {
  const end = POSTONA_END_VS_ACCOUNT_DELETE.postona_end;
  const del = POSTONA_END_VS_ACCOUNT_DELETE.account_delete;
  assert.notEqual(end.title, del.title);
  assert.ok(end.keeps.some((k) => /ログイン用のアカウント/u.test(k)), 'ending POSTONA keeps the login');
  assert.ok(end.keeps.some((k) => /かぶモリ/u.test(k)), 'ending POSTONA keeps Kabumori');
  assert.ok(del.removes.some((k) => /ログイン用のアカウント/u.test(k)), 'deleting removes the login');
  assert.ok(del.removes.some((k) => /かぶモリ/u.test(k)), 'deleting removes Kabumori data');
  assert.match(del.reversible, /元に戻すことはできません/u);
  assert.match(end.reversible, /元に戻りません/u);
  // both state that published posts stay and that Threads' own authorization stays
  assert.ok(end.keeps.some((k) => /公開された投稿/u.test(k)) && del.keeps.some((k) => /公開された投稿/u.test(k)));
  assert.ok(del.keeps.some((k) => /Threads側のアクセス許可/u.test(k)));
  assert.ok(end.removes.some((k) => /Threads側の許可は残ります/u.test(k)));
});

test('result lines: the local result first, the remote line separate, only what the server confirmed', () => {
  const ended = resultLines({ outcome: 'ended', providers: { threads: 'local_removed_remote_unverified', x: 'done' }, remote_unverified: ['threads'] }, 'postona_end');
  assert.equal(ended.length, 2);
  assert.match(ended[0], /POSTONAの利用を終了しました/u);
  assert.equal(ended[1], REMOTE_UNVERIFIED.threads.remote);
  const plain = resultLines({ outcome: 'ended', providers: { x: 'done' } }, 'postona_end');
  assert.equal(plain.length, 1, 'no remote line when nothing is unverified');
  const deleted = resultLines({ outcome: 'deleted', remote_unverified: ['threads'] }, 'account_delete');
  assert.match(deleted[0], /共通アカウントを削除しました/u);
  assert.equal(deleted[1], REMOTE_UNVERIFIED.threads.remote);
  // a success of the other act, or an unknown shape, says nothing
  assert.deepEqual(resultLines({ outcome: 'deleted' }, 'postona_end'), []);
  assert.deepEqual(resultLines({ outcome: 'ended' }, 'account_delete'), []);
  assert.deepEqual(resultLines({ outcome: 'weird', remote_unverified: ['threads'] }, 'postona_end'), []);
  // an unknown provider has no text to invent
  assert.equal(resultLines({ outcome: 'ended', remote_unverified: ['someone_else'] }, 'postona_end').length, 1);
});

// ---- Phase 8: the typed X reasons and the unconfirmed posts ----------------------------------------------------------
test('every typed X reason has one line, and none of them claims a revocation, an end or a publication', () => {
  const reasons = [...X_BLOCK_REASONS, 'X_REVOKE_FAILED', 'CREDENTIALS_CHANGED', 'FINALIZE_FAILED', 'OPERATOR_REQUIRED'];
  assert.deepEqual(Object.keys(X_REASON_NOTICES).sort(), [...reasons].sort());
  const claims = [...CLAIMS_OF_REVOCATION, /削除しました/u, /終了しました/u, /完了しました/u, /投稿されました/u];
  for (const [reason, text] of Object.entries(X_REASON_NOTICES)) {
    assert.ok(hasCjk(text), `${reason}: a Japanese text`);
    assert.ok(!/[A-Z]{2,}_[A-Z_]+/u.test(text), `${reason}: the text never shows a code`);
    for (const claim of claims) assert.ok(!claim.test(text), `${reason}: "${text}" must not claim ${claim}`);
  }
});

test('X posts whose result was never known: a separate line that says neither "posted" nor "not posted"', () => {
  const line = xPostsUnconfirmedLine(2);
  assert.match(line, /2件/u);
  assert.match(line, /Xでご確認/u);
  assert.doesNotMatch(line, /投稿されました|投稿されていません|投稿されませんでした|キャンセル|取り消/u);
  const ended = resultLines({ outcome: 'ended', providers: { x: 'done' }, x_posts_unconfirmed: 2 }, 'postona_end');
  assert.equal(ended.length, 2);
  assert.equal(ended[1], line);
  const again = resultLines({ outcome: 'already_ended', x_posts_unconfirmed: 2 }, 'postona_end');
  assert.equal(again[again.length - 1], line, 'a later read says it too');
  const deleted = resultLines({ outcome: 'deleted', remote_unverified: ['threads'], x_posts_unconfirmed: 1 }, 'account_delete');
  assert.deepEqual(deleted.slice(1), [REMOTE_UNVERIFIED.threads.remote, xPostsUnconfirmedLine(1)], 'the remote line first, then the unconfirmed posts');
  for (const bad of [0, -1, 1.5, '2', null, undefined]) {
    assert.deepEqual(resultLines({ outcome: 'ended', x_posts_unconfirmed: bad }, 'postona_end').length, 1, `no line for ${String(bad)}`);
  }
});

// ---- what the real app clients map today (the expected/actual error list for the app owners) ----------------------
test('app gap: the Kabumori client does not map the Phase 4/6 provider answers yet (they fall back to a generic text)', () => {
  const client = read('../../src/lib/account-deletion.ts');
  const map = /const DELETE_MESSAGES: Record<string, string> = \{([\s\S]*?)\n\};/u.exec(client);
  assert.ok(map, 'DELETE_MESSAGES found');
  const mapped = new Set([...map[1].matchAll(/^\s+([A-Z_]+):/gmu)].map((m) => m[1]));
  const withdrawCases = new Set([...(/export function withdrawOutcome([\s\S]*?)\n\}\n/u.exec(client)?.[1] ?? '').matchAll(/case '([A-Z_]+)'/gu)].map((m) => m[1]));
  const unmapped = serverCodes.filter((code) => !mapped.has(code) && !withdrawCases.has(code)).sort();
  // Pinned: when an app owner maps one of these, this list shrinks and this test must be updated with the change.
  assert.deepEqual(unmapped, [
    'ACKNOWLEDGEMENT_INVALID', 'ACTION_REQUIRED', 'FAILED', 'PROVIDER_ADAPTER_MISSING', 'PROVIDER_CLEANUP_BLOCKED',
    'PROVIDER_REMOTE_UNVERIFIED', 'REMOTE_UNVERIFIED_ACK_REQUIRED', 'WITHDRAW_INCOMPLETE',
  ]);
  // and the client cannot send the acknowledgement or ask for POSTONA alone: no such action or field exists in it
  assert.ok(!/withdraw_postona/u.test(client), 'the Kabumori client has no POSTONA-end action');
  assert.ok(!/acknowledged_remote_unverified/u.test(client), 'the Kabumori client sends no acknowledgement');
});

test('app gap: the POSTONA app deletes through the legacy X saga, not through account-delete (no lifecycle, no acknowledgement)', () => {
  const client = read('../../apps/social-mobile/src/domain/account-deletion.ts');
  assert.match(client, /ACCOUNT_DELETION_FUNCTION = 'social-mobile-account-delete'/u);
  assert.ok(!/account-delete/u.test(client.replaceAll('social-mobile-account-delete', '')), 'it never calls the common account-delete function');
  assert.ok(!/withdraw_postona|acknowledged_remote_unverified|delete_common_account/u.test(client));
  // the legacy saga does not know the common lifecycle either (no entitlement, no lease, no provider results)
  const saga = read('../functions/social-mobile-account-delete/delete_logic.ts');
  assert.ok(!/service_entitlements|common_accounts|claim_service_deletion|begin_service_deletion/u.test(saga));
});
