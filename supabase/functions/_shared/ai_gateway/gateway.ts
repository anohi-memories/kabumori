// REFERENCE MODEL (F6, 2026-10-19) of the app-independent common AI gateway contract shared by Kabumori, POSTONA
// and (later) Miseiro. NOT deployed: nothing deployable imports this file, it is not wired into any app, and every
// side effect is injected (authority, policies, provider fetch, ledger guard, call store). It exists so the contract
// in docs/ai-provider/F6_CROSS_APP_GATEWAY_OFFLINE_CONTRACT.md can be tested offline against the REAL shared provider
// (executeAiRequest) without building a gateway.
//
// Order of one call (each step refuses before anything costs money or leaves the process):
//   request shape -> authority verdict (G5's, an INPUT here) -> app feature policy -> cost bound -> call key and
//   claim (idempotency) -> [per attempt] ledger reserve -> claim still held -> authority RECHECK -> ledger mark sent ->
//   ONE provider request -> ledger settle | unknown -> app output check -> record the outcome -> answer.
// G6-20 (owner-held ledger, the runtime default): "ledger reserve" and "ledger mark sent" each check, in the same
// database transaction, that this claim still owns the call, so the separate "claim still held" step is gone.
//
// 2026-10-19 (PR289 GAP-1..3): a revocation before ANY attempt is AUTH_REVOKED_BEFORE_SEND (not a quota); a ledger
// that is unreachable or does not confirm the send is LEDGER_UNAVAILABLE (not a quota); the stored outcome uses the
// call store's audit (ai_calls / H5 bridge Audit, nine keys), mapped here and checked again on replay.
import {
  type AiRequest,
  type AiSubject,
  type BudgetGuard,
  executeAiRequest,
  type ExecuteDeps,
  findModelSpec,
  type JsonSchema,
  LedgerOwnerNotHeldError,
  upperBoundAttemptCostUsd,
} from "../ai_provider/mod.ts";

export type AppId = "kabumori" | "postona" | "miseiro";
const APPS: readonly AppId[] = ["kabumori", "postona", "miseiro"];

/** A brand / shop / workspace of one app, by its slug. Never a user id, never a ledger brand_id. */
export type BrandRef = Readonly<{ app: AppId; slug: string }>;
export type GatewaySubject =
  | Readonly<{ kind: "system"; app: AppId }>
  | Readonly<{ kind: "user"; app: AppId; userId: string; brand: BrandRef | null }>;

/**
 * The authority's answer (G5 for people; the app's own server-side job authority for system work). The gateway never
 * derives identity, ownership or service state itself: it consumes this verdict and refuses anything but "allow".
 */
export type AuthVerdict = Readonly<{
  decision: "allow" | "deny" | "unknown" | "pending";
  subject: GatewaySubject;
  /** Opaque lifecycle / ownership generation (for example an owner epoch); a recheck must return the same value. */
  generation: string;
  expiresAtMs: number;
  reason?: string;
}>;
export type AuthorityPort = Readonly<{
  verdict(credential: unknown, scope: Readonly<{ app: AppId; feature: string; brand: BrandRef | null }>): Promise<AuthVerdict>;
  /** Asked again immediately before EACH provider attempt. */
  recheck(prior: AuthVerdict): Promise<AuthVerdict>;
}>;

/** Defined by each app, consumed by the gateway. The request cannot choose the provider, the model or the limits. */
export type FeaturePolicy = Readonly<{
  app: AppId;
  feature: string;
  /** The policy's version; stored as the audit's policyVersion and part of the operation's fingerprint. */
  revision: string;
  /** The ledger feature (budget_policies.scope_feature) the calls are counted under. */
  ledgerFeature: string;
  logicalRole: string;
  provider: "openai" | "anthropic";
  model: string;
  reasoningEffort: AiRequest["reasoningEffort"];
  maxOutputTokens: number;
  timeoutMs: number;
  maxAttempts: 1 | 2 | 3;
  /** Upper bound of all attempts of ONE operation (USD); checked before any reservation. */
  maxCostUsdPerOperation: number;
  maxInputBytes: number;
  subjectKinds: readonly ("system" | "user")[];
  brandRequired: boolean;
  systemInstructions: string;
  schema: Readonly<{ name: string; schema: JsonSchema }>;
  /** Mandatory app check of the parsed output (no implicit pass). */
  validate: (payload: unknown) => boolean;
}>;
export type PolicyRegistry = ReadonlyMap<string, FeaturePolicy>;
export const policyKey = (app: AppId, feature: string) => `${app}:${feature}`;

