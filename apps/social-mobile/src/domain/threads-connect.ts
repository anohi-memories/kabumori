import type { SocialAccount } from './types.ts';

/**
 * Release flag for the Threads connect / reconnect entry. OFF until H5's connect runtime is live, the
 * Meta app's HTTPS callback and the app link that forwards it are configured and verified, and a pilot is
 * approved (docs/postona/threads-connect-publish-integration-v1.md). While OFF the entry is shown as
 * "in preparation" with a disabled button, and nothing is requested.
 */
export const THREADS_CONNECT_UI_ENABLED = false;

export type ThreadsConnectMode = 'preview' | 'preparing' | 'connect' | 'reconnect' | 'connected';

export type ThreadsConnectView = { mode: ThreadsConnectMode; title: string; note: string; buttonLabel: string | null; canStart: boolean };

/**
 * What the accounts screen may offer for Threads. Connecting never enables posting: the account starts
 * without manual publish permission, which the person grants separately on the account page.
 */
export function threadsConnectView(threadsAccount: Pick<SocialAccount, 'connectionStatus'> | null, options: { releaseEnabled: boolean; preview: boolean }): ThreadsConnectView {
  const needsReconnect = threadsAccount !== null && threadsAccount.connectionStatus !== 'connected';
  const title = needsReconnect ? 'Threadsアカウントの再接続' : 'Threadsアカウント接続';
  if (options.preview) return { mode: 'preview', title, note: 'プレビュー表示のため、接続はできません。', buttonLabel: null, canStart: false };
  if (!options.releaseEnabled) {
    return {
      mode: 'preparing', title,
      note: 'Threadsとの接続は準備中です。利用できるようになるまで、ここから接続や投稿が行われることはありません。',
      buttonLabel: needsReconnect ? 'Threadsアカウントを再接続（準備中）' : 'Threadsアカウントを接続（準備中）',
      canStart: false,
    };
  }
  if (threadsAccount !== null && !needsReconnect) {
    return { mode: 'connected', title, note: '接続済みです。投稿するには、アカウントの画面で投稿を許可してください。', buttonLabel: null, canStart: false };
  }
  return {
    mode: needsReconnect ? 'reconnect' : 'connect', title,
    note: 'Threadsの画面で、接続したいアカウントにログインして許可してください。接続しても、投稿は自動では有効になりません。',
    buttonLabel: needsReconnect ? 'Threadsアカウントを再接続' : 'Threadsアカウントを接続',
    canStart: true,
  };
}

/** The server entry that starts / completes the connection (H5). Hard-disabled server-side today. */
export const THREADS_CONNECT_FUNCTION = 'threads-oauth-connect-user';

/**
 * How one connect attempt ended, as far as the app can know. `connected` is the server's verified receipt
 * only; the screen still re-reads the account before it says "接続済み".
 */
export type ThreadsConnectStart =
  | { kind: 'connected'; socialAccountId: string }
  | { kind: 'canceled' }
  | { kind: 'expired' }
  | { kind: 'failed'; code: string; reconcile: boolean }
  | { kind: 'unavailable'; code: string };

/** The app side of starting a connection. The production adapter does nothing until the release flag. */
export type ThreadsConnectStarter = { start(): Promise<ThreadsConnectStart> };

export const disabledThreadsConnectStarter: ThreadsConnectStarter = Object.freeze({
  start: () => Promise.resolve({ kind: 'unavailable', code: 'THREADS_CONNECT_DISABLED' } as const),
});

/**
 * The callback handoff (design, unwired). Meta redirects to the ONE registered HTTPS callback; the app's
 * verified app link receives that exact URL and forwards it, unchanged, to the server with the person's
 * own session. The app never reads, stores or logs the code or state, and accepts nothing else: another
 * origin or path, credentials in the URL, extra or repeated parameters, or a fragment other than Meta's
 * trailing `#_`.
 */
export function threadsCallbackForward(received: string, registeredCallback: string): { action: 'callback'; callback_url: string } | null {
  let url: URL;
  let registered: URL;
  try {
    url = new URL(received);
    registered = new URL(registeredCallback);
  } catch {
    return null;
  }
  if (registered.protocol !== 'https:' || registered.search !== '' || registered.hash !== '') return null;
  if (url.protocol !== 'https:' || url.origin !== registered.origin || url.pathname !== registered.pathname) return null;
  if (url.username !== '' || url.password !== '' || (url.hash !== '' && url.hash !== '#_')) return null;
  const names = [...url.searchParams.keys()];
  const allowed = new Set(['code', 'state', 'error', 'error_reason', 'error_description']);
  if (names.length === 0 || names.length > 4 || names.some((name) => !allowed.has(name)) || new Set(names).size !== names.length) return null;
  if (received.length > 4096) return null;
  return { action: 'callback', callback_url: received };
}

// --- The server contract (mirrors supabase/functions/_shared/social/threads_connect_edge.ts; parity tested) ---

export const THREADS_AUTHORIZE_ENDPOINT = 'https://threads.com/oauth/authorize';
export const THREADS_REQUIRED_SCOPE = 'threads_basic,threads_content_publish';

/** The registered callback itself: a plain HTTPS URL (no query, fragment or credentials). */
export function isRegisteredCallback(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.search === '' && url.hash === '' && url.username === '' && url.password === '' && url.href === value;
  } catch {
    return false;
  }
}

