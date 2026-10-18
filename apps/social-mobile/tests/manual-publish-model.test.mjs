// F1 manual X single post: the pure model (draft rules, account choice, state machine, send gate).
// Offline: no network, no React, no clock of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/features/manual-publish/manual-publish-model.ts';
import { READINESS_MAX_AGE_MS } from '../src/features/manual-publish/manual-publish-port.ts';

const account = (id, over = {}) => ({
  id,
  brandId: 'A',
  platform: 'x',
  profile: { displayName: id, handle: `@${id}`, avatarColor: '#000000', voice: { tone: '', language: 'ja', avoid: [] } },
  connectionStatus: 'connected',
  postingState: 'active',
  ...over,
});
const READY = (accountId = 'X_A', checkedAt = 1_000) => ({ accountId, checkedAt, result: { kind: 'ready' } });
const apply = (state, ...actions) => actions.reduce((s, a) => m.manualPublishReducer(s, a), state);

/** editing -> confirming with a fresh `ready` answer for X_A. */
function confirming(text = 'こんにちは') {
  return apply(
    m.createInitialState(),
    { type: 'account_selected', accountId: 'X_A' },
    { type: 'draft_changed', text },
    { type: 'confirm_opened' },
    { type: 'readiness_received', record: READY('X_A', 1_000) },
  );
}

const gateOf = (state, over = {}) =>
  m.sendGate({ now: 2_000, signedIn: true, dataStatus: 'ready', account: account('X_A'), state, ...over });

// ---- draft ------------------------------------------------------------------------------------------------------

test('draft: empty and whitespace-only text are empty; line endings are unified and the ends trimmed', () => {
  assert.equal(m.checkDraft('').kind, 'empty');
  assert.equal(m.checkDraft('  \r\n\t ').kind, 'empty');
  assert.equal(m.normalizeDraft('  a\r\nb\rc  '), 'a\nb\nc');
  const ok = m.checkDraft('  hello  ');
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.text, 'hello');
});

test('draft: the X weighted limit is applied (wide characters and emoji count 2, a URL counts 23)', () => {
  assert.equal(m.MANUAL_PUBLISH_TEXT_LIMIT, 280);
  assert.equal(m.checkDraft('あ'.repeat(140)).kind, 'ok');
  const long = m.checkDraft('あ'.repeat(141));
  assert.deepEqual({ kind: long.kind, used: long.used, limit: long.limit }, { kind: 'too_long', used: 282, limit: 280 });
  assert.equal(m.checkDraft('a'.repeat(280)).kind, 'ok');
  assert.equal(m.checkDraft('a'.repeat(281)).kind, 'too_long');
  assert.equal(m.checkDraft(`${'a'.repeat(250)} https://example.com/a/very/long/path?x=1`).used, 274);
  assert.equal(m.checkDraft('😀'.repeat(140)).kind, 'ok');
  assert.equal(m.checkDraft('😀'.repeat(141)).kind, 'too_long');
});

