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

export type ThreadsConnectStart = { kind: 'opened' } | { kind: 'unavailable'; code: string };

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
