// F1 manual X single post: the pure model (draft rules, account choice, consent, attempt identity, state machine,
// send gate). Offline: no network, no React, no clock of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as m from '../src/features/manual-publish/manual-publish-model.ts';
import { READINESS_MAX_AGE_MS } from '../src/features/manual-publish/manual-publish-port.ts';

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REAL = { simulated: false, afterFreeze: false };
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

/** editing -> confirming with a fresh `ready` answer for X_A (no consent yet). */
function confirming(text = 'こんにちは') {
  return apply(
    m.createInitialState(),
    { type: 'account_selected', accountId: 'X_A' },
    { type: 'draft_changed', text },
    { type: 'confirm_opened' },
    { type: 'readiness_received', record: READY('X_A', 1_000) },
  );
}
/** confirming + the explicit consent ticked. */
const consented = (text) => apply(confirming(text), { type: 'consent_changed', checked: true });
const start = (state, requestId = ID(1), now = 2_000) => apply(state, { type: 'send_started', requestId, now });
const settle = (state, outcome) => apply(state, { type: 'send_settled', requestId: state.requestId, outcome });

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
  assert.equal(m.resolveSelectedAccount([account('X_A')], 'X_B'), null);
});

// ---- reducer: editing and confirming -----------------------------------------------------------------------------

