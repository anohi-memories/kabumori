import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image, type ImageSource } from 'expo-image';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { fetchDailyTopic } from '@/lib/daily-topic';
import { goHome, goPastTopics } from '@/lib/detail-navigation';
import { isTopicLevel, TOPIC_LEVEL_LABEL, type HomeTopic, type TopicLevel } from '@/lib/home-topic';
import { topicDetailFor, type TopicDetailSection } from '@/lib/topic-detail-catalog';
import {
  createTopicViewCache,
  decideLevelSwitch,
  resolveTopicForLevel,
  topicDetailRouteParams,
  topicSwitchErrorMessage,
  TOPIC_SWITCH_LEVELS,
} from '@/lib/topic-detail-switch';
import {
  splitTrailingCaution,
  TOPIC_DETAIL_ART_ASPECT,
  TOPIC_DETAIL_LEVEL_COLORS,
  topicDetailStepNumber,
  topicDetailTitleStyle,
  TOPIC_DETAIL_ART_CLEAR_RATIO,
} from '@/lib/topic-detail-presentation';
import { formatTopicDate } from '@/lib/topic-history';

const palette = KABUMORI_COLORS.light;

type Status = 'loading' | 'ok' | 'mismatch' | 'error';

const SCREEN_PADDING = 20;
const PAGE_BACKGROUND = '#fbfbf6';
const INK = '#2a3830';

// The approved canonical level artwork (the same files the Home topic card uses; never edited, never
// stretched). It is laid at the top of the Hero at its own aspect ratio, softened under the text.
const HERO_ART: Record<TopicLevel, ImageSource> = {
  beginner: require('@/assets/images/home/topic_background_beginner.webp'),
  intermediate: require('@/assets/images/home/topic_background_intermediate.webp'),
  advanced: require('@/assets/images/home/topic_background_advanced.webp'),
};

// The art is softened with a native tint wash so a long title stays readable: a left-to-right ramp
// (strong under the text, none over the illustration on the right) and a short fade at the bottom edge
// where the art ends inside a taller Hero. Strips never overlap, so the ramps have no banding.
const WASH_STRIPS = 20;
const WASH_SOLID_STRIPS = 4;
const WASH_CLEAR_FROM = 12;
const FADE_STRIPS = 12;
const FADE_STRIP_HEIGHT = 2;

