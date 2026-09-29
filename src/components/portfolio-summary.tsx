import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { fetchRecentReports } from '@/lib/personalized-reports';
import {
  direction,
  formatSignedYen,
  formatYen,
  latestCloseReport,
  portfolioBasisLabel,
  type PersonalizedReport,
} from '@/lib/report-presentation';

const colors = KABUMORI_COLORS.light;
const DIRECTION_COLOR = { up: '#b2332b', down: '#2a5fa8', flat: colors.muted, none: colors.muted } as const;

// Valuation summary shown above the editable holdings list on the 銘柄 screen's
// ポートフォリオ tab (formerly the standalone ポートフォリオ screen). It only
// reads the latest saved close report -- no live prices -- and renders nothing
// at all when there is no report snapshot yet or the read fails, so it never
// blocks or replaces the holdings list underneath it.
export function PortfolioSummary() {
  const [report, setReport] = useState<PersonalizedReport | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      fetchRecentReports(20)
        .then((reports) => {
          if (active) setReport(latestCloseReport(reports));
        })
        .catch(() => {
          if (active) setReport(null);
        });
      return () => {
        active = false;
      };
    }, []),
  );

  const snapshot = report?.portfolio_snapshot ?? null;
  if (!report || !snapshot) return null;
  const totals = snapshot.totals;
  const basis = portfolioBasisLabel(report);

  return (
    <View style={styles.wrap}>
      <View style={styles.basisRow}>
        <Text style={styles.basisLabel}>{basis}</Text>
        <Text style={styles.basisNote}>最新の保存済み大引けレポート</Text>
      </View>

      <View style={styles.metricsCard}>
        <Metric label="保有銘柄" value={`${totals.holding_count}銘柄`} />
        <Metric label="評価額" value={formatYen(totals.market_value)} />
        <Metric label="今日の損益" value={formatSignedYen(totals.day_pl)} directionValue={totals.day_pl} />
        <Metric label="含み損益" value={formatSignedYen(totals.unrealized_pl)} directionValue={totals.unrealized_pl} />
      </View>
      <Text style={styles.disclaimer}>上記は{basis}のデータです。リアルタイム価格ではありません。</Text>

      {snapshot.sector_weights.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>業種バランス</Text>
          {snapshot.sector_weights.map((entry) => (
            <View key={entry.sector} style={styles.weightRow}>
              <Text style={styles.weightLabel}>{entry.sector}</Text>
              <View style={styles.weightTrack}>
                <View style={[styles.weightBar, { width: `${Math.min(100, Math.max(2, entry.weight_percent))}%` }]} />
              </View>
              <Text style={styles.weightValue}>{entry.weight_percent}%</Text>
            </View>
          ))}
          <Text style={styles.footnote}>{snapshot.sector_weights[0].basis === 'market_value' ? '評価額ベース' : '銘柄数ベース'}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Metric({ label, value, directionValue }: { label: string; value: string; directionValue?: number | null }) {
  const tone = direction(directionValue ?? null);
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, directionValue !== undefined && { color: DIRECTION_COLOR[tone] }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, marginBottom: 14 },
  basisRow: { marginTop: 2 },
  basisLabel: { color: colors.text, fontSize: 16, fontWeight: '900' },
  basisNote: { color: colors.muted, fontSize: 12, marginTop: 3 },
  metricsCard: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 8 },
  metric: { width: '50%', padding: 9 },
  metricLabel: { color: colors.muted, fontSize: 12 },
  metricValue: { color: colors.text, fontSize: 18, fontWeight: '900', marginTop: 3 },
  disclaimer: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  section: { marginTop: 4 },
  sectionTitle: { color: colors.accent, fontSize: 14, fontWeight: '900', letterSpacing: 0.6 },
  weightRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 9 },
  weightLabel: { width: 92, color: colors.text, fontSize: 12, fontWeight: '700' },
  weightTrack: { flex: 1, height: 8, backgroundColor: colors.border, borderRadius: 4, overflow: 'hidden' },
  weightBar: { height: 8, backgroundColor: colors.accent, borderRadius: 4 },
  weightValue: { width: 48, color: colors.muted, textAlign: 'right', fontSize: 12 },
  footnote: { color: colors.muted, fontSize: 11, marginTop: 7 },
});