export type GatewayRequest = Readonly<{ app: AppId; feature: string; operationId: string; input: string; brand: BrandRef | null }>;

export type GatewayAudit = Readonly<{
  callKey: string;
  tenantTag: string;
  app: AppId;
  feature: string;
  model: string;
  attempts: number;
  estimatedCostUsd: number;
  costBasis: "measured" | "includes_upper_bound" | "no_request";
}>;
export type GatewayCode =
  | "REQUEST_INVALID"
  | "AUTH_UNAVAILABLE"
  | "AUTH_DENIED"
  | "AUTH_UNKNOWN"
  | "AUTH_PENDING"
  | "AUTH_EXPIRED"
  | "AUTH_SCOPE_MISMATCH"
  | "POLICY_MISSING"
  | "POLICY_SUBJECT_DENIED"
  | "COST_DENIED"
  | "QUOTA_EXCEEDED"
  | "LEDGER_UNAVAILABLE"
  | "STORE_UNAVAILABLE"
  | "IN_PROGRESS"
  | "OPERATION_REUSED"
  | "AUTH_REVOKED_BEFORE_SEND"
  | "NOT_SENT"
  | "PROVIDER_FAILED"
  | "OUTPUT_REJECTED"
  | "UNKNOWN";
export type GatewayResult =
  | Readonly<{ ok: true; data: unknown; audit: GatewayAudit }>
  | Readonly<{ ok: false; code: GatewayCode; audit: GatewayAudit | null }>;

/** The stored outcome codes are the call store's (ai_calls accepts these and MODEL_UNAVAILABLE, never produced here). */
type StoredCode = "POLICY_DENIED" | "COST_DENIED" | "BUDGET_DENIED" | "OUTPUT_REJECTED" | "PROVIDER_FAILED" | "UNKNOWN";
const STORED_CODES: readonly string[] = ["POLICY_DENIED", "COST_DENIED", "BUDGET_DENIED", "OUTPUT_REJECTED", "PROVIDER_FAILED", "UNKNOWN"];
/**
 * The call store's audit: exactly the nine keys ai_calls.audit_ok (and the H5 bridge Audit) accept. `feature` is the
 * store feature `app:feature` (equal to the claimed row's feature), `role` the policy's logicalRole, `policyVersion`
 * the policy's revision. The app-facing GatewayAudit is rebuilt from it on replay, after checking every field.
 */
export type StoreAudit = Readonly<{
  callId: string;
  tenantTag: string;
  feature: string;
  role: string;
  model: string;
  policyVersion: string;
  attempts: number;
  estimatedCostUsd: number;
  costBasis: GatewayAudit["costBasis"];
}>;
const STORE_AUDIT_KEYS = "attempts,callId,costBasis,estimatedCostUsd,feature,model,policyVersion,role,tenantTag";
export type StoredOutcome =
  | Readonly<{ ok: true; data: unknown; audit: StoreAudit }>
  | Readonly<{ ok: false; code: StoredCode; audit: StoreAudit }>;
export type CallIdentity = Readonly<{ key: string; tenantTag: string; fingerprint: string }>;
export type CallClaim =
  | Readonly<{ kind: "acquired"; owner: string }>
  | Readonly<{ kind: "busy" | "conflict" }>
  | Readonly<{ kind: "complete"; fingerprint: string; outcome: StoredOutcome }>;
/** The durable call store (ai_calls in production design; unapplied). Bound to the verdict's subject per call. */
/** `storeFeature` is the row's feature (`app:feature`); the stored audit's feature must be the same value. */
export type ClaimContext = Readonly<{ app: AppId; feature: string; storeFeature: string; subject: GatewaySubject }>;
export interface CallStore {
  claim(identity: CallIdentity, context: ClaimContext): Promise<CallClaim>;
  complete(identity: CallIdentity, owner: string, outcome: StoredOutcome): Promise<void>;
}

