// Pure model of the manual X single post screen (F1, source-only): the draft, the account choice, the state
// machine and the send gate. No React, network, storage or clock of its own (time is passed in).
//
// Two rules shape everything here:
//  1. The screen may OFFER a send only when a fresh, account-bound answer from the send port says `ready`.
//     Cached display values (SocialAccount.connectionStatus, a previous screen, the session alone) can only
//     BLOCK a send, never allow one. The server decides again at send time.
//  2. Nothing is shown as sent unless the port returned `published`. An unknown outcome is never sent again.

import { X_STANDARD_WEIGHTED_LIMIT, xWeightedLength } from '../../domain/schedule-planner.ts';
import type { SocialAccount } from '../../domain/types.ts';
import { READINESS_MAX_AGE_MS, type ManualPublishOutcome, type ManualPublishTarget, type ReadinessRecord } from './manual-publish-port.ts';

export const MANUAL_PUBLISH_TEXT_LIMIT = X_STANDARD_WEIGHTED_LIMIT;

// ---- draft ---------------------------------------------------------------------------------------------------

export type DraftCheck =
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'invalid_characters' }>
  | Readonly<{ kind: 'too_long'; used: number; limit: number }>
  | Readonly<{ kind: 'ok'; text: string; used: number; limit: number }>;

/** What would actually be sent: line endings unified, surrounding whitespace removed, nothing else changed. */
export function normalizeDraft(raw: string): string {
  return raw.replace(/\r\n?/gu, '\n').trim();
}

function hasUnsendableCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // C0/C1 controls other than tab and line feed, DEL, and lone surrogates cannot be part of a post.
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) return true;
  }
  return false;
}

export function checkDraft(raw: string, limit: number = MANUAL_PUBLISH_TEXT_LIMIT): DraftCheck {
  const text = normalizeDraft(raw);
  if (text === '') return { kind: 'empty' };
  if (hasUnsendableCharacter(text)) return { kind: 'invalid_characters' };
  const used = xWeightedLength(text);
  if (used > limit) return { kind: 'too_long', used, limit };
  return { kind: 'ok', text, used, limit };
}

// ---- accounts ------------------------------------------------------------------------------------------------

/** Only X accounts of the CURRENT account list; other providers and other lists never match. */
export function xAccountsOf(accounts: readonly SocialAccount[]): SocialAccount[] {
  return accounts.filter((account) => account.platform === 'x');
}

export function resolveSelectedAccount(accounts: readonly SocialAccount[], accountId: string | null): SocialAccount | null {
  if (accountId === null) return null;
  return xAccountsOf(accounts).find((account) => account.id === accountId) ?? null;
}

// ---- state ---------------------------------------------------------------------------------------------------

export type AttemptResult =
  | Readonly<{ kind: 'sent'; requestId: string; providerPostId: string }>
  | Readonly<{ kind: 'failed'; requestId: string; code: string }>
  | Readonly<{ kind: 'uncertain'; requestId: string; code: string }>;

/** An attempt whose outcome the user has not acknowledged and that may have posted (or is still in flight). */
export type UnresolvedAttempt = Readonly<{ accountId: string; requestId: string }>;

export type ManualPublishPhase = 'editing' | 'confirming' | 'sending' | 'result';

export type ManualPublishState = Readonly<{
  draft: string;
  accountId: string | null;
  phase: ManualPublishPhase;
  readiness: ReadinessRecord | null;
  requestId: string | null;
  result: AttemptResult | null;
  unresolved: UnresolvedAttempt | null;
}>;

export const UNRESOLVED_FROM_EARLIER_VISIT = 'UNRESOLVED_FROM_EARLIER_VISIT';

export function createInitialState(unresolved: UnresolvedAttempt | null = null): ManualPublishState {
  if (unresolved) {
    return {
      draft: '',
      accountId: unresolved.accountId,
      phase: 'result',
      readiness: null,
      requestId: unresolved.requestId,
      result: { kind: 'uncertain', requestId: unresolved.requestId, code: UNRESOLVED_FROM_EARLIER_VISIT },
      unresolved,
    };
  }
  return { draft: '', accountId: null, phase: 'editing', readiness: null, requestId: null, result: null, unresolved: null };
}

/**
 * The only mapping from a port answer to something the user is shown. Anything that does not clearly prove a
 * publish (wrong target id, empty provider post id) is `uncertain`, never `sent`.
 */
export function resultOf(requestId: string, outcome: ManualPublishOutcome): AttemptResult {
  if (outcome.targetId !== requestId) return { kind: 'uncertain', requestId, code: 'OUTCOME_TARGET_MISMATCH' };
  switch (outcome.kind) {
    case 'published':
      return typeof outcome.providerPostId === 'string' && outcome.providerPostId.trim() !== ''
        ? { kind: 'sent', requestId, providerPostId: outcome.providerPostId }
        : { kind: 'uncertain', requestId, code: 'OUTCOME_INVALID' };
    case 'rejected':
      return { kind: 'failed', requestId, code: outcome.code };
    case 'uncertain':
      return { kind: 'uncertain', requestId, code: outcome.code };
    default:
      return { kind: 'uncertain', requestId, code: 'OUTCOME_UNKNOWN_KIND' };
  }
}

