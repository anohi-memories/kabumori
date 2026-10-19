// G6 runtime candidate (2026-10-19, G6-03): POSTONA consult -> common AI gateway, WITHOUT changing the consult
// handler. The handler (supabase/functions/social-mobile-consult/logic.ts, owner not confirmed) already takes its AI
// call as a dependency (ConsultDependencies.callModel); this module builds that dependency on the G6 gateway:
//   - the caller's JWT goes to the G5 authority port (G6 never reads it), the client's Idempotency-Key becomes the
//     gateway operationId, the request's brand_id (parsed by the handler's own parser) becomes the brand selector;
//   - the handler-built OpenAI body is checked against the handler's own prompt and schema (drift -> refused) and
//     turned into one gateway input; the gateway sends it (provider, ledger, call store, recheck, no resend);
//   - every gateway answer becomes a ConsultError the handler already knows how to return; the handler then runs
//     its per-request sanitizeConsultModelOutput on the answer, as today.
// The direct OpenAI path is never used (no fallback): without a gateway, or with G5 not connected, nothing is sent.
// NOT deployed (outside supabase/functions), not wired into index.ts. See docs/ai-provider/G6_POSTONA_CONSULT_GATEWAY_ADAPTER.md.
import {
  CONSULT_LIMITS,
  CONSULT_OUTPUT_SCHEMA,
  CONSULT_SYSTEM_PROMPT,
  type ConsultDependencies,
  ConsultError,
  type ConsultModelCall,
  handleSocialMobileConsult,
  parseConsultRequest,
  sanitizeConsultModelOutput,
} from "../functions/social-mobile-consult/logic.ts";
import { SOCIAL_MOBILE_USER_DEFAULTS } from "../functions/_shared/brand/social_mobile_content_settings.ts";
import type { FeatureContent } from "./app_policies.ts";
import type { G5Transport } from "./authority_port.ts";
import type { GatewayCode, GatewayResult } from "./gateway.ts";
import type { AiGateway } from "./runtime.ts";

export const CONSULT_SCHEMA_NAME = "social_mobile_consult";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u;
const BRAND_SLUG = /^[a-z][a-z0-9_]{1,40}$/u;
const SAVED_PREFIX = "現在保存されている内容（データ）:\n";

/**
 * The consult feature's app content for buildAppPolicySet, taken from the handler itself (no copy of the prompt or
 * schema). validate is the shape check at the gateway (the handler's sanitizer against neutral saved state); the
 * per-request sanitize with the real saved state and message stays in the handler, after the gateway answers.
 */
export const POSTONA_CONSULT_CONTENT: FeatureContent = Object.freeze({
  systemInstructions: CONSULT_SYSTEM_PROMPT,
  schema: Object.freeze({ name: CONSULT_SCHEMA_NAME, schema: CONSULT_OUTPUT_SCHEMA }),
  validate: (payload: unknown) => sanitizeConsultModelOutput(JSON.stringify(payload), { settings: SOCIAL_MOBILE_USER_DEFAULTS, persona: null }, "") !== null,
});

/** G5's real verdict does not exist yet: this transport refuses every question, so every consult sends nothing. */
export const G5_NOT_CONNECTED: G5Transport = Object.freeze({
  fetchVerdict: () => Promise.reject(new Error("G5_VERDICT_NOT_CONNECTED")),
  fetchRecheck: () => Promise.reject(new Error("G5_VERDICT_NOT_CONNECTED")),
});

