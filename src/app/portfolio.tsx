import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { fetchRecentReports } from '@/lib/personalized-reports';
import {
  direction,
  formatPercent,
  formatPrice,
  formatSignedYen,
  formatYen,
  latestCloseReport,
  portfolioBasisLabel,
  positionLabel,
  type PersonalizedReport,
  type ReportStock,
} from '@/lib/report-presentation';

const colors = KABUMORI_COLORS.light;
const DIRECTION_COLOR = { up: '#b2332b', down: '#2a5fa8', flat: colors.muted, none: colors.muted } as const;

export default function PortfolioScreen() {
  const [reports, setReports] = useState<PersonalizedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      setReports(await fetchRecentReports(20));
    } catch {
      setReports([]);
      setError('ポートフォリオを読み込めませんでした。');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const report = latestCloseReport(reports);
  const snapshot = report?.portfolio_snapshot ?? null;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={colors.accent} />}>
        <Text style={styles.eyebrow}>PORTFOLIO</Text>
        <Text style={styles.title}>ポートフォリオ</Text>
        <Text style={styles.description}>保存済みの大引けレポートに含まれる終値から、保有銘柄の状況を確認できます。</Text>

        {loading && !reports.length ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
        {!!error && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={() => void load()} style={styles.retryButton} accessibilityRole="button">
              <Text style={styles.retryText}>もう一度試す</Text>
            </Pressable>
          </View>
        )}

        {!loading && !error && !snapshot ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>まだポートフォリオデータがありません</Text>
            <Text style={styles.emptyText}>大引けレポートが作成されると、保存済みの終値ベースで表示します。現在値は表示していません。</Text>
            <View style={styles.emptyActions}>
              <Pressable onPress={() => router.push('/explore')} style={styles.secondaryButton} accessibilityRole="button">
                <Text style={styles.secondaryButtonText}>銘柄を登録する</Text>
              </Pressable>
              <Pressable onPress={() => router.push('/reports')} style={styles.primaryButton} accessibilityRole="button">
                <Text style={styles.primaryButtonText}>レポートを見る</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {snapshot && report ? <PortfolioContent report={report} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function PortfolioContent({ report }: { report: PersonalizedReport }) {
  const snapshot = report.portfolio_snapshot!;
  const totals = snapshot.totals;
  return (
    <>
      <View style={styles.basisRow}>
        <Text style={styles.basisLabel}>{portfolioBasisLabel(report)}</Text>
        <Text style={styles.basisNote}>最新の保存済み大引けレポート</Text>
      </View>

      <View style={styles.metricsCard}>
        <Metric label="保有銘柄" value={`${totals.holding_count}銘柄`} />
        <Metric label="評価額" value={formatYen(totals.market_value)} />
        <Metric label="今日の損益" value={formatSignedYen(totals.day_pl)} directionValue={totals.day_pl} />
        <Metric label="含み損益" value={formatSignedYen(totals.unrealized_pl)} directionValue={totals.unrealized_pl} />
      </View>
      <Text style={styles.disclaimer}>上記は{portfolioBasisLabel(report)}のデータです。リアルタイム価格ではありません。</Text>

      <Text style={styles.sectionTitle}>保有銘柄</Text>
      {snapshot.holdings.length ? snapshot.holdings.map((stock) => <HoldingCard key={stock.ticker_code} stock={stock} />) : (
        <View style={styles.emptyCard}><Text style={styles.emptyText}>保有銘柄はありません。監視銘柄はポートフォリオ合計に含めていません。</Text></View>
      )}

      {snapshot.sector_weights.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>業種バランス</Text>
          {snapshot.sector_weights.map((entry) => (
            <View key={entry.sector} style={styles.weightRow}>
              <Text style={styles.weightLabel}>{entry.sector}</Text>
              <View style={styles.weightTrack}><View style={[styles.weightBar, { width: `${Math.min(100, Math.max(2, entry.weight_percent))}%` }]} /></View>
              <Text style={styles.weightValue}>{entry.weight_percent}%</Text>
            </View>
          ))}
          <Text style={styles.footnote}>{snapshot.sector_weights[0].basis === 'market_value' ? '評価額ベース' : '銘柄数ベース'}</Text>
        </View>
      ) : null}
    </>
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

function HoldingCard({ stock }: { stock: ReportStock }) {
  const tone = direction(stock.price.changePercent);
  return (
    <View style={styles.holdingCard}>
      <View style={styles.stockHeader}>
        <Text style={styles.stockTicker}>{stock.ticker_code}</Text>
        <Text style={styles.stockPosition}>{positionLabel(stock)}</Text>
      </View>
      <Text style={styles.stockName}>{stock.company_name}</Text>
      <View style={styles.stockGrid}>
        <Value label="数量" value={stock.quantity === null ? '未登録' : `${stock.quantity.toLocaleString()}株`} />
        <Value label="平均取得" value={stock.average_price === null ? '未登録' : formatYen(stock.average_price)} />
        <Value label="保存終値" value={stock.price.status === 'ok' ? formatPrice(stock.price.close) : '—'} />
        <Value label="前日比" value={formatPercent(stock.price.changePercent)} tone={DIRECTION_COLOR[tone]} />
        <Value label="評価額" value={formatYen(stock.market_value)} />
        <Value label="今日の損益" value={formatSignedYen(stock.day_pl)} tone={DIRECTION_COLOR[direction(stock.day_pl)]} />
        <Value label="含み損益" value={formatSignedYen(stock.unrealized_pl)} tone={DIRECTION_COLOR[direction(stock.unrealized_pl)]} />
        <Value label="含み損益率" value={formatPercent(stock.unrealized_pl_percent)} />
      </View>
    </View>
  );
}

function Value({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <View style={styles.value}><Text style={styles.valueLabel}>{label}</Text><Text style={[styles.valueText, tone ? { color: tone } : null]}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  container: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 120, gap: 12 },
  eyebrow: { color: colors.accent, fontWeight: '900', letterSpacing: 2, fontSize: 12 },
  title: { color: colors.text, fontSize: 30, fontWeight: '900', marginTop: 4 },
  description: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  status: { marginTop: 32 },
  errorCard: { backgroundColor: colors.errorSoft, borderRadius: 16, padding: 18, alignItems: 'center' },
  errorText: { color: colors.errorText, textAlign: 'center', lineHeight: 21 },
  retryButton: { marginTop: 12, borderRadius: 10, backgroundColor: colors.accent, paddingHorizontal: 16, paddingVertical: 10 },
  retryText: { color: '#fff', fontWeight: '800' },
  emptyCard: { backgroundColor: colors.accentSoft, borderRadius: 16, padding: 18, marginTop: 8 },
  emptyTitle: { color: colors.text, fontWeight: '900', fontSize: 16 },
  emptyText: { color: colors.muted, lineHeight: 21, marginTop: 7 },
  emptyActions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  primaryButton: { borderRadius: 10, backgroundColor: colors.accent, paddingHorizontal: 14, paddingVertical: 10 },
  primaryButtonText: { color: '#fff', fontWeight: '800' },
  secondaryButton: { borderRadius: 10, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 10 },
  secondaryButtonText: { color: colors.accent, fontWeight: '800' },
  basisRow: { marginTop: 6 },
  basisLabel: { color: colors.text, fontSize: 18, fontWeight: '900' },
  basisNote: { color: colors.muted, fontSize: 12, marginTop: 3 },
  metricsCard: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 8 },
  metric: { width: '50%', padding: 9 },
  metricLabel: { color: colors.muted, fontSize: 12 },
  metricValue: { color: colors.text, fontSize: 18, fontWeight: '900', marginTop: 3 },
  disclaimer: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  section: { marginTop: 8 },
  sectionTitle: { color: colors.accent, fontSize: 14, fontWeight: '900', letterSpacing: 0.6, marginTop: 8 },
  holdingCard: { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 15, marginTop: 9 },
  stockHeader: { flexDirection: 'row', alignItems: 'center' },
  stockTicker: { color: colors.accent, fontWeight: '900', fontSize: 15 },
  stockPosition: { color: colors.warningText, backgroundColor: colors.warningSoft, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11, fontWeight: '800', marginLeft: 'auto' },
  stockName: { color: colors.text, fontSize: 17, fontWeight: '900', marginTop: 6 },
  stockGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  value: { width: '47%', backgroundColor: colors.accentSoft, borderRadius: 9, padding: 8 },
  valueLabel: { color: colors.muted, fontSize: 11 },
  valueText: { color: colors.text, fontSize: 14, fontWeight: '800', marginTop: 2 },
  weightRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 9 },
  weightLabel: { width: 92, color: colors.text, fontSize: 12, fontWeight: '700' },
  weightTrack: { flex: 1, height: 8, backgroundColor: colors.border, borderRadius: 4, overflow: 'hidden' },
  weightBar: { height: 8, backgroundColor: colors.accent, borderRadius: 4 },
  weightValue: { width: 48, color: colors.muted, textAlign: 'right', fontSize: 12 },
  footnote: { color: colors.muted, fontSize: 11, marginTop: 7 },
});
