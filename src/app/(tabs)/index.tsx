import { useCallback, useMemo, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { AppState, RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchMyImportantStockNews, type ImportantStockNews } from '@/lib/important-news';
import { fetchHomeMarketReports } from '@/lib/ondemand-analysis';
import { formatDateJa } from '@/lib/report-presentation';
import { dashboardGreeting, dashboardSectionError, todayJst } from '@/lib/dashboard';
import { HOME_MARKET_INITIAL, homeMarketRouteParams, resolveHomeMarketState, type HomeMarketState } from '@/lib/home-market-report';
import { splitHomeNewsSections } from '@/lib/home-news-sections';
import { fetchDailyTopic } from '@/lib/daily-topic';
import { readTopicLevel } from '@/lib/topic-level-storage';
import { topicKeyMatches, type HomeTopic, type TopicLevel, type TopicRequestKey } from '@/lib/home-topic';
import { KABUMORI_COLORS, type KabumoriPalette } from '@/constants/kabumori-theme';
import { HOME_LAYOUT } from '@/constants/home-tokens';
import { HomeHeader } from '@/components/home/home-header';
import { HomeReportHero } from '@/components/home/home-report-hero';
import { HomeMarketNewsGrid } from '@/components/home/home-market-news-grid';
import { HomeHoldingNewsList } from '@/components/home/home-holding-news-list';
import { HomeTopicFeature } from '@/components/home/home-topic-feature';
import { HomeAskAiEntry } from '@/components/home/home-ask-ai-entry';

// Returning to the app (background -> active) refreshes only the shared market report, at most this often.
const MARKET_RESUME_MIN_INTERVAL_MS = 60_000;

export default function HomeScreen() {
  // Keep the core Kabumori screens on one light palette until a complete dark
  // mode pass can cover every screen consistently.
  const palette: KabumoriPalette = KABUMORI_COLORS.light;
  const greeting = dashboardGreeting();
  const [news, setNews] = useState<ImportantStockNews[]>([]);
  // The shared market report (morning / close for everyone) behind 「今日のポイント」; never a personalized report.
  const [market, setMarket] = useState<HomeMarketState>(HOME_MARKET_INITIAL);
  const lastMarketLoadRef = useRef(0);
  const [topic, setTopic] = useState<HomeTopic | null>(null);
  const [topicKey, setTopicKey] = useState<TopicRequestKey | null>(null);
  const [topicLevel, setTopicLevel] = useState<TopicLevel>('beginner');
  // Resolved fresh on every load/focus/refresh (not once at mount): if the
  // app stays mounted across JST midnight, a later focus or pull-to-refresh
  // must not keep fetching/scoping content to yesterday.
  const [todayJstValue, setTodayJstValue] = useState(() => todayJst());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState({ news: '', topic: '' });

  // Four network calls total (news feed + the latest shared morning and close report + daily topic):
  // market/holding news comes from the same get_my_important_stock_news feed via tracking_type, so
  // nothing is fetched twice. The shared reports are two get_app_market_report calls (morning and
  // close, latest of each); which one Home shows is decided from what is actually published, see
  // home-market-report.ts. The topic level preference itself is a fast local AsyncStorage read, not a
  // network call. Nothing here polls: loads happen on focus, pull-to-refresh and (market only) app resume.
  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    const today = todayJst();
    setTodayJstValue(today);
    const level = await readTopicLevel();
    setTopicLevel(level);
    lastMarketLoadRef.current = Date.now();
    const [newsResult, marketResults, topicResult] = await Promise.allSettled([
      fetchMyImportantStockNews(),
      fetchHomeMarketReports(),
      fetchDailyTopic(level, today),
    ]);
    setErrors({
      news: newsResult.status === 'rejected' ? dashboardSectionError('news') : '',
      topic: topicResult.status === 'rejected' ? dashboardSectionError('topic') : '',
    });
    if (newsResult.status === 'fulfilled') setNews(newsResult.value.items);
    // fetchHomeMarketReports never rejects (allSettled); a failed half keeps the last confirmed report, flagged.
    if (marketResults.status === 'fulfilled') {
      setMarket((previous) => resolveHomeMarketState(previous.report, marketResults.value));
    }
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

  // App resume while Home is focused: re-read only the shared market report (a new morning / close may have been
  // published, or the JST date may have rolled over), not more often than MARKET_RESUME_MIN_INTERVAL_MS.
  useFocusEffect(
    useCallback(() => {
      const subscription = AppState.addEventListener('change', (state) => {
        if (state !== 'active' || Date.now() - lastMarketLoadRef.current < MARKET_RESUME_MIN_INTERVAL_MS) return;
        lastMarketLoadRef.current = Date.now();
        setTodayJstValue(todayJst());
        void fetchHomeMarketReports().then((results) =>
          setMarket((previous) => resolveHomeMarketState(previous.report, results)),
        );
      });
      return () => subscription.remove();
    }, []),
  );

  const newsSections = useMemo(() => splitHomeNewsSections(news), [news]);
  const marketError = market.failed ? dashboardSectionError('reports') : '';
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
        <HomeHeader palette={palette} greeting={greeting.title} date={today} />

        <HomeReportHero
          palette={palette}
          report={market.report}
          todayJst={todayJstValue}
          unconfirmed={market.unconfirmed}
          loading={loading && !market.report}
          error={marketError}
          // The shared market report detail on the root stack: 戻る / a swipe pops straight back to Home. The params
          // pin the exact published report (type, trading date, id) and strict, so the detail never swaps in another day.
          onOpen={() =>
            market.report && router.push({ pathname: '/market-report', params: homeMarketRouteParams(market.report) })
          }
          onRetry={() => void load(true)}
        />

        <HomeMarketNewsGrid
          palette={palette}
          items={newsSections.market}
          loading={loading && !news.length}
          error={errors.news}
          onRetry={() => void load(true)}
        />

        <HomeHoldingNewsList
          palette={palette}
          items={newsSections.holding}
          loading={loading && !news.length}
          error={errors.news}
          onRetry={() => void load(true)}
        />

        <HomeTopicFeature
          palette={palette}
          topic={displayedTopic}
          loading={loading && !displayedTopic}
          error={errors.topic}
          onOpen={() =>
            displayedTopic &&
            router.push({
              pathname: '/topic-detail',
              params: { id: displayedTopic.id, level: displayedTopic.level, jstDate: todayJstValue, from: 'home' },
            })
          }
          onRetry={() => void load(true)}
        />

        <HomeAskAiEntry palette={palette} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    paddingHorizontal: HOME_LAYOUT.gutter,
    paddingTop: 8,
    paddingBottom: HOME_LAYOUT.bottomInset,
    gap: HOME_LAYOUT.sectionGap,
  },
});
