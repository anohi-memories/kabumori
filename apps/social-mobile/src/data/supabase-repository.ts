import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlannedPost, SocialAccount, Workspace } from '@/domain/types';

export const KABUMORI_BRAND_ID = 'kabumori';
export type ReadState = 'ready' | 'blocked' | 'unavailable';
export type SupabaseReadResult<T> = { state: ReadState; data: T; reason?: string };
export type SocialDataSnapshot = { workspace: Workspace | null; accounts: SocialAccount[]; plannedPosts: PlannedPost[]; history: PlannedPost[] };

const emptySnapshot: SocialDataSnapshot = { workspace: null, accounts: [], plannedPosts: [], history: [] };

export class SupabaseSocialRepository {
  constructor(private readonly client: SupabaseClient) {}

  async readSnapshot(): Promise<SupabaseReadResult<SocialDataSnapshot>> {
    const { data: userData, error: userError } = await this.client.auth.getUser();
    if (userError || !userData.user) return { state: 'blocked', data: emptySnapshot, reason: 'ログインが必要です。' };

    // These are intentionally narrow read candidates. RLS/tenant ownership must be proven by production policy before enabling this source.
    const { data: brandRows, error: brandError } = await this.client.from('brands').select('id,display_name,is_active,publish_mode').eq('id', KABUMORI_BRAND_ID).limit(1);
    const { data: accountRows, error: accountError } = await this.client.from('social_accounts').select('id,brand_id,platform,handle,connection_status,publish_enabled').eq('brand_id', KABUMORI_BRAND_ID).limit(20);
    // The checked-in scheduler schema has no tenant key or generated-text column. Do not
    // guess either field or client-filter rows into a brand; keep this adapter blocked until
    // production exposes a proven ownership relation (for example, a brand_id + RLS policy).
    const { data: scheduleRows, error: scheduleError } = await this.client.from('scheduled_posts').select('id,post_type,scheduled_for,status').order('scheduled_for', { ascending: false }).limit(30);
    if (brandError || accountError || scheduleError) {
      const code = brandError?.code ?? accountError?.code ?? scheduleError?.code;
      return { state: code === '42501' ? 'blocked' : 'unavailable', data: emptySnapshot, reason: code === '42501' ? 'このアカウントの運用データを読む権限が確認できません。' : '運用データを取得できません。' };
    }

    const accounts: SocialAccount[] = (accountRows ?? []).flatMap((row) => {
      if (row.brand_id !== KABUMORI_BRAND_ID || typeof row.id !== 'string' || typeof row.handle !== 'string') return [];
      const platform = row.platform === 'instagram' || row.platform === 'threads' ? row.platform : row.platform === 'x' ? 'x' : null;
      if (!platform) return [];
      return [{ id: row.id, platform, profile: { displayName: row.handle, handle: `@${row.handle.replace(/^@/u, '')}`, avatarColor: '#475569', voice: { tone: '設定未取得', language: '日本語', avoid: [] } }, connectionStatus: row.connection_status === 'connected' ? 'connected' : 'needs_attention', postingState: row.publish_enabled === false ? 'paused' : 'active' }];
    });
    if ((scheduleRows ?? []).length > 0) return { state: 'blocked', data: emptySnapshot, reason: '投稿予定とブランドの所有境界を確認できないため、表示を保留しています。' };
    const posts: PlannedPost[] = (scheduleRows ?? []).flatMap((row) => {
      if (typeof row.id !== 'string' || typeof row.scheduled_for !== 'string' || typeof row.post_type !== 'string') return [];
      const status = row.status === 'published' ? 'published' : row.status === 'failed' ? 'failed' : row.status === 'publishing' ? 'publishing' : row.status === 'draft' ? 'draft' : 'scheduled';
      return [{ id: row.id, accountId: accounts[0]?.id ?? 'unknown', scheduledAt: row.scheduled_for, origin: 'ai_generated', status, text: '' }];
    });
    const brand = brandRows?.[0];
    return { state: 'ready', data: { workspace: brand ? { id: String(brand.id), name: typeof brand.display_name === 'string' ? brand.display_name : KABUMORI_BRAND_ID, plan: 'standard' } : null, accounts, plannedPosts: posts.filter((post) => post.status !== 'published'), history: posts } };
  }
}
