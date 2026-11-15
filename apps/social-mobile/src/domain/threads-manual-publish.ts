import type { SocialAccount } from './types.ts';

/**
 * Release flag for the Threads "post now" card. OFF until the server side is live and a pilot is
 * approved (docs/postona/threads-manual-publish-v1.md): while OFF the card only says the feature is in
 * preparation, offers no input and sends nothing. Changing it is a reviewed source change.
 */
export const THREADS_MANUAL_PUBLISH_UI_ENABLED = false;

/** The one Edge Function this card talks to (the database decides everything; see the server source). */
export const THREADS_PUBLISH_FUNCTION = 'social-mobile-threads-publish';

// --- Text (mirrors supabase/functions/_shared/social/threads_publish_contract.ts; parity is tested) ----

export const THREADS_TEXT_MAX_LENGTH = 500;
export const THREADS_TEXT_MAX_LINKS = 5;
const EMOJI_PART = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[\u{E0020}-\u{E007F}])$/u;
const encoder = new TextEncoder();

/** Threads' documented count: one per character, emojis count their UTF-8 bytes. */
export function threadsTextLength(text: string): number {
  let length = 0;
  for (const codePoint of text) length += EMOJI_PART.test(codePoint) ? encoder.encode(codePoint).length : 1;
  return length;
}

export function threadsTextLinks(text: string): number {
  return new Set(text.match(/https?:\/\/[^\s]+/giu) ?? []).size;
}

/** What is typed becomes exactly what is sent: CRLF / CR become LF, nothing else changes. */
export function normalizeThreadsText(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}

export type ThreadsTextIssue = 'empty' | 'too_long' | 'too_many_links' | 'invalid_characters';
export type ThreadsTextCheck = { ok: boolean; issue: ThreadsTextIssue | null; length: number; links: number };

export function checkThreadsComposerText(raw: string): ThreadsTextCheck {
  const text = normalizeThreadsText(raw);
  const length = threadsTextLength(text);
  const links = threadsTextLinks(text);
  if (!text.isWellFormed() || /[\u0000-\u0008\u000B-\u001F\u007F]/u.test(text)) return { ok: false, issue: 'invalid_characters', length, links };
  if (text.trim() === '') return { ok: false, issue: 'empty', length, links };
  if (length > THREADS_TEXT_MAX_LENGTH) return { ok: false, issue: 'too_long', length, links };
  if (links > THREADS_TEXT_MAX_LINKS) return { ok: false, issue: 'too_many_links', length, links };
  return { ok: true, issue: null, length, links };
}

export const TEXT_ISSUE_COPY: Record<ThreadsTextIssue, string> = {
  empty: '投稿する文章を入力してください。',
  too_long: 'Threadsの上限（500文字。絵文字は1つで2〜4文字以上として数えます）を超えています。',
  too_many_links: 'Threadsの投稿に入れられるリンクは5つまでです。',
  invalid_characters: '使えない文字が含まれています。文章を確認してください。',
};

// --- Attempt (the server's public view) --------------------------------------------------------------

