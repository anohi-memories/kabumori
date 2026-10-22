// Pure model of the manual X single post screen (F1, source-only): the draft, the account choice, the explicit
// consent, the state machine and the send gate. No React, network, storage or clock of its own (time is passed in).
//
// The rules that shape everything here:
//  1. The screen may OFFER a send only when (a) a fresh, account-bound answer from the send port says `ready`
//     and (b) the user ticked the explicit consent for THIS exact text. Cached display values
//     (SocialAccount.connectionStatus, a previous screen, the session alone) can only BLOCK a send.
//  2. Nothing is shown as sent unless the port returned `published`.
//  3. The attempt id (the server's idempotency key) belongs to ONE attempt: the same account + the same exact
//     text. A retry of an unresolved attempt reuses it; a new attempt gets a new one; it is never shared.
//  4. Unknown is never "not posted": `pending` and `unconfirmed` (F3 `unavailable`) may still be in flight on
//     the server and `uncertain` may have posted, so none of them lets a DIFFERENT attempt be sent. `pending`
//     and `unconfirmed` may only be retried with the SAME id (the server never sends twice for one id);
//     `uncertain` is never resent.
//  5. An unresolved attempt also survives an app restart -- but only as a hash-only record (manual-publish-store.ts):
//     the text is gone, so a restored attempt can only be re-asked by typing the SAME text again (its hash must
//     match), with the SAME id. While the record is being read, or cannot be read, nothing can be sent.
//     A local record is never proof that something was, or was not, posted.
//  6. A result is shown as a real post only when the server marked it `simulated: false` (a missing mark is a
//     test result). A simulated `published` is kept as UNRESOLVED (`uncertain`): it proves nothing about X, so no
//     other text is offered until the user has looked at X. `afterFreeze` only adds a note: it never turns a
//     pending / uncertain / failed result into a success.

import { X_STANDARD_WEIGHTED_LIMIT, xWeightedLength } from '../../domain/schedule-planner.ts';
import type { SocialAccount } from '../../domain/types.ts';
import { sha256Hex } from './manual-publish-hash.ts';
import {
  READINESS_MAX_AGE_MS,
  type ManualPublishConsent,
  type ManualPublishOutcome,
  type ManualPublishTarget,
  type ReadinessRecord,
  type ResultMarks,
} from './manual-publish-port.ts';
import { ACCOUNT_RE, CODE_RE, POST_ID_RE, UUID_RE } from './single-post-contract.ts';

export const MANUAL_PUBLISH_TEXT_LIMIT = X_STANDARD_WEIGHTED_LIMIT;

// ---- draft ---------------------------------------------------------------------------------------------------

export type DraftCheck =
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'invalid_characters' }>
  | Readonly<{ kind: 'too_long'; used: number; limit: number }>
  | Readonly<{ kind: 'ok'; text: string; used: number; limit: number }>;

/**
 * What would actually be sent: line endings unified and surrounding whitespace removed -- ONCE, before the
 * confirmation. From then on the confirmation, the consent hash and the request carry this exact string.
 */
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

/** What an attempt came to, in the vocabulary of the screen. */
export type AttemptResult =
  | Readonly<{ kind: 'sent'; requestId: string; providerPostId: string; marks: ResultMarks }>
  | Readonly<{ kind: 'simulated'; requestId: string; marks: ResultMarks }>
  | Readonly<{ kind: 'failed'; requestId: string; code: string; marks: ResultMarks | null }>
  | Readonly<{ kind: 'refused'; requestId: string; code: string; retryable: boolean }>
  | Readonly<{ kind: 'pending'; requestId: string; code: string | null; marks: ResultMarks | null }>
  | Readonly<{ kind: 'unconfirmed'; requestId: string; code: string | null }>
  | Readonly<{ kind: 'uncertain'; requestId: string; code: string; marks: ResultMarks | null }>;

export type UnresolvedKind = 'in_flight' | 'pending' | 'unconfirmed' | 'uncertain';

