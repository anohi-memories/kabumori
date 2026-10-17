import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { useAuth } from '@/providers/auth-provider';

/**
 * POSTONA service lifecycle seen by the app (F4; design B of docs/postona-service-end-gate-g1-g2-design.md).
 * Above the per-login enrollment gate and below the signed-in check, it holds only person ids and counters:
 * - `bump(userId)`: the POSTONA service of that person was ended (an authoritative `ended` / `already_ended`).
 *   It raises that person's epoch by one. The enrollment gate (F5) reads `useServiceLifecycleEpoch(userId)` for the
 *   person it shows and asks the server again; the epoch itself is never a verdict, a token, a session or a preview.
 * - `open(userId)` / `close()`: the end / ID-management surface, rendered outside the gate so that a new login of the
 *   same person (re-authentication) does not destroy the flow.
 * Both act only for the person signed in now; another person (or nobody) closes the surface. Sign-out unmounts all of it.
 */
export type ServiceLifecycle = {
  /** The person the surface is open for; never anyone but the person signed in now. */
  readonly openFor: string | null;
  /** Opens the surface for `userId` if that person is signed in now. Returns whether it opened. */
  open(userId: string): boolean;
  close(): void;
  /** Counts one end of `userId`'s POSTONA service if that person is signed in now. Returns whether it counted. */
  bump(userId: string): boolean;
};

const LifecycleContext = createContext<ServiceLifecycle | null>(null);
const EpochContext = createContext<Readonly<Record<string, number>>>({});

export function ServiceLifecycleProvider({ children }: PropsWithChildren) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  // The person signed in now, for calls that arrive after an await (a late answer of a previous person is refused).
  const signedIn = useRef(userId);
  const [openState, setOpenState] = useState<string | null>(null);
  const [epochs, setEpochs] = useState<Readonly<Record<string, number>>>({});
  // Another person, or nobody: the surface is closed, not merely hidden (coming back does not reopen it). Adjusted
  // while rendering (as the end screen does for its login binding), so no frame keeps it for the new person.
  const [seenUser, setSeenUser] = useState(userId);
  if (seenUser !== userId) {
    setSeenUser(userId);
    if (openState !== null && openState !== userId) setOpenState(null);
  }
  useEffect(() => { signedIn.current = userId; }, [userId]);
  const open = useCallback((person: string) => {
    if (!person || person !== signedIn.current) return false;
    setOpenState(person);
    return true;
  }, []);
  const close = useCallback(() => setOpenState(null), []);
  const bump = useCallback((person: string) => {
    if (!person || person !== signedIn.current) return false;
    setEpochs((old) => ({ ...old, [person]: (old[person] ?? 0) + 1 }));
    return true;
  }, []);
  const openFor = openState !== null && openState === userId ? openState : null;
  const value = useMemo<ServiceLifecycle>(() => ({ openFor, open, close, bump }), [bump, close, open, openFor]);
  return (
    <LifecycleContext.Provider value={value}>
      <EpochContext.Provider value={epochs}>{children}</EpochContext.Provider>
    </LifecycleContext.Provider>
  );
}

export function useServiceLifecycle(): ServiceLifecycle {
  const value = useContext(LifecycleContext);
  if (!value) throw new Error('useServiceLifecycle must be used inside ServiceLifecycleProvider');
  return value;
}

/** That person's epoch: 0 until their first end, then +1 per end; 0 for nobody. It never decreases while signed in. */
export function useServiceLifecycleEpoch(userId: string | null): number {
  const epochs = useContext(EpochContext);
  return userId ? epochs[userId] ?? 0 : 0;
}
