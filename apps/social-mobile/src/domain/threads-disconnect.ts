import type { SocialAccount } from '@/domain/types';

/**
 * The person removes ONLY their Threads connection from POSTONA (F4). X, the POSTONA registration, the common
 * account and Kabumori stay. Release flag OFF: the card is an honest "in preparation" card and nothing runs.
 * The server entry and the database function have their own closed gates.
 */
export const THREADS_DISCONNECT_UI_ENABLED = false;

/** The server entry (hard-disabled server-side today). */
export const THREADS_DISCONNECT_FUNCTION = 'social-mobile-threads-disconnect';

/** The account the person confirmed on screen: its id and its handle (without @). */
export type ThreadsDisconnectTarget = Readonly<{ id: string; handle: string }>;

/**
 * How one disconnect ended, as far as the app can know. The local result and the Threads-side result are
 * separate: POSTONA can remove what it stores, it cannot revoke the grant at Threads (no such API).
 */
export type ThreadsDisconnectResult =
  | { kind: 'disconnected' }
  | { kind: 'stopped'; code: 'PUBLISH_IN_FLIGHT' | 'SECRET_SHARED' | 'DISCONNECT_FAILED' }
  | { kind: 'not_connected' }
  | { kind: 'failed'; code: string; uncertain: boolean };

export type ThreadsDisconnector = { disconnect(target: ThreadsDisconnectTarget, confirmedBy: string): Promise<ThreadsDisconnectResult> };

const ACCOUNT_ID = /^[a-z][a-z0-9_]{1,80}$/u;
const HANDLE = /^[^\s\p{Cc}@]{1,63}$/u;

/** A target the server would accept (id + handle, the leading @ dropped), or null. */
export function validDisconnectTarget(target: { id: string; handle: string }): ThreadsDisconnectTarget | null {
  const handle = target.handle.replace(/^@/u, '');
  return ACCOUNT_ID.test(target.id) && HANDLE.test(handle) ? { id: target.id, handle } : null;
}

/** The account shown on screen -> the target the server will compare, or null when it cannot be one. */
export function disconnectTarget(account: Pick<SocialAccount, 'id' | 'platform' | 'profile'>): ThreadsDisconnectTarget | null {
  if (account.platform !== 'threads') return null;
  return validDisconnectTarget({ id: account.id, handle: account.profile.handle });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const STOPPED: readonly string[] = ['PUBLISH_IN_FLIGHT', 'SECRET_SHARED', 'DISCONNECT_FAILED'];
/** Refusals: the database changed nothing (or the request never reached it). */
const KNOWN_REFUSALS: readonly string[] = [
  'DISCONNECT_DISABLED', 'THREADS_DISCONNECT_DISABLED', 'AUTH_REQUIRED', 'REQUEST_INVALID', 'SERVICE_NOT_ACTIVE',
  'ACCOUNT_LIFECYCLE_BLOCKED', 'BUSY', 'ACCOUNT_NOT_FOUND', 'ACCOUNT_CHANGED', 'DISCONNECT_FORBIDDEN', 'METHOD_NOT_ALLOWED',
];

/**
 * The server's answer -> the result. Mirrors the server contract exactly; anything else (including a lost
 * answer) is `failed` + uncertain: the screen re-reads the accounts and never claims a removal.
 */
export function parseDisconnectResponse(payload: unknown, ok: boolean): ThreadsDisconnectResult {
  if (!ok || !isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) && payload.ok === false && keysAre(payload, ['ok', 'error']) ? payload.error : null;
    if (typeof error === 'string' && KNOWN_REFUSALS.includes(error)) return { kind: 'failed', code: error, uncertain: false };
    return { kind: 'failed', code: 'STORE_UNAVAILABLE', uncertain: true };
  }
  const uncertain: ThreadsDisconnectResult = { kind: 'failed', code: 'STORE_UNAVAILABLE', uncertain: true };
  if (!keysAre(payload, ['ok', 'status', 'code', 'publish_permission', 'local_credentials', 'remote_access'])
    || payload.remote_access !== 'not_revoked_by_app'
    || (payload.publish_permission !== 'withdrawn' && payload.publish_permission !== 'already_off')) {
    return uncertain;
  }
  if (payload.status === 'disconnected' && payload.code === 'LOCAL_REMOVED' && payload.local_credentials === 'removed') return { kind: 'disconnected' };
  if (payload.status === 'stopped' && typeof payload.code === 'string' && STOPPED.includes(payload.code) && payload.local_credentials === 'kept') {
    return { kind: 'stopped', code: payload.code as 'PUBLISH_IN_FLIGHT' | 'SECRET_SHARED' | 'DISCONNECT_FAILED' };
  }
  if (payload.status === 'not_connected' && payload.code === 'ALREADY_REMOVED' && payload.local_credentials === 'none'
    && payload.publish_permission === 'already_off') {
    return { kind: 'not_connected' };
  }
  return uncertain;
}