/**
 * An attempt whose outcome is not known to be "not posted". It carries everything needed to retry the SAME
 * attempt (id, account, the exact text and its hash) and survives leaving the screen (process-local memory).
 */
export type UnresolvedAttempt = Readonly<{
  accountId: string;
  requestId: string;
  contentSha256: string;
  /** The exact text, or null when the attempt was restored after an app restart (only its hash is kept on the device). */
  text: string | null;
  kind: UnresolvedKind;
}>;

/** The durable record of unresolved attempts: being read, readable (nothing or a record found), or NOT readable. */
export type StoreStatus =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'unreadable'; reason: 'io' | 'corrupt' | 'version' }>;

/** The explicit consent the user gave for THIS text and account. It carries no authority beyond the hash it names. */
export type ConsentRecord = Readonly<{ accountId: string; contentSha256: string }>;

export type ManualPublishPhase = 'editing' | 'confirming' | 'sending' | 'result';

export type ManualPublishState = Readonly<{
  draft: string;
  accountId: string | null;
  phase: ManualPublishPhase;
  readiness: ReadinessRecord | null;
  consent: ConsentRecord | null;
  requestId: string | null;
  result: AttemptResult | null;
  unresolved: UnresolvedAttempt | null;
  store: StoreStatus;
  /** Whether the stored draft of an earlier visit has been looked at yet (it is looked at once, never again). */
  draftRestore: 'pending' | 'done';
  /** True only while a send is under way that RE-ASKS an unresolved attempt (same id); false for a first send. */
  retrying: boolean;
}>;

export const UNRESOLVED_FROM_EARLIER_VISIT = 'UNRESOLVED_FROM_EARLIER_VISIT';
export const UNRESOLVED_AFTER_RESTART = 'UNRESOLVED_AFTER_RESTART';
const STORE_READY: StoreStatus = Object.freeze({ kind: 'ready' as const });

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** A code from a port is shown only if it is a stable machine code; anything else becomes a fixed one. */
function safeCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && CODE_RE.test(value) ? value : fallback;
}
function safeNullableCode(value: unknown): string | null {
  return typeof value === 'string' && CODE_RE.test(value) ? value : null;
}

export function createInitialState(unresolved: UnresolvedAttempt | null = null, store: StoreStatus = STORE_READY): ManualPublishState {
  if (unresolved) {
    // A visit that begins with an unresolved attempt shows what is known: a send that was still in flight when the
    // user left (or the app was closed) is `unconfirmed` (same id may be retried; the server never sends twice).
    const kind = unresolved.kind === 'in_flight' ? 'unconfirmed' : unresolved.kind;
    const code = unresolved.text === null ? UNRESOLVED_AFTER_RESTART : UNRESOLVED_FROM_EARLIER_VISIT;
    // What the server said about the marks is not kept on the device (only the kind is), so a restored result has none.
    const result: AttemptResult = kind === 'uncertain'
      ? { kind: 'uncertain', requestId: unresolved.requestId, code, marks: null }
      : kind === 'pending'
        ? { kind: 'pending', requestId: unresolved.requestId, code, marks: null }
        : { kind: 'unconfirmed', requestId: unresolved.requestId, code };
    return {
      draft: unresolved.text ?? '',
      accountId: unresolved.accountId,
      phase: 'result',
      readiness: null,
      consent: null,
      requestId: unresolved.requestId,
      result,
      unresolved: { ...unresolved, kind },
      store: STORE_READY,
      draftRestore: 'done', // an unresolved attempt shows its own result; no draft is put in front of it
      retrying: false,
    };
  }
  return { draft: '', accountId: null, phase: 'editing', readiness: null, consent: null, requestId: null, result: null, unresolved: null, store, draftRestore: 'pending', retrying: false };
}

/**
 * The marks of a port answer. Only an explicit `simulated: false` is "real" and only an explicit
 * `afterFreeze: true` is "after the freeze": a missing, partial or malformed mark is the cautious reading.
 */
