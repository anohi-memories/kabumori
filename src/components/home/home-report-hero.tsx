import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image, type ImageSource } from 'expo-image';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { HERO, HOME_COLORS, HOME_LAYOUT } from '@/constants/home-tokens';
import { reportTypeLabel, type PersonalizedReport } from '@/lib/report-presentation';
import { reportCardStatus } from '@/lib/home-report-highlights';
import { heroArtHeight, heroIsExtended, heroPointsTop, heroWidth, HERO_ART_ASPECT } from '@/lib/home-hero-geometry';
import { CharacterSlot } from '@/components/home/character-slot';

// The Hero background art (1586x992, lossless). The title 「今日の かぶモリレポート」, the description
// and the 「今日のポイント」 label are part of this picture, so none of them are drawn as Text here (no
// double display). It is laid on the art box at its own aspect ratio, never cropped or stretched.
export const HERO_BACKGROUND_SOURCE: ImageSource = require('@/assets/images/home/report_hero_background.webp');

// Character layer, phase 1: the one approved neutral (04) artwork, shown for every state. It was made
// on the same canvas as the background, so it is stacked on the art box 1:1. Phase 2 (after visual
// approval) replaces this single constant with a selected source; no layout change is needed then.
const FIXED_REPORT_CHARACTER_SOURCE = require('@/assets/images/report-states/report_04_neutral.webp');

// Readable summary of the baked-in art for VoiceOver (the picture itself carries the words).
const HERO_ART_LABEL = '今日のかぶモリレポート。今日の市場とあなたの保有銘柄への影響をAIが整理しました。今日のポイント';

// Fade steps that blend the bottom edge of the art into the fill colour when the live points make
// the Hero taller than the art (see heroIsExtended).
const FADE_STEPS = 12;
const FADE_STEP_HEIGHT = 2.5;

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
//   1. background art -> 2. character (same 1:1 box) -> 3. live UI (report kind, 1-3 points)
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
        {extended
          ? Array.from({ length: FADE_STEPS }, (_, index) => (
              <View
                key={index}
                pointerEvents="none"
                style={[
                  styles.fadeStrip,
                  { bottom: (FADE_STEPS - 1 - index) * FADE_STEP_HEIGHT, opacity: (index + 1) / FADE_STEPS },
                ]}
              />
            ))
          : null}
        <CharacterSlot source={FIXED_REPORT_CHARACTER_SOURCE} style={StyleSheet.absoluteFill} />
        {status === 'report' && report ? (
          <Text style={[styles.reportKind, { color: palette.muted }]} numberOfLines={1}>
            {reportTypeLabel(report.report_type)}
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
  // Art + character share this box (absolute, top-left, full width, art aspect ratio).
  artBox: { position: 'absolute', top: 0, left: 0, right: 0 },
  fadeStrip: { position: 'absolute', left: 0, right: 0, height: FADE_STEP_HEIGHT + 0.5, backgroundColor: HERO.fillColor },
  // Report kind (朝刊 / 大引け) sits right after the baked-in 「今日のポイント」 label.
  reportKind: { position: 'absolute', left: HERO.metaLeft, top: HERO.metaTop, fontSize: 11, fontWeight: '800' },
  // flexGrow: with the spacer, the CTA stays at the bottom edge of a Hero that is only as tall as the art.
  content: { flexGrow: 1, paddingBottom: HERO.padding },
  pointsColumn: { marginLeft: HERO.pointsLeft, width: HERO.pointsWidth },
  points: { gap: 3 },
  pointRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 2,
    minHeight: 26,
  },
  pointCircle: { width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  pointNumber: { color: '#fff', fontSize: 10, fontWeight: '900' },
  pointText: { flex: 1, fontSize: 10.5, lineHeight: 13, fontWeight: '800' },
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
