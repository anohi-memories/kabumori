// G1 TASK 51 (G3-02 #22/#23, contract §5b): the history of notifications past the first page. Pure: the hooks keep the state and send; this
// decides what a page may add. A walk is started by a first page read (the screen opens, or reads again) and kept in memory only. It only ever
// asks for `before` = the last cursor it was given, adds a page only if it is exactly the next older page, and stops for good (until a new
// first page) at the first answer that is not a page it can continue from.
import type { ApprovalNotification, NotificationPage } from './approval-client.ts';
import { isCursor } from './approval-client.ts';

/** The first page keeps its size (G3 default); later pages ask for the most G3 gives (1-100). */
export const FIRST_PAGE_SIZE = 50;
export const MORE_PAGE_SIZE = 100;
/** A walk never holds more than this many pages (2,000 rows): what is older is not shown, and the screen says so. */
export const MAX_PAGES = 20;

export type Walk = {
  rows: ApprovalNotification[];
  /** The `before` of the next page; null when the walk reached its end. */
  next: number | null;
  pages: number;
  /** Set when a page could not be accepted: no further request is made by this walk. */
  stopped: StopReason | null;
};
export type StopReason = 'invalid_page' | 'duplicate' | 'order' | 'cursor' | 'capped';

/** The walk a first page starts. A first page that is not usable still shows its rows but cannot be continued. */
export function startWalk(page: NotificationPage, size = FIRST_PAGE_SIZE): Walk {
  const bad = pageProblem(page, null, size);
  if (bad) return { rows: page.rows, next: null, pages: 1, stopped: bad };
  return { rows: page.rows, next: page.nextCursor, pages: 1, stopped: page.nextCursor !== null && 1 >= MAX_PAGES ? 'capped' : null };
}

/** What is wrong with a page asked for with `before` (null: the first page), or null when it is a page we can continue from. */
export function pageProblem(page: NotificationPage, before: number | null, size: number): StopReason | null {
  if (page.rows.length > size) return 'invalid_page';
  let previous = before;
  const seen = new Set<string>();
  for (const row of page.rows) {
    if (seen.has(row.notificationId)) return 'duplicate';
    seen.add(row.notificationId);
    if (row.cursor === undefined) {
      // a server without paging: the first page only, and no way to continue from it
      if (before !== null || page.nextCursor !== null) return 'cursor';
      continue;
    }
    if (!isCursor(row.cursor)) return 'cursor';
    if (previous !== null && row.cursor >= previous) return 'order';
    previous = row.cursor;
  }
  if (page.nextCursor !== null) {
    const last = page.rows[page.rows.length - 1];
    if (!last || last.cursor === undefined || page.nextCursor !== last.cursor) return 'cursor';
  }
  return null;
}

/** Add the page asked for with `before` to the walk. A page for any other cursor (a late answer of an earlier walk) adds nothing. */
export function acceptPage(walk: Walk, before: number, page: NotificationPage, size = MORE_PAGE_SIZE): { walk: Walk; added: boolean } {
  if (walk.stopped || walk.next === null || walk.next !== before) return { walk, added: false };
  const problem = pageProblem(page, before, size);
  if (problem) return { walk: { ...walk, next: null, stopped: problem }, added: false };
  const known = new Set(walk.rows.map((row) => row.notificationId));
  if (page.rows.some((row) => known.has(row.notificationId))) return { walk: { ...walk, next: null, stopped: 'duplicate' }, added: false };
  const pages = walk.pages + 1;
  const capped = page.nextCursor !== null && pages >= MAX_PAGES;
  return { walk: { rows: [...walk.rows, ...page.rows], next: capped ? null : page.nextCursor, pages, stopped: capped ? 'capped' : null }, added: true };
}

export const PAGES_MORE_TEXT = 'さらに読み込む';
export const PAGES_LOADING_TEXT = '読み込んでいます…';
export const PAGES_RETRY_TEXT = 'お知らせの続きを読み込めませんでした。通信状態を確かめて、もう一度押してください。';
export const PAGES_END_TEXT = 'これより古いお知らせはありません。';
export const PAGES_STOP_TEXT: Readonly<Record<StopReason, string>> = {
  invalid_page: 'お知らせの続きを正しく読み取れなかったため、ここで止めました。「最新の状態を読み込む」で最初から読み直せます。',
  duplicate: 'お知らせの続きに同じものが重なっていたため、ここで止めました。「最新の状態を読み込む」で最初から読み直せます。',
  order: 'お知らせの続きの順序が正しくなかったため、ここで止めました。「最新の状態を読み込む」で最初から読み直せます。',
  cursor: 'お知らせの続きの位置を確認できなかったため、ここで止めました。「最新の状態を読み込む」で最初から読み直せます。',
  capped: `新しい順に${MAX_PAGES * MORE_PAGE_SIZE}件まで表示しました。これより古いお知らせは、このアプリでは表示しません。`,
};

/** The "さらに読み込む" row under a list: what it shows and what pressing it does (reads only). */
export type NotificationsMore = { state: 'none' | 'available' | 'loading' | 'retry' | 'end' | 'stopped'; label: string | null; text: string | null; load: () => void };
export type MoreFlag = 'idle' | 'loading' | 'retry';
export function moreOf(walk: { next: number | null; pages: number; stopped: StopReason | null } | null, flag: MoreFlag): Omit<NotificationsMore, 'load'> {
  if (!walk) return { state: 'none', label: null, text: null };
  if (walk.stopped) return { state: 'stopped', label: null, text: PAGES_STOP_TEXT[walk.stopped] };
  if (walk.next !== null) {
    if (flag === 'loading') return { state: 'loading', label: PAGES_LOADING_TEXT, text: null };
    if (flag === 'retry') return { state: 'retry', label: PAGES_MORE_TEXT, text: PAGES_RETRY_TEXT };
    return { state: 'available', label: PAGES_MORE_TEXT, text: null };
  }
  return walk.pages > 1 ? { state: 'end', label: null, text: PAGES_END_TEXT } : { state: 'none', label: null, text: null };
}
