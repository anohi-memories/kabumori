import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image, type ImageSource } from 'expo-image';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { HERO, HOME_COLORS, HOME_LAYOUT } from '@/constants/home-tokens';
import type { PersonalizedReport } from '@/lib/report-presentation';
import { reportCardStatus } from '@/lib/home-report-highlights';
import { heroArtHeight, heroIsExtended, heroPointsTop, heroWidth, HERO_ART_ASPECT } from '@/lib/home-hero-geometry';
import { selectReportCharacterState, type ReportCharacterState } from '@/lib/report-character-state';
import { CharacterSlot } from '@/components/home/character-slot';

// The Hero background art (1586x992, lossless). The title 「今日の かぶモリレポート」, the description
// and the 「今日のポイント」 label are part of this picture, so none of them are drawn as Text here (no
// double display). It is laid on the art box at its own aspect ratio, never cropped or stretched.
export const HERO_BACKGROUND_SOURCE: ImageSource = require('@/assets/images/home/report_hero_background.webp');

// Character layer: one of eight approved full-canvas images (1586x992, plus the 03 canvas at 1536x960),
// chosen deterministically from the stored report by selectReportCharacterState (no network, no AI).
// Static requires, because Metro resolves assets at build time. No report (loading / empty / error)
// shows 03 neutral. Every state follows the same full-canvas rule: no per-state offsets or scales.
const CHARACTER_SOURCES: Record<ReportCharacterState, ImageSource> = {
  very_positive: require('@/assets/images/report-states/report_01_very_positive.webp'),
  positive: require('@/assets/images/report-states/report_02_positive.webp'),
  neutral: require('@/assets/images/report-states/report_03_neutral.webp'),
  uncertain: require('@/assets/images/report-states/report_04_uncertain.webp'),
  caution: require('@/assets/images/report-states/report_05_caution.webp'),
  negative: require('@/assets/images/report-states/report_06_negative.webp'),
  very_negative: require('@/assets/images/report-states/report_07_very_negative.webp'),
  volatile: require('@/assets/images/report-states/report_08_volatile.webp'),
};

// Short report-type label shown after the baked-in 「今日のポイント」 label.
const REPORT_KIND_LABEL: Record<PersonalizedReport['report_type'], string> = { morning: '朝刊', close: '大引け' };

// Readable summary of the baked-in art for VoiceOver (the picture itself carries the words).
const HERO_ART_LABEL = '今日のかぶモリレポート。今日の市場とあなたの保有銘柄への影響をAIが整理しました。今日のポイント';

type HomeReportHeroProps = {
  palette: KabumoriPalette;
  report: PersonalizedReport | null;
  points: string[];
  loading: boolean;
  error: string;
  onOpen: () => void;
  onRetry: () => void;
};

