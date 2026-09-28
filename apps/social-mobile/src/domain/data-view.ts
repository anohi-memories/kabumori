import type { PlannedPost, SocialAccount } from './types';

// Mirrors DataProvider's own (unexported) DataStatus in
// providers/data-provider.tsx. Kept as a local literal union rather than an
// import so this pure module has no dependency on that provider file.
export type DataStatus = 'mock_preview' | 'loading' | 'ready' | 'blocked' | 'unavailable';

/**
 * What a list screen (Home/schedule/history) should render, decided once from
 * the data-provider status rather than duplicated per screen. The key rule:
 * mock data is shown only in explicit `mock_preview` mode. A `blocked` or
 * `unavailable` real connection must never fall back to demo posts silently
 * -- the screen would look populated while actually hiding a real problem.
 */
export type PostsViewState =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string | null }
  | { kind: 'posts'; posts: PlannedPost[]; isPreview: boolean };

export function resolvePostsView(
  status: DataStatus,
  reason: string | null,
  realPosts: PlannedPost[] | undefined,
  mockPosts: PlannedPost[],
): PostsViewState {
  if (status === 'mock_preview') return { kind: 'posts', posts: mockPosts, isPreview: true };
  if (status === 'loading') return { kind: 'loading' };
  if (status === 'ready') return { kind: 'posts', posts: realPosts ?? [], isPreview: false };
  // 'blocked' | 'unavailable'
  return { kind: 'unavailable', reason };
}

export type StatusHeadline = { label: string; tone: 'ready' | 'loading' | 'preview' | 'attention' };

/**
 * The Home status banner previously fell through to the mock-preview label
 * for `blocked`/`unavailable` too, which hides that a real connection is
 * broken behind the same wording used for an intentional local demo.
 */
export function statusHeadline(status: DataStatus): StatusHeadline {
  switch (status) {
    case 'ready':
      return { label: '接続済みデータ', tone: 'ready' };
    case 'loading':
      return { label: 'データ読み込み中', tone: 'loading' };
    case 'mock_preview':
      return { label: 'ローカルプレビュー', tone: 'preview' };
    default:
      return { label: '運用データを確認できません', tone: 'attention' };
  }
}

export type HomeSummary = {
  autoPostEnabled: boolean | null;
  nextPost: PlannedPost | null;
  latestResult: PlannedPost | null;
  pendingCount: number;
  attentionCount: number;
};

const upcomingStatuses = new Set(['scheduled', 'publishing', 'draft']);
const resultStatuses = new Set(['published', 'failed']);

/**
 * Pure summary for the Home screen: no account selected reads as "unknown",
 * never as "off" or "on". `posts`/`history` should already be the resolved
 * (mode-appropriate) lists from resolvePostsView, not the raw snapshot.
 */
export function summarizeHome(input: {
  account: SocialAccount | null;
  posts: PlannedPost[];
  history: PlannedPost[];
  now: Date;
}): HomeSummary {
  const { account, posts, history, now } = input;
  const nowMs = now.getTime();

  const upcoming = posts
    .filter((post) => upcomingStatuses.has(post.status) && new Date(post.scheduledAt).getTime() >= nowMs)
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

  const results = history
    .filter((post) => resultStatuses.has(post.status))
    .sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());

  return {
    autoPostEnabled: account ? account.postingState === 'active' : null,
    nextPost: upcoming[0] ?? null,
    latestResult: results[0] ?? null,
    pendingCount: posts.filter((post) => upcomingStatuses.has(post.status)).length,
    attentionCount: history.filter((post) => post.status === 'failed').length,
  };
}
