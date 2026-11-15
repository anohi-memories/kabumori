import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { initialDataStatus, selectDataSource } from '@/data/repository-selection';
import type { SocialDataSnapshot } from '@/data/supabase-repository';
import { useAuth } from '@/providers/auth-provider';

type DataStatus = 'mock_preview' | 'loading' | 'ready' | 'blocked' | 'unavailable';
type DataContextValue = { status: DataStatus; reason: string | null; snapshot: SocialDataSnapshot | null; reload: () => void };
/** What one read produced, tagged with the person it was read for. */
type Loaded = { userId: string | null; status: DataStatus; reason: string | null; snapshot: SocialDataSnapshot | null };
const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: PropsWithChildren) {
  const { session } = useAuth();
  // Keyed by the person, not by the session object: a token refresh (the same person, a new session object) neither
  // re-reads nor blanks the screens; another person or a sign-out always re-reads.
  const userId = session?.user.id ?? null;
  const [loaded, setLoaded] = useState<Loaded>(() => ({ userId, status: initialDataStatus(), reason: null, snapshot: null }));
  // Bumped after an account change (e.g. X connected) so the snapshot is re-read.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    // A re-read for the same person keeps the snapshot it already has; another person (or nobody) starts from none.
    const keep = (previous: Loaded) => (previous.userId === userId ? previous.snapshot : null);
    void Promise.resolve().then(async () => {
      const selected = selectDataSource();
      if (cancelled) return;
      if (selected.kind === 'mock') { setLoaded({ userId, status: 'mock_preview', reason: null, snapshot: null }); return; }
      if (!userId) { setLoaded({ userId, status: 'blocked', reason: 'ログイン後に運用データを読み込みます。', snapshot: null }); return; }
      if (selected.kind === 'blocked') { setLoaded((previous) => ({ userId, status: 'blocked', reason: selected.reason, snapshot: keep(previous) })); return; }
      setLoaded((previous) => ({ userId, status: 'loading', reason: null, snapshot: keep(previous) }));
      const result = await selected.repository.readSnapshot();
      if (cancelled) return;
      setLoaded({ userId, status: result.state, reason: result.reason ?? null, snapshot: result.state === 'ready' ? result.data : null });
    });
    return () => { cancelled = true; };
  }, [userId, generation]);
  // Only what was read for the person signed in now is shown; until that read starts, nothing of anyone else is.
  const owned = loaded.userId === userId;
  const status: DataStatus = owned ? loaded.status : 'loading';
  const reason = owned ? loaded.reason : null;
  const snapshot = owned ? loaded.snapshot : null;
  const value = useMemo(() => ({ status, reason, snapshot, reload }), [reason, reload, snapshot, status]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
export function useDataStatus() { const value = useContext(DataContext); if (!value) throw new Error('useDataStatus must be used inside DataProvider'); return value; }
