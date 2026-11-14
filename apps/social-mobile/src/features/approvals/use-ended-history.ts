import { useEffect, useMemo, useRef, useState } from 'react';
import { getSupabaseConfig, supabase } from '@/lib/supabase';
import { type ApprovalNotification, type Candidate, createApprovalClient, UNCERTAIN } from './approval-client';
import { APPROVAL_ENDPOINT, POSTONA_APPROVAL_UI_ENABLED } from './approval-gate';
import { actionOf, groupNotifications, type NotificationGroup, readFailedText } from './approval-view';
import { acceptPage, FIRST_PAGE_SIZE, type MoreFlag, moreOf, MORE_PAGE_SIZE, type NotificationsMore, startWalk, type Walk } from './notification-pages';

/** At most this many candidates are read one by one behind the notifications. */
export const ENDED_HISTORY_CANDIDATES = 20;

export type EndedHistoryView =
  | { state: 'off' }
  | { state: 'loading' }
  | { state: 'error'; message: string; reload: () => void }
  | { state: 'ready'; groups: NotificationGroup[]; candidates: Candidate[]; unreadable: number; more: NotificationsMore; reload: () => void };
/** `tried`: the candidates already asked for (at most ENDED_HISTORY_CANDIDATES in all); `gen`: which first-page read this walk belongs to. */
type Box = { owner: string; gen: number; state: 'loading' | 'error' | 'ready'; message: string; walk: Walk | null; candidates: Candidate[]; tried: string[]; unreadable: number; more: MoreFlag };

/**
 * G1 TASK 46 (G2 #10, G3-02 #19 §5a): what a person whose X autopost service has ended may still see. G3 answers `notifications` and
 * `get` for them (submit / revise / approve are refused with SERVICE_NOT_ACTIVE), so this reads the person's own notifications and the
 * candidates they name, and offers nothing else: no submit, revise, approve, reject or markRead is ever sent from here. The token is the
 * one of `userId`'s session only; another person's session sends nothing and sees nothing of this one.
 *
 * G1 TASK 51 (G3-02 #22/#23 §5b): past the first page the history is read on the person's own press, newest to oldest, by the cursor the
 * server gave (see notification-pages.ts); still reads only. A walk starts again from the first page on every read of it (opening the
 * view, 「最新の状態を読み込む」) and its cursor lives in memory only.
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
  const paging = useRef<string | null>(null);
  const reload = () => setReads((value) => value + 1);

  /** Up to the cap of candidates, one by one (a candidate the server does not give back is counted, never shown). */
  const readCandidates = async (ids: readonly string[], tried: readonly string[]) => {
    const fresh = [...new Set(ids)].filter((id) => !tried.includes(id)).slice(0, Math.max(0, ENDED_HISTORY_CANDIDATES - tried.length));
    const answers = await Promise.all(fresh.map((id) => client!.get(id)));
    return { tried: [...tried, ...fresh], found: answers.flatMap((a) => (a.ok ? [a.value] : [])), missed: answers.length - answers.flatMap((a) => (a.ok ? [a.value] : [])).length };
  };
  const idsOf = (rows: readonly ApprovalNotification[]) => rows.map((n) => n.candidateId).filter((id): id is string => !!id);

  useEffect(() => {
    live.current = userId;
    if (!client || !userId) return;
    const mine = userId;
    let cancelled = false;
    const put = (change: (current: Box | null) => Box | null) => { if (!cancelled && live.current === mine) setBox(change); };
    void (async () => {
      const notes = await client.notificationPage({ limit: FIRST_PAGE_SIZE });
      if (!notes.ok) { put((c) => ({ owner: mine, gen: (c?.gen ?? 0) + 1, state: 'error', message: readFailedText(actionOf(notes.code, notes.definite)), walk: null, candidates: [], tried: [], unreadable: 0, more: 'idle' })); return; }
      const walk = startWalk(notes.value);
      const read = await readCandidates(idsOf(walk.rows), []);
      put((c) => ({ owner: mine, gen: (c?.gen ?? 0) + 1, state: 'ready', message: '', walk, candidates: read.found, tried: read.tried, unreadable: read.missed, more: 'idle' }));
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, userId, reads]);

  // The next older page, on the person's press: for the cursor this walk holds now, once; its answer lands only in the same walk (same
  // first-page read, same cursor), so a late answer of an earlier read, another person's screen or a sign-out adds nothing.
  const loadMore = () => {
    const cur = box;
    if (!client || !userId || !cur || cur.owner !== userId || cur.state !== 'ready' || !cur.walk || cur.walk.next === null || cur.walk.stopped !== null || cur.more === 'loading') return;
    const mine = userId;
    const before = cur.walk.next;
    const generation = cur.gen;
    const asked = `${mine}|${generation}|${before}`;
    if (paging.current === asked) return;
    paging.current = asked;
    setBox((c) => (c && c.owner === mine && c.gen === generation ? { ...c, more: 'loading' } : c));
    const same = (c: Box | null): c is Box => !!c && c.owner === mine && c.gen === generation && c.state === 'ready' && !!c.walk && c.walk.next === before;
    void client.notificationPage({ limit: MORE_PAGE_SIZE, before }).then(async (answer) => {
      if (paging.current === asked) paging.current = null;
      if (live.current !== mine) return;
      if (!answer.ok) {
        const action = actionOf(answer.code, answer.definite);
        setBox((c) => {
          if (!same(c)) return c;
          if (action === 'sign_in' || action === 'forbidden') return { ...c, state: 'error', message: readFailedText(action), walk: null, more: 'idle', gen: c.gen + 1 };
          if (answer.code === UNCERTAIN && answer.status === 200 && c.walk) return { ...c, more: 'idle', walk: { ...c.walk, next: null, stopped: 'invalid_page' } };
          return { ...c, more: 'retry' };
        });
        return;
      }
      let accepted: { walk: Walk; added: boolean } | null = null;
      let added: ApprovalNotification[] = [];
      setBox((c) => {
        if (!same(c) || !c.walk) return c;
        accepted = acceptPage(c.walk, before, answer.value);
        added = accepted.added ? answer.value.rows : [];
        return { ...c, more: 'idle', walk: accepted.walk };
      });
      // The candidates the new rows name, up to the cap, only if the walk took the page.
      if (!added.length) return;
      const current = box;
      const read = await readCandidates(idsOf(added), current && current.owner === mine ? current.tried : []);
      setBox((c) => (c && c.owner === mine && c.gen === generation
        ? { ...c, tried: read.tried, candidates: [...c.candidates, ...read.found.filter((f) => !c.candidates.some((k) => k.candidateId === f.candidateId))], unreadable: c.unreadable + read.missed }
        : c));
    });
  };

  if (!client || !userId) return { state: 'off' };
  if (!box || box.owner !== userId || box.state === 'loading') return { state: 'loading' };
  if (box.state === 'error') return { state: 'error', message: box.message, reload };
  return { state: 'ready', groups: groupNotifications(box.walk?.rows ?? []), candidates: box.candidates, unreadable: box.unreadable, more: { ...moreOf(box.walk, box.more), load: loadMore }, reload };
}
