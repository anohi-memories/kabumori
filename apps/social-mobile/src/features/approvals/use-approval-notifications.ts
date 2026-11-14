import { useEffect, useRef, useState } from 'react';
import type { ApprovalNotification } from './approval-client';
import { UNCERTAIN } from './approval-client';
import {
  actionOf, ACTION_TEXT, type ApprovalAction, type ApprovalBlock, groupedUnreadCount, groupNotifications, LIFECYCLE_UNKNOWN_TEXT, MARK_READ_FAILED_TEXT,
  type NotificationGroup, NOTIFICATIONS_ENDED_TEXT,
} from './approval-view';
import {
  acceptPage, FIRST_PAGE_SIZE, moreOf, MORE_PAGE_SIZE, type NotificationsMore, startWalk, type StopReason,
} from './notification-pages';
import { useApprovalEnv } from './use-approval-env';

/** `next`: the `before` of the next older page (null: none); `stopped`: why this walk makes no more requests (G1 TASK 51). */
export type NotificationList =
  | { state: 'loading' }
  | { state: 'ready'; items: ApprovalNotification[]; next: number | null; pages: number; stopped: StopReason | null }
  | { state: 'error'; action: ApprovalAction };
/**
 * `ended`: the service gate said this person's service ended; the list stays readable and nothing is marked read any more.
 * `gen`: which first-page read the list belongs to; an answer for the older page of an earlier read never lands in a newer one.
 */
type Box = { scope: string; list: NotificationList; notice: string | null; ended: boolean; more: 'idle' | 'loading' | 'retry'; gen: number };

export type NotificationsView =
  | { kind: 'blocked'; block: ApprovalBlock }
  | { kind: 'open'; list: NotificationList; groups: NotificationGroup[]; unread: number; notice: string | null; readOnly: boolean; more: NotificationsMore; open: (n: ApprovalNotification) => void; reload: () => void };

/**
 * The person's own notifications (G3 contract §5), newest first, read again on every return to the screen. Opening one marks it read
 * (idempotent; the first read time stays). A refusal of the person's access drops the list. Nothing here says a push was delivered.
 *
 * G1 TASK 47 (G2 #11 P3): G3 still answers markRead 200 after the service ended, so the app does not send it unless the service gate
 * confirmed, just before, that the service runs for this person and login. Every read of the list asks too (a return to the screen,
 * a reload), so an end seen there turns this screen read-only (and the gate closes the app to its own screen with the read-only
 * history). No answer is not a yes: nothing is marked and the person is told so.
 */
