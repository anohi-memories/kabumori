// Edge Function wall-clock limits are 150s (free) / 400s (pro) per Supabase's documented plan tiers.
// A stale threshold must clear the higher of those with margin, or reconciliation could fail a run that
// is still legitimately executing.
export const MORNING_REPORT_STALE_RUN_THRESHOLD_MS = 10 * 60 * 1000;
export const MORNING_REPORT_STALE_RUN_ERROR = "MORNING_REPORT_STALE_RUNTIME_TERMINATION";
export const MORNING_REPORT_STALE_RECONCILIATION_FAILED = "MORNING_REPORT_STALE_RECONCILIATION_FAILED";

export const MORNING_REPORT_MAX_ATTEMPTS = 3;
export const MORNING_REPORT_RETRY_BASE_DELAY_MS = 60 * 1000;

export type MorningReportFailureClassification = {
  retryable: boolean;
  reasonCode: string;
};

const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);

// Supabase REST failures observed before any generation or posting has happened; a transient DB/network
// blip here is safe to retry the same way an OpenAI 5xx is.
const RETRYABLE_INFRA_ERRORS = new Set([
  "JPX_CALENDAR_SELECT_FAILED",
  "US_MARKET_CALENDAR_SELECT_FAILED",
  "MORNING_REPORT_LOG_CREATE_FAILED",
  "MORNING_REPORT_LOG_UPDATE_FAILED",
]);

// Content, fact, or safety judgements. Retrying with the same inputs would not change the outcome, and
// the project's safety rules require these to stop the run rather than loop.
const CONTENT_OR_SAFETY_ERRORS = new Set([
  "MORNING_REPORT_FACT_CHECK_FAILED",
  "MORNING_REPORT_SEARCH_BUDGET_EXCEEDED",
  "MORNING_REPORT_WRITING_EMPTY",
  "MORNING_REPORT_WRITING_INVALID",
  "MORNING_REPORT_FORMAT_INVALID",
  "MORNING_REPORT_TRADING_DATE_MISMATCH",
  "MORNING_REPORT_INVALID_REFERENCE_TIME",
]);

// Classifies a single caught error as transient-and-safe-to-retry or not. This function only looks at
// *what* failed — it says nothing about whether an X post may already have happened; callers must apply
// that check separately (see shouldRetryMorningReport) before ever acting on a "retryable" result.
export function classifyMorningReportFailure(error: unknown): MorningReportFailureClassification {
  const name = error && typeof error === "object" && "name" in error
    ? (error as { name?: unknown }).name
    : null;
  if (name === "MorningLaneResponseError" || name === "VoiceEvaluationOutputError") {
    return { retryable: false, reasonCode: "CONTENT_OR_SCHEMA_FAILURE" };
  }

  const message = error instanceof Error ? error.message : "";
  if (CONTENT_OR_SAFETY_ERRORS.has(message)) {
    return { retryable: false, reasonCode: "CONTENT_OR_SAFETY_FAILURE" };
  }
  if (RETRYABLE_INFRA_ERRORS.has(message)) {
    return { retryable: true, reasonCode: "TRANSIENT_INFRA_FAILURE" };
  }

  const statusMatch = message.match(/_FAILED:(\d+)$/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return RETRYABLE_HTTP_STATUS.has(status)
      ? { retryable: true, reasonCode: `TRANSIENT_HTTP_${status}` }
      : { retryable: false, reasonCode: `NON_TRANSIENT_HTTP_${status}` };
  }

  // fetch() itself rejecting (DNS/connection failure) surfaces as a TypeError in Deno, distinct from a
  // resolved-but-non-ok response (handled by the status check above).
  if (error instanceof TypeError) {
    return { retryable: true, reasonCode: "NETWORK_FETCH_FAILED" };
  }

  return { retryable: false, reasonCode: "UNCLASSIFIED_ERROR" };
}