export type GatewayDeps = Readonly<{
  authority: AuthorityPort;
  policies: PolicyRegistry;
  /** Shared provider: readEnv (provider keys), fetch, retry timing. */
  provider: Omit<ExecuteDeps, "budget">;
  /**
   * G6-20: the OWNER-HELD ledger (the default of createAiGateway): a ledger guard bound to this call's claim, whose
   * reserve / mark sent / release check, in the same database transaction, that the claim still owns the call
   * (candidate supabase/candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql). It replaces the busy re-claim as
   * the pre-send check (G6-17 / G6-18 KNOWN GAP 2 and 3, closed together: C1 + C3).
   */
  heldBudget?: (binding: HeldBinding) => BudgetGuard;
  /** The ledger without the owner check: used ONLY with legacyBusyHeldCheck (UNSAFE, kept for the older suites). */
  budget?: BudgetGuard;
  /**
   * UNSAFE legacy pre-send check (busy from a second ai_calls_claim), with the plain `budget`: a stalled process can
   * send for a row it no longer owns and re-create a forgotten row (G6-18 S2 / S3 / S5 / S8b). Never set by
   * createAiGateway's default; without heldBudget and without this flag the gateway refuses before anything is asked.
   */
  legacyBusyHeldCheck?: boolean;
  store: CallStore;
  nowMs?: () => number;
}>;

/** What the owner-held ledger needs to know about the claim that is about to spend. */
export type HeldBinding = Readonly<{ identity: CallIdentity; context: ClaimContext; owner: string }>;

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const FEATURE = /^[a-z][a-z0-9_.]{1,63}$/;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z][a-z0-9_]{1,40}$/;
const REQUEST_KEYS = ["app", "brand", "feature", "input", "operationId"];
const STORE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** Ledger refusals that are a budget decision; every other refusal means the ledger did not confirm (fail closed). */
const QUOTA_REASONS: readonly string[] = ["CALL_LIMIT", "COST_LIMIT", "PER_CALL_LIMIT", "NO_MATCHING_LIMIT"];

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameBrand = (a: BrandRef | null, b: BrandRef | null) => (a === null || b === null) ? a === b : a.app === b.app && a.slug === b.slug;
const fail = (code: GatewayCode, audit: GatewayAudit | null = null): GatewayResult => ({ ok: false, code, audit });

function validBrand(b: unknown): b is BrandRef {
  return isRecord(b) && Object.keys(b).sort().join(",") === "app,slug" && APPS.includes(b.app as AppId) && typeof b.slug === "string" &&
    SLUG.test(b.slug) && !USER_ID.test(b.slug);
}
function validSubject(s: unknown, app: AppId): s is GatewaySubject {
  if (!isRecord(s) || s.app !== app) return false;
  if (s.kind === "system") return Object.keys(s).sort().join(",") === "app,kind";
  return s.kind === "user" && Object.keys(s).sort().join(",") === "app,brand,kind,userId" && typeof s.userId === "string" &&
    USER_ID.test(s.userId) && (s.brand === null || (validBrand(s.brand) && (s.brand as BrandRef).app === app));
}
function verdictProblem(v: unknown, app: AppId, now: number): GatewayCode | null {
  if (!isRecord(v) || typeof v.generation !== "string" || v.generation === "" || typeof v.expiresAtMs !== "number") return "AUTH_UNKNOWN";
  if (v.decision === "deny") return "AUTH_DENIED";
  if (v.decision === "pending") return "AUTH_PENDING";
  if (v.decision !== "allow") return "AUTH_UNKNOWN";
  if (!(v.expiresAtMs > now)) return "AUTH_EXPIRED";
  if (!validSubject(v.subject, app)) return "AUTH_SCOPE_MISMATCH";
  return null;
}
/** GatewayAudit -> the call store's nine-key audit. */
export function toStoreAudit(a: GatewayAudit, policy: FeaturePolicy): StoreAudit {
  return {
    callId: a.callKey,
    tenantTag: a.tenantTag,
    feature: policyKey(a.app, a.feature),
    role: policy.logicalRole,
    model: a.model,
    policyVersion: policy.revision,
    attempts: a.attempts,
    estimatedCostUsd: a.estimatedCostUsd,
    costBasis: a.costBasis,
  };
}

