import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sameDeletionContext, deletionAvailability } from '../src/domain/account-deletion.ts';
import { POSTONA_END_SOURCE_ENABLED, POSTONA_END_CONFIRM_PHRASE, parseEndPreview, parseEndResult, endFailure } from '../src/domain/postona-service-end.ts';
import { createPostonaEndClient } from '../src/lib/postona-service-end-client.ts';
import { ERROR_NOTICES } from '../src/domain/postona-end-notices.ts';

export const previewBody = (status = 'active') => ({ ok: true, account_status: 'active', lifecycle_version: 7,
  services: [{ service: 'kabumori', status: 'active' }, { service: 'x_autopost', status }], blockers: [], deletion_in_progress: false,
  deletion_available: false, apple: { required: false, supported: true, code_required: false }, x_cleanup: 'supported',
  providers: [{ provider: 'x', adapter: 'saga', remote_revoke: 'saga' }, { provider: 'threads', adapter: 'registered', remote_revoke: 'unsupported' }],
  acknowledgement_required: ['threads'], postona_end_available: true });
const ended = { ok: true, outcome: 'ended', providers: { x: 'done', threads: 'local_removed_remote_unverified' }, remote_unverified: ['threads'], x_posts_unconfirmed: 2 };
const context = { userId: 'synthetic-user', sessionId: 'synthetic-session' };
const answer = (body, status = 200) => ({ status, body });
function harness({ enabled = true, responses = [answer(previewBody()), answer(ended), answer(previewBody('ended'))] } = {}) {
  const calls = []; let current = { ...context, accessToken: 'synthetic-token' };
  const client = createPostonaEndClient({ enabled, session: async () => current, call: async (body, token) => {
    calls.push({ body, token }); const next = responses.shift(); if (typeof next === 'function') return next(); if (!next) throw new Error('offline'); return next;
  } });
  return { client, calls, setSession: (next) => { current = next; } };
}
const input = (preview, extra = {}) => ({ context, preview, phrase: POSTONA_END_CONFIRM_PHRASE, acknowledged: ['threads'], ...extra });

