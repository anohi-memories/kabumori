import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image, type ImageSource } from 'expo-image';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { HOME_COLORS, HOME_LAYOUT } from '@/constants/home-tokens';
import { TOPIC_LEVEL_LABEL, topicCardStatus, type HomeTopic } from '@/lib/home-topic';
import { HomeSectionHeader } from '@/components/home/home-section-header';

// Asset slot: topic background art (no text baked in). Set to
//   require('@/assets/images/home/topic_background.webp')
// when the file exists (NOT required while missing). It fills the feature card with
// contentFit="cover" behind the native text, so adding it needs no layout change.
export const TOPIC_BACKGROUND_SOURCE: ImageSource | null = null;

type HomeTopicFeatureProps = {
  palette: KabumoriPalette;
  topic: HomeTopic | null;
  loading: boolean;
  error: string;
  onOpen: () => void;
  onRetry: () => void;
};

// Featured card: level badge / title (2 lines max) / summary (2 lines max) on the left, the
// background art area on the right, CTA bottom-right. Reads the deterministic daily-topic RPC; a
// fetch failure is never shown as "準備中" (that would turn a data error into a false product
// state). The whole card opens the topic detail once a topic is loaded.
export function HomeTopicFeature({ palette, topic, loading, error, onOpen, onRetry }: HomeTopicFeatureProps) {
  const status = topicCardStatus(!!topic, loading, error);

  return (
    <View>
      <HomeSectionHeader
        palette={palette}
        title="今日のトピック"
        markColor="#e8a317"
        accessibilityLabel="過去のトピックをすべて見る"
        href="/topics"
      />

      <View style={styles.card}>
        {TOPIC_BACKGROUND_SOURCE ? (
          <Image source={TOPIC_BACKGROUND_SOURCE} style={StyleSheet.absoluteFill} contentFit="cover" accessible={false} />
        ) : null}

        {status === 'loading' ? (
          <Text style={[styles.summary, { color: palette.muted }]}>読み込み中です…</Text>
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
            style={({ pressed }) => [styles.body, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`${topic.title}、詳しく読む`}>
            <View style={styles.text}>
              <Text style={styles.levelBadge}>{TOPIC_LEVEL_LABEL[topic.level]}</Text>
              <Text style={[styles.title, { color: palette.text }]} numberOfLines={2}>
                {topic.title}
              </Text>
              <Text style={[styles.summary, { color: palette.muted }]} numberOfLines={2}>
                {topic.body}
              </Text>
            </View>
            <Text style={styles.cta}>詳しく見る →</Text>
          </Pressable>
        ) : (
          <Text style={[styles.summary, { color: palette.muted }]}>
            今日のトピックは準備中です。近日中に学べる小さな知識をここでお届けします。
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 8,
    borderRadius: HOME_LAYOUT.radius,
    borderWidth: 1,
    borderColor: HOME_COLORS.topicBorder,
    backgroundColor: HOME_COLORS.topicBackground,
    padding: 10,
    overflow: 'hidden',
    minHeight: 104,
    justifyContent: 'center',
  },
  body: {},
  // Left ~62%: the right side stays free for the (future) background illustration.
  text: { width: '62%', gap: 4 },
  levelBadge: {
    alignSelf: 'flex-start',
    backgroundColor: HOME_COLORS.topicBadgeBackground,
    color: HOME_COLORS.topicBadgeText,
    fontSize: 11,
    fontWeight: '900',
    borderRadius: 99,
    paddingHorizontal: 10,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '900' },
  summary: { fontSize: 12, lineHeight: 17, fontWeight: '600' },
  cta: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    color: '#17211a',
    fontSize: 12,
    fontWeight: '900',
    borderRadius: 99,
    paddingHorizontal: 14,
    paddingVertical: 8,
    overflow: 'hidden',
  },
  errorCard: { borderRadius: 12, padding: 12 },
  errorText: { fontSize: 13, lineHeight: 19 },
  retryButton: { alignSelf: 'flex-start', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
  retryText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  pressed: { opacity: 0.8 },
});
