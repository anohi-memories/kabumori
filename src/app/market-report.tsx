import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { fetchAnalysisStatus, fetchAppMarketReport } from '@/lib/ondemand-analysis';
import { STATUS_OFF, marketReportParams, type AnalysisStatus, type AppMarketReport } from '@/lib/ondemand-analysis-presentation';
import {
  CLAIM_TYPE_LABEL,
  REPORT_DISCLAIMER_JA,
  changeDirection,
  formatTimeJa,
  marketDirectionLabel,
  marketReportDateLine,
  marketReportEmptyText,
  reportTypeLabel,
  type ReportType,
} from '@/lib/report-presentation';

const colors = KABUMORI_COLORS.light;
const CHANGE_COLOR = { up: '#b2332b', down: '#2a5fa8', flat: '#5e6d63', none: '#89918c' } as const;

// 全員に共通の朝刊・大引け（X と同じ共通の分析）。サーバーが公開してよい項目だけを返す
// （get_app_market_report）。利用者ごとの AI は呼ばない。
// 一斉通知から開いたときは ?type=close&date=YYYY-MM-DD で、その日・その種類の回を開く。
export default function MarketReportScreen() {
  const params = useLocalSearchParams<{ type?: string; date?: string }>();
  const initial = marketReportParams(params);
  const [type, setType] = useState<ReportType>(initial.type);
  const [date, setDate] = useState<string | null>(initial.date);
  const [report, setReport] = useState<AppMarketReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 分析の受付が ON のときだけ「保有銘柄をAIで分析する」を出す。
  const [analysis, setAnalysis] = useState<AnalysisStatus>(STATUS_OFF);

  const load = useCallback(async (reportType: ReportType, tradingDate: string | null) => {
    setLoading(true);
    setError('');
    void fetchAnalysisStatus().then(setAnalysis, () => setAnalysis(STATUS_OFF));
    try {
      // 通知の日付の回が読めない（古すぎるなど）ときは、直近の回を出す。
      const next = await fetchAppMarketReport(reportType, tradingDate).catch((dated: unknown) => {
        if (!tradingDate) throw dated;
        return fetchAppMarketReport(reportType);
      });
      setReport(next);
    } catch (loadError) {
      setReport(null);
      setError(loadError instanceof Error ? loadError.message : '読み込めませんでした。');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load(type, date);
  }, [load, type, date]));

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load(type, date)} tintColor={colors.accent} />}>
        <BackButton />
        <Text style={styles.eyebrow}>MARKET REPORT</Text>
        <Text style={styles.title}>きょうの市況</Text>
        <View style={styles.segment}>
          {(['morning', 'close'] as const).map((entry) => (
            <Pressable
              key={entry}
              onPress={() => {
                // 種類を切り替えたら、通知の日付ではなく直近の回にする。
                setType(entry);
                setDate(null);
              }}
              style={[styles.segmentItem, type === entry && styles.segmentActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: type === entry }}>
              <Text style={[styles.segmentText, type === entry && styles.segmentTextActive]}>{reportTypeLabel(entry)}</Text>
            </Pressable>
          ))}
        </View>

        {loading && !report ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
        {!!error && <Text style={styles.error}>{error}</Text>}
        {report && report.status !== 'completed' && <Text style={styles.empty}>{marketReportEmptyText(report)}</Text>}

        {report?.status === 'completed' && (
          <>
            <Text style={[styles.dateLine, !report.isToday && styles.staleLine]}>{marketReportDateLine(report)}</Text>
            <Text style={styles.headline}>{report.headlineJa}</Text>
            <Text style={styles.meta}>
              {marketDirectionLabel(report.direction)}
              {report.generatedAt ? `・${formatTimeJa(report.generatedAt)} 作成` : ''}
            </Text>
            {!!report.summaryJa && <Text style={styles.paragraph}>{report.summaryJa}</Text>}

            {report.pointsJa.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>ポイント</Text>
                {report.pointsJa.map((point, index) => <Bullet key={`p-${index}`} text={point} />)}
              </View>
            )}

            {report.majorMoves.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>主な指標</Text>
                {report.majorMoves.map((move) => (
                  <View key={move.label} style={styles.moveRow}>
                    <Text style={styles.moveLabel}>{move.label}</Text>
                    <Text style={styles.moveValue}>{move.value}</Text>
                    <Text style={[styles.moveChange, { color: CHANGE_COLOR[changeDirection(move.change)] }]}>
                      {move.stale ? '前回値' : move.change ?? '—'}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {report.claims.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>{report.reportType === 'close' ? '今日の動き' : '見ておきたい動き'}</Text>
                {report.claims.map((claim, index) => (
                  <Bullet
                    key={`c-${index}`}
                    text={claim.textJa}
                    tag={CLAIM_TYPE_LABEL[claim.claimType] ? `（${CLAIM_TYPE_LABEL[claim.claimType]}）` : ''}
                  />
                ))}
              </View>
            )}

            {(report.strongThemes.length > 0 || report.weakThemes.length > 0) && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>テーマ</Text>
                {report.strongThemes.length > 0 && <Text style={styles.paragraph}>強い: {report.strongThemes.join('、')}</Text>}
                {report.weakThemes.length > 0 && <Text style={styles.paragraph}>弱い: {report.weakThemes.join('、')}</Text>}
              </View>
            )}

            {report.keyNews.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>主なニュース</Text>
                {report.keyNews.map((news, index) => (
                  <View key={`n-${index}`} style={styles.newsItem}>
                    <Text style={styles.newsHeadline}>{news.headlineJa}</Text>
                    {!!news.whyJa && <Text style={styles.newsWhy}>{news.whyJa}</Text>}
                  </View>
                ))}
              </View>
            )}

            {report.nextWatchJa.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>次に見るポイント</Text>
                {report.nextWatchJa.map((item, index) => <Bullet key={`w-${index}`} text={item} />)}
              </View>
            )}

            {report.risksJa.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>気をつけたい点</Text>
                {report.risksJa.map((item, index) => <Bullet key={`r-${index}`} text={item} />)}
              </View>
            )}

            {analysis.enabled && (
              <Pressable
                onPress={() => router.push('/ai-analysis')}
                style={({ pressed }) => [styles.analysisButton, pressed && { opacity: 0.85 }]}
                accessibilityRole="button">
                <Text style={styles.analysisTitle}>私の保有銘柄をAIで分析する</Text>
                <Text style={styles.analysisText}>この市況を基準に、保有・ウォッチ銘柄への影響を分析します ›</Text>
              </Pressable>
            )}

            <View style={styles.footer}>
              {report.dataGapsJa.map((note) => <Text key={note} style={styles.footnote}>{note}</Text>)}
              <Text style={styles.footnote}>{REPORT_DISCLAIMER_JA}</Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Bullet({ text, tag = '' }: { text: string; tag?: string }) {
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletDot}>・</Text>
      <Text style={styles.bulletText}>
        {text}
        {!!tag && <Text style={styles.tag}>{tag}</Text>}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 60, gap: 10 },
  eyebrow: { color: colors.accent, fontWeight: '900', letterSpacing: 2, fontSize: 11, marginTop: 8 },
  title: { color: colors.text, fontSize: 26, fontWeight: '900' },
  segment: { flexDirection: 'row', backgroundColor: colors.accentSoft, borderRadius: 12, padding: 4, gap: 4 },
  segmentItem: { flex: 1, borderRadius: 9, paddingVertical: 9, alignItems: 'center' },
  segmentActive: { backgroundColor: colors.card },
  segmentText: { color: colors.muted, fontWeight: '800', fontSize: 14 },
  segmentTextActive: { color: colors.text },
  status: { marginTop: 24 },
  error: { color: colors.errorText, fontSize: 14 },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 12 },
  dateLine: { color: colors.accent, fontWeight: '800', fontSize: 13, marginTop: 6 },
  staleLine: { color: '#946222' },
  headline: { color: colors.text, fontWeight: '900', fontSize: 21, lineHeight: 29 },
  meta: { color: colors.muted, fontSize: 12 },
  paragraph: { color: colors.text, fontSize: 15, lineHeight: 23 },
  section: { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 15, gap: 6 },
  sectionTitle: { color: colors.text, fontWeight: '900', fontSize: 15 },
  moveRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3 },
  moveLabel: { color: colors.text, fontSize: 14, flex: 1 },
  moveValue: { color: colors.text, fontSize: 14, fontWeight: '700', marginRight: 10 },
  moveChange: { fontSize: 13, fontWeight: '800', minWidth: 64, textAlign: 'right' },
  newsItem: { gap: 2, paddingVertical: 3 },
  newsHeadline: { color: colors.text, fontWeight: '800', fontSize: 14, lineHeight: 20 },
  newsWhy: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  bulletRow: { flexDirection: 'row' },
  bulletDot: { color: colors.accent, fontSize: 15, lineHeight: 22 },
  bulletText: { color: colors.text, fontSize: 15, lineHeight: 22, flex: 1 },
  tag: { color: colors.muted, fontSize: 12 },
  analysisButton: { backgroundColor: colors.accentSoft, borderRadius: 16, padding: 15, gap: 4 },
  analysisTitle: { color: colors.text, fontWeight: '900', fontSize: 16 },
  analysisText: { color: colors.accent, fontWeight: '700', fontSize: 13 },
  footer: { gap: 4, marginTop: 6 },
  footnote: { color: colors.muted, fontSize: 12, lineHeight: 18 },
});
