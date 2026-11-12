import { useEffect, useMemo, useRef, useState } from 'react';
import { getSupabaseConfig, supabase } from '@/lib/supabase';
import { type ApprovalNotification, type Candidate, createApprovalClient } from './approval-client';
import { APPROVAL_ENDPOINT, POSTONA_APPROVAL_UI_ENABLED } from './approval-gate';
import { actionOf, groupNotifications, type NotificationGroup, readFailedText } from './approval-view';

/** At most this many candidates are read one by one behind the notifications. */
export const ENDED_HISTORY_CANDIDATES = 20;

export type EndedHistoryView =
  | { state: 'off' }
  | { state: 'loading' }
  | { state: 'error'; message: string; reload: () => void }
  | { state: 'ready'; groups: NotificationGroup[]; candidates: Candidate[]; unreadable: number; reload: () => void };
type Box = { owner: string; view: EndedHistoryView };

/**
 * G1 TASK 46 (G2 #10, G3-02 #19 §5a): what a person whose X autopost service has ended may still see. G3 answers `notifications` and
 * `get` for them (submit / revise / approve are refused with SERVICE_NOT_ACTIVE), so this reads the person's own notifications and the
 * candidates they name, and offers nothing else: no submit, revise, approve, reject or markRead is ever sent from here. The token is the
 * one of `userId`'s session only; another person's session sends nothing and sees nothing of this one.
 */
export function useEndedHistory(userId: string | null): EndedHistoryView {
  const config = getSupabaseConfig();
  const url = config.ok ? config.config.url : null;
  const key = config.ok ? config.config.publishableKey : null;
  const client = useMemo(() => {
    if (!POSTONA_APPROVAL_UI_ENABLED || !supabase || !url || !key || !userId) return null;
    const auth = supabase.auth;
    try {
      return createApprovalClient({
        supabaseUrl: url,
        publishableKey: key,
        // Only this person's token: when the session now belongs to someone else, nothing is sent (AUTH_REQUIRED).
        accessToken: async () => { const s = (await auth.getSession()).data.session; return s && s.user?.id === userId ? s.access_token : null; },
        fetch: (input, init) => globalThis.fetch(input, init),
        functionName: APPROVAL_ENDPOINT.functionName,
        allowLoopbackHttpForTests: APPROVAL_ENDPOINT.allowLoopbackHttpForTests,
      });
    } catch {
      return null;
    }
  }, [url, key, userId]);
  const [box, setBox] = useState<Box | null>(null);
  const [reads, setReads] = useState(0);
  const live = useRef<string | null>(null);
  const reload = () => setReads((value) => value + 1);

  useEffect(() => {
    live.current = userId;
    if (!client || !userId) return;
    const mine = userId;
    let cancelled = false;
    const put = (view: EndedHistoryView) => { if (!cancelled && live.current === mine) setBox({ owner: mine, view }); };
    void (async () => {
      const notes = await client.notifications(50);
      if (!notes.ok) { put({ state: 'error', message: readFailedText(actionOf(notes.code, notes.definite)), reload }); return; }
      const ids = [...new Set(notes.value.map((n: ApprovalNotification) => n.candidateId).filter((id): id is string => !!id))].slice(0, ENDED_HISTORY_CANDIDATES);
      const answers = await Promise.all(ids.map((id) => client.get(id)));
      const candidates = answers.flatMap((a) => (a.ok ? [a.value] : []));
      put({ state: 'ready', groups: groupNotifications(notes.value), candidates, unreadable: answers.length - candidates.length, reload });
    })();
    return () => { cancelled = true; };
  }, [client, userId, reads]);

  if (!client || !userId) return { state: 'off' };
  return box && box.owner === userId ? box.view : { state: 'loading' };
}
