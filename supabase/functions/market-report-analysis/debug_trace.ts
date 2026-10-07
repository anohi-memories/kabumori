// Test-phase debug traces of the shared analysis (2026-10-07).
//
// The 10/7 morning cycle failed twice and kept a few fixed codes and the last Fact issue: the generated
// bodies, the first generation's local findings and the 07:55 attempt were overwritten, so a false reject
// and a real defect looked the same. While the reports are being tuned, every model generation is kept as
// its own row: the structured candidate the model returned and what the local guard and the Fact check
// said about it, with the invocation, scheduled attempt, cycle and packet ids.
//
// Pure functions only (no I/O besides the injected insert). Rules:
//   - Diagnostics are secondary. A failed write is logged and dropped: never retried, never thrown, never a
//     model call, never a reason a safe report is not delivered.
//   - Content is kept, credentials are not. The whole generated output and every finding are stored; anything
//     recognizable as a credential is redacted first, and a row that still contains one afterwards is dropped.
//   - Retention is complete up to ONE declared bound per field (MAX_FIELD_CHARS). Nothing is shortened below
//     it; above it the row says so (truncated + truncation metadata with the original size).
//   - The row shape does not assume a public market report: `source` and `subject_ref` leave room for
//     personalized reports when they enter QA. Nothing here generates one.

import type { GenerationRecord } from "./analysis_logic.ts";

export const TRACE_TABLE = "market_report_generation_traces";
export const REDACTED = "[redacted]";

/**
 * The only size bound on stored evidence: the serialized length of ONE field (the candidate, the local issues,
 * the local warnings, the Fact issues), counted after redaction. The model is capped at 10,000 output tokens, so
 * a real candidate is a small fraction of this; a field above it is cut here and the row says how large it was.
 */
export const MAX_FIELD_CHARS = 200_000;
const MAX_DEPTH = 64;

// ---------------------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------------------

const KEY_NAMES = [
  "access[_-]?token", "refresh[_-]?token", "id[_-]?token", "auth[_-]?token", "session[_-]?token", "token",
  "api[_-]?key", "apikey", "secret[_-]?key", "client[_-]?secret", "service[_-]?role[_-]?key", "private[_-]?key",
  "password", "passwd", "pwd", "secret", "credentials?", "cookie", "set-cookie",
].join("|");

/** An object key whose value is never written, whatever it holds. */
const SECRET_KEY = new RegExp(
  `(?:^|[^A-Za-z0-9])(?:${KEY_NAMES}|authorization|auth[_-]?header|bearer|vault)$|^(?:${KEY_NAMES}|authorization|bearer|vault)`, "i",
);

