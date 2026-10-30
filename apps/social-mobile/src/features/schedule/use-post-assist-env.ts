import { supabase } from '@/lib/supabase';
import { usePersonalWorkspace } from '@/features/personal-workspace/personal-workspace-provider';
import { useAuth } from '@/providers/auth-provider';
import { useDataStatus } from '@/providers/data-provider';
import type { AssistEnv } from '@/features/schedule/post-assist';

/**
 * The schedule composer's only way to the backend: the AI post assist (POST /functions/v1/postona-post-assist), with the
 * person's own session, for the brand the composer plans for, checked against the person's workspace. It reads; it never
 * saves, schedules or posts (post-assist.ts decides whether anything may be sent at all).
 */
export function usePostAssistEnv(owner: { brandId: string; platform: 'x' }, refusedToken: string | null): AssistEnv {
  const { session } = useAuth();
  const { status } = useDataStatus();
  const { view, retry } = usePersonalWorkspace();
  return {
    client: supabase,
    accessToken: session?.access_token ?? null,
    userId: session?.user?.id ?? null,
    brandId: owner.brandId,
    // Only the person's own personal workspace: W0 answered it and the snapshot read after it shows it -- never the first
    // brand they happen to see.
    workspaceId: view.kind === 'ready' ? view.workspaceId : null,
    platform: owner.platform,
    preview: status === 'mock_preview',
    // A 401 from the assist for this token, or W0 refusing this token's login.
    loginRefused: (refusedToken !== null && refusedToken === (session?.access_token ?? null)) || view.kind === 'relogin',
    workspaceSetup: view.kind === 'relogin' ? 'idle' : view.kind,
    retryWorkspaceSetup: view.kind === 'unavailable' ? retry : null,
  };
}
