import { useEffect, useRef, useState } from 'react';
import type { ApprovalNotification } from './approval-client';
import { actionOf, ACTION_TEXT, type ApprovalAction, type ApprovalBlock, groupedUnreadCount, groupNotifications, MARK_READ_FAILED_TEXT, type NotificationGroup } from './approval-view';
import { useApprovalEnv } from './use-approval-env';

export type NotificationList = { state: 'loading' } | { state: 'ready'; items: ApprovalNotification[] } | { state: 'error'; action: ApprovalAction };
type Box = { scope: string; list: NotificationList; notice: string | null };

export type NotificationsView =
  | { kind: 'blocked'; block: ApprovalBlock }
  | { kind: 'open'; list: NotificationList; groups: NotificationGroup[]; unread: number; notice: string | null; open: (n: ApprovalNotification) => void; reload: () => void };

/**
 * The person's own notifications (G3 contract §5), newest first, read again on every return to the screen. Opening one marks it read
 * (idempotent; the first read time stays). A refusal of the person's access drops the list. Nothing here says a push was delivered.
 */
export function useApprovalNotifications(): NotificationsView {
  const env = useApprovalEnv();
  const [box, setBox] = useState<Box | null>(null);
  const [reads, setReads] = useState(0);
  const live = useRef<string | null>(null);
  const scope = env.notificationScope;
  const client = env.client;

  if (scope === null ? box !== null : box?.scope !== scope) setBox(scope === null ? null : { scope, list: { state: 'loading' }, notice: null });
  const update = (mine: string, change: (current: Box) => Box) => setBox((current) => (current && current.scope === mine ? change(current) : current));
  // A read that failed shows no list and says only that it could not read (the card); an end of the person's access also says why.
  const refused = (mine: string, action: ApprovalAction) => setBox((current) => (current && current.scope === mine
    ? { scope: mine, list: { state: 'error', action }, notice: action === 'sign_in' || action === 'forbidden' ? ACTION_TEXT[action] : null }
    : current));

  useEffect(() => {
    live.current = scope;
    if (scope === null || !client) return;
    const mine = scope;
    let cancelled = false;
    void client.notifications(50).then((answer) => {
      if (cancelled || live.current !== mine) return;
      // A list that answered: an older warning goes with it (G1 TASK 45, G2 #9 A18).
      if (answer.ok) { update(mine, (current) => ({ ...current, list: { state: 'ready', items: answer.value }, notice: null })); return; }
      refused(mine, actionOf(answer.code, answer.definite));
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, env.refocus, reads]);

  if (scope === null || !client) return { kind: 'blocked', block: env.notificationBlock ?? 'workspace_unavailable' };
  const mine = scope;
  const shown = box && box.scope === mine ? box : null;
  const list = shown?.list ?? { state: 'loading' };

  const groups = list.state === 'ready' ? groupNotifications(list.items) : [];
  // Opening a line marks it read, and (G3 §5a) the older unread requests of the same candidate too: one call each, each shown only on success.
  const open = (n: ApprovalNotification) => {
    const group = groups.find((g) => g.row.notificationId === n.notificationId);
    for (const row of [n, ...(group?.older ?? [])]) if (row.readAt === null) markOne(row);
  };
  const markOne = (n: ApprovalNotification) => {
    void client.markRead(n.notificationId).then((answer) => {
      if (live.current !== mine) return;
      if (answer.ok) {
        update(mine, (current) => (current.list.state === 'ready'
          ? { ...current, list: { state: 'ready', items: current.list.items.map((item) => (item.notificationId === n.notificationId ? answer.value : item)) } }
          : current));
        return;
      }
      const action = actionOf(answer.code, answer.definite);
      if (action === 'sign_in' || action === 'forbidden') { refused(mine, action); return; }
      // Gone (or never the person's): the list says what is left.
      if (action === 'not_found') setReads((value) => value + 1);
      update(mine, (current) => ({ ...current, notice: action === 'not_found' ? 'このお知らせは見つかりませんでした。最新の一覧を読み込みます。' : MARK_READ_FAILED_TEXT }));
    });
  };

  return { kind: 'open', list, groups, unread: groupedUnreadCount(groups), notice: shown?.notice ?? null, open, reload: () => setReads((value) => value + 1) };
}
