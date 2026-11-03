import { useEffect, useMemo, useRef, useState } from 'react';
import { usePersonalWorkspace } from '@/features/personal-workspace/personal-workspace-provider';
import { HOME_LOGIN_TEXT, HOME_NO_ACCESS_TEXT, homeReservationsOf, type HomeReservations } from '@/features/reservations/home-reservations';
import { useRefocusCount } from '@/features/reservations/use-refocus-count';
import { useXWriteGuard } from '@/features/reservations/use-x-write-guard';
import { isXRowNotEditable } from '@/features/reservations/x-reconnect-signal';
import { reservationErrorAction } from '@/features/schedule/reservation-error-actions';
import { createReservationStore, POSTONA_RESERVATION_PERSISTENCE_ENABLED } from '@/features/schedule/reservation-store';
import { applyListAnswer, serverListFor, type ServerListSnapshot } from '@/features/schedule/server-reservations-state';
import { getSupabaseConfig, supabase } from '@/lib/supabase';

/**
 * G3's list for the home, read on arrival and on every return. Release gate OFF: the disabled store, nothing is read or sent.
 * Bound to the person, login and account it was read for. G3 answers 200 and no rows for an account that is not the caller's,
 * so that is not asked: such an account has no number, never 「0件」.
 */
export function useHomeReservations(account: { id: string; brandId?: string; connectionStatus: string; platform: string } | null, status: string): { view: HomeReservations; reload: () => void } {
  const store = useMemo(() => {
    const config = getSupabaseConfig();
    const live = supabase && config.ok ? { supabaseUrl: config.config.url, session: supabase, publishableKey: config.config.publishableKey } : null;
    return createReservationStore(POSTONA_RESERVATION_PERSISTENCE_ENABLED, live);
  }, []);
  const guard = useXWriteGuard(account);
  const { view: workspace } = usePersonalWorkspace();
  const refocus = useRefocusCount();
  const [reads, setReads] = useState(0);
  const [snapshot, setSnapshot] = useState<ServerListSnapshot | null>(null);
  const loads = useRef(0);
  const applies = store.enabled && status !== 'mock_preview' && account?.platform === 'x';
  const own = applies && workspace.kind === 'ready' && account?.brandId === workspace.workspaceId;
  const accountId = own ? account.id : null;
  const scope = guard.scope;
  useEffect(() => {
    if (!accountId || !scope || !guard.canRead) return;
    loads.current += 1;
    const loadId = loads.current;
    const sentToken = guard.token;
    let cancelled = false;
    void store.list(accountId).then((answer) => {
      if (cancelled) return;
      setSnapshot((current) => applyListAnswer(current, scope, loadId, answer));
      if (!answer.ok && reservationErrorAction(answer.code) === 'sign_in') guard.refuseToken(sentToken);
    });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, scope, guard.canRead, store, refocus, reads]);
  const reload = () => setReads((value) => value + 1);
  if (!applies) return { view: { kind: 'not_applicable' }, reload };
  if (!scope) return { view: { kind: 'no_access', text: HOME_LOGIN_TEXT }, reload };
  if (workspace.kind === 'idle' || workspace.kind === 'preparing') return { view: { kind: 'loading' }, reload };
  if (!own) return { view: { kind: 'no_access', text: HOME_NO_ACCESS_TEXT }, reload };
  return { view: homeReservationsOf(serverListFor(snapshot, scope), isXRowNotEditable, new Date().getTime(), reservationErrorAction), reload };
}
