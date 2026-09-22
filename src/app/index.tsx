import { useCallback, useMemo, useState } from 'react';
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

import { fetchMyImportantStockNews, type ImportantStockNews } from '@/lib/important-news';
import { categoryLabels, formatNewsTime, importanceLabel, targetLabel } from '@/lib/news-labels';
import { buildNewsPresentation } from '@/lib/news-presentation';
import { fetchRecentReports } from '@/lib/personalized-reports';
import { formatTimeJa, reportTypeLabel, type PersonalizedReport, type ReportType } from '@/lib/report-presentation';
import { dashboardGreeting, dashboardSectionError, summarizeTrackedStocks, todayJst, todaysReports } from '@/lib/dashboard';
import type { TrackedStock } from '@/lib/stocks';
import { supabase } from '@/lib/supabase';
import { KABUMORI_COLORS, type KabumoriPalette } from '@/constants/kabumori-theme';
const REPORT_SCHEDULE: Record<ReportType, string> = { morning: '平日の朝8時半ごろに届きます', close: '平日の17時すぎに届きます' };

async function fetchTrackedStocks(): Promise<TrackedStock[]> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error('登録銘柄を見るにはログインが必要です。');
  const { data, error } = await supabase
    .from('tracked_stocks')
    .select('id,user_id,stock_id,tracking_type,quantity,average_price,position_type,side,target_buy_price,target_sell_price,memo,stocks_master!inner(id,ticker_code,company_name,market)')
    .eq('user_id', userData.user.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`登録銘柄を取得できませんでした。${error.message}`);
  return (data ?? []) as unknown as TrackedStock[];
}

function retryButton(message: string, onRetry: () => void, palette: KabumoriPalette) {
  return (
    <View style={[styles.errorCard, { backgroundColor: palette.error }]}>
      <Text style={[styles.errorText, { color: palette.muted }]}>{message}</Text>
      <Pressable onPress={onRetry} style={[styles.retryButton, { backgroundColor: palette.accent }]} accessibilityRole="button" accessibilityLabel="もう一度読み込む">
        <Text style={styles.retryText}>もう一度試す</Text>
      </Pressable>
    </View>
  );
}