export type ThreadsDisconnectView = {
  mode: 'preparing' | 'preview' | 'ready';
  note: string;
  buttonLabel: string;
  canStart: boolean;
};

export function threadsDisconnectView(options: { releaseEnabled: boolean; preview: boolean }): ThreadsDisconnectView {
  if (options.preview) return { mode: 'preview', note: 'プレビュー表示のため、解除はできません。', buttonLabel: 'Threads連携を解除', canStart: false };
  if (!options.releaseEnabled) {
    return {
      mode: 'preparing',
      note: 'Threads連携の解除は準備中です。利用できるようになるまで、ここから解除が行われることはありません。',
      buttonLabel: 'Threads連携を解除（準備中）',
      canStart: false,
    };
  }
  return {
    mode: 'ready',
    note: 'このThreadsアカウントだけをPOSTONAから外します。X連携、POSTONAの利用登録、共通ID（かぶモリ）はそのまま残ります。',
    buttonLabel: 'Threads連携を解除',
    canStart: true,
  };
}

/** What the confirmation says, before anything is sent. */
export function disconnectConfirmLines(target: ThreadsDisconnectTarget): string[] {
  return [
    `@${target.handle} のThreads連携を解除しますか？`,
    'POSTONAからこのThreadsアカウントへ投稿できなくなり、POSTONAに保存しているThreadsの認証情報を削除します。',
    'X連携、POSTONAの利用登録、共通ID（かぶモリ）はそのまま残ります。',
    THREADS_REMOTE_NOTE,
  ];
}

/** Always shown on its own line: POSTONA cannot revoke the Threads-side permission. */
export const THREADS_REMOTE_NOTE = 'Threads側の許可は、POSTONAからは取り消せません。Threadsの設定から、連携しているアプリの一覧でPOSTONAを削除してください。';

export const DISCONNECT_FAILURE_COPY: Readonly<Record<string, string>> = {
  AUTH_REQUIRED: 'もう一度ログインしてからお試しください。',
  SESSION_CHANGED: '途中でログイン中のアカウントが変わったため、解除を中止しました。',
  IN_PROGRESS: '解除の処理中です。',
  REQUEST_INVALID: 'この操作は受け付けられませんでした。画面を読み直してからお試しください。',
  ACCOUNT_CHANGED: '表示中のThreadsアカウントが変わっています。画面を読み直して、もう一度確認してください。',
  ACCOUNT_NOT_FOUND: 'このThreadsアカウントは見つかりませんでした。画面を読み直してください。',
  ACCOUNT_LIFECYCLE_BLOCKED: 'アカウントの削除や利用終了の手続き中のため、ここからは解除できません。',
  SERVICE_NOT_ACTIVE: 'POSTONAの利用登録が有効ではないため、解除できません。',
  DISCONNECT_FORBIDDEN: 'この操作を行う権限がありません。',
  BUSY: '処理が混み合っています。少し待ってからお試しください。',
  DISCONNECT_DISABLED: 'Threads連携の解除は準備中です。',
  THREADS_DISCONNECT_DISABLED: 'Threads連携の解除は準備中です。',
  METHOD_NOT_ALLOWED: 'この操作は受け付けられませんでした。',
  STORE_UNAVAILABLE: '結果を確認できませんでした。画面を読み直して、接続の状態を確認してください。',
};

export function disconnectFailureCopy(code: string): string {
  return DISCONNECT_FAILURE_COPY[code] ?? DISCONNECT_FAILURE_COPY.STORE_UNAVAILABLE;
}

/** The result as separate lines: what happened in POSTONA, then (always) the Threads side. */
export function disconnectResultLines(result: ThreadsDisconnectResult): { local: string; remote: string | null } {
  switch (result.kind) {
    case 'disconnected':
      return { local: 'Threads連携を解除しました。POSTONAに保存していたThreadsの認証情報を削除し、投稿もできなくなりました。', remote: THREADS_REMOTE_NOTE };
    case 'not_connected':
      return { local: 'Threadsは接続されていません（すでに解除されています）。', remote: THREADS_REMOTE_NOTE };
    case 'stopped':
      return {
        local: result.code === 'PUBLISH_IN_FLIGHT'
          ? '投稿は停止しました。送信中かもしれない投稿の確認が終わるまで、認証情報は残しています。確認が済んでから、もう一度解除してください。'
          : '投稿は停止しました。認証情報の削除はまだ完了していません。時間をおいてもう一度お試しください。',
        remote: THREADS_REMOTE_NOTE,
      };
    case 'failed':
      return { local: disconnectFailureCopy(result.code), remote: null };
  }
}
