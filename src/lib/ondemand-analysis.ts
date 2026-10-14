import { supabase } from '@/lib/supabase';
import {
  analysisAsReport,
  parseAnalysisStatus,
  parseAppMarketReport,
  STATUS_OFF,
  type AnalysisJob,
  type AnalysisResultRow,
  type AnalysisScope,
  type AnalysisStatus,
  type AppMarketReport,
} from '@/lib/ondemand-analysis-presentation';
import type { PersonalizedReport, ReportType } from '@/lib/report-presentation';

// オンデマンド個別AI分析と、アプリ向けの共通朝刊・大引けの読み書き。すべてログイン中の本人として呼ぶ
// （サーバー側の RPC が auth.uid() で本人を決める。アプリは service_role のキーを持たない）。
// 生成はサーバーの worker が行い、ここでは依頼と読み取りだけをする。

/** 関数がまだ無い（サーバー側が未公開）ときは「準備中」として扱い、画面に入口を出さない。 */
function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === 'PGRST202' || error.code === '42883');
}

export async function fetchAnalysisStatus(): Promise<AnalysisStatus> {
  const { data, error } = await supabase.rpc('get_personalized_analysis_status');
  if (isMissingFunction(error)) return STATUS_OFF;
  if (error) throw new Error('分析の状態を取得できませんでした。');
  return parseAnalysisStatus(data);
}

export async function requestAnalysis(scope: AnalysisScope, clientRequestId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc('request_personalized_analysis', {
    p_scope: scope,
    p_client_request_id: clientRequestId,
    p_model_tier: 'standard',
  });
  if (isMissingFunction(error)) return { status: 'disabled' };
  if (error) throw new Error('分析を依頼できませんでした。');
  return data;
}

const JOB_COLUMNS = 'id,scope,request_date,status,requested_at,completed_at,error_code';

export async function fetchRecentAnalysisJobs(limit = 10): Promise<AnalysisJob[]> {
  const { data, error } = await supabase
    .from('personalized_analysis_jobs')
    .select(JOB_COLUMNS)
    .order('requested_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error('分析の一覧を取得できませんでした。');
  return (data ?? []) as AnalysisJob[];
}

const RESULT_COLUMNS = 'job_id,report_type,trading_date,title_ja,summary_ja,body,portfolio_snapshot,generated_at';

export async function fetchAnalysisReport(jobId: string): Promise<PersonalizedReport | null> {
  const { data, error } = await supabase
    .from('personalized_analysis_results')
    .select(RESULT_COLUMNS)
    .eq('job_id', jobId)
    .maybeSingle();
  if (error) throw new Error('分析を取得できませんでした。');
  return data ? analysisAsReport(data as AnalysisResultRow) : null;
}

/** tradingDate を渡すとその日の回、省略すると直近の完成した回（サーバーが公開してよい項目だけを返す）。 */
export async function fetchAppMarketReport(reportType: ReportType, tradingDate: string | null = null): Promise<AppMarketReport> {
  const { data, error } = await supabase.rpc('get_app_market_report', {
    p_report_type: reportType,
    ...(tradingDate ? { p_trading_date: tradingDate } : {}),
  });
  if (isMissingFunction(error)) return { status: 'disabled' };
  if (error) throw new Error('市況レポートを取得できませんでした。');
  return parseAppMarketReport(data, reportType);
}

/**
 * ホーム「今日のポイント」用に、朝刊と大引けの最新の公開済みの回を 1 回ずつ読む（RPC は 2 回。日付は渡さない）。
 * 片方が失敗してももう片方の結果は捨てない（Promise.allSettled）。どちらを出すかは home-market-report.ts が決める。
 */
export function fetchHomeMarketReports(): Promise<[PromiseSettledResult<AppMarketReport>, PromiseSettledResult<AppMarketReport>]> {
  return Promise.allSettled([fetchAppMarketReport('morning'), fetchAppMarketReport('close')]);
}
