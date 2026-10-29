import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { useDataStatus } from '@/providers/data-provider';
import type { AssistEnv } from '@/features/schedule/post-assist';

/**
 * The schedule composer's only way to the backend: the AI post assist (POST /functions/v1/postona-post-assist), with the
 * person's own session, for the brand the composer plans for, checked against the person's workspace. It reads; it never
 * saves, schedules or posts (post-assist.ts decides whether anything may be sent at all).
 */
export function usePostAssistEnv(owner: { brandId: string; platform: 'x' }): AssistEnv {
  const { session } = useAuth();
  const { status, snapshot } = useDataStatus();
  return {
    client: supabase,
    accessToken: session?.access_token ?? null,
    userId: session?.user?.id ?? null,
    brandId: owner.brandId,
    workspaceId: snapshot?.workspace?.id ?? null,
    platform: owner.platform,
    preview: status === 'mock_preview',
  };
}
