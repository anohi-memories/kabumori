// Delivery policy Phase 1: shadow PASS / WARN / BLOCK classification + telemetry (observability only).
//
// Pure: derived from an already-finished ReportOutcome. It never feeds back into generation, the local
// checks, the Fact check, or the save / notify decision — reportUpdate() and the enqueue path behave
// exactly as before; this only adds `source_basis.delivery_policy`.
//
// Responsibilities (voice-gate audit, K2-accepted):
//   Fact    — numbers, entities, dates, causation, evidence, data consistency, unsupported impact
//   Safety  — explicit buy/sell advice, fabricated claims, URLs / markup, structural invalidity
//   Voice   — length, emoji, labels, Latin words, date formatting, minor style
// Only Voice-class local issues are WARN candidates; everything else mirrors an existing blocker.
// Phase 1 has no rewrite and no fallback, so those fields are always false.

import type { ReportOutcome } from "./report_logic.ts";

export const DELIVERY_POLICY_VERSION = "delivery_policy.v1_shadow" as const;

export type VoiceStatus = "pass" | "warn" | "block" | "unavailable";
export type DeliveryBlocker = "data" | "infra" | "structure" | "local_fact_safety" | "local_style" | "fact" | null;
export type IssueClass = "block" | "warn";

// Local issue codes that are style/readability only (WARN candidates under a future warn_deliver policy).
export const WARN_LOCAL_CODES: ReadonlySet<string> = new Set([
  "TITLE_TOO_LONG",
  "SUMMARY_TOO_LONG",
  "OVERVIEW_TOO_LONG",
  "IMPACT_TOO_LONG",
  "WATCH_NOTE_TOO_LONG",
  "TOO_MANY_WATCH_NOTES",
  "RISK_NOTES_INVALID",
  "MORNING_REVIEW_TOO_LONG",
  "CONTAINS_LATIN_WORD",
  "CONTAINS_EMOJI",
  "CONTAINS_NEWS_LABEL",
  "CONTAINS_ISO_DATE",
]);

// Local issue codes that mirror existing Fact / Safety / structure blockers. Listed explicitly so a new
// code is never silently treated as style: anything not in WARN_LOCAL_CODES classifies as block.
export const BLOCK_LOCAL_CODES: ReadonlySet<string> = new Set([
  "NUMBER_NOT_IN_PACKET",
  "UNKNOWN_HOLDING_TICKER",
  "UNKNOWN_WATCH_TICKER",
  "DUPLICATE_TICKER_NOTE",
  "MISSING_HOLDING_IMPACTS",
  "BASIS_NOT_AVAILABLE",
  "STANCE_WITHOUT_BASIS",
  "STANCE_BASIS_MISMATCH",
  "FALSE_NO_MATERIAL_CLAIM",
  "INFERENCE_NOT_HEDGED",
  "CONTAINS_INVESTMENT_ADVICE",
  "CONTAINS_URL",
  "CONTAINS_MARKUP",
  "CONTRADICTS_SHARED_MARKET",
  "UNSUPPORTED_MULTI_DAY_WORD",
  "MORNING_REVIEW_ON_MORNING",
  "CHECKPOINTS_INVALID",
  "NOT_JAPANESE",
]);

const DATA_BLOCKERS: ReadonlySet<string> = new Set(["NO_TRACKED_STOCKS", "PRICES_UNAVAILABLE"]);
const STRUCTURE_ERRORS: ReadonlySet<string> = new Set([
  "REPORT_INSUFFICIENT_INFORMATION",
  "REPORT_EMPTY_FIELD",
  "REPORT_INVALID_OUTPUT",
  "REPORT_EMPTY_OUTPUT",
]);

/** The code part of a local issue ("IMPACT_TOO_LONG:1111" → "IMPACT_TOO_LONG"). */
export function issueCode(issue: string): string {
  return issue.split(":")[0];
}

