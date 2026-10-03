import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { TOPIC_CARD } from '@/constants/home-tokens';
import { fetchDailyTopic } from '@/lib/daily-topic';
import { isTopicLevel, TOPIC_LEVEL_LABEL, type HomeTopic } from '@/lib/home-topic';
import { topicDetailFor, type TopicDetailSection } from '@/lib/topic-detail-catalog';

const palette = KABUMORI_COLORS.light;

type Status = 'loading' | 'ok' | 'mismatch' | 'error';

// Pale level tints for the example card and the takeaway block (same palette as the Home topic
// badge: pale green / pale blue / pale lavender).
const LEVEL_SOFT = {
  beginner: '#eef7f0',
  intermediate: '#edf5fc',
  advanced: '#f2effc',
} as const;

// Re-fetches today's topic from the same deterministic RPC using the (level,
// jstDate) passed as params, and only renders if the returned row's id
// matches the id the user actually tapped on Home -- this never lets the
// user land on a different topic than the one they opened, even if the
// level/date changed in the meantime (e.g. from another tab or a midnight
// rollover while this screen was open).
//
// Reading order: identity (level / category / title) -> short intro (the same base_text the Home
// card shows) -> まずこれだけ -> なぜ大事？ -> 具体例 -> 株価・相場との関係 -> 覚えておくポイント.
// The learning content is static curated text (src/lib/topic-detail-catalog.ts): rendering it makes
// no network, AI or database call of its own.
export default function TopicDetailScreen() {
  const params = useLocalSearchParams<{ id?: string; level?: string; jstDate?: string }>();
  const [status, setStatus] = useState<Status>('loading');
  const [topic, setTopic] = useState<HomeTopic | null>(null);

  useEffect(() => {
    let active = true;
    const level = params.level;
    const jstDate = params.jstDate;
    const id = params.id;
    if (!isTopicLevel(level) || !jstDate || !id) {
      setStatus('mismatch');
      return;
    }
    fetchDailyTopic(level, jstDate)
      .then((result) => {
        if (!active) return;
        if (!result || result.id !== id) {
          setStatus('mismatch');
          return;
        }
        setTopic(result);
        setStatus('ok');
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [params.id, params.level, params.jstDate]);

  const detail = topic ? topicDetailFor(topic.title) : null;
  const accent = topic ? TOPIC_CARD.badge[topic.level] : null;
  const soft = topic ? LEVEL_SOFT[topic.level] : null;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.container}>
        <BackButton />

        {status === 'loading' ? (
          <ActivityIndicator color={palette.accent} style={styles.status} />
        ) : status === 'error' ? (
          <Text style={styles.message}>今日のトピックを取得できませんでした。もう一度お試しください。</Text>
        ) : status === 'mismatch' ? (
          <Text style={styles.message}>この内容は表示できません。Homeに戻ってもう一度開き直してください。</Text>
        ) : topic && accent && soft ? (
          <>
            <Text style={styles.eyebrow}>TODAY&apos;S TOPIC</Text>
            <View style={styles.badgeRow}>
              <View style={[styles.levelBadge, { backgroundColor: accent.background }]}>
                <Text style={[styles.levelText, { color: accent.text }]}>{TOPIC_LEVEL_LABEL[topic.level]}</Text>
              </View>
              {topic.category ? <Text style={styles.category}>{topic.category}</Text> : null}
            </View>
            <Text style={styles.title}>{topic.title}</Text>

            {/* Intro: the short summary, clearly separate from the deeper learning below */}
            <View style={[styles.intro, { backgroundColor: soft, borderColor: accent.background }]}>
              <Text style={styles.introText}>{topic.body}</Text>
            </View>

            {detail ? (
              <View style={styles.sections}>
                {detail.sections.map((section) => (
                  <DetailSection key={section.role} section={section} accentText={accent.text} accentBackground={accent.background} soft={soft} />
                ))}
              </View>
            ) : (
              <View style={styles.sections}>
                <Text style={styles.note}>この用語の詳しい解説は準備中です。</Text>
              </View>
            )}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function DetailSection({
  section,
  accentText,
  accentBackground,
  soft,
}: {
  section: TopicDetailSection;
  accentText: string;
  accentBackground: string;
  soft: string;
}) {
  // 具体例: a tinted card so the example is easy to spot. 覚えておくポイント: a calm accent-bar block.
  if (section.role === 'example') {
    return (
      <View style={[styles.exampleCard, { backgroundColor: soft, borderColor: accentBackground }]}>
        <Text style={[styles.sectionHeading, { color: accentText }]}>{section.heading}</Text>
        <Text style={styles.sectionBody}>{section.body}</Text>
      </View>
    );
  }
  if (section.role === 'takeaway') {
    return (
      <View style={[styles.takeaway, { backgroundColor: accentBackground, borderLeftColor: accentText }]}>
        <Text style={[styles.takeawayHeading, { color: accentText }]}>{section.heading}</Text>
        <Text style={styles.takeawayBody}>{section.body}</Text>
      </View>
    );
  }
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionHeading, { color: accentText }]}>{section.heading}</Text>
      <Text style={styles.sectionBody}>{section.body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  container: { padding: 20, paddingBottom: 60 },
  status: { marginTop: 40 },
  message: { color: palette.muted, fontSize: 15, lineHeight: 23, marginTop: 24 },
  eyebrow: { color: palette.accent, fontWeight: '900', letterSpacing: 1.4, fontSize: 11, marginTop: 16 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  levelBadge: { borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5 },
  levelText: { fontSize: 11, fontWeight: '900' },
  category: { color: palette.muted, fontSize: 12, fontWeight: '700' },
  title: { color: palette.text, fontSize: 24, fontWeight: '900', lineHeight: 32, marginTop: 12 },
  intro: { marginTop: 16, borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  introText: { color: palette.text, fontSize: 14, lineHeight: 22, fontWeight: '600' },
  sections: { marginTop: 22, gap: 20 },
  section: { gap: 6 },
  sectionHeading: { fontSize: 14, fontWeight: '900' },
  sectionBody: { color: palette.text, fontSize: 15, lineHeight: 25 },
  exampleCard: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 6 },
  takeaway: { borderRadius: 14, borderLeftWidth: 4, padding: 14, gap: 6 },
  takeawayHeading: { fontSize: 14, fontWeight: '900' },
  takeawayBody: { color: palette.text, fontSize: 15, lineHeight: 25, fontWeight: '700' },
  note: { color: palette.muted, fontSize: 13, lineHeight: 20 },
});