/** Every gateway code -> the consult error the handler returns. A stored failure is never retryable with that key. */
export function consultErrorFor(code: GatewayCode): ConsultError {
  switch (code) {
    case "QUOTA_EXCEEDED":
      return new ConsultError("CONSULT_QUOTA_EXCEEDED", 429, false);
    case "IN_PROGRESS":
      return new ConsultError("CONSULT_IN_PROGRESS", 409, true);
    case "OPERATION_REUSED":
      return new ConsultError("CONSULT_OPERATION_REUSED", 409, false);
    case "UNKNOWN":
      return new ConsultError("CONSULT_AI_UNKNOWN", 502, false);
    case "PROVIDER_FAILED":
      return new ConsultError("CONSULT_AI_FAILED", 502, false);
    case "OUTPUT_REJECTED":
      return new ConsultError("CONSULT_AI_MALFORMED", 502, false);
    case "AUTH_UNAVAILABLE":
      return new ConsultError("CONSULT_AUTH_UNAVAILABLE", 503, true); // G5 unreachable; nothing was claimed or sent
    case "AUTH_DENIED":
    case "AUTH_UNKNOWN":
    case "AUTH_PENDING":
    case "AUTH_EXPIRED":
    case "AUTH_SCOPE_MISMATCH":
    case "AUTH_REVOKED_BEFORE_SEND":
    case "POLICY_MISSING":
    case "POLICY_SUBJECT_DENIED":
      return new ConsultError("CONSULT_NOT_ENTITLED", 403, false);
    case "STORE_UNAVAILABLE":
      return new ConsultError("CONSULT_AI_UNAVAILABLE", 503, true); // nothing claimed: the same key may be retried
    case "LEDGER_UNAVAILABLE":
    case "NOT_SENT":
      return new ConsultError("CONSULT_NOT_SENT", 503, false); // nothing sent; this key is final, use a new one
    case "COST_DENIED":
    case "REQUEST_INVALID":
      return new ConsultError("CONSULT_AI_UNAVAILABLE", 503, false); // configuration
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The handler-built OpenAI body -> the gateway input (one string). The body must be exactly what the handler builds
 * today: the handler's prompt first, the saved state second, then the turns and the message; the handler's schema.
 * Anything else (a changed prompt, schema or shape) is refused: the gateway sends its own policy's prompt and schema,
 * so a drift would otherwise go unnoticed.
 */
export function consultGatewayInput(body: Record<string, unknown>): string | null {
  const format = isRecord(body.text) && isRecord(body.text.format) ? body.text.format : null;
  if (!format || format.type !== "json_schema" || format.name !== CONSULT_SCHEMA_NAME || JSON.stringify(format.schema) !== JSON.stringify(CONSULT_OUTPUT_SCHEMA)) return null;
  const input = Array.isArray(body.input) ? body.input : null;
  if (!input || input.length < 3) return null;
  const [prompt, saved, ...turns] = input;
  if (!isRecord(prompt) || prompt.role !== "system" || prompt.content !== CONSULT_SYSTEM_PROMPT) return null;
  if (!isRecord(saved) || saved.role !== "system" || typeof saved.content !== "string" || !saved.content.startsWith(SAVED_PREFIX)) return null;
  let savedState: unknown;
  try {
    savedState = JSON.parse(saved.content.slice(SAVED_PREFIX.length));
  } catch {
    return null;
  }
  const last = turns.at(-1);
  if (!isRecord(last) || last.role !== "user" || typeof last.content !== "string") return null;
  const history = turns.slice(0, -1);
  if (!history.every((t) => isRecord(t) && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && Object.keys(t).length === 2)) return null;
  // Same data the handler sends today, as one JSON document of data (the prompt already says it is data).
  return JSON.stringify({ saved: savedState, history: history.map((t) => ({ role: t.role, text: t.content })), message: last.content });
}

export type ConsultGatewayBinding = Readonly<{
  gateway: AiGateway | null;
  credential: string | null;
  operationId: string | null;
  brandSlug: string | null;
}>;

/** A ConsultModelCall that goes through the gateway only. It never calls OpenAI itself and ignores the OpenAI key. */
export function consultModelCallViaGateway(binding: ConsultGatewayBinding): ConsultModelCall {
  return async ({ body }) => {
    if (!binding.gateway) throw new ConsultError("CONSULT_AI_UNAVAILABLE", 503, false);
    if (!binding.operationId) throw new ConsultError("CONSULT_IDEMPOTENCY_KEY_REQUIRED", 400, false);
    if (!binding.brandSlug) throw new ConsultError("CONSULT_AI_UNAVAILABLE", 503, false); // a brand id the gateway cannot carry
    const input = consultGatewayInput(body);
    if (input === null) throw new ConsultError("CONSULT_AI_UNAVAILABLE", 503, false);
    let result: GatewayResult;
    try {
      result = await binding.gateway.execute(binding.credential, {
        app: "postona",
        feature: "consult",
        operationId: binding.operationId,
        input,
        brand: { app: "postona", slug: binding.brandSlug },
      });
    } catch {
      throw new ConsultError("CONSULT_AI_UNKNOWN", 502, false); // the gateway never throws; if it did, never resend
    }
    if (!result.ok) throw consultErrorFor(result.code);
    // Token counts are not part of the gateway answer: the ledger holds usage and cost (call key in the audit).
    return { outputText: JSON.stringify(result.data), usage: { model: result.audit.model, inputTokens: 0, outputTokens: 0 } };
  };
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/u.exec(request.headers.get("Authorization")?.trim() ?? "");
  return match ? match[1] : null;
}

/**
 * Serve one consult request through the gateway with the UNCHANGED handler. The handler still verifies the caller,
 * parses the body, proves workspace ownership with the caller's JWT (RLS) and sanitizes the answer; only its AI call
 * is replaced. `gateway: null` (the default until G5, the plan and the owner agree) answers CONSULT_AI_UNAVAILABLE
 * with nothing sent, even when an OpenAI key is configured.
 */
export async function handleConsultViaGateway(request: Request, deps: ConsultDependencies, gateway: AiGateway | null): Promise<Response> {
  let brandSlug: string | null = null;
  // Read the copy only when its declared size is within the handler's own limit (no unbounded read before the
  // handler's checks); without a usable Content-Length the gateway path sends nothing.
  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (request.method === "POST" && Number.isInteger(declared) && declared > 0 && declared <= CONSULT_LIMITS.requestBytes) {
    try {
      // The handler's own parser on a copy; the handler reads and validates the original again.
      const brandId = parseConsultRequest(await request.clone().json()).brandId;
      brandSlug = BRAND_SLUG.test(brandId) ? brandId : null;
    } catch {
      brandSlug = null; // the handler rejects the body itself
    }
  }
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  const binding: ConsultGatewayBinding = {
    gateway,
    credential: bearer(request),
    operationId: IDEMPOTENCY_KEY.test(key) ? key : null,
    brandSlug,
  };
  return await handleSocialMobileConsult(request, { ...deps, openAiApiKey: "", callModel: consultModelCallViaGateway(binding) });
}
