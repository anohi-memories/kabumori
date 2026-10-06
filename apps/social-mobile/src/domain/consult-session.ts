/**
 * Pure logic for the consultation chat: what is sent, how an answer is read,
 * how the on-screen session moves, and what a confirmation is allowed to save.
 * No React, no network, no storage — the screen and the data client call into
 * this, and the tests exercise it directly.
 *
 * The rule the whole file protects: conversation -> proposal -> the user's
 * explicit confirmation -> save. Nothing here saves on an answer arriving.
 */
import type { PersonaProfile, SocialMobileContentSettings } from './content-settings.ts';
import {
  applyConfirmedConversationProposal,
  validateConversationalAssistantResult,
  type ConversationalAssistantResult,
} from './content-settings-conversation.ts';

export const CONSULT_FUNCTION = 'social-mobile-consult';

/** Mirrors the server's bounds; the server rejects anything larger rather than trimming it. */
export const CONSULT_LIMITS = { messageChars: 1000, historyTurns: 12, turnChars: 1000, historyTotalChars: 6000 } as const;

export type ConsultTurn = { role: 'user' | 'assistant'; text: string };
export type ConsultRequestBody = { brand_id: string; message: string; history: ConsultTurn[] };

/** The most recent turns that fit the bounds: newest kept, oldest dropped, long turns clipped. */
export function boundedConsultHistory(turns: readonly ConsultTurn[]): ConsultTurn[] {
  const kept: ConsultTurn[] = [];
  let total = 0;
  for (let index = turns.length - 1; index >= 0 && kept.length < CONSULT_LIMITS.historyTurns; index -= 1) {
    const text = turns[index].text.trim().slice(0, CONSULT_LIMITS.turnChars);
    if (!text) continue;
    if (total + text.length > CONSULT_LIMITS.historyTotalChars) break;
    total += text.length;
    kept.unshift({ role: turns[index].role, text });
  }
  return kept;
}

export type ConsultInputProblem = 'empty' | 'too_long';

export function consultInputProblem(message: string): ConsultInputProblem | null {
  const text = message.trim();
  if (!text) return 'empty';
  return text.length > CONSULT_LIMITS.messageChars ? 'too_long' : null;
}

/** Only the workspace selector, this message and bounded session turns ever leave the device. */
export function buildConsultRequest(input: { brandId: string; message: string; priorTurns: readonly ConsultTurn[] }): ConsultRequestBody {
  return { brand_id: input.brandId, message: input.message.trim(), history: boundedConsultHistory(input.priorTurns) };
}

export type ConsultFailure = { code: string; retryable: boolean; message: string };
export type ConsultOutcome = { ok: true; result: ConversationalAssistantResult } | { ok: false; error: ConsultFailure };

const ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'ログインの確認ができませんでした。ログインし直してから、もう一度お試しください。',
  OWNED_WORKSPACE_NOT_FOUND: 'このワークスペースでは相談できません。',
  SOCIAL_MOBILE_PROFILE_NOT_CONFIGURED: 'このワークスペースでは相談できません。',
  MESSAGE_REQUIRED: 'メッセージを入力してください。',
  MESSAGE_TOO_LONG: `メッセージは${CONSULT_LIMITS.messageChars}文字以内で入力してください。`,
  HISTORY_INVALID: '会話が長くなりました。新しい相談として、もう一度送ってください。',
  REQUEST_TOO_LARGE: '会話が長くなりました。新しい相談として、もう一度送ってください。',
  CONSULT_AI_TIMEOUT: 'AIの応答に時間がかかっています。もう一度お試しください。',
  CONSULT_AI_BUSY: 'AIが混み合っています。少し待ってから、もう一度お試しください。',
  CONSULT_AI_UNAVAILABLE: 'AIとの相談は、まだ利用できません。',
  CONSULT_CONFIGURATION_UNAVAILABLE: 'AIとの相談は、まだ利用できません。',
};
const GENERIC_ERROR = 'AIの応答を受け取れませんでした。もう一度お試しください。';
const NON_RETRYABLE = new Set(['OWNED_WORKSPACE_NOT_FOUND', 'SOCIAL_MOBILE_PROFILE_NOT_CONFIGURED', 'MESSAGE_REQUIRED', 'MESSAGE_TOO_LONG', 'CONSULT_AI_UNAVAILABLE', 'CONSULT_CONFIGURATION_UNAVAILABLE']);

