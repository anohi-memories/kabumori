import { useCallback, useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { dashboardSectionError, todayJst } from '@/lib/dashboard';
import { fetchDailyTopic } from '@/lib/daily-topic';
import { TOPIC_LEVEL_LABEL, type HomeTopic, type TopicLevel } from '@/lib/home-topic';
import { formatTopicDate, pastJstDates } from '@/lib/topic-history';
import { readTopicLevel } from '@/lib/topic-level-storage';

const palette = KABUMORI_COLORS.light;
const PAGE_DAYS = 14;
const MAX_DAYS = 98;

type Row = { date: string; topic: HomeTopic | null; failed: boolean };

// Past daily topics, newest first, for the level selected in Settings. The
// daily topic is a deterministic function of (level, JST date), so each past
// day is the same RPC evaluated for that date -- there is no separate history
// table. Tapping a row opens the same id-verified detail screen as Home.
export default function TopicsScreen() {
  const [level, setLevel] = useState<TopicLevel | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadedDays = useRef(0);
  const today = useRef(todayJst());

  const loadMore = useCallback(async (activeLevel: TopicLevel) => {
    setLoading(true);
    const dates = pastJstDates(today.current, PAGE_DAYS, loadedDays.current);
    const results = await Promise.allSettled(dates.map((date) => fetchDailyTopic(activeLevel, date)));
    const next: Row[] = dates.map((date, index) => {
      const result = results[index];
      return result.status === 'fulfilled'
        ? { date, topic: result.value, failed: false }
        : { date, topic: null, failed: true };
    });
    loadedDays.current += PAGE_DAYS;
    setRows((previous) => [...previous, ...next]);
    setError(next.every((row) => row.failed) ? dashboardSectionError('topic') : '');
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    void readTopicLevel().then((stored) => {
      if (!active) return;
      setLevel(stored);
      void loadMore(stored);
    });
    return () => {
      active = false;
    };
  }, [loadMore]);

  const visible = rows.filter((row) => row.topic);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.container}>
        <BackButton />
        <Text style={styles.eyebrow}>TOPICS</Text>
        <Text style={styles.title}>今日のトピック</Text>
        <Text style={styles.lead}>
          {level ? `${TOPIC_LEVEL_LABEL[level]}のトピックを日付順に表示します。` : ''}
          レベルは設定から変更できます。
        </Text>

        {!!error && <Text style={styles.message}>{error}</Text>}

        {visible.map((row) => (
          <Pressable
            key={row.date}
            onPress={() =>
              row.topic &&
              router.push({
                pathname: '/topic-detail',
                params: { id: row.topic.id, level: row.topic.level, jstDate: row.date },
              })
            }
            accessibilityRole="button"
            accessibilityLabel={`${formatTopicDate(row.date)} ${row.topic?.title ?? ''}`}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <View style={styles.rowMain}>
              <Text style={styles.rowDate}>{formatTopicDate(row.date)}</Text>
              <Text style={styles.rowTitle} numberOfLines={2}>{row.topic?.title}</Text>
              {row.topic?.category ? <Text style={styles.rowCategory}>{row.topic.category}</Text> : null}
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}

        {loading ? <ActivityIndicator color={palette.accent} style={styles.status} /> : null}

        {!loading && !error && !visible.length ? (
          <Text style={styles.message}>表示できるトピックがまだありません。</Text>
        ) : null}

        {!loading && level && loadedDays.current < MAX_DAYS ? (
          <Pressable
            onPress={() => void loadMore(level)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.moreButton, pressed && styles.pressed]}>
            <Text style={styles.moreText}>さらに過去のトピックを見る</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  container: { padding: 20, paddingBottom: 60, gap: 10 },
  eyebrow: { color: palette.accent, fontWeight: '900', letterSpacing: 2, fontSize: 11, marginTop: 4 },
  title: { color: palette.text, fontSize: 26, fontWeight: '900' },
  lead: { color: palette.muted, fontSize: 14, lineHeight: 20, marginBottom: 6 },
  message: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  status: { marginVertical: 16 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: palette.card, borderColor: palette.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14 },
  rowMain: { flex: 1, gap: 3 },
  rowDate: { color: palette.accent, fontSize: 12, fontWeight: '900' },
  rowTitle: { color: palette.text, fontSize: 15, lineHeight: 21, fontWeight: '800' },
  rowCategory: { color: palette.muted, fontSize: 12 },
  chevron: { color: palette.muted, fontSize: 22, marginLeft: 10 },
  pressed: { opacity: 0.7 },
  moreButton: { alignSelf: 'center', borderRadius: 12, backgroundColor: palette.accentSoft, paddingHorizontal: 18, paddingVertical: 12, marginTop: 6 },
  moreText: { color: palette.accent, fontSize: 13, fontWeight: '900' },
});
