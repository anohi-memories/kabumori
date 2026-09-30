import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image, type ImageSource } from 'expo-image';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { HERO, HOME_COLORS, HOME_LAYOUT } from '@/constants/home-tokens';
import { reportTypeLabel, type PersonalizedReport } from '@/lib/report-presentation';
import { reportCardStatus } from '@/lib/home-report-highlights';
import { CharacterSlot } from '@/components/home/character-slot';

// Asset slot: Hero background art (no text or character baked in). Set to
//   require('@/assets/images/home/report_hero_background.webp')
// when the file exists (NOT required while missing). It fills the Hero with contentFit="cover"
// behind every other layer, so adding it needs no layout change; until then the Hero is the plain
// pale-mint block below.
export const HERO_BACKGROUND_SOURCE: ImageSource | null = null;

// Character layer, phase 1: the one approved neutral (04) artwork, shown for every state. Phase 2
// (after visual approval) replaces this single constant with a selected source; the layer is
// independent of the rest of the Hero, so no layout change is needed then.
const FIXED_REPORT_CHARACTER_SOURCE = require('@/assets/images/report-states/report_04_neutral.webp');

type HomeReportHeroProps = {
  palette: KabumoriPalette;
  report: PersonalizedReport | null;
  points: string[];
  loading: boolean;
  error: string;
  onOpen: () => void;
  onRetry: () => void;
};

// The Home hero. Layers (back to front): background -> text/points column -> character -> CTA.
// Individual points are NOT navigation targets -- the single CTA is the only way into the report.
export function HomeReportHero({ palette, report, points, loading, error, onOpen, onRetry }: HomeReportHeroProps) {
  const hasReport = !!report;
  const status = reportCardStatus(hasReport, loading, error);
  const shownPoints = points.slice(0, HERO.maxPoints);

  return (
    <View style={styles.hero}>
      {/* BackgroundLayer */}
      {HERO_BACKGROUND_SOURCE ? (
        <Image source={HERO_BACKGROUND_SOURCE} style={StyleSheet.absoluteFill} contentFit="cover" accessible={false} />
      ) : null}

      {/* Top row: TitleBlock on the left, CharacterLayer flush to the top-right (in flow, so the row
          is always as tall as the character even while loading / empty). */}
      <View style={styles.topRow}>
        <View style={styles.titleBlock}>
          <View style={styles.pill}>
            <Text style={styles.pillText}>今日の</Text>
          </View>
          <Text
            style={styles.title}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.75}
            accessibilityRole="header">
            かぶモリレポート
          </Text>
          <Text style={[styles.description, { color: palette.muted }]} numberOfLines={2}>
            今日の市場とあなたの保有銘柄への影響をAIが整理しました。
          </Text>
          {status === 'report' && report ? (
            <View style={styles.pointsPill}>
              <Text style={styles.pointsPillText}>今日のポイント</Text>
              <Text style={[styles.reportKind, { color: palette.muted }]} numberOfLines={1}>
                {reportTypeLabel(report.report_type)}
              </Text>
            </View>
          ) : null}
        </View>

        {/* CharacterLayer: independent of the text layout */}
        <CharacterSlot source={FIXED_REPORT_CHARACTER_SOURCE} style={styles.character} />
      </View>

      <View style={styles.lower}>
        {/* PointsBox: full width, below the character */}
        {status === 'loading' ? (
          <Text style={[styles.status, { color: palette.muted }]}>読み込み中です…</Text>
        ) : status === 'error' ? (
          <View style={[styles.errorCard, { backgroundColor: palette.error }]}>
            <Text style={[styles.errorText, { color: palette.muted }]}>{error}</Text>
            <Pressable
              onPress={onRetry}
              style={[styles.retryButton, { backgroundColor: palette.accent }]}
              accessibilityRole="button"
              accessibilityLabel="もう一度読み込む">
              <Text style={styles.retryText}>もう一度試す</Text>
            </Pressable>
          </View>
        ) : status === 'report' && report ? (
          <View style={styles.points}>
            {shownPoints.map((point, index) => (
              <View key={index} style={styles.pointRow}>
                <View style={[styles.pointCircle, { backgroundColor: HOME_COLORS.point[index] }]}>
                  <Text style={styles.pointNumber}>{index + 1}</Text>
                </View>
                <Text style={[styles.pointText, { color: palette.text }]} numberOfLines={2}>
                  {point}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={[styles.status, { color: palette.muted }]}>
            今日のレポートはまだありません。生成され次第ここに表示されます。
          </Text>
        )}

        {/* CTA: the only navigation into the report */}
        <Pressable
          onPress={onOpen}
          disabled={!hasReport}
          style={({ pressed }) => [
            styles.cta,
            { backgroundColor: hasReport ? HOME_COLORS.deepGreen : palette.soft },
            pressed && hasReport && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="レポートを見る"
          accessibilityState={{ disabled: !hasReport }}>
          <Text style={[styles.ctaText, { color: hasReport ? '#fff' : palette.muted }]}>レポートを見る →</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    borderRadius: HOME_LAYOUT.radius,
    borderWidth: 1,
    borderColor: HOME_COLORS.heroBorder,
    backgroundColor: HOME_COLORS.heroBackground,
    overflow: 'hidden',
  },
  topRow: { flexDirection: 'row', alignItems: 'flex-start' },
  titleBlock: { width: HERO.leftColumnPercent, paddingTop: HERO.padding, paddingLeft: HERO.padding },
  // Flush to the Hero's top-right corner; width is a share of the Hero, height follows the art.
  character: { width: HERO.characterWidthPercent, marginLeft: 'auto' },
  lower: { paddingHorizontal: HERO.padding, paddingBottom: HERO.padding },
  pill: { alignSelf: 'flex-start', backgroundColor: HOME_COLORS.pillGreen, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 2 },
  pillText: { color: '#fff', fontSize: 11, fontWeight: '900' },
  title: { color: HOME_COLORS.brandGreen, fontSize: 23, lineHeight: 29, fontWeight: '900', marginTop: 2 },
  description: { fontSize: 11.5, lineHeight: 16, fontWeight: '600', marginTop: 3 },
  pointsPill: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7 },
  pointsPillText: {
    color: HOME_COLORS.pointsPillText,
    backgroundColor: HOME_COLORS.pointsPillBackground,
    borderRadius: 99,
    paddingHorizontal: 9,
    paddingVertical: 2,
    fontSize: 11,
    fontWeight: '900',
    overflow: 'hidden',
  },
  reportKind: { flexShrink: 1, fontSize: 10, fontWeight: '800' },
  points: { gap: 4 },
  pointRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: HOME_COLORS.pointsBoxBackground,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    minHeight: 36,
  },
  pointCircle: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  pointNumber: { color: '#fff', fontSize: 11, fontWeight: '900' },
  pointText: { flex: 1, fontSize: 12, lineHeight: 16, fontWeight: '800' },
  status: { fontSize: 12, lineHeight: 17, marginTop: 8 },
  errorCard: { borderRadius: 12, padding: 10, marginTop: 8 },
  errorText: { fontSize: 12, lineHeight: 17 },
  retryButton: { alignSelf: 'flex-start', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7, marginTop: 8 },
  retryText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  cta: { height: HERO.ctaHeight, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: HERO.ctaGap },
  ctaText: { fontSize: 14, fontWeight: '900' },
  pressed: { opacity: 0.85 },
});