export function consultFailure(code: string, retryable?: boolean): ConsultFailure {
  return { code, retryable: NON_RETRYABLE.has(code) ? false : retryable ?? true, message: ERROR_MESSAGES[code] ?? GENERIC_ERROR };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the endpoint's answer as untrusted data. Anything that is not a
 * success envelope wrapping a result the validator accepts becomes a safe,
 * retryable error: no proposal, nothing saved.
 */
export function parseConsultResponse(payload: unknown): ConsultOutcome {
  if (!isRecord(payload)) return { ok: false, error: consultFailure('CONSULT_RESPONSE_INVALID') };
  if (payload.success !== true) {
    const code = typeof payload.error === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(payload.error) ? payload.error : 'CONSULT_REQUEST_FAILED';
    return { ok: false, error: consultFailure(code, typeof payload.retryable === 'boolean' ? payload.retryable : undefined) };
  }
  // The endpoint is read-only. An envelope claiming otherwise is not one we act on.
  if (payload.settings_saved !== false || payload.publish_attempted !== false || payload.x_api_called !== false || payload.scheduled_post_created !== false) {
    return { ok: false, error: consultFailure('CONSULT_RESPONSE_INVALID') };
  }
  const result = validateConversationalAssistantResult(payload.result);
  return result ? { ok: true, result } : { ok: false, error: consultFailure('CONSULT_RESPONSE_INVALID') };
}

// ---------------------------------------------------------------------------
// What a proposal shows and what a confirmation may save
// ---------------------------------------------------------------------------

export function hasPersistentChange(result: ConversationalAssistantResult): boolean {
  return Object.keys(result.proposedSettingsDelta).length > 0 || Object.keys(result.proposedPersonaDelta).length > 0;
}

const SENTENCE_LENGTH_LABELS = { short: '短め', mixed: '長短まじり', long: '長め' } as const;
const joined = (items: readonly string[]) => (items.length ? items.join('、') : '（なし）');

export type ProposalRow = { key: string; label: string; value: string };

/** Only the fields the proposal changes, in a stable order, ready to render. */
export function proposalRows(result: ConversationalAssistantResult): ProposalRow[] {
  const s = result.proposedSettingsDelta;
  const p = result.proposedPersonaDelta;
  const rows: ProposalRow[] = [];
  if (s.preferredTone !== undefined) rows.push({ key: 'preferredTone', label: 'トーン', value: s.preferredTone });
  if (s.themes !== undefined) rows.push({ key: 'themes', label: 'テーマ', value: joined(s.themes) });
  if (s.objective !== undefined) rows.push({ key: 'objective', label: '投稿の目的', value: s.objective });
  if (s.frequencyTargetPerWeek !== undefined) rows.push({ key: 'frequencyTargetPerWeek', label: '週あたり', value: `${s.frequencyTargetPerWeek}回` });
  if (s.optionalNgWords !== undefined) rows.push({ key: 'optionalNgWords', label: '避けたい語句', value: joined(s.optionalNgWords) });
  if (s.notes !== undefined) rows.push({ key: 'notes', label: 'AIへの補足メモ', value: s.notes || '（なし）' });
  if (p.toneSignals !== undefined) rows.push({ key: 'toneSignals', label: '文体の特徴', value: joined(p.toneSignals) });
  if (p.sentenceLength !== undefined) rows.push({ key: 'sentenceLength', label: '文の長さ', value: SENTENCE_LENGTH_LABELS[p.sentenceLength] });
  if (p.punctuationEmoji !== undefined) rows.push({ key: 'punctuationEmoji', label: '記号・絵文字', value: p.punctuationEmoji });
  if (p.recurringVocabulary !== undefined) rows.push({ key: 'recurringVocabulary', label: 'よく使う言葉', value: joined(p.recurringVocabulary) });
  if (p.topicSignals !== undefined) rows.push({ key: 'topicSignals', label: '話題の傾向', value: joined(p.topicSignals) });
  if (p.hashtagHabits !== undefined) rows.push({ key: 'hashtagHabits', label: 'ハッシュタグ', value: p.hashtagHabits });
  if (p.ctaStyle !== undefined) rows.push({ key: 'ctaStyle', label: '呼びかけ方', value: p.ctaStyle });
  if (p.openingClosingPatterns !== undefined) rows.push({ key: 'openingClosingPatterns', label: '書き出し・締め', value: joined(p.openingClosingPatterns) });
  return rows;
}

export type SavedSnapshot = { settings: SocialMobileContentSettings; persona: PersonaProfile | null };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export type ConfirmedSavePlan =
  | { kind: 'nothing' }
  /** A field this proposal changes was itself changed after the proposal was shown. Ask again. */
  | { kind: 'reconfirm'; conflicts: string[] }
  | { kind: 'save'; settings: SocialMobileContentSettings; persona: PersonaProfile | null; personaChanged: boolean };

/**
 * Decides what an explicit confirmation saves. The delta is applied onto the
 * freshly re-read state, so unrelated newer values are kept. If a field the
 * delta touches changed since the proposal was shown, it does not overwrite:
 * the user is asked to confirm again against what is saved now.
 */
export function planConfirmedSave(input: { shownAgainst: SavedSnapshot; latest: SavedSnapshot; proposal: ConversationalAssistantResult }): ConfirmedSavePlan {
  const { shownAgainst, latest, proposal } = input;
  if (!hasPersistentChange(proposal)) return { kind: 'nothing' };
  const conflicts = [
    ...Object.keys(proposal.proposedSettingsDelta).filter((key) => !same((shownAgainst.settings as Record<string, unknown>)[key], (latest.settings as Record<string, unknown>)[key])),
    ...Object.keys(proposal.proposedPersonaDelta).filter((key) => !same((shownAgainst.persona as Record<string, unknown> | null)?.[key], (latest.persona as Record<string, unknown> | null)?.[key])),
  ];
  if (conflicts.length) return { kind: 'reconfirm', conflicts };
  const applied = applyConfirmedConversationProposal(latest.settings, latest.persona, proposal);
  // An out-of-contract merge leaves settings as they were; with no persona change there is then nothing to save.
  if (!applied.personaChanged && same(applied.settings, latest.settings)) return { kind: 'nothing' };
  return { kind: 'save', settings: applied.settings, persona: applied.persona, personaChanged: applied.personaChanged };
}

// ---------------------------------------------------------------------------
// The on-screen session
// ---------------------------------------------------------------------------

export type ConsultMessage = { id: string; role: 'assistant' | 'user'; text: string };
export type PendingProposal = { result: ConversationalAssistantResult; shownAgainst: SavedSnapshot };

export type ConsultState = {
  messages: ConsultMessage[];
  sending: boolean;
  /** The user turn that failed, kept so "retry" resends it without typing it again. */
  failed: { text: string; error: ConsultFailure } | null;
  pending: PendingProposal | null;
  /** The user asked to learn from past posts. Shows the consent gate only; nothing is fetched. */
  historyIntent: boolean;
  /** Result of the last confirmation, shown under the proposal or after it is saved. */
  notice: { tone: 'success' | 'warning'; text: string } | null;
  nextId: number;
};

export type ConsultEvent =
  | { type: 'send'; text: string }
  | { type: 'retry' }
  | { type: 'reply'; result: ConversationalAssistantResult; shownAgainst: SavedSnapshot }
  | { type: 'failed'; error: ConsultFailure }
  | { type: 'dismiss_proposal' }
  | { type: 'rebase_proposal'; shownAgainst: SavedSnapshot; text: string }
  | { type: 'saved'; text: string }
  | { type: 'save_failed'; text: string };

export function initialConsultState(greeting: readonly { role: 'assistant' | 'user'; text: string }[]): ConsultState {
  return {
    messages: greeting.map((item, index) => ({ id: `m${index}`, role: item.role, text: item.text })),
    sending: false,
    failed: null,
    pending: null,
    historyIntent: false,
    notice: null,
    nextId: greeting.length,
  };
}

/**
 * Turns to send with the next request: everything before the message being
 * sent. On a retry the failed user turn is already the last message, so it is
 * left out here and sent again as the message itself.
 */
export function priorTurns(state: ConsultState, retrying = false): ConsultTurn[] {
  const messages = retrying && state.failed ? state.messages.slice(0, -1) : state.messages;
  return messages.map((item) => ({ role: item.role, text: item.text }));
}

export function consultReducer(state: ConsultState, event: ConsultEvent): ConsultState {
  switch (event.type) {
    case 'send': {
      const text = event.text.trim();
      if (state.sending || consultInputProblem(text)) return state;
      return { ...state, sending: true, failed: null, notice: null, nextId: state.nextId + 1, messages: [...state.messages, { id: `m${state.nextId}`, role: 'user', text }] };
    }
    case 'retry':
      return state.failed && !state.sending ? { ...state, sending: true } : state;
    case 'failed': {
      if (!state.sending) return state;
      const last = state.messages[state.messages.length - 1];
      return { ...state, sending: false, failed: { text: last?.role === 'user' ? last.text : '', error: event.error } };
    }
    case 'reply': {
      if (!state.sending) return state;
      const changes = hasPersistentChange(event.result);
      return {
        ...state,
        sending: false,
        failed: null,
        nextId: state.nextId + 1,
        messages: [...state.messages, { id: `m${state.nextId}`, role: 'assistant', text: event.result.assistantReply }],
        // A newer proposal replaces the pending one (a correction wins). A plain answer or a
        // question leaves a pending proposal as it is, so the user can ask something and still confirm.
        pending: changes ? { result: event.result, shownAgainst: event.shownAgainst } : state.pending,
        historyIntent: state.historyIntent || event.result.historyLearningIntent.explicitConsent,
        notice: changes ? null : state.notice,
      };
    }
    case 'dismiss_proposal':
      return { ...state, pending: null, notice: null };
    case 'rebase_proposal':
      return state.pending ? { ...state, pending: { ...state.pending, shownAgainst: event.shownAgainst }, notice: { tone: 'warning', text: event.text } } : state;
    case 'saved':
      return { ...state, pending: null, notice: { tone: 'success', text: event.text } };
    case 'save_failed':
      return { ...state, notice: { tone: 'warning', text: event.text } };
    default:
      return state;
  }
}
