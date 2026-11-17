// G1-02 TASK 2: where a person who uses Threads starts a post. The home card and the manual-publish screen are X's (the X single-post port);
// Threads is posted from the Threads account's own detail (ThreadsPublishCard: consent, the server's check, the attempt and its recovery).
// This only points there. Pure: no state, no request, nothing is switched on; the Threads card keeps its own release gate.
import type { SocialAccount } from '@/domain/types';

export const THREADS_ENTRY_TITLE = 'Threadsに投稿する';
export type ThreadsEntry =
  | { kind: 'open'; accountId: string; text: string; label: string }
  | { kind: 'connect'; text: string; label: string };

export const THREADS_ENTRY_OPEN_TEXT = 'Threadsへの投稿は、Threadsアカウントの詳細から行います。接続の状態、投稿の確認、結果はそこに出ます。';
export const THREADS_ENTRY_CONNECT_TEXT = 'Threadsアカウントはまだ接続されていません。アカウント画面で接続すると、Threadsアカウントの詳細から投稿できます。';

/** The Threads account to open: the active one when it is Threads, else the first Threads account; none -> the way to connect one. */
export function threadsEntry(accounts: readonly Pick<SocialAccount, 'id' | 'platform'>[], activeId: string | null): ThreadsEntry {
  const threads = accounts.filter((account) => account.platform === 'threads');
  const chosen = threads.find((account) => account.id === activeId) ?? threads[0];
  if (!chosen) return { kind: 'connect', text: THREADS_ENTRY_CONNECT_TEXT, label: 'アカウント画面を開く' };
  return { kind: 'open', accountId: chosen.id, text: THREADS_ENTRY_OPEN_TEXT, label: 'Threadsアカウントの詳細を開く' };
}