/** A stored audit back to the GatewayAudit, only if every field is the one this call and policy would write. */
export function fromStoreAudit(s: unknown, expect: Readonly<{ callKey: string; tenantTag: string; app: AppId; feature: string; policy: FeaturePolicy }>): GatewayAudit | null {
  if (!isRecord(s) || Object.keys(s).sort().join(",") !== STORE_AUDIT_KEYS) return null;
  if (s.callId !== expect.callKey || s.tenantTag !== expect.tenantTag || s.feature !== policyKey(expect.app, expect.feature) ||
    s.role !== expect.policy.logicalRole || s.model !== expect.policy.model || s.policyVersion !== expect.policy.revision) return null;
  if (typeof s.attempts !== "number" || !Number.isInteger(s.attempts) || s.attempts < 0 || s.attempts > expect.policy.maxAttempts) return null;
  if (typeof s.estimatedCostUsd !== "number" || !Number.isFinite(s.estimatedCostUsd) || s.estimatedCostUsd < 0) return null;
  if (s.costBasis !== "measured" && s.costBasis !== "includes_upper_bound" && s.costBasis !== "no_request") return null;
  if ((s.attempts === 0) !== (s.costBasis === "no_request")) return null;
  return {
    callKey: expect.callKey,
    tenantTag: expect.tenantTag,
    app: expect.app,
    feature: expect.feature,
    model: expect.policy.model,
    attempts: s.attempts,
    estimatedCostUsd: s.estimatedCostUsd,
    costBasis: s.costBasis,
  };
}

/** What the ledger records: the person (no brand slug: the ledger's brand_id is a uuid), or system. */
function ledgerSubject(s: GatewaySubject): AiSubject {
  return s.kind === "system" ? { kind: "system" } : { kind: "user", userId: s.userId, brandId: null };
}

