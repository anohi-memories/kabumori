import { StyleSheet, Text, View } from 'react-native';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { TOPIC_LEVEL_LABEL, type HomeTopic } from '@/lib/home-topic';

type TopicCardProps = {
  palette: KabumoriPalette;
  topic: HomeTopic | null;
  loading: boolean;
};

// There is no daily-topic backend yet (see src/lib/home-topic.ts), so this
// renders a future-ready empty state rather than a hardcoded fake topic.
export function TopicCard({ palette, topic, loading }: TopicCardProps) {
  return (
    <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <View style={styles.header}>
        <Text style={[styles.eyebrow, { color: palette.accent }]}>TODAY&apos;S TOPIC</Text>
        <Text style={[styles.title, { color: palette.text }]}>今日のトピック</Text>
      </View>

      {loading ? (
        <Text style={[styles.bodyText, { color: palette.muted }]}>読み込み中です…</Text>
      ) : topic ? (
        <>
          <View style={[styles.levelBadge, { backgroundColor: palette.soft }]}>
            <Text style={[styles.levelText, { color: palette.accent }]}>{TOPIC_LEVEL_LABEL[topic.level]}</Text>
          </View>
          <Text style={[styles.topicTitle, { color: palette.text }]} numberOfLines={2}>
            {topic.title}
          </Text>
          <Text style={[styles.bodyText, { color: palette.muted }]} numberOfLines={3}>
            {topic.body}
          </Text>
        </>
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
  levelBadge: { alignSelf: 'flex-start', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5, marginTop: 10 },
  levelText: { fontSize: 11, fontWeight: '900' },
  topicTitle: { fontSize: 16, lineHeight: 22, fontWeight: '900', marginTop: 9 },
  bodyText: { fontSize: 13, lineHeight: 19, marginTop: 8 },
});
