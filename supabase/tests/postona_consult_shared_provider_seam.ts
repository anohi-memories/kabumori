// OFFLINE SEAM (F6, 2026-10-18): one POSTONA consultation through the shared AI foundation, keeping the existing
// OpenAI consult behaviour. NOT deployed: nothing deployable imports this file, the live social-mobile-consult
// handler is unchanged, and no request leaves the process in the tests (every network hop is injected).
//
// It wraps the existing handler (social-mobile-consult/logic.ts handleSocialMobileConsult) through its own
// `callModel` seam, adding what the live endpoint does not have yet:
//   1. before the handler: a verified user (Auth) and an ACTIVE POSTONA service (common_accounts.status = 'active'
//      and service_entitlements(x_autopost).status = 'active', read with the user's own JWT), and an
//      Idempotency-Key (the client's operation id for this message);
//   2. the handler then proves workspace ownership and reads the saved state, as today, and builds the request;
//   3. the model call goes through the shared provider (executeAiRequest, OpenAI, the same model / schema / output
//      cap / single attempt as today) with a budget guard (ledger: reserve -> mark sent -> settle | unknown), behind
//      a durable call store (claim once per operation; replay, IN_PROGRESS, drift; never resent);
//   4. the handler's own allowlist (sanitizeConsultModelOutput) and response shape stay as they are.
// Nothing reaches the provider before 1 and 2 pass. Contract: docs/ai-provider/F6_POSTONA_OPENAI_CONSULT_OFFLINE_SEAM.md.
import {
  CONSULT_LIMITS,
  CONSULT_MODEL,
  CONSULT_OUTPUT_SCHEMA,
  CONSULT_SYSTEM_PROMPT,
  ConsultError,
  type ConsultModelCall,
  handleSocialMobileConsult,
} from "../functions/social-mobile-consult/logic.ts";
import { type AiRequest, type AiSubject, type BudgetGuard, executeAiRequest, type ExecuteDeps } from "../functions/_shared/ai_provider/mod.ts";
import type { Audit, BridgeResult, CallIdentity, ConsumerCallStore } from "../functions/_shared/ai_consumer_bridge/types.ts";

export const SEAM_VERSION = "postona-consult-openai-seam-1";
export const CONSULT_FEATURE_ID = "postona.consult";
export const CONSULT_ROLE = "postona.consult.reply";
export const CONSULT_APPLICATION = "postona";
export const CONSULT_LEDGER_FEATURE = "consult";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SeamDeps = Readonly<{
  supabaseUrl: string;
  publishableKey: string;
  /** Supabase Auth / REST with the caller's JWT (the same reads the handler makes). */
  fetchImpl: typeof fetch;
  /** Shared provider: readEnv (OPENAI_API_KEY), fetch (the provider), retry timing. The budget is passed apart. */
  provider: Omit<ExecuteDeps, "budget">;
  /** Ledger guard (SupabaseLedgerBudgetGuard live; InMemoryBudgetGuard in pure tests). */
  budget: BudgetGuard;
  /**
   * Durable call store for ONE request, bound to the verified subject (the ai_calls RPCs record application,
   * feature, subject kind and user id with each claim; a reference store in pure tests).
   */
  storeFor: (context: Readonly<{ application: string; feature: string; subject: AiSubject }>) => ConsumerCallStore;
  /** Metadata-only log (never message text, tokens, ids or keys). */
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
}>;

type JsonRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonRecord => typeof v === "object" && v !== null && !Array.isArray(v);
const respond = (body: JsonRecord, status: number) => Response.json(body, { status, headers: CORS_HEADERS });
const refuse = (error: string, status: number, retryable: boolean) => respond({ success: false, error, retryable }, status);

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/u.exec(header);
  return match ? match[1] : null;
}

/** A stored failure means the same answer for the same operation id: never retryable with that key. */
function errorFor(code: string): ConsultError {
  switch (code) {
    case "BUDGET_DENIED":
      return new ConsultError("CONSULT_QUOTA_EXCEEDED", 429, false);
    case "UNKNOWN":
      return new ConsultError("CONSULT_AI_UNKNOWN", 502, false);
    case "OUTPUT_REJECTED":
      return new ConsultError("CONSULT_AI_MALFORMED", 502, false);
    case "PROVIDER_FAILED":
      return new ConsultError("CONSULT_AI_FAILED", 502, false);
    default:
      // POLICY_DENIED / COST_DENIED / MODEL_UNAVAILABLE: nothing sent (configuration).
      return new ConsultError("CONSULT_AI_UNAVAILABLE", 503, false);
  }
}

