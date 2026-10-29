// G6-23 (2026-10-29): the HTTP entry of POSTONA's AI post assist, served by supabase/functions/postona-post-assist (G6-24;
// NOT deployed). One request: the browser-origin rule (CORS), POST + JSON + the
// person's Bearer token checked before anything is asked, the configuration read from the Edge environment once, then
// the G6-21 personal-MVP adapter (G5 R1 verdict -> owner-held gateway -> editable candidates). It never posts to a
// social network and never calls a provider itself. The Edge Function file only serves this handler with readEnv set
// to the Edge environment's getter (docs/ai-provider/G6_23_POST_ASSIST_EDGE_ENTRY.md).
import { SecretValue } from "../ai_provider/secrets.ts";
import type { FeatureConfig } from "./app_policies.ts";
import { createPostonaPostAssistMvp, G5_R1_PERSONAL_MVP_PROFILE, type PostonaPostAssistMvp, type PostonaPostAssistMvpConfig } from "./postona_post_assist_mvp.ts";

/** The Edge environment names this entry reads (secrets are set by the deployment owner; nothing has a default). */
export const POST_ASSIST_EDGE_ENV = Object.freeze({
  supabaseUrl: "SUPABASE_URL",
  /** The project's publishable (anon) key: the G5 RPC runs with the person's own token; this key grants nothing. */
  publishableKey: "SUPABASE_ANON_KEY",
  /** The server-side secret key for the ledger and ai_calls RPCs (sb_secret_...; a legacy JWT key is refused). */
  serviceKey: "AI_GATEWAY_SERVICE_KEY",
  /** JSON of postona:post_generation's FeatureConfig (model, limits, revision): the operator's decision, no default. */
  feature: "POSTONA_POST_ASSIST_FEATURE",
  /** Comma-separated exact browser origins allowed to call (empty or unset: none; the native app sends no Origin). */
  allowedOrigins: "POSTONA_POST_ASSIST_ALLOWED_ORIGINS",
});

export type PostAssistEdgeOptions = Readonly<{
  readEnv: (name: string) => string | undefined;
  fetch?: PostonaPostAssistMvpConfig["fetch"];
  g5TimeoutMs?: number;
  nowMs?: () => number;
  retryTiming?: PostonaPostAssistMvpConfig["retryTiming"];
  sleep?: PostonaPostAssistMvpConfig["sleep"];
  random?: PostonaPostAssistMvpConfig["random"];
}>;

const FEATURE_KEYS = "enabled,entitlements,maxAttempts,maxCostUsdPerOperation,maxInputBytes,maxOutputTokens,model,provider,reasoningEffort,revision,timeoutMs";
const ORIGIN = /^(?:https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?)$/u;
const BEARER = /^Bearer\s+(\S+)$/u;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The operator's feature JSON with exactly FeatureConfig's keys and types (the policy catalog checks the values). */
export function parseFeatureConfig(text: string | undefined): FeatureConfig | null {
  if (!text) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(v) || Object.keys(v).sort().join(",") !== FEATURE_KEYS) return null;
  const strings = ["model", "provider", "reasoningEffort", "revision"].every((k) => typeof v[k] === "string");
  const numbers = ["maxAttempts", "maxCostUsdPerOperation", "maxInputBytes", "maxOutputTokens", "timeoutMs"].every((k) => typeof v[k] === "number");
  const entitlements = Array.isArray(v.entitlements) && v.entitlements.every((e) => typeof e === "string");
  if (!strings || !numbers || !entitlements || typeof v.enabled !== "boolean") return null;
  return Object.freeze({ ...v, entitlements: Object.freeze([...(v.entitlements as string[])]) }) as unknown as FeatureConfig;
}

/** Exact origins only; "*", paths, credentials or a plain-http non-local origin make the whole setting invalid. */
export function parseAllowedOrigins(text: string | undefined): readonly string[] | null {
  const list = (text ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  return list.every((o) => ORIGIN.test(o)) ? Object.freeze(list) : null;
}

const SECURITY_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Vary": "Origin" };

function reply(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { "Content-Type": "application/json" }), ...SECURITY_HEADERS, ...extra },
  });
}
const refuse = (error: string, status: number, extra: Record<string, string> = {}) => reply({ error, retry_same_key: false }, status, extra);

function cors(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, apikey, x-client-info",
    "Access-Control-Max-Age": "600",
  };
}

/**
 * The Edge request handler. Every refusal before the adapter (origin, method, content type, missing token, missing or
 * invalid configuration) asks nobody and sends nothing. The configuration is read on the first request that needs it and
 * kept once valid; an invalid one answers 503 (no detail) until it is fixed.
 */
export function createPostonaPostAssistEdgeHandler(options: PostAssistEdgeOptions): (request: Request) => Promise<Response> {
  if (typeof options?.readEnv !== "function") throw new Error("POST_ASSIST_EDGE_CONFIG_INVALID:read_env");
  let app: PostonaPostAssistMvp | null = null;
  const build = (): PostonaPostAssistMvp | null => {
    if (app) return app;
    const env = options.readEnv;
    const feature = parseFeatureConfig(env(POST_ASSIST_EDGE_ENV.feature));
    const supabaseUrl = env(POST_ASSIST_EDGE_ENV.supabaseUrl);
    const publishableKey = env(POST_ASSIST_EDGE_ENV.publishableKey);
    const serviceKey = env(POST_ASSIST_EDGE_ENV.serviceKey);
    if (!feature || !supabaseUrl || !publishableKey || !serviceKey) return null;
    try {
      app = createPostonaPostAssistMvp({
        profile: G5_R1_PERSONAL_MVP_PROFILE,
        supabaseUrl,
        publishableKey,
        serviceKey: new SecretValue(POST_ASSIST_EDGE_ENV.serviceKey, serviceKey),
        readEnv: env, // the runtime hands the provider layer its provider keys only
        feature,
        fetch: options.fetch,
        g5TimeoutMs: options.g5TimeoutMs,
        nowMs: options.nowMs,
        retryTiming: options.retryTiming,
        sleep: options.sleep,
        random: options.random,
      });
    } catch {
      app = null; // never echo which setting failed
    }
    return app;
  };

  return async (request: Request): Promise<Response> => {
    const origins = parseAllowedOrigins(options.readEnv(POST_ASSIST_EDGE_ENV.allowedOrigins));
    if (!origins) return refuse("POST_ASSIST_UNAVAILABLE", 503);
    const origin = request.headers.get("Origin");
    if (origin !== null && !origins.includes(origin)) return refuse("POST_ASSIST_ORIGIN_REFUSED", 403);
    const allow = origin === null ? {} : cors(origin);
    if (request.method === "OPTIONS") return reply(null, 204, allow);
    if (request.method !== "POST") return refuse("POST_ASSIST_REQUEST_INVALID", 405, { ...allow, "Allow": "POST, OPTIONS" });
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("Content-Type")?.trim() ?? "")) {
      return refuse("POST_ASSIST_REQUEST_INVALID", 415, allow);
    }
    if (!BEARER.test(request.headers.get("Authorization")?.trim() ?? "")) {
      return refuse("POST_ASSIST_AUTH_REQUIRED", 401, { ...allow, "WWW-Authenticate": "Bearer" });
    }
    const built = build();
    if (!built) return refuse("POST_ASSIST_UNAVAILABLE", 503, allow);
    try {
      const inner = await built.handle(request);
      return reply(await inner.json(), inner.status, allow);
    } catch {
      return refuse("POST_ASSIST_AI_UNKNOWN", 502, allow); // the adapter never throws; if it did, never resend
    }
  };
}
