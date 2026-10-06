import { Link } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { mockRepository } from '@/data/mock-repository';
import { colors, typography } from '@/constants/theme';
import { ActionButton, Card, EmptyState, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { BrandPostPreview } from '@/features/brand-preview/brand-post-preview';
import { resolvePostsView, statusHeadline, summarizeHome } from '@/domain/data-view';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useDataStatus } from '@/providers/data-provider';
import { SignOutButton } from '@/components/sign-out-button';

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function HomeScreen() {
  const { activeAccount } = useActiveAccount();
  const { status, reason, snapshot } = useDataStatus();
  const headline = statusHeadline(status);

  // Mock data is filtered to the selected demo account so switching accounts
  // still demonstrates the per-account view; real scheduled_posts rows have
  // no account attribution yet (see supabase-repository.ts), so a `ready`
  // connection shows the workspace's posts as-is rather than hiding them
  // behind a filter that could never match.
  const mockPosts = mockRepository.getPlannedPosts().filter((post) => post.accountId === activeAccount?.id);
  const mockHistory = mockRepository.getHistory().filter((post) => post.accountId === activeAccount?.id);
  const postsView = resolvePostsView(status, reason, snapshot?.plannedPosts, mockPosts);
  const historyView = resolvePostsView(status, reason, snapshot?.history, mockHistory);

  const workspace = status === 'mock_preview' ? mockRepository.getWorkspace() : snapshot?.workspace ?? null;
  const summary = summarizeHome({
    account: activeAccount,
    posts: postsView.kind === 'posts' ? postsView.posts : [],
    history: historyView.kind === 'posts' ? historyView.posts : [],
    now: new Date(),
  });

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }} showsVerticalScrollIndicator={false}>
        <View style={{ gap: 6 }}>
          <Text style={typography.caption}>{workspace?.name ?? 'ワークスペース未取得'}</Text>
          <Text style={typography.title}>おはようございます</Text>
          <Text style={{ color: colors.muted, ...typography.body }}>AI運用担当者と、今日の発信を整えましょう。</Text>
        </View>

        {status !== 'mock_preview' ? (
          <Card
            style={{
              backgroundColor: headline.tone === 'ready' ? colors.successSoft : headline.tone === 'attention' ? colors.dangerSoft : colors.warningSoft,
              borderColor: headline.tone === 'ready' ? '#BBF7D0' : headline.tone === 'attention' ? '#FECACA' : '#FDE68A',
            }}
          >
            <Text style={{ color: headline.tone === 'ready' ? colors.success : headline.tone === 'attention' ? colors.danger : colors.warning, fontWeight: '800' }}>
              {headline.label}
            </Text>
            {reason ? <Text style={{ color: colors.muted }}>{reason}</Text> : null}
          </Card>
        ) : null}

        <Card>
          <SectionTitle detail="自動投稿の状態と、選択中のアカウント">運用アカウント</SectionTitle>
          {activeAccount ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: activeAccount.profile.avatarColor }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', color: colors.ink }}>{activeAccount.profile.displayName}</Text>
                  <Text style={{ color: colors.muted }}>{activeAccount.profile.handle}</Text>
                </View>
                <Pill tone={activeAccount.connectionStatus === 'connected' ? 'success' : 'warning'}>
                  {activeAccount.connectionStatus === 'connected' ? '接続済み' : '要確認'}
                </Pill>
              </View>
              <Pill tone={summary.autoPostEnabled ? 'success' : 'neutral'}>
                自動投稿: {summary.autoPostEnabled ? 'ON（稼働中）' : 'OFF（停止中）'}
              </Pill>
            </>
          ) : (
            <Text style={styles.muted}>アカウントを選択してください。</Text>
          )}
          <Link href="/accounts" asChild>
            <ActionButton label="アカウントを切り替える" onPress={() => {}} />
          </Link>
        </Card>

        <Card>
          <SectionTitle detail="次に投稿される予定">次回の投稿予定</SectionTitle>
          {postsView.kind === 'loading' ? (
            <Text style={styles.muted}>読み込み中…</Text>
          ) : postsView.kind === 'unavailable' ? (
            <Text style={styles.muted}>{postsView.reason ?? '投稿予定を確認できません。'}</Text>
          ) : summary.nextPost ? (
            <View style={{ gap: 4 }}>
              <Text style={{ color: colors.ink, fontWeight: '800' }}>{formatTime(summary.nextPost.scheduledAt)}</Text>
              <Text style={{ color: colors.ink }}>{summary.nextPost.text || '（本文は投稿予定の確認画面で表示されます）'}</Text>
            </View>
          ) : (
            <Text style={styles.muted}>予定されている投稿はありません。</Text>
          )}
          <Link href="/(tabs)/schedule" asChild>
            <ActionButton label="投稿予定を見る" onPress={() => {}} />
          </Link>
        </Card>

        <Card>
          <SectionTitle detail="直近の投稿結果">最新の投稿結果</SectionTitle>
          {historyView.kind === 'loading' ? (
            <Text style={styles.muted}>読み込み中…</Text>
          ) : historyView.kind === 'unavailable' ? (
            <Text style={styles.muted}>{historyView.reason ?? '投稿結果を確認できません。'}</Text>
          ) : summary.latestResult ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: colors.ink }}>{formatTime(summary.latestResult.scheduledAt)}</Text>
              <Pill tone={summary.latestResult.status === 'published' ? 'success' : 'danger'}>
                {summary.latestResult.status === 'published' ? '投稿成功' : '失敗'}
              </Pill>
            </View>
          ) : (
            <Text style={styles.muted}>まだ投稿結果はありません。</Text>
          )}
          <Link href="/(tabs)/history" asChild>
            <ActionButton label="履歴を確認する" onPress={() => {}} />
          </Link>
        </Card>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Card style={{ flex: 1 }}>
            <Text style={styles.muted}>今後の予定</Text>
            <Text style={{ color: colors.ink, fontSize: 28, fontWeight: '800' }}>{postsView.kind === 'posts' ? `${summary.pendingCount}件` : '－'}</Text>
          </Card>
          <Card style={{ flex: 1 }}>
            <Text style={styles.muted}>要確認</Text>
            <Text style={{ color: summary.attentionCount ? colors.danger : colors.ink, fontSize: 28, fontWeight: '800' }}>
              {historyView.kind === 'posts' ? `${summary.attentionCount}件` : '－'}
            </Text>
          </Card>
        </View>

        <BrandPostPreview brandId={activeAccount?.brandId} workspaceName={workspace?.name ?? ''} handle={activeAccount?.profile.handle} />

        <Card style={{ backgroundColor: colors.primarySoft, borderColor: '#C7D2FE' }}>
          <Text style={{ color: colors.primary, fontWeight: '800' }}>投稿内容を調整する</Text>
          <Text style={{ color: colors.ink, ...typography.body }}>トーン・頻度・NGワードなどを設定画面から調整できます。</Text>
          <Link href="/(tabs)/settings" asChild>
            <ActionButton label="投稿設定を開く" onPress={() => {}} />
          </Link>
        </Card>

        <Card style={{ backgroundColor: colors.primarySoft, borderColor: '#C7D2FE' }}>
          <Text style={{ color: colors.primary, fontWeight: '800' }}>AI運用担当者からの提案</Text>
          <Text style={{ color: colors.ink, ...typography.body }}>今週は投稿の冒頭を短くすると、読みやすさが上がりそうです。</Text>
          <Link href="/(tabs)/consult" asChild>
            <ActionButton label="相談内容を見る" onPress={() => {}} />
          </Link>
        </Card>

        {postsView.kind === 'posts' && postsView.posts.length === 0 && historyView.kind === 'posts' && historyView.posts.length === 0 ? (
          <EmptyState title="まだ運用データがありません" detail="接続とアカウント選択が完了すると、予定と履歴がここに表示されます。" />
        ) : null}

        <SignOutButton />
      </ScrollView>
    </Screen>
  );
}