/** The handler-built OpenAI body -> one shared-provider request. A body that drifted from the contract is refused. */
function toAiRequest(body: JsonRecord, subject: AiSubject, callId: string, timeoutMs: number): AiRequest {
  const input = body.input;
  const format = isRecord(body.text) && isRecord(body.text.format) ? body.text.format : null;
  if (
    body.model !== CONSULT_MODEL || body.store !== false || body.max_output_tokens !== CONSULT_LIMITS.maxOutputTokens ||
    !isRecord(body.reasoning) || body.reasoning.effort !== "low" || !format || format.schema !== CONSULT_OUTPUT_SCHEMA ||
    !Array.isArray(input) || input.length < 3 ||
    !isRecord(input[0]) || input[0].role !== "system" || input[0].content !== CONSULT_SYSTEM_PROMPT ||
    !isRecord(input[1]) || input[1].role !== "system" || typeof input[1].content !== "string" ||
    !input.slice(2).every((t) => isRecord(t) && (t.role === "user" || t.role === "assistant") && typeof t.content === "string") ||
    (input[input.length - 1] as JsonRecord).role !== "user"
  ) {
    throw new ConsultError("CONSULT_AI_UNAVAILABLE", 503, false);
  }
  return {
    logicalRole: CONSULT_ROLE,
    provider: "openai",
    model: CONSULT_MODEL,
    systemInstructions: CONSULT_SYSTEM_PROMPT,
    // The saved state and the bounded conversation, as data (the same content the live body carries as roles).
    userContent: JSON.stringify({
      saved_state: input[1].content,
      conversation: input.slice(2).map((t) => ({ role: (t as JsonRecord).role, text: (t as JsonRecord).content })),
    }),
    jsonSchema: { name: "social_mobile_consult", schema: CONSULT_OUTPUT_SCHEMA },
    reasoningEffort: "low",
    maxOutputTokens: CONSULT_LIMITS.maxOutputTokens,
    timeoutMs,
    transport: { maxAttempts: 1 },
    usageContext: { application: CONSULT_APPLICATION, feature: CONSULT_LEDGER_FEATURE, subject },
    callId,
  };
}

/** A stored result the store returns for replay: exactly the shape this seam writes, for this call. */
function storedResultOk(r: unknown, identity: CallIdentity): r is BridgeResult {
  if (!isRecord(r) || !isRecord(r.audit)) return false;
  const a = r.audit;
  const keys = Object.keys(r).sort().join(",");
  if (r.ok === true ? keys !== "audit,data,ok" : r.ok === false ? keys !== "audit,code,ok" || typeof r.code !== "string" : true) return false;
  return a.callId === identity.key && a.tenantTag === identity.tenantTag && a.feature === CONSULT_FEATURE_ID &&
    a.role === CONSULT_ROLE && a.model === CONSULT_MODEL && a.policyVersion === SEAM_VERSION;
}

function modelCall(deps: SeamDeps, userId: string, operationId: string): ConsultModelCall {
  return async ({ body, timeoutMs }) => {
    const subject: AiSubject = { kind: "user", userId, brandId: null };
    const tenantTag = await sha256(JSON.stringify([CONSULT_APPLICATION, subject]));
    const callId = "h5m2_" + await sha256(JSON.stringify([tenantTag, CONSULT_FEATURE_ID, operationId]));
    const request = toAiRequest(body, subject, callId, timeoutMs);
    const fingerprint = await sha256(JSON.stringify([
      SEAM_VERSION, request.model, request.reasoningEffort, request.maxOutputTokens, request.jsonSchema,
      request.systemInstructions, request.userContent,
    ]));
    const identity: CallIdentity = Object.freeze({ key: callId, tenantTag, fingerprint });
    const store = deps.storeFor({ application: CONSULT_APPLICATION, feature: CONSULT_FEATURE_ID, subject });

    let claim;
    try {
      claim = await store.claim(identity);
    } catch {
      throw new ConsultError("CONSULT_AI_UNAVAILABLE", 503, true); // nothing was sent
    }
    if (claim.kind === "conflict") throw new ConsultError("CONSULT_OPERATION_REUSED", 409, false);
    if (claim.kind === "busy") throw new ConsultError("CONSULT_IN_PROGRESS", 409, true);
    if (claim.kind === "complete") {
      if (claim.fingerprint !== fingerprint || !storedResultOk(claim.result, identity)) throw new ConsultError("CONSULT_AI_UNKNOWN", 502, false);
      if (!claim.result.ok) throw errorFor(claim.result.code);
      // Replay: the stored answer, no provider request, no new usage.
      return { outputText: JSON.stringify(claim.result.data), usage: { model: CONSULT_MODEL, inputTokens: 0, outputTokens: 0 } };
    }
    if (claim.kind !== "acquired" || typeof claim.owner !== "string") throw new ConsultError("CONSULT_AI_UNKNOWN", 502, false);

    let result;
    try {
      result = await executeAiRequest(request, { ...deps.provider, budget: deps.budget });
    } catch {
      // Whether anything was sent is unknown: the claim stays acquired (IN_PROGRESS) until recovery closes it from
      // the ledger (ai_ledger_recover_stale -> ai_calls_abandon). Never resent.
      throw new ConsultError("CONSULT_AI_UNKNOWN", 502, false);
    }
    const audit: Audit = {
      callId,
      tenantTag,
      feature: CONSULT_FEATURE_ID,
      role: CONSULT_ROLE,
      model: CONSULT_MODEL,
      policyVersion: SEAM_VERSION,
      attempts: result.transportAttempts,
      estimatedCostUsd: result.estimatedCostUsd,
      costBasis: result.costBasis,
    };
    const stored: BridgeResult = result.ok
      ? { ok: true, data: result.parsedPayload, audit }
      : result.errorCode === "BUDGET_DENIED"
      ? { ok: false, code: "BUDGET_DENIED", audit }
      : result.costBasis === "includes_upper_bound"
      ? { ok: false, code: "UNKNOWN", audit }
      : result.errorCode === "INVALID_JSON" || result.errorCode === "SCHEMA_VIOLATION"
      ? { ok: false, code: "OUTPUT_REJECTED", audit }
      : result.costBasis === "no_request"
      ? { ok: false, code: "POLICY_DENIED", audit }
      : { ok: false, code: "PROVIDER_FAILED", audit };
    try {
      await store.complete(identity, claim.owner, stored);
    } catch {
      // The outcome may not be recorded: the same operation id stays IN_PROGRESS until recovery; never resent.
      throw new ConsultError("CONSULT_AI_UNKNOWN", 502, false);
    }
    if (!stored.ok) throw errorFor(stored.code);
    return {
      outputText: JSON.stringify(stored.data),
      usage: { model: CONSULT_MODEL, inputTokens: result.ok ? result.inputTokens : 0, outputTokens: result.ok ? result.outputTokens : 0 },
    };
  };
}

