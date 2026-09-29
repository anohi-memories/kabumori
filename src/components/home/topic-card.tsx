import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { TOPIC_LEVEL_LABEL, topicCardStatus, type HomeTopic } from '@/lib/home-topic';

type TopicCardProps = {
  palette: KabumoriPalette;
  topic: HomeTopic | null;
  loading: boolean;
  error: string;
  onOpen: () => void;
  onRetry: () => void;
};

// Reads from the deterministic get_daily_kabumori_tip RPC (see
// src/lib/daily-topic.ts). A fetch failure must never be shown as "準備中"
// -- that would turn a network/data error into a false product-state
// message, the same class of bug fixed on the report hero card. The whole
// card is tappable to the topic detail screen once a topic is loaded --
// base_text alone is too short to read comfortably here, so this is only a
// preview.
export function TopicCard({ palette, topic, loading, error, onOpen, onRetry }: TopicCardProps) {
  const status = topicCardStatus(!!topic, loading, error);

  return (
    <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <View style={styles.header}>
        <Text style={[styles.eyebrow, { color: palette.accent }]}>TODAY&apos;S TOPIC</Text>
        <Text style={[styles.title, { color: palette.text }]}>今日のトピック</Text>
      </View>

      {status === 'loading' ? (
        <Text style={[styles.bodyText, { color: palette.muted }]}>読み込み中です…</Text>
      ) : status === 'error' ? (
        <View style={[styles.errorCard, { backgroundColor: palette.error }]}>
          <Text style={[styles.errorText, { color: palette.muted }]}>{error}</Text>
          <Pressable onPress={onRetry} style={[styles.retryButton, { backgroundColor: palette.accent }]} accessibilityRole="button" accessibilityLabel="もう一度読み込む">
            <Text style={styles.retryText}>もう一度試す</Text>
          </Pressable>
        </View>
      ) : status === 'topic' && topic ? (
        <Pressable
          onPress={onOpen}
          style={({ pressed }) => [styles.topicBody, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${topic.title}、詳しく読む`}>
          <View style={[styles.levelBadge, { backgroundColor: palette.soft }]}>
            <Text style={[styles.levelText, { color: palette.accent }]}>{TOPIC_LEVEL_LABEL[topic.level]}</Text>
          </View>
          <Text style={[styles.topicTitle, { color: palette.text }]} numberOfLines={2}>
            {topic.title}
          </Text>
          <Text style={[styles.bodyText, { color: palette.muted }]} numberOfLines={2}>
            {topic.body}
          </Text>
          <Text style={[styles.link, { color: palette.accent }]}>詳しく読む →</Text>
        </Pressable>
      ) : (
        <Text style={[styles.bodyText, { color: palette.muted }]}>
          今日のトピックは準備中です。近日中に学べる小さな知識をここでお届けします。
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, borderWidth: 1, padding: 16 },
  header: { marginBottom: 4 },
  eyebrow: { fontWeight: '900', letterSpacing: 1.4, fontSize: 11 },
  title: { fontSize: 19, fontWeight: '900', marginTop: 3 },
  topicBody: {},
  pressed: { opacity: 0.7 },
  levelBadge: { alignSelf: 'flex-start', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5, marginTop: 10 },
  levelText: { fontSize: 11, fontWeight: '900' },
  topicTitle: { fontSize: 16, lineHeight: 22, fontWeight: '900', marginTop: 9 },
  bodyText: { fontSize: 13, lineHeight: 19, marginTop: 8 },
  link: { fontSize: 12, fontWeight: '900', marginTop: 8 },
  errorCard: { borderRadius: 12, padding: 12, marginTop: 10 },
  errorText: { fontSize: 13, lineHeight: 19 },
  retryButton: { alignSelf: 'flex-start', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
  retryText: { color: '#fff', fontWeight: '900', fontSize: 12 },
});
