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
import {
  fetchRecentReports,
  fetchReportAlertSettings,
  setReportAlert,
  type ReportAlertSettings,
} from '@/lib/personalized-reports';
import { formatDateJa, formatTimeJa, reportTypeLabel, type PersonalizedReport, type ReportType } from '@/lib/report-presentation';

const colors = KABUMORI_COLORS.light;

function todayJst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const SCHEDULE: Record<ReportType, string> = {
  morning: '平日の朝8時半ごろに届きます',
  close: '平日の17時すぎに届きます',
};

export default function ReportsScreen() {
  const [reports, setReports] = useState<PersonalizedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState<ReportAlertSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReports(await fetchRecentReports());
    } catch {
      setReports([]);
      setError('レポートを読み込めませんでした。');
    } finally {
      setLoading(false);
    }
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

  const today = todayJst();
  const todays = (type: ReportType) => reports.find((report) => report.trading_date === today && report.report_type === type);
  const older = reports.filter((report) => report.trading_date !== today);

  function card(type: ReportType) {
    const report = todays(type);
    return (
      <Pressable
        key={type}
        disabled={!report}
        onPress={() => report && router.push({ pathname: '/reports/[id]', params: { id: report.id } })}
        style={({ pressed }) => [styles.todayCard, !report && styles.todayCardEmpty, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityHint={report ? `${reportTypeLabel(type)}を開きます` : undefined}>
        <View style={styles.cardHead}>
          <Text style={[styles.typeBadge, type === 'close' && styles.closeBadge]}>{reportTypeLabel(type)}</Text>
          {report ? <Text style={styles.time}>{formatTimeJa(report.generated_at)} 更新</Text> : null}
        </View>
        {report ? (
          <>
            <Text style={styles.cardTitle}>{report.title_ja}</Text>
            {!!report.summary_ja && <Text style={styles.cardSummary} numberOfLines={3}>{report.summary_ja}</Text>}
            <Text style={styles.more}>読む ›</Text>
          </>
        ) : (
          <Text style={styles.emptyText}>今日の{reportTypeLabel(type)}はまだありません。{SCHEDULE[type]}。</Text>
        )}
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

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={loading && reports.length > 0} onRefresh={load} tintColor={colors.accent} />}>
        <Text style={styles.eyebrow}>YOUR PORTFOLIO</Text>
        <Text style={styles.title}>あなたのレポート</Text>
        <Text style={styles.description}>
          登録した保有・監視銘柄に合わせて、朝は「今日どこを見るか」、引け後は「今日どう動いたか」をまとめます。
        </Text>

        {loading && reports.length === 0 ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
        {!!error && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={() => void load()} style={styles.retryButton}>
              <Text style={styles.retryText}>もう一度試す</Text>
            </Pressable>
          </View>
        )}

        {!loading || reports.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>今日 {formatDateJa(today)}</Text>
            {card('morning')}
            {card('close')}
          </>
        ) : null}

        <View style={styles.alertCard}>
          <Text style={styles.alertTitle}>完成したら通知</Text>
          {toggleRow('morning_report', '朝刊の通知')}
          {toggleRow('close_report', '大引けレポートの通知')}
          {!!settingsError && <Text style={styles.alertError}>{settingsError}</Text>}
        </View>

        {older.length > 0 && <Text style={styles.sectionTitle}>これまでのレポート</Text>}
        {older.map((report) => (
          <Pressable
            key={report.id}
            onPress={() => router.push({ pathname: '/reports/[id]', params: { id: report.id } })}
            style={({ pressed }) => [styles.pastRow, pressed && styles.pressed]}
            accessibilityRole="button">
            <Text style={styles.pastDate}>{formatDateJa(report.trading_date)}・{reportTypeLabel(report.report_type)}</Text>
            <Text style={styles.pastTitle} numberOfLines={2}>{report.title_ja}</Text>
          </Pressable>
        ))}
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
  sectionTitle: { color: colors.text, fontWeight: '900', fontSize: 15, marginTop: 8 },
  todayCard: { backgroundColor: colors.card, borderRadius: 18, borderWidth: 1, borderColor: colors.border, padding: 17 },
  todayCardEmpty: { backgroundColor: colors.accentSoft, borderStyle: 'dashed' },
  pressed: { opacity: 0.85 },
  cardHead: { flexDirection: 'row', alignItems: 'center' },
  typeBadge: { color: colors.accent, backgroundColor: colors.accentSoft, fontWeight: '900', fontSize: 12, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5, overflow: 'hidden' },
  closeBadge: { color: '#2f4f86', backgroundColor: '#e6edf8' },
  time: { color: colors.muted, fontSize: 12, marginLeft: 'auto' },
  cardTitle: { color: colors.text, fontWeight: '900', fontSize: 19, lineHeight: 26, marginTop: 10 },
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
