// worker の DB との境界（PostgREST の RPC と SELECT）と、Cron からの呼び出しの認証。index.ts から使い、テストからも使う。

import type { PipelineDb } from "./analysis_pipeline.ts";
import type { AnalysisResult, ClaimedJob, WorkerStore } from "./worker_logic.ts";

export function isAuthorizedCronCaller(req: Request, expected: string | undefined): boolean {
  const provided = req.headers.get("X-Cron-Secret");
  return typeof expected === "string" && expected.length > 0 && provided === expected;
}

export function restDb(supabaseUrl: string, secretKey: string, fetchImpl: typeof fetch = fetch): PipelineDb {
  const headers = {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
  };
  return {
    async get<T>(path: string) {
      const result = await fetchImpl(`${supabaseUrl}/rest/v1/${path}`, { headers });
      if (!result.ok) throw new Error(`REST_GET_FAILED:${path.split("?")[0]}:${result.status}`);
      return await result.json() as T;
    },
    async rpc<T>(name: string, args: Record<string, unknown>) {
      const result = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
        method: "POST", headers, body: JSON.stringify(args),
      });
      if (!result.ok) throw new Error(`REST_RPC_FAILED:${name}:${result.status}`);
      const text = await result.text();
      return (text ? JSON.parse(text) : null) as T;
    },
  };
}

function statusOf(value: unknown): string {
  const status = (value as { status?: unknown } | null)?.status;
  return typeof status === "string" ? status : "unknown";
}

/** ジョブの状態の変更は、すべて DB の RPC（貸し出しの token と版を添える）。 */
export function rpcStore(db: PipelineDb): WorkerStore {
  return {
    async claim(limit) {
      const rows = await db.rpc<ClaimedJob[]>("claim_personalized_analysis_jobs", { p_limit: limit });
      return Array.isArray(rows) ? rows : [];
    },
    async complete(job: ClaimedJob, result: AnalysisResult) {
      return statusOf(await db.rpc("complete_personalized_analysis_job", {
        p_job_id: job.job_id, p_lease_token: job.lease_token, p_lease_version: job.lease_version, p_result: result,
      }));
    },
    async fail(job, code, retryable) {
      return statusOf(await db.rpc("fail_personalized_analysis_job", {
        p_job_id: job.job_id, p_lease_token: job.lease_token, p_lease_version: job.lease_version,
        p_error_code: code, p_retryable: retryable,
      }));
    },
    async pendingNotifications(limit) {
      const rows = await db.get<Array<{ id: string }>>(
        "personalized_analysis_jobs?status=eq.completed&notify_status=in.(pending,failed)&notify_attempt_count=lt.3" +
          `&select=id&order=completed_at.asc&limit=${limit}`,
      );
      return (rows ?? []).map((row) => row.id);
    },
    async enqueueNotification(jobId) {
      return statusOf(await db.rpc("enqueue_personalized_analysis_notification", { p_job_id: jobId }));
    },
    async markNotificationFailed(jobId) {
      await db.rpc("mark_personalized_analysis_notification_failed", { p_job_id: jobId });
    },
  };
}
