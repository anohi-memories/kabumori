// 「AIに聞く」V1 Phase A: 対話UIの型付き契約・入力検証・状態遷移・提示の純関数 (no RN / no network / no imports,
// so it is testable with Deno).
//
// Phase A connects to NOTHING. There is no server endpoint and no provider call in this file or in the screen that
// uses it. What exists here is the CONTRACT the Phase B server must honour, and the client behaviour around it:
//   * a question is bounded text; the request carries no user id, no holdings and no prices -- the server will
//     identify the user from the JWT and read holdings itself under RLS (see docs/release-readiness/kabumori-app/
//     AI_ASK_V1_PHASE_A_CONTRACT.md);
//   * an answer is only ever shown with its sources and "when the data was taken"; an unknown time says "不明",
//     it is never filled in;
//   * production (`dev === false`, no server flag) is "unavailable": the screen cannot send anything and says so.
//     The offline mock lives in ai-ask-mock.ts and is reachable only under __DEV__.

// ---- the contract -------------------------------------------------------------------------------------------------

export const ASK_CONTRACT_VERSION = 1 as const;

/** What the question is about. The server uses it to pick the context it may read; the client never sends context. */
export type AskScope = 'market' | 'holdings' | 'stock';

export type AskRequest = {
  version: typeof ASK_CONTRACT_VERSION;
  /** Normalised question text, 1..ASK_QUESTION_MAX_CHARS characters. */
  question: string;
  scope: AskScope;
  /** Required for scope 'stock': the listed ticker code the question is about. Never a name or a price. */
  tickerCode: string | null;
  /** Idempotency key. A retry of the same question reuses it, so the server can answer once and bill once. */
  clientRequestId: string;
};

export type AskSourceKind = 'news' | 'report' | 'market_data' | 'holding';

/** One thing the answer is based on. `ref` is an in-app id (news id / report id), never an external URL. */
export type AskSource = {
  kind: AskSourceKind;
  title: string;
  /** When the source was published / computed, ISO-8601; null = unknown (shown as 不明, never guessed). */
  asOf: string | null;
  ref: string | null;
};

export type AskRefusalReason = 'investment_advice' | 'out_of_scope' | 'insufficient_evidence';

export type AskFailureCode =
  | 'unavailable' // the feature is not offered (server flag off / not connected)
  | 'auth_required'
  | 'rate_limited' // per-user limit
  | 'budget_exhausted' // cost cap reached
  | 'network'
  | 'timeout'
  | 'server_error';

export type AskResponse =
  | {
    status: 'answered';
    answer: string;
    /** 0..5 short bullets; may be empty. */
    keyPoints: string[];
    /** At least one for an answer that states facts. Empty is allowed only for general explanations. */
    sources: AskSource[];
    /** When the answer was generated, ISO-8601, or null if unknown. */
    generatedAt: string | null;
    /** The date/time of the newest data the answer used, or null if it cannot be stated. */
    dataAsOf: string | null;
    /** True when the answer used this user's own holdings (shown to the user; relevant to consent). */
    usedHoldings: boolean;
  }
  | { status: 'refused'; reason: AskRefusalReason }
  | { status: 'failed'; code: AskFailureCode };

// ---- input --------------------------------------------------------------------------------------------------------

export const ASK_QUESTION_MAX_CHARS = 300;

export type QuestionCheck =
  | { ok: true; value: string }
  | { ok: false; reason: 'empty' | 'too_long' | 'no_letters' };

// C0/C1 control characters and zero-width/bidi marks have no place in a question and are a prompt-injection
// carrier; they are removed, then whitespace is collapsed.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/g;
const HAS_LETTER = /[\p{L}\p{N}]/u;

export function checkQuestion(raw: string): QuestionCheck {
  const value = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (!HAS_LETTER.test(value)) return { ok: false, reason: 'no_letters' };
  if (Array.from(value).length > ASK_QUESTION_MAX_CHARS) return { ok: false, reason: 'too_long' };
  return { ok: true, value };
}

export const QUESTION_PROBLEM_JA: Record<'empty' | 'too_long' | 'no_letters', string> = {
  empty: '質問を入力してください。',
  too_long: `質問は${ASK_QUESTION_MAX_CHARS}文字以内で入力してください。`,
  no_letters: '文字で質問を入力してください。',
};

const TICKER = /^[0-9]{4}$|^[0-9]{3}[A-Z]$/;