export function marksOf(outcome: ManualPublishOutcome): ResultMarks {
  const marks = (outcome as { marks?: unknown }).marks;
  const given = typeof marks === 'object' && marks !== null ? (marks as { simulated?: unknown; afterFreeze?: unknown }) : {};
  return { simulated: given.simulated !== false, afterFreeze: given.afterFreeze === true };
}

/**
 * The state of a screen that opens WHILE a send of this process is still out (the screen that started it was left or
 * re-created). It is "sending", exactly as the screen that started it would show: no result is invented, no re-ask or
 * other send is offered, and the real answer is applied through `send_settled` when the send ends.
 */
export function createSendingState(attempt: UnresolvedAttempt & Readonly<{ text: string }>, retrying = false): ManualPublishState {
  return {
    draft: attempt.text,
    accountId: attempt.accountId,
    phase: 'sending',
    readiness: null,
    consent: null,
    requestId: attempt.requestId,
    result: null,
    unresolved: { ...attempt, kind: 'in_flight' },
    store: STORE_READY,
    draftRestore: 'done',
    retrying,
  };
}

/**
 * The only mapping from a port answer to something the user is shown. Anything that does not clearly prove what
 * it claims (wrong target id, a post id that is not a number) is `uncertain`, never `sent`.
 */
export function resultOf(requestId: string, outcome: ManualPublishOutcome): AttemptResult {
  if (outcome.targetId !== requestId) return { kind: 'uncertain', requestId, code: 'OUTCOME_TARGET_MISMATCH', marks: null };
  switch (outcome.kind) {
    case 'published': {
      const marks = marksOf(outcome);
      if (typeof outcome.providerPostId !== 'string' || !POST_ID_RE.test(outcome.providerPostId)) return { kind: 'uncertain', requestId, code: 'OUTCOME_INVALID', marks };
      // A test result is not a post: it never reaches `sent`.
      return marks.simulated ? { kind: 'simulated', requestId, marks } : { kind: 'sent', requestId, providerPostId: outcome.providerPostId, marks };
    }
    case 'rejected':
      return { kind: 'failed', requestId, code: safeCode(outcome.code, 'FAILED'), marks: marksOf(outcome) };
    case 'refused':
      return { kind: 'refused', requestId, code: safeCode(outcome.code, 'REFUSED'), retryable: outcome.retryable === true };
    case 'pending':
      return { kind: 'pending', requestId, code: safeNullableCode(outcome.code), marks: marksOf(outcome) };
    case 'unavailable':
      return { kind: 'unconfirmed', requestId, code: safeNullableCode(outcome.code) };
    case 'uncertain':
      return { kind: 'uncertain', requestId, code: safeCode(outcome.code, 'UNCERTAIN'), marks: marksOf(outcome) };
    default:
      return { kind: 'uncertain', requestId, code: 'OUTCOME_UNKNOWN_KIND', marks: null };
  }
}

export type ManualPublishAction =
  | Readonly<{ type: 'draft_changed'; text: string }>
  | Readonly<{ type: 'account_selected'; accountId: string }>
  | Readonly<{ type: 'accounts_changed'; accountIds: readonly string[] }>
  | Readonly<{ type: 'confirm_opened' }>
  | Readonly<{ type: 'confirm_closed' }>
  | Readonly<{ type: 'consent_changed'; checked: boolean }>
  | Readonly<{ type: 'readiness_received'; record: ReadinessRecord }>
  | Readonly<{ type: 'send_started'; requestId: string; now: number }>
  | Readonly<{ type: 'send_settled'; requestId: string; outcome: ManualPublishOutcome }>
  | Readonly<{ type: 'retry_requested' }>
  | Readonly<{ type: 'result_dismissed' }>
  | Readonly<{ type: 'unresolved_acknowledged' }>
  | Readonly<{ type: 'draft_restored'; text: string | null; accountId: string | null }>
  | Readonly<{ type: 'store_loaded'; unresolved: UnresolvedAttempt | null }>
  | Readonly<{ type: 'send_adopted'; attempt: UnresolvedAttempt & Readonly<{ text: string }>; retrying: boolean }>
  | Readonly<{ type: 'send_not_started'; requestId: string; attempt: UnresolvedAttempt }>
  | Readonly<{ type: 'store_unreadable'; reason: 'io' | 'corrupt' | 'version' }>
  | Readonly<{ type: 'store_reload_requested' }>
  | Readonly<{ type: 'store_unreadable_acknowledged' }>
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

