import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { fetchDailyTopic } from '@/lib/daily-topic';
import { isTopicLevel, TOPIC_LEVEL_LABEL, type HomeTopic } from '@/lib/home-topic';
import { topicDetailFor } from '@/lib/topic-detail-catalog';

const palette = KABUMORI_COLORS.light;

type Status = 'loading' | 'ok' | 'mismatch' | 'error';

// Re-fetches today's topic from the same deterministic RPC using the (level,
// jstDate) passed as params, and only renders if the returned row's id
// matches the id the user actually tapped on Home -- this never lets the
// user land on a different topic than the one they opened, even if the
// level/date changed in the meantime (e.g. from another tab or a midnight
// rollover while this screen was open).
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

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.backButton}>
          <Text style={styles.backText}>‹ Homeにもどる</Text>
        </Pressable>

        {status === 'loading' ? (
          <ActivityIndicator color={palette.accent} style={styles.status} />
        ) : status === 'error' ? (
          <Text style={styles.message}>今日のトピックを取得できませんでした。もう一度お試しください。</Text>
        ) : status === 'mismatch' ? (
          <Text style={styles.message}>この内容は表示できません。Homeに戻ってもう一度開き直してください。</Text>
        ) : topic ? (
          <>
            <Text style={styles.eyebrow}>TODAY&apos;S TOPIC</Text>
            <View style={styles.badgeRow}>
              <View style={styles.levelBadge}>
                <Text style={styles.levelText}>{TOPIC_LEVEL_LABEL[topic.level]}</Text>
              </View>
              {topic.category ? <Text style={styles.category}>{topic.category}</Text> : null}
            </View>
            <Text style={styles.title}>{topic.title}</Text>

            {detail ? (
              <View style={styles.sections}>
                {detail.sections.map((section) => (
                  <View key={section.heading} style={styles.section}>
                    <Text style={styles.sectionHeading}>{section.heading}</Text>
                    <Text style={styles.sectionBody}>{section.body}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.sections}>
                <Text style={styles.sectionBody}>{topic.body}</Text>
                <Text style={styles.note}>この用語の詳しい解説は準備中です。</Text>
              </View>
            )}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  container: { padding: 20, paddingBottom: 60 },
  backButton: { minHeight: 44, justifyContent: 'center' },
  backText: { color: palette.accent, fontWeight: '800', fontSize: 15 },
  status: { marginTop: 40 },
  message: { color: palette.muted, fontSize: 15, lineHeight: 23, marginTop: 24 },
  eyebrow: { color: palette.accent, fontWeight: '900', letterSpacing: 1.4, fontSize: 11, marginTop: 16 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  levelBadge: { backgroundColor: palette.soft, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5 },
  levelText: { color: palette.accent, fontSize: 11, fontWeight: '900' },
  category: { color: palette.muted, fontSize: 12, fontWeight: '700' },
  title: { color: palette.text, fontSize: 24, fontWeight: '900', lineHeight: 32, marginTop: 12 },
  sections: { marginTop: 20, gap: 18 },
  section: { gap: 6 },
  sectionHeading: { color: palette.accent, fontSize: 13, fontWeight: '900' },
  sectionBody: { color: palette.text, fontSize: 15, lineHeight: 24 },
  note: { color: palette.muted, fontSize: 12, marginTop: 4 },
});
