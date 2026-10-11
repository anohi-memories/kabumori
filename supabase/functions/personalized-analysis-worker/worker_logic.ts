// オンデマンド分析の worker の1回の実行（DB と分析の処理は差し替え可能。テストでは手元の模型を使う）。
//
//   1. 引き取る: claim_personalized_analysis_jobs(batch)。DB が先着順・同時に動かせる数の上限・1人1件を守り、
//      ジョブごとに新しい貸し出しの token と版を渡す。
//   2. 分析する: 引き取ったジョブを並行して処理する（数は batch まで）。貸し出しの残りが短すぎるジョブは
//      AI を呼ばずに待ち行列へ戻す。
//   3. 書き込む: 完了・失敗は token と版を添えて DB に渡す。DB は、期限内で token と版が一致するときだけ
//      受け付ける（遅れて終わった worker の書き込みは lease_lost で捨てられる）。
//   4. 通知を予約する: 完成して予約がまだのジョブを古い順に予約する（この回の完成分と、前回までに予約できなかった分）。
//      予約に失敗しても、完成した結果は変わらない。印を付けて次回に回す（最大3回）。
// アプリが閉じていても、この worker は DB の Cron（毎分）から動くので処理は止まらない。

import { isRetryable, safeCode, type AnalysisScope } from "./market_basis.ts";

export type ClaimedJob = {
  job_id: string;
  user_id: string;
  scope: AnalysisScope;
  request_date: string;
  model_tier: string;
  attempt_count: number;
  max_attempts: number;
  lease_token: string;
  lease_version: number;
  lease_expires_at: string;
};

export type AnalysisResult = {
  title_ja: string;
  summary_ja: string;
  body: Record<string, unknown>;
  portfolio_snapshot: unknown;
  source_basis: Record<string, unknown>;
  fact_status: "passed";
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  api_cost_usd: number;
  reference_report_packet_id: string;
  reference_data_packet_id: string | null;
  report_type: "morning" | "close";
  trading_date: string;
};

export type AnalyzeOutcome =
  | { kind: "completed"; result: AnalysisResult; calls: number }
  | { kind: "failed"; code: string; retryable: boolean; calls: number };

export type WorkerStore = {
  claim(limit: number): Promise<ClaimedJob[]>;
  complete(job: ClaimedJob, result: AnalysisResult): Promise<string>;
  fail(job: ClaimedJob, code: string, retryable: boolean): Promise<string>;
  pendingNotifications(limit: number): Promise<string[]>;
  enqueueNotification(jobId: string): Promise<string>;
  markNotificationFailed(jobId: string): Promise<void>;
};

export type Analyze = (job: ClaimedJob) => Promise<AnalyzeOutcome>;

/** 分析1件にかかる最長の時間（AI の呼び出し 90 秒 × 2 と、株価・ニュースの読み込み）より長い残りが要る。 */
export const MIN_LEASE_REMAINING_MS = 200_000;
export const DEFAULT_BATCH = 4;
export const MAX_BATCH = 10;
export const NOTIFICATION_SWEEP_LIMIT = 50;

export type JobReport = {
  job: string;
  user: string;
  outcome: "completed" | "failed" | "requeued" | "lease_lost" | "skipped_short_lease" | "error";
  code?: string;
  calls?: number;
};

export type WorkerReport = {
  claimed: number;
  jobs: JobReport[];
  notifications: { queued: number; skipped: number; already: number; failed: number };
};

export async function runWorker(
  store: WorkerStore,
  analyze: Analyze,
  options: { batch?: number; now?: () => number; log?: (event: Record<string, unknown>) => void } = {},
): Promise<WorkerReport> {
  const batch = Math.max(1, Math.min(MAX_BATCH, Math.trunc(options.batch ?? DEFAULT_BATCH)));
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});

  const jobs = await store.claim(batch);
  const reports = await Promise.all(jobs.map((job) => processJob(store, analyze, job, now, log)));
  const notifications = await sweepNotifications(store, log);
  return { claimed: jobs.length, jobs: reports, notifications };
}

async function processJob(
  store: WorkerStore,
  analyze: Analyze,
  job: ClaimedJob,
  now: () => number,
  log: (event: Record<string, unknown>) => void,
): Promise<JobReport> {
  const base = { job: job.job_id.slice(0, 8), user: job.user_id.slice(0, 8) };
  try {
    if (Date.parse(job.lease_expires_at) - now() < MIN_LEASE_REMAINING_MS) {
      // 貸し出しの残りが短い: AI を呼ばずに返す（途中で期限が切れて、費用だけかかるのを避ける）。
      const status = await store.fail(job, "LEASE_TOO_SHORT", true);
      return { ...base, outcome: status === "lease_lost" ? "lease_lost" : "skipped_short_lease" };
    }
    const outcome = await analyze(job);
    if (outcome.kind === "completed") {
      const status = await store.complete(job, outcome.result);
      log({ event: "personalized_analysis_job", ...base, status, calls: outcome.calls });
      return { ...base, outcome: status === "completed" ? "completed" : "lease_lost", calls: outcome.calls };
    }
    const status = await store.fail(job, outcome.code, outcome.retryable && isRetryable(outcome.code));
    log({ event: "personalized_analysis_job", ...base, status, code: outcome.code, calls: outcome.calls });
    return {
      ...base,
      outcome: status === "requeued" ? "requeued" : status === "failed" ? "failed" : "lease_lost",
      code: outcome.code,
      calls: outcome.calls,
    };
  } catch (error) {
    // 予期しない例外（読み込みの失敗など）: 再試行できる失敗として返す。返せなくても、貸し出しの期限切れで
    // 次の実行が引き取り直す。
    const code = safeCode(error);
    const status = await store.fail(job, code, true).catch(() => "unreported");
    log({ event: "personalized_analysis_job", ...base, status, code });
    return { ...base, outcome: status === "requeued" ? "requeued" : status === "failed" ? "failed" : "error", code };
  }
}

async function sweepNotifications(store: WorkerStore, log: (event: Record<string, unknown>) => void) {
  const counts = { queued: 0, skipped: 0, already: 0, failed: 0 };
  let ids: string[] = [];
  try {
    ids = await store.pendingNotifications(NOTIFICATION_SWEEP_LIMIT);
  } catch {
    // 一覧が読めなければ次の実行で予約する（完成した結果には影響しない）。
    return counts;
  }
  for (const id of ids) {
    try {
      const status = await store.enqueueNotification(id);
      if (status === "queued") counts.queued += 1;
      else if (status === "skipped") counts.skipped += 1;
      else counts.already += 1;
    } catch (error) {
      counts.failed += 1;
      log({ event: "personalized_analysis_notification_failed", job: id.slice(0, 8), code: safeCode(error) });
      await store.markNotificationFailed(id).catch(() => {});
    }
  }
  return counts;
}