export function useApprovalNotifications(): NotificationsView {
  const env = useApprovalEnv();
  const [box, setBox] = useState<Box | null>(null);
  const [reads, setReads] = useState(0);
  const live = useRef<string | null>(null);
  // Rows of this scope whose read is being confirmed or sent: a second tap meanwhile sends nothing more.
  const sending = useRef<{ scope: string | null; ids: Set<string> }>({ scope: null, ids: new Set() });
  // The page being asked for (scope, read, cursor): a second press before the answer asks for nothing more.
  const paging = useRef<string | null>(null);
  const scope = env.notificationScope;
  const client = env.client;
  const confirmActive = env.confirmActive;

  if (scope === null ? box !== null : box?.scope !== scope) setBox(scope === null ? null : { scope, list: { state: 'loading' }, notice: null, ended: false, more: 'idle', gen: 0 });
  const update = (mine: string, change: (current: Box) => Box) => setBox((current) => (current && current.scope === mine ? change(current) : current));
  // A read that failed shows no list and says only that it could not read (the card); an end of the person's access also says why.
  const refused = (mine: string, action: ApprovalAction) => setBox((current) => (current && current.scope === mine
    ? { scope: mine, list: { state: 'error', action }, notice: action === 'sign_in' || action === 'forbidden' ? ACTION_TEXT[action] : null, ended: current.ended, more: 'idle', gen: current.gen + 1 }
    : current));
  const endedFor = (mine: string) => update(mine, (current) => ({ ...current, ended: true, notice: NOTIFICATIONS_ENDED_TEXT }));

  useEffect(() => {
    live.current = scope;
    if (sending.current.scope !== scope) sending.current = { scope, ids: new Set() };
    if (scope === null || !client) return;
    const mine = scope;
    let cancelled = false;
    void client.notificationPage({ limit: FIRST_PAGE_SIZE }).then((answer) => {
      if (cancelled || live.current !== mine) return;
      // A list that answered: an older warning goes with it (G1 TASK 45, G2 #9 A18), but not the read-only state. It starts a new walk
      // of the history: the cursor is kept in memory only and every read of the first page begins again from the newest (G3 §5b).
      if (answer.ok) {
        const walk = startWalk(answer.value);
        update(mine, (current) => ({
          ...current, list: { state: 'ready', items: walk.rows, next: walk.next, pages: walk.pages, stopped: walk.stopped },
          notice: current.ended ? NOTIFICATIONS_ENDED_TEXT : null, more: 'idle', gen: current.gen + 1,
        }));
        return;
      }
      refused(mine, actionOf(answer.code, answer.definite));
    });
    void confirmActive().then((check) => {
      if (!cancelled && live.current === mine && check === 'ended') endedFor(mine);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, env.refocus, reads]);

  if (scope === null || !client) return { kind: 'blocked', block: env.notificationBlock ?? 'workspace_unavailable' };
  const mine = scope;
  const shown = box && box.scope === mine ? box : null;
  const list = shown?.list ?? { state: 'loading' };
  const readOnly = shown?.ended === true;

  const groups = list.state === 'ready' ? groupNotifications(list.items) : [];
  // Opening a line marks it read, and (G3 §5a) the older unread requests of the same candidate too: one call each, each shown only on
  // success, and only after the gate confirmed the service for this person just now.
  const open = (n: ApprovalNotification) => {
    if (readOnly) return;
    const group = groups.find((g) => g.row.notificationId === n.notificationId);
    const ids = sending.current.ids;
    const rows = [n, ...(group?.older ?? [])].filter((row) => row.readAt === null && !ids.has(row.notificationId));
    if (!rows.length) return;
    for (const row of rows) ids.add(row.notificationId);
    void confirmActive().then((check) => {
      if (live.current !== mine || check !== 'active') {
        for (const row of rows) ids.delete(row.notificationId);
        if (live.current !== mine) return;
        if (check === 'ended') endedFor(mine);
        else update(mine, (current) => ({ ...current, notice: LIFECYCLE_UNKNOWN_TEXT }));
        return;
      }
      for (const row of rows) markOne(row, ids);
    });
  };
  const markOne = (n: ApprovalNotification, ids: Set<string>) => {
    void client.markRead(n.notificationId).then((answer) => {
      ids.delete(n.notificationId);
      if (live.current !== mine) return;
      if (answer.ok) {
        update(mine, (current) => (current.list.state === 'ready'
          ? { ...current, list: { ...current.list, items: current.list.items.map((item) => (item.notificationId === n.notificationId ? answer.value : item)) } }
          : current));
        return;
      }
      const action = actionOf(answer.code, answer.definite);
      if (action === 'forbidden') {
        // A server that refuses the read of an ended service (a later G3 guard): the gate checks and closes the app.
        refused(mine, action);
        void confirmActive().then((check) => { if (live.current === mine && check === 'ended') endedFor(mine); });
        return;
      }
      if (action === 'sign_in') { refused(mine, action); return; }
      // Gone (or never the person's): the list says what is left.
      if (action === 'not_found') setReads((value) => value + 1);
      update(mine, (current) => ({ ...current, notice: action === 'not_found' ? 'このお知らせは見つかりませんでした。最新の一覧を読み込みます。' : MARK_READ_FAILED_TEXT }));
    });
  };

  // The next older page, on the person's own press (a read: allowed in the read-only state too). One at a time, for the cursor the list
  // holds now; the answer is used only if the list is still that walk (same first-page read, same cursor), so a late answer of an
  // earlier read, a sign-out or another person's screen adds nothing. A page that is not the next older page stops the walk (fail-closed).
  const loadMore = () => {
    const cur = shown;
    if (!cur || cur.list.state !== 'ready' || cur.more === 'loading' || cur.list.next === null || cur.list.stopped !== null) return;
    const before = cur.list.next;
    const generation = cur.gen;
    const asked = `${mine}|${generation}|${before}`;
    if (paging.current === asked) return;
    paging.current = asked;
    update(mine, (current) => ({ ...current, more: 'loading' }));
    void client.notificationPage({ limit: MORE_PAGE_SIZE, before }).then((answer) => {
      if (paging.current === asked) paging.current = null;
      if (live.current !== mine) return;
      setBox((current) => {
        if (!current || current.scope !== mine || current.gen !== generation || current.list.state !== 'ready' || current.list.next !== before) return current;
        if (!answer.ok) {
          const action = actionOf(answer.code, answer.definite);
          if (action === 'sign_in' || action === 'forbidden') return { ...current, list: { state: 'error', action }, notice: ACTION_TEXT[action], more: 'idle', gen: current.gen + 1 };
          // A 200 that is not a page (UNCERTAIN with status 200) is an answer that cannot be trusted: the walk stops. A lost answer
          // (network, 5xx, timeout) keeps the cursor: pressing again asks for the same page.
          if (answer.code === UNCERTAIN && answer.status === 200) return { ...current, more: 'idle', list: { ...current.list, next: null, stopped: 'invalid_page' } };
          return { ...current, more: 'retry' };
        }
        const walk = { rows: current.list.items, next: current.list.next, pages: current.list.pages, stopped: current.list.stopped };
        const accepted = acceptPage(walk, before, answer.value);
        return { ...current, more: 'idle', list: { state: 'ready', items: accepted.walk.rows, next: accepted.walk.next, pages: accepted.walk.pages, stopped: accepted.walk.stopped } };
      });
    });
  };
  const more: NotificationsMore = { ...moreOf(list.state === 'ready' ? list : null, shown?.more ?? 'idle'), load: loadMore };

  return { kind: 'open', list, groups, unread: groupedUnreadCount(groups), notice: shown?.notice ?? null, readOnly, more, open, reload: () => setReads((value) => value + 1) };
}
