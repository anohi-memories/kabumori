import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { reportTypeLabel, type PersonalizedReport } from '@/lib/report-presentation';
import { CharacterSlot } from '@/components/home/character-slot';

type ReportHighlightCardProps = {
  palette: KabumoriPalette;
  report: PersonalizedReport | null;
  points: string[];
  loading: boolean;
  onOpen: () => void;
};

// The primary home card. Point rows have no per-row chevron/tap target --
// detail navigation is a single CTA at the bottom of the card, per the
// approved design ("各ポイントは個別遷移ではない").
export function ReportHighlightCard({ palette, report, points, loading, onOpen }: ReportHighlightCardProps) {
  const hasReport = !!report;

  return (
    <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <View style={styles.headRow}>
        <View style={styles.headText}>
          <Text style={[styles.eyebrow, { color: palette.accent }]}>TODAY&apos;S REPORT</Text>
          <Text style={[styles.title, { color: palette.text }]}>今日の かぶモリレポート</Text>
          <Text style={[styles.description, { color: palette.muted }]}>
            今日の市場とあなたの保有銘柄への影響をAIが整理しました。
          </Text>
        </View>
        <CharacterSlot palette={palette} />
      </View>

      {loading && !hasReport ? (
        <Text style={[styles.emptyText, { color: palette.muted }]}>読み込み中です…</Text>
      ) : hasReport ? (
        <>
          <Text style={[styles.reportMeta, { color: palette.muted }]}>
            {reportTypeLabel(report.report_type)}
            {report.title_ja ? ` ・ ${report.title_ja}` : ''}
          </Text>
          <View style={styles.points}>
            {points.map((point, index) => (
              <View key={index} style={styles.pointRow}>
                <View style={[styles.pointDot, { backgroundColor: palette.accent }]} />
                <Text style={[styles.pointText, { color: palette.text }]} numberOfLines={2}>
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
  card: { borderRadius: 20, borderWidth: 1, padding: 18 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headText: { flex: 1 },
  eyebrow: { fontWeight: '900', letterSpacing: 1.4, fontSize: 11 },
  title: { fontSize: 20, fontWeight: '900', marginTop: 4 },
  description: { fontSize: 13, lineHeight: 19, marginTop: 6 },
  reportMeta: { fontSize: 12, fontWeight: '800', marginTop: 14 },
  points: { marginTop: 10, gap: 9 },
  pointRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  pointDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  pointText: { flex: 1, fontSize: 14, lineHeight: 20, fontWeight: '700' },
  emptyText: { fontSize: 13, lineHeight: 19, marginTop: 14 },
  cta: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 16 },
  ctaText: { fontSize: 14, fontWeight: '900' },
  pressed: { opacity: 0.85 },
});
