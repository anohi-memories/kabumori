import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image, type ImageSource } from 'expo-image';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { HOME_COLORS, HOME_LAYOUT, TOPIC_CARD } from '@/constants/home-tokens';
import { TOPIC_LEVEL_LABEL, topicCardStatus, type HomeTopic, type TopicLevel } from '@/lib/home-topic';
import { HomeSectionHeader } from '@/components/home/home-section-header';

// One approved background per topic level (the three-level series: pale green / pale blue / pale
// lavender, 1942x809, lossless, no baked text or UI). The level comes only from `topic.level` -- no text
// heuristics, no date guess, no randomness. Static requires, because Metro resolves assets at build time.
export const TOPIC_BACKGROUND_SOURCES: Record<TopicLevel, ImageSource> = {
  beginner: require('@/assets/images/home/topic_background_beginner.webp'),
  intermediate: require('@/assets/images/home/topic_background_intermediate.webp'),
  advanced: require('@/assets/images/home/topic_background_advanced.webp'),
};

type HomeTopicFeatureProps = {
  palette: KabumoriPalette;
  topic: HomeTopic | null;
  loading: boolean;
  error: string;
  onOpen: () => void;
  onRetry: () => void;
};

// Featured card. Loaded: the level's background art fills a card that has the art's own aspect ratio
// (so it is never stretched or meaningfully cropped); badge / title (2 lines max) / summary (2 lines
// max) sit in the quiet left ~56%, and 「詳しく見る →」 sits in the art's intentionally empty
// bottom-right. The whole card is one Pressable that opens the topic detail. Loading / error / empty
// keep the plain card and their truthful texts (no level is invented, no background is shown). A fetch
// failure is never shown as "準備中" (that would turn a data error into a false product state).
export function HomeTopicFeature({ palette, topic, loading, error, onOpen, onRetry }: HomeTopicFeatureProps) {
  const status = topicCardStatus(!!topic, loading, error);
  const loaded = status === 'topic' && !!topic;

  return (
    <View>
      <HomeSectionHeader
        palette={palette}
        title="今日のトピック"
        markColor="#e8a317"
        accessibilityLabel="過去のトピックをすべて見る"
        href="/topics"
      />

      <View style={[styles.card, loaded ? styles.cardLoaded : styles.cardPlain]}>
        {loaded && topic ? (
          <>
            <Image
              source={TOPIC_BACKGROUND_SOURCES[topic.level]}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              accessible={false}
            />
            <Pressable
              onPress={onOpen}
              style={({ pressed }) => [styles.pressFill, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`${topic.title}、詳しく読む`}>
              <View style={styles.text}>
                <Text
                  style={[
                    styles.levelBadge,
                    { backgroundColor: TOPIC_CARD.badge[topic.level].background, color: TOPIC_CARD.badge[topic.level].text },
                  ]}>
                  {TOPIC_LEVEL_LABEL[topic.level]}
                </Text>
                <Text style={[styles.title, { color: palette.text }]} numberOfLines={2}>
                  {topic.title}
                </Text>
                <Text style={[styles.summary, { color: palette.muted }]} numberOfLines={2}>
                  {topic.body}
                </Text>
              </View>
              <Text style={styles.cta}>詳しく見る →</Text>
            </Pressable>
          </>
        ) : status === 'loading' ? (
          <Text style={[styles.summary, { color: palette.muted }]}>読み込み中です…</Text>
        ) : status === 'error' ? (
          <View style={[styles.errorCard, { backgroundColor: palette.error }]}>
            <Text style={[styles.errorText, { color: palette.muted }]}>{error}</Text>
            <Pressable onPress={onRetry} style={[styles.retryButton, { backgroundColor: palette.accent }]} accessibilityRole="button" accessibilityLabel="もう一度読み込む">
              <Text style={styles.retryText}>もう一度試す</Text>
            </Pressable>
          </View>
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
    overflow: 'hidden',
  },
  // The approved artwork's own ratio: the card is exactly as tall as the art needs, for every level.
  cardLoaded: { aspectRatio: TOPIC_CARD.aspectRatio },
  cardPlain: { backgroundColor: HOME_COLORS.topicBackground, padding: 10, minHeight: 96, justifyContent: 'center' },
  pressFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, padding: TOPIC_CARD.padding },
  // Quiet text area: the left part of the art; the illustration cluster is on the right.
  text: { width: TOPIC_CARD.textWidth, gap: 4 },
  levelBadge: {
    alignSelf: 'flex-start',
    fontSize: 11,
    fontWeight: '900',
    borderRadius: 99,
    paddingHorizontal: 10,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  title: { fontSize: 15, lineHeight: 19, fontWeight: '900' },
  summary: { fontSize: 11.5, lineHeight: 16, fontWeight: '600' },
  // Bottom-right, inside the art's intentionally empty corner.
  cta: {
    position: 'absolute',
    right: TOPIC_CARD.ctaRight,
    bottom: TOPIC_CARD.ctaBottom,
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