export const ATTEMPT_STATUSES = ['reserved', 'creating_container', 'container_created', 'publishing', 'publish_returned', 'published', 'published_unidentified', 'failed', 'uncertain'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export type ThreadsAttemptView = {
  id: string;
  accountId: string;
  status: AttemptStatus;
  providerPostId: string | null;
  permalink: string | null;
  errorCode: string | null;
  replayed: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PERMALINK = /^https:\/\/(www\.)?threads\.(net|com)\/[^\s]*$/u;

/** Accepts only a well-formed attempt for exactly this account; anything else is "not an answer". */
export function parseAttempt(value: unknown, accountId: string): ThreadsAttemptView | null {
  if (typeof value !== 'object' || value === null) return null;
  const a = value as Record<string, unknown>;
  if (typeof a.id !== 'string' || !UUID.test(a.id) || a.social_account_id !== accountId) return null;
  if (typeof a.status !== 'string' || !(ATTEMPT_STATUSES as readonly string[]).includes(a.status)) return null;
  const status = a.status as AttemptStatus;
  const providerPostId = typeof a.provider_post_id === 'string' && /^[1-9][0-9]{0,31}$/u.test(a.provider_post_id) ? a.provider_post_id : null;
  const permalink = typeof a.permalink === 'string' && a.permalink.length <= 512 && PERMALINK.test(a.permalink) ? a.permalink : null;
  // A post is shown as confirmed only with both the id and a Threads permalink.
  if (status === 'published' && (providerPostId === null || permalink === null)) return null;
  return {
    id: a.id,
    accountId,
    status,
    providerPostId,
    permalink: status === 'published' ? permalink : null,
    errorCode: typeof a.error_code === 'string' && /^[A-Z_]{1,64}$/u.test(a.error_code) ? a.error_code : null,
    replayed: a.replayed === true,
  };
}

export type AttemptDisplay = {
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  title: string;
  detail: string | null;
  /** The person may ask to continue (a container that was not ready yet, or a pending read-back). */
  canContinue: boolean;
  /** The person may ask to check again whether an uncertain post went out (read-only). */
  canCheck: boolean;
  /** A new post may be written for this account. */
  allowsNewPost: boolean;
};

const ATTEMPT_ERROR_COPY: Record<string, string> = {
  THREADS_TOKEN_INVALID: 'Threadsとの接続の有効期限が切れたか、解除されています。Threadsアカウントを接続し直してください。',
  THREADS_PERMISSION_MISSING: 'Threadsへの投稿の許可がありません。Threadsアカウントを接続し直して、投稿の許可を確認してください。',
  THREADS_RATE_LIMITED: 'Threadsの投稿回数の上限に達しました。時間をおいてから、もう一度お試しください。',
  THREADS_REQUEST_REJECTED: 'Threadsが投稿を受け付けませんでした。文章を確認して、もう一度お試しください。',
  CONTAINER_ERROR: 'Threadsで投稿の準備に失敗しました。もう一度お試しください。',
  CONTAINER_EXPIRED: 'Threadsで投稿されないまま期限が切れました。この投稿は公開されていません。',
  CONTAINER_OUTCOME_UNKNOWN: 'Threadsへの準備の結果が分かりませんでした。この投稿は公開されていません。もう一度お試しください。',
  ATTEMPT_EXPIRED: '時間が経ちすぎたため、この投稿は中止しました。この投稿は公開されていません。',
  STEP_INTERRUPTED: '処理が途中で止まったため中止しました。この投稿は公開されていません。',
  AUTHORIZATION_CHANGED: '投稿の直前に条件が変わったため、送信しませんでした。',
};

export function attemptDisplay(attempt: ThreadsAttemptView): AttemptDisplay {
  const base = { canContinue: false, canCheck: false, allowsNewPost: false };
  switch (attempt.status) {
    case 'reserved':
    case 'creating_container':
    case 'publishing':
      return { ...base, tone: 'neutral', title: 'Threadsへ投稿しています…', detail: 'この画面を閉じても、同じ投稿が二重に送られることはありません。' };
    case 'container_created':
      return { ...base, tone: 'neutral', title: 'Threadsで投稿の準備をしています', detail: '準備ができたら「続ける」で投稿します。まだ公開されていません。', canContinue: true };
    case 'publish_returned':
      return { ...base, tone: 'neutral', title: 'Threadsの返答を確認しています', detail: 'Threadsから返答はありましたが、投稿をまだ確認できていません。「確認する」で確かめます。', canContinue: true };
    case 'published':
      return { ...base, tone: 'success', title: 'Threadsに投稿しました', detail: '投稿をThreadsで確認できました。', allowsNewPost: true };
    case 'published_unidentified':
      return { ...base, tone: 'warning', title: 'Threadsへの投稿は確認できました', detail: '投稿のリンクを特定できませんでした。Threadsアプリでご確認ください。', allowsNewPost: true };
    case 'uncertain':
      return {
        ...base, tone: 'warning', title: '投稿されたか確認できていません',
        detail: '重複投稿を防ぐため、自動で送り直すことはしません。「確認する」でThreadsの状態を確かめます（最長24時間で確定します）。',
        canCheck: true,
      };
    case 'failed':
      return { ...base, tone: 'danger', title: '投稿できませんでした', detail: ATTEMPT_ERROR_COPY[attempt.errorCode ?? ''] ?? 'この投稿は公開されていません。時間をおいて、もう一度お試しください。', allowsNewPost: true };
  }
}

// --- Server refusals ---------------------------------------------------------------------------------

const REFUSAL_COPY: Record<string, { message: string; reload: boolean }> = {
  AUTH_REQUIRED: { message: 'ログインの有効期限が切れました。もう一度ログインしてください。', reload: false },
  REQUEST_INVALID: { message: '送信できませんでした。アプリを再読み込みしてください。', reload: true },
  TEXT_INVALID: { message: '文章を確認してください。Threadsの上限を超えているか、使えない文字が含まれています。', reload: false },
  ACCOUNT_NOT_FOUND: { message: 'このアカウントでは投稿できません。アカウント一覧を確認してください。', reload: true },
  PUBLISH_FORBIDDEN: { message: 'Threadsへの投稿は、ワークスペースのオーナーまたは管理者のみ行えます。', reload: false },
  WORKSPACE_INACTIVE: { message: 'このワークスペースは現在、投稿できない状態です。', reload: true },
  SERVICE_NOT_ACTIVE: { message: 'POSTONAの利用が有効になっていないため、投稿できません。', reload: false },
  ACCOUNT_LIFECYCLE_BLOCKED: { message: 'アカウントの手続き中のため、現在は投稿できません。', reload: false },
  PLATFORM_NOT_SUPPORTED: { message: 'このアカウントはThreadsではありません。', reload: true },
  CONNECTION_NOT_VERIFIED: { message: 'Threadsとの接続を確認できません。Threadsアカウントを接続し直してください。', reload: true },
  CREDENTIALS_MISSING: { message: 'Threadsの接続情報が不足しています。Threadsアカウントを接続し直してください。', reload: true },
  CREDENTIALS_EXPIRED: { message: 'Threadsとの接続の有効期限が切れているか、まもなく切れます。Threadsアカウントを接続し直してください。', reload: true },
  MANUAL_PUBLISH_NOT_PERMITTED: { message: 'このThreadsアカウントへの投稿がまだ許可されていません。', reload: true },
  PUBLISH_IN_PROGRESS: { message: 'このアカウントでは、別の投稿の処理がまだ終わっていません。', reload: true },
  IDEMPOTENCY_CONFLICT: { message: '同じ操作が別の内容で送られました。画面を読み込み直してから、もう一度お試しください。', reload: true },
  ATTEMPT_NOT_FOUND: { message: 'この投稿の記録が見つかりません。', reload: true },
  ATTEMPT_EXPIRED: { message: '時間が経ちすぎたため、この投稿は中止しました。公開はされていません。', reload: true },
  STALE_STEP: { message: '状態が変わっていました。最新の状態を読み込み直しました。', reload: true },
  GRANT_INVALID: { message: '投稿の処理を続けられませんでした。時間をおいて、状態を確認してください。', reload: true },
  BUSY: { message: '混み合っています。少し待ってから、もう一度お試しください。', reload: false },
  STORE_UNAVAILABLE: { message: '投稿の処理を確認できませんでした。時間をおいて、状態を確認してください。', reload: false },
  THREADS_PUBLISH_DISABLED: { message: 'Threadsへの投稿は、まだ準備中です。', reload: false },
  METHOD_NOT_ALLOWED: { message: '送信できませんでした。アプリを再読み込みしてください。', reload: false },
};
const GENERIC_REFUSAL = { code: 'STORE_UNAVAILABLE', message: '通信状況を確認してください。投稿されたかどうかは「確認する」で確かめられます。', reload: false };

export type ThreadsRefusal = { code: string; message: string; reload: boolean };

/** Bounded server code -> safe Japanese copy. Unknown or malformed payloads never surface raw text. */
export function threadsRefusal(payload: unknown): ThreadsRefusal {
  if (typeof payload !== 'object' || payload === null) return GENERIC_REFUSAL;
  const code = (payload as { error?: unknown }).error;
  if (typeof code !== 'string' || !Object.hasOwn(REFUSAL_COPY, code)) return GENERIC_REFUSAL;
  return { code, ...REFUSAL_COPY[code] };
}

// --- What the card may offer ----------------------------------------------------------------------------

export type ThreadsCardMode =
  | 'not_threads'
  | 'release_disabled' // the release flag is OFF: "in preparation", nothing to do
  | 'preview' // explicit local mock preview: the composer is shown but nothing can be sent
  | 'reconnect' // the account needs reconnecting (expired / revoked / unverified)
  | 'loading'
  | 'unavailable' // the server state could not be read
  | 'consent_required' // the per-account manual publish permission is not granted
  | 'ready'
  | 'busy'; // an attempt is open for this account

export type ThreadsCardContext = {
  accountId: string;
  mode: ThreadsCardMode;
  userId: string | null;
};

export type ThreadsServerState = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'loaded'; permitted: boolean; open: ThreadsAttemptView | null; last: ThreadsAttemptView | null };

export function threadsCardMode(
  account: Pick<SocialAccount, 'platform' | 'connectionStatus'>,
  options: { releaseEnabled: boolean; preview: boolean; server: ThreadsServerState },
): ThreadsCardMode {
  if (account.platform !== 'threads') return 'not_threads';
  if (!options.releaseEnabled) return 'release_disabled';
  if (options.preview) return 'preview';
  if (account.connectionStatus !== 'connected') return 'reconnect';
  if (options.server.kind === 'loading') return 'loading';
  if (options.server.kind === 'unavailable') return 'unavailable';
  if (!options.server.permitted) return 'consent_required';
  if (options.server.open) return 'busy';
  return 'ready';
}

export const MODE_COPY: Record<ThreadsCardMode, string | null> = {
  not_threads: null,
  release_disabled: 'Threadsへの手動投稿は準備中です。利用できるようになるまで、ここから投稿されることはありません。',
  preview: 'プレビュー表示です。この画面からは実際には投稿されません。',
  reconnect: 'Threadsとの接続を確認できません（期限切れ・解除など）。Threadsアカウントを接続し直すと投稿できます。',
  loading: '状態を確認しています…',
  unavailable: '投稿の状態を確認できませんでした。時間をおいて、もう一度開いてください。',
  consent_required: 'このThreadsアカウントへの投稿は、まだ許可されていません。',
  ready: null,
  busy: null,
};

export const CONSENT_COPY = 'POSTONAからこのThreadsアカウントに、あなたが「投稿する」を押した文章だけを投稿します。自動では投稿しません。許可はいつでも取り消せます（取り消しても、すでに公開された投稿は消えません）。';
export const PUBLISH_CONFIRM_COPY = 'この文章を、上のThreadsアカウントに公開します。公開した投稿は、このアプリからは取り消せません。';

/**
 * One publish, pinned to exactly what the person confirmed: this account, this text, this signed-in user
 * and one idempotency key. The key is created when the person confirms and is reused if the same pinned
 * action has to be sent again (the server then returns the same attempt instead of posting twice).
 */
export type PinnedThreadsPublish = { accountId: string; userId: string; text: string; idempotencyKey: string };

export function pinThreadsPublish(context: ThreadsCardContext, rawText: string, newKey: () => string): PinnedThreadsPublish | null {
  if (context.mode !== 'ready' || !context.userId) return null;
  const check = checkThreadsComposerText(rawText);
  if (!check.ok) return null;
  const idempotencyKey = newKey();
  if (!UUID.test(idempotencyKey)) return null;
  return { accountId: context.accountId, userId: context.userId, text: normalizeThreadsText(rawText), idempotencyKey };
}

/** Still the same account, user and a sendable screen: otherwise nothing is sent. */
export function pinnedStillValid(pinned: PinnedThreadsPublish, context: ThreadsCardContext): boolean {
  return pinned.accountId === context.accountId && pinned.userId === context.userId && context.mode === 'ready';
}

export function buildPublishRequest(pinned: PinnedThreadsPublish) {
  return { action: 'publish', social_account_id: pinned.accountId, idempotency_key: pinned.idempotencyKey, text: pinned.text } as const;
}
export function buildAttemptRequest(action: 'resume' | 'reconcile' | 'status', attemptId: string) {
  return { action, attempt_id: attemptId } as const;
}
export function buildStateRequest(accountId: string) {
  return { action: 'account_state', social_account_id: accountId } as const;
}
export function buildPermissionRequest(accountId: string, desired: boolean, expected: boolean) {
  return { action: 'set_permission', social_account_id: accountId, desired_enabled: desired, expected_current_enabled: expected } as const;
}

/** The account state, only for exactly this account. */
export function parseAccountState(payload: unknown, accountId: string): ThreadsServerState {
  if (typeof payload !== 'object' || payload === null || (payload as { success?: unknown }).success !== true) return { kind: 'unavailable' };
  const account = (payload as { account?: unknown }).account as Record<string, unknown> | undefined;
  if (!account || account.id !== accountId || typeof account.manual_publish_permitted !== 'boolean') return { kind: 'unavailable' };
  const open = account.open_attempt === null ? null : parseAttempt(account.open_attempt, accountId);
  const last = account.last_attempt === null ? null : parseAttempt(account.last_attempt, accountId);
  if ((account.open_attempt !== null && open === null) || (account.last_attempt !== null && last === null)) return { kind: 'unavailable' };
  return { kind: 'loaded', permitted: account.manual_publish_permitted, open, last };
}

/** An attempt answer, only for exactly this account. */
export function parseAttemptResponse(payload: unknown, accountId: string): ThreadsAttemptView | null {
  if (typeof payload !== 'object' || payload === null || (payload as { success?: unknown }).success !== true) return null;
  return parseAttempt((payload as { attempt?: unknown }).attempt, accountId);
}

export function parsePermissionResponse(payload: unknown, accountId: string, desired: boolean): boolean | null {
  if (typeof payload !== 'object' || payload === null || (payload as { success?: unknown }).success !== true) return null;
  const account = (payload as { account?: unknown }).account as Record<string, unknown> | undefined;
  if (!account || account.id !== accountId || account.manual_publish_permitted !== desired) return null;
  return desired;
}