/** Builds the request, or null when it would be invalid. A stock question needs a ticker; others carry none. */
export function buildAskRequest(input: {
  question: string;
  scope: AskScope;
  tickerCode?: string | null;
  clientRequestId: string;
}): AskRequest | null {
  const checked = checkQuestion(input.question);
  if (!checked.ok) return null;
  if (!input.clientRequestId) return null;
  const ticker = input.tickerCode?.trim().toUpperCase() ?? null;
  if (input.scope === 'stock') {
    if (!ticker || !TICKER.test(ticker)) return null;
  }
  return {
    version: ASK_CONTRACT_VERSION,
    question: checked.value,
    scope: input.scope,
    tickerCode: input.scope === 'stock' ? ticker : null,
    clientRequestId: input.clientRequestId,
  };
}

/** An example's 「〇〇」 is a blank to fill in; a question that still contains it is not sendable. */
export function hasUnfilledPlaceholder(question: string): boolean {
  return question.includes('〇〇');
}

/** A request id that is unique per question: time + random suffix, both injected so it stays testable. */
export function makeClientRequestId(now: number, random: () => number): string {
  const suffix = Math.floor(random() * 0xffffff).toString(16).padStart(6, '0');
  return `ask-${Math.floor(now).toString(36)}-${suffix}`;
}

// ---- examples -------------------------------------------------------------------------------------------------------

export type AskExample = { id: string; scope: AskScope; question: string };

/** Starting points only: they fill the input, they are never sent on their own and carry no figures. */
export const ASK_EXAMPLES: readonly AskExample[] = [
  { id: 'market-today', scope: 'market', question: '今日の市況は？' },
  { id: 'holdings-news', scope: 'holdings', question: '自分の保有銘柄に影響するニュースは？' },
  { id: 'holdings-risk', scope: 'holdings', question: 'ポートフォリオのリスクは？' },
  { id: 'stock-fall', scope: 'stock', question: '〇〇の下落理由は？' },
];

/** The scope an unnamed example needs a stock for is filled in by the screen; here it is only a label. */
export function exampleNeedsStock(example: AskExample): boolean {
  return example.scope === 'stock';
}

// ---- availability ---------------------------------------------------------------------------------------------------

export type AskAvailability = 'unavailable' | 'mock' | 'live';

/**
 * 'live' only when the server says so (Phase B); 'mock' only in a development build; otherwise 'unavailable'.
 * The two flags are independent inputs so production cannot become 'mock' by accident.
 */
export function askAvailability(input: { dev: boolean; serverEnabled: boolean }): AskAvailability {
  if (input.serverEnabled === true) return 'live';
  if (input.dev === true) return 'mock';
  return 'unavailable';
}

/** Phase A: there is no server. Phase B replaces this with the server's own status (see the contract document). */
export const ASK_SERVER_ENABLED = false;

// ---- state machine --------------------------------------------------------------------------------------------------

export type AskPhase = 'idle' | 'sending' | 'answered' | 'refused' | 'failed';

export type AskState = {
  phase: AskPhase;
  draft: string;
  scope: AskScope;
  tickerCode: string | null;
  /** The request in flight / last sent (kept so a retry resends exactly it, with the same id). */
  request: AskRequest | null;
  response: Extract<AskResponse, { status: 'answered' }> | null;
  refusal: AskRefusalReason | null;
  failure: AskFailureCode | null;
  /** How many requests were SENT (a retry counts). Used only for display / tests. */
  sent: number;
};

export const ASK_INITIAL_STATE: AskState = {
  phase: 'idle',
  draft: '',
  scope: 'market',
  tickerCode: null,
  request: null,
  response: null,
  refusal: null,
  failure: null,
  sent: 0,
};