// The Home hero: one designed block. Layers, back to front:
//   1. background art -> 2. character (same 1:1 box, one of 8 states) -> 3. live UI (report kind, 1-3 points)
//   -> 4. CTA (opaque, so it covers the character's lower body where they overlap).
// Individual points are NOT navigation targets -- the single CTA is the only way into the report.
export function HomeReportHero({ palette, report, points, loading, error, onOpen, onRetry }: HomeReportHeroProps) {
  const { width: windowWidth } = useWindowDimensions();
  const [heroHeight, setHeroHeight] = useState(0);
  const hasReport = !!report;
  const status = reportCardStatus(hasReport, loading, error);
  // Only the points that exist: 1-3, never an empty placeholder row.
  const shownPoints = points.filter((point) => point.trim().length > 0).slice(0, HERO.maxPoints);

  const width = heroWidth(windowWidth, HOME_LAYOUT.gutter);
  const artHeight = heroArtHeight(width);
  const extended = heroIsExtended(heroHeight, artHeight);
  // The report on screen decides the expression; no report -> 03 neutral. Pure, no network/AI.
  const characterState = selectReportCharacterState(report);

  return (
    <View
      style={[styles.hero, { minHeight: artHeight }]}
      onLayout={(event) => setHeroHeight(event.nativeEvent.layout.height)}>
      {/* Layers 1-2 live in one box that has the art's aspect ratio, so the character is stacked 1:1. */}
      <View style={[styles.artBox, { aspectRatio: HERO_ART_ASPECT }]}>
        <Image
          source={HERO_BACKGROUND_SOURCE}
          style={StyleSheet.absoluteFill}
          contentFit="fill"
          accessible
          accessibilityRole="header"
          accessibilityLabel={HERO_ART_LABEL}
        />
        <CharacterSlot source={CHARACTER_SOURCES[characterState]} style={styles.characterLift} />
        {/* Taller than the art: fade the art + character's bottom into the fill colour (see HERO.fade*). */}
        {extended
          ? Array.from({ length: HERO.fadeStrips }, (_, index) => {
              const fromBottom = HERO.fadeStrips - 1 - index;
              const rampStrips = HERO.fadeStrips - HERO.fadeSolidStrips;
              return (
                <View
                  key={index}
                  pointerEvents="none"
                  style={[
                    styles.fadeStrip,
                    {
                      bottom: fromBottom * HERO.fadeStripHeight,
                      // Strips never overlap, so opacity ramps smoothly 0 -> 1 with no banding.
                      opacity: Math.min(1, (index + 1) / rampStrips),
                    },
                  ]}
                />
              );
            })
          : null}
        {status === 'report' && report ? (
          <Text style={[styles.reportKind, { color: palette.muted }]} numberOfLines={1}>
            {REPORT_KIND_LABEL[report.report_type] ?? ''}
          </Text>
        ) : null}
      </View>

      {/* Layer 3-4: live UI in normal flow, drawn over the art and the character */}
      <View style={[styles.content, { paddingTop: heroPointsTop(artHeight) }]}>
        <View style={styles.pointsColumn}>
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
        </View>

        {/* Keeps the CTA on the Hero's bottom edge when there is less content than the art needs */}
        <View style={styles.spacer} />

        {/* CTA: the only navigation into the report; opaque and last, so it sits in front of the character */}
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
    borderRadius: HERO.radius,
    backgroundColor: HERO.fillColor,
    overflow: 'hidden',
  },
  // The whole character canvas moves up by one global amount (same for every state), together with the CTA.
  characterLift: { top: -HERO.characterLift, bottom: HERO.characterLift },
  // Art + character share this box (absolute, top-left, full width, art aspect ratio).
  artBox: { position: 'absolute', top: 0, left: 0, right: 0 },
  fadeStrip: { position: 'absolute', left: 0, right: 0, height: HERO.fadeStripHeight, backgroundColor: HERO.fillColor },
  // Report kind (朝刊 / 大引け) sits right after the baked-in 「今日のポイント」 label.
  reportKind: { position: 'absolute', left: HERO.metaLeft, top: HERO.metaTop, fontSize: 11, fontWeight: '800' },
  // flexGrow: with the spacer, the CTA stays at the bottom edge of a Hero that is only as tall as the art.
  content: { flexGrow: 1, paddingBottom: HERO.ctaBottomInset },
  pointsColumn: { marginLeft: HERO.pointsLeft, width: HERO.pointsWidth },
  points: { gap: 2 },
  pointRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
    minHeight: 25,
  },
  pointCircle: { width: 15, height: 15, borderRadius: 7.5, alignItems: 'center', justifyContent: 'center' },
  pointNumber: { color: '#fff', fontSize: 10, fontWeight: '900' },
  pointText: { flex: 1, fontSize: 10.5, lineHeight: 12.5, fontWeight: '800' },
  spacer: { flexGrow: 1, minHeight: HERO.ctaGap },
  status: { fontSize: 12, lineHeight: 17 },
  errorCard: { borderRadius: 12, padding: 10 },
  errorText: { fontSize: 12, lineHeight: 17 },
  retryButton: { alignSelf: 'flex-start', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7, marginTop: 8 },
  retryText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  cta: {
    height: HERO.ctaHeight,
    marginHorizontal: HERO.padding,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: { fontSize: 13, fontWeight: '900' },
  pressed: { opacity: 0.85 },
});
