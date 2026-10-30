import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlannedPost, SocialAccount, Workspace } from '@/domain/types';
import { mapScheduledPostStatus } from '@/domain/post-status';

export const KABUMORI_BRAND_ID = 'kabumori';
export type ReadState = 'ready' | 'blocked' | 'unavailable';
export type SupabaseReadResult<T> = { state: ReadState; data: T; reason?: string };
/**
 * `personalWorkspaceId` is the person's own personal workspace (POSTONA personal MVP, G5): a brand they are the owner of whose
 * code_profile_key is PERSONAL_WORKSPACE_KIND -- set only when exactly one such brand is visible, else null (nothing is guessed).
 * The server (G5) still checks the rest (derived id, sole owner, no other brand); this only picks which brand to ask for.
 */
export type SocialDataSnapshot = { workspace: Workspace | null; personalWorkspaceId: string | null; accounts: SocialAccount[]; plannedPosts: PlannedPost[]; history: PlannedPost[] };
export const PERSONAL_WORKSPACE_KIND = 'social_mobile_user_v1';

const emptySnapshot: SocialDataSnapshot = { workspace: null, personalWorkspaceId: null, accounts: [], plannedPosts: [], history: [] };

function classifyReadError(code: string | undefined): { state: ReadState; reason: string } {
  if (code === '42501') return { state: 'blocked', reason: 'このアカウントの運用データを読む権限が確認できません。' };
  if (code === '42P01' || code === '42703') return { state: 'unavailable', reason: '必要な運用テーブルまたは列が確認できません。' };
  return { state: 'unavailable', reason: '運用データを取得できません。' };
}

export class SupabaseSocialRepository {
  constructor(private readonly client: SupabaseClient) {}

  async readSnapshot(): Promise<SupabaseReadResult<SocialDataSnapshot>> {
    const { data: userData, error: userError } = await this.client.auth.getUser();
    if (userError || !userData.user) return { state: 'blocked', data: emptySnapshot, reason: 'ログインが必要です。' };

    // Membership is the tenant boundary. Never use a client-supplied brand id as
    // authorization; only ids returned by the RLS-protected self-membership query
    // are passed to the operational reads.
    const { data: membershipRows, error: membershipError } = await this.client.from('brand_memberships').select('brand_id,role').eq('user_id', userData.user.id);
    if (membershipError) {
      const failure = classifyReadError(membershipError.code);
      return { state: failure.state, data: emptySnapshot, reason: failure.reason };
    }
    const brandIds = [...new Set((membershipRows ?? []).flatMap((row) => typeof row.brand_id === 'string' && row.brand_id.trim() ? [row.brand_id] : []))];
    if (!brandIds.length) return { state: 'blocked', data: emptySnapshot, reason: '所属している運用ワークスペースがありません。' };

    const { data: brandRows, error: brandError } = await this.client.from('brands').select('id,display_name,is_active,publish_mode').in('id', brandIds).limit(50);
    const { data: accountRows, error: accountError } = await this.client.from('social_accounts').select('id,brand_id,platform,handle,connection_status,publish_enabled').in('brand_id', brandIds).limit(100);
    const { data: scheduleRows, error: scheduleError } = await this.client.from('scheduled_posts').select('id,brand_id,post_type,scheduled_for,status').in('brand_id', brandIds).order('scheduled_for', { ascending: false }).limit(100);
    if (brandError || accountError || scheduleError) {
      const code = brandError?.code ?? accountError?.code ?? scheduleError?.code;
      const failure = classifyReadError(code);
      return { state: failure.state, data: emptySnapshot, reason: failure.reason };
    }

    const accounts: SocialAccount[] = (accountRows ?? []).flatMap((row) => {
      if (typeof row.brand_id !== 'string' || !brandIds.includes(row.brand_id) || typeof row.id !== 'string' || typeof row.handle !== 'string') return [];
      const platform = row.platform === 'instagram' || row.platform === 'threads' ? row.platform : row.platform === 'x' ? 'x' : null;
      if (!platform) return [];
      return [{ id: row.id, brandId: row.brand_id, platform, profile: { displayName: row.handle, handle: `@${row.handle.replace(/^@/u, '')}`, avatarColor: '#475569', voice: { tone: '設定未取得', language: '日本語', avoid: [] } }, connectionStatus: row.connection_status === 'connected' || row.connection_status === 'identity_verified' ? 'connected' : 'needs_attention', postingState: row.publish_enabled === false ? 'paused' : 'active' }];
    });
    const posts: PlannedPost[] = (scheduleRows ?? []).flatMap((row) => {
      if (typeof row.brand_id !== 'string' || !brandIds.includes(row.brand_id) || typeof row.id !== 'string' || typeof row.scheduled_for !== 'string' || typeof row.post_type !== 'string') return [];
      const status = mapScheduledPostStatus(row.status);
      // Production scheduled_posts has no social_account_id relation. Do not
      // attribute a post to the first account merely because it is available.
      return [{ id: row.id, accountId: 'unknown', brandId: row.brand_id, scheduledAt: row.scheduled_for, origin: 'ai_generated', status, text: '' }];
    });
    const personalWorkspaceId = await this.readPersonalWorkspaceId(membershipRows ?? [], brandIds);
    // With several memberships the personal workspace is the one shown; otherwise the first visible brand, as before.
    const brand = brandRows?.find((row) => row.id === personalWorkspaceId) ?? brandRows?.find((row) => typeof row.id === 'string' && brandIds.includes(row.id)) ?? brandRows?.[0];
    return { state: 'ready', data: { workspace: brand ? { id: String(brand.id), name: typeof brand.display_name === 'string' ? brand.display_name : String(brand.id), plan: 'standard' } : null, personalWorkspaceId, accounts, plannedPosts: posts.filter((post) => post.status !== 'published'), history: posts } };
  }

  /**
   * The one brand the person owns whose kind is the personal workspace; null when there is none, more than one, or the kind cannot be
   * read (a column not granted, an error) -- the snapshot itself never fails because of this read.
   */
  private async readPersonalWorkspaceId(memberships: { brand_id?: unknown; role?: unknown }[], brandIds: string[]): Promise<string | null> {
    const owned = [...new Set(memberships.flatMap((row) => row.role === 'owner' && typeof row.brand_id === 'string' && brandIds.includes(row.brand_id) ? [row.brand_id] : []))];
    if (!owned.length) return null;
    try {
      const { data, error } = await this.client.from('brands').select('id,code_profile_key').in('id', owned).limit(50);
      if (error || !Array.isArray(data)) return null;
      const personal = [...new Set(data.flatMap((row) => typeof row.id === 'string' && owned.includes(row.id) && row.code_profile_key === PERSONAL_WORKSPACE_KIND ? [row.id] : []))];
      return personal.length === 1 ? personal[0] : null;
    } catch {
      return null;
    }
  }
}