export type ManualPublishAction =
  | Readonly<{ type: 'draft_changed'; text: string }>
  | Readonly<{ type: 'account_selected'; accountId: string }>
  | Readonly<{ type: 'accounts_changed'; accountIds: readonly string[] }>
  | Readonly<{ type: 'confirm_opened' }>
  | Readonly<{ type: 'confirm_closed' }>
  | Readonly<{ type: 'readiness_received'; record: ReadinessRecord }>
  | Readonly<{ type: 'send_started'; requestId: string; now: number }>
  | Readonly<{ type: 'send_settled'; requestId: string; outcome: ManualPublishOutcome }>
  | Readonly<{ type: 'result_dismissed' }>
  | Readonly<{ type: 'uncertain_acknowledged' }>
  | Readonly<{ type: 'reset' }>;

/** Is this readiness record trustworthy for `accountId` at `now`? (`ready`, same account, fresh, not from the future.) */
export function readinessIsFresh(record: ReadinessRecord | null, accountId: string | null, now: number): boolean {
  return (
    record !== null &&
    accountId !== null &&
    record.accountId === accountId &&
    record.result.kind === 'ready' &&
    now >= record.checkedAt &&
    now - record.checkedAt <= READINESS_MAX_AGE_MS
  );
}

export function manualPublishReducer(state: ManualPublishState, action: ManualPublishAction): ManualPublishState {
  switch (action.type) {
    case 'draft_changed':
      return state.phase === 'editing' ? { ...state, draft: action.text } : state;
    case 'account_selected':
      if (state.phase !== 'editing' || action.accountId === '' || action.accountId === state.accountId) return state;
      return { ...state, accountId: action.accountId, readiness: null };
    case 'accounts_changed': {
      if (state.accountId === null || action.accountIds.includes(state.accountId)) return state;
      // The chosen account is no longer in the list (switch / disconnect / other workspace). Never keep it.
      if (state.phase === 'sending' || state.phase === 'result') return state;
      return { ...state, accountId: null, readiness: null, phase: 'editing' };
    }
    case 'confirm_opened':
      if (state.phase !== 'editing' || state.accountId === null || state.unresolved !== null) return state;
      if (checkDraft(state.draft).kind !== 'ok') return state;
      return { ...state, phase: 'confirming', readiness: null };
    case 'confirm_closed':
      return state.phase === 'confirming' ? { ...state, phase: 'editing', readiness: null } : state;
    case 'readiness_received':
      if (state.phase !== 'confirming' || action.record.accountId !== state.accountId) return state;
      return { ...state, readiness: action.record };
    case 'send_started': {
      if (state.phase !== 'confirming' || action.requestId === '' || state.unresolved !== null) return state;
      if (checkDraft(state.draft).kind !== 'ok') return state;
      if (!readinessIsFresh(state.readiness, state.accountId, action.now)) return state;
      return {
        ...state,
        phase: 'sending',
        requestId: action.requestId,
        result: null,
        unresolved: state.accountId === null ? null : { accountId: state.accountId, requestId: action.requestId },
      };
    }
    case 'send_settled': {
      if (state.phase !== 'sending' || state.requestId !== action.requestId) return state;
      const result = resultOf(action.requestId, action.outcome);
      return {
        ...state,
        phase: 'result',
        result,
        readiness: null,
        draft: result.kind === 'sent' ? '' : state.draft,
        unresolved: result.kind === 'uncertain' ? state.unresolved : null,
      };
    }
    case 'result_dismissed':
      // An uncertain result can only be left through `uncertain_acknowledged`.
      if (state.phase !== 'result' || state.result === null || state.result.kind === 'uncertain') return state;
      return { ...state, phase: 'editing', result: null, requestId: null, readiness: null };
    case 'uncertain_acknowledged':
      if (state.phase !== 'result' || state.result?.kind !== 'uncertain') return state;
      return { ...state, draft: '', phase: 'editing', result: null, requestId: null, readiness: null, unresolved: null };
    case 'reset':
      return createInitialState();
    default:
      return state;
  }
}

// ---- send gate -----------------------------------------------------------------------------------------------

export type DataStatus = 'mock_preview' | 'loading' | 'ready' | 'blocked' | 'unavailable';

export type SendBlockReason =
  | 'not_signed_in'
  | 'data_not_ready'
  | 'no_account'
  | 'sending'
  | 'unresolved_attempt'
  | 'account_needs_attention'
  | 'account_not_connected'
  | 'draft_empty'
  | 'draft_invalid'
  | 'draft_too_long'
  | 'readiness_unchecked'
  | 'port_not_connected'
  | 'port_unavailable'
  | 'readiness_stale'
  | 'readiness_other_account';

