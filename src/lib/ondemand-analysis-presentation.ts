// オンデマンド個別AI分析と、アプリ向けの共通朝刊・大引けの表示（純粋な関数。AI もネットワークも呼ばない）。
//
// 処理はすべてサーバー（personalized-analysis-worker）が行う。アプリは依頼を出して、状態と完成した結果を読むだけ。
// アプリを閉じても分析は続き、完成したら通知が1件届く。画面を開いている間の再読み込みは表示のためだけ。

import type { PersonalizedReport, ReportBody, ReportSnapshot, ReportType } from './report-presentation';

// 日付つきの表示（basisLabel・marketReportDateLine・marketReportEmptyText）は report-presentation.ts にある
// （このファイルは型だけを読み込み、テストから単体で動かせるようにしている）。

export type AnalysisScope = 'morning' | 'close' | 'latest';
export type AnalysisJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type AnalysisJob = {
  id: string;
  scope: AnalysisScope;
  request_date: string;
  status: AnalysisJobStatus;
  requested_at: string;
  completed_at: string | null;
  error_code: string | null;
};

export type AnalysisStatus = {
  /** オンデマンド分析を受け付けているか。 */
  enabled: boolean;
  /** アプリ向けの共通朝刊・大引けを公開しているか。 */
  marketFeedEnabled: boolean;
  dailyLimit: number;
  usedToday: number;
  activeJobId: string | null;
  activeStatus: AnalysisJobStatus | null;
};

export const STATUS_OFF: AnalysisStatus = {
  enabled: false, marketFeedEnabled: false, dailyLimit: 0, usedToday: 0, activeJobId: null, activeStatus: null,
};

export const SCOPES: ReadonlyArray<{ scope: AnalysisScope; label: string; hint: string }> = [
  { scope: 'latest', label: 'いちばん新しい市況で分析', hint: '最新の朝刊・大引けを基準にします' },
  { scope: 'morning', label: '朝刊の視点で分析', hint: '今日の見通しと、保有株への影響' },
  { scope: 'close', label: '大引けの視点で分析', hint: '今日の値動きと、保有株への影響' },
];

export const ANALYSIS_NOTE_JA =
  '依頼するとサーバーで分析します。アプリを閉じても続き、完成したら通知でお知らせします。';

export function scopeLabel(scope: AnalysisScope): string {
  return SCOPES.find((entry) => entry.scope === scope)?.label ?? '分析';
}

export function parseAnalysisStatus(value: unknown): AnalysisStatus {
  const row = (value ?? {}) as Record<string, unknown>;
  const marketFeedEnabled = row.market_feed_enabled === true;
  if (row.enabled !== true) return { ...STATUS_OFF, marketFeedEnabled };
  const number = (input: unknown) => (typeof input === 'number' && Number.isFinite(input) ? input : 0);
  const status = row.active_status;
  return {
    enabled: true,
    marketFeedEnabled,
    dailyLimit: number(row.daily_limit),
    usedToday: number(row.used_today),
    activeJobId: typeof row.active_job_id === 'string' ? row.active_job_id : null,
    activeStatus: status === 'queued' || status === 'processing' ? status : null,
  };
}

export function remainingToday(status: AnalysisStatus): number | null {
  return status.enabled ? Math.max(0, status.dailyLimit - status.usedToday) : null;
}

export type RequestOutcome = { kind: 'accepted' | 'info' | 'error'; jobId: string | null; message: string };

