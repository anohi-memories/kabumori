import type { SupabaseClient } from "@supabase/supabase-js";
import { getPostTypeLabel, getStatusLabel, getStatusTone } from "./today-scheduled-posts";

const DEFAULT_HISTORY_LIMIT = 30;
const ERROR_MESSAGE_LIMIT = 500;

type ExecutionLogRow = {
  id: number;
  scheduled_post_id: string | null;
  post_type: string;
  status: string;
  tip_id: string | null;
  useful_tip_id: string | null;
  important_news_candidate_id: string | null;
  x_post_id: string | null;
  message: string | null;
  error_code: string | null;
  created_at: string;
};

type ScheduledPostRow = {
  id: string;
  scheduled_for: string;
  attempt_count: number;
};

type ReportRunRow = {
  id: string;
  scheduled_post_id: string | null;
  status: string;
  generated_text: string | null;
  x_post_id: string | null;
  created_at: string;
};

type ImportantNewsRow = {
  id: string;
  generated_text: string | null;
  x_post_id: string | null;
};

export type PostHistoryItem = {
  id: number;
  occurredAt: string;
  occurredAtLabel: string;
  scheduledAtLabel: string | null;
  postType: string;
  postTypeLabel: string;
  status: string;
  statusLabel: string;
  statusTone: ReturnType<typeof getStatusTone>;
  generatedText: string | null;
  xPostId: string | null;
  xPostUrl: string | null;
  errorCode: string | null;
  message: string | null;
  attemptCount: number | null;
};

export type PostHistoryResult = {
  posts: PostHistoryItem[];
  error: boolean;
};

export function formatPostHistoryTimeJst(timestamp: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

function logQueryError(source: string, code: string) {
  console.error(`[admin/post-history] ${source} query failed`, { code });
}

function selectMatchingReportRun(log: ExecutionLogRow, rows: ReportRunRow[]) {
  if (!log.scheduled_post_id) return null;

  const matches = rows.filter((row) => row.scheduled_post_id === log.scheduled_post_id);
  const exactXPost = log.x_post_id
    ? matches.find((row) => row.x_post_id === log.x_post_id)
    : null;
  if (exactXPost) return exactXPost;

  const logTime = Date.parse(log.created_at);
  return (
    matches.find(
      (row) => row.status === log.status && Date.parse(row.created_at) <= logTime,
    ) ??
    matches.find((row) => Date.parse(row.created_at) <= logTime) ??
    null
  );
}

function safeXPostUrl(xPostId: string | null) {
  return xPostId && /^\d+$/.test(xPostId)
    ? `https://x.com/yume_daka/status/${xPostId}`
    : null;
}

function safeErrorMessage(message: string | null) {
  if (!message) return null;
  const normalized = message.trim();
  return normalized.length > ERROR_MESSAGE_LIMIT
    ? `${normalized.slice(0, ERROR_MESSAGE_LIMIT)}…`
    : normalized;
}

async function getScheduledPosts(supabase: SupabaseClient, ids: string[]) {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("scheduled_posts")
    .select("id,scheduled_for,attempt_count")
    .in("id", ids);
  if (error) {
    logQueryError("scheduled_posts", error.code);
    return null;
  }
  return (data ?? []) as ScheduledPostRow[];
}

async function getReportRuns(
  supabase: SupabaseClient,
  table: "morning_report_runs" | "close_report_runs" | "us_premarket_report_runs",
  ids: string[],
) {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from(table)
    .select("id,scheduled_post_id,status,generated_text,x_post_id,created_at")
    .in("scheduled_post_id", ids)
    .order("created_at", { ascending: false });
  if (error) {
    logQueryError(table, error.code);
    return null;
  }
  return (data ?? []) as ReportRunRow[];
}

async function getImportantNews(supabase: SupabaseClient, ids: string[]) {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("important_news_candidates")
    .select("id,generated_text,x_post_id")
    .in("id", ids);
  if (error) {
    logQueryError("important_news_candidates", error.code);
    return null;
  }
  return (data ?? []) as ImportantNewsRow[];
}

export async function getPostHistory(
  supabase: SupabaseClient,
  limit = DEFAULT_HISTORY_LIMIT,
): Promise<PostHistoryResult> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), DEFAULT_HISTORY_LIMIT);
  const { data, error } = await supabase
    .from("post_execution_logs")
    .select(
      "id,scheduled_post_id,post_type,status,tip_id,useful_tip_id,important_news_candidate_id,x_post_id,message,error_code,created_at",
    )
    .in("status", ["succeeded", "failed"])
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) {
    logQueryError("post_execution_logs", error.code);
    return { posts: [], error: true };
  }

  const logs = (data ?? []) as ExecutionLogRow[];
  const scheduledPostIds = [...new Set(logs.flatMap((log) =>
    log.scheduled_post_id ? [log.scheduled_post_id] : [],
  ))];
  const importantNewsIds = [...new Set(logs.flatMap((log) =>
    log.important_news_candidate_id ? [log.important_news_candidate_id] : [],
  ))];

  const [scheduledPosts, morningRuns, closeRuns, usRuns, importantNews] = await Promise.all([
    getScheduledPosts(supabase, scheduledPostIds),
    getReportRuns(supabase, "morning_report_runs", scheduledPostIds),
    getReportRuns(supabase, "close_report_runs", scheduledPostIds),
    getReportRuns(supabase, "us_premarket_report_runs", scheduledPostIds),
    getImportantNews(supabase, importantNewsIds),
  ]);

  if (!scheduledPosts || !morningRuns || !closeRuns || !usRuns || !importantNews) {
    return { posts: [], error: true };
  }

  const scheduledById = new Map(scheduledPosts.map((post) => [post.id, post]));
  const importantNewsById = new Map(importantNews.map((candidate) => [candidate.id, candidate]));

  const posts = logs.map<PostHistoryItem>((log) => {
    const scheduled = log.scheduled_post_id
      ? scheduledById.get(log.scheduled_post_id) ?? null
      : null;
    const reportRun =
      log.post_type === "morning_report"
        ? selectMatchingReportRun(log, morningRuns)
        : log.post_type === "close_report" || log.post_type === "closing_report"
          ? selectMatchingReportRun(log, closeRuns)
          : log.post_type === "us_premarket" || log.post_type === "us_premarket_report"
            ? selectMatchingReportRun(log, usRuns)
            : null;
    const news = log.important_news_candidate_id
      ? importantNewsById.get(log.important_news_candidate_id) ?? null
      : null;
    const xPostId = log.x_post_id ?? reportRun?.x_post_id ?? news?.x_post_id ?? null;

    return {
      id: log.id,
      occurredAt: log.created_at,
      occurredAtLabel: formatPostHistoryTimeJst(log.created_at),
      scheduledAtLabel: scheduled
        ? formatPostHistoryTimeJst(scheduled.scheduled_for)
        : null,
      postType: log.post_type,
      postTypeLabel: getPostTypeLabel(log.post_type),
      status: log.status,
      statusLabel: getStatusLabel(log.status),
      statusTone: getStatusTone(log.status),
      generatedText: reportRun?.generated_text ?? news?.generated_text ?? null,
      xPostId,
      xPostUrl: safeXPostUrl(xPostId),
      errorCode: log.error_code,
      message: safeErrorMessage(log.message),
      attemptCount: scheduled?.attempt_count ?? null,
    };
  });

  return { posts, error: false };
}