test('draft: control characters, C1 controls and lone surrogates cannot be sent; tab and newline can', () => {
  for (const bad of ['a\u0000b', 'a\u0007b', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\ud800b']) {
    assert.equal(m.checkDraft(bad).kind, 'invalid_characters', JSON.stringify(bad));
  }
  assert.equal(m.checkDraft('a\tb\nc').kind, 'ok');
});

// ---- accounts ------------------------------------------------------------------------------------------------------

test('accounts: only X accounts of the current list can be chosen; other providers and stale ids never match', () => {
  const list = [account('X_A'), account('T_1', { platform: 'threads' }), account('I_1', { platform: 'instagram' }), account('X_B', { brandId: 'B' })];
  assert.deepEqual(m.xAccountsOf(list).map((a) => a.id), ['X_A', 'X_B']);
  assert.equal(m.resolveSelectedAccount(list, 'X_A').id, 'X_A');
  assert.equal(m.resolveSelectedAccount(list, 'T_1'), null);
  assert.equal(m.resolveSelectedAccount(list, 'I_1'), null);
  assert.equal(m.resolveSelectedAccount(list, null), null);
  assert.equal(m.resolveSelectedAccount(list, 'x_a'), null, 'ids match exactly');
  // The other brand's account is not in this brand's list: it cannot be resolved from it.
  assert.equal(m.resolveSelectedAccount([account('X_A')], 'X_B'), null);
});

// ---- reducer: editing and confirming -----------------------------------------------------------------------------

test('reducer: a confirmation needs an account, a valid draft and no unresolved attempt', () => {
  const start = m.createInitialState();
  assert.equal(apply(start, { type: 'confirm_opened' }).phase, 'editing', 'no account');
  const noText = apply(start, { type: 'account_selected', accountId: 'X_A' }, { type: 'confirm_opened' });
  assert.equal(noText.phase, 'editing', 'empty draft');
  const tooLong = apply(start, { type: 'account_selected', accountId: 'X_A' }, { type: 'draft_changed', text: 'あ'.repeat(141) }, { type: 'confirm_opened' });
  assert.equal(tooLong.phase, 'editing', 'over the limit');
  const ok = apply(start, { type: 'account_selected', accountId: 'X_A' }, { type: 'draft_changed', text: 'hi' }, { type: 'confirm_opened' });
  assert.equal(ok.phase, 'confirming');
  assert.equal(ok.readiness, null, 'every confirmation starts without any readiness answer');
});

test('reducer: the draft and the account cannot be edited once confirming / sending / showing a result', () => {
  const s = confirming('abc');
  assert.equal(apply(s, { type: 'draft_changed', text: 'changed' }).draft, 'abc');
  assert.equal(apply(s, { type: 'account_selected', accountId: 'X_B' }).accountId, 'X_A');
  const back = apply(s, { type: 'confirm_closed' });
  assert.equal(back.phase, 'editing');
  assert.equal(back.readiness, null, 'going back drops the readiness answer');
  assert.equal(apply(back, { type: 'draft_changed', text: 'changed' }).draft, 'changed');
});

test('reducer: selecting another account drops the readiness answer', () => {
  const s = apply(m.createInitialState(), { type: 'account_selected', accountId: 'X_A' });
  assert.equal(apply(s, { type: 'account_selected', accountId: 'X_B' }).accountId, 'X_B');
  assert.equal(apply(s, { type: 'account_selected', accountId: '' }).accountId, 'X_A', 'an empty id is ignored');
});

test('reducer: a readiness answer for another account or outside the confirmation is ignored', () => {
  const editing = apply(m.createInitialState(), { type: 'account_selected', accountId: 'X_A' }, { type: 'draft_changed', text: 'hi' });
  assert.equal(apply(editing, { type: 'readiness_received', record: READY('X_A') }).readiness, null, 'not confirming');
  const c = apply(editing, { type: 'confirm_opened' });
  assert.equal(apply(c, { type: 'readiness_received', record: READY('X_B') }).readiness, null, 'other account');
  assert.equal(apply(c, { type: 'readiness_received', record: READY('X_A') }).readiness.accountId, 'X_A');
});

// ---- reducer: send ------------------------------------------------------------------------------------------------------

test('send_started: only from a confirmation holding a fresh, ready, same-account answer', () => {
  const ok = confirming();
  assert.equal(apply(ok, { type: 'send_started', requestId: 'r1', now: 2_000 }).phase, 'sending');
  const refused = (s, now = 2_000, requestId = 'r1') => apply(s, { type: 'send_started', requestId, now }).phase === 'confirming';
  assert.ok(refused(ok, 1_000 + READINESS_MAX_AGE_MS + 1), 'a stale answer');
  assert.ok(refused(ok, 999), 'an answer from the future');
  assert.ok(refused(ok, 2_000, ''), 'no request id');
  const notConnected = apply(confirming(), { type: 'readiness_received', record: { accountId: 'X_A', checkedAt: 1_000, result: { kind: 'not_connected' } } });
  assert.ok(refused(notConnected), 'not_connected');
  const unavailable = apply(confirming(), { type: 'readiness_received', record: { accountId: 'X_A', checkedAt: 1_000, result: { kind: 'unavailable', code: 'X' } } });
  assert.ok(refused(unavailable), 'unavailable');
  const noAnswer = apply(m.createInitialState(), { type: 'account_selected', accountId: 'X_A' }, { type: 'draft_changed', text: 'hi' }, { type: 'confirm_opened' });
  assert.ok(refused(noAnswer), 'no answer yet');
  assert.equal(apply(m.createInitialState(), { type: 'send_started', requestId: 'r1', now: 2_000 }).phase, 'editing', 'not from editing');
});

test('send_started twice is a no-op the second time', () => {
  const sending = apply(confirming(), { type: 'send_started', requestId: 'r1', now: 2_000 });
  const again = apply(sending, { type: 'send_started', requestId: 'r2', now: 2_001 });
  assert.equal(again.requestId, 'r1');
  assert.equal(again, sending);
});

test('send_settled: published is the only way to "sent"; the draft is then cleared', () => {
  const sending = apply(confirming('hello'), { type: 'send_started', requestId: 'r1', now: 2_000 });
  const sent = apply(sending, { type: 'send_settled', requestId: 'r1', outcome: { kind: 'published', targetId: 'r1', providerPostId: '123' } });
  assert.deepEqual(sent.result, { kind: 'sent', requestId: 'r1', providerPostId: '123' });
  assert.equal(sent.phase, 'result');
  assert.equal(sent.draft, '');
  assert.equal(sent.unresolved, null);
  assert.equal(m.surfaceOf({ dataStatus: 'ready', xAccountCount: 1, account: account('X_A'), state: sent }), 'sent');
  const dismissed = apply(sent, { type: 'result_dismissed' });
  assert.equal(dismissed.phase, 'editing');
  assert.equal(dismissed.draft, '');
});

test('send_settled: a proven rejection is "failed", keeps the draft and allows editing again', () => {
  const sending = apply(confirming('hello'), { type: 'send_started', requestId: 'r1', now: 2_000 });
  const failed = apply(sending, { type: 'send_settled', requestId: 'r1', outcome: { kind: 'rejected', targetId: 'r1', code: 'X_REJECTED_403' } });
  assert.deepEqual(failed.result, { kind: 'failed', requestId: 'r1', code: 'X_REJECTED_403' });
  assert.equal(failed.draft, 'hello');
  assert.equal(failed.unresolved, null);
  const back = apply(failed, { type: 'result_dismissed' });
  assert.equal(back.phase, 'editing');
  assert.equal(back.draft, 'hello');
});

test('send_settled: an unknown outcome blocks every further send until the user acknowledges it', () => {
  const sending = apply(confirming('hello'), { type: 'send_started', requestId: 'r1', now: 2_000 });
  const unknown = apply(sending, { type: 'send_settled', requestId: 'r1', outcome: { kind: 'uncertain', targetId: 'r1', code: 'X_TIMEOUT' } });
  assert.equal(unknown.result.kind, 'uncertain');
  assert.deepEqual(unknown.unresolved, { accountId: 'X_A', requestId: 'r1' });
  assert.equal(m.surfaceOf({ dataStatus: 'ready', xAccountCount: 1, account: account('X_A'), state: unknown }), 'uncertain');
  assert.equal(apply(unknown, { type: 'result_dismissed' }), unknown, 'cannot be dismissed');
  assert.equal(apply(unknown, { type: 'confirm_opened' }), unknown);
  assert.equal(apply(unknown, { type: 'send_started', requestId: 'r2', now: 2_000 }), unknown);
  assert.equal(gateOf(unknown).reason, 'unresolved_attempt');
  const acknowledged = apply(unknown, { type: 'uncertain_acknowledged' });
  assert.equal(acknowledged.phase, 'editing');
  assert.equal(acknowledged.draft, '', 'the draft that may already be posted is discarded');
  assert.equal(acknowledged.unresolved, null);
});

test('send_settled: an answer for another request, or one that proves nothing, never shows "sent"', () => {
  const sending = apply(confirming('hello'), { type: 'send_started', requestId: 'r1', now: 2_000 });
  assert.equal(apply(sending, { type: 'send_settled', requestId: 'other', outcome: { kind: 'published', targetId: 'other', providerPostId: '1' } }), sending);
  const mismatched = apply(sending, { type: 'send_settled', requestId: 'r1', outcome: { kind: 'published', targetId: 'someone-else', providerPostId: '1' } });
  assert.equal(mismatched.result.kind, 'uncertain');
  assert.equal(mismatched.result.code, 'OUTCOME_TARGET_MISMATCH');
  for (const providerPostId of ['', '   ', undefined, null, 5]) {
    const r = m.resultOf('r1', { kind: 'published', targetId: 'r1', providerPostId });
    assert.equal(r.kind, 'uncertain', String(providerPostId));
  }
  assert.equal(m.resultOf('r1', { kind: 'bogus', targetId: 'r1' }).kind, 'uncertain');
  assert.equal(apply(confirming(), { type: 'send_settled', requestId: 'r1', outcome: { kind: 'published', targetId: 'r1', providerPostId: '1' } }).phase, 'confirming', 'not while confirming');
});

test('accounts_changed: the chosen account must stay in the current list', () => {
  const editing = apply(m.createInitialState(), { type: 'account_selected', accountId: 'X_B' }, { type: 'draft_changed', text: 'hi' });
  assert.equal(apply(editing, { type: 'accounts_changed', accountIds: ['X_A', 'X_B'] }), editing);
  const dropped = apply(editing, { type: 'accounts_changed', accountIds: ['X_A'] });
  assert.equal(dropped.accountId, null);
  assert.equal(dropped.draft, 'hi', 'the text is kept, the account is not');
  const c = apply(editing, { type: 'confirm_opened' }, { type: 'readiness_received', record: READY('X_B') });
  const left = apply(c, { type: 'accounts_changed', accountIds: [] });
  assert.equal(left.phase, 'editing');
  assert.equal(left.accountId, null);
  assert.equal(left.readiness, null);
  const sending = apply(confirming(), { type: 'send_started', requestId: 'r1', now: 2_000 });
  assert.equal(apply(sending, { type: 'accounts_changed', accountIds: [] }), sending, 'an in-flight send is never forgotten');
});

test('an unresolved attempt from an earlier visit opens the screen on the uncertain result', () => {
  const s = m.createInitialState({ accountId: 'X_A', requestId: 'r9' });
  assert.equal(s.phase, 'result');
  assert.equal(s.result.kind, 'uncertain');
  assert.equal(s.result.code, m.UNRESOLVED_FROM_EARLIER_VISIT);
  assert.equal(gateOf(s).reason, 'unresolved_attempt');
  assert.equal(apply(s, { type: 'uncertain_acknowledged' }).phase, 'editing');
  assert.equal(apply(s, { type: 'reset' }).unresolved, null);
});

// ---- send gate -----------------------------------------------------------------------------------------------------------

test('gate: the first failing condition names the reason (in a fixed order)', () => {
  const ready = confirming();
  assert.deepEqual(gateOf(ready), { allowed: true });
  assert.equal(gateOf(ready, { signedIn: false }).reason, 'not_signed_in');
  for (const dataStatus of ['loading', 'blocked', 'unavailable']) assert.equal(gateOf(ready, { dataStatus }).reason, 'data_not_ready', dataStatus);
  assert.equal(gateOf(ready, { account: null }).reason, 'no_account');
  assert.equal(gateOf(ready, { account: account('X_B') }).reason, 'no_account', 'the account is not the chosen one');
  assert.equal(gateOf(ready, { account: account('X_A', { platform: 'threads' }) }).reason, 'no_account', 'not an X account');
  assert.equal(gateOf(ready, { account: account('X_A', { connectionStatus: 'needs_attention' }) }).reason, 'account_needs_attention');
  assert.equal(gateOf(ready, { account: account('X_A', { connectionStatus: 'not_connected' }) }).reason, 'account_not_connected');
  const sending = apply(ready, { type: 'send_started', requestId: 'r1', now: 2_000 });
  assert.equal(gateOf(sending).reason, 'sending');
  for (const reason of Object.keys(m.SEND_BLOCK_MESSAGES)) assert.ok(m.SEND_BLOCK_MESSAGES[reason].length > 0, reason);
});

test('gate: draft problems block the send even with a ready port', () => {
  const withDraft = (text) => ({ ...confirming(), draft: text });
  assert.equal(gateOf(withDraft('')).reason, 'draft_empty');
  assert.equal(gateOf(withDraft('a\u0000')).reason, 'draft_invalid');
  assert.equal(gateOf(withDraft('あ'.repeat(141))).reason, 'draft_too_long');
});

test('gate: a cached "connected" value never allows a send -- only a fresh, same-account `ready` answer does', () => {
  const connectedAccount = account('X_A', { connectionStatus: 'connected' });
  const base = apply(m.createInitialState(), { type: 'account_selected', accountId: 'X_A' }, { type: 'draft_changed', text: 'hi' }, { type: 'confirm_opened' });
  assert.equal(gateOf(base, { account: connectedAccount }).reason, 'readiness_unchecked');
  const notConnected = apply(base, { type: 'readiness_received', record: { accountId: 'X_A', checkedAt: 1_000, result: { kind: 'not_connected' } } });
  assert.equal(gateOf(notConnected, { account: connectedAccount }).reason, 'port_not_connected');
  assert.equal(gateOf(notConnected, { account: connectedAccount, dataStatus: 'mock_preview' }).reason, 'port_not_connected', 'the local demo is no exception');
  const unavailable = apply(base, { type: 'readiness_received', record: { accountId: 'X_A', checkedAt: 1_000, result: { kind: 'unavailable', code: 'E' } } });
  assert.equal(gateOf(unavailable, { account: connectedAccount }).reason, 'port_unavailable');
  const ready = apply(base, { type: 'readiness_received', record: READY('X_A', 1_000) });
  assert.deepEqual(gateOf(ready, { account: connectedAccount }), { allowed: true });
  assert.equal(gateOf(ready, { account: connectedAccount, now: 1_000 + READINESS_MAX_AGE_MS }).allowed, true, 'exactly at the limit');
  assert.equal(gateOf(ready, { account: connectedAccount, now: 1_000 + READINESS_MAX_AGE_MS + 1 }).reason, 'readiness_stale');
  assert.equal(gateOf(ready, { account: connectedAccount, now: 500 }).reason, 'readiness_stale', 'from the future');
  const other = { ...ready, readiness: READY('X_B', 1_000) };
  assert.equal(gateOf(other, { account: connectedAccount }).reason, 'readiness_other_account');
});

// ---- target and surface ------------------------------------------------------------------------------------------------

test('target: the idempotency key is the request id; a text-only X target is the only shape', () => {
  const t = m.buildTarget('r1', 'X_A', 'hi');
  assert.deepEqual(t, { targetId: 'r1', provider: 'x', connectedAccountId: 'X_A', renderedText: 'hi', media: [] });
  assert.equal(m.targetIsSendable(t), true);
  assert.equal(m.targetIsSendable({ ...t, renderedText: '   ' }), false);
  assert.equal(m.targetIsSendable({ ...t, provider: 'threads' }), false);
  assert.equal(m.targetIsSendable({ ...t, media: [{ assetId: 'a', kind: 'image' }] }), false);
});

test('surface: one label for the situation; "sent" needs a published result', () => {
  const init = m.createInitialState();
  const surface = (over) => m.surfaceOf({ dataStatus: 'ready', xAccountCount: 1, account: account('X_A'), state: init, ...over });
  assert.equal(surface({}), 'ready_to_preview');
  assert.equal(surface({ dataStatus: 'mock_preview' }), 'ready_to_preview');
  for (const dataStatus of ['loading', 'blocked', 'unavailable']) assert.equal(surface({ dataStatus }), 'unavailable', dataStatus);
  assert.equal(surface({ xAccountCount: 0, account: null }), 'not_connected');
  assert.equal(surface({ account: account('X_A', { connectionStatus: 'not_connected' }) }), 'not_connected');
  assert.equal(surface({ account: account('X_A', { connectionStatus: 'needs_attention' }) }), 'unavailable');
  assert.equal(surface({ state: apply(confirming(), { type: 'send_started', requestId: 'r1', now: 2_000 }) }), 'sending');
  for (const state of [init, confirming()]) assert.notEqual(surface({ state }), 'sent');
});
