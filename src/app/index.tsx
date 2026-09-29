import { useCallback, useMemo, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchMyImportantStockNews, type ImportantStockNews } from '@/lib/important-news';
import { targetLabel } from '@/lib/news-labels';
import { fetchRecentReports } from '@/lib/personalized-reports';
import { formatDateJa, type PersonalizedReport } from '@/lib/report-presentation';
import { dashboardGreeting, dashboardSectionError, todayJst } from '@/lib/dashboard';
import { currentReport, buildReportHighlights } from '@/lib/home-report-highlights';
import { splitHomeNewsSections } from '@/lib/home-news-sections';
import { fetchDailyTopic } from '@/lib/daily-topic';
import { readTopicLevel } from '@/lib/topic-level-storage';
import { topicKeyMatches, type HomeTopic, type TopicLevel, type TopicRequestKey } from '@/lib/home-topic';
import { KABUMORI_COLORS, type KabumoriPalette } from '@/constants/kabumori-theme';
import { ReportHighlightCard } from '@/components/home/report-highlight-card';
import { HomeNewsSection } from '@/components/home/home-news-section';
import { TopicCard } from '@/components/home/topic-card';
import { AskAiEntry } from '@/components/home/ask-ai-entry';

export default function HomeScreen() {
  // Keep the core Kabumori screens on one light palette until a complete dark
  // mode pass can cover every screen consistently.
  const palette: KabumoriPalette = KABUMORI_COLORS.light;
  const greeting = dashboardGreeting();
  const [news, setNews] = useState<ImportantStockNews[]>([]);
  const [reports, setReports] = useState<PersonalizedReport[]>([]);
  const [topic, setTopic] = useState<HomeTopic | null>(null);
  const [topicKey, setTopicKey] = useState<TopicRequestKey | null>(null);
  const [topicLevel, setTopicLevel] = useState<TopicLevel>('beginner');
  // Resolved fresh on every load/focus/refresh (not once at mount): if the
  // app stays mounted across JST midnight, a later focus or pull-to-refresh
  // must not keep fetching/scoping content to yesterday.
  const [todayJstValue, setTodayJstValue] = useState(() => todayJst());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState({ news: '', reports: '', topic: '' });

  // Three network calls total (news feed + reports + daily topic), down from
  // the original three-call layout's tracked_stocks fetch: market/holding
  // news comes from the same get_my_important_stock_news feed via
  // tracking_type, so nothing is fetched twice. The topic level preference
  // itself is a fast local AsyncStorage read, not a network call.
  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    const today = todayJst();
    setTodayJstValue(today);
    const level = await readTopicLevel();
    setTopicLevel(level);
    const [newsResult, reportsResult, topicResult] = await Promise.allSettled([
      fetchMyImportantStockNews(),
      fetchRecentReports(),
      fetchDailyTopic(level, today),
    ]);
    setErrors({
      news: newsResult.status === 'rejected' ? dashboardSectionError('news') : '',
      reports: reportsResult.status === 'rejected' ? dashboardSectionError('reports') : '',
      topic: topicResult.status === 'rejected' ? dashboardSectionError('topic') : '',
    });
    if (newsResult.status === 'fulfilled') setNews(newsResult.value.items);
    if (reportsResult.status === 'fulfilled') setReports(reportsResult.value);
    // A rejected topic fetch deliberately leaves `topic`/`topicKey` alone: a
    // same-key retry can still show the last-good topic (matches the report
    // hero's precedent), while topicKeyMatches() below hides it the moment
    // the key no longer matches (level changed, or the date rolled over).
    if (topicResult.status === 'fulfilled') {
      setTopic(topicResult.value);
      setTopicKey({ level, jstDate: today });
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const newsSections = useMemo(() => splitHomeNewsSections(news), [news]);
  const report = useMemo(() => currentReport(reports, todayJstValue), [reports, todayJstValue]);
  const highlights = useMemo(() => buildReportHighlights(report), [report]);
  const today = useMemo(() => formatDateJa(todayJstValue), [todayJstValue]);
  const currentTopicKey = useMemo<TopicRequestKey>(() => ({ level: topicLevel, jstDate: todayJstValue }), [topicLevel, todayJstValue]);
  const displayedTopic = useMemo(
    () => (topicKeyMatches(topicKey, currentTopicKey) ? topic : null),
    [topic, topicKey, currentTopicKey],
  );

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={palette.accent} />}>
        <View style={styles.titleRow}>
          <View style={styles.titleMain}>
            <Text style={[styles.eyebrow, { color: palette.accent }]}>{greeting.eyebrow}</Text>
            <Text style={[styles.title, { color: palette.text }]}>{greeting.title}</Text>
            <Text style={[styles.date, { color: palette.muted }]}>{today}</Text>
          </View>
          <Pressable
            onPress={() => router.push('/settings')}
            style={({ pressed }) => [styles.settingsButton, { backgroundColor: palette.accentSoft }, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="設定"
            accessibilityHint="アカウント・通知・規約・ログアウトの設定を開きます">
            <Text style={[styles.settingsText, { color: palette.muted }]}>設定</Text>
          </Pressable>
        </View>

        <ReportHighlightCard
          palette={palette}
          report={report}
          points={highlights.points}
          loading={loading && !reports.length}
          error={errors.reports}
          onOpen={() => report && router.push({ pathname: '/reports/[id]', params: { id: report.id } })}
          onRetry={() => void load(true)}
        />

        <HomeNewsSection
          palette={palette}
          eyebrow="MARKET NEWS"
          title="重要ニュース"
          items={newsSections.market}
          loading={loading && !news.length}
          error={errors.news}
          emptyText="市場全体の重要ニュースはまだありません。"
          itemSubtitle={(item) => targetLabel(item).detail}
          onRetry={() => void load(true)}
        />

        <HomeNewsSection
          palette={palette}
          eyebrow="YOUR HOLDINGS"
          title="あなたの保有銘柄 最新ニュース"
          items={newsSections.holding}
          loading={loading && !news.length}
          error={errors.news}
          emptyText="保有銘柄に関連する新着ニュースはまだありません。"
          itemSubtitle={(item) => `${item.ticker_code ?? ''} ${item.company_name}`.trim()}
          onRetry={() => void load(true)}
        />

        <TopicCard
          palette={palette}
          topic={displayedTopic}
          loading={loading && !displayedTopic}
          error={errors.topic}
          onOpen={() =>
            displayedTopic &&
            router.push({
              pathname: '/topic-detail',
              params: { id: displayedTopic.id, level: displayedTopic.level, jstDate: todayJstValue },
            })
          }
          onRetry={() => void load(true)}
        />

        <AskAiEntry palette={palette} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 110, gap: 14 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  titleMain: { flex: 1 },
  settingsButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, marginTop: 4 },
  settingsText: { fontSize: 12, fontWeight: '800' },
  eyebrow: { fontWeight: '900', letterSpacing: 2, fontSize: 12 },
  title: { fontSize: 32, fontWeight: '900', marginTop: 5 },
  date: { fontSize: 13, fontWeight: '700', marginTop: 4 },
  pressed: { opacity: 0.7 },
});
