import type { SupabaseClient } from "@supabase/supabase-js";

const JST_TIME_ZONE = "Asia/Tokyo";

const POST_TYPE_LABELS: Readonly<Record<string, string>> = {
  close_report: "大引けレポート",
  closing_report: "大引けレポート",
  important_news: "重要ニュース",
  interaction: "交流投稿",
  morning_greeting: "朝の挨拶",
  morning_report: "朝刊",
  tip: "株の小ネタ",
  useful_tip: "お役立ち情報",
  us_premarket: "米国市場前",
  us_premarket_report: "米国市場前",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  failed: "失敗",
  pending: "投稿待ち",
  running: "処理中",
  succeeded: "投稿成功",
};

export type ScheduleStatusTone = "failed" | "pending" | "running" | "success" | "unknown";

type ScheduledPostRow = {
  id: string;
  schedule_date: string;
  post_type: string;
  scheduled_for: string;
  status: string;
};

type ExecutionLogRow = {
  id: number;
  scheduled_post_id: string | null;
  status: string;
  x_post_id: string | null;
  message: string | null;
  error_code: string | null;
  created_at: string;
};

export type TodayScheduledPost = {
  id: string;
  scheduledDate: string;
  scheduledFor: string;
  timeJst: string;
  postType: string;
  postTypeLabel: string;
  status: string;
  statusLabel: string;
  statusTone: ScheduleStatusTone;
  xPostId: string | null;
  failureReason: string | null;
};

export type TodayScheduledPostsResult = {
  dateJst: string;
  posts: TodayScheduledPost[];
  error: boolean;
};

function getJstDateParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function getJstDate(now = new Date()) {
  const { year, month, day } = getJstDateParts(now);
  return `${year}-${month}-${day}`;
}

export function formatScheduledTimeJst(scheduledFor: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(scheduledFor));
}

export function getPostTypeLabel(postType: string) {
  return POST_TYPE_LABELS[postType] ?? `未分類（${postType}）`;
}

export function getStatusLabel(status: string) {
  return STATUS_LABELS[status] ?? `不明（${status}）`;
}

export function getStatusTone(status: string): ScheduleStatusTone {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    case "running":
      return "running";
    default:
      return "unknown";
  }
}

function summarizeFailureReason(log: ExecutionLogRow | undefined) {
  const reason = log?.message?.trim() || log?.error_code?.trim();
  if (!reason) return "詳細なし";
  return reason.length > 180 ? `${reason.slice(0, 180)}…` : reason;
}

export async function getTodayScheduledPosts(
  supabase: SupabaseClient,
  now = new Date(),
): Promise<TodayScheduledPostsResult> {
  const dateJst = getJstDate(now);
  const { data: scheduleData, error: scheduleError } = await supabase
    .from("scheduled_posts")
    .select("id,schedule_date,post_type,scheduled_for,status")
    .eq("schedule_date", dateJst)
    .order("scheduled_for", { ascending: true });

  if (scheduleError) {
    console.error("[admin/today-schedule] scheduled_posts query failed", {
      code: scheduleError.code,
    });
    return { dateJst, posts: [], error: true };
  }

  const schedules = (scheduleData ?? []) as ScheduledPostRow[];
  if (schedules.length === 0) {
    return { dateJst, posts: [], error: false };
  }

  const scheduledPostIds = schedules.map(({ id }) => id);
  const { data: logData, error: logError } = await supabase
    .from("post_execution_logs")
    .select("id,scheduled_post_id,status,x_post_id,message,error_code,created_at")
    .in("scheduled_post_id", scheduledPostIds)
    .order("created_at", { ascending: false });

  if (logError) {
    console.error("[admin/today-schedule] post_execution_logs query failed", {
      code: logError.code,
    });
    return { dateJst, posts: [], error: true };
  }

  const logs = (logData ?? []) as ExecutionLogRow[];
  const logsByScheduledPost = new Map<string, ExecutionLogRow[]>();
  logs.forEach((log) => {
    if (!log.scheduled_post_id) return;
    const current = logsByScheduledPost.get(log.scheduled_post_id) ?? [];
    current.push(log);
    logsByScheduledPost.set(log.scheduled_post_id, current);
  });

  const posts = schedules.map<TodayScheduledPost>((schedule) => {
    const postLogs = logsByScheduledPost.get(schedule.id) ?? [];
    const xPostId = postLogs.find((log) => Boolean(log.x_post_id))?.x_post_id ?? null;
    const latestFailure = postLogs.find((log) => log.status === "failed");

    return {
      id: schedule.id,
      scheduledDate: schedule.schedule_date,
      scheduledFor: schedule.scheduled_for,
      timeJst: formatScheduledTimeJst(schedule.scheduled_for),
      postType: schedule.post_type,
      postTypeLabel: getPostTypeLabel(schedule.post_type),
      status: schedule.status,
      statusLabel: getStatusLabel(schedule.status),
      statusTone: getStatusTone(schedule.status),
      xPostId,
      failureReason:
        schedule.status === "failed" ? summarizeFailureReason(latestFailure) : null,
    };
  });

  return { dateJst, posts, error: false };
}
