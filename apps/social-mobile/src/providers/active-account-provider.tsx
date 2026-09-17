import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import { mockRepository } from '@/data/mock-repository';
import type { SocialAccount } from '@/domain/types';
import { useDataStatus } from '@/providers/data-provider';

type ActiveAccountContextValue = { accounts: SocialAccount[]; activeAccount: SocialAccount | null; selectAccount: (accountId: string) => void };
const ActiveAccountContext = createContext<ActiveAccountContextValue | null>(null);

export function ActiveAccountProvider({ children }: PropsWithChildren) {
  const { status, snapshot } = useDataStatus();
  const accounts = status === 'ready' && snapshot ? snapshot.accounts : mockRepository.getAccounts();
  const [activeId, setActiveId] = useState(accounts[0]?.id ?? '');
  const value = useMemo(() => ({ accounts, activeAccount: accounts.find((account) => account.id === activeId) ?? accounts[0] ?? null, selectAccount: (accountId: string) => { if (accounts.some((account) => account.id === accountId)) setActiveId(accountId); } }), [accounts, activeId]);
  return <ActiveAccountContext.Provider value={value}>{children}</ActiveAccountContext.Provider>;
}

export function useActiveAccount() { const value = useContext(ActiveAccountContext); if (!value) throw new Error('useActiveAccount must be used inside ActiveAccountProvider'); return value; }
