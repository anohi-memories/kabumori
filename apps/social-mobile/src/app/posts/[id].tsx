import { useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import { mockRepository } from '@/data/mock-repository';
import { colors } from '@/constants/theme';
import { Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { useDataStatus } from '@/providers/data-provider';

export default function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { status, snapshot } = useDataStatus();

  if (status === 'loading') {
    return (
      <Screen>
        <Card>
          <Text style={styles.muted}>読み込み中…</Text>
        </Card>
      </Screen>
    );
  }

  // `history` already carries every post (published/failed and still
  // pending), so it doubles as the full lookup source; see
  // supabase-repository.ts and mock-repository.ts.
  const source = status === 'ready' && snapshot ? snapshot.history : status === 'mock_preview' ? mockRepository.getHistory() : null;
  const post = source?.find((item) => item.id === id) ?? null;

  if (!post) {
    return (
      <Screen>
        <Card>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>投稿が見つかりません</Text>
          <Text style={styles.muted}>
            {source === null ? '運用データを確認できないため表示できません。' : '一覧からもう一度選択してください。'}
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <SectionTitle detail={new Date(post.scheduledAt).toLocaleString('ja-JP')}>投稿詳細</SectionTitle>
      <Card>
        <Pill tone={post.status === 'published' ? 'success' : post.status === 'failed' ? 'danger' : 'warning'}>{post.status}</Pill>
        <Text selectable style={{ color: colors.ink, fontSize: 16, lineHeight: 25 }}>
          {post.text || '（本文はまだ取得できません）'}
        </Text>
        <Text style={styles.muted}>この画面ではまだ投稿の編集・再送は行いません。</Text>
      </Card>
    </Screen>
  );
}
