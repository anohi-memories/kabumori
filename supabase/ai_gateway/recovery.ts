// G6-06 (2026-10-20): reconciliation of calls the gateway left IN PROGRESS (an `ai_calls` row still `acquired`) after a
// crash, a lost response or a lost record. NOT deployed, no scheduler: a future job (separately approved) would run it.
//
// It only ever uses the three EXISTING service RPCs, through a port that refuses any other name:
//   ai_ledger_recover_stale       finalise expired unsent holds (released) and long-sent attempts (unknown, upper bound);
//   ai_calls_recovery_candidates  old acquired rows + what the ledger knows of them (open / sent attempts, cost, basis);
//   ai_calls_abandon              close one row as the UNKNOWN tombstone, only when the ledger has no open attempt and
//                                 the audit agrees with the ledger (checked again in SQL).
// It never sends, never calls the gateway or a provider, never reopens a claim, never deletes, never turns UNKNOWN into
// "safe to resend". The ledger stays the cost truth: an audit is built from the ledger and never shows less.
//
// What it adds over the PR256 maintenance mock (bridge registrations): the G6 policy registry (`app:feature`, role, model,
// revision, subject, attempts, the 1 USD store limit), a per-policy "may still be running" age so a live call is never
// fenced, strict candidate validation with anomalies left for an operator, an advise-only mode (no write at all), and a
// ledger-based classification:
//   NOT_SENT_PROVEN  no attempt ever reached mark_sent (no settled / unknown attempt, none open): nothing was sent or
//                    charged. ai_calls can only close it as UNKNOWN today (no "not sent" close exists: BLOCKED_SQL).
//   RESULT_LOST      every attempt settled with measured usage: the provider answered and was charged; the answer was lost.
//   POSSIBLY_SENT    an attempt is unknown / upper bound (timeout, lost connection, 5xx, recovered): it may have run.
// See docs/ai-provider/G6_UNKNOWN_RECOVERY.md.
import type { FeaturePolicy, PolicyRegistry } from "./gateway.ts";

export type RecoveryRpc = (name: string, p: unknown) => Promise<unknown>;
const ALLOWED_RPCS: readonly string[] = ["ai_ledger_recover_stale", "ai_calls_recovery_candidates", "ai_calls_abandon"];

export type Classification = "NOT_SENT_PROVEN" | "RESULT_LOST" | "POSSIBLY_SENT";
export type Outcome =
  | "ABANDONED" // closed as the UNKNOWN tombstone (apply mode)
  | "WOULD_ABANDON" // advise mode: what apply would do
  | "WAIT_LEDGER_OPEN" // an attempt is still reserved / sent: a later run (after recover_stale) decides
  | "WAIT_MAY_BE_RUNNING" // younger than the policy's longest possible run: never fence a live call
  | "WAIT_SQL_TOO_RECENT" // ai_calls_abandon's own age rule
  | "ALREADY_CLOSED" // completed or abandoned meanwhile (owner finished, or a parallel run won)
  | "RETRY_LATER" // the ledger changed between the read and the close (audit refused): read again next run
  | "UNREGISTERED" // no policy for app:feature (or another app's row): an operator decides, nothing is guessed
  | "ANOMALY"; // a row or ledger state the gateway cannot have produced: left alone, reported

export type CandidateReport = Readonly<{
  callKey: string;
  storeFeature: string;
  application: string;
  classification: Classification | null;
  outcome: Outcome;
  detail: string | null;
  /** For a close: the attempts and the cost the audit records (from the ledger, rounded UP to the ledger's 8 decimals). */
  attempts: number | null;
  costUsd: number | null;
}>;

export type ReconcileResult = Readonly<{
  mode: "advise" | "apply";
  recovered: Readonly<{ released: number; marked_unknown: number }> | null;
  candidates: readonly CandidateReport[];
}>;

export type ReconcileOptions = Readonly<{
  /** "advise" (default) writes nothing; "apply" runs recover_stale and closes what is safe to close. */
  mode?: "advise" | "apply";
  /** The SQL rule (300..2592000 s, default 1800). The per-policy running age below applies on top. */
  abandonAfterSeconds?: number;
  /** Candidates per run (1..1000, default 100). */
  limit?: number;
  nowMs?: () => number;
  /** Extra margin on the longest possible run (authority, ledger and store calls). Default 120 s. */
  marginMs?: number;
}>;

