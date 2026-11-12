import { useEffect, useRef, useState } from 'react';
import type { ApprovalNotification } from './approval-client';
import {
  actionOf, ACTION_TEXT, type ApprovalAction, type ApprovalBlock, groupedUnreadCount, groupNotifications, LIFECYCLE_UNKNOWN_TEXT, MARK_READ_FAILED_TEXT,
  type NotificationGroup, NOTIFICATIONS_ENDED_TEXT,
} from './approval-view';
import { useApprovalEnv } from './use-approval-env';

export type NotificationList = { state: 'loading' } | { state: 'ready'; items: ApprovalNotification[] } | { state: 'error'; action: ApprovalAction };
/** `ended`: the service gate said this person's service ended; the list stays readable and nothing is marked read any more. */
type Box = { scope: string; list: NotificationList; notice: string | null; ended: boolean };

export type NotificationsView =
  | { kind: 'blocked'; block: ApprovalBlock }
  | { kind: 'open'; list: NotificationList; groups: NotificationGroup[]; unread: number; notice: string | null; readOnly: boolean; open: (n: ApprovalNotification) => void; reload: () => void };

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
  const scope = env.notificationScope;
  const client = env.client;
  const confirmActive = env.confirmActive;

  if (scope === null ? box !== null : box?.scope !== scope) setBox(scope === null ? null : { scope, list: { state: 'loading' }, notice: null, ended: false });
  const update = (mine: string, change: (current: Box) => Box) => setBox((current) => (current && current.scope === mine ? change(current) : current));
  // A read that failed shows no list and says only that it could not read (the card); an end of the person's access also says why.
  const refused = (mine: string, action: ApprovalAction) => setBox((current) => (current && current.scope === mine
    ? { scope: mine, list: { state: 'error', action }, notice: action === 'sign_in' || action === 'forbidden' ? ACTION_TEXT[action] : null, ended: current.ended }
    : current));
  const endedFor = (mine: string) => update(mine, (current) => ({ ...current, ended: true, notice: NOTIFICATIONS_ENDED_TEXT }));

  useEffect(() => {
    live.current = scope;
    if (sending.current.scope !== scope) sending.current = { scope, ids: new Set() };
    if (scope === null || !client) return;
    const mine = scope;
    let cancelled = false;
    void client.notifications(50).then((answer) => {
      if (cancelled || live.current !== mine) return;
      // A list that answered: an older warning goes with it (G1 TASK 45, G2 #9 A18), but not the read-only state.
      if (answer.ok) { update(mine, (current) => ({ ...current, list: { state: 'ready', items: answer.value }, notice: current.ended ? NOTIFICATIONS_ENDED_TEXT : null })); return; }
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
          ? { ...current, list: { state: 'ready', items: current.list.items.map((item) => (item.notificationId === n.notificationId ? answer.value : item)) } }
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

  return { kind: 'open', list, groups, unread: groupedUnreadCount(groups), notice: shown?.notice ?? null, readOnly, open, reload: () => setReads((value) => value + 1) };
}