/** request_personalized_analysis の返り値を、利用者向けの文に（内部のコードは見せない）。 */
export function requestOutcome(value: unknown): RequestOutcome {
  const row = (value ?? {}) as Record<string, unknown>;
  const jobId = typeof row.job_id === 'string' ? row.job_id : null;
  switch (row.status) {
    case 'queued':
      return { kind: 'accepted', jobId, message: '分析を受け付けました。完成したら通知でお知らせします（アプリを閉じても続きます）。' };
    case 'replayed':
      return { kind: 'accepted', jobId, message: '分析を受け付けています。完成までお待ちください。' };
    case 'already_active':
      return { kind: 'info', jobId, message: '分析中のものがあります。完成してから、もう一度お試しください。' };
    case 'daily_limit_reached':
      return {
        kind: 'info', jobId: null,
        message: `今日の分析の回数（${typeof row.limit === 'number' ? row.limit : '上限'}回）に達しました。明日またお試しください。`,
      };
    case 'no_tracked_stocks':
      return { kind: 'info', jobId: null, message: '保有・ウォッチ銘柄を登録すると、分析できます。' };
    case 'disabled':
      return { kind: 'info', jobId: null, message: 'この機能は準備中です。' };
    default:
      return { kind: 'error', jobId: null, message: '受け付けられませんでした。時間をおいてもう一度お試しください。' };
  }
}

export function jobStatusLabel(job: Pick<AnalysisJob, 'status'>): string {
  return { queued: '順番待ち', processing: '分析中', completed: '完成', failed: '作成できませんでした' }[job.status];
}

/** 失敗の理由（内部のコードは見せず、利用者が次にできることだけを書く）。 */
export function failureReasonJa(code: string | null): string {
  if (code === 'NO_TRACKED_STOCKS') return '保有・ウォッチ銘柄が登録されていませんでした。';
  if (code === 'MARKET_REPORT_UNAVAILABLE' || code === 'MARKET_REPORT_NOT_READY') {
    return '基準にする朝刊・大引けがまだできていませんでした。少し時間をおいてお試しください。';
  }
  if (code?.startsWith('REPORT_FACT_FAILED') || code === 'REPORT_LOCAL_CHECK_FAILED') {
    return '内容の確認で基準を満たさなかったため、表示していません。もう一度お試しください。';
  }
  return '時間をおいて、もう一度お試しください。';
}

export function shouldRefresh(jobs: readonly Pick<AnalysisJob, 'status'>[]): boolean {
  return jobs.some((job) => job.status === 'queued' || job.status === 'processing');
}

/** 依頼の重複を防ぐ ID（二重タップ・再送で同じジョブになる）。秘密ではないので乱数の質は問わない。 */
export function newClientRequestId(random: () => number = Math.random): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256) & 0xff);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type AnalysisResultRow = {
  job_id: string;
  report_type: ReportType;
  trading_date: string;
  title_ja: string;
  summary_ja: string | null;
  body: ReportBody | null;
  portfolio_snapshot: ReportSnapshot | null;
  generated_at: string | null;
};

/** 分析結果を、個別レポートの詳細画面がそのまま描ける形に。 */
export function analysisAsReport(row: AnalysisResultRow): PersonalizedReport {
  return {
    id: row.job_id,
    report_type: row.report_type,
    trading_date: row.trading_date,
    title_ja: row.title_ja,
    summary_ja: row.summary_ja,
    body: row.body,
    portfolio_snapshot: row.portfolio_snapshot,
    generated_at: row.generated_at,
  };
}

// ---------------------------------------------------------------------------
// 共通の朝刊・大引け（get_app_market_report が返す、公開してよい項目だけ）
// ---------------------------------------------------------------------------

/** 共通の市況の画面の引数（通知から開いたときの種類と日付）。不正な値は無視して、朝刊の最新の回にする。 */
export function marketReportParams(params: { type?: unknown; date?: unknown }): { type: ReportType; date: string | null } {
  const type: ReportType = params.type === 'close' ? 'close' : 'morning';
  const date = typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : null;
  return { type, date };
}

/** AI が書いた市況のお話（公開してよい8つの文章。空の文章もある）。V2 の回だけにある。 */
export type AppMarketStory = {
  summaryJa: string;
  overseasJa: string;
  japanJa: string;
  crossAssetJa: string;
  newsJa: string;
  strongJa: string;
  cautionJa: string;
  watchJa: string;
};

export type YumeStance = 'up' | 'down' | 'flat';
export type YumeVerdict = 'hit' | 'partial' | 'miss' | 'undeterminable';