test('old flag and new runtime source stay closed, with no lifecycle request', async () => {
  assert.equal(POSTONA_END_SOURCE_ENABLED, false);
  assert.equal(deletionAvailability({ enabledFlag: 'true', backendAvailable: true }), 'setup_pending');
  const h = harness({ enabled: false });
  assert.equal((await h.client.preview()).code, 'POSTONA_END_UNAVAILABLE');
  assert.equal((await h.client.end({})).code, 'POSTONA_END_UNAVAILABLE');
  assert.deepEqual(h.calls, []);
});
test('only actual common POSTONA action + consent, followed by definitive read-back; login and Kabumori stay', async () => {
  const h = harness(), p = await h.client.preview(); const result = await h.client.end(input(p));
  assert.equal(result.ok, true); assert.match(result.lines[0], /ログイン用のアカウントとかぶモリのデータは残っています/u);
  assert.match(result.lines[1], /Threads（Meta）側/u); assert.match(result.lines[2], /予約が2件/u);
  assert.deepEqual(h.calls.map((c) => c.body), [{ action: 'preview' }, { action: 'withdraw_postona', confirmation: 'END_POSTONA_SERVICE', acknowledged_remote_unverified: ['threads'] }, { action: 'preview' }]);
  assert.equal((await h.client.end(input(p))).code, 'LIFECYCLE_CHANGED'); assert.equal(h.calls.length, 3);
});
test('POSTONA-only user without Kabumori registration still retains common login', async () => {
  const before = previewBody(); before.services = [{ service: 'x_autopost', status: 'active' }];
  const after = { ...before, services: [{ service: 'x_autopost', status: 'ended' }] };
  const h = harness({ responses: [answer(before), answer(ended), answer(after)] });
  assert.equal((await h.client.end(input(await h.client.preview()))).ok, true);
  assert.ok(h.calls.every((c) => !['delete_common_account', 'delete'].includes(c.body.action)));
});
test('active POSTONA, changed Kabumori or missing common-account/Auth read-back prevents success', async () => {
  const states = [previewBody(), { ...previewBody('ended'), services: [{ service: 'x_autopost', status: 'ended' }] }, { ...previewBody('ended'), account_status: 'none' }, { ...previewBody('ended'), services: [{ service: 'kabumori', status: 'ended' }, { service: 'x_autopost', status: 'ended' }] }, { ok: false, error: 'AUTH_REQUIRED' }];
  for (const after of states) {
    const h = harness({ responses: [answer(previewBody()), answer(ended), answer(after)] });
    const result = await h.client.end(input(await h.client.preview()));
    assert.equal(result.ok, false); assert.equal(result.code, 'RESULT_UNCONFIRMED');
    assert.ok(result.lines.some((s) => s.includes('予約が2件'))); assert.ok(!result.lines.some((s) => s.includes('終了しました')));
  }
});
test('unknown/legacy/login-deleting/incomplete provider results fail closed, including unconsented remote grant', () => {
  for (const body of [null, [], {}, { ok: true }, { ok: true, login_deleted: true }, { ...ended, login_deleted: true }, { ...ended, outcome: 'deleted' }, { ...ended, x_posts_unconfirmed: -1 }, { ...ended, x_posts_unconfirmed: '2' }, { ...ended, providers: { threads: 'blocked' } }, { ...ended, remote_unverified: ['unknown'] }, { ...ended, remote_unverified: [] }, { ...ended, remote_unverified: ['threads', 'threads'] }]) assert.equal(parseEndResult(200, body, ['threads']).ok, false, JSON.stringify(body));
  assert.equal(parseEndResult(200, ended, []).ok, false); assert.equal(parseEndResult(202, ended, ['threads']).ok, false);
  assert.equal(parseEndResult(200, { ok: true, outcome: 'already_ended', remote_unverified: ['threads'], x_posts_unconfirmed: 2 }, ['threads']).ok, true);
  assert.equal(parseEndResult(200, { ok: true, outcome: 'not_registered' }, []).ok, true);
});
test('malformed preview, unknown provider and inconsistent consent block; busy or missing adapter unavailable', () => {
  for (const patch of [{ acknowledgement_required: [] }, { acknowledgement_required: ['unknown'] }, { services: [{}] }, { lifecycle_version: -1 }, { providers: [{ provider: 'unknown' }] }, { account_status: 'unknown' }]) assert.equal(parseEndPreview(200, { ...previewBody(), ...patch }).ok, false);
  for (const patch of [{ x_cleanup: 'unsupported' }, { blockers: ['LOCKED'] }, { postona_end_available: false }, { account_status: 'locked' }, { deletion_in_progress: true }]) assert.equal(parseEndPreview(200, { ...previewBody(), ...patch }).postonaAvailable, false);
});
test('distinct typed phrase and explicit exact provider consent, no mutation when missing', async () => {
  const h = harness(), p = await h.client.preview();
  for (const [extra, code] of [[{ phrase: '削除する' }, 'CONFIRMATION_REQUIRED'], [{ phrase: '共通IDを完全削除' }, 'CONFIRMATION_REQUIRED'], [{ acknowledged: [] }, 'REMOTE_UNVERIFIED_ACK_REQUIRED'], [{ acknowledged: ['x'] }, 'ACKNOWLEDGEMENT_INVALID'], [{ acknowledged: ['threads', 'threads'] }, 'ACKNOWLEDGEMENT_INVALID']]) assert.equal((await h.client.end(input(p, extra))).code, code);
  assert.equal(h.calls.length, 1);
});
test('preview and reauthentication cannot cross users, sessions or fabricated previews', async () => {
  const h = harness(), p = await h.client.preview(); assert.equal((await h.client.end(input({ ...p }))).code, 'LIFECYCLE_CHANGED');
  for (const current of [{ ...context, userId: 'other', accessToken: 't' }, { ...context, sessionId: 'other', accessToken: 't' }, null]) { h.setSession(current); assert.equal((await h.client.end(input(p))).ok, false); }
  assert.equal(h.calls.length, 1); assert.equal(sameDeletionContext({ userId: '', sessionId: '' }, { userId: '', sessionId: '' }), false);
});
test('double tap sends one mutation; stale response for another session is never successful', async () => {
  let finish; const pending = new Promise((resolve) => { finish = resolve; });
  const h = harness({ responses: [answer(previewBody()), () => pending] }), p = await h.client.preview();
  const first = h.client.end(input(p)); assert.equal((await h.client.end(input(p))).code, 'DELETION_IN_PROGRESS');
  await new Promise((r) => setImmediate(r)); h.setSession({ userId: 'other', sessionId: 'other', accessToken: 't' }); finish(answer(ended));
  assert.equal((await first).code, 'SESSION_CHANGED'); assert.equal(h.calls.length, 2);
});
test('every F5 error has fixed notices; reasons and uncertain posts survive failure; never server prose', () => {
  for (const [code, notice] of Object.entries(ERROR_NOTICES)) {
    const f = endFailure(code, { message: 'secret prose', reasons: ['X_REVOKE_FAILED'], x_posts_unconfirmed: 3 });
    assert.equal(f.ok, false); assert.equal(f.retryable, notice.retryable); assert.equal(f.lines.slice(0, notice.ja.split('\n').length).join('\n'), notice.ja);
    assert.ok(f.lines.at(-1).includes('予約が3件')); assert.ok(!f.lines.join().includes('secret prose'));
  }
  assert.match(endFailure('X_CLEANUP_FAILED', { reasons: ['X_REVOKE_FAILED'] }).lines[1], /取り消しを確認できませんでした/u);
});
test('in-progress/consent/reconciliation/failed mutation must refresh preview before retry', async () => {
  for (const code of ['REAUTH_REQUIRED', 'REMOTE_UNVERIFIED_ACK_REQUIRED', 'DELETION_IN_PROGRESS', 'RECONCILIATION_REQUIRED', 'X_CLEANUP_UNSUPPORTED', 'FAILED']) {
    const h = harness({ responses: [answer(previewBody()), answer({ ok: false, error: code }, 409)] }), p = await h.client.preview();
    assert.equal((await h.client.end(input(p))).code, code); assert.equal((await h.client.end(input(p))).code, 'LIFECYCLE_CHANGED'); assert.equal(h.calls.length, 2);
  }
});
test('application source has no callable legacy route or full-account fallback', async () => {
  const provider = await readFile(new URL('../src/providers/auth-provider.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(provider, /social-mobile-account-delete|action: 'delete'|expected_scope|DELETE_MY_ACCOUNT/u);
  const screen = await readFile(new URL('../src/app/account-deletion.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(screen, /deleteAccount\(|previewDeletion\(|Alert\.alert|loginDeleted/u);
  assert.match(screen, /disabled style=\{\[styles.button/u);
});

test('already-ended durable facts retain Threads warning and uncertainty after providers disappeared', async () => {
  const state = { ...previewBody('ended'), providers: [], acknowledgement_required: [], x_cleanup: 'not_needed' };
  const h = harness({ responses: [answer(state), answer({ ...ended, outcome: 'already_ended' }), answer(state)] });
  const p = await h.client.preview(); const result = await h.client.end(input(p, { acknowledged: [] }));
  assert.equal(result.ok, true); assert.match(result.lines[0], /すでに終了/u);
  assert.match(result.lines[1], /Threads（Meta）側/u); assert.match(result.lines[2], /予約が2件/u);
  assert.throws(() => { p.acknowledgementRequired.push('unknown'); }, TypeError);
});