// Re-fetches today's topic from the same deterministic RPC using the (level,
// jstDate) passed as params, and only renders if the returned row's id
// matches the id the user actually tapped on Home -- this never lets the
// user land on a different topic than the one they opened, even if the
// level/date changed in the meantime (e.g. from another tab or a midnight
// rollover while this screen was open).
//
// Navigation: explicit ホーム / 過去のトピック destinations (never router.back(), so a cold deep link has
// both too) and a 初級/中級/上級 selector that only changes what this open screen shows -- it resolves the
// SAME jstDate through the same read-only fetch, keeps loaded levels in an in-memory cache, and never
// writes the Settings level that drives Home.
//
// Layout (the "かぶモリ学習ノート" direction): destinations -> notebook label -> level selector -> level-aware Hero (badge,
// category, large title, the fetched summary, level artwork on the right) -> numbered steps 1-3 -> a
// tinted 具体例 card -> a calm 覚えておくポイント block. All text is native; the learning content is the
// static curated catalog (src/lib/topic-detail-catalog.ts): rendering makes no network, AI or database
// call of its own.
export default function TopicDetailScreen() {
  const params = useLocalSearchParams<{ id?: string; level?: string; jstDate?: string }>();
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<Status>('loading');
  const [topic, setTopic] = useState<HomeTopic | null>(null);
  const [pendingLevel, setPendingLevel] = useState<TopicLevel | null>(null);
  const [switchError, setSwitchError] = useState<TopicLevel | null>(null);
  // Loaded topics by date+level for this open screen only (never persisted, never shared with Home).
  const cache = useRef(createTopicViewCache()).current;
  // A newer tap supersedes an older in-flight switch; a late result of the older one is dropped.
  const switchSeq = useRef(0);

  useEffect(() => {
    let active = true;
    const level = params.level;
    const jstDate = params.jstDate;
    const id = params.id;
    if (!isTopicLevel(level) || !jstDate || !id) {
      setTopic(null);
      setStatus('mismatch');
      return;
    }
    // A topic this screen already loaded for exactly these params (e.g. right after an in-screen switch
    // updated the route) is shown as is: no second request for the same (level, jstDate).
    const cached = cache.get(jstDate, level);
    if (cached && cached.id === id) {
      setTopic(cached);
      setStatus('ok');
      return;
    }
    // New params (e.g. this screen reused by a deep link): never keep showing the previous topic.
    setTopic(null);
    setStatus('loading');
    fetchDailyTopic(level, jstDate)
      .then((result) => {
        if (!active) return;
        if (!result || result.id !== id) {
          setStatus('mismatch');
          return;
        }
        cache.set(jstDate, result);
        setTopic(result);
        setStatus('ok');
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [params.id, params.level, params.jstDate, cache]);

  const viewDate = typeof params.jstDate === 'string' ? params.jstDate : '';

  // In-screen level switch: the target is the deterministic topic of the SAME date. On success the exact
  // returned topic is shown and the route params become its real id/level/jstDate; on failure the current
  // content stays and only a small message appears next to the selector.
  const switchLevel = useCallback(
    (target: TopicLevel) => {
      if (!topic || !viewDate) return;
      if (decideLevelSwitch(topic.level, target) === 'noop') {
        // The shown level was tapped: nothing to load. It only drops a pending switch to another level.
        switchSeq.current += 1;
        setPendingLevel(null);
        setSwitchError(null);
        return;
      }
      if (pendingLevel === target) return;
      const seq = (switchSeq.current += 1);
      setSwitchError(null);
      const show = (next: HomeTopic) => {
        setTopic(next);
        setStatus('ok');
        setPendingLevel(null);
        router.setParams(topicDetailRouteParams(next, viewDate));
      };
      const cached = cache.get(viewDate, target);
      if (cached) {
        show(cached);
        return;
      }
      setPendingLevel(target);
      void resolveTopicForLevel({ level: target, jstDate: viewDate, cache, fetchTopic: fetchDailyTopic }).then((result) => {
        if (seq !== switchSeq.current) return;
        if (result.ok) {
          show(result.topic);
        } else {
          setPendingLevel(null);
          setSwitchError(target);
        }
      });
    },
    [cache, pendingLevel, topic, viewDate],
  );

  const detail = topic ? topicDetailFor(topic.title) : null;
  const colors = topic ? TOPIC_DETAIL_LEVEL_COLORS[topic.level] : null;
  const heroWidth = Math.max(0, Math.min(windowWidth, 720) - SCREEN_PADDING * 2);
  const artHeight = heroWidth / TOPIC_DETAIL_ART_ASPECT;
  const titleStyle = topic ? topicDetailTitleStyle(topic.title) : null;
  // A long title starts below the illustration (badge row = 20 padding + ~33 badge).
  const titleTop = titleStyle?.belowArt ? Math.max(14, artHeight * TOPIC_DETAIL_ART_CLEAR_RATIO - 53) : 14;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView contentContainerStyle={[styles.container, { paddingBottom: 60 + insets.bottom }]}>
        <View style={styles.navRow}>
          <Pressable
            onPress={() => goHome(router)}
            accessibilityRole="button"
            accessibilityLabel="ホームへ"
            hitSlop={8}
            style={styles.navButton}>
            <Text style={styles.navText}>‹ ホーム</Text>
          </Pressable>
          <Pressable
            onPress={() => goPastTopics(router)}
            accessibilityRole="button"
            accessibilityLabel="過去のトピックへ"
            hitSlop={8}
            style={styles.navButton}>
            <Text style={styles.navText}>過去のトピック ›</Text>
          </Pressable>
        </View>

        {status === 'loading' ? (
          <ActivityIndicator color={palette.accent} style={styles.status} />
        ) : status === 'error' ? (
          <Text style={styles.message}>今日のトピックを取得できませんでした。もう一度お試しください。</Text>
        ) : status === 'mismatch' ? (
          <Text style={styles.message}>この内容は表示できません。Homeに戻ってもう一度開き直してください。</Text>
        ) : topic && colors ? (
          <>
            {/* Notebook label */}
            <View style={styles.labelRow} accessible accessibilityRole="header" accessibilityLabel="かぶモリ学習ノート">
              <Text style={styles.labelIcon}>🌱</Text>
              <Text style={[styles.labelText, { color: colors.strong }]}>かぶモリ学習ノート</Text>
              {viewDate ? <Text style={styles.labelDate}>{formatTopicDate(viewDate)}</Text> : null}
            </View>

            {/* Level selector: the same date, another level. Viewing only -- Home's saved level is never written. */}
            <View style={[styles.switcher, { backgroundColor: colors.soft, borderColor: colors.outline }]}>
              {TOPIC_SWITCH_LEVELS.map(({ level, label }) => {
                const selected = topic.level === level;
                const levelColors = TOPIC_DETAIL_LEVEL_COLORS[level];
                return (
                  <Pressable
                    key={level}
                    onPress={() => switchLevel(level)}
                    accessibilityRole="button"
                    accessibilityLabel={`${label}のトピック`}
                    accessibilityState={{ selected, busy: pendingLevel === level }}
                    accessibilityHint="同じ日の別のレベルに切り替えます。Homeの設定は変わりません。"
                    style={[styles.switchSegment, selected && { backgroundColor: levelColors.strong }]}>
                    {pendingLevel === level ? (
                      <ActivityIndicator size="small" color={levelColors.strong} />
                    ) : (
                      <Text style={[styles.switchText, { color: selected ? '#ffffff' : levelColors.strong }]}>{label}</Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
            {switchError ? (
              <Text style={styles.switchError} accessibilityLiveRegion="polite">
                {topicSwitchErrorMessage(switchError)}
              </Text>
            ) : null}

            {/* Hero: level badge | category, large title, the short summary (the same base_text as Home) */}
            <View style={[styles.hero, { backgroundColor: colors.hero, minHeight: artHeight }]}>
              <View style={[styles.artBox, { height: artHeight }]} pointerEvents="none">
                <Image source={HERO_ART[topic.level]} style={StyleSheet.absoluteFill} contentFit="cover" accessible={false} />
                <View style={styles.washRow}>
                  {Array.from({ length: WASH_STRIPS }, (_, index) => (
                    <View
                      key={index}
                      style={{
                        flex: 1,
                        backgroundColor: colors.hero,
                        opacity:
                          index < WASH_SOLID_STRIPS
                            ? 0.94
                            : index >= WASH_CLEAR_FROM
                              ? 0
                              : 0.94 * (1 - (index - WASH_SOLID_STRIPS + 1) / (WASH_CLEAR_FROM - WASH_SOLID_STRIPS + 1)),
                      }}
                    />
                  ))}
                </View>
                {Array.from({ length: FADE_STRIPS }, (_, index) => (
                  <View
                    key={index}
                    style={[
                      styles.fadeStrip,
                      {
                        backgroundColor: colors.hero,
                        bottom: (FADE_STRIPS - 1 - index) * FADE_STRIP_HEIGHT,
                        opacity: Math.min(1, (index + 1) / (FADE_STRIPS - 3)),
                      },
                    ]}
                  />
                ))}
              </View>

              <View style={styles.heroContent}>
                <View style={styles.badgeRow}>
                  <View style={[styles.levelBadge, { backgroundColor: colors.badge }]}>
                    <Text style={[styles.levelText, { color: colors.strong }]}>{TOPIC_LEVEL_LABEL[topic.level]}</Text>
                  </View>
                  {topic.category ? (
                    <>
                      <View style={[styles.badgeDivider, { backgroundColor: colors.outline }]} />
                      <Text style={styles.category}>{topic.category}</Text>
                    </>
                  ) : null}
                </View>
                <Text
                  style={[
                    styles.title,
                    titleStyle ? { fontSize: titleStyle.fontSize, lineHeight: titleStyle.lineHeight } : null,
                    { marginTop: titleTop },
                  ]}>
                  {topic.title}
                </Text>
                <Text style={styles.summary}>{topic.body}</Text>
              </View>
            </View>

            {detail ? (
              <View style={styles.sections}>
                {detail.sections.map((section) => (
                  <DetailSection key={section.role} section={section} level={topic.level} />
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

function DetailSection({ section, level }: { section: TopicDetailSection; level: TopicLevel }) {
  const colors = TOPIC_DETAIL_LEVEL_COLORS[level];

  // 具体例: a pale level-tinted outlined card with a small bulb; always its own block.
  if (section.role === 'example') {
    return (
      <View style={[styles.exampleCard, { backgroundColor: colors.soft, borderColor: colors.outline }]}>
        <View style={styles.exampleHead}>
          <View style={[styles.exampleMark, { backgroundColor: colors.badge }]}>
            <Text style={[styles.exampleMarkText, { color: colors.strong }]}>例</Text>
          </View>
          <Text style={[styles.blockHeading, { color: colors.strong }]}>{section.heading}</Text>
        </View>
        <Text style={styles.body}>{section.body}</Text>
      </View>
    );
  }

  // 覚えておくポイント: the end of the lesson, a calm tinted block with a strong left accent line.
  if (section.role === 'takeaway') {
    return (
      <View style={[styles.takeaway, { backgroundColor: colors.badge }]}>
        <View style={[styles.takeawayBar, { backgroundColor: colors.strong }]} />
        <Text style={[styles.blockHeading, { color: colors.strong }]}>{section.heading}</Text>
        <Text style={styles.takeawayBody}>{section.body}</Text>
      </View>
    );
  }

  // Numbered steps 1-3. A trailing 「ただし…」 sentence that already exists in the text is shown as an
  // inset band with a left accent bar; nothing is added or rewritten.
  const number = topicDetailStepNumber(section.role);
  const { lead, caution } = splitTrailingCaution(section.body);
  return (
    <View style={styles.step}>
      <View style={styles.stepHead}>
        <View style={[styles.stepCircle, { backgroundColor: colors.badge }]}>
          <Text style={[styles.stepNumber, { color: colors.strong }]}>{number}</Text>
        </View>
        <Text style={[styles.stepHeading, { color: colors.strong }]}>{section.heading}</Text>
      </View>
      <View style={styles.stepBody}>
        <Text style={styles.body}>{lead}</Text>
        {caution ? (
          <View style={[styles.cautionBand, { backgroundColor: colors.soft }]}>
            <View style={[styles.cautionBar, { backgroundColor: colors.strong }]} />
            <Text style={styles.cautionText}>{caution}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: PAGE_BACKGROUND },
  container: { paddingHorizontal: SCREEN_PADDING, paddingTop: 8 },
  status: { marginTop: 40 },
  message: { color: palette.muted, fontSize: 15, lineHeight: 23, marginTop: 24 },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navButton: { minHeight: 44, justifyContent: 'center' },
  navText: { color: palette.accent, fontWeight: '800', fontSize: 15 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  labelIcon: { fontSize: 18 },
  labelText: { fontSize: 16, fontWeight: '900', letterSpacing: 0.4 },
  labelDate: { marginLeft: 'auto', color: palette.muted, fontSize: 13, fontWeight: '700' },
  switcher: { marginTop: 12, flexDirection: 'row', borderRadius: 14, borderWidth: 1, padding: 3, gap: 3 },
  switchSegment: { flex: 1, minHeight: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  switchText: { fontSize: 15, fontWeight: '900' },
  switchError: { color: '#9a3a2c', fontSize: 13, lineHeight: 19, marginTop: 8 },
  hero: { marginTop: 14, borderRadius: 22, overflow: 'hidden' },
  artBox: { position: 'absolute', top: 0, left: 0, right: 0 },
  washRow: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row' },
  fadeStrip: { position: 'absolute', left: 0, right: 0, height: FADE_STRIP_HEIGHT },
  heroContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 22 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  levelBadge: { borderRadius: 99, paddingHorizontal: 14, paddingVertical: 7 },
  levelText: { fontSize: 13, fontWeight: '900' },
  badgeDivider: { width: 1.5, height: 18, borderRadius: 1 },
  category: { color: palette.muted, fontSize: 14, fontWeight: '700' },
  title: { color: '#17251d', fontSize: 34, lineHeight: 42, fontWeight: '900', marginTop: 14 },
  summary: { color: INK, fontSize: 15.5, lineHeight: 25, fontWeight: '500', marginTop: 12 },
  sections: { marginTop: 28, gap: 28 },
  step: { gap: 12 },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepCircle: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  stepNumber: { fontSize: 18, fontWeight: '900' },
  stepHeading: { flex: 1, fontSize: 21, lineHeight: 28, fontWeight: '900' },
  // Body copy is indented to line up under the heading text (circle 38 + gap 12).
  stepBody: { paddingLeft: 50, gap: 14 },
  body: { color: INK, fontSize: 15.5, lineHeight: 25 },
  cautionBand: { borderRadius: 12, paddingLeft: 20, paddingRight: 14, paddingVertical: 12, overflow: 'hidden' },
  // A straight accent bar inset from the band's rounded corners (not a curved border).
  cautionBar: { position: 'absolute', left: 8, top: 10, bottom: 10, width: 4, borderRadius: 2 },
  cautionText: { color: '#17251d', fontSize: 14.5, lineHeight: 23, fontWeight: '800' },
  exampleCard: { borderRadius: 18, borderWidth: 1, padding: 18, gap: 12 },
  exampleHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  exampleMark: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  exampleMarkText: { fontSize: 17, fontWeight: '900' },
  blockHeading: { fontSize: 21, lineHeight: 28, fontWeight: '900' },
  takeaway: { borderRadius: 18, paddingVertical: 18, paddingLeft: 32, paddingRight: 18, gap: 8, overflow: 'hidden' },
  // A straight accent line inset from the block's rounded corners.
  takeawayBar: { position: 'absolute', left: 14, top: 16, bottom: 16, width: 5, borderRadius: 3 },
  takeawayBody: { color: '#17251d', fontSize: 15.5, lineHeight: 25, fontWeight: '700' },
  note: { color: palette.muted, fontSize: 13, lineHeight: 20 },
});
