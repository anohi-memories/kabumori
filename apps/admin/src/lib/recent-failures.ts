import type { SupabaseClient } from "@supabase/supabase-js";
import { getPostTypeLabel } from "./today-scheduled-posts";

const FETCH_LIMIT_PER_SOURCE = 20;
const DISPLAY_LIMIT = 10;
const ISSUE_DISPLAY_LIMIT = 8;
const TEXT_DISPLAY_LIMIT = 240;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type ExecutionLogRow = {
  id: number;
  scheduled_post_id: string | null;
  important_news_candidate_id: string | null;
  post_type: string;
  message: string | null;
  error_code: string | null;
  created_at: string;
};

type ScheduledPostRow = {
  id: string;
  scheduled_for: string;
};

type MorningReportRunRow = {
  id: string;
  scheduled_post_id: string | null;
  status: string;
  error: string | null;
  fact_check_status: string | null;
  fact_check_notes: JsonValue;
  created_at: string;
};

type ImportantNewsCandidateRow = {
  id: string;
  company_name: string | null;
  title: string;
  status: string;
  generation_fact_status: string | null;
  generation_fact_issues: JsonValue;
  generation_voice_status: string | null;
  generation_voice_issues: JsonValue;
  generation_error: string | null;
  created_at: string;
};

export type RecentFailure = {
  id: string;
  source: "execution_log" | "morning_report_run" | "important_news_candidate";
  postType: string;
  postTypeLabel: string;
  occurredAt: string;
  occurredAtLabel: string;
  scheduledAtLabel: string | null;
  companyName: string | null;
  title: string | null;
  summary: string;
  errorCode: string | null;
  message: string | null;
  factStatusLabel: string | null;
  factIssues: string[];
  voiceStatusLabel: string | null;
  voiceIssues: string[];
};

export type RecentFailuresResult = {
  failures: RecentFailure[];
  error: boolean;
};

