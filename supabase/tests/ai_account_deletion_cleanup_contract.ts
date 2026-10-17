// REFERENCE (F6, 2026-10-17) of the AI-cleanup step of a common-account deletion, for the account-deletion owner
// (F5 / G5) to adopt in its own orchestrator. NOT deployed: nothing deployable imports this file, it calls nothing on
// its own (every RPC goes through the injected `rpc`), and it holds no key. Contract:
// docs/ai-provider/F6_F5_ACCOUNT_DELETION_AI_CLEANUP_CONTRACT.md.
//
// One call = one pass of: forget the user's call-store rows -> forget the system rows tagged with the user's POSTONA
// workspace slug -> pseudonymise the user in the cost ledger -> read back that NOTHING of the user is left. Every RPC
// is idempotent and atomic; a pass that does not end with an all-zero read-back is never reported as done. A failed
// or unexpected answer stops the pass (fail closed); the caller repeats the pass later (it is safe to repeat).

export type Rpc = (name: string, p: Record<string, unknown>) => Promise<unknown>;

/** The largest bridge deadline a registered feature may have (ConsumerFeature.deadlineMs <= 60 s). */
export const BRIDGE_MAX_DEADLINE_MS = 60_000;
/** Extra wait after the deadline: clock skew, a worker finishing its last statement. */
export const DEFAULT_MARGIN_MS = 120_000;

export type CleanupRequest = Readonly<{
  /** auth.users id of the person, canonical lower-case uuid (the call store accepts only that form). */
  userId: string;
  /** The person's own POSTONA workspace slug (u_ + 24 hex), or null when they never had one. Never the user id. */
  workspaceSlug: string | null;
  /** Server time at which F5 read back that every service entitlement of the person is `ended`; null = not yet. */
  entitlementsEndedAtMs: number | null;
  /** F5 / POSTONA read-back that the AI entry points now refuse this person (no new claim can start). */
  aiAuthorizationStopped: boolean;
  nowMs: number;
  marginMs?: number;
}>;

export type Footprint = Readonly<{
  reservations: number;
  usage_events: number;
  budget_buckets: number;
  budget_policies: number;
  policy_mentions: number;
  call_rows: number;
  brand_call_rows?: number;
}>;
export type Step = "forget_user" | "forget_system_brand" | "erase_user" | "footprint";
export type CleanupResult =
  | Readonly<{
    status: "done";
    callRowsDeleted: number;
    systemBrandRowsDeleted: number;
    erased: Readonly<{ reservations: number; usage_events: number; budget_buckets: number; budget_policies: number }>;
    footprint: Footprint;
  }>
  | Readonly<{ status: "refused"; reason: "PRECONDITION_ENTITLEMENTS_NOT_ENDED" | "PRECONDITION_AI_AUTHORIZATION_ACTIVE" | "INVALID_USER_ID" | "INVALID_WORKSPACE_SLUG" }>
  | Readonly<{ status: "wait"; reason: "BRIDGE_DEADLINE"; retryAfterMs: number }>
  | Readonly<{ status: "retry_later"; step: Step; reason: "CALLS_IN_FLIGHT" | "LEDGER_IN_FLIGHT" | "CALL_STORE_NOT_FORGOTTEN" | "FOOTPRINT_NOT_ZERO"; detail: Record<string, unknown> }>
  | Readonly<{ status: "operator_required"; step: "erase_user"; reason: "POLICY_TEXT_MENTIONS_USER" | "POLICY_KEY_CONFLICT"; detail: Record<string, unknown> }>
  | Readonly<{ status: "failed"; step: Step; reason: "RPC_ERROR" | "UNEXPECTED_RESPONSE" }>;

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERASED_SUBJECT = /^00000000-0000-0000-/;
const WORKSPACE_SLUG = /^u_[0-9a-f]{24}$/;

const isCount = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** The exact key set (no more, no fewer). */
function keys(v: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(v).sort();
  const want = [...expected].sort();
  return actual.length === want.length && actual.every((k, i) => k === want[i]);
}

class Stop extends Error {
  constructor(readonly result: CleanupResult) {
    super(result.status);
  }
}

async function call(rpc: Rpc, step: Step, name: string, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  let answer: unknown;
  try {
    answer = await rpc(name, p);
  } catch {
    throw new Stop({ status: "failed", step, reason: "RPC_ERROR" });
  }
  if (!isRecord(answer)) throw new Stop({ status: "failed", step, reason: "UNEXPECTED_RESPONSE" });
  return answer;
}
const unexpected = (step: Step): never => {
  throw new Stop({ status: "failed", step, reason: "UNEXPECTED_RESPONSE" });
};

