import type { SocialOperationsRepository } from '@/data/repository';
import type { ConsultationMessage, MediaAsset, PlannedPost, SettingsProposal, SocialAccount } from '@/domain/types';

const accounts: SocialAccount[] = [
  { id: 'account-x-main', platform: 'x', profile: { displayName: 'かぶモリ公式', handle: '@kabumori', avatarColor: '#312E81', voice: { tone: '落ち着いた、親しみやすい', language: '日本語', avoid: ['断定的な投資助言'] } }, connectionStatus: 'connected', postingState: 'active' },
  { id: 'account-instagram-lab', platform: 'instagram', profile: { displayName: 'Brand Studio', handle: '@brand_studio', avatarColor: '#BE185D', voice: { tone: '明るく視覚的', language: '日本語', avoid: ['過度な絵文字'] } }, connectionStatus: 'needs_attention', postingState: 'paused' },
];

const posts: PlannedPost[] = [
  { id: 'post-1', accountId: accounts[0].id, scheduledAt: '2026-09-17T08:20:00+09:00', origin: 'ai_generated', status: 'published', text: '今朝の市場メモをお届けします。' },
  { id: 'post-2', accountId: accounts[0].id, scheduledAt: '2026-09-17T11:44:00+09:00', origin: 'user_authored', status: 'scheduled', text: '今週のテーマをひとこと。' },
  { id: 'post-3', accountId: accounts[1].id, scheduledAt: '2026-09-17T13:00:00+09:00', origin: 'fixed', status: 'failed', text: '新商品の紹介文案です。' },
];

const messages: ConsultationMessage[] = [
  { id: 'message-1', role: 'assistant', text: '投稿の雰囲気や頻度を一緒に整えます。まず、今週はどんな印象を届けたいですか？', createdAt: '2026-09-17T08:00:00+09:00' },
  { id: 'message-2', role: 'user', text: '専門的すぎず、毎日読みやすいトーンにしたいです。', createdAt: '2026-09-17T08:01:00+09:00' },
];

const proposal: SettingsProposal = { id: 'proposal-1', title: '読みやすいトーンへ調整', summary: '文章を短くし、専門用語には一言の補足を添えます。', changes: [{ label: '文体', before: '専門的', after: 'やさしく簡潔' }, { label: '投稿頻度', before: '週3回', after: '週5回' }], status: 'pending' };
const media: MediaAsset[] = [{ id: 'asset-1', name: 'morning-window.png', kind: 'image', sizeLabel: '1.2 MB' }, { id: 'asset-2', name: 'brand-intro.mp4', kind: 'video', sizeLabel: '8.4 MB' }];

export const mockRepository: SocialOperationsRepository = {
  getWorkspace: () => ({ id: 'workspace-demo', name: 'Social Operations', plan: 'standard' }),
  getAccounts: () => accounts,
  getPlannedPosts: () => posts.filter((post) => post.status !== 'published'),
  getHistory: () => posts,
  getConsultation: () => ({ messages, proposal }),
  getMediaAssets: () => media,
  getUsage: () => ({ plan: 'standard', monthlyPostsUsed: 38, monthlyPostsLimit: 100, aiActionsUsed: 12, aiActionsLimit: 50 }),
};
