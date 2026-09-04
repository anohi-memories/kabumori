import type { SupabaseClient } from "@supabase/supabase-js";
import { formatFailureTimeJst, formatIssueList, getCheckStatusLabel } from "./recent-failures";

const DEFAULT_CANDIDATE_LIMIT = 30;
const GENERATION_ERROR_LIMIT = 500;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type ImportantNewsCandidateRow = {
  id: string;
  company_name: string | null;
  title: string;
  importance: string;
  status: string;
  generation_fact_status: string | null;
  generation_fact_issues: JsonValue;
  generation_voice_status: string | null;
  generation_voice_issues: JsonValue;
  generation_error: string | null;
  generated_text: string | null;
  x_post_id: string | null;
  source_url: string | null;
  created_at: string;
};

export type ImportantNewsCandidateTone = "failed" | "pending" | "running" | "success" | "unknown";

export type ImportantNewsCandidate = {
  id: string;
  companyName: string | null;
  title: string;
  importance: string;
  importanceLabel: string;
  status: string;
  statusLabel: string;
  statusTone: ImportantNewsCandidateTone;
  factStatusLabel: string | null;
  factIssues: string[];
  voiceStatusLabel: string | null;
  voiceIssues: string[];
  generationError: string | null;
  generatedText: string | null;
  xPostId: string | null;
  xPostUrl: string | null;
  sourceUrl: string | null;
  occurredAt: string;
  occurredAtLabel: string;
};

export type ImportantNewsCandidatesResult = {
  candidates: ImportantNewsCandidate[];
  error: boolean;
};

const IMPORTANCE_LABELS: Readonly<Record<string, string>> = {
  no_post: "対象外",
  important: "重要",
  most_important: "最重要",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  fetched: "取得済み",
  duplicate: "重複",
  pending_judgement: "判定待ち",
  rejected: "対象外判定",
  ready_for_generation: "生成待ち",
  ready_for_publish: "投稿準備完了",
  generation_failed: "生成失敗",
  publishing: "投稿処理中",
  publish_failed: "投稿失敗",
  published: "投稿済み",
  failed: "失敗",
};

export function getImportanceLabel(importance: string) {
  return IMPORTANCE_LABELS[importance] ?? `不明（${importance}）`;
}

export function getCandidateStatusLabel(status: string) {
  return STATUS_LABELS[status] ?? `不明（${status}）`;
}

export function getCandidateStatusTone(status: string): ImportantNewsCandidateTone {
  switch (status) {
    case "published":
      return "success";
    case "ready_for_publish":
      return "pending";
    case "publishing":
      return "running";
    case "generation_failed":
    case "publish_failed":
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function safeXPostUrl(xPostId: string | null) {
  return xPostId && /^\d+$/.test(xPostId)
    ? `https://x.com/yume_daka/status/${xPostId}`
    : null;
}

function safeSourceUrl(sourceUrl: string | null) {
  return sourceUrl && sourceUrl.startsWith("https://") ? sourceUrl : null;
}

function safeGenerationError(message: string | null) {
  if (!message) return null;
  const normalized = message.trim();
  return normalized.length > GENERATION_ERROR_LIMIT
    ? `${normalized.slice(0, GENERATION_ERROR_LIMIT)}…`
    : normalized;
}

function logQueryError(source: string, code: string) {
  console.error(`[admin/important-news] ${source} query failed`, { code });
}

export async function getImportantNewsCandidates(
  supabase: SupabaseClient,
  limit = DEFAULT_CANDIDATE_LIMIT,
): Promise<ImportantNewsCandidatesResult> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), DEFAULT_CANDIDATE_LIMIT);
  const { data, error } = await supabase
    .from("important_news_candidates")
    .select(
      "id,company_name,title,importance,status,generation_fact_status,generation_fact_issues,generation_voice_status,generation_voice_issues,generation_error,generated_text,x_post_id,source_url,created_at",
    )
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) {
    logQueryError("important_news_candidates", error.code);
    return { candidates: [], error: true };
  }

  const rows = (data ?? []) as ImportantNewsCandidateRow[];

  const candidates = rows.map<ImportantNewsCandidate>((row) => ({
    id: row.id,
    companyName: row.company_name,
    title: row.title,
    importance: row.importance,
    importanceLabel: getImportanceLabel(row.importance),
    status: row.status,
    statusLabel: getCandidateStatusLabel(row.status),
    statusTone: getCandidateStatusTone(row.status),
    factStatusLabel: getCheckStatusLabel(row.generation_fact_status),
    factIssues: formatIssueList(row.generation_fact_issues),
    voiceStatusLabel: getCheckStatusLabel(row.generation_voice_status),
    voiceIssues: formatIssueList(row.generation_voice_issues),
    generationError: safeGenerationError(row.generation_error),
    generatedText: row.generated_text,
    xPostId: row.x_post_id,
    xPostUrl: safeXPostUrl(row.x_post_id),
    sourceUrl: safeSourceUrl(row.source_url),
    occurredAt: row.created_at,
    occurredAtLabel: formatFailureTimeJst(row.created_at),
  }));

  return { candidates, error: false };
}
