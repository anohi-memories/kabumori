import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { selectDataSource } from '@/data/repository-selection';
import type { SocialDataSnapshot } from '@/data/supabase-repository';
import { useAuth } from '@/providers/auth-provider';

type DataStatus = 'mock_preview' | 'loading' | 'ready' | 'blocked' | 'unavailable';
type DataContextValue = { status: DataStatus; reason: string | null; snapshot: SocialDataSnapshot | null };
const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: PropsWithChildren) {
  const { session } = useAuth();
  const [status, setStatus] = useState<DataStatus>(process.env.EXPO_PUBLIC_DATA_SOURCE === 'supabase' ? 'loading' : 'mock_preview');
  const [reason, setReason] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SocialDataSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      const selected = selectDataSource();
      if (cancelled) return;
      if (selected.kind === 'mock') { setStatus('mock_preview'); setReason(null); setSnapshot(null); return; }
      if (!session) { setStatus('blocked'); setReason('ログイン後に運用データを読み込みます。'); return; }
      if (selected.kind === 'blocked') { setStatus('blocked'); setReason(selected.reason); return; }
      setStatus('loading'); setReason(null);
      const result = await selected.repository.readSnapshot();
      if (cancelled) return;
      setStatus(result.state); setReason(result.reason ?? null); setSnapshot(result.state === 'ready' ? result.data : null);
    });
    return () => { cancelled = true; };
  }, [session]);
  const value = useMemo(() => ({ status, reason, snapshot }), [reason, snapshot, status]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
export function useDataStatus() { const value = useContext(DataContext); if (!value) throw new Error('useDataStatus must be used inside DataProvider'); return value; }