export function classifyLocalIssue(issue: string): IssueClass {
  return WARN_LOCAL_CODES.has(issueCode(issue)) ? "warn" : "block";
}

export type DeliveryPolicyTelemetry = {
  version: typeof DELIVERY_POLICY_VERSION;
  mode: "shadow";
  voice_status: VoiceStatus;
  warning_codes: string[];
  block_codes: string[];
  // What actually stopped delivery under the current (fail-closed) behavior; null when delivered.
  delivery_blocked_by: DeliveryBlocker;
  // Shadow answer only: would a future warn_deliver policy have delivered this report?
  would_deliver_under_warn_policy: boolean;
  rewrite_attempted: false;
  rewrite_succeeded: false;
  fallback_original_used: false;
};

/**
 * Classifies a finished outcome. Never throws: anything unexpected yields voice_status "unavailable"
 * with the current blocker preserved, so telemetry can never become a new delivery failure.
 */
export function classifyDelivery(outcome: Pick<ReportOutcome, "status" | "error" | "issues" | "calls">): DeliveryPolicyTelemetry {
  const base = {
    version: DELIVERY_POLICY_VERSION,
    mode: "shadow" as const,
    rewrite_attempted: false as const,
    rewrite_succeeded: false as const,
    fallback_original_used: false as const,
  };
  try {
    const error = outcome.error ?? null;
    const issues = Array.isArray(outcome.issues) ? outcome.issues.filter((issue) => typeof issue === "string") : [];
    if (outcome.status === "passed" && !error) {
      return { ...base, voice_status: "pass", warning_codes: [], block_codes: [], delivery_blocked_by: null, would_deliver_under_warn_policy: true };
    }
    if (error === "REPORT_LOCAL_CHECK_FAILED") {
      const codes = [...new Set(issues.map(issueCode))];
      const warnings = codes.filter((code) => WARN_LOCAL_CODES.has(code));
      const blocks = codes.filter((code) => !WARN_LOCAL_CODES.has(code));
      const styleOnly = blocks.length === 0 && warnings.length > 0;
      return {
        ...base,
        voice_status: styleOnly ? "warn" : "block",
        warning_codes: warnings,
        block_codes: blocks,
        delivery_blocked_by: styleOnly ? "local_style" : "local_fact_safety",
        // Style-only local failures never reached the Fact check, so a warn policy would still need Fact.
        would_deliver_under_warn_policy: false,
      };
    }
    if (error === "REPORT_FACT_FAILED") {
      return { ...base, voice_status: "block", warning_codes: [], block_codes: ["REPORT_FACT_FAILED"], delivery_blocked_by: "fact", would_deliver_under_warn_policy: false };
    }
    if (error && DATA_BLOCKERS.has(error)) {
      return { ...base, voice_status: "unavailable", warning_codes: [], block_codes: [error], delivery_blocked_by: "data", would_deliver_under_warn_policy: false };
    }
    if (error && STRUCTURE_ERRORS.has(error)) {
      return { ...base, voice_status: "block", warning_codes: [], block_codes: [error], delivery_blocked_by: "structure", would_deliver_under_warn_policy: false };
    }
    // Transport / unexpected errors: nothing to classify; delivery was already stopped by infra.
    return {
      ...base,
      voice_status: "unavailable",
      warning_codes: [],
      block_codes: error ? [issueCode(error)] : [],
      delivery_blocked_by: "infra",
      would_deliver_under_warn_policy: false,
    };
  } catch {
    return { ...base, voice_status: "unavailable", warning_codes: [], block_codes: [], delivery_blocked_by: "infra", would_deliver_under_warn_policy: false };
  }
}

/** sourceBasis plus the shadow telemetry; every existing key is kept as-is. */
export function withDeliveryPolicy(
  sourceBasis: Record<string, unknown>,
  outcome: Pick<ReportOutcome, "status" | "error" | "issues" | "calls">,
): Record<string, unknown> {
  return { ...sourceBasis, delivery_policy: classifyDelivery(outcome) };
}
