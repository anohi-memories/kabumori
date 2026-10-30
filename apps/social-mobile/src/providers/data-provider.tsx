import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { initialDataStatus, selectDataSource } from '@/data/repository-selection';
import type { SocialDataSnapshot } from '@/data/supabase-repository';
import { useAuth } from '@/providers/auth-provider';

type DataStatus = 'mock_preview' | 'loading' | 'ready' | 'blocked' | 'unavailable';
// generation: the latest requested read (reload() adds one); settled: the read whose answer status/snapshot show now.
type DataContextValue = { status: DataStatus; reason: string | null; snapshot: SocialDataSnapshot | null; reload: () => void; generation: number; settled: number };
const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: PropsWithChildren) {
  const { session } = useAuth();
  const [status, setStatus] = useState<DataStatus>(initialDataStatus);
  const [reason, setReason] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SocialDataSnapshot | null>(null);
  // Bumped after an account change (e.g. X connected) so the snapshot is re-read.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const [settled, setSettled] = useState(-1);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      const selected = selectDataSource();
      if (cancelled) return;
      if (selected.kind === 'mock') { setStatus('mock_preview'); setReason(null); setSnapshot(null); setSettled(generation); return; }
      if (!session) { setStatus('blocked'); setReason('ログイン後に運用データを読み込みます。'); setSettled(generation); return; }
      if (selected.kind === 'blocked') { setStatus('blocked'); setReason(selected.reason); setSettled(generation); return; }
      setStatus('loading'); setReason(null);
      const result = await selected.repository.readSnapshot();
      if (cancelled) return;
      setStatus(result.state); setReason(result.reason ?? null); setSnapshot(result.state === 'ready' ? result.data : null); setSettled(generation);
    });
    return () => { cancelled = true; };
  }, [session, generation]);
  const value = useMemo(() => ({ status, reason, snapshot, reload, generation, settled }), [generation, reason, reload, settled, snapshot, status]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
export function useDataStatus() { const value = useContext(DataContext); if (!value) throw new Error('useDataStatus must be used inside DataProvider'); return value; }
