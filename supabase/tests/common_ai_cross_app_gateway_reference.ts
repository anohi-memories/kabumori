// REFERENCE MODEL (F6, 2026-10-19) of the app-independent common AI gateway contract shared by Kabumori, POSTONA
// and (later) Miseiro. NOT deployed: nothing deployable imports this file, it is not wired into any app, and every
// side effect is injected (authority, policies, provider fetch, ledger guard, call store). It exists so the contract
// in docs/ai-provider/F6_CROSS_APP_GATEWAY_OFFLINE_CONTRACT.md can be tested offline against the REAL shared provider
// (executeAiRequest) without building a gateway.
//
// Order of one call (each step refuses before anything costs money or leaves the process):
//   request shape -> authority verdict (G5's, an INPUT here) -> app feature policy -> cost bound -> call key and
//   claim (idempotency) -> [per attempt] ledger reserve -> authority RECHECK -> ledger mark sent -> ONE provider
//   request -> ledger settle | unknown -> app output check -> record the outcome -> answer.
import { type AiRequest, type AiSubject, type BudgetGuard, executeAiRequest, type ExecuteDeps, findModelSpec, type JsonSchema, upperBoundAttemptCostUsd } from "../functions/_shared/ai_provider/mod.ts";

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

/** The stored outcome codes are the call store's (ai_calls accepts exactly these failure codes). */
type StoredCode = "POLICY_DENIED" | "COST_DENIED" | "BUDGET_DENIED" | "OUTPUT_REJECTED" | "PROVIDER_FAILED" | "UNKNOWN";
export type StoredOutcome =
  | Readonly<{ ok: true; data: unknown; audit: GatewayAudit }>
  | Readonly<{ ok: false; code: StoredCode; audit: GatewayAudit }>;
export type CallIdentity = Readonly<{ key: string; tenantTag: string; fingerprint: string }>;
export type CallClaim =
  | Readonly<{ kind: "acquired"; owner: string }>
  | Readonly<{ kind: "busy" | "conflict" }>
  | Readonly<{ kind: "complete"; fingerprint: string; outcome: StoredOutcome }>;
/** The durable call store (ai_calls in production design; unapplied). Bound to the verdict's subject per call. */
export interface CallStore {
  claim(identity: CallIdentity, context: Readonly<{ app: AppId; feature: string; subject: GatewaySubject }>): Promise<CallClaim>;
  complete(identity: CallIdentity, owner: string, outcome: StoredOutcome): Promise<void>;
}

export type GatewayDeps = Readonly<{
  authority: AuthorityPort;
  policies: PolicyRegistry;
  /** Shared provider: readEnv (provider keys), fetch, retry timing. */
  provider: Omit<ExecuteDeps, "budget">;
  /** The ledger: the source of truth for usage and cost (reserve -> mark sent -> settle | unknown). */
  budget: BudgetGuard;
  store: CallStore;
  nowMs?: () => number;
}>;

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const FEATURE = /^[a-z][a-z0-9_.]{1,63}$/;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z][a-z0-9_]{1,40}$/;
const REQUEST_KEYS = ["app", "brand", "feature", "input", "operationId"];

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
  if (!policy || policy.app !== req.app || policy.feature !== req.feature || typeof policy.validate !== "function") return fail("POLICY_MISSING");
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
  const fingerprint = await sha256(JSON.stringify([policy.app, policy.feature, policy.provider, policy.model, policy.reasoningEffort,
    policy.maxOutputTokens, policy.maxAttempts, policy.schema, policy.systemInstructions, req.input]));
  const identity: CallIdentity = Object.freeze({ key: callKey, tenantTag, fingerprint });
  let claim: CallClaim;
  try {
    claim = await deps.store.claim(identity, { app: req.app, feature: req.feature, subject: verdict.subject });
  } catch {
    return fail("STORE_UNAVAILABLE");
  }
  if (claim.kind === "conflict") return fail("OPERATION_REUSED");
  if (claim.kind === "busy") return fail("IN_PROGRESS");
  if (claim.kind === "complete") {
    const o = claim.outcome;
    if (claim.fingerprint !== fingerprint || !isRecord(o) || !isRecord(o.audit) || o.audit.callKey !== callKey || o.audit.tenantTag !== tenantTag ||
      o.audit.app !== req.app || o.audit.feature !== req.feature) return fail("UNKNOWN");
    return o.ok ? { ok: true, data: o.data, audit: o.audit } : fail(publicCode(o.code), o.audit);
  }
  if (claim.kind !== "acquired") return fail("UNKNOWN");

  // 7. Before EACH attempt: the ledger reserves, then the authority is asked again; a changed answer stops the send
  //    (the reservation is released, nothing leaves). After the last recheck a call in flight cannot be stopped.
  let revoked = false;
  const budget: BudgetGuard = {
    reserve: (c, cost) => deps.budget.reserve(c, cost),
    markSent: async (r) => {
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
      await deps.budget.markSent?.(r);
    },
    settle: (r, c, s) => deps.budget.settle(r, c, s),
    release: (r) => deps.budget.release?.(r) ?? Promise.resolve(),
  };
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
  let outcome: StoredOutcome;
  if (result.ok) {
    let valid = false;
    try {
      valid = policy.validate(structuredClone(result.parsedPayload)) === true;
    } catch {
      valid = false;
    }
    outcome = valid ? { ok: true, data: result.parsedPayload, audit } : { ok: false, code: "OUTPUT_REJECTED", audit };
  } else if (result.costBasis === "includes_upper_bound") outcome = { ok: false, code: "UNKNOWN", audit };
  else if (revoked && result.costBasis === "no_request") outcome = { ok: false, code: "POLICY_DENIED", audit };
  else if (result.errorCode === "BUDGET_DENIED") outcome = { ok: false, code: "BUDGET_DENIED", audit };
  else if (result.errorCode === "INVALID_JSON" || result.errorCode === "SCHEMA_VIOLATION") outcome = { ok: false, code: "OUTPUT_REJECTED", audit };
  else if (result.costBasis === "no_request") outcome = { ok: false, code: "POLICY_DENIED", audit };
  else outcome = { ok: false, code: "PROVIDER_FAILED", audit };
  try {
    await deps.store.complete(identity, claim.owner, outcome);
  } catch {
    return fail("UNKNOWN", audit); // not recorded: the operation stays IN_PROGRESS until recovery; never resent
  }
  if (outcome.ok) return outcome;
  // The first answer says why nothing was sent; a replay of the stored POLICY_DENIED only knows that nothing was sent.
  return fail(revoked && outcome.code === "POLICY_DENIED" ? "AUTH_REVOKED_BEFORE_SEND" : publicCode(outcome.code), audit);
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
