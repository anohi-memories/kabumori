// Test-phase debug traces of the shared analysis (2026-10-07).
//
// The 10/7 morning cycle failed twice and kept a few fixed codes and the last Fact issue: the generated
// bodies, the first generation's local findings and the 07:55 attempt were overwritten, so a false reject
// and a real defect looked the same. While the reports are being tuned, every model generation is kept as
// its own row: the structured candidate the model returned and what the local guard and the Fact check
// said about it, with the invocation, scheduled attempt, cycle and packet ids.
//
// Pure functions only (no I/O besides the injected insert). Three rules:
//   - Diagnostics are secondary. A failed write is logged and dropped: never retried, never thrown, never a
//     model call, never a reason a safe report is not delivered.
//   - Content is kept, credentials are not. Report text, model output and findings are stored; anything
//     shaped like a token / key / Authorization value is redacted before it leaves this module.
//   - The row shape does not assume a public market report: `source` and `subject_ref` leave room for
//     personalized reports when they enter QA. Nothing here generates one.

import type { GenerationRecord } from "./analysis_logic.ts";

export const TRACE_TABLE = "market_report_generation_traces";
export const REDACTED = "[redacted]";

/** Field names whose value is never written, whatever it holds. */
const SECRET_KEY = /authorization|auth[_-]?header|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|secret|password|passwd|credential|cookie|private[_-]?key|service[_-]?role|bearer|client[_-]?secret|vault/i;

/** Text shaped like a credential: replaced in place, the rest of the sentence is kept. */
const SECRET_TEXT: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{12,}/g, `Basic ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{12,}/g, REDACTED],
  [/\b(access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|password|client[_-]?secret)(\s*[:=]\s*)["']?[^\s"',;]{4,}/gi, `$1$2${REDACTED}`],
];

const MAX_STRING = 4_000;
const MAX_ARRAY = 80;
const MAX_DEPTH = 8;
const MAX_ISSUE = 700;
const MAX_ISSUES = 50;
/** Above this a candidate is stored as a head + the exact length, so one row never grows without bound. */
export const MAX_CANDIDATE_CHARS = 60_000;

export function redactText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_TEXT) out = out.replace(pattern, replacement);
  return out;
}

/** Deep copy of a JSON value with credential-shaped keys and text redacted, and strings / arrays bounded. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    const text = redactText(value);
    return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…[truncated ${text.length - MAX_STRING}]` : text;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return out;
  }
  return null;
}

/** True when nothing credential-shaped is left in a serialized row (used by the tests and the writer). */
export function containsSecret(serialized: string): boolean {
  return SECRET_TEXT.some(([pattern]) => {
    pattern.lastIndex = 0;
    const match = pattern.exec(serialized);
    if (!match) return false;
    return !match[0].includes(REDACTED);
  });
}

function issuesOf(values: readonly string[]): string[] {
  return values.slice(0, MAX_ISSUES).map((value) => {
    const text = redactText(value);
    return text.length > MAX_ISSUE ? `${text.slice(0, MAX_ISSUE)}…` : text;
  });
}

function candidateOf(candidate: unknown): unknown {
  if (candidate === null || candidate === undefined) return null;
  const cleaned = redactValue(candidate);
  const size = JSON.stringify(cleaned).length;
  return size <= MAX_CANDIDATE_CHARS
    ? cleaned
    : `${JSON.stringify(cleaned).slice(0, MAX_CANDIDATE_CHARS)}…[truncated, ${size} characters in total]`;
}

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
  promptHash: string | null;
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
  prompt_hash: string | null;
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
  calls: number;
  input_tokens: number;
  output_tokens: number;
  api_cost_usd: number;
  created_at?: string;
};

/** One row per generation. Order and ids make a scheduled retry distinguishable from the first attempt. */
export function traceRows(context: TraceContext, records: readonly GenerationRecord[]): TraceRow[] {
  return records.map((record) => ({
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
    prompt_hash: context.promptHash,
    stage: record.stage,
    hard_rejection: record.hardRejection,
    local_passed: record.localPassed,
    local_issues: issuesOf(record.localIssues),
    local_warnings: issuesOf(record.localWarnings),
    fact_ran: record.factRan,
    fact_passed: record.factPassed,
    fact_issues: issuesOf(record.factIssues),
    selected_for_delivery: record.selectedForDelivery,
    fallback_reason: record.fallbackReason,
    error_code: record.errorCode,
    candidate: candidateOf(record.candidate),
    calls: record.calls,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    api_cost_usd: record.costUsd,
    ...(context.createdAt ? { created_at: context.createdAt.toISOString() } : {}),
  }));
}

/** Short stable hash of the instructions the model was given: which prompt produced a candidate. */
export async function promptHash(instructions: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(instructions));
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type TraceInsert = (table: string, rows: TraceRow[]) => Promise<void>;

/**
 * Best effort. Never throws, never retries, never calls the model, and a row that still looks like it holds
 * a credential after redaction is dropped instead of written. Returns whether the rows were written.
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