const CALL_KEY = /^h5m2_[0-9a-f]{64}$/u;
const TENANT = /^[0-9a-f]{64}$/u;
const CANDIDATE_KEYS = "application,call_key,created_at,estimated_cost_usd,feature,includes_upper_bound,logical_roles,models,open_attempts,sent_attempts,subject_kind,tenant_tag";
const UNIT = 100_000_000;
/** The provider's DEFAULT_RETRY_TIMING.maxRetryAfterMs: the longest wait between two attempts. */
const MAX_RETRY_WAIT_MS = 20_000;
/** ai_calls.audit_ok accepts at most 1 USD per operation. */
const STORE_COST_LIMIT_USD = 1;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The longest one gateway call under this policy can still be running (every attempt, the waits, a margin). */
export function longestRunMs(policy: FeaturePolicy, marginMs: number): number {
  return policy.timeoutMs * policy.maxAttempts + MAX_RETRY_WAIT_MS * (policy.maxAttempts - 1) + marginMs;
}

/** Only the three recovery RPCs can be called through this port; anything else throws before any request. */
function guardedRpc(rpc: RecoveryRpc): RecoveryRpc {
  return (name, p) => {
    if (!ALLOWED_RPCS.includes(name)) return Promise.reject(new Error(`RECOVERY_RPC_NOT_ALLOWED:${name}`));
    return rpc(name, p);
  };
}

type Plan = Readonly<{ report: CandidateReport; close: Record<string, unknown> | null }>;

/** Decide one candidate (pure). */
function plan(raw: unknown, policies: PolicyRegistry, nowMs: number, abandonAfterSeconds: number, marginMs: number): Plan {
  const anomaly = (callKey: string, storeFeature: string, application: string, detail: string): Plan => ({
    report: { callKey, storeFeature, application, classification: null, outcome: "ANOMALY", detail, attempts: null, costUsd: null },
    close: null,
  });
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== CANDIDATE_KEYS) return anomaly("?", "?", "?", "CANDIDATE_SHAPE");
  const c = raw;
  const callKey = typeof c.call_key === "string" && CALL_KEY.test(c.call_key) ? c.call_key : null;
  const storeFeature = typeof c.feature === "string" ? c.feature : "?";
  const application = typeof c.application === "string" ? c.application : "?";
  if (!callKey || typeof c.tenant_tag !== "string" || !TENANT.test(c.tenant_tag)) return anomaly(String(c.call_key ?? "?"), storeFeature, application, "CANDIDATE_IDENTITY");
  const created = typeof c.created_at === "string" ? Date.parse(c.created_at) : NaN;
  const cost = typeof c.estimated_cost_usd === "number" ? c.estimated_cost_usd : typeof c.estimated_cost_usd === "string" ? Number(c.estimated_cost_usd) : NaN;
  if (!count(c.open_attempts) || !count(c.sent_attempts) || !Number.isFinite(created) || !Number.isFinite(cost) || cost < 0 ||
    typeof c.includes_upper_bound !== "boolean" || !Array.isArray(c.models) || !Array.isArray(c.logical_roles) ||
    !c.models.every((m) => typeof m === "string") || !c.logical_roles.every((r) => typeof r === "string") ||
    (c.subject_kind !== "user" && c.subject_kind !== "system")) {
    return anomaly(callKey, storeFeature, application, "CANDIDATE_VALUES");
  }
  const base = { callKey, storeFeature, application };
  const policy = policies.get(storeFeature);
  if (!policy || `${policy.app}:${policy.feature}` !== storeFeature || policy.app !== application) {
    return { report: { ...base, classification: null, outcome: "UNREGISTERED", detail: policy ? "APPLICATION_MISMATCH" : "NO_POLICY", attempts: null, costUsd: null }, close: null };
  }
  if (!policy.subjectKinds.includes(c.subject_kind)) return anomaly(callKey, storeFeature, application, "SUBJECT_KIND");
  const models = c.models as string[];
  const roles = c.logical_roles as string[];
  if (models.some((m) => m !== policy.model)) return anomaly(callKey, storeFeature, application, "LEDGER_MODEL");
  if (roles.some((r) => r !== policy.logicalRole)) return anomaly(callKey, storeFeature, application, "LEDGER_ROLE");
  const open = c.open_attempts as number;
  const sent = c.sent_attempts as number;
  if (sent + open > policy.maxAttempts) return anomaly(callKey, storeFeature, application, "ATTEMPTS");
  if (sent === 0 && (cost !== 0 || c.includes_upper_bound)) return anomaly(callKey, storeFeature, application, "COST_WITHOUT_ATTEMPT");
  if (open > 0) return { report: { ...base, classification: null, outcome: "WAIT_LEDGER_OPEN", detail: `${open}_OPEN`, attempts: null, costUsd: null }, close: null };

  const classification: Classification = sent === 0 ? "NOT_SENT_PROVEN" : c.includes_upper_bound ? "POSSIBLY_SENT" : "RESULT_LOST";
  // Never fence a call that may still be running (its own owner would then lose its answer).
  const age = nowMs - created;
  if (age < Math.max(longestRunMs(policy, marginMs), abandonAfterSeconds * 1000)) {
    return { report: { ...base, classification, outcome: "WAIT_MAY_BE_RUNNING", detail: null, attempts: null, costUsd: null }, close: null };
  }
  const costUsd = Math.ceil(cost * UNIT) / UNIT; // never below the ledger's charge
  if (costUsd > STORE_COST_LIMIT_USD) return anomaly(callKey, storeFeature, application, "COST_ABOVE_STORE_LIMIT");
  const audit = {
    callId: callKey,
    tenantTag: c.tenant_tag,
    feature: storeFeature,
    role: policy.logicalRole,
    model: policy.model,
    // The revision at call time is not recorded anywhere; the current one is written. A replay under another revision
    // is another operation content (OPERATION_REUSED), so a stale revision here can never be replayed as an answer.
    policyVersion: policy.revision,
    attempts: sent,
    estimatedCostUsd: costUsd,
    costBasis: sent === 0 ? "no_request" : c.includes_upper_bound ? "includes_upper_bound" : "measured",
  };
  return {
    report: {
      ...base,
      classification,
      outcome: "WOULD_ABANDON",
      // NOT_SENT_PROVEN deserves a "not sent" close; ai_calls only has the UNKNOWN tombstone (conservative).
      detail: classification === "NOT_SENT_PROVEN" ? "BLOCKED_SQL_NO_NOT_SENT_CLOSE" : null,
      attempts: sent,
      costUsd,
    },
    close: { call_key: callKey, audit, older_than_seconds: abandonAfterSeconds },
  };
}

