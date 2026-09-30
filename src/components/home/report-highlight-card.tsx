import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { reportTypeLabel, type PersonalizedReport } from '@/lib/report-presentation';
import { reportCardStatus } from '@/lib/home-report-highlights';
import { CharacterSlot } from '@/components/home/character-slot';

// Phase 1: one fixed approved neutral artwork, shown for every report/loading/empty
// state. Phase 2 (after visual approval) replaces this constant with a selected source.
const FIXED_REPORT_CHARACTER_SOURCE = require('@/assets/images/report-states/report_04_neutral.webp');

type ReportHighlightCardProps = {
  palette: KabumoriPalette;
  report: PersonalizedReport | null;
  points: string[];
  loading: boolean;
  error: string;
  onOpen: () => void;
  onRetry: () => void;
};

// The primary home card. Point rows have no per-row chevron/tap target --
// detail navigation is a single CTA at the bottom of the card, per the
// approved design ("各ポイントは個別遷移ではない").
export function ReportHighlightCard({ palette, report, points, loading, error, onOpen, onRetry }: ReportHighlightCardProps) {
  const hasReport = !!report;
  const status = reportCardStatus(hasReport, loading, error);

  return (
    <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <View style={styles.headText}>
        <Text style={[styles.eyebrow, { color: palette.accent }]}>TODAY&apos;S REPORT</Text>
        <Text
          style={[styles.title, { color: palette.text }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.85}>
          今日の かぶモリレポート
        </Text>
      </View>

      {/* Body: text column on the left, the character on the right third-plus of the card,
          bottom-aligned with the text block (approved layout: 理想の1枚目). */}
      <View style={styles.bodyRow}>
        <View style={styles.bodyText}>
          <Text style={[styles.description, { color: palette.muted }]}>
            今日の市場とあなたの保有銘柄への影響をAIが整理しました。
          </Text>

          {status === 'loading' ? (
            <Text style={[styles.emptyText, { color: palette.muted }]}>読み込み中です…</Text>
          ) : status === 'error' ? (
            <View style={[styles.errorCard, { backgroundColor: palette.error }]}>
              <Text style={[styles.errorText, { color: palette.muted }]}>{error}</Text>
              <Pressable onPress={onRetry} style={[styles.retryButton, { backgroundColor: palette.accent }]} accessibilityRole="button" accessibilityLabel="もう一度読み込む">
                <Text style={styles.retryText}>もう一度試す</Text>
              </Pressable>
            </View>
          ) : status === 'report' && report ? (
            <>
              <Text style={[styles.reportMeta, { color: palette.muted }]}>
                {reportTypeLabel(report.report_type)}
                {report.title_ja ? ` ・ ${report.title_ja}` : ''}
              </Text>
              <View style={styles.points}>
                {points.map((point, index) => (
                  <View key={index} style={styles.pointRow}>
                    <View style={[styles.pointDot, { backgroundColor: palette.accent }]} />
                    <Text style={[styles.pointText, { color: palette.text }]} numberOfLines={3}>
                      {point}
                    </Text>
                  </View>
                ))}
              </View>
            </>
          ) : (
            <Text style={[styles.emptyText, { color: palette.muted }]}>
              今日のレポートはまだありません。生成され次第ここに表示されます。
            </Text>
          )}
        </View>
        <CharacterSlot palette={palette} source={FIXED_REPORT_CHARACTER_SOURCE} />
      </View>

      <Pressable
        onPress={onOpen}
        disabled={!hasReport}
        style={({ pressed }) => [
          styles.cta,
          { backgroundColor: hasReport ? palette.accent : palette.soft },
          pressed && hasReport && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="レポートを見る"
        accessibilityState={{ disabled: !hasReport }}>
        <Text style={[styles.ctaText, { color: hasReport ? '#fff' : palette.muted }]}>レポートを見る →</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, borderWidth: 1, padding: 14 },
  headText: {},
  // flex-end: the character sits on the bottom edge of the text block.
  bodyRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  bodyText: { flex: 1, minWidth: 0 },
  eyebrow: { fontWeight: '900', letterSpacing: 1.4, fontSize: 11 },
  title: { fontSize: 18, fontWeight: '900', marginTop: 3 },
  description: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  reportMeta: { fontSize: 11, fontWeight: '800', marginTop: 10 },
  points: { marginTop: 8, gap: 6 },
  pointRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  pointDot: { width: 6, height: 6, borderRadius: 3, marginTop: 6 },
  pointText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '700' },
  emptyText: { fontSize: 13, lineHeight: 19, marginTop: 10 },
  errorCard: { borderRadius: 12, padding: 12, marginTop: 10 },
  errorText: { fontSize: 13, lineHeight: 19 },
  retryButton: { alignSelf: 'flex-start', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
  retryText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  cta: { borderRadius: 12, paddingVertical: 10, alignItems: 'center', marginTop: 12 },
  ctaText: { fontSize: 13, fontWeight: '900' },
  pressed: { opacity: 0.85 },
});