export type AskAction =
  | { type: 'edit'; draft: string }
  | { type: 'scope'; scope: AskScope; tickerCode?: string | null }
  | { type: 'send'; request: AskRequest }
  | { type: 'retry' }
  | { type: 'receive'; clientRequestId: string; response: AskResponse }
  | { type: 'fail'; clientRequestId: string; code: AskFailureCode }
  | { type: 'reset' };

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case 'edit':
      // Editing while a request is in flight is allowed (the answer will still arrive for the sent question).
      return { ...state, draft: action.draft };
    case 'scope':
      return { ...state, scope: action.scope, tickerCode: action.scope === 'stock' ? action.tickerCode ?? state.tickerCode : null };
    case 'send':
      // One request at a time: a second send while sending is ignored (no duplicate request, no double billing).
      if (state.phase === 'sending') return state;
      return {
        ...state,
        phase: 'sending',
        request: action.request,
        response: null,
        refusal: null,
        failure: null,
        sent: state.sent + 1,
      };
    case 'retry':
      // Only a failed request is retried, with the same request (same clientRequestId).
      if (state.phase !== 'failed' || !state.request) return state;
      return { ...state, phase: 'sending', failure: null, sent: state.sent + 1 };
    case 'receive': {
      // A late answer for a request that is no longer the current one is dropped.
      if (state.phase !== 'sending' || state.request?.clientRequestId !== action.clientRequestId) return state;
      const r = action.response;
      if (r.status === 'answered') return { ...state, phase: 'answered', response: r };
      if (r.status === 'refused') return { ...state, phase: 'refused', refusal: r.reason };
      return { ...state, phase: 'failed', failure: r.code };
    }
    case 'fail':
      if (state.phase !== 'sending' || state.request?.clientRequestId !== action.clientRequestId) return state;
      return { ...state, phase: 'failed', failure: action.code };
    case 'reset':
      return { ...ASK_INITIAL_STATE, scope: state.scope, tickerCode: state.tickerCode };
  }
}

/** Retrying makes sense for transient failures only; a refusal / disabled feature / auth problem is not retried. */
export function isRetryable(code: AskFailureCode): boolean {
  return code === 'network' || code === 'timeout' || code === 'server_error';
}

// ---- presentation -----------------------------------------------------------------------------------------------------

export const FAILURE_MESSAGE_JA: Record<AskFailureCode, string> = {
  unavailable: 'この機能は、まだご利用いただけません。',
  auth_required: 'ログイン状態を確認できませんでした。もう一度ログインしてお試しください。',
  rate_limited: '短い時間にたくさん質問されました。しばらく待ってからお試しください。',
  budget_exhausted: '本日のご利用の上限に達しました。明日またお試しください。',
  network: '通信できませんでした。電波の良いところでもう一度お試しください。',
  timeout: '回答に時間がかかっています。もう一度お試しください。',
  server_error: '回答を作れませんでした。時間をおいてもう一度お試しください。',
};

export const REFUSAL_MESSAGE_JA: Record<AskRefusalReason, string> = {
  investment_advice:
    '個別の売買をすすめる回答はできません。値動きの背景や、確認できる情報の整理についてならお答えします。',
  out_of_scope: 'この質問には、かぶモリではお答えできません。市況・ニュース・保有銘柄についてお聞きください。',
  insufficient_evidence: '確認できる情報が足りないため、回答を控えます。',
};

/** Same wording as REPORT_DISCLAIMER_JA (pinned equal by a test); defined here to keep this module import-free. */
export const ASK_DISCLAIMER_JA =
  '※本レポートはAIによる分析です。内容に誤り・不足を含む可能性があります。最終的な投資判断はご自身でお願いします。';

export const ASK_SOURCE_LABEL_JA: Record<AskSourceKind, string> = {
  news: 'ニュース',
  report: 'レポート',
  market_data: '市場データ',
  holding: 'あなたの保有銘柄',
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** "10/12 15:30" (JST) for a valid ISO timestamp, or null. */
export function formatJstDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + JST_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hh}:${mm}`;
}

/** "取得時点: 10/12 15:30"; an unknown or unparseable time is "取得時点: 不明" -- never a guess. */
export function asOfLabel(iso: string | null): string {
  return `取得時点: ${formatJstDateTime(iso) ?? '不明'}`;
}

/** "対象データ: …" line of an answer: the newest data it used, or 不明. */
export function dataAsOfLabel(iso: string | null): string {
  return `回答に使ったデータ: ${formatJstDateTime(iso) ?? '不明'}`;
}

/** What the answer card says about its sources, so an answer without any is never presented as evidence-backed. */
export function sourcesSummary(sources: readonly AskSource[]): string {
  return sources.length > 0 ? `出典 ${sources.length}件` : '出典なし（一般的な説明です）';
}

/** The honest one-line note of what this screen is, per availability. */
export function availabilityNote(availability: AskAvailability): string {
  if (availability === 'mock') {
    return '開発用のサンプル表示です。実際のAIには接続しておらず、回答は固定の例です。';
  }
  if (availability === 'unavailable') {
    return 'AIに聞く機能は、現在準備中です。公開までもうしばらくお待ちください。';
  }
  return '';
}

/** In production nothing may look sendable: the input, the examples-as-chips and the send button are not drawn. */
export function canSend(availability: AskAvailability): boolean {
  return availability !== 'unavailable';
}