function truncateText(value: string, limit = TEXT_DISPLAY_LIMIT) {
  const normalized = value.trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function formatIssueEntry(value: JsonValue, prefix?: string): string[] {
  if (value === null) return [];
  if (typeof value === "string") {
    const text = truncateText(value);
    return text ? [prefix ? `${prefix}: ${text}` : text] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [prefix ? `${prefix}: ${String(value)}` : String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => formatIssueEntry(entry, prefix));
  }

  return Object.entries(value).flatMap(([key, entry]) =>
    formatIssueEntry(entry, prefix ? `${prefix}.${key}` : key),
  );
}

export function formatIssueList(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  return formatIssueEntry(value).slice(0, ISSUE_DISPLAY_LIMIT);
}

export function formatFailureTimeJst(timestamp: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

export function getCheckStatusLabel(status: string | null) {
  switch (status) {
    case "passed":
      return "問題なし";
    case "failed":
      return "失敗";
    case "not_run":
      return "未実施";
    case null:
      return null;
    default:
      return `不明（${status}）`;
  }
}

function getFailureSummary(code: string | null, fallback = "処理を完了できませんでした。") {
  if (!code) return fallback;
  if (code.startsWith("MORNING_GREETING_TEXT_LENGTH_INVALID")) {
    return "朝の挨拶文の長さが基準を満たしませんでした。";
  }
  if (code.startsWith("MORNING_REPORT_FACT_CHECK_FAILED")) {
    return "朝刊の事実確認で問題が見つかりました。";
  }
  if (code.startsWith("MORNING_REPORT_VOICE_CHECK_FAILED")) {
    return "朝刊の文章品質チェックで問題が見つかりました。";
  }
  if (code.startsWith("INTERACTION_MECHANICAL_GUARD_FAILED")) {
    return "交流投稿の形式または安全条件を満たしませんでした。";
  }
  if (code.startsWith("OPENAI_INTERACTION")) {
    return "交流投稿の文章生成結果を正しく取得できませんでした。";
  }
  if (code.startsWith("X_REQUEST_FAILED")) {
    return "Xへの送信処理に失敗しました。";
  }
  return fallback;
}

function logQueryError(source: string, code: string) {
  console.error(`[admin/recent-failures] ${source} query failed`, { code });
}

export async function getRecentFailures(
  supabase: SupabaseClient,
): Promise<RecentFailuresResult> {
  const [executionResult, morningResult, importantNewsResult] = await Promise.all([
    supabase
      .from("post_execution_logs")
      .select(
        "id,scheduled_post_id,important_news_candidate_id,post_type,message,error_code,created_at",
      )
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(FETCH_LIMIT_PER_SOURCE),
    supabase
      .from("morning_report_runs")
      .select("id,scheduled_post_id,status,error,fact_check_status,fact_check_notes,created_at")
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(FETCH_LIMIT_PER_SOURCE),
    supabase
      .from("important_news_candidates")
      .select(
        "id,company_name,title,status,generation_fact_status,generation_fact_issues,generation_voice_status,generation_voice_issues,generation_error,created_at",
      )
      .or("status.eq.generation_failed,generation_fact_status.eq.failed,generation_voice_status.eq.failed")
      .order("created_at", { ascending: false })
      .limit(FETCH_LIMIT_PER_SOURCE),
  ]);

  if (executionResult.error || morningResult.error || importantNewsResult.error) {
    if (executionResult.error) logQueryError("post_execution_logs", executionResult.error.code);
    if (morningResult.error) logQueryError("morning_report_runs", morningResult.error.code);
    if (importantNewsResult.error) {
      logQueryError("important_news_candidates", importantNewsResult.error.code);
    }
    return { failures: [], error: true };
  }

  const executionLogs = (executionResult.data ?? []) as ExecutionLogRow[];
  const morningRuns = (morningResult.data ?? []) as MorningReportRunRow[];
  const failedMorningScheduledPostIds = new Set(
    morningRuns.flatMap((run) => (run.scheduled_post_id ? [run.scheduled_post_id] : [])),
  );
  const genericLogs = executionLogs.filter(
    (log) =>
      !log.important_news_candidate_id &&
      !(
        log.post_type === "morning_report" &&
        log.scheduled_post_id &&
        failedMorningScheduledPostIds.has(log.scheduled_post_id)
      ),
  );
  const scheduledPostIds = genericLogs.flatMap((log) =>
    log.scheduled_post_id ? [log.scheduled_post_id] : [],
  );

  let scheduledPosts: ScheduledPostRow[] = [];
  if (scheduledPostIds.length > 0) {
    const { data, error } = await supabase
      .from("scheduled_posts")
      .select("id,scheduled_for")
      .in("id", scheduledPostIds);

    if (error) {
      logQueryError("scheduled_posts", error.code);
      return { failures: [], error: true };
    }
    scheduledPosts = (data ?? []) as ScheduledPostRow[];
  }

  const scheduledAtById = new Map(
    scheduledPosts.map((post) => [post.id, formatFailureTimeJst(post.scheduled_for)]),
  );

  const failures: RecentFailure[] = [
    ...genericLogs.map<RecentFailure>((log) => ({
      id: `execution-${log.id}`,
      source: "execution_log",
      postType: log.post_type,
      postTypeLabel: getPostTypeLabel(log.post_type),
      occurredAt: log.created_at,
      occurredAtLabel: formatFailureTimeJst(log.created_at),
      scheduledAtLabel: log.scheduled_post_id
        ? scheduledAtById.get(log.scheduled_post_id) ?? null
        : null,
      companyName: null,
      title: null,
      summary: getFailureSummary(log.error_code || log.message),
      errorCode: log.error_code || (log.message ? truncateText(log.message) : null),
      message: log.error_code && log.message ? truncateText(log.message) : null,
      factStatusLabel: null,
      factIssues: [],
      voiceStatusLabel: null,
      voiceIssues: [],
    })),
    ...morningRuns.map<RecentFailure>((run) => ({
      id: `morning-${run.id}`,
      source: "morning_report_run",
      postType: "morning_report",
      postTypeLabel: getPostTypeLabel("morning_report"),
      occurredAt: run.created_at,
      occurredAtLabel: formatFailureTimeJst(run.created_at),
      scheduledAtLabel: null,
      companyName: null,
      title: null,
      summary: getFailureSummary(run.error, "朝刊の生成処理を完了できませんでした。"),
      errorCode: run.error,
      message: null,
      factStatusLabel: getCheckStatusLabel(run.fact_check_status),
      factIssues: formatIssueList(run.fact_check_notes),
      voiceStatusLabel: null,
      voiceIssues: [],
    })),
    ...(importantNewsResult.data as ImportantNewsCandidateRow[]).map<RecentFailure>(
      (candidate) => ({
        id: `important-${candidate.id}`,
        source: "important_news_candidate",
        postType: "important_news",
        postTypeLabel: getPostTypeLabel("important_news"),
        occurredAt: candidate.created_at,
        occurredAtLabel: formatFailureTimeJst(candidate.created_at),
        scheduledAtLabel: null,
        companyName: candidate.company_name,
        title: candidate.title,
        summary:
          candidate.generation_fact_status === "failed"
            ? "重要ニュースの事実確認で問題が見つかりました。"
            : candidate.generation_voice_status === "failed"
              ? "重要ニュースの文章品質チェックで問題が見つかりました。"
              : "重要ニュースの生成処理を完了できませんでした。",
        errorCode: candidate.generation_error,
        message: null,
        factStatusLabel: getCheckStatusLabel(candidate.generation_fact_status),
        factIssues: formatIssueList(candidate.generation_fact_issues),
        voiceStatusLabel: getCheckStatusLabel(candidate.generation_voice_status),
        voiceIssues: formatIssueList(candidate.generation_voice_issues),
      }),
    ),
  ];

  failures.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));

  return { failures: failures.slice(0, DISPLAY_LIMIT), error: false };
}
