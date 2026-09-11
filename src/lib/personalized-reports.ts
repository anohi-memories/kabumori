import { supabase } from '@/lib/supabase';
import type { PersonalizedReport } from '@/lib/report-presentation';

// Reads stored reports only. RLS returns just the signed-in user's completed,
// Fact-passed rows; nothing is generated at display time.
const COLUMNS = 'id,report_type,trading_date,title_ja,summary_ja,body,portfolio_snapshot,generated_at';

export async function fetchRecentReports(limit = 14): Promise<PersonalizedReport[]> {
  const { data, error } = await supabase
    .from('personalized_reports')
    .select('id,report_type,trading_date,title_ja,summary_ja,generated_at')
    .order('trading_date', { ascending: false })
    .order('report_type', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`レポートを取得できませんでした。${error.message}`);
  return (data ?? []).map((row) => ({ ...row, body: null, portfolio_snapshot: null })) as PersonalizedReport[];
}

export async function fetchReport(id: string): Promise<PersonalizedReport | null> {
  const { data, error } = await supabase
    .from('personalized_reports')
    .select(COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`レポートを取得できませんでした。${error.message}`);
  return (data as PersonalizedReport | null) ?? null;
}

export type ReportAlertSettings = { morning_report: boolean; close_report: boolean };

export async function fetchReportAlertSettings(): Promise<ReportAlertSettings | null> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return null;
  const { data, error } = await supabase
    .from('alert_settings')
    .select('morning_report,close_report')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw new Error(`通知設定を取得できませんでした。${error.message}`);
  // Without a row nothing is sent (the push producer requires a row).
  return { morning_report: data?.morning_report === true, close_report: data?.close_report === true };
}

export async function setReportAlert(column: keyof ReportAlertSettings, enabled: boolean): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error('通知設定を変更するにはログインが必要です。');
  const { error } = await supabase
    .from('alert_settings')
    .upsert({ user_id: userData.user.id, [column]: enabled }, { onConflict: 'user_id' });
  if (error) throw new Error(`通知設定を保存できませんでした。${error.message}`);
}