/** 朝の予想の答え合わせ（判定はサーバーのコードが決めたもの。text_ja はゆめちゃんのことば）。 */
export type AppYumeReview = {
  verdict: YumeVerdict;
  reasonCode: string;
  morningStance: YumeStance | null;
  morningHeadlineJa: string | null;
  actualChangeDisplay: string | null;
  actualSessionDate: string | null;
  textJa: string;
};

/** ゆめちゃん（AI）の見立て。意見であって事実ではない（事実の項目とは分けて表示する）。 */
export type AppYumeView = {
  stance: YumeStance;
  horizon: 'this_session' | 'next_session';
  horizonDate: string | null;
  flatBandPct: number;
  headlineJa: string;
  reasonsJa: string;
  scenarioJa: string;
  counterJa: string;
  invalidationJa: string;
  review: AppYumeReview | null;
};

export type AppSessionView = { market: 'tokyo' | 'us'; sessionDate: string | null; direction: string };
export type NewsScope = 'broad' | 'sector' | 'company';
export type MarketMove = {
  label: string;
  value: string;
  change: string | null;
  sessionDate: string;
  stale: boolean;
  metricKey: string | null;
};
export type MarketNews = { headlineJa: string; whyJa: string; scope: NewsScope | null };

export type AppMarketReport =
  | { status: 'disabled' }
  | { status: 'missing' | 'not_ready'; reportType: ReportType; tradingDate: string | null }
  | {
    status: 'completed';
    reportType: ReportType;
    tradingDate: string;
    isToday: boolean;
    headlineJa: string;
    summaryJa: string;
    direction: string;
    pointsJa: string[];
    majorMoves: MarketMove[];
    claims: Array<{ textJa: string; claimType: string; scope: string }>;
    keyNews: MarketNews[];
    strongThemes: string[];
    weakThemes: string[];
    nextWatchJa: string[];
    risksJa: string[];
    dataGapsJa: string[];
    generatedAt: string | null;
    // ここから V2（get_app_market_report の追加の項目）。古い回・古いサーバーでは null / []。
    presentationVersion: string | null;
    appStory: AppMarketStory | null;
    sessionViews: AppSessionView[];
    yume: AppYumeView | null;
    /** 元の市場データを取得した時刻（ISO 8601）。 */
    dataGeneratedAt: string | null;
  };

export type CompletedMarketReport = Extract<AppMarketReport, { status: 'completed' }>;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
const objects = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const STANCES: readonly YumeStance[] = ['up', 'down', 'flat'];
const VERDICTS: readonly YumeVerdict[] = ['hit', 'partial', 'miss', 'undeterminable'];
const NEWS_SCOPES: readonly NewsScope[] = ['broad', 'sector', 'company'];
/** 横ばいの帯（サーバーの YUME_FLAT_BAND_PCT と同じ）。記録に帯が無い・壊れているときだけ使う。 */
export const YUME_DEFAULT_FLAT_BAND_PCT = 0.3;
const stanceOf = (value: unknown): YumeStance | null => (STANCES.includes(value as YumeStance) ? value as YumeStance : null);

function parseAppStory(value: unknown): AppMarketStory | null {
  const row = record(value);
  if (!row) return null;
  return {
    summaryJa: text(row.summary_ja),
    overseasJa: text(row.overseas_ja),
    japanJa: text(row.japan_ja),
    crossAssetJa: text(row.cross_asset_ja),
    newsJa: text(row.news_ja),
    strongJa: text(row.strong_ja),
    cautionJa: text(row.caution_ja),
    watchJa: text(row.watch_ja),
  };
}

function parseYumeReview(value: unknown): AppYumeReview | null {
  const row = record(value);
  if (!row || !VERDICTS.includes(row.verdict as YumeVerdict)) return null;
  return {
    verdict: row.verdict as YumeVerdict,
    reasonCode: text(row.reason_code),
    morningStance: stanceOf(row.morning_stance),
    morningHeadlineJa: textOrNull(row.morning_headline_ja),
    actualChangeDisplay: textOrNull(row.actual_change_display),
    actualSessionDate: textOrNull(row.actual_session_date),
    textJa: text(row.text_ja),
  };
}