export function shouldRetryMorningReport(args: {
  error: unknown;
  postAttempted: boolean;
  attemptNumber: number;
  maxAttempts?: number;
}): MorningReportFailureClassification {
  // Once postToX has been called, whether X actually received the post is unknown — a thrown error here
  // could mean the request failed outright, or that it succeeded and only the response/completion step
  // failed. Retrying would risk a second post, so this overrides every other classification.
  if (args.postAttempted) return { retryable: false, reasonCode: "POST_ATTEMPTED_NO_RETRY" };

  const classification = classifyMorningReportFailure(args.error);
  if (!classification.retryable) return classification;

  const maxAttempts = args.maxAttempts ?? MORNING_REPORT_MAX_ATTEMPTS;
  if (args.attemptNumber >= maxAttempts) {
    return { retryable: false, reasonCode: "MAX_ATTEMPTS_REACHED" };
  }
  return classification;
}

export function computeMorningReportRetryTime(
  referenceTime: Date,
  attemptNumber: number,
  baseDelayMs = MORNING_REPORT_RETRY_BASE_DELAY_MS,
): Date {
  return new Date(referenceTime.getTime() + baseDelayMs * Math.max(1, attemptNumber));
}

export type MorningReportStaleReconciliationResult = {
  scheduledPostsReconciled: number;
  runsReconciled: number;
};

// Mirrors the scheduled_posts table's own design (the existing fail_scheduled_post RPC, which is already
// used by the live dispatch path) rather than importing important-news-monitor's single-table pattern.
// A row stuck in 'running' past the threshold is marked failed — never retried from here, since staleness
// alone cannot prove whether an X post happened before the worker was killed.
export async function reconcileStaleMorningReportRuns(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  referenceTime?: Date;
  fetcher?: typeof fetch;
}): Promise<MorningReportStaleReconciliationResult> {
  const referenceTime = args.referenceTime ?? new Date();
  if (!Number.isFinite(referenceTime.getTime())) {
    throw new Error("MORNING_REPORT_STALE_REFERENCE_TIME_INVALID");
  }
  const fetcher = args.fetcher ?? fetch;
  const cutoff = new Date(referenceTime.getTime() - MORNING_REPORT_STALE_RUN_THRESHOLD_MS).toISOString();
  const authHeaders = {
    apikey: args.serviceRoleKey,
    Authorization: `Bearer ${args.serviceRoleKey}`,
  };

  const scheduledPostsParams = new URLSearchParams({
    select: "id",
    post_type: "eq.morning_report",
    status: "eq.running",
    started_at: `lte.${cutoff}`,
  });
  const staleScheduledPostsResponse = await fetcher(
    `${args.supabaseUrl}/rest/v1/scheduled_posts?${scheduledPostsParams}`,
    { headers: authHeaders },
  );
  if (!staleScheduledPostsResponse.ok) throw new Error(MORNING_REPORT_STALE_RECONCILIATION_FAILED);
  const staleScheduledPosts = await staleScheduledPostsResponse.json();
  if (!Array.isArray(staleScheduledPosts)) throw new Error(MORNING_REPORT_STALE_RECONCILIATION_FAILED);

  let scheduledPostsReconciled = 0;
  for (const row of staleScheduledPosts) {
    const id = typeof row === "object" && row !== null ? (row as { id?: unknown }).id : null;
    if (typeof id !== "string") continue;
    const failResult = await fetcher(`${args.supabaseUrl}/rest/v1/rpc/fail_scheduled_post`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ p_scheduled_post_id: id, p_message: MORNING_REPORT_STALE_RUN_ERROR }),
    });
    if (failResult.ok) scheduledPostsReconciled += 1;
  }

  const runsParams = new URLSearchParams({
    status: "eq.generating",
    created_at: `lte.${cutoff}`,
  });
  const staleRunsResponse = await fetcher(
    `${args.supabaseUrl}/rest/v1/morning_report_runs?${runsParams}`,
    {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ status: "failed", error: MORNING_REPORT_STALE_RUN_ERROR }),
    },
  );
  if (!staleRunsResponse.ok) throw new Error(MORNING_REPORT_STALE_RECONCILIATION_FAILED);
  const staleRuns = await staleRunsResponse.json();
  const runsReconciled = Array.isArray(staleRuns) ? staleRuns.length : 0;

  return { scheduledPostsReconciled, runsReconciled };
}