/**
 * One reconciliation run. Idempotent: a second run on the same state closes nothing more; parallel runs are safe
 * (ai_calls_abandon locks the row; the loser sees ALREADY_CLOSED). A failure of one close never stops the others.
 */
export async function reconcileUnknownCalls(rpc: RecoveryRpc, policies: PolicyRegistry, options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const mode = options.mode ?? "advise";
  if (mode !== "advise" && mode !== "apply") throw new Error("RECOVERY_MODE_INVALID");
  const abandonAfterSeconds = options.abandonAfterSeconds ?? 1800;
  if (!Number.isInteger(abandonAfterSeconds) || abandonAfterSeconds < 300 || abandonAfterSeconds > 2_592_000) throw new Error("RECOVERY_AGE_INVALID");
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("RECOVERY_LIMIT_INVALID");
  const marginMs = options.marginMs ?? 120_000;
  if (!Number.isInteger(marginMs) || marginMs < 0) throw new Error("RECOVERY_MARGIN_INVALID");
  const now = options.nowMs ?? (() => Date.now());
  const call = guardedRpc(rpc);

  let recovered: ReconcileResult["recovered"] = null;
  if (mode === "apply") {
    const r = await call("ai_ledger_recover_stale", {});
    if (!isRecord(r) || !count(r.released) || !count(r.marked_unknown)) throw new Error("RECOVERY_LEDGER_ANSWER");
    recovered = { released: r.released, marked_unknown: r.marked_unknown };
  }
  const listed = await call("ai_calls_recovery_candidates", { older_than_seconds: abandonAfterSeconds, limit });
  if (!Array.isArray(listed)) throw new Error("RECOVERY_CANDIDATES_ANSWER");

  const reports: CandidateReport[] = [];
  for (const raw of listed) {
    const p = plan(raw, policies, now(), abandonAfterSeconds, marginMs);
    if (!p.close || mode === "advise") {
      reports.push(p.report);
      continue;
    }
    let outcome: Outcome;
    let detail = p.report.detail;
    try {
      const answer = await call("ai_calls_abandon", p.close);
      if (isRecord(answer) && answer.abandoned === true) outcome = "ABANDONED";
      else if (isRecord(answer) && answer.reason === "TOO_RECENT") outcome = "WAIT_SQL_TOO_RECENT";
      else if (isRecord(answer) && answer.reason === "LEDGER_NOT_FINAL") outcome = "WAIT_LEDGER_OPEN";
      else if (isRecord(answer) && (answer.reason === "NOT_ACQUIRED" || answer.reason === "NOT_FOUND")) outcome = "ALREADY_CLOSED";
      else {
        outcome = "ANOMALY";
        detail = "ABANDON_ANSWER";
      }
    } catch {
      // Typically AI_CALLS_AUDIT_LEDGER_MISMATCH: the ledger moved after the read. Nothing changed; read again next run.
      outcome = "RETRY_LATER";
    }
    reports.push({ ...p.report, outcome, detail });
  }
  return { mode, recovered, candidates: reports };
}
