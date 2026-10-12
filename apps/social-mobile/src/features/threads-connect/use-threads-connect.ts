import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ThreadsConnectStart, ThreadsConnectStarter } from '@/domain/threads-connect';
import type { SocialAccount } from '@/domain/types';
import { productionThreadsConnectDeps } from '@/features/threads-connect/threads-connect-runtime';
import { createThreadsConnectStarter } from '@/features/threads-connect/threads-connect-starter';
import { useAuth } from '@/providers/auth-provider';

export type ThreadsConnectUiState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'verifying'; accountId: string }
  | { kind: 'done'; result: Exclude<ThreadsConnectStart, { kind: 'connected' }> };

/**
 * The connect / reconnect action for the accounts screens. Nothing starts while the release flag is OFF.
 * A verified server receipt is only "verifying": the shared account data is reloaded, and the screen says
 * connected only once the reloaded data shows that Threads account as connected.
 */
export function useThreadsConnect({ accounts, reload, releaseEnabled, starter }: {
  accounts: readonly Pick<SocialAccount, 'id' | 'platform' | 'connectionStatus'>[];
  reload: () => void;
  releaseEnabled: boolean;
  starter?: ThreadsConnectStarter;
}) {
  const { session } = useAuth();
  const latest = useRef(session);
  useLayoutEffect(() => {
    latest.current = session;
  });
  const own = useRef<ThreadsConnectStarter | null>(null);
  const [state, setState] = useState<ThreadsConnectUiState>({ kind: 'idle' });
  const running = useRef(false);

  const connect = useCallback(async () => {
    if (!releaseEnabled || running.current) return;
    // The real flow is built on the first tap (never during render); the session is read at every step.
    const active = starter ?? (own.current ??= createThreadsConnectStarter(productionThreadsConnectDeps(() => {
      const current = latest.current;
      return current?.user?.id && current.access_token ? { userId: current.user.id, token: current.access_token } : null;
    })));
    running.current = true;
    setState({ kind: 'running' });
    try {
      const result = await active.start();
      if (result.kind === 'connected') {
        setState({ kind: 'verifying', accountId: result.socialAccountId });
        reload();
      } else {
        setState({ kind: 'done', result });
      }
    } finally {
      running.current = false;
    }
  }, [releaseEnabled, reload, starter]);

  const verified = state.kind === 'verifying'
    && accounts.some((account) => account.id === state.accountId && account.platform === 'threads' && account.connectionStatus === 'connected');
  return { state, verified, connect, busy: state.kind === 'running' };
}