/** ゆめちゃんの見立て。予想・期間・見出し・理由のどれかが欠けたら出さない（null）。 */
function parseYume(value: unknown): AppYumeView | null {
  const row = record(value);
  const stance = stanceOf(row?.stance);
  if (!row || !stance || (row.horizon !== 'this_session' && row.horizon !== 'next_session')) return null;
  const headlineJa = text(row.headline_ja).trim();
  const reasonsJa = text(row.reasons_ja).trim();
  if (!headlineJa || !reasonsJa) return null;
  const band = row.flat_band_pct;
  return {
    stance,
    horizon: row.horizon,
    horizonDate: textOrNull(row.horizon_date),
    flatBandPct: typeof band === 'number' && Number.isFinite(band) && band > 0 ? band : YUME_DEFAULT_FLAT_BAND_PCT,
    headlineJa,
    reasonsJa,
    scenarioJa: text(row.scenario_ja).trim(),
    counterJa: text(row.counter_ja).trim(),
    invalidationJa: text(row.invalidation_ja).trim(),
    review: parseYumeReview(row.review),
  };
}

export function parseAppMarketReport(value: unknown, requested: ReportType): AppMarketReport {
  const row = (value ?? {}) as Record<string, unknown>;
  const reportType: ReportType = row.report_type === 'close' || row.report_type === 'morning' ? row.report_type : requested;
  if (row.status === 'disabled') return { status: 'disabled' };
  if (row.status !== 'completed' || typeof row.trading_date !== 'string' || !text(row.headline_ja)) {
    return {
      status: row.status === 'not_ready' ? 'not_ready' : 'missing',
      reportType,
      tradingDate: typeof row.trading_date === 'string' ? row.trading_date : null,
    };
  }
  return {
    status: 'completed',
    reportType,
    tradingDate: row.trading_date,
    isToday: row.is_today === true,
    headlineJa: text(row.headline_ja),
    summaryJa: text(row.market_summary_ja),
    direction: text(row.market_direction),
    pointsJa: strings(row.points_ja),
    majorMoves: objects(row.major_moves).filter((move) => text(move.label) && text(move.value_display)).map((move) => ({
      label: text(move.label),
      value: text(move.value_display),
      change: text(move.change_pct_display) || null,
      sessionDate: text(move.session_date),
      stale: move.freshness === 'stale',
      metricKey: textOrNull(move.metric_key),
    })),
    claims: objects(row.claims).filter((claim) => text(claim.text_ja)).map((claim) => ({
      textJa: text(claim.text_ja), claimType: text(claim.claim_type), scope: text(claim.scope),
    })),
    keyNews: objects(row.key_news).filter((news) => text(news.headline_ja)).map((news) => ({
      headlineJa: text(news.headline_ja),
      whyJa: text(news.why_it_matters_ja),
      scope: NEWS_SCOPES.includes(news.scope as NewsScope) ? news.scope as NewsScope : null,
    })),
    strongThemes: strings(row.strong_themes),
    weakThemes: strings(row.weak_themes),
    nextWatchJa: strings(row.next_watch_ja),
    risksJa: strings(row.risks_ja),
    dataGapsJa: strings(row.data_gaps_ja),
    generatedAt: typeof row.generated_at === 'string' ? row.generated_at : null,
    presentationVersion: textOrNull(row.presentation_version),
    appStory: parseAppStory(row.app_story),
    sessionViews: objects(row.session_views)
      .filter((view) => (view.market === 'tokyo' || view.market === 'us') && text(view.direction))
      .map((view) => ({
        market: view.market as 'tokyo' | 'us',
        sessionDate: textOrNull(view.session_date),
        direction: text(view.direction),
      })),
    yume: parseYume(row.yume),
    dataGeneratedAt: textOrNull(row.data_generated_at),
  };
}