/** Only the official authorize endpoint, the five documented parameters, our callback and both scopes. */
export function isThreadsAuthorizationUrl(value: unknown, registeredCallback: string): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin + url.pathname !== THREADS_AUTHORIZE_ENDPOINT || url.hash !== '' || url.username !== '' || url.password !== '') return false;
  const names = [...url.searchParams.keys()];
  if (names.length !== 5 || new Set(names).size !== 5) return false;
  const p = url.searchParams;
  return /^[0-9]{1,32}$/u.test(p.get('client_id') ?? '') && p.get('redirect_uri') === registeredCallback
    && p.get('scope') === THREADS_REQUIRED_SCOPE && p.get('response_type') === 'code'
    && /^[A-Za-z0-9_-]{43,128}$/u.test(p.get('state') ?? '');
}

export type ParsedConnectStart = { kind: 'start'; authorizationUrl: string; expiresAt: number } | { kind: 'failed'; code: string; reconcile: boolean };

const FAILURE_CODES = new Set(['AUTH_REQUIRED', 'REQUEST_INVALID', 'CALLBACK_INVALID', 'START_REFUSED', 'CALLBACK_REFUSED',
  'EXCHANGE_OUTCOME_UNCERTAIN', 'COMPLETE_OUTCOME_UNKNOWN', 'THREADS_CONNECT_RUNTIME_UNAVAILABLE', 'THREADS_CONNECT_DISABLED', 'METHOD_NOT_ALLOWED']);

function failureOf(payload: unknown): { kind: 'failed'; code: string; reconcile: boolean } {
  const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
  const code = typeof body.error === 'string' && FAILURE_CODES.has(body.error) ? body.error : 'THREADS_CONNECT_RUNTIME_UNAVAILABLE';
  return { kind: 'failed', code, reconcile: body.reconciliation_required === true };
}

/** The start answer: the validated authorization URL and its expiry, or a fixed failure. */
export function parseConnectStart(payload: unknown, ok: boolean, registeredCallback: string, now: number): ParsedConnectStart {
  if (!ok) return failureOf(payload);
  const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
  if (!body || body.ok !== true || body.provider !== 'threads' || !isThreadsAuthorizationUrl(body.authorization_url, registeredCallback)
    || typeof body.expires_at !== 'string') {
    return { kind: 'failed', code: 'THREADS_CONNECT_RUNTIME_UNAVAILABLE', reconcile: false };
  }
  const expiresAt = Date.parse(body.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 11 * 60 * 1000) {
    return { kind: 'failed', code: 'THREADS_CONNECT_RUNTIME_UNAVAILABLE', reconcile: false };
  }
  return { kind: 'start', authorizationUrl: body.authorization_url as string, expiresAt };
}

/** The callback answer: the verified receipt (publishing stays off), or a fixed failure. */
export function parseConnectCallback(payload: unknown, ok: boolean): ThreadsConnectStart {
  if (!ok) return failureOf(payload);
  const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
  if (!body || body.ok !== true || body.status !== 'connected' || body.provider !== 'threads' || body.publish_enabled !== false
    || typeof body.social_account_id !== 'string' || !/^sa_[0-9a-f]{24}$/u.test(body.social_account_id)) {
    return { kind: 'failed', code: 'THREADS_CONNECT_RUNTIME_UNAVAILABLE', reconcile: true };
  }
  return { kind: 'connected', socialAccountId: body.social_account_id };
}

/** Whether a URL is a return to our registered callback at all (anything else is ignored, not handled). */
export function isOurCallbackReturn(url: string, registeredCallback: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname === registeredCallback;
  } catch {
    return false;
  }
}

export const CONNECT_FAILURE_COPY: Record<string, string> = {
  AUTH_REQUIRED: 'ログインの有効期限が切れました。もう一度ログインしてから接続してください。',
  SESSION_CHANGED: '接続の途中でログイン中のアカウントが変わったため、中止しました。',
  CALLBACK_INVALID: 'Threadsからの戻り先を確認できなかったため、中止しました。もう一度お試しください。',
  CALLBACK_NOT_CONFIGURED: 'Threadsとの接続の準備（戻り先の設定）がまだ整っていません。',
  IN_PROGRESS: '接続の処理がすでに進んでいます。',
  START_REFUSED: 'Threadsとの接続を始められませんでした。時間をおいて、もう一度お試しください。',
  CALLBACK_REFUSED: '接続を完了できませんでした。もう一度最初から接続してください。',
  EXCHANGE_OUTCOME_UNCERTAIN: '接続の結果を確認できませんでした。重複を避けるため自動では再試行しません。時間をおいて、もう一度最初から接続してください。',
  COMPLETE_OUTCOME_UNKNOWN: '接続が完了したかどうか確認できませんでした。アカウント一覧を確認してください。',
  THREADS_CONNECT_DISABLED: 'Threadsとの接続は、まだ利用できません。',
  THREADS_CONNECT_RUNTIME_UNAVAILABLE: 'Threadsとの接続は、現在利用できません。時間をおいて、もう一度お試しください。',
};

export function connectFailureCopy(code: string): string {
  return CONNECT_FAILURE_COPY[code] ?? CONNECT_FAILURE_COPY.THREADS_CONNECT_RUNTIME_UNAVAILABLE;
}
