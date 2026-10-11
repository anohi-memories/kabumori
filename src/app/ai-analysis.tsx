import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { fetchAnalysisStatus, fetchRecentAnalysisJobs, requestAnalysis } from '@/lib/ondemand-analysis';
import {
  ANALYSIS_NOTE_JA,
  SCOPES,
  failureReasonJa,
  jobStatusLabel,
  newClientRequestId,
  remainingToday,
  requestOutcome,
  scopeLabel,
  shouldRefresh,
  type AnalysisJob,
  type AnalysisScope,
  type AnalysisStatus,
  type RequestOutcome,
} from '@/lib/ondemand-analysis-presentation';
import { formatDateJa, formatTimeJa } from '@/lib/report-presentation';

const colors = KABUMORI_COLORS.light;
const REFRESH_MS = 10_000;

// 保有銘柄のAI分析（オンデマンド）。依頼はサーバーのジョブになり、サーバーの worker が分析する。
// アプリを閉じても処理は続き、完成したら通知が届く。この画面の再読み込みは、表示を新しくするためだけ。
export default function AiAnalysisScreen() {
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<RequestOutcome | null>(null);
  // 通信が途中で切れたときに同じ ID で送り直す（サーバーで同じジョブになり、二重に作られない）。
  const pending = useRef<{ scope: AnalysisScope; id: string } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const nextStatus = await fetchAnalysisStatus();
      setStatus(nextStatus);
      setJobs(nextStatus.enabled ? await fetchRecentAnalysisJobs() : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '読み込めませんでした。');
    } finally {
      setLoading(false);
    }
  }, []);

  const active = shouldRefresh(jobs);
  useFocusEffect(useCallback(() => {
    void load();
    if (!active) return undefined;
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, active]));

  const submit = useCallback(async (scope: AnalysisScope) => {
    if (submitting) return;
    if (!pending.current || pending.current.scope !== scope) pending.current = { scope, id: newClientRequestId() };
    setSubmitting(true);
    setOutcome(null);
    try {
      const result = requestOutcome(await requestAnalysis(scope, pending.current.id));
      pending.current = null;
      setOutcome(result);
      await load();
    } catch {
      setOutcome({ kind: 'error', jobId: null, message: '通信できませんでした。もう一度押すと、同じ依頼として送り直します。' });
    } finally {
      setSubmitting(false);
    }
  }, [load, submitting]);

  const remaining = status ? remainingToday(status) : null;
  const busy = status?.enabled === true && status.activeJobId !== null;
  const canRequest = status?.enabled === true && !busy && !submitting && (remaining ?? 0) > 0;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={colors.accent} />}>
        <BackButton />
        <Text style={styles.eyebrow}>AI ANALYSIS</Text>
        <Text style={styles.title}>保有銘柄のAI分析</Text>
        <Text style={styles.body}>{ANALYSIS_NOTE_JA}</Text>

        {loading ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
        {!!error && <Text style={styles.error}>{error}</Text>}

        {!loading && status && !status.enabled && (
          <View style={styles.card}>
            <Text style={styles.cardText}>この機能は準備中です。公開までもうしばらくお待ちください。</Text>
          </View>
        )}

        {status?.enabled && (
          <>
            <Text style={styles.remaining}>
              今日あと{remaining}回（1日{status.dailyLimit}回まで）
              {busy ? '・分析中のものが完成すると、次を依頼できます' : ''}
            </Text>
            {SCOPES.map((entry) => (
              <Pressable
                key={entry.scope}
                disabled={!canRequest}
                onPress={() => void submit(entry.scope)}
                style={({ pressed }) => [styles.scopeButton, !canRequest && styles.disabled, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canRequest }}>
                <Text style={styles.scopeLabel}>{entry.label}</Text>
                <Text style={styles.scopeHint}>{entry.hint}</Text>
              </Pressable>
            ))}
            {submitting ? <ActivityIndicator color={colors.accent} /> : null}
            {!!outcome && (
              <Text style={[styles.outcome, outcome.kind === 'error' && styles.error]}>{outcome.message}</Text>
            )}
            <Text style={styles.footnote}>分析には通常のAIモデルを使います。上位のモデルは準備中です。</Text>

            {jobs.length > 0 && <Text style={styles.sectionTitle}>依頼した分析</Text>}
            {jobs.map((job) => (
              <Pressable
                key={job.id}
                disabled={job.status !== 'completed'}
                onPress={() => router.push({ pathname: '/report-detail', params: { id: job.id, source: 'analysis' } })}
                style={({ pressed }) => [styles.jobRow, pressed && styles.pressed]}
                accessibilityRole="button">
                <View style={styles.jobHead}>
                  <Text style={styles.jobScope}>{scopeLabel(job.scope)}</Text>
                  <Text style={[styles.jobStatus, job.status === 'failed' && styles.error]}>{jobStatusLabel(job)}</Text>
                </View>
                <Text style={styles.jobMeta}>
                  {formatDateJa(job.request_date)} {formatTimeJa(job.requested_at)} に依頼
                  {job.status === 'completed' ? '・読む ›' : ''}
                </Text>
                {job.status === 'failed' && <Text style={styles.jobReason}>{failureReasonJa(job.error_code)}</Text>}
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 60, gap: 10 },
  eyebrow: { color: colors.accent, fontWeight: '900', letterSpacing: 2, fontSize: 11, marginTop: 8 },
  title: { color: colors.text, fontSize: 26, fontWeight: '900' },
  body: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  status: { marginTop: 24 },
  card: { backgroundColor: colors.accentSoft, borderRadius: 16, padding: 16 },
  cardText: { color: colors.text, fontSize: 14, lineHeight: 21 },
  remaining: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 4 },
  scopeButton: { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 15 },
  scopeLabel: { color: colors.text, fontWeight: '900', fontSize: 16 },
  scopeHint: { color: colors.muted, fontSize: 13, marginTop: 4 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.85 },
  outcome: { color: colors.text, fontSize: 14, lineHeight: 21 },
  error: { color: colors.errorText },
  footnote: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  sectionTitle: { color: colors.text, fontWeight: '900', fontSize: 15, marginTop: 12 },
  jobRow: { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14 },
  jobHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  jobScope: { color: colors.text, fontWeight: '800', fontSize: 15 },
  jobStatus: { color: colors.accent, fontWeight: '800', fontSize: 13 },
  jobMeta: { color: colors.muted, fontSize: 12, marginTop: 4 },
  jobReason: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
});