async function readOwnRows(deps: SeamDeps, token: string, table: string, filters: Record<string, string>): Promise<unknown[] | null> {
  const url = new URL(`/rest/v1/${table}`, deps.supabaseUrl);
  for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);
  let response: Response;
  try {
    response = await deps.fetchImpl(url.toString(), {
      method: "GET",
      headers: { apikey: deps.publishableKey, Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch {
    return null;
  }
  const body = await response.json().catch(() => null);
  return response.ok && Array.isArray(body) ? body : null;
}

export function createConsultSeam(deps: SeamDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});
  return async (request: Request) => {
    if (request.method !== "POST") {
      return await handleSocialMobileConsult(request, {
        supabaseUrl: deps.supabaseUrl,
        publishableKey: deps.publishableKey,
        openAiApiKey: "",
        log,
      });
    }
    if (!deps.supabaseUrl || !deps.publishableKey) return refuse("CONSULT_CONFIGURATION_UNAVAILABLE", 503, false);
    const token = bearer(request);
    if (!token) return refuse("AUTH_REQUIRED", 401, false);

    // 1a. Identity (the handler verifies it again; this copy decides the subject before any model work).
    let userId: string;
    try {
      const response = await deps.fetchImpl(`${deps.supabaseUrl.replace(/\/$/u, "")}/auth/v1/user`, {
        method: "GET",
        headers: { apikey: deps.publishableKey, Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !isRecord(body) || typeof body.id !== "string" || !USER_ID.test(body.id)) {
        log({ event: "postona_consult_seam", result: "auth_required" });
        return refuse("AUTH_REQUIRED", 401, false);
      }
      userId = body.id;
    } catch {
      return refuse("AUTH_VERIFICATION_UNAVAILABLE", 503, true);
    }

    // 1b. The operation id of this message (one per user message; a retry of the same message reuses it).
    const operationId = request.headers.get("Idempotency-Key") ?? "";
    if (!OPERATION_ID.test(operationId)) return refuse("CONSULT_OPERATION_ID_REQUIRED", 400, false);

    // 1c. The POSTONA service must be active for this person, and the common account not being deleted.
    const accounts = await readOwnRows(deps, token, "common_accounts", { select: "status", user_id: `eq.${userId}` });
    const services = await readOwnRows(deps, token, "service_entitlements", {
      select: "status",
      user_id: `eq.${userId}`,
      service_key: "eq.x_autopost",
    });
    if (accounts === null || services === null) return refuse("ENTITLEMENT_READ_UNAVAILABLE", 503, true);
    const active = accounts.length === 1 && isRecord(accounts[0]) && accounts[0].status === "active" &&
      services.length === 1 && isRecord(services[0]) && services[0].status === "active";
    if (!active) {
      log({ event: "postona_consult_seam", result: "not_entitled" });
      return refuse("CONSULT_NOT_ENTITLED", 403, false);
    }

    // 2-4. The existing handler, with the shared-provider model call bound to this user and operation.
    return await handleSocialMobileConsult(request, {
      supabaseUrl: deps.supabaseUrl,
      publishableKey: deps.publishableKey,
      openAiApiKey: "",
      fetchImpl: deps.fetchImpl,
      callModel: modelCall(deps, userId, operationId),
      log,
      now: deps.now,
    });
  };
}
