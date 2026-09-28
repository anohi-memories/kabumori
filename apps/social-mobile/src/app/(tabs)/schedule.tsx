import { Link } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { mockRepository } from '@/data/mock-repository';
import { colors } from '@/constants/theme';
import { Card, EmptyState, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { resolvePostsView } from '@/domain/data-view';
import type { PostOrigin, PostStatus } from '@/domain/types';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useDataStatus } from '@/providers/data-provider';

const originLabels: Record<PostOrigin, string> = { ai_generated: 'AI生成', user_authored: 'ユーザー作成', fixed: '固定', manual: '手動' };
const statusLabels: Record<PostStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = { draft: { label: '下書き', tone: 'neutral' }, scheduled: { label: '投稿待ち', tone: 'warning' }, publishing: { label: '投稿中', tone: 'warning' }, published: { label: '投稿済み', tone: 'success' }, failed: { label: '失敗', tone: 'danger' } };

export default function ScheduleScreen() {
  const { activeAccount } = useActiveAccount();
  const { status, reason, snapshot } = useDataStatus();
  const mockPosts = mockRepository.getPlannedPosts().filter((post) => post.accountId === activeAccount?.id);
  const view = resolvePostsView(status, reason, snapshot?.plannedPosts, mockPosts);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail="日時が近い順に表示しています">投稿予定</SectionTitle>
        {view.kind === 'loading' ? (
          <Text style={styles.muted}>読み込み中…</Text>
        ) : view.kind === 'unavailable' ? (
          <EmptyState title="投稿予定を確認できません" detail={view.reason ?? '時間をおいて再度お試しください。'} />
        ) : view.posts.length ? (
          [...view.posts]
            .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())
            .map((post) => {
              const status = statusLabels[post.status];
              return (
                <Link key={post.id} href={{ pathname: '/posts/[id]', params: { id: post.id } }} asChild>
                  <Card>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ color: colors.ink, fontWeight: '800' }}>
                        {new Date(post.scheduledAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </Text>
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </View>
                    <Text style={{ color: colors.ink }}>{post.text || '（本文は投稿の確認画面で表示されます）'}</Text>
                    <Text style={styles.muted}>{originLabels[post.origin]} ・ 実投稿は次フェーズ</Text>
                  </Card>
                </Link>
              );
            })
        ) : (
          <EmptyState title="投稿予定はありません" detail="予定が作成されるとここに表示されます。" />
        )}
      </ScrollView>
    </Screen>
  );
}
