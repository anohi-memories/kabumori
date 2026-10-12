import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ThreadsDisconnectResult, ThreadsDisconnectTarget, ThreadsDisconnector } from '@/domain/threads-disconnect';
import type { SocialAccount } from '@/domain/types';
import { createThreadsDisconnector } from '@/features/threads-disconnect/threads-disconnect-runner';
import { productionThreadsDisconnectDeps } from '@/features/threads-disconnect/threads-disconnect-runtime';
import { useAuth } from '@/providers/auth-provider';

export type ThreadsDisconnectUiState =
  | { kind: 'idle' }
  | { kind: 'confirming'; target: ThreadsDisconnectTarget; confirmedBy: string }
  | { kind: 'running'; target: ThreadsDisconnectTarget }
  | { kind: 'verifying'; target: ThreadsDisconnectTarget; result: Extract<ThreadsDisconnectResult, { kind: 'disconnected' | 'not_connected' }> }
  | { kind: 'done'; result: ThreadsDisconnectResult };

/**
 * The disconnect action for one Threads account. Nothing starts while the release flag is OFF. `ask` opens
 * the confirmation for the person signed in now; `confirm` sends it once (a second tap sends nothing). A
 * server answer is only "verifying": the shared account data is reloaded, and the screen says disconnected
 * only once the reloaded data no longer shows that Threads account. An unknown answer also reloads.
 */
export function useThreadsDisconnect({ accounts, reload, releaseEnabled, disconnector }: {
  accounts: readonly Pick<SocialAccount, 'id' | 'platform'>[];
  reload: () => void;
  releaseEnabled: boolean;
  disconnector?: ThreadsDisconnector;
}) {
  const { session } = useAuth();
  const latest = useRef(session);
  useLayoutEffect(() => {
    latest.current = session;
  });
  const own = useRef<ThreadsDisconnector | null>(null);
  const [state, setState] = useState<ThreadsDisconnectUiState>({ kind: 'idle' });
  const running = useRef(false);

  const ask = useCallback((target: ThreadsDisconnectTarget | null) => {
    const userId = latest.current?.user?.id;
    if (!releaseEnabled || running.current || !target || !userId) return;
    setState({ kind: 'confirming', target, confirmedBy: userId });
  }, [releaseEnabled]);

  const cancel = useCallback(() => {
    if (!running.current) setState({ kind: 'idle' });
  }, []);

  const confirm = useCallback(async () => {
    if (!releaseEnabled || running.current || state.kind !== 'confirming') return;
    const { target, confirmedBy } = state;
    // Built on the first confirmation (never during render); the session is read at the moment it is sent.
    const active = disconnector ?? (own.current ??= createThreadsDisconnector(productionThreadsDisconnectDeps(() => {
      const current = latest.current;
      return current?.user?.id && current.access_token ? { userId: current.user.id, token: current.access_token } : null;
    })));
    running.current = true;
    setState({ kind: 'running', target });
    try {
      const result = await active.disconnect(target, confirmedBy);
      if (result.kind === 'disconnected' || result.kind === 'not_connected') {
        setState({ kind: 'verifying', target, result });
        reload();
      } else {
        setState({ kind: 'done', result });
        if (result.kind === 'failed' && result.uncertain) reload();
      }
    } finally {
      running.current = false;
    }
  }, [disconnector, releaseEnabled, reload, state]);

  const verified = state.kind === 'verifying'
    && !accounts.some((account) => account.id === state.target.id && account.platform === 'threads');
  return { state, verified, ask, cancel, confirm, busy: state.kind === 'running' };
}
