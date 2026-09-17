import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlannedPost, SocialAccount, Workspace } from '@/domain/types';

export const KABUMORI_BRAND_ID = 'kabumori';
export type ReadState = 'ready' | 'blocked' | 'unavailable';
export type SupabaseReadResult<T> = { state: ReadState; data: T; reason?: string };
export type SocialDataSnapshot = { workspace: Workspace | null; accounts: SocialAccount[]; plannedPosts: PlannedPost[]; history: PlannedPost[] };

const emptySnapshot: SocialDataSnapshot = { workspace: null, accounts: [], plannedPosts: [], history: [] };

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

    // These are intentionally narrow read candidates. Production metadata confirms the
    // columns, but RLS/grants still need to prove that an authenticated mobile user may read them.
    const { data: brandRows, error: brandError } = await this.client.from('brands').select('id,display_name,is_active,publish_mode').eq('id', KABUMORI_BRAND_ID).limit(1);
    const { data: accountRows, error: accountError } = await this.client.from('social_accounts').select('id,brand_id,platform,handle,connection_status,publish_enabled').eq('brand_id', KABUMORI_BRAND_ID).limit(20);
    const { data: scheduleRows, error: scheduleError } = await this.client.from('scheduled_posts').select('id,brand_id,post_type,scheduled_for,status').eq('brand_id', KABUMORI_BRAND_ID).order('scheduled_for', { ascending: false }).limit(30);
    if (brandError || accountError || scheduleError) {
      const code = brandError?.code ?? accountError?.code ?? scheduleError?.code;
      const failure = classifyReadError(code);
      return { state: failure.state, data: emptySnapshot, reason: failure.reason };
    }

    const accounts: SocialAccount[] = (accountRows ?? []).flatMap((row) => {
      if (row.brand_id !== KABUMORI_BRAND_ID || typeof row.id !== 'string' || typeof row.handle !== 'string') return [];
      const platform = row.platform === 'instagram' || row.platform === 'threads' ? row.platform : row.platform === 'x' ? 'x' : null;
      if (!platform) return [];
      return [{ id: row.id, platform, profile: { displayName: row.handle, handle: `@${row.handle.replace(/^@/u, '')}`, avatarColor: '#475569', voice: { tone: '設定未取得', language: '日本語', avoid: [] } }, connectionStatus: row.connection_status === 'connected' ? 'connected' : 'needs_attention', postingState: row.publish_enabled === false ? 'paused' : 'active' }];
    });
    const posts: PlannedPost[] = (scheduleRows ?? []).flatMap((row) => {
      if (row.brand_id !== KABUMORI_BRAND_ID || typeof row.id !== 'string' || typeof row.scheduled_for !== 'string' || typeof row.post_type !== 'string') return [];
      const status = row.status === 'published' ? 'published' : row.status === 'failed' ? 'failed' : row.status === 'publishing' ? 'publishing' : row.status === 'draft' ? 'draft' : 'scheduled';
      return [{ id: row.id, accountId: accounts[0]?.id ?? 'unknown', scheduledAt: row.scheduled_for, origin: 'ai_generated', status, text: '' }];
    });
    const brand = brandRows?.[0];
    return { state: 'ready', data: { workspace: brand ? { id: String(brand.id), name: typeof brand.display_name === 'string' ? brand.display_name : KABUMORI_BRAND_ID, plan: 'standard' } : null, accounts, plannedPosts: posts.filter((post) => post.status !== 'published'), history: posts } };
  }
}
