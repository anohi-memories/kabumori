import { useState } from 'react';
import { loginSessionIdOf } from '@/domain/service-enrollment';
import { usePersonalWorkspace } from '@/features/personal-workspace/personal-workspace-provider';
import { isXReconnectRequired, useXReconnectSignal } from '@/features/reservations/x-reconnect-signal';
import { xWriteRefusal, type XWriteRefusal } from '@/features/reservations/x-write-view';
import { useAuth } from '@/providers/auth-provider';

export type XWriteGuard = {
  /** Person, login and account of what is on screen; an answer asked for another scope is not shown. */
  scope: string | null;
  token: string | null;
  /** Reads stop only for a token the server answered 401 to. */
  canRead: boolean;
  refusal: XWriteRefusal | null;
  refuseToken: (token: string | null) => void;
  block: (scope: string | null, refusal: XWriteRefusal) => void;
  unblock: (scope: string | null) => void;
};

/** When the composer may send an X write for this account (one person's own personal workspace, signed in, not refused). */
export function useXWriteGuard(account: { id: string; brandId?: string; connectionStatus: string; platform: string } | null): XWriteGuard {
  const { session } = useAuth();
  const { view: workspace } = usePersonalWorkspace();
  useXReconnectSignal();
  const userId = session?.user?.id ?? null;
  const token = session?.access_token ?? null;
  const loginId = userId && token ? loginSessionIdOf(userId, token) : null;
  const scope = loginId && account ? `${userId}\n${loginId}\n${account.id}` : null;
  const [refusedToken, setRefusedToken] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ scope: string; refusal: XWriteRefusal } | null>(null);
  const loginRefused = refusedToken !== null && refusedToken === token;
  const refusal = xWriteRefusal({ loginId, account, personalId: workspace.kind === 'ready' ? workspace.workspaceId : null, reconnectRequired: isXReconnectRequired(account?.id) })
    ?? (loginRefused ? { text: 'ログインの有効期限が切れたため、ログインし直すまで予約を保存できません。', button: 'settings' as const } : null)
    ?? (blocked && blocked.scope === scope ? blocked.refusal : null);
  return {
    scope,
    token,
    canRead: !loginRefused,
    refusal,
    refuseToken: setRefusedToken,
    block: (mine, why) => { if (mine) setBlocked({ scope: mine, refusal: why }); },
    unblock: (mine) => setBlocked((current) => (current && current.scope === mine ? null : current)),
  };
}