/** Pending and unconfirmed attempts may be retried -- with the SAME id. Uncertain ones never. */
export function mayRetrySameId(kind: UnresolvedKind): boolean {
  return kind === 'pending' || kind === 'unconfirmed';
}

/**
 * May this attempt, AS THE PROCESS KNOWS IT NOW, be re-asked? The same rule as `mayRetrySameId`, applied to the attempt itself:
 * a screen's own state can be older than the attempt (another screen of the same user may have turned a pending attempt into an
 * uncertain one). An attempt that was out when the process was left is shown -- and re-asked -- as unconfirmed.
 */
export function mayRetryAttempt(attempt: Readonly<{ kind: UnresolvedKind }>): boolean {
  return mayRetrySameId(attempt.kind === 'in_flight' ? 'unconfirmed' : attempt.kind);
}

/**
 * The consent as the port wants it, or null. Valid only for the exact current text of the chosen account: the
 * hash is recomputed from the draft here, so a stale or forged record can never be passed on.
 */
export function consentForSend(state: ManualPublishState): ManualPublishConsent | null {
  const draft = checkDraft(state.draft);
  if (draft.kind !== 'ok' || state.consent === null || state.accountId === null) return null;
  if (state.consent.accountId !== state.accountId) return null;
  const sha = sha256Hex(draft.text);
  return state.consent.contentSha256 === sha ? { confirmed: true, contentSha256: sha } : null;
}

/** In a retry the attempt is the unresolved one: same account, same exact text. */
function isRetryContext(state: ManualPublishState): boolean {
  const unresolved = state.unresolved;
  if (unresolved === null || state.phase !== 'confirming' || !mayRetrySameId(unresolved.kind)) return false;
  const draft = checkDraft(state.draft);
  return draft.kind === 'ok' && unresolved.accountId === state.accountId && unresolved.contentSha256 === sha256Hex(draft.text);
}

