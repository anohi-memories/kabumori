import { useCallback, useMemo, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { todayJst } from '@/lib/dashboard';
import { datedMarketReportEmptyText, stepMarketReportDate } from '@/lib/market-report-history';
import { buildMarketReportView, type MarketReportBlock } from '@/lib/market-report-view';
import { fetchAnalysisStatus, fetchAppMarketReport } from '@/lib/ondemand-analysis';
import {
  STATUS_OFF,
  isRequestedMarketReport,
  marketReportRequest,
  type AnalysisStatus,
  type AppMarketReport,
} from '@/lib/ondemand-analysis-presentation';
import {
  REPORT_DISCLAIMER_JA,
  changeDirection,
  formatDateJa,
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
// 一斉通知から開いたときは ?type=close&date=YYYY-MM-DD で、その日・その種類の回を開く（読めない日付は直近の回へ戻す）。
// ホーム「今日のポイント」から開いたときは ?type&date&id&strict=1 で、指定の回だけを開く。読めなくても別の回にはせず、
// その旨と「直近の市況を見る」を出す。日付ナビ（前の日・次の日）で選んだ過去の回も同じ（指定の回だけ）。
// 本文は buildMarketReportView のブロックの順（ポイント → ゆめちゃん → お話 → 注目材料 → 参考資料）で描く。
export default function MarketReportScreen() {
  const params = useLocalSearchParams<{ type?: string; date?: string; id?: string; strict?: string }>();
  const initial = marketReportRequest(params);
  const [type, setType] = useState<ReportType>(initial.type);
  const [date, setDate] = useState<string | null>(initial.date);
  // 日付を指定して開いた回（ホーム・日付ナビ）は strict: 読めなくても直近の回に差し替えない。
  const [strict, setStrict] = useState(initial.strict);
  // 結果は、どの回（種類・日付）のものかの印つきで持つ。別の回を読み込み中に、前の回を見せ続けない。
  const [result, setResult] = useState<{ key: string; report: AppMarketReport | null; error: string } | null>(null);
  const requestSeq = useRef(0);
  const requestKey = `${type}:${date ?? 'latest'}`;
  const current = result && result.key === requestKey ? result : null;
  const report = current?.report ?? null;
  const error = current?.error ?? '';
  const loading = current === null;
  const today = todayJst();
  // 分析の受付が ON のときだけ「保有銘柄をAIで分析する」を出す。
  const [analysis, setAnalysis] = useState<AnalysisStatus>(STATUS_OFF);
  const blocks = useMemo(() => (report?.status === 'completed' ? buildMarketReportView(report).blocks : []), [report]);
  // 参考資料（主な市場指標）はいつも最後。分析の入口は、その手前に置く。
  const bodyBlocks = blocks.filter((block) => block.key !== 'reference');
  const referenceBlock = blocks.find((block) => block.key === 'reference');

  const load = useCallback(async (reportType: ReportType, tradingDate: string | null, onlyThisReport: boolean) => {
    const sequence = ++requestSeq.current;
    const key = `${reportType}:${tradingDate ?? 'latest'}`;
    void fetchAnalysisStatus().then(setAnalysis, () => setAnalysis(STATUS_OFF));
    let next: AppMarketReport | null = null;
    let message = '';
    try {
      // 通知の日付の回が読めない（古すぎるなど）ときだけ、直近の回を出す。指定の回だけを開く場合（strict）は戻さない。
      next = await fetchAppMarketReport(reportType, tradingDate).catch((dated: unknown) => {
        if (!tradingDate || onlyThisReport) throw dated;
        return fetchAppMarketReport(reportType);
      });
      // 指定の回を開いたのに、違う種類・日付の回が返ったら出さない（別の回を指定の回として見せない）。
      if (onlyThisReport && tradingDate && next.status === 'completed' && !isRequestedMarketReport(next, reportType, tradingDate)) {
        next = null;
        message = '指定された回を表示できませんでした。';
      }
    } catch (loadError) {
      next = null;
      message = loadError instanceof Error ? loadError.message : '読み込めませんでした。';
    }
    // 連続して回を切り替えたとき、遅れて返った前の結果で上書きしない。
    if (sequence === requestSeq.current) setResult({ key, report: next, error: message });
  }, []);

  useFocusEffect(useCallback(() => {
    void load(type, date, strict);
  }, [load, type, date, strict]));

  // 日付ナビの基準: 表示中の回の取引日、読めなかったときは指定の日付。直近の回を読み込む前は無い。
  const anchorDate = report?.status === 'completed' ? report.tradingDate : date;
  const previousDate = anchorDate ? stepMarketReportDate(anchorDate, -1, today) : null;
  const nextDate = anchorDate ? stepMarketReportDate(anchorDate, 1, today) : null;
  const goToDate = (target: string) => {
    setDate(target);
    setStrict(true);
  };
  const goToLatest = () => {
    setDate(null);
    setStrict(false);
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load(type, date, strict)} tintColor={colors.accent} />}>
        <BackButton />
        <Text style={styles.eyebrow}>MARKET REPORT</Text>
        <Text style={styles.title}>きょうの市況</Text>
        <View style={styles.segment}>
          {(['morning', 'close'] as const).map((entry) => (
            <Pressable
              key={entry}
              onPress={() => {
                // 指定の日付を見ているとき（ホーム・日付ナビ）は、同じ日の別の種類へ。通知の日付は、直近の回にする。
                setType(entry);
                if (!strict) setDate(null);
              }}
              style={[styles.segmentItem, type === entry && styles.segmentActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: type === entry }}>
              <Text style={[styles.segmentText, type === entry && styles.segmentTextActive]}>{reportTypeLabel(entry)}</Text>
            </Pressable>
          ))}
        </View>

        {anchorDate && (
          <View style={styles.dateNav}>
            <Pressable
              onPress={() => previousDate && goToDate(previousDate)}
              disabled={!previousDate}
              style={[styles.dateNavButton, !previousDate && styles.dateNavDisabled]}
              accessibilityRole="button"
              accessibilityLabel="前の日の回を見る"
              accessibilityState={{ disabled: !previousDate }}>
              <Text style={styles.dateNavText}>‹ 前の日</Text>
            </Pressable>
            <Text style={styles.dateNavLabel} accessibilityLiveRegion="polite">{formatDateJa(anchorDate)}</Text>
            <Pressable
              onPress={() => nextDate && goToDate(nextDate)}
              disabled={!nextDate}
              style={[styles.dateNavButton, !nextDate && styles.dateNavDisabled]}
              accessibilityRole="button"
              accessibilityLabel="次の日の回を見る"
              accessibilityState={{ disabled: !nextDate }}>
              <Text style={styles.dateNavText}>次の日 ›</Text>
            </Pressable>
          </View>
        )}
        {date !== null && (
          <Pressable onPress={goToLatest} accessibilityRole="button" style={styles.latestLink}>
            <Text style={styles.latestLinkText}>直近の{reportTypeLabel(type)}を見る</Text>
          </Pressable>
        )}

        {loading ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
        {!!error && <Text style={styles.error}>{error}</Text>}
        {report && report.status !== 'completed' && (
          <Text style={styles.empty}>
            {date ? datedMarketReportEmptyText(report, type, date, today) : marketReportEmptyText(report)}
          </Text>
        )}

        {report?.status === 'completed' && (
          <>
            <Text style={[styles.dateLine, !report.isToday && !strict && styles.staleLine]}>{marketReportDateLine(report, strict)}</Text>
            <Text style={styles.headline}>{report.headlineJa}</Text>
            <Text style={styles.meta}>
              {marketDirectionLabel(report.direction)}
              {report.generatedAt ? `・${formatTimeJa(report.generatedAt)} 作成` : ''}
            </Text>
            {bodyBlocks.map((block) => <ReportBlock key={block.key} block={block} />)}

            {analysis.enabled && (
              <Pressable
                onPress={() => router.push('/ai-analysis')}
                style={({ pressed }) => [styles.analysisButton, pressed && { opacity: 0.85 }]}
                accessibilityRole="button">
                <Text style={styles.analysisTitle}>私の保有銘柄をAIで分析する</Text>
                <Text style={styles.analysisText}>この市況を基準に、保有・ウォッチ銘柄への影響を分析します ›</Text>
              </Pressable>
            )}

            {referenceBlock && <ReportBlock block={referenceBlock} />}

            <View style={styles.footer}>
              <Text style={styles.footnote}>{REPORT_DISCLAIMER_JA}</Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ReportBlock({ block }: { block: MarketReportBlock }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">{block.heading}</Text>
      {!!block.intro && <Text style={styles.paragraph}>{block.intro}</Text>}
      {!!block.meta && <Text style={styles.meta}>{block.meta}</Text>}
      {block.paragraphs.map((paragraph, index) => (
        <View key={`para-${index}`} style={styles.paragraphBlock}>
          {!!paragraph.subheading && <Text style={styles.subheading}>{paragraph.subheading}</Text>}
          {!!paragraph.text && <Text style={styles.paragraph}>{paragraph.text}</Text>}
        </View>
      ))}
      {block.groups?.map((group) => (
        <View key={group.title} style={styles.paragraphBlock}>
          <Text style={styles.subheading}>{group.title}</Text>
          {group.rows.map((row, index) => (
            <View key={`${group.title}-${index}`} style={styles.moveRow}>
              <View style={styles.moveName}>
                <Text style={styles.moveLabel}>{row.label}</Text>
                {!!row.sessionDateJa && <Text style={styles.moveDate}>{row.sessionDateJa}</Text>}
              </View>
              <Text style={styles.moveValue}>{row.value}</Text>
              <Text style={[styles.moveChange, { color: CHANGE_COLOR[changeDirection(row.change)] }]}>
                {row.stale ? '前回値' : row.change ?? '—'}
              </Text>
            </View>
          ))}
        </View>
      ))}
      {!!block.bulletsTitle && block.bullets.length > 0 && <Text style={styles.subheading}>{block.bulletsTitle}</Text>}
      {block.bullets.map((item, index) => <Bullet key={`b-${index}`} text={item} />)}
      {!!block.note && <Text style={styles.footnote}>{block.note}</Text>}
    </View>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletDot}>・</Text>
      <Text style={styles.bulletText}>{text}</Text>
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
  dateNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  dateNavButton: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  dateNavDisabled: { opacity: 0.4 },
  dateNavText: { color: colors.accent, fontWeight: '800', fontSize: 13 },
  dateNavLabel: { color: colors.text, fontWeight: '900', fontSize: 14, flex: 1, textAlign: 'center' },
  latestLink: { alignSelf: 'flex-start', paddingVertical: 4 },
  latestLinkText: { color: colors.accent, fontWeight: '800', fontSize: 13 },
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
  subheading: { color: colors.text, fontWeight: '800', fontSize: 13, lineHeight: 19 },
  paragraphBlock: { gap: 2 },
  moveRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3 },
  moveName: { flex: 1 },
  moveLabel: { color: colors.text, fontSize: 14 },
  moveDate: { color: colors.muted, fontSize: 11 },
  moveValue: { color: colors.text, fontSize: 14, fontWeight: '700', marginRight: 10 },
  moveChange: { fontSize: 13, fontWeight: '800', minWidth: 64, textAlign: 'right' },
  bulletRow: { flexDirection: 'row' },
  bulletDot: { color: colors.accent, fontSize: 15, lineHeight: 22 },
  bulletText: { color: colors.text, fontSize: 15, lineHeight: 22, flex: 1 },
  analysisButton: { backgroundColor: colors.accentSoft, borderRadius: 16, padding: 15, gap: 4 },
  analysisTitle: { color: colors.text, fontWeight: '900', fontSize: 16 },
  analysisText: { color: colors.accent, fontWeight: '700', fontSize: 13 },
  footer: { gap: 4, marginTop: 6 },
  footnote: { color: colors.muted, fontSize: 12, lineHeight: 18 },
});
