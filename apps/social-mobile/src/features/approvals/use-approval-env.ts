import { useMemo } from 'react';
import { usePersonalWorkspace } from '@/features/personal-workspace/personal-workspace-provider';
import { useRefocusCount } from '@/features/reservations/use-refocus-count';
import { type LifecycleCheck, useServiceLifecycle } from '@/features/service-enrollment/service-lifecycle';
import { getSupabaseConfig, supabase } from '@/lib/supabase';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useAuth } from '@/providers/auth-provider';
import { useDataStatus } from '@/providers/data-provider';
import { createApprovalClient, type ApprovalClient } from './approval-client';
import { APPROVAL_ENDPOINT, POSTONA_APPROVAL_UI_ENABLED } from './approval-gate';
import { type ApprovalBlock, workspaceBlockOf } from './approval-view';

export type ApprovalEnv = {
  block: ApprovalBlock | null;
  scope: string | null;
  client: ApprovalClient | null;
  accountId: string | null;
  refocus: number;
  notificationBlock: ApprovalBlock | null;
  notificationScope: string | null;
  /** G1 TASK 47: asks the service gate, now, whether this person's service still runs. Only 'active' lets a write be sent. */
  confirmActive: () => Promise<LifecycleCheck>;
};

const NOT_CONFIRMED = async (): Promise<LifecycleCheck> => 'unknown';

/**
 * Whether the person may use the approval screens, and for whom: the signed-in user, their own personal workspace, and the selected X
 * account of that workspace. `scope` keys everything the screens hold; another value drops it.
 */
export function useApprovalEnv(): ApprovalEnv {
  const { session } = useAuth();
  const { status } = useDataStatus();
  const { view: workspace } = usePersonalWorkspace();
  const { activeAccount } = useActiveAccount();
  const refocus = useRefocusCount();
  const lifecycle = useServiceLifecycle();
  const config = getSupabaseConfig();
  const url = config.ok ? config.config.url : null;
  const key = config.ok ? config.config.publishableKey : null;
  const client = useMemo(() => {
    if (!supabase || !url || !key) return null;
    try {
      const auth = supabase.auth;
      return createApprovalClient({
        supabaseUrl: url,
        publishableKey: key,
        accessToken: async () => (await auth.getSession()).data.session?.access_token ?? null,
        fetch: (input, init) => globalThis.fetch(input, init),
        functionName: APPROVAL_ENDPOINT.functionName,
        allowLoopbackHttpForTests: APPROVAL_ENDPOINT.allowLoopbackHttpForTests,
      });
    } catch {
      return null;
    }
  }, [url, key]);
  const userId = session?.user?.id ?? null;
  const account = activeAccount?.platform === 'x' ? activeAccount : null;

  let block: ApprovalBlock | null;
  if (!POSTONA_APPROVAL_UI_ENABLED) block = 'off';
  else if (status === 'mock_preview') block = 'preview';
  else if (!client) block = 'unconfigured';
  else if (!session || !userId) block = 'signed_out';
  else block = workspaceBlockOf(workspace.kind);
  // Notifications are the person's own, whatever account is selected.
  const notificationBlock = block;
  const notificationScope = block === null && workspace.kind === 'ready' ? `${userId}\n${workspace.workspaceId}` : null;
  if (block === null && !account) block = 'no_x_account';
  if (block === null && workspace.kind === 'ready' && account && account.brandId !== workspace.workspaceId) block = 'other_workspace';
  const scope = block === null && workspace.kind === 'ready' && account ? `${userId}\n${workspace.workspaceId}\n${account.id}` : null;
  // The gate's answer is for the person it shows; a screen of anyone else is never confirmed by it.
  const confirmActive = notificationScope && lifecycle.userId === userId ? lifecycle.confirmActive : NOT_CONFIRMED;
  return { block, scope, client: notificationScope ? client : null, accountId: scope ? account?.id ?? null : null, refocus, notificationBlock, notificationScope, confirmActive };
}