export function manualPublishReducer(state: ManualPublishState, action: ManualPublishAction): ManualPublishState {
  switch (action.type) {
    case 'draft_changed':
      if (state.store.kind !== 'ready') return state;
      // The one place the text may be typed outside the editor: re-entering the text of a restored attempt, which
      // is only ever compared to the stored hash. Whatever consent existed belongs to the old text.
      if (state.phase === 'confirming' && state.unresolved !== null && state.unresolved.text === null) return { ...state, draft: action.text, consent: null };
      return state.phase === 'editing' ? { ...state, draft: action.text } : state;
    case 'account_selected':
      if (state.store.kind !== 'ready') return state;
      if (state.phase !== 'editing' || action.accountId === '' || action.accountId === state.accountId) return state;
      return { ...state, accountId: action.accountId, readiness: null, consent: null };
    case 'accounts_changed': {
      if (state.accountId === null || action.accountIds.includes(state.accountId)) return state;
      // The chosen account is no longer in the list (switch / disconnect / other workspace). Never keep it.
      if (state.phase === 'sending' || state.phase === 'result') return state;
      if (state.unresolved !== null) return state; // a retry of an unresolved attempt stays bound to its account
      return { ...state, accountId: null, readiness: null, consent: null, phase: 'editing' };
    }
    case 'confirm_opened':
      if (state.store.kind !== 'ready') return state;
      if (state.phase !== 'editing' || state.accountId === null || state.unresolved !== null) return state;
      if (checkDraft(state.draft).kind !== 'ok') return state;
      return { ...state, phase: 'confirming', readiness: null, consent: null };
    case 'confirm_closed':
      if (state.phase !== 'confirming') return state;
      // Leaving the confirmation of a retry returns to the unresolved result; it never opens the editor.
      return { ...state, phase: state.unresolved !== null ? 'result' : 'editing', readiness: null, consent: null };
    case 'consent_changed': {
      if (state.phase !== 'confirming') return state;
      if (!action.checked) return { ...state, consent: null };
      const draft = checkDraft(state.draft);
      if (draft.kind !== 'ok' || state.accountId === null) return state;
      return { ...state, consent: { accountId: state.accountId, contentSha256: sha256Hex(draft.text) } };
    }
    case 'readiness_received':
      if (state.phase !== 'confirming' || action.record.accountId !== state.accountId) return state;
      return { ...state, readiness: action.record };
    case 'send_started': {
      if (state.store.kind !== 'ready') return state;
      if (state.phase !== 'confirming' || !isRequestId(action.requestId) || state.accountId === null) return state;
      if (!ACCOUNT_RE.test(state.accountId)) return state;
      const draft = checkDraft(state.draft);
      if (draft.kind !== 'ok') return state;
      const consent = consentForSend(state);
      if (consent === null) return state;
      if (!readinessIsFresh(state.readiness, state.accountId, action.now)) return state;
      if (state.unresolved !== null) {
        // Only a retry of the SAME attempt may start, and only with the SAME id.
        if (!isRetryContext(state) || action.requestId !== state.unresolved.requestId) return state;
      }
      return {
        ...state,
        phase: 'sending',
        retrying: state.unresolved !== null, // read BEFORE `unresolved` is replaced by this send's own in-flight record
        requestId: action.requestId,
        result: null,
        unresolved: { accountId: state.accountId, requestId: action.requestId, contentSha256: consent.contentSha256, text: draft.text, kind: 'in_flight' },
      };
    }
    case 'send_settled': {
      if (state.phase !== 'sending' || state.requestId !== action.requestId || state.unresolved === null) return state;
      const result = resultOf(action.requestId, action.outcome);
      // A simulated `published` proves nothing about X: it stays unresolved, as `uncertain` (never resent).
      const unresolvedKind: UnresolvedKind | null =
        result.kind === 'pending' ? 'pending'
          : result.kind === 'unconfirmed' ? 'unconfirmed'
            : result.kind === 'uncertain' || result.kind === 'simulated' ? 'uncertain'
              : null;
      return {
        ...state,
        retrying: false,
        phase: 'result',
        result,
        readiness: null,
        consent: null,
        draft: result.kind === 'sent' ? '' : state.draft,
        unresolved: unresolvedKind === null ? null : { ...state.unresolved, kind: unresolvedKind },
      };
    }
    case 'retry_requested': {
      const kind = state.unresolved?.kind;
      if (state.phase !== 'result' || state.result === null || kind === undefined || !mayRetrySameId(kind)) return state;
      if (state.result.kind !== 'pending' && state.result.kind !== 'unconfirmed') return state;
      // Back to the confirmation of the SAME attempt: a fresh readiness and a fresh explicit consent are needed.
      return { ...state, phase: 'confirming', readiness: null, consent: null };
    }
    case 'result_dismissed':
      // Only a proven end (sent / failed / refused) can be left this way.
      if (state.phase !== 'result' || state.result === null || state.unresolved !== null) return state;
      return { ...state, phase: 'editing', result: null, requestId: null, readiness: null, consent: null };
    case 'unresolved_acknowledged':
      if (state.phase !== 'result' || state.unresolved === null) return state;
      return { ...state, draft: '', phase: 'editing', result: null, requestId: null, readiness: null, consent: null, unresolved: null };
    case 'draft_restored': {
      // The stored draft of an earlier visit is looked at ONCE. It is put into the editor only while the editor is
      // untouched (no text typed, nothing unresolved, record readable); it never carries a consent or a confirmation.
      if (state.draftRestore !== 'pending' || state.store.kind !== 'ready') return state;
      const done: ManualPublishState = { ...state, draftRestore: 'done' };
      if (action.text === null || action.text.trim() === '' || state.phase !== 'editing' || state.unresolved !== null || state.draft !== '') return done;
      if (action.accountId !== null && !ACCOUNT_RE.test(action.accountId)) return done;
      return { ...done, draft: action.text, accountId: action.accountId ?? state.accountId, readiness: null, consent: null };
    }
    case 'store_loaded':
      // Only the answer to the read this visit started; the state is untouched until then (every input is blocked).
      if (state.store.kind !== 'loading') return state;
      return action.unresolved === null ? { ...state, store: STORE_READY } : createInitialState(action.unresolved);
    case 'send_not_started':
      // The re-ask was refused before anything was sent because the process knows the attempt in a state this screen had not
      // seen (another screen moved it on, e.g. pending -> uncertain). The screen is brought to the attempt as it is NOW -- the
      // same view a screen opened later would show -- never to what it believed and never to a downgraded kind.
      if (state.phase !== 'sending' || state.requestId !== action.requestId) return state;
      return createInitialState(action.attempt);
    case 'send_adopted':
      // A send of this process began while this visit was still reading the record of the device: that record is the
      // send's own, not an earlier run's. Only a visit that is still loading (nothing typed, nothing sendable) switches.
      if (state.store.kind !== 'loading') return state;
      return createSendingState(action.attempt, action.retrying);
    case 'store_unreadable':
      if (state.store.kind !== 'loading') return state;
      return { ...state, store: { kind: 'unreadable', reason: action.reason } };
    case 'store_reload_requested':
      return state.store.kind === 'unreadable' ? { ...state, store: { kind: 'loading' } } : state;
    case 'store_unreadable_acknowledged':
      // The caller has already cleared the record. An I/O failure is never acknowledged away: it can only be re-read.
      if (state.store.kind !== 'unreadable' || state.store.reason === 'io') return state;
      return { ...state, store: STORE_READY };
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
  | 'demo_data'
  | 'no_account'
  | 'account_id_invalid'
  | 'sending'
  | 'unresolved_attempt'
  | 'restored_text_mismatch'
  | 'store_loading'
  | 'store_unreadable'
  | 'account_needs_attention'
  | 'account_not_connected'
  | 'draft_empty'
  | 'draft_invalid'
  | 'draft_too_long'
  | 'consent_missing'
  | 'readiness_unchecked'
  | 'port_not_connected'
  | 'port_unavailable'
  | 'readiness_stale'
  | 'readiness_other_account';

export type SendGate = Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: SendBlockReason }>;

export const SEND_BLOCK_MESSAGES: Readonly<Record<SendBlockReason, string>> = Object.freeze({
  not_signed_in: 'ログインを確認できないため、送信できません。',
  data_not_ready: 'アカウント情報を確認できないため、送信できません。',
  demo_data: 'デモ用（ローカルプレビュー）のデータのため、送信できません。',
  no_account: '投稿先のXアカウントを選んでください。',
  account_id_invalid: 'このアカウントのIDを送信できる形式で確認できないため、送信できません。',
  sending: '送信中です。結果が出るまでお待ちください。',
  unresolved_attempt: '前回の送信結果が確認できていません。結果を確認するまで、別の内容は送信できません。',
  restored_text_mismatch: 'アプリを再起動したため、前回の本文は残っていません。前回と同じ本文を入力すると、同じ送信IDで確認し直せます。',
  store_loading: '前回の送信記録を確認しています。確認できるまで、送信できません。',
  store_unreadable: '前回の送信記録を読み込めないため、送信できません。Xで最近の投稿を確認してから、続けてください。',
  account_needs_attention: 'このアカウントはXとの接続の確認が必要です。再接続してから送信してください。',
  account_not_connected: 'このアカウントはXに接続されていません。',
  draft_empty: '本文を入力してください。',
  draft_invalid: '使えない文字が含まれているため、送信できません。',
  draft_too_long: '本文がXの文字数の上限を超えています。',
  consent_missing: '「この内容を、いま、Xに投稿することに同意します」にチェックを入れると送信できます。',
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
  if (state.store.kind === 'loading') return block('store_loading');
  if (state.store.kind === 'unreadable') return block('store_unreadable');
  // Only real, loaded data can ever lead to a send. Demo (mock_preview) data has made-up accounts: it may be typed into and
  // previewed, but never sent -- whatever the send port says. Any other value (loading, blocked, unavailable, or one this
  // code does not know) is "not ready" too: the test is strict equality with `ready`, not a list of bad values.
  if (input.dataStatus === 'mock_preview') return block('demo_data');
  if (input.dataStatus !== 'ready') return block('data_not_ready');
  if (input.account === null || input.account.platform !== 'x' || state.accountId !== input.account.id) return block('no_account');
  if (!ACCOUNT_RE.test(input.account.id)) return block('account_id_invalid');
  if (state.phase === 'sending') return block('sending');
  if (state.unresolved !== null && !isRetryContext(state)) {
    const waitingForText = state.phase === 'confirming' && state.unresolved.text === null && mayRetrySameId(state.unresolved.kind);
    return block(waitingForText ? 'restored_text_mismatch' : 'unresolved_attempt');
  }
  if (input.account.connectionStatus === 'needs_attention') return block('account_needs_attention');
  if (input.account.connectionStatus === 'not_connected') return block('account_not_connected');
  const draft = checkDraft(state.draft);
  if (draft.kind === 'empty') return block('draft_empty');
  if (draft.kind === 'invalid_characters') return block('draft_invalid');
  if (draft.kind === 'too_long') return block('draft_too_long');
  if (consentForSend(state) === null) return block('consent_missing');
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
export function buildTarget(requestId: string, accountId: string, text: string, consent: ManualPublishConsent): ManualPublishTarget {
  return { targetId: requestId, provider: 'x', connectedAccountId: accountId, renderedText: text, media: [], consent };
}

/** A text-only X post: the provider is X, there is text, no media, a UUID attempt id, and a consent for exactly this text. */
export function targetIsSendable(target: ManualPublishTarget): boolean {
  return (
    target.provider === 'x' &&
    isRequestId(target.targetId) &&
    target.renderedText.trim() !== '' &&
    target.media.length === 0 &&
    target.consent.confirmed === true &&
    target.consent.contentSha256 === sha256Hex(target.renderedText)
  );
}

// ---- what the screen shows -----------------------------------------------------------------------------------

export type Surface =
  | 'not_connected' | 'unavailable' | 'record_unchecked' | 'ready_to_preview' | 'sending'
  | 'sent' | 'simulated' | 'pending' | 'failed' | 'refused' | 'unconfirmed' | 'uncertain';

/**
 * One label for the situation. `sent` exists only after the port returned `published`; with the unconnected
 * port of this build it can never be reached.
 */
export function surfaceOf(input: Readonly<{ dataStatus: DataStatus; xAccountCount: number; account: SocialAccount | null; state: ManualPublishState }>): Surface {
  const { state } = input;
  if (state.phase === 'sending') return 'sending';
  if (state.phase === 'result' && state.result) return state.result.kind;
  if (state.store.kind !== 'ready') return 'record_unchecked';
  if (input.dataStatus !== 'ready' && input.dataStatus !== 'mock_preview') return 'unavailable';
  if (input.xAccountCount === 0) return 'not_connected';
  if (input.account && input.account.connectionStatus === 'not_connected') return 'not_connected';
  if (input.account && input.account.connectionStatus === 'needs_attention') return 'unavailable';
  return 'ready_to_preview';
}

/** First 12 hex digits of the consent hash, to show the user which exact text the consent is bound to. */
export function shortHash(contentSha256: string): string {
  return contentSha256.slice(0, 12);
}