export default function HomeScreen() {
  // Keep the core Kabumori screens on one light palette until a complete dark
  // mode pass can cover every screen consistently.
  const palette = KABUMORI_COLORS.light;
  const greeting = dashboardGreeting();
  const [stocks, setStocks] = useState<TrackedStock[]>([]);
  const [news, setNews] = useState<ImportantStockNews[]>([]);
  const [reports, setReports] = useState<PersonalizedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState({ stocks: '', news: '', reports: '' });

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    const [stocksResult, newsResult, reportsResult] = await Promise.allSettled([
      fetchTrackedStocks(),
      fetchMyImportantStockNews(),
      fetchRecentReports(),
    ]);
    setErrors({
      stocks: stocksResult.status === 'rejected' ? dashboardSectionError('stocks') : '',
      news: newsResult.status === 'rejected' ? dashboardSectionError('news') : '',
      reports: reportsResult.status === 'rejected' ? dashboardSectionError('reports') : '',
    });
    if (stocksResult.status === 'fulfilled') setStocks(stocksResult.value);
    if (newsResult.status === 'fulfilled') setNews(newsResult.value.items);
    if (reportsResult.status === 'fulfilled') setReports(reportsResult.value);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const summary = useMemo(() => summarizeTrackedStocks(stocks), [stocks]);
  const reportsToday = todaysReports(reports, todayJst());
  const newsPreview = news.slice(0, 3);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: palette.background }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={palette.accent} />}>
        <Text style={[styles.eyebrow, { color: palette.accent }]}>{greeting.eyebrow}</Text>
        <Text style={[styles.title, { color: palette.text }]}>{greeting.title}</Text>
        <Text style={[styles.description, { color: palette.muted }]}>あなたの保有・監視銘柄に必要な情報をまとめます。</Text>

        <View style={styles.actionGrid}>
          {[
            { label: '銘柄を見る・追加', icon: '⌕', onPress: () => router.push({ pathname: '/explore', params: { focus: 'search' } }) },
            { label: 'ポートフォリオ', icon: '◈', onPress: () => router.push('/portfolio') },
            { label: 'レポート', icon: '▤', onPress: () => router.push('/reports') },
            { label: '重要ニュース', icon: '✦', onPress: () => router.push('/news') },
          ].map((action) => (
            <Pressable key={action.label} onPress={action.onPress} style={({ pressed }) => [styles.action, { backgroundColor: palette.card, borderColor: palette.border }, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={action.label} accessibilityHint={`${action.label}を開きます`}>
              <Text style={[styles.actionIcon, { color: palette.accent }]}>{action.icon}</Text>
              <Text style={[styles.actionLabel, { color: palette.text }]}>{action.label}</Text>
            </Pressable>
          ))}
        </View>

        <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
          <View style={styles.sectionHeader}><View><Text style={[styles.sectionEyebrow, { color: palette.accent }]}>MY STOCKS</Text><Text style={[styles.sectionTitle, { color: palette.text }]}>銘柄</Text></View><Pressable onPress={() => router.push('/explore')} accessibilityRole="button" accessibilityLabel="銘柄一覧を見る"><Text style={[styles.link, { color: palette.accent }]}>一覧を見る ›</Text></Pressable></View>
          {loading && !stocks.length ? <ActivityIndicator color={palette.accent} style={styles.sectionStatus} /> : null}
          {!!errors.stocks ? retryButton(errors.stocks, () => void load(true), palette) : null}
          {!loading && !errors.stocks && !stocks.length ? <View style={[styles.emptyInner, { backgroundColor: palette.soft }]}><Text style={[styles.emptyTitle, { color: palette.text }]}>まず1銘柄を登録しましょう</Text><Text style={[styles.emptyText, { color: palette.muted }]}>保有または監視銘柄を追加すると、ここでいつでも確認できます。</Text><Pressable onPress={() => router.push({ pathname: '/explore', params: { focus: 'search' } })} style={[styles.primaryButton, { backgroundColor: palette.accent }]} accessibilityRole="button"><Text style={styles.primaryButtonText}>銘柄を検索する</Text></Pressable></View> : null}
          {!!stocks.length ? <>
            <View style={styles.metricsRow}><View style={styles.metric}><Text style={[styles.metricValue, { color: palette.text }]}>{summary.holdingCount}</Text><Text style={[styles.metricLabel, { color: palette.muted }]}>保有</Text></View><View style={styles.metric}><Text style={[styles.metricValue, { color: palette.text }]}>{summary.watchCount}</Text><Text style={[styles.metricLabel, { color: palette.muted }]}>監視</Text></View><View style={styles.metric}><Text style={[styles.metricValue, { color: palette.text }]}>{summary.totalCount}</Text><Text style={[styles.metricLabel, { color: palette.muted }]}>合計</Text></View></View>
            <View style={styles.stockPreviewList}>{stocks.slice(0, 3).map((item) => { const holding = item.tracking_type === 'holding'; return <Pressable key={item.id} onPress={() => router.push('/explore')} style={({ pressed }) => [styles.stockPreview, { borderTopColor: palette.border }, pressed && styles.pressed]} accessibilityRole="button"><View style={styles.stockPreviewMain}><Text style={[styles.stockTicker, { color: palette.accent }]}>{item.stocks_master.ticker_code}</Text><Text style={[styles.stockName, { color: palette.text }]} numberOfLines={1}>{item.stocks_master.company_name}</Text>{holding && item.quantity !== null ? <Text style={[styles.stockMeta, { color: palette.muted }]}>{item.quantity.toLocaleString()}株</Text> : null}</View><View style={[styles.typeBadge, { backgroundColor: holding ? palette.soft : palette.warningSoft }]}><Text style={[styles.typeBadgeText, { color: holding ? palette.accent : palette.warningText }]}>{holding ? '保有' : '監視'}</Text></View></Pressable>; })}</View>
            {stocks.length > 3 ? <Text style={[styles.moreHint, { color: palette.muted }]}>ほか{stocks.length - 3}銘柄</Text> : null}
          </> : null}
        </View>

        <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
          <View style={styles.sectionHeader}><View><Text style={[styles.sectionEyebrow, { color: palette.accent }]}>IMPORTANT NEWS</Text><Text style={[styles.sectionTitle, { color: palette.text }]}>重要ニュース</Text></View><Pressable onPress={() => router.push('/news')} accessibilityRole="button" accessibilityLabel="重要ニュースをすべて見る"><Text style={[styles.link, { color: palette.accent }]}>すべて見る ›</Text></Pressable></View>
          {loading && !news.length ? <ActivityIndicator color={palette.accent} style={styles.sectionStatus} /> : null}
          {!!errors.news ? retryButton(errors.news, () => void load(true), palette) : null}
          {!loading && !errors.news && !newsPreview.length ? <Text style={[styles.emptyText, { color: palette.muted }]}>登録銘柄に関連する重要ニュースはまだありません。</Text> : null}
          {newsPreview.map((item) => { const target = targetLabel(item); const importance = importanceLabel(item); const view = buildNewsPresentation(item); const categories = categoryLabels(item.coverage_categories); return <Pressable key={item.news_id} onPress={() => router.push({ pathname: '/news/[id]', params: { id: item.news_id } })} style={({ pressed }) => [styles.newsPreview, { borderTopColor: palette.border }, pressed && styles.pressed]} accessibilityRole="button" accessibilityHint="ニュースの詳細を開きます"><View style={styles.newsTopRow}><View style={[styles.newsBadge, { backgroundColor: palette.soft }]}><Text style={[styles.newsBadgeText, { color: palette.accent }]}>{target.badge}</Text></View><Text style={[styles.newsTicker, { color: palette.muted }]}>{target.detail}</Text><Text style={[styles.newsImportance, { color: importance.subtle ? palette.muted : '#a23e37' }]}>{importance.text}</Text></View><Text style={[styles.newsTitle, { color: palette.text }]} numberOfLines={2}>{view.title}</Text>{categories.length > 0 ? <Text style={[styles.newsCategory, { color: palette.muted }]} numberOfLines={1}>{categories.slice(0, 2).join('・')}</Text> : null}<View style={styles.newsFooter}><Text style={[styles.newsTime, { color: palette.muted }]}>{formatNewsTime(item.news_time)}</Text><Text style={[styles.link, { color: palette.accent }]}>詳しく見る ›</Text></View></Pressable>; })}
        </View>

        <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
          <View style={styles.sectionHeader}><View><Text style={[styles.sectionEyebrow, { color: palette.accent }]}>TODAY'S REPORTS</Text><Text style={[styles.sectionTitle, { color: palette.text }]}>今日のレポート</Text></View><Pressable onPress={() => router.push('/reports')} accessibilityRole="button" accessibilityLabel="レポートをすべて見る"><Text style={[styles.link, { color: palette.accent }]}>すべて見る ›</Text></Pressable></View>
          {loading && !reports.length ? <ActivityIndicator color={palette.accent} style={styles.sectionStatus} /> : null}
          {!!errors.reports ? retryButton(errors.reports, () => void load(true), palette) : null}
          {!loading && !errors.reports ? <View style={styles.reportGrid}>{(['morning', 'close'] as ReportType[]).map((type) => { const report = reportsToday[type]; return <Pressable key={type} disabled={!report} onPress={() => report && router.push({ pathname: '/reports/[id]', params: { id: report.id } })} style={({ pressed }) => [styles.reportCard, { backgroundColor: report ? palette.softBlue : palette.soft }, pressed && styles.pressed]} accessibilityRole="button" accessibilityHint={report ? `${reportTypeLabel(type)}を開きます` : undefined}><View style={styles.reportHead}><Text style={[styles.reportType, { color: palette.accent }]}>{reportTypeLabel(type)}</Text>{report ? <Text style={[styles.reportTime, { color: palette.muted }]}>{formatTimeJa(report.generated_at)}</Text> : null}</View>{report ? <><Text style={[styles.reportTitle, { color: palette.text }]} numberOfLines={2}>{report.title_ja}</Text>{report.summary_ja ? <Text style={[styles.reportSummary, { color: palette.muted }]} numberOfLines={2}>{report.summary_ja}</Text> : null}<Text style={[styles.reportMore, { color: palette.accent }]}>読む ›</Text></> : <Text style={[styles.reportEmpty, { color: palette.muted }]}>今日のレポートはまだありません。{REPORT_SCHEDULE[type]}。</Text>}</Pressable>; })}</View> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 110, gap: 14 },
  eyebrow: { fontWeight: '900', letterSpacing: 2, fontSize: 12 },
  title: { fontSize: 32, fontWeight: '900', marginTop: 5 },
  description: { fontSize: 15, lineHeight: 22, marginTop: 7, marginBottom: 4 },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  action: { width: '48%', minHeight: 66, borderRadius: 15, borderWidth: 1, padding: 12, justifyContent: 'center' },
  actionIcon: { fontSize: 20, fontWeight: '800' },
  actionLabel: { fontSize: 13, fontWeight: '800', marginTop: 4 },
  card: { borderRadius: 18, borderWidth: 1, padding: 16 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionEyebrow: { fontWeight: '900', letterSpacing: 1.4, fontSize: 11 },
  sectionTitle: { fontSize: 21, fontWeight: '900', marginTop: 3 },
  link: { fontSize: 12, fontWeight: '900' },
  sectionStatus: { marginVertical: 20 },
  metricsRow: { flexDirection: 'row', borderRadius: 13, marginTop: 15, paddingVertical: 12, backgroundColor: '#00000008' },
  metric: { flex: 1, alignItems: 'center', borderRightWidth: 1, borderRightColor: '#00000012' },
  metricValue: { fontSize: 23, fontWeight: '900' },
  metricLabel: { fontSize: 12, marginTop: 1 },
  stockPreviewList: { marginTop: 4 },
  stockPreview: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, paddingVertical: 12 },
  stockPreviewMain: { flex: 1 },
  stockTicker: { fontWeight: '900', fontSize: 12 },
  stockName: { fontWeight: '800', fontSize: 15, marginTop: 2 },
  stockMeta: { fontSize: 12, marginTop: 2 },
  typeBadge: { borderRadius: 99, paddingHorizontal: 9, paddingVertical: 5 },
  typeBadgeText: { fontSize: 11, fontWeight: '900' },
  moreHint: { textAlign: 'right', fontSize: 12, marginTop: 2 },
  emptyInner: { borderRadius: 14, padding: 15, marginTop: 14 },
  emptyTitle: { fontSize: 15, fontWeight: '900' },
  emptyText: { fontSize: 14, lineHeight: 21, marginTop: 8 },
  primaryButton: { alignSelf: 'flex-start', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginTop: 13 },
  primaryButtonText: { color: '#fff', fontWeight: '900', fontSize: 13 },
  errorCard: { borderRadius: 12, padding: 12, marginTop: 12 },
  errorText: { fontSize: 13, lineHeight: 19 },
  retryButton: { alignSelf: 'flex-start', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
  retryText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  newsPreview: { borderTopWidth: 1, paddingVertical: 13 },
  newsTopRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  newsBadge: { borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4 },
  newsBadgeText: { fontSize: 11, fontWeight: '900' },
  newsTicker: { fontSize: 11, fontWeight: '800' },
  newsImportance: { marginLeft: 'auto', fontSize: 11, fontWeight: '900' },
  newsTitle: { fontSize: 16, lineHeight: 22, fontWeight: '900', marginTop: 7 },
  newsCategory: { fontSize: 12, marginTop: 5 },
  newsFooter: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  newsTime: { fontSize: 11 },
  reportGrid: { gap: 10, marginTop: 13 },
  reportCard: { borderRadius: 14, padding: 13 },
  reportHead: { flexDirection: 'row', alignItems: 'center' },
  reportType: { fontSize: 12, fontWeight: '900' },
  reportTime: { fontSize: 11, marginLeft: 'auto' },
  reportTitle: { fontSize: 16, lineHeight: 22, fontWeight: '900', marginTop: 8 },
  reportSummary: { fontSize: 13, lineHeight: 19, marginTop: 5 },
  reportMore: { fontSize: 12, fontWeight: '900', marginTop: 8, textAlign: 'right' },
  reportEmpty: { fontSize: 13, lineHeight: 19, marginTop: 8 },
  pressed: { opacity: 0.7 },
});
