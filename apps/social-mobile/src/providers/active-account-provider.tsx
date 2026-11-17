import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import { mockRepository } from '@/data/mock-repository';
import { isInitialReleaseProvider } from '@/domain/initial-release';
import type { SocialAccount } from '@/domain/types';
import { useDataStatus } from '@/providers/data-provider';

type ActiveAccountContextValue = { accounts: SocialAccount[]; activeAccount: SocialAccount | null; selectAccount: (accountId: string) => void };
const ActiveAccountContext = createContext<ActiveAccountContextValue | null>(null);

export function ActiveAccountProvider({ children }: PropsWithChildren) {
  const { status, snapshot } = useDataStatus();
  // Mock accounts only in the explicit local preview. With real data, a blocked/loading/unavailable
  // state shows no account at all rather than someone else's (fake) account.
  const accounts = useMemo(
    () => (status === 'mock_preview' ? mockRepository.getAccounts() : status === 'ready' && snapshot ? snapshot.accounts : []),
    [snapshot, status],
  );
  const [activeId, setActiveId] = useState(accounts.find((account) => isInitialReleaseProvider(account.platform))?.id ?? '');
  const value = useMemo(() => ({ accounts, activeAccount: accounts.find((account) => account.id === activeId && isInitialReleaseProvider(account.platform)) ?? accounts.find((account) => isInitialReleaseProvider(account.platform)) ?? null, selectAccount: (accountId: string) => { if (accounts.some((account) => account.id === accountId && isInitialReleaseProvider(account.platform))) setActiveId(accountId); } }), [accounts, activeId]);
  return <ActiveAccountContext.Provider value={value}>{children}</ActiveAccountContext.Provider>;
}

export function useActiveAccount() { const value = useContext(ActiveAccountContext); if (!value) throw new Error('useActiveAccount must be used inside ActiveAccountProvider'); return value; }