export async function gatewayExecute(deps: GatewayDeps, credential: unknown, request: unknown): Promise<GatewayResult> {
  const now = deps.nowMs ?? (() => Date.now());
  // 1. Shape: exactly these keys; the request names no model, provider, limit, user or subject.
  if (!isRecord(request) || Object.keys(request).sort().join(",") !== REQUEST_KEYS.join(",")) return fail("REQUEST_INVALID");
  const { app, feature, operationId, input, brand } = request as Record<string, unknown>;
  if (!APPS.includes(app as AppId) || typeof feature !== "string" || !FEATURE.test(feature) || typeof operationId !== "string" ||
    !OPERATION_ID.test(operationId) || typeof input !== "string" || !(brand === null || (validBrand(brand) && (brand as BrandRef).app === app))) {
    return fail("REQUEST_INVALID");
  }
  const req = { app: app as AppId, feature, operationId, input, brand: brand as BrandRef | null };
  // G6-20: the owner-held ledger, or explicitly the unsafe legacy check; anything else refuses before G5 is asked.
  const ownerHeld = typeof deps.heldBudget === "function";
  if (!ownerHeld && !(deps.legacyBusyHeldCheck === true && deps.budget)) return fail("LEDGER_UNAVAILABLE");

  // 2. The authority's verdict (an input: the gateway never decides identity, ownership or service state).
  let verdict: AuthVerdict;
  try {
    verdict = await deps.authority.verdict(credential, { app: req.app, feature: req.feature, brand: req.brand });
  } catch {
    return fail("AUTH_UNAVAILABLE");
  }
  const problem = verdictProblem(verdict, req.app, now());
  if (problem) return fail(problem);
  // The request's brand must be the one the authority approved (it is a selector, never authority).
  if (verdict.subject.kind === "user" ? !sameBrand(verdict.subject.brand, req.brand) : req.brand !== null) return fail("AUTH_SCOPE_MISMATCH");

  // 3. The app's feature policy: missing = refused (fail closed).
  const policy = deps.policies.get(policyKey(req.app, req.feature));
  if (!policy || policy.app !== req.app || policy.feature !== req.feature || typeof policy.validate !== "function" ||
    typeof policy.revision !== "string" || !REVISION.test(policy.revision) || typeof policy.logicalRole !== "string" ||
    !STORE_IDENTIFIER.test(policy.logicalRole) || !STORE_IDENTIFIER.test(policyKey(req.app, req.feature))) return fail("POLICY_MISSING");
  if (!policy.subjectKinds.includes(verdict.subject.kind)) return fail("POLICY_SUBJECT_DENIED");
  if (policy.brandRequired && req.brand === null) return fail("POLICY_SUBJECT_DENIED");
  if (new TextEncoder().encode(req.input).length > policy.maxInputBytes) return fail("REQUEST_INVALID");

  // 4. Keys: the tenant is the app + the verdict's subject (+ brand); the same operation id elsewhere is another call.
  const tenantTag = await sha256(JSON.stringify([req.app, verdict.subject]));
  const callKey = "h5m2_" + await sha256(JSON.stringify([tenantTag, policyKey(req.app, req.feature), req.operationId]));
  const aiRequest: AiRequest = {
    logicalRole: policy.logicalRole,
    provider: policy.provider,
    model: policy.model,
    systemInstructions: policy.systemInstructions,
    userContent: req.input,
    jsonSchema: policy.schema,
    reasoningEffort: policy.reasoningEffort,
    maxOutputTokens: policy.maxOutputTokens,
    timeoutMs: policy.timeoutMs,
    transport: { maxAttempts: policy.maxAttempts },
    usageContext: { application: req.app, feature: policy.ledgerFeature, subject: ledgerSubject(verdict.subject) },
    callId: callKey,
  };
  const noRequest: GatewayAudit = { callKey, tenantTag, app: req.app, feature: req.feature, model: policy.model, attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" };

  // 5. The per-operation cost bound (before any claim or reservation).
  const spec = findModelSpec(policy.model);
  if (!spec || spec.provider !== policy.provider) return fail("POLICY_MISSING");
  const upper = upperBoundAttemptCostUsd(spec, aiRequest) * policy.maxAttempts;
  if (!Number.isFinite(upper) || upper > policy.maxCostUsdPerOperation) return fail("COST_DENIED", noRequest);

  // 6. Idempotency: one claim per (tenant, feature, operation); the same content replays; other content is refused.
  const fingerprint = await sha256(JSON.stringify([policy.app, policy.feature, policy.revision, policy.logicalRole, policy.provider, policy.model,
    policy.reasoningEffort, policy.maxOutputTokens, policy.maxAttempts, policy.schema, policy.systemInstructions, req.input]));
  const identity: CallIdentity = Object.freeze({ key: callKey, tenantTag, fingerprint });
  const claimContext: ClaimContext = { app: req.app, feature: req.feature, storeFeature: policyKey(req.app, req.feature), subject: verdict.subject };
  let claim: CallClaim;
  try {
    claim = await deps.store.claim(identity, claimContext);
  } catch {
    return fail("STORE_UNAVAILABLE");
  }
  if (claim.kind === "conflict") return fail("OPERATION_REUSED");
  if (claim.kind === "busy") return fail("IN_PROGRESS");
  if (claim.kind === "complete") {
    const o: unknown = claim.outcome;
    if (claim.fingerprint !== fingerprint || !isRecord(o)) return fail("UNKNOWN");
    const audit = fromStoreAudit(o.audit, { callKey, tenantTag, app: req.app, feature: req.feature, policy });
    if (!audit) return fail("UNKNOWN");
    if (o.ok === true && Object.keys(o).sort().join(",") === "audit,data,ok") return { ok: true, data: o.data, audit };
    if (o.ok === false && Object.keys(o).sort().join(",") === "audit,code,ok" && STORED_CODES.includes(o.code as string)) {
      return fail(publicCode(o.code as StoredCode), audit);
    }
    return fail("UNKNOWN");
  }
  if (claim.kind !== "acquired") return fail("UNKNOWN");

  // 7. Before EACH attempt, the authority is asked again LAST before the send permit (G6-09 R2: no other await between
  //    the recheck and mark_sent); a changed answer stops the send (the reservation is released, nothing leaves). A
  //    change after the recheck is not seen, and after mark_sent a call in flight cannot be stopped.
  //    Owner-held ledger (G6-20, the default): reserve and mark_sent each check, in the SAME database transaction, that
  //    this claim (its original token, the full identity, still acquired) owns the call; a process that lost the row
  //    never reaches the ledger, never takes or releases another claim's attempt, and gets no send permit (C1 + C3).
  //    Legacy (UNSAFE, explicit flag only): after reserve, a second ai_calls_claim answering "busy" counts as held
  //    (G6-07); "busy" is not proof of ownership (G6-08 R1, G6-18 S2 / S3 / S5 / S8b).
  let revoked = false;
  let fenced = false;
  const recheck = async () => {
    let again: AuthVerdict;
    try {
      again = await deps.authority.recheck(verdict);
    } catch {
      revoked = true;
      throw new Error("RECHECK_UNAVAILABLE");
    }
    if (verdictProblem(again, req.app, now()) !== null || again.generation !== verdict.generation ||
      JSON.stringify(again.subject) !== JSON.stringify(verdict.subject)) {
      revoked = true;
      throw new Error("REVOKED");
    }
  };
  const fenceIfNotHeld = (e: unknown) => {
    if (e instanceof LedgerOwnerNotHeldError) fenced = true;
    throw e;
  };
  let budget: BudgetGuard;
  if (ownerHeld) {
    let bound: BudgetGuard;
    try {
      bound = deps.heldBudget!({ identity, context: claimContext, owner: claim.owner });
    } catch {
      return fail("UNKNOWN"); // nothing reserved; the row stays acquired for recovery
    }
    // Without its own mark_sent / release the owner check would be skipped: refuse such a ledger.
    if (typeof bound.markSent !== "function" || typeof bound.release !== "function") return fail("UNKNOWN");
    budget = {
      reserve: (c, cost) => bound.reserve(c, cost).catch(fenceIfNotHeld),
      markSent: async (r) => {
        await recheck();
        await bound.markSent!(r).catch(fenceIfNotHeld);
      },
      settle: (r, c, s) => bound.settle(r, c, s),
      release: (r) => bound.release!(r),
    };
  } else {
    const legacy = deps.budget!;
    budget = {
      reserve: (c, cost) => legacy.reserve(c, cost),
      markSent: async (r) => {
        // The row stays "acquired" (busy for a second claim) until this call completes it or recovery closes it.
        let held: CallClaim;
        try {
          held = await deps.store.claim(identity, claimContext);
        } catch {
          held = { kind: "conflict" };
        }
        if (held.kind !== "busy") {
          fenced = true;
          throw new Error("CLAIM_NOT_HELD");
        }
        await recheck();
        await legacy.markSent?.(r);
      },
      settle: (r, c, s) => legacy.settle(r, c, s),
      release: (r) => legacy.release?.(r) ?? Promise.resolve(),
    };
  }
  let result;
  try {
    result = await executeAiRequest(aiRequest, { ...deps.provider, budget, nowMs: now });
  } catch {
    return fail("UNKNOWN"); // whether anything was sent is unknown: the claim stays acquired for recovery; never resent
  }
  const audit: GatewayAudit = {
    callKey, tenantTag, app: req.app, feature: req.feature, model: policy.model,
    attempts: result.transportAttempts, estimatedCostUsd: result.estimatedCostUsd, costBasis: result.costBasis,
  };
  // The claim was no longer held: the row's own outcome (recovery's tombstone) is the answer; nothing is recorded over it.
  if (fenced) return fail("UNKNOWN", audit);
  // G6-09 / G6-10 (R1): the ledger refused, or could not answer, in a way that does not prove the operation unsent.
  //   ATTEMPT_FINALIZED: that attempt was already sent, settled or released (by another process, maybe).
  //   SEND_NOT_CONFIRMED: the shared guard folds ATTEMPT_IN_FLIGHT into it, with a mark_sent that failed or was
  //     refused (which may itself have committed "sent").
  //   GUARD_UNAVAILABLE (G6-10, H3 P2): the shared execute.ts folds EVERY reserve failure into it (network, HTTP 5xx,
  //     a timeout, an answer lost after the statement committed, which may have been ATTEMPT_FINALIZED) and the guard
  //     maps an unknown ledger reason to it. The ledger may know of another process's send under this key.
  // None of them proves "not sent": record nothing (no NOT_SENT, no no_request, no 0 USD) and answer UNKNOWN; the row
  // stays acquired and recovery closes it with an audit built from the ledger (the source of truth). The cost: a
  // ledger that was really unreachable also waits for recovery (IN_PROGRESS) instead of answering NOT_SENT at once.
  // Not here: a revocation found by this process's own recheck; a budget limit (the ledger answered after finding no
  // such attempt); INVALID_AMOUNT (decided locally, before any ledger call).
  const AMBIGUOUS_LEDGER: readonly string[] = ["ATTEMPT_FINALIZED", "SEND_NOT_CONFIRMED", "GUARD_UNAVAILABLE"];
  if (!result.ok && !revoked && result.errorCode === "BUDGET_DENIED" && AMBIGUOUS_LEDGER.includes(String(result.detail))) {
    return fail("UNKNOWN", null);
  }
  // Why the call stopped without (another) send, decided in this order: a possibly billed attempt is UNKNOWN whatever
  // else happened; then a revocation (GAP-1: also after an earlier refused attempt); then the ledger: a budget limit
  // is a quota, any other refusal before the send (an invalid amount) is LEDGER_UNAVAILABLE (GAP-2; every refusal that
  // does not prove "not sent", an unreachable ledger included, is answered above since G6-10). Both stop reasons are stored as
  // POLICY_DENIED (nothing more was sent; the store has no other code for it) and replay as NOT_SENT.
  let stop: "revoked" | "ledger" | null = null;
  let outcome: Readonly<{ ok: true; data: unknown } | { ok: false; code: StoredCode }>;
  if (result.ok) {
    let valid = false;
    try {
      valid = policy.validate(structuredClone(result.parsedPayload)) === true;
    } catch {
      valid = false;
    }
    outcome = valid ? { ok: true, data: result.parsedPayload } : { ok: false, code: "OUTPUT_REJECTED" };
  } else if (result.costBasis === "includes_upper_bound") outcome = { ok: false, code: "UNKNOWN" };
  else if (revoked) {
    stop = "revoked";
    outcome = { ok: false, code: "POLICY_DENIED" };
  } else if (result.errorCode === "BUDGET_DENIED" && QUOTA_REASONS.includes(String(result.detail))) outcome = { ok: false, code: "BUDGET_DENIED" };
  else if (result.errorCode === "BUDGET_DENIED") {
    stop = "ledger";
    outcome = { ok: false, code: "POLICY_DENIED" };
  } else if (result.errorCode === "INVALID_JSON" || result.errorCode === "SCHEMA_VIOLATION") outcome = { ok: false, code: "OUTPUT_REJECTED" };
  else if (result.costBasis === "no_request") outcome = { ok: false, code: "POLICY_DENIED" };
  else outcome = { ok: false, code: "PROVIDER_FAILED" };
  const stored: StoredOutcome = { ...outcome, audit: toStoreAudit(audit, policy) } as StoredOutcome;
  try {
    await deps.store.complete(identity, claim.owner, stored);
  } catch {
    return fail("UNKNOWN", audit); // not recorded: the operation stays IN_PROGRESS until recovery; never resent
  }
  if (outcome.ok) return { ok: true, data: outcome.data, audit };
  // The first answer says why nothing (more) was sent; a replay of the stored POLICY_DENIED only knows that.
  if (stop === "revoked") return fail("AUTH_REVOKED_BEFORE_SEND", audit);
  if (stop === "ledger") return fail("LEDGER_UNAVAILABLE", audit);
  return fail(publicCode(outcome.code), audit);
}

function publicCode(code: StoredCode): GatewayCode {
  switch (code) {
    case "BUDGET_DENIED":
      return "QUOTA_EXCEEDED";
    case "COST_DENIED":
      return "COST_DENIED";
    case "OUTPUT_REJECTED":
      return "OUTPUT_REJECTED";
    case "PROVIDER_FAILED":
      return "PROVIDER_FAILED";
    case "POLICY_DENIED":
      return "NOT_SENT";
    default:
      return "UNKNOWN";
  }
}
