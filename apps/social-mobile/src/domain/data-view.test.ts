import assert from 'node:assert/strict';
import test from 'node:test';
import { filterHistoryPosts, resolvePostsView, statusHeadline, summarizeHome } from './data-view.ts';
import { mapScheduledPostStatus } from './post-status.ts';
import type { PlannedPost, SocialAccount } from './types.ts';

const NOW = new Date('2026-09-28T09:00:00+09:00');

function post(overrides: Partial<PlannedPost>): PlannedPost {
  return { id: 'p1', accountId: 'a1', scheduledAt: '2026-09-28T10:00:00+09:00', origin: 'ai_generated', status: 'scheduled', text: '', ...overrides };
}

function account(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return { id: 'a1', platform: 'x', profile: { displayName: 'x', handle: '@x', avatarColor: '#000', voice: { tone: '', language: 'ja', avoid: [] } }, connectionStatus: 'connected', postingState: 'active', ...overrides };
}

// --- resolvePostsView: mock data must never leak into a real-but-broken state ---

test('mock_preview always shows the mock list, regardless of what real data is passed', () => {
  const mock = [post({ id: 'm1' })];
  assert.deepEqual(resolvePostsView('mock_preview', null, [post({ id: 'real1' })], mock), { kind: 'posts', posts: mock, isPreview: true });
  assert.deepEqual(resolvePostsView('mock_preview', null, undefined, mock), { kind: 'posts', posts: mock, isPreview: true });
});

test('loading shows a loading state, not mock or stale data', () => {
  assert.deepEqual(resolvePostsView('loading', null, undefined, [post({ id: 'm1' })]), { kind: 'loading' });
});

test('ready shows the real list, empty when the snapshot has none', () => {
  const real = [post({ id: 'r1' })];
  assert.deepEqual(resolvePostsView('ready', null, real, [post({ id: 'm1' })]), { kind: 'posts', posts: real, isPreview: false });
  assert.deepEqual(resolvePostsView('ready', null, undefined, [post({ id: 'm1' })]), { kind: 'posts', posts: [], isPreview: false });
});

test('blocked and unavailable never fall back to mock posts (no fake data)', () => {
  const mock = [post({ id: 'm1' })];
  assert.deepEqual(resolvePostsView('blocked', '所属している運用ワークスペースがありません。', undefined, mock), {
    kind: 'unavailable',
    reason: '所属している運用ワークスペースがありません。',
  });
  assert.deepEqual(resolvePostsView('unavailable', null, [post({ id: 'r1' })], mock), { kind: 'unavailable', reason: null });
});

test('history excludes posts that are still scheduled or publishing', () => {
  const posts = [
    post({ id: 'success', status: 'published' }),
    post({ id: 'failure', status: 'failed' }),
    post({ id: 'pending', status: 'scheduled' }),
    post({ id: 'running', status: 'publishing' }),
    post({ id: 'draft', status: 'draft' }),
  ];
  assert.deepEqual(filterHistoryPosts(posts).map((item) => item.id), ['success', 'failure']);
});

test('maps persisted scheduled_posts status values to truthful app states', () => {
  assert.equal(mapScheduledPostStatus('pending'), 'scheduled');
  assert.equal(mapScheduledPostStatus('running'), 'publishing');
  assert.equal(mapScheduledPostStatus('succeeded'), 'published');
  assert.equal(mapScheduledPostStatus('failed'), 'failed');
});

// --- statusHeadline: blocked/unavailable must not read as an intentional preview ---

test('ready/loading/mock_preview keep their own distinct labels', () => {
  assert.deepEqual(statusHeadline('ready'), { label: '接続済みデータ', tone: 'ready' });
  assert.deepEqual(statusHeadline('loading'), { label: 'データ読み込み中', tone: 'loading' });
  assert.deepEqual(statusHeadline('mock_preview'), { label: 'ローカルプレビュー', tone: 'preview' });
});

test('blocked and unavailable get an attention label distinct from mock preview', () => {
  for (const status of ['blocked', 'unavailable'] as const) {
    const headline = statusHeadline(status);
    assert.notEqual(headline.label, 'ローカルプレビュー', status);
    assert.equal(headline.tone, 'attention', status);
  }
});

// --- summarizeHome ---

test('no account reads auto-post as unknown, never on or off', () => {
  const summary = summarizeHome({ account: null, posts: [], history: [], now: NOW });
  assert.equal(summary.autoPostEnabled, null);
  assert.equal(summary.nextPost, null);
  assert.equal(summary.latestResult, null);
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.attentionCount, 0);
});

test('auto-post reflects the account postingState directly', () => {
  assert.equal(summarizeHome({ account: account({ postingState: 'active' }), posts: [], history: [], now: NOW }).autoPostEnabled, true);
  assert.equal(summarizeHome({ account: account({ postingState: 'paused' }), posts: [], history: [], now: NOW }).autoPostEnabled, false);
});

test('next post is the soonest upcoming scheduled/publishing/draft item, past items excluded', () => {
  const past = post({ id: 'past', status: 'scheduled', scheduledAt: '2026-09-28T08:00:00+09:00' });
  const soon = post({ id: 'soon', status: 'scheduled', scheduledAt: '2026-09-28T10:00:00+09:00' });
  const later = post({ id: 'later', status: 'draft', scheduledAt: '2026-09-28T18:00:00+09:00' });
  const published = post({ id: 'done', status: 'published', scheduledAt: '2026-09-28T09:30:00+09:00' });
  const summary = summarizeHome({ account: account(), posts: [later, past, soon, published], history: [], now: NOW });
  assert.equal(summary.nextPost?.id, 'soon');
  // pendingCount counts every not-yet-resolved item, including one whose
  // scheduled time has already passed (still pending, e.g. delayed
  // execution); only `nextPost` requires a future time.
  assert.equal(summary.pendingCount, 3); // past + soon + later; published is excluded
});

test('latest result is the most recent published or failed item, independent of post order', () => {
  const older = post({ id: 'older', status: 'published', scheduledAt: '2026-09-27T08:00:00+09:00' });
  const newer = post({ id: 'newer', status: 'failed', scheduledAt: '2026-09-28T07:00:00+09:00' });
  const stillScheduled = post({ id: 'scheduled', status: 'scheduled', scheduledAt: '2026-09-29T07:00:00+09:00' });
  const summary = summarizeHome({ account: account(), posts: [], history: [older, stillScheduled, newer], now: NOW });
  assert.equal(summary.latestResult?.id, 'newer');
});

test('attentionCount counts failed history items only', () => {
  const history = [post({ status: 'failed' }), post({ status: 'failed' }), post({ status: 'published' }), post({ status: 'scheduled' })];
  assert.equal(summarizeHome({ account: account(), posts: [], history, now: NOW }).attentionCount, 2);
});

test('an account with no posts or history still yields a defined (empty) summary, not an exception', () => {
  assert.doesNotThrow(() => summarizeHome({ account: account(), posts: [], history: [], now: NOW }));
});