export async function runAiAccountCleanup(rpc: Rpc, request: CleanupRequest): Promise<CleanupResult> {
  // Inputs: never mix the user id and the workspace slug, never a pseudonymised (erased) id.
  if (typeof request.userId !== "string" || !USER_ID.test(request.userId) || ERASED_SUBJECT.test(request.userId)) {
    return { status: "refused", reason: "INVALID_USER_ID" };
  }
  if (request.workspaceSlug !== null && (typeof request.workspaceSlug !== "string" || !WORKSPACE_SLUG.test(request.workspaceSlug))) {
    return { status: "refused", reason: "INVALID_WORKSPACE_SLUG" };
  }
  // Preconditions read back by F5 / POSTONA: no new AI work can start for this person.
  if (request.entitlementsEndedAtMs === null || !Number.isFinite(request.entitlementsEndedAtMs)) {
    return { status: "refused", reason: "PRECONDITION_ENTITLEMENTS_NOT_ENDED" };
  }
  if (request.aiAuthorizationStopped !== true) return { status: "refused", reason: "PRECONDITION_AI_AUTHORIZATION_ACTIVE" };
  // Work that was authorised just before can still run until its bridge deadline.
  const readyAt = request.entitlementsEndedAtMs + BRIDGE_MAX_DEADLINE_MS + (request.marginMs ?? DEFAULT_MARGIN_MS);
  if (request.nowMs < readyAt) return { status: "wait", reason: "BRIDGE_DEADLINE", retryAfterMs: readyAt - request.nowMs };

  try {
    // 1. The person's call-store rows.
    const forget = await call(rpc, "forget_user", "ai_calls_forget_user", { user_id: request.userId });
    let callRowsDeleted: number;
    if (forget.forgotten === true && keys(forget, ["forgotten", "deleted", "ledger_reservations_retained"]) &&
      isCount(forget.deleted) && isCount(forget.ledger_reservations_retained)) {
      callRowsDeleted = forget.deleted;
    } else if (forget.forgotten === false && forget.reason === "CALLS_IN_FLIGHT" && keys(forget, ["forgotten", "reason", "in_flight"]) &&
      isCount(forget.in_flight, 1)) {
      return { status: "retry_later", step: "forget_user", reason: "CALLS_IN_FLIGHT", detail: { in_flight: forget.in_flight } };
    } else return unexpected("forget_user");

    // 2. System-subject rows tagged with the person's workspace slug (forget_user cannot reach them).
    let systemBrandRowsDeleted = 0;
    if (request.workspaceSlug !== null) {
      const brand = await call(rpc, "forget_system_brand", "ai_calls_forget_system_brand", { brand_ref: request.workspaceSlug });
      if (brand.forgotten === true && keys(brand, ["forgotten", "deleted"]) && isCount(brand.deleted)) {
        systemBrandRowsDeleted = brand.deleted;
      } else if (brand.forgotten === false && brand.reason === "CALLS_IN_FLIGHT" && isCount(brand.in_flight, 1) &&
        (keys(brand, ["forgotten", "reason", "in_flight"]) || (keys(brand, ["forgotten", "reason", "in_flight", "deleted"]) && isCount(brand.deleted)))) {
        return { status: "retry_later", step: "forget_system_brand", reason: "CALLS_IN_FLIGHT", detail: { in_flight: brand.in_flight } };
      } else return unexpected("forget_system_brand");
    }

    // 3. The person's cost-ledger rows become one erased subject.
    const erase = await call(rpc, "erase_user", "ai_ledger_erase_user", { user_id: request.userId });
    let erased: Extract<CleanupResult, { status: "done" }>["erased"];
    if (erase.erased === true && keys(erase, ["erased", "reservations", "usage_events", "budget_buckets", "budget_policies"]) &&
      isCount(erase.reservations) && isCount(erase.usage_events) && isCount(erase.budget_buckets) && isCount(erase.budget_policies)) {
      erased = {
        reservations: erase.reservations,
        usage_events: erase.usage_events,
        budget_buckets: erase.budget_buckets,
        budget_policies: erase.budget_policies,
      };
    } else if (erase.erased === false && erase.reason === "CALL_STORE_NOT_FORGOTTEN" && keys(erase, ["erased", "reason", "call_rows"]) && isCount(erase.call_rows, 1)) {
      // A claim landed after step 1 (an entry that did not stop): the next pass forgets it again.
      return { status: "retry_later", step: "erase_user", reason: "CALL_STORE_NOT_FORGOTTEN", detail: { call_rows: erase.call_rows } };
    } else if (erase.erased === false && erase.reason === "LEDGER_IN_FLIGHT" && keys(erase, ["erased", "reason", "in_flight"]) && isCount(erase.in_flight, 1)) {
      return { status: "retry_later", step: "erase_user", reason: "LEDGER_IN_FLIGHT", detail: { in_flight: erase.in_flight } };
    } else if (erase.erased === false && erase.reason === "POLICY_TEXT_MENTIONS_USER" && keys(erase, ["erased", "reason", "policies"]) && isCount(erase.policies, 1)) {
      return { status: "operator_required", step: "erase_user", reason: "POLICY_TEXT_MENTIONS_USER", detail: { policies: erase.policies } };
    } else if (erase.erased === false && erase.reason === "POLICY_KEY_CONFLICT" && keys(erase, ["erased", "reason"])) {
      return { status: "operator_required", step: "erase_user", reason: "POLICY_KEY_CONFLICT", detail: {} };
    } else return unexpected("erase_user");

    // 4. Read-back: nothing of the person may remain (policy_mentions included). Anything else is not done.
    const footprintInput: Record<string, unknown> = { user_id: request.userId };
    if (request.workspaceSlug !== null) footprintInput.brand_ref = request.workspaceSlug;
    const fp = await call(rpc, "footprint", "ai_ledger_user_footprint", footprintInput);
    const fpKeys = ["reservations", "usage_events", "budget_buckets", "budget_policies", "policy_mentions", "call_rows"];
    if (request.workspaceSlug !== null) fpKeys.push("brand_call_rows");
    if (!keys(fp, fpKeys) || !fpKeys.every((k) => isCount(fp[k]))) return unexpected("footprint");
    const footprint = fp as unknown as Footprint;
    if (fpKeys.some((k) => fp[k] !== 0)) {
      return { status: "retry_later", step: "footprint", reason: "FOOTPRINT_NOT_ZERO", detail: { ...footprint } };
    }
    return { status: "done", callRowsDeleted, systemBrandRowsDeleted, erased, footprint };
  } catch (error) {
    if (error instanceof Stop) return error.result;
    throw error;
  }
}
