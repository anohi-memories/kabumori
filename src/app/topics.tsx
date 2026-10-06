import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { LevelSwitcher } from '@/components/level-switcher';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { dashboardSectionError, todayJst } from '@/lib/dashboard';
import { fetchDailyTopic } from '@/lib/daily-topic';
import { isTopicLevel, TOPIC_LEVEL_LABEL, type TopicLevel } from '@/lib/home-topic';
import { TOPIC_DETAIL_LEVEL_COLORS } from '@/lib/topic-detail-presentation';
import { formatTopicDate, pastJstDates } from '@/lib/topic-history';
import {
  applyPage,
  beginLoad,
  canLoadMore,
  createTopicListState,
  loadTopicListPage,
  shouldAutoLoad,
  TOPIC_LIST_PAGE_DAYS,
  visibleRows,
  type TopicListState,
} from '@/lib/topic-list';
import { isTopicRead } from '@/lib/topic-read';
import { topicReadStore } from '@/lib/topic-read-storage';
import { readTopicLevel } from '@/lib/topic-level-storage';

const palette = KABUMORI_COLORS.light;

// Past daily topics, newest first, for the level chosen HERE. The daily topic is a deterministic function
// of (level, JST date), so each past day is the same RPC evaluated for that date -- there is no separate
// history table. Tapping a row opens the same id-verified detail screen as Home.
//
// The Settings level only decides what Home shows; here it is just the level the list opens on the first
// time (when no level was requested). Switching the level in this screen is local to it and never writes the
// Settings preference. A level requested by navigation (`level` + `req` params, sent by the detail's
// 「トピック一覧 ›」) wins for that navigation. Each level keeps its own loaded rows in memory, and only the
// selected level is fetched.
export default function TopicsScreen() {
  const params = useLocalSearchParams<{ level?: string; req?: string }>();
  const [selected, setSelected] = useState<TopicLevel | null>(null);
  const [lists, setLists] = useState<TopicListState>(createTopicListState);
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(new Set());
  const listsRef = useRef<TopicListState>(lists);
  const selectedRef = useRef<TopicLevel | null>(null);
  const mounted = useRef(true);
  const scrollRef = useRef<ScrollView>(null);
  const today = useRef(todayJst());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const select = useCallback((level: TopicLevel) => {
    selectedRef.current = level;
    setSelected(level);
  }, []);

  // Initial level: an explicitly requested one, otherwise the Settings level -- read once, only while the
  // user has not chosen a level here yet (a later param-less return never resets their choice).
  useEffect(() => {
    if (isTopicLevel(params.level)) {
      select(params.level);
      // An explicit request shows that level from its top (the list may have been scrolled on another level).
      scrollRef.current?.scrollTo({ y: 0, animated: false });
      return;
    }
    if (selectedRef.current) return;
    let active = true;
    void readTopicLevel().then((stored) => {
      if (active && !selectedRef.current) select(stored);
    });
    return () => {
      active = false;
    };
  }, [params.level, params.req, select]);

  const update = useCallback((change: (state: TopicListState) => TopicListState) => {
    listsRef.current = change(listsRef.current);
    if (mounted.current) setLists(listsRef.current);
  }, []);

  // Loads one page of ONE level. The result is applied to that level's own entry, so a slow answer for a
  // level the user already left can never be appended to the level on screen.
  const loadMore = useCallback(
    async (level: TopicLevel) => {
      const entry = listsRef.current[level];
      if (entry.loading) return;
      update((state) => beginLoad(state, level));
      const dates = pastJstDates(today.current, TOPIC_LIST_PAGE_DAYS, entry.loadedDays);
      const page = await loadTopicListPage({ level, dates, fetchTopic: fetchDailyTopic });
      update((state) => applyPage(state, level, page));
    },
    [update],
  );

  // The first page of the selected level loads once; a level that was already loaded is simply shown again.
  useEffect(() => {
    if (selected && shouldAutoLoad(listsRef.current[selected])) void loadMore(selected);
  }, [selected, loadMore]);

  // Learned state is local to this device; reload it whenever the list is focused again so a topic read in a
  // detail shows as learned right after coming back.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void topicReadStore.read().then((ids) => {
        if (active) setReadIds(ids);
      });
      return () => {
        active = false;
      };
    }, []),
  );

  const level = selected;
  const entry = level ? lists[level] : null;
  const rows = entry ? visibleRows(entry) : [];
  const levelColors = level ? TOPIC_DETAIL_LEVEL_COLORS[level] : null;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.container}>
        <BackButton />
        <Text style={styles.eyebrow}>TOPICS</Text>
        <Text style={styles.title}>今日のトピック</Text>
        <Text style={styles.lead}>
          {level ? `${TOPIC_LEVEL_LABEL[level]}のトピックを日付順に表示します。` : ''}
          ここでレベルを切り替えられます。設定のレベルは、ホームに表示するトピックだけを決めます。
        </Text>

        {!level ? <View style={styles.switcherPlaceholder} /> : null}
        {level ? (
          <LevelSwitcher
            active={level}
            onSelect={select}
            hint="このレベルの過去のトピックを表示します。ホームの設定は変わりません。"
          />
        ) : null}

        {entry?.error ? <Text style={styles.message}>{dashboardSectionError('topic')}</Text> : null}

        {rows.map((row) => {
          const read = row.topic ? isTopicRead(readIds, row.topic.id) : false;
          return (
            <Pressable
              key={row.date}
              onPress={() =>
                row.topic &&
                router.push({
                  pathname: '/topic-detail',
                  params: { id: row.topic.id, level: row.topic.level, jstDate: row.date, from: 'topics' },
                })
              }
              accessibilityRole="button"
              accessibilityLabel={`${formatTopicDate(row.date)} ${row.topic?.title ?? ''} ${read ? '学習済み' : '未読'}`}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
              <View style={styles.rowMain}>
                <View style={styles.rowTop}>
                  <Text style={styles.rowDate}>{formatTopicDate(row.date)}</Text>
                  {read ? (
                    <Text style={[styles.statusRead, levelColors && { color: levelColors.strong }]}>✓ 学習済み</Text>
                  ) : (
                    <Text style={styles.statusUnread}>未読</Text>
                  )}
                </View>
                <Text style={styles.rowTitle} numberOfLines={2}>{row.topic?.title}</Text>
                {row.topic?.category ? <Text style={styles.rowCategory}>{row.topic.category}</Text> : null}
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          );
        })}

        {entry?.loading ? <ActivityIndicator color={palette.accent} style={styles.status} /> : null}

        {entry && entry.attempted && !entry.loading && !entry.error && !rows.length ? (
          <Text style={styles.message}>表示できるトピックがまだありません。</Text>
        ) : null}

        {level && entry && entry.attempted && canLoadMore(entry) ? (
          <Pressable
            onPress={() => void loadMore(level)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.moreButton, pressed && styles.pressed]}>
            <Text style={styles.moreText}>{entry.error && !rows.length ? 'もう一度読み込む' : 'さらに過去のトピックを見る'}</Text>
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
  // Keeps the selector's place until the Settings level has been read (no layout jump).
  switcherPlaceholder: { height: 48, marginTop: 12 },
  message: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  status: { marginVertical: 16 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: palette.card, borderColor: palette.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14 },
  rowMain: { flex: 1, gap: 3 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowDate: { color: palette.accent, fontSize: 12, fontWeight: '900' },
  statusRead: { fontSize: 12, fontWeight: '900' },
  statusUnread: { color: palette.muted, fontSize: 12, fontWeight: '700' },
  rowTitle: { color: palette.text, fontSize: 15, lineHeight: 21, fontWeight: '800' },
  rowCategory: { color: palette.muted, fontSize: 12 },
  chevron: { color: palette.muted, fontSize: 22, marginLeft: 10 },
  pressed: { opacity: 0.7 },
  moreButton: { alignSelf: 'center', borderRadius: 12, backgroundColor: palette.accentSoft, paddingHorizontal: 18, paddingVertical: 12, marginTop: 6 },
  moreText: { color: palette.accent, fontSize: 13, fontWeight: '900' },
});