const PEM = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g;
const KEY_BOUNDARY = "(?<![A-Za-z0-9])";
// "key": "value with spaces" / \\"key\\":\\"value\\" / 'key': 'value' : the value runs to the closing quote.
const QUOTED_KV = new RegExp(`${KEY_BOUNDARY}((?:${KEY_NAMES}|authorization)["'\\\\]*\\s*[:=]\\s*["'\\\\]+)([^"'\\\\]{3,}?)(?=["'\\\\]|$)`, "gi");
// key=value / key: value : the value runs to the next separator. Already-redacted values are left alone.
const BARE_KV = new RegExp(
  `${KEY_BOUNDARY}((?:${KEY_NAMES})\\s*[:=]\\s*)(?!\\[redacted\\])(?!["'\\\\])([^\\s"'\\\\,;}\\])&]{4,})`, "gi",
);
const AUTHORIZATION = /(?<![A-Za-z0-9])(authorization\s*[:=]\s*)(?!\[redacted\])(?!["'\\])(?:(?:Bearer|Basic|Digest|Token)\s+)?(?!\[redacted\])[^\s"'\\,;}\])&]{4,}/gi;

const TOKENISH = "(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=])";
const SECRET_TEXT: Array<[RegExp, string | ((...match: string[]) => string)]> = [
  [PEM, REDACTED],
  [AUTHORIZATION, (_all, head) => `${head}${REDACTED}`],
  [new RegExp(`\\bBearer\\s+${TOKENISH}[A-Za-z0-9._~+/=-]{8,}`, "gi"), `Bearer ${REDACTED}`],
  [new RegExp(`\\bBasic\\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/=]{12,}`, "gi"), `Basic ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{12,}/g, REDACTED],
  [QUOTED_KV, (_all, head) => `${head}${REDACTED}`],
  [BARE_KV, (_all, head) => `${head}${REDACTED}`],
];

/** Every credential-shaped piece of the text replaced (all of them, not the first), the rest kept as written. */
export function redactText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_TEXT) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

/** True when anything credential-shaped is still in the text, wherever it sits: redaction would change it. */
export function containsSecret(text: string): boolean {
  return redactText(text) !== text;
}

type Flags = { depthLimited: boolean };

/** Deep copy of a JSON value with credential-shaped keys and text redacted. Nothing is shortened. */
export function redactValue(value: unknown, flags: Flags = { depthLimited: false }, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) {
    flags.depthLimited = true;
    return "[depth-limit]";
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, flags, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, flags, depth + 1);
    }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------------------

type Truncation = { reason: string; original_chars: number; kept_chars: number; original_count?: number; kept_count?: number };
type Kept<T> = { value: T; chars: number; count?: number; truncation: Truncation | null };

/** The redacted candidate, whole; above the declared field bound a head of it plus the original size. */
function keepCandidate(candidate: unknown): Kept<unknown> {
  if (candidate === null || candidate === undefined) return { value: null, chars: 0, truncation: null };
  const flags = { depthLimited: false };
  const cleaned = redactValue(candidate, flags);
  const text = JSON.stringify(cleaned);
  const depth = flags.depthLimited ? { reason: "depth_limit" } : null;
  if (text.length <= MAX_FIELD_CHARS) {
    return { value: cleaned, chars: text.length, truncation: depth ? { ...depth, original_chars: text.length, kept_chars: text.length } : null };
  }
  const head = text.slice(0, MAX_FIELD_CHARS);
  return {
    value: { truncated: true, reason: "field_bound", original_chars: text.length, kept_chars: head.length, head },
    chars: text.length,
    truncation: { reason: "field_bound", original_chars: text.length, kept_chars: head.length },
  };
}

/** A list of strings, redacted, every item whole; above the declared bound the leading items that fit. */
function keepList(values: readonly string[]): Kept<string[]> {
  const cleaned = values.map(redactText);
  const total = JSON.stringify(cleaned).length;
  if (total <= MAX_FIELD_CHARS) return { value: cleaned, chars: total, count: cleaned.length, truncation: null };
  const kept: string[] = [];
  let used = 2;
  for (const item of cleaned) {
    const size = JSON.stringify(item).length + 1;
    if (used + size > MAX_FIELD_CHARS) break;
    kept.push(item);
    used += size;
  }
  return {
    value: kept, chars: total, count: cleaned.length,
    truncation: { reason: "field_bound", original_chars: total, kept_chars: used, original_count: cleaned.length, kept_count: kept.length },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------------

export type TraceContext = {
  source?: "shared_market_report" | "personalized_report";
  reportType: "morning" | "close";
  tradingDate: string;
  cycleId: string | null;
  dataPacketId: string | null;
  reportPacketId?: string | null;
  /** Future personalized reports: user / account / report identifier. Null for the shared analysis. */
  subjectRef?: string | null;
  invocationId: string;
  /** The cycle's report attempt: the 07:55 run is 1, the 08:05 retry is 2. */
  attempt: number;
  model: string;
  /** Hash of the instructions without any previous-issues note: the same for every generation of a prompt. */
  basePromptHash: string | null;
  createdAt?: Date;
};

export type TraceRow = {
  source: string;
  report_type: string;
  trading_date: string;
  cycle_id: string | null;
  data_packet_id: string | null;
  report_packet_id: string | null;
  subject_ref: string | null;
  invocation_id: string;
  attempt: number;
  generation_index: number;
  model: string;
  base_prompt_hash: string | null;
  request_hash: string | null;
  stage: string;
  hard_rejection: string | null;
  local_passed: boolean | null;
  local_issues: string[];
  local_warnings: string[];
  fact_ran: boolean;
  fact_passed: boolean | null;
  fact_issues: string[];
  selected_for_delivery: boolean;
  fallback_reason: string | null;
  error_code: string | null;
  candidate: unknown;
  candidate_chars: number;
  local_issue_count: number;
  fact_issue_count: number;
  truncated: boolean;
  truncation: Record<string, Truncation> | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  api_cost_usd: number;
  created_at?: string;
};

/** One row per generation. Order and ids make a scheduled retry distinguishable from the first attempt. */
export function traceRows(context: TraceContext, records: readonly GenerationRecord[]): TraceRow[] {
  return records.map((record) => {
    const candidate = keepCandidate(record.candidate);
    const localIssues = keepList(record.localIssues);
    const localWarnings = keepList(record.localWarnings);
    const factIssues = keepList(record.factIssues);
    const truncation: Record<string, Truncation> = {};
    if (candidate.truncation) truncation.candidate = candidate.truncation;
    if (localIssues.truncation) truncation.local_issues = localIssues.truncation;
    if (localWarnings.truncation) truncation.local_warnings = localWarnings.truncation;
    if (factIssues.truncation) truncation.fact_issues = factIssues.truncation;
    const truncated = Object.keys(truncation).length > 0;
    return {
      source: context.source ?? "shared_market_report",
      report_type: context.reportType,
      trading_date: context.tradingDate,
      cycle_id: context.cycleId,
      data_packet_id: context.dataPacketId,
      report_packet_id: record.selectedForDelivery ? context.reportPacketId ?? null : null,
      subject_ref: context.subjectRef ?? null,
      invocation_id: context.invocationId,
      attempt: context.attempt,
      generation_index: record.generationIndex,
      model: context.model,
      base_prompt_hash: context.basePromptHash,
      request_hash: record.requestHash,
      stage: record.stage,
      hard_rejection: record.hardRejection,
      local_passed: record.localPassed,
      local_issues: localIssues.value,
      local_warnings: localWarnings.value,
      fact_ran: record.factRan,
      fact_passed: record.factPassed,
      fact_issues: factIssues.value,
      selected_for_delivery: record.selectedForDelivery,
      fallback_reason: record.fallbackReason,
      error_code: record.errorCode,
      candidate: candidate.value,
      candidate_chars: candidate.chars,
      local_issue_count: localIssues.count ?? 0,
      fact_issue_count: factIssues.count ?? 0,
      truncated,
      truncation: truncated ? truncation : null,
      calls: record.calls,
      input_tokens: record.inputTokens,
      output_tokens: record.outputTokens,
      api_cost_usd: record.costUsd,
      ...(context.createdAt ? { created_at: context.createdAt.toISOString() } : {}),
    };
  });
}

/** Short stable hash (16 hex chars of SHA-256) of a prompt or request: which one produced a candidate. */
export async function promptHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type TraceInsert = (table: string, rows: TraceRow[]) => Promise<void>;

/**
 * Best effort. Never throws, never retries, never calls the model. A row that still holds anything
 * credential-shaped after redaction (every occurrence is checked, not the first) is dropped instead of
 * written, and the insert callback is not invoked at all when no row is left.
 */
export async function persistTraces(
  insert: TraceInsert,
  rows: TraceRow[],
  log: (message: string) => void = (message) => console.error(message),
): Promise<boolean> {
  if (rows.length === 0) return true;
  try {
    const safe = rows.filter((row) => !containsSecret(JSON.stringify(row)));
    if (safe.length !== rows.length) log(`GENERATION_TRACE_ROW_DROPPED:secret_shape:${rows.length - safe.length}`);
    if (safe.length === 0) return false;
    await insert(TRACE_TABLE, safe);
    return true;
  } catch (error) {
    const code = error instanceof Error && /^[A-Za-z0-9_:.-]+$/.test(error.message) ? error.message.slice(0, 120) : "UNEXPECTED_ERROR";
    log(`GENERATION_TRACE_WRITE_FAILED:${code}`);
    return false;
  }
}
