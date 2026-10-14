import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { todayJst } from '@/lib/dashboard';
import { isCurrentHomeMarketReport } from '@/lib/home-market-report';
import { reportsTabPastParams } from '@/lib/market-report-history';
import {
  fetchRecentReports,
  fetchReportAlertSettings,
  setReportAlert,
  type ReportAlertSettings,
} from '@/lib/personalized-reports';
import {
  REPORTS_TAB_CARDS_INITIAL,
  reportsTabFailed,
  reportsTabOpenParams,
  resolveReportsTabCards,
  type ReportsTabCard,
  type ReportsTabCards,
} from '@/lib/reports-tab';
import { formatDateJa, formatTimeJa, reportTypeLabel, type PersonalizedReport, type ReportType } from '@/lib/report-presentation';
import { fetchAnalysisStatus, fetchHomeMarketReports } from '@/lib/ondemand-analysis';
import { STATUS_OFF, remainingToday, type AnalysisStatus } from '@/lib/ondemand-analysis-presentation';

const colors = KABUMORI_COLORS.light;

// レポートタブ: 上から「最新の市況（全員共通の朝刊・大引け）」→「過去のレポート」→「保有銘柄のAI分析」→ 通知。
// 共通の朝刊・大引けはホームの「今日のポイント」と同じ保存済みのレポート（get_app_market_report）で、完成・公開済みの回だけを出す。
// 保有銘柄向けの個別の分析（これまでの個別レポートとオンデマンドのAI分析）は、別の見出しにそのまま残している。
export default function ReportsScreen() {
  const [cards, setCards] = useState<ReportsTabCards>(REPORTS_TAB_CARDS_INITIAL);
  const [marketLoaded, setMarketLoaded] = useState(false);
  const [personal, setPersonal] = useState<PersonalizedReport[]>([]);
  const [personalError, setPersonalError] = useState('');
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<ReportAlertSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  // サーバー側で公開されたときだけ入口を出す（未公開・取得失敗では何も出さない）。
  const [ondemand, setOndemand] = useState<AnalysisStatus>(STATUS_OFF);
  // 日付をまたいでも古い「今日」を使わないよう、読み込みのたびに決め直す。
  const [today, setToday] = useState(() => todayJst());

  const load = useCallback(async () => {
    setLoading(true);
    setToday(todayJst());
    // 共通の市況（朝刊・大引けの最新）。fetchHomeMarketReports は失敗しても reject しない（種類ごとの結果を返す）。
    const marketPromise = fetchHomeMarketReports().then((results) => {
      setCards((previous) => resolveReportsTabCards(previous, results));
      setMarketLoaded(true);
    });
    // 保有銘柄向けの個別レポート（これまでの分）は、共通の市況とは独立に読む。
    const personalPromise = fetchRecentReports().then(
      (reports) => {
        setPersonal(reports);
        setPersonalError('');
      },
      () => setPersonalError('個別レポートを読み込めませんでした。'),
    );
    await Promise.all([marketPromise, personalPromise]);
    setLoading(false);
    setOndemand(await fetchAnalysisStatus().catch(() => STATUS_OFF));
    try {
      setSettings(await fetchReportAlertSettings());
      setSettingsError('');
    } catch {
      setSettingsError('通知設定を取得できませんでした。');
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const toggle = useCallback(async (column: keyof ReportAlertSettings, enabled: boolean) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, [column]: enabled });
    setSaving(true);
    setSettingsError('');
    try {
      await setReportAlert(column, enabled);
    } catch (saveError) {
      setSettings(previous);
      setSettingsError('通知設定を保存できませんでした。');
    } finally {
      setSaving(false);
    }
  }, [settings]);

  function marketCard(type: ReportType) {
    const card: ReportsTabCard | null = cards[type];
    const label = reportTypeLabel(type);
    if (!card) return null;
    if (card.kind === 'report') {
      const current = isCurrentHomeMarketReport(card.report, today);
      return (
        <Pressable
          key={type}
          onPress={() => router.push({ pathname: '/market-report', params: reportsTabOpenParams(card) })}
          style={({ pressed }) => [styles.todayCard, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${formatDateJa(card.report.tradingDate)}の${label}を開く`}>
          <View style={styles.cardHead}>
            <Text style={[styles.typeBadge, type === 'close' && styles.closeBadge]}>{label}</Text>
            {current ? <Text style={styles.todayBadge}>今日</Text> : null}
            {card.generatedAt ? <Text style={styles.time}>{formatTimeJa(card.generatedAt)} 作成</Text> : null}
          </View>
          <Text style={styles.cardDate}>{formatDateJa(card.report.tradingDate)}</Text>
          <Text style={styles.cardTitle}>{card.headline}</Text>
          {!!card.summary && <Text style={styles.cardSummary} numberOfLines={3}>{card.summary}</Text>}
          {card.unconfirmed && <Text style={styles.unconfirmed}>最新かどうか確認できませんでした。引っ張って更新してください。</Text>}
          <Text style={styles.more}>読む ›</Text>
        </Pressable>
      );
    }
    return (
      <View key={type} style={[styles.todayCard, styles.todayCardEmpty]}>
        <View style={styles.cardHead}>
          <Text style={[styles.typeBadge, type === 'close' && styles.closeBadge]}>{label}</Text>
        </View>
        {card.kind === 'error' ? (
          <>
            <Text style={styles.emptyText}>{label}を読み込めませんでした。</Text>
            <Pressable onPress={() => void load()} style={styles.retryButton} accessibilityRole="button">
              <Text style={styles.retryText}>もう一度試す</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.emptyText}>
            {card.reason === 'disabled' ? '共通の朝刊・大引けは準備中です。' : `直近の${label}はまだありません。`}
          </Text>
        )}
      </View>
    );
  }

  function pastRow(type: ReportType) {
    return (
      <Pressable
        key={type}
        onPress={() => router.push({ pathname: '/market-report', params: reportsTabPastParams(cards[type], type, today) })}
        style={({ pressed }) => [styles.pastRow, pressed && styles.pressed]}
        accessibilityRole="button">
        <Text style={styles.pastTitle}>過去の{reportTypeLabel(type)}を日付で見る ›</Text>
      </Pressable>
    );
  }

  function toggleRow(column: keyof ReportAlertSettings, label: string) {
    return (
      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Switch
          value={settings?.[column] === true}
          onValueChange={(enabled) => void toggle(column, enabled)}
          disabled={!settings || saving}
          trackColor={{ true: colors.accent, false: colors.border }}
          accessibilityLabel={label}
        />
      </View>
    );
  }

  const failed = marketLoaded && reportsTabFailed(cards);
  const showPersonalSection = ondemand.enabled || personal.length > 0 || !!personalError;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={loading && marketLoaded} onRefresh={load} tintColor={colors.accent} />}>
        <Text style={styles.eyebrow}>REPORT</Text>
        <Text style={styles.title}>レポート</Text>
        <Text style={styles.description}>
          全員共通の朝刊と大引けです。朝は「今日どこを見るか」、引け後は「今日どう動いたか」をまとめます。
        </Text>

        <Text style={styles.sectionTitle}>最新の市況</Text>
        {!marketLoaded ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
        {failed ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>共通の朝刊・大引けを読み込めませんでした。</Text>
            <Pressable onPress={() => void load()} style={styles.retryButton} accessibilityRole="button">
              <Text style={styles.retryText}>もう一度試す</Text>
            </Pressable>
          </View>
        ) : marketLoaded ? (
          <>
            {marketCard('morning')}
            {marketCard('close')}
          </>
        ) : null}

        <Text style={styles.sectionTitle}>過去のレポート</Text>
        <Text style={styles.sectionNote}>日付をさかのぼって、これまでの朝刊・大引けを読めます（直近31日）。</Text>
        {pastRow('morning')}
        {pastRow('close')}

        {showPersonalSection && <Text style={styles.sectionTitle}>保有銘柄のAI分析</Text>}
        {ondemand.enabled && (
          <Pressable
            onPress={() => router.push('/ai-analysis')}
            style={({ pressed }) => [styles.entryCard, styles.entryAccent, pressed && styles.pressed]}
            accessibilityRole="button">
            <Text style={styles.entryTitle}>保有銘柄をAIで分析</Text>
            <Text style={styles.entryText}>
              {ondemand.activeJobId ? '分析中です ›' : `今日あと${remainingToday(ondemand)}回 ›`}
            </Text>
          </Pressable>
        )}
        {!!personalError && <Text style={styles.alertError}>{personalError}</Text>}
        {personal.length > 0 && <Text style={styles.subSectionTitle}>これまでの個別レポート</Text>}
        {personal.map((report) => (
          <Pressable
            key={report.id}
            onPress={() => router.push({ pathname: '/reports/[id]', params: { id: report.id } })}
            style={({ pressed }) => [styles.pastRow, pressed && styles.pressed]}
            accessibilityRole="button">
            <Text style={styles.pastDate}>{formatDateJa(report.trading_date)}・{reportTypeLabel(report.report_type)}</Text>
            <Text style={styles.pastTitle} numberOfLines={2}>{report.title_ja}</Text>
          </Pressable>
        ))}

        <View style={styles.alertCard}>
          <Text style={styles.alertTitle}>共通の朝刊・大引けの通知</Text>
          {toggleRow('morning_report', '朝刊の通知')}
          {toggleRow('close_report', '大引けの通知')}
          {!!settingsError && <Text style={styles.alertError}>{settingsError}</Text>}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  container: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 110, gap: 12 },
  eyebrow: { color: colors.accent, fontWeight: '900', letterSpacing: 2, fontSize: 12 },
  title: { color: colors.text, fontSize: 30, fontWeight: '900', marginTop: -6 },
  description: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  status: { marginTop: 24 },
  entryCard: { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 4 },
  entryAccent: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoft },
  entryTitle: { color: colors.text, fontWeight: '900', fontSize: 15 },
  entryText: { color: colors.accent, fontWeight: '700', fontSize: 12 },
  sectionTitle: { color: colors.text, fontWeight: '900', fontSize: 15, marginTop: 8 },
  sectionNote: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: -6 },
  subSectionTitle: { color: colors.muted, fontWeight: '800', fontSize: 13, marginTop: 4 },
  todayCard: { backgroundColor: colors.card, borderRadius: 18, borderWidth: 1, borderColor: colors.border, padding: 17 },
  todayCardEmpty: { backgroundColor: colors.accentSoft, borderStyle: 'dashed' },
  pressed: { opacity: 0.85 },
  cardHead: { flexDirection: 'row', alignItems: 'center' },
  typeBadge: { color: colors.accent, backgroundColor: colors.accentSoft, fontWeight: '900', fontSize: 12, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5, overflow: 'hidden' },
  closeBadge: { color: '#2f4f86', backgroundColor: '#e6edf8' },
  todayBadge: { color: '#fff', backgroundColor: colors.accent, fontWeight: '900', fontSize: 11, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4, marginLeft: 6, overflow: 'hidden' },
  time: { color: colors.muted, fontSize: 12, marginLeft: 'auto' },
  cardDate: { color: colors.muted, fontWeight: '800', fontSize: 12, marginTop: 8 },
  unconfirmed: { color: '#946222', fontSize: 12, lineHeight: 18, marginTop: 6 },
  cardTitle: { color: colors.text, fontWeight: '900', fontSize: 19, lineHeight: 26, marginTop: 4 },
  cardSummary: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 6 },
  more: { color: colors.accent, fontWeight: '800', fontSize: 13, marginTop: 10, textAlign: 'right' },
  emptyText: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 10 },
  alertCard: { backgroundColor: colors.accentSoft, borderRadius: 16, padding: 14, gap: 4, marginTop: 4 },
  alertTitle: { color: colors.text, fontWeight: '800', fontSize: 14 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2 },
  toggleLabel: { color: colors.text, fontSize: 14 },
  alertError: { color: colors.errorText, fontSize: 12 },
  errorCard: { borderRadius: 18, backgroundColor: colors.errorSoft, padding: 18, alignItems: 'center' },
  errorText: { color: colors.errorText, textAlign: 'center', lineHeight: 21 },
  retryButton: { marginTop: 12, borderRadius: 10, backgroundColor: colors.accent, paddingHorizontal: 16, paddingVertical: 10 },
  retryText: { color: '#fff', fontWeight: '800' },
  pastRow: { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14 },
  pastDate: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  pastTitle: { color: colors.text, fontWeight: '800', fontSize: 15, lineHeight: 21, marginTop: 4 },
});