test('reducer: a confirmation needs an account, a valid draft and no unresolved attempt', () => {
  const s0 = m.createInitialState();
  assert.equal(apply(s0, { type: 'confirm_opened' }).phase, 'editing', 'no account');
  const noText = apply(s0, { type: 'account_selected', accountId: 'X_A' }, { type: 'confirm_opened' });
  assert.equal(noText.phase, 'editing', 'empty draft');
  const tooLong = apply(s0, { type: 'account_selected', accountId: 'X_A' }, { type: 'draft_changed', text: 'あ'.repeat(141) }, { type: 'confirm_opened' });
  assert.equal(tooLong.phase, 'editing', 'over the limit');
  const ok = apply(s0, { type: 'account_selected', accountId: 'X_A' }, { type: 'draft_changed', text: 'hi' }, { type: 'confirm_opened' });
  assert.equal(ok.phase, 'confirming');
  assert.equal(ok.readiness, null, 'every confirmation starts without any readiness answer');
  assert.equal(ok.consent, null, 'and without any consent');
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

test('reducer: selecting another account drops the readiness answer and the consent', () => {
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

// ---- consent ------------------------------------------------------------------------------------------------------------

test('consent: it exists only after the explicit tick, is bound to the exact text and account, and is dropped on leaving', () => {
  const s = confirming('こんにちは');
  assert.equal(s.consent, null);
  assert.equal(m.consentForSend(s), null);
  const on = apply(s, { type: 'consent_changed', checked: true });
  assert.deepEqual(on.consent, { accountId: 'X_A', contentSha256: sha('こんにちは') });
  assert.deepEqual(m.consentForSend(on), { confirmed: true, contentSha256: sha('こんにちは') });
  assert.equal(m.shortHash(on.consent.contentSha256), sha('こんにちは').slice(0, 12));
  assert.equal(apply(on, { type: 'consent_changed', checked: false }).consent, null);
  assert.equal(apply(on, { type: 'confirm_closed' }).consent, null);
  assert.equal(apply(m.createInitialState(), { type: 'consent_changed', checked: true }).consent, null, 'not while editing');
});

test('consent: the hash is of the EXACT confirmed string -- no hidden trimming, newline or normalisation differences', () => {
  const s = consented('  行1\r\n行2  ');
  assert.equal(s.consent.contentSha256, sha('行1\n行2'), 'the normalised text that the confirmation shows');
  assert.notEqual(s.consent.contentSha256, sha('  行1\r\n行2  '));
  const forged = { ...s, consent: { accountId: 'X_A', contentSha256: sha('another text') } };
  assert.equal(m.consentForSend(forged), null, 'a record for other text is never passed on');
  const otherAccount = { ...s, consent: { accountId: 'X_B', contentSha256: s.consent.contentSha256 } };
  assert.equal(m.consentForSend(otherAccount), null, 'nor one for another account');
});

// ---- reducer: send ------------------------------------------------------------------------------------------------------

test('send_started: only with an explicit consent, a fresh, ready, same-account answer and a UUID attempt id', () => {
  const ok = consented();
  assert.equal(start(ok).phase, 'sending');
  const refused = (s, requestId = ID(1), now = 2_000) => start(s, requestId, now).phase === 'confirming';
  assert.ok(refused(confirming()), 'no consent');
  assert.ok(refused(ok, ID(1), 1_000 + READINESS_MAX_AGE_MS + 1), 'a stale answer');
  assert.ok(refused(ok, ID(1), 999), 'an answer from the future');
  for (const bad of ['', 'req-1', 'manual-00000000-0000-4000-8000-000000000001', 'ABCDEF00-0000-4000-8000-000000000001', ID(1).slice(1)]) assert.ok(refused(ok, bad), `attempt id ${bad}`);
  const notConnected = apply(consented(), { type: 'readiness_received', record: { accountId: 'X_A', checkedAt: 1_000, result: { kind: 'not_connected' } } });
  assert.ok(refused(notConnected), 'not_connected');
  const unavailable = apply(consented(), { type: 'readiness_received', record: { accountId: 'X_A', checkedAt: 1_000, result: { kind: 'unavailable', code: 'X' } } });
  assert.ok(refused(unavailable), 'unavailable');
  const noAnswer = apply(m.createInitialState(), { type: 'account_selected', accountId: 'X_A' }, { type: 'draft_changed', text: 'hi' }, { type: 'confirm_opened' }, { type: 'consent_changed', checked: true });
  assert.ok(refused(noAnswer), 'no readiness answer yet');
  assert.equal(start(m.createInitialState()).phase, 'editing', 'not from editing');
  const badAccount = apply(m.createInitialState(), { type: 'account_selected', accountId: 'bad id!' }, { type: 'draft_changed', text: 'hi' }, { type: 'confirm_opened' }, { type: 'readiness_received', record: READY('bad id!') }, { type: 'consent_changed', checked: true });
  assert.ok(refused(badAccount), 'an account id the server would refuse');
});

test('send_started twice is a no-op the second time', () => {
  const sending = start(consented());
  const again = start(sending, ID(2), 2_001);
  assert.equal(again.requestId, ID(1));
  assert.equal(again, sending);
});

test('send_settled: published is the only way to "sent"; the draft is then cleared and nothing stays unresolved', () => {
  const sending = start(consented('hello'));
  assert.deepEqual(sending.unresolved, { accountId: 'X_A', requestId: ID(1), contentSha256: sha('hello'), text: 'hello', kind: 'in_flight' });
  const sent = settle(sending, { kind: 'published', marks: REAL, targetId: ID(1), providerPostId: '1790000000000000001' });
  assert.deepEqual(sent.result, { kind: 'sent', requestId: ID(1), providerPostId: '1790000000000000001', marks: REAL });
  assert.equal(sent.phase, 'result');
  assert.equal(sent.draft, '');
  assert.equal(sent.unresolved, null);
  assert.equal(sent.consent, null, 'the consent is spent');
  assert.equal(m.surfaceOf({ dataStatus: 'ready', xAccountCount: 1, account: account('X_A'), state: sent }), 'sent');
  const dismissed = apply(sent, { type: 'result_dismissed' });
  assert.equal(dismissed.phase, 'editing');
  assert.equal(dismissed.draft, '');
});

test('send_settled: a proven rejection (failed) and a refusal keep the draft; the next attempt is a NEW attempt', () => {
  for (const [outcome, kind] of [
    [{ kind: 'rejected', targetId: ID(1), code: 'X_REJECTED_403' }, 'failed'],
    [{ kind: 'refused', targetId: ID(1), code: 'POSTONA_RESV_SERVICE_NOT_ACTIVE', retryable: false }, 'refused'],
  ]) {
    const done = settle(start(consented('hello')), outcome);
    assert.equal(done.result.kind, kind);
    assert.equal(done.draft, 'hello');
    assert.equal(done.unresolved, null, `${kind} is a proven end`);
    const back = apply(done, { type: 'result_dismissed' });
    assert.equal(back.phase, 'editing');
    assert.equal(back.draft, 'hello');
    assert.equal(back.requestId, null, 'the attempt id is forgotten: a new send gets a new one');
  }
});

test('pending is NOT uncertain and NOT sent: not posted yet, possibly in flight, retried only with the SAME id', () => {
  const pending = settle(start(consented('hello')), { kind: 'pending', targetId: ID(1), code: 'IN_PROGRESS', marks: REAL });
  assert.deepEqual(pending.result, { kind: 'pending', requestId: ID(1), code: 'IN_PROGRESS', marks: REAL });
  assert.equal(pending.unresolved.kind, 'pending');
  assert.equal(m.surfaceOf({ dataStatus: 'ready', xAccountCount: 1, account: account('X_A'), state: pending }), 'pending');
  assert.equal(apply(pending, { type: 'result_dismissed' }), pending, 'cannot be walked away from');
  assert.equal(apply(pending, { type: 'confirm_opened' }), pending, 'no different attempt');
  assert.equal(gateOf(pending).reason, 'unresolved_attempt');
  const retry = apply(pending, { type: 'retry_requested' }, { type: 'readiness_received', record: READY('X_A', 1_000) });
  assert.equal(retry.phase, 'confirming');
  assert.equal(retry.consent, null, 'a retry needs a fresh explicit consent');
  assert.equal(gateOf(retry).reason, 'consent_missing');
  const ready = apply(retry, { type: 'consent_changed', checked: true });
  assert.deepEqual(gateOf(ready), { allowed: true });
  assert.equal(start(ready, ID(2)).phase, 'confirming', 'a NEW id is refused for an unresolved attempt');
  assert.equal(start(ready, ID(1)).phase, 'sending', 'the SAME id is the retry');
  assert.equal(apply(ready, { type: 'confirm_closed' }).phase, 'result', 'leaving a retry returns to the unresolved result');
});

test('unconfirmed (F3 unavailable) is not "not posted": same-id retry or acknowledgement only', () => {
  const s = settle(start(consented('hello')), { kind: 'unavailable', targetId: ID(1), code: 'TRANSPORT_FAILED' });
  assert.deepEqual(s.result, { kind: 'unconfirmed', requestId: ID(1), code: 'TRANSPORT_FAILED' });
  assert.equal(s.unresolved.kind, 'unconfirmed');
  assert.equal(m.surfaceOf({ dataStatus: 'ready', xAccountCount: 1, account: account('X_A'), state: s }), 'unconfirmed');
  assert.equal(apply(s, { type: 'result_dismissed' }), s);
  assert.equal(apply(s, { type: 'retry_requested' }).phase, 'confirming');
  const ack = apply(s, { type: 'unresolved_acknowledged' });
  assert.equal(ack.phase, 'editing');
  assert.equal(ack.draft, '');
  assert.equal(ack.unresolved, null);
});

test('a retry is bound to the same account and the same exact text', () => {
  const pending = settle(start(consented('hello')), { kind: 'pending', targetId: ID(1), code: null });
  const retry = apply(pending, { type: 'retry_requested' }, { type: 'readiness_received', record: READY('X_A', 1_000) }, { type: 'consent_changed', checked: true });
  assert.equal(start(retry, ID(1)).phase, 'sending');
  assert.equal(apply(retry, { type: 'draft_changed', text: 'changed' }).draft, 'hello', 'the text cannot change');
  const otherAccount = { ...retry, accountId: 'X_B', readiness: READY('X_B', 1_000), consent: { accountId: 'X_B', contentSha256: sha('hello') } };
  assert.equal(start(otherAccount, ID(1)).phase, 'confirming', 'the unresolved attempt belongs to X_A');
  const otherText = { ...retry, draft: 'other', consent: { accountId: 'X_A', contentSha256: sha('other') } };
  assert.equal(start(otherText, ID(1)).phase, 'confirming', 'nor can it carry other text');
});

test('uncertain: never resent, no retry, only an acknowledgement ends it', () => {
  const unknown = settle(start(consented('hello')), { kind: 'uncertain', targetId: ID(1), code: 'X_TIMEOUT' });
  assert.equal(unknown.result.kind, 'uncertain');
  assert.equal(unknown.unresolved.kind, 'uncertain');
  assert.equal(m.surfaceOf({ dataStatus: 'ready', xAccountCount: 1, account: account('X_A'), state: unknown }), 'uncertain');
  assert.equal(apply(unknown, { type: 'result_dismissed' }), unknown, 'cannot be dismissed');
  assert.equal(apply(unknown, { type: 'retry_requested' }), unknown, 'no retry');
  assert.equal(apply(unknown, { type: 'confirm_opened' }), unknown);
  assert.equal(start(unknown, ID(1)), unknown);
  assert.equal(gateOf(unknown).reason, 'unresolved_attempt');
  const acknowledged = apply(unknown, { type: 'unresolved_acknowledged' });
  assert.equal(acknowledged.phase, 'editing');
  assert.equal(acknowledged.draft, '', 'the draft that may already be posted is discarded');
  assert.equal(acknowledged.unresolved, null);
});

test('defence in depth: even a hand-built state cannot retry an uncertain attempt or carry an old consent into a retry', () => {
  // (unreachable through the reducer; the guards below hold on their own)
  const pending = settle(start(consented('hello')), { kind: 'pending', targetId: ID(1), code: null });
  const withConsent = { ...pending, consent: { accountId: 'X_A', contentSha256: sha('hello') } };
  assert.equal(apply(withConsent, { type: 'retry_requested' }).consent, null, 'a retry always starts without consent');
  const uncertainAttempt = { accountId: 'X_A', requestId: ID(1), contentSha256: sha('hello'), text: 'hello', kind: 'uncertain' };
  const forced = { ...consented('hello'), unresolved: uncertainAttempt };
  assert.equal(start(forced, ID(1)).phase, 'confirming', 'an uncertain attempt is never sent again, even with the same id');
  assert.equal(gateOf(forced).reason, 'unresolved_attempt');
  const inFlight = { ...consented('hello'), unresolved: { ...uncertainAttempt, kind: 'in_flight' } };
  assert.equal(start(inFlight, ID(1)).phase, 'confirming', 'nor an attempt that is still in flight');
});

test('send_settled: an answer for another request, or one that proves nothing, never shows "sent"', () => {
  const sending = start(consented('hello'));
  assert.equal(apply(sending, { type: 'send_settled', requestId: ID(9), outcome: { kind: 'published', marks: REAL, targetId: ID(9), providerPostId: '1' } }), sending);
  const mismatched = settle(sending, { kind: 'published', marks: REAL, targetId: ID(7), providerPostId: '1' });
  assert.equal(mismatched.result.kind, 'uncertain');
  assert.equal(mismatched.result.code, 'OUTCOME_TARGET_MISMATCH');
  for (const providerPostId of ['', '   ', 'abc', '12x', undefined, null, 5, '1'.repeat(31)]) {
    assert.equal(m.resultOf(ID(1), { kind: 'published', marks: REAL, targetId: ID(1), providerPostId }).kind, 'uncertain', String(providerPostId));
  }
  assert.equal(m.resultOf(ID(1), { kind: 'bogus', targetId: ID(1) }).kind, 'uncertain');
  assert.equal(apply(consented(), { type: 'send_settled', requestId: ID(1), outcome: { kind: 'published', marks: REAL, targetId: ID(1), providerPostId: '1' } }).phase, 'confirming', 'not while confirming');
});

test('resultOf: every port outcome lands in exactly one result class; codes are stable machine codes only', () => {
  const r = (outcome) => m.resultOf(ID(1), { targetId: ID(1), ...outcome });
  assert.equal(r({ kind: 'published', marks: REAL, providerPostId: '9' }).kind, 'sent');
  assert.equal(r({ kind: 'pending', code: null }).kind, 'pending');
  assert.equal(r({ kind: 'rejected', code: 'X_REJECTED_400' }).kind, 'failed');
  assert.equal(r({ kind: 'refused', code: 'AUTH_REQUIRED', retryable: true }).kind, 'refused');
  assert.equal(r({ kind: 'unavailable', code: null }).kind, 'unconfirmed');
  assert.equal(r({ kind: 'uncertain', code: 'X_TIMEOUT' }).kind, 'uncertain');
  assert.equal(r({ kind: 'rejected', code: '<script>alert(1)</script>' }).code, 'FAILED');
  assert.equal(r({ kind: 'uncertain', code: 'ユーザーの本文を含むメッセージ' }).code, 'UNCERTAIN');
  assert.equal(r({ kind: 'pending', code: 'lowercase' }).code, null);
  assert.equal(r({ kind: 'refused', code: 'AUTH_REQUIRED', retryable: 'yes' }).retryable, false, 'only a real true is retryable');
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
  assert.equal(left.consent, null);
  const sending = start(consented());
  assert.equal(apply(sending, { type: 'accounts_changed', accountIds: [] }), sending, 'an in-flight send is never forgotten');
  const pending = settle(sending, { kind: 'pending', targetId: ID(1), code: null });
  assert.equal(apply(pending, { type: 'accounts_changed', accountIds: [] }), pending);
});

test('an unresolved attempt from an earlier visit restores the exact attempt: same id, text, hash and account', () => {
  const attempt = { accountId: 'X_A', requestId: ID(9), contentSha256: sha('earlier'), text: 'earlier', kind: 'in_flight' };
  const s = m.createInitialState(attempt);
  assert.equal(s.phase, 'result');
  assert.equal(s.result.kind, 'unconfirmed', 'an attempt still in flight when the user left is not "not posted"');
  assert.equal(s.result.code, m.UNRESOLVED_FROM_EARLIER_VISIT);
  assert.equal(s.draft, 'earlier');
  assert.equal(s.unresolved.requestId, ID(9));
  assert.equal(s.unresolved.kind, 'unconfirmed');
  const retry = apply(s, { type: 'retry_requested' }, { type: 'readiness_received', record: READY('X_A', 1_000) }, { type: 'consent_changed', checked: true });
  assert.equal(start(retry, ID(9)).phase, 'sending', 'the same attempt, the same id');
  assert.equal(start(retry, ID(10)).phase, 'confirming');
  const uncertain = m.createInitialState({ ...attempt, kind: 'uncertain' });
  assert.equal(uncertain.result.kind, 'uncertain');
  assert.equal(apply(uncertain, { type: 'retry_requested' }), uncertain);
  assert.equal(m.createInitialState({ ...attempt, kind: 'pending' }).result.kind, 'pending');
  assert.equal(gateOf(s).reason, 'unresolved_attempt');
  assert.equal(apply(s, { type: 'unresolved_acknowledged' }).phase, 'editing');
  assert.equal(apply(s, { type: 'reset' }).unresolved, null);
});

// ---- send gate -----------------------------------------------------------------------------------------------------------

test('gate: the first failing condition names the reason (in a fixed order)', () => {
  const ready = consented();
  assert.deepEqual(gateOf(ready), { allowed: true });
  assert.equal(gateOf(ready, { signedIn: false }).reason, 'not_signed_in');
  for (const dataStatus of ['loading', 'blocked', 'unavailable']) assert.equal(gateOf(ready, { dataStatus }).reason, 'data_not_ready', dataStatus);
  assert.equal(gateOf(ready, { account: null }).reason, 'no_account');
  assert.equal(gateOf(ready, { account: account('X_B') }).reason, 'no_account', 'the account is not the chosen one');
  assert.equal(gateOf(ready, { account: account('X_A', { platform: 'threads' }) }).reason, 'no_account', 'not an X account');
  assert.equal(gateOf(ready, { account: account('X_A', { connectionStatus: 'needs_attention' }) }).reason, 'account_needs_attention');
  assert.equal(gateOf(ready, { account: account('X_A', { connectionStatus: 'not_connected' }) }).reason, 'account_not_connected');
  assert.equal(gateOf(start(ready)).reason, 'sending');
  for (const reason of Object.keys(m.SEND_BLOCK_MESSAGES)) assert.ok(m.SEND_BLOCK_MESSAGES[reason].length > 0, reason);
  assert.equal(Object.keys(m.SEND_BLOCK_MESSAGES).length, 20);
});

test('gate: draft problems block the send even with a ready port and a consent', () => {
  const withDraft = (text) => ({ ...consented(), draft: text });
  assert.equal(gateOf(withDraft('')).reason, 'draft_empty');
  assert.equal(gateOf(withDraft('a\u0000')).reason, 'draft_invalid');
  assert.equal(gateOf(withDraft('あ'.repeat(141))).reason, 'draft_too_long');
});

test('gate: no consent, no send -- and a consent for other text or another account is no consent', () => {
  assert.equal(gateOf(confirming()).reason, 'consent_missing');
  assert.equal(gateOf({ ...consented('abc'), draft: 'abd' }).reason, 'consent_missing');
  assert.equal(gateOf({ ...consented(), consent: { accountId: 'X_B', contentSha256: sha('こんにちは') } }).reason, 'consent_missing');
  assert.equal(gateOf(apply(consented(), { type: 'consent_changed', checked: false })).reason, 'consent_missing');
});

test('gate: an account id the server would refuse (not [A-Za-z0-9_:-]{1,128}) blocks the send locally', () => {
  const odd = apply(m.createInitialState(), { type: 'account_selected', accountId: 'a b' });
  assert.equal(gateOf(odd, { account: account('a b') }).reason, 'account_id_invalid');
  assert.equal(gateOf(odd, { account: account('x'.repeat(129)) }).reason, 'no_account');
});

test('gate: a cached "connected" value never allows a send -- only a fresh, same-account `ready` answer does', () => {
  const connectedAccount = account('X_A', { connectionStatus: 'connected' });
  const base = apply(m.createInitialState(), { type: 'account_selected', accountId: 'X_A' }, { type: 'draft_changed', text: 'hi' }, { type: 'confirm_opened' }, { type: 'consent_changed', checked: true });
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

test('target: the idempotency key is the attempt id; a text-only X target with a matching consent is the only shape', () => {
  const consent = { confirmed: true, contentSha256: sha('hi') };
  const t = m.buildTarget(ID(1), 'X_A', 'hi', consent);
  assert.deepEqual(t, { targetId: ID(1), provider: 'x', connectedAccountId: 'X_A', renderedText: 'hi', media: [], consent });
  assert.equal(m.targetIsSendable(t), true);
  assert.equal(m.targetIsSendable({ ...t, renderedText: '   ' }), false);
  assert.equal(m.targetIsSendable({ ...t, provider: 'threads' }), false);
  assert.equal(m.targetIsSendable({ ...t, media: [{ assetId: 'a', kind: 'image' }] }), false);
  assert.equal(m.targetIsSendable({ ...t, targetId: 'req-1' }), false, 'the attempt id must be a UUID');
  assert.equal(m.targetIsSendable({ ...t, consent: { confirmed: true, contentSha256: sha('other') } }), false, 'consent for other text');
  assert.equal(m.targetIsSendable({ ...t, consent: { confirmed: false, contentSha256: sha('hi') } }), false);
  assert.equal(m.targetIsSendable({ ...t, renderedText: 'hi ' }), false, 'one extra space changes the hash');
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
  assert.equal(surface({ state: start(consented()) }), 'sending');
  for (const state of [init, confirming(), consented()]) assert.notEqual(surface({ state }), 'sent');
  const cases = [
    [{ kind: 'published', marks: REAL, providerPostId: '1' }, 'sent'],
    [{ kind: 'pending', code: null }, 'pending'],
    [{ kind: 'rejected', code: 'X_REJECTED_400' }, 'failed'],
    [{ kind: 'refused', code: 'AUTH_REQUIRED', retryable: true }, 'refused'],
    [{ kind: 'unavailable', code: null }, 'unconfirmed'],
    [{ kind: 'uncertain', code: 'X_TIMEOUT' }, 'uncertain'],
  ];
  for (const [outcome, label] of cases) {
    assert.equal(surface({ state: settle(start(consented()), { targetId: ID(1), ...outcome }) }), label, label);
  }
});

// ---- N1: the "same attempt again" sentence belongs to a real re-ask only ------------------------------------------------------------------

test('N1: `retrying` is true only while a send RE-ASKS an unresolved attempt (same id); a first send is not a retry', () => {
  const first = start(consented('hello'));
  assert.equal(first.phase, 'sending');
  assert.equal(first.unresolved.kind, 'in_flight', 'a first send is in flight too');
  assert.equal(first.retrying, false);
  const pending = settle(first, { kind: 'pending', targetId: ID(1), code: null, marks: REAL });
  assert.equal(pending.retrying, false, 'settled');
  const retry = apply(pending, { type: 'retry_requested' }, { type: 'readiness_received', record: READY('X_A', 1_000) }, { type: 'consent_changed', checked: true });
  assert.equal(retry.retrying, false, 'confirming the retry is not yet sending');
  const again = start(retry, ID(1));
  assert.equal(again.phase, 'sending');
  assert.equal(again.retrying, true);
  assert.equal(again.unresolved.kind, 'in_flight');
  const done = settle(again, { kind: 'published', targetId: ID(1), providerPostId: '1', marks: REAL });
  assert.equal(done.retrying, false);
  assert.equal(m.createInitialState().retrying, false);
  assert.equal(m.createInitialState({ accountId: 'X_A', requestId: ID(9), contentSha256: 'a'.repeat(64), text: null, kind: 'pending' }).retrying, false);
});