export type SendGate = Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: SendBlockReason }>;

export const SEND_BLOCK_MESSAGES: Readonly<Record<SendBlockReason, string>> = Object.freeze({
  not_signed_in: 'ログインを確認できないため、送信できません。',
  data_not_ready: 'アカウント情報を確認できないため、送信できません。',
  no_account: '投稿先のXアカウントを選んでください。',
  sending: '送信中です。結果が出るまでお待ちください。',
  unresolved_attempt: '前回の送信結果が確認できていません。Xで確認し、結果を確認済みにするまで新しい送信はできません。',
  account_needs_attention: 'このアカウントはXとの接続の確認が必要です。再接続してから送信してください。',
  account_not_connected: 'このアカウントはXに接続されていません。',
  draft_empty: '本文を入力してください。',
  draft_invalid: '使えない文字が含まれているため、送信できません。',
  draft_too_long: '本文がXの文字数の上限を超えています。',
  readiness_unchecked: '送信できる状態かを確認しています。',
  port_not_connected: '送信機能は接続されていません。このビルドでは、入力・プレビュー・送信前の確認のみ行えます。',
  port_unavailable: '送信できる状態を確認できませんでした。時間をおいてもう一度お試しください。',
  readiness_stale: '送信できる状態の確認が古くなりました。確認画面を開き直してください。',
  readiness_other_account: '確認時と投稿先が変わっています。確認画面を開き直してください。',
});

export type SendGateInput = Readonly<{
  now: number;
  signedIn: boolean;
  dataStatus: DataStatus;
  /** The selected X account from the CURRENT account list, or null. */
  account: SocialAccount | null;
  state: ManualPublishState;
}>;

/**
 * Whether the screen may OFFER the send. `allowed: true` only means "nothing here blocks it"; the server chain
 * still decides at send time. Cached values (`connectionStatus`) can block but never allow.
 */
export function sendGate(input: SendGateInput): SendGate {
  const { state } = input;
  const block = (reason: SendBlockReason): SendGate => ({ allowed: false, reason });
  if (!input.signedIn) return block('not_signed_in');
  if (input.dataStatus !== 'ready' && input.dataStatus !== 'mock_preview') return block('data_not_ready');
  if (input.account === null || input.account.platform !== 'x' || state.accountId !== input.account.id) return block('no_account');
  if (state.phase === 'sending') return block('sending');
  if (state.unresolved !== null) return block('unresolved_attempt');
  if (input.account.connectionStatus === 'needs_attention') return block('account_needs_attention');
  if (input.account.connectionStatus === 'not_connected') return block('account_not_connected');
  const draft = checkDraft(state.draft);
  if (draft.kind === 'empty') return block('draft_empty');
  if (draft.kind === 'invalid_characters') return block('draft_invalid');
  if (draft.kind === 'too_long') return block('draft_too_long');
  const record = state.readiness;
  if (record === null) return block('readiness_unchecked');
  if (record.accountId !== state.accountId) return block('readiness_other_account');
  if (record.result.kind === 'not_connected') return block('port_not_connected');
  if (record.result.kind === 'unavailable') return block('port_unavailable');
  if (!readinessIsFresh(record, state.accountId, input.now)) return block('readiness_stale');
  return { allowed: true };
}

// ---- target --------------------------------------------------------------------------------------------------

/** The provider-neutral target handed to the port. `targetId` is the idempotency key of this attempt. */
export function buildTarget(requestId: string, accountId: string, text: string): ManualPublishTarget {
  return { targetId: requestId, provider: 'x', connectedAccountId: accountId, renderedText: text, media: [] };
}

/** A text-only X post: the provider is X, there is text, and no media (this feature has none). */
export function targetIsSendable(target: ManualPublishTarget): boolean {
  return target.provider === 'x' && target.renderedText.trim() !== '' && target.media.length === 0;
}

// ---- what the screen shows -----------------------------------------------------------------------------------

export type Surface = 'not_connected' | 'unavailable' | 'ready_to_preview' | 'sending' | 'sent' | 'failed' | 'uncertain';

/**
 * One label for the situation. `sent` exists only after the port returned `published`; with the unconnected
 * port of this build it can never be reached.
 */
export function surfaceOf(input: Readonly<{ dataStatus: DataStatus; xAccountCount: number; account: SocialAccount | null; state: ManualPublishState }>): Surface {
  const { state } = input;
  if (state.phase === 'sending') return 'sending';
  if (state.phase === 'result' && state.result) return state.result.kind === 'sent' ? 'sent' : state.result.kind === 'failed' ? 'failed' : 'uncertain';
  if (input.dataStatus !== 'ready' && input.dataStatus !== 'mock_preview') return 'unavailable';
  if (input.xAccountCount === 0) return 'not_connected';
  if (input.account && input.account.connectionStatus === 'not_connected') return 'not_connected';
  if (input.account && input.account.connectionStatus === 'needs_attention') return 'unavailable';
  return 'ready_to_preview';
}
