import type { SupabaseClient } from '@supabase/supabase-js';
import type { OnboardingInput, OnboardingSettingsState, OnboardingXAccount } from '@/domain/onboarding';

/**
 * Reads only what the signed-in user may see through RLS: their own
 * memberships, the X account rows of those brands (non-secret columns only)
 * and whether their brand has a content-settings row. Brand ids come solely
 * from the self-membership query, never from the client.
 */
export class SupabaseOnboardingRepository {
  constructor(private readonly client: SupabaseClient) {}

  async read(settingsDeferred: (userId: string) => Promise<boolean>): Promise<{ userId: string | null; input: OnboardingInput }> {
    const { data: userData, error: userError } = await this.client.auth.getUser();
    if (userError || !userData.user) return { userId: null, input: { kind: 'error', reason: 'ログイン状態を確認できません。' } };
    const userId = userData.user.id;

    const { data: memberships, error: membershipError } = await this.client
      .from('brand_memberships').select('brand_id').eq('user_id', userId);
    if (membershipError) return { userId, input: { kind: 'error', reason: '所属ワークスペースを確認できません。' } };
    const brandIds = [...new Set((memberships ?? []).flatMap((row) =>
      typeof row.brand_id === 'string' && row.brand_id.trim() ? [row.brand_id] : []))];
    if (brandIds.length !== 1) {
      return { userId, input: { kind: 'loaded', brandIds, xAccounts: [], settings: 'not_saved', settingsDeferred: false } };
    }

    const { data: accountRows, error: accountError } = await this.client
      .from('social_accounts')
      .select('id,brand_id,handle,connection_status,last_connection_error_code')
      .eq('brand_id', brandIds[0]).eq('platform', 'x').limit(5);
    if (accountError) return { userId, input: { kind: 'error', reason: 'Xアカウントの状態を確認できません。' } };
    const xAccounts: OnboardingXAccount[] = (accountRows ?? []).flatMap((row) =>
      typeof row.id === 'string' && row.brand_id === brandIds[0] && typeof row.connection_status === 'string'
        ? [{
          id: row.id,
          brandId: row.brand_id,
          handle: typeof row.handle === 'string' ? row.handle : '',
          connectionStatus: row.connection_status,
          lastConnectionErrorCode: typeof row.last_connection_error_code === 'string' ? row.last_connection_error_code : null,
        }]
        : []);

    let settings: OnboardingSettingsState = 'not_saved';
    const { data: settingsRows, error: settingsError } = await this.client
      .from('social_mobile_content_settings').select('brand_id').eq('brand_id', brandIds[0]).limit(1);
    if (settingsError) settings = settingsError.code === '42501' ? 'blocked' : 'unavailable';
    else if ((settingsRows ?? []).some((row) => row.brand_id === brandIds[0])) settings = 'saved';

    return {
      userId,
      input: { kind: 'loaded', brandIds, xAccounts, settings, settingsDeferred: await settingsDeferred(userId) },
    };
  }
}
