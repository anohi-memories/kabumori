import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { selectDataSource } from '@/data/repository-selection';
import {
  createPersonalWorkspaceCall,
  ensurePersonalWorkspace,
  type PersonalWorkspaceOutcome,
} from '@/domain/personal-workspace';
import { EnrollmentCancelledError, loginSessionIdOf } from '@/domain/service-enrollment';
import { getSupabaseConfig } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { useDataStatus } from '@/providers/data-provider';

/** What the app knows about the person's personal workspace now. Only 'ready' lets the AI post assist be asked. */
export type PersonalWorkspaceView =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  /** W0 answered this id AND the snapshot read after it shows the same personal workspace. */
  | { kind: 'ready'; workspaceId: string }
  /** W0 answered, but the snapshot read again after it does not show that workspace. */
  | { kind: 'unconfirmed' }
  | { kind: 'relogin' }
  | { kind: 'service_inactive' }
  | { kind: 'not_available' }
  | { kind: 'support' }
  | { kind: 'off' }
  | { kind: 'unavailable' };

type Context = { view: PersonalWorkspaceView; retry: () => void };
const PersonalWorkspaceContext = createContext<Context>({ view: { kind: 'idle' }, retry: () => {} });

type Owner = { userId: string; loginId: string };
/** One decided W0 answer: for whom, for which attempt, with which token it was sent. */
type Decided = Owner & { attempt: number; token: string; outcome: PersonalWorkspaceOutcome };
/** The one snapshot read asked for after a W0 answer: it counts once its generation has been read. */
type Reread = Owner & { attempt: number; target: number };

const sameOwner = (a: Owner | null, userId: string | null, loginId: string | null) => a !== null && a.userId === userId && a.loginId === loginId;

/**
 * The first run of the person's personal workspace, after the X autopost service has started (this provider sits inside
 * ServiceEnrollmentGate, which renders the app only once the start answered ready): one W0 call per login (the token's
 * session id), then one re-read of the snapshot. Nothing here blocks the app or the manual flow; only the AI post assist
 * waits for 'ready'. Every request carries the token of the login it was started for and is cancelled, unsent or
 * unread, when the person signs out or another person or login starts. A 401 / refused session is remembered with its
 * token: a new token of the same login asks once more. The mock preview never calls anything.
 */
export function PersonalWorkspaceProvider({ children }: PropsWithChildren) {
  const { session } = useAuth();
  const { snapshot, reload, generation, settled } = useDataStatus();
  const userId = session?.user.id ?? null;
  const accessToken = session?.access_token ?? null;
  const loginId = userId && accessToken ? loginSessionIdOf(userId, accessToken) : null;
  const selection = useMemo(() => selectDataSource(), []);
  const [attempt, setAttempt] = useState(0);
  const [decided, setDecided] = useState<Decided | null>(null);
  const [reread, setReread] = useState<Reread | null>(null);
  const flight = useRef<(Owner & { attempt: number; controller: AbortController }) | null>(null);

  useEffect(() => () => { flight.current?.controller.abort(); flight.current = null; }, []);

  useEffect(() => {
    if (selection.kind !== 'supabase' || !userId || !accessToken || !loginId) {
      flight.current?.controller.abort();
      flight.current = null;
      return;
    }
    if (flight.current && !sameOwner(flight.current, userId, loginId)) {
      flight.current.controller.abort();
      flight.current = null;
    }
    // A token refresh in flight keeps the request: it was sent for this login.
    if (flight.current && flight.current.attempt === attempt) return;
    if (sameOwner(decided, userId, loginId) && decided?.attempt === attempt
        && (decided.outcome.kind !== 'relogin' || decided.token === accessToken)) return;
    flight.current?.controller.abort();
    const config = getSupabaseConfig();
    const controller = new AbortController();
    const mine = { userId, loginId, attempt, controller };
    flight.current = mine;
    const token = accessToken;
    void Promise.resolve().then(async () => {
      let outcome: PersonalWorkspaceOutcome;
      try {
        outcome = config.ok
          ? await ensurePersonalWorkspace(createPersonalWorkspaceCall({ url: config.config.url, apiKey: config.config.publishableKey, accessToken: token }), controller.signal)
          : { kind: 'unavailable' };
      } catch (failure) {
        if (failure instanceof EnrollmentCancelledError) return;
        outcome = { kind: 'unavailable' };
      }
      if (flight.current !== mine || controller.signal.aborted) return;
      flight.current = null;
      setDecided({ userId: mine.userId, loginId: mine.loginId, attempt: mine.attempt, token, outcome });
    });
  }, [accessToken, attempt, decided, loginId, selection, userId]);

  const ready = sameOwner(decided, userId, loginId) && decided?.outcome.kind === 'ready' ? decided : null;
  const workspaceId = ready?.outcome.kind === 'ready' ? ready.outcome.workspaceId : null;
  // The last snapshot read (it stays while a later one is under way), so a reload for another reason does not flicker.
  const shown = workspaceId !== null && snapshot?.personalWorkspaceId === workspaceId;
  const rereadDone = ready !== null && sameOwner(reread, userId, loginId) && reread?.attempt === ready.attempt && settled >= reread.target;

  // After W0: one re-read of the snapshot, unless the snapshot already shows the workspace (an existing one).
  useEffect(() => {
    if (!ready || shown) return;
    if (sameOwner(reread, ready.userId, ready.loginId) && reread?.attempt === ready.attempt) return;
    // A workspace W0 had to look up (created false) may already be in the read under way; one W0 just wrote never is.
    if (ready.outcome.kind === 'ready' && !ready.outcome.created && settled < generation) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setReread({ userId: ready.userId, loginId: ready.loginId, attempt: ready.attempt, target: generation + 1 });
      reload();
    });
    return () => { cancelled = true; };
  }, [generation, ready, reload, reread, settled, shown]);

  // Only for this login's latest answer that decided nothing. The next attempt is fixed by that answer, so a double tap
  // (or a tap while the retry is out) asks once.
  const retry = useCallback(() => {
    if (!sameOwner(decided, userId, loginId) || decided?.outcome.kind !== 'unavailable' || decided.attempt !== attempt) return;
    setAttempt(decided.attempt + 1);
  }, [attempt, decided, loginId, userId]);

  let view: PersonalWorkspaceView;
  if (selection.kind !== 'supabase' || !userId || !accessToken || !loginId) view = { kind: 'idle' };
  else if (!sameOwner(decided, userId, loginId) || decided?.attempt !== attempt) view = { kind: 'preparing' };
  else if (decided.outcome.kind === 'relogin') view = decided.token === accessToken ? { kind: 'relogin' } : { kind: 'preparing' };
  else if (decided.outcome.kind === 'ready') {
    view = shown && workspaceId ? { kind: 'ready', workspaceId } : rereadDone ? { kind: 'unconfirmed' } : { kind: 'preparing' };
  } else view = { kind: decided.outcome.kind };

  const value = useMemo(() => ({ view, retry }), [view, retry]);
  return <PersonalWorkspaceContext.Provider value={value}>{children}</PersonalWorkspaceContext.Provider>;
}

export function usePersonalWorkspace() {
  return useContext(PersonalWorkspaceContext);
}
