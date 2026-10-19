// G6-04 (2026-10-19): the G5Transport for G5's PROPOSED verdict RPC. NOT CONNECTED anywhere; the RPC itself does NOT
// exist yet (G5 PR #340 docs/common-account/g5-01-postona-entitlement-auth-boundary.md section 6: design only, a separate
// G5 TASK behind a Codex Sol (high) gate). This file only fixes, on the G6 side, how that RPC would be called and read:
//   POST <supabaseUrl>/rest/v1/rpc/common_account_authorization_verdict
//     headers: apikey = the publishable key, Authorization = Bearer <the caller's own JWT>   (G5 takes the subject from it)
//     body:    { p_app, p_feature, p_brand_id }                                            (no user id, no session id)
//   200 -> the section-4 wire WITHOUT times (exactly 8 keys); the Edge (this transport) adds issued_at_ms / expires_at_ms:
//          an allow lives G5's 60 s, a refusal expires at once.
//   401 / 403 (PostgREST: the JWT is not accepted) -> a deny wire (AUTH_REQUIRED), built here; it can only refuse.
//   anything else (404 = RPC not deployed, 5xx, network, a body that is not the expected shape) -> throws, which the port
//   turns into AUTH_UNAVAILABLE (nothing claimed, nothing sent).
// The JWT goes into the Authorization header only: never into the body, a log, an error or the generation.
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { safeToken } from "../functions/_shared/ai_provider/redact.ts";
import { G5_ALLOW_TTL_MS, type G5Transport, type VerdictScope } from "./authority_port.ts";
import { supabaseUrlAllowed } from "./ai_calls_store.ts";

export const G5_VERDICT_RPC = "common_account_authorization_verdict";
const RPC_WIRE_KEYS = "decision,entitlements,owner_epoch,reason,scope,session,subject,v";
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class G5RpcError extends Error {
  constructor(status: number | null, code: string | null) {
    super(`G5_VERDICT_RPC_FAILED:${status ?? "network"}${code ? `:${code}` : ""}`);
  }
}

export type G5RpcTransportOptions = Readonly<{
  supabaseUrl: string;
  /** The project's publishable (anon) key: identifies the project, grants nothing by itself. */
  publishableKey: string;
  fetch?: FetchLike;
  nowMs?: () => number;
}>;

/** The transport for G5's proposed RPC (see the header). Throws at construction on a bad URL or key. */
export function createG5RpcTransport(options: G5RpcTransportOptions): G5Transport {
  if (!supabaseUrlAllowed(options.supabaseUrl)) throw new Error("G5_RPC_URL_NOT_HTTPS");
  if (typeof options.publishableKey !== "string" || options.publishableKey.length < 16 || /\s/u.test(options.publishableKey)) {
    throw new Error("G5_RPC_PUBLISHABLE_KEY_INVALID");
  }
  const url = new URL(options.supabaseUrl);
  const endpoint = `${url.origin}${url.pathname.replace(/\/+$/u, "")}/rest/v1/rpc/${G5_VERDICT_RPC}`;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.nowMs ?? (() => Date.now());

  async function ask(credential: unknown, scope: VerdictScope): Promise<unknown> {
    // Only a JWT-shaped string is ever sent; anything else would make G5 answer for nobody.
    if (typeof credential !== "string" || !JWT_SHAPE.test(credential)) throw new G5RpcError(null, "NO_JWT");
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: { "apikey": options.publishableKey, "Authorization": `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_app: scope.app, p_feature: scope.feature, p_brand_id: scope.brand ? scope.brand.slug : null }),
      });
    } catch {
      throw new G5RpcError(null, null);
    }
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const issued = now();
    if (response.status === 401 || response.status === 403) {
      // The JWT itself was not accepted: refuse (never allow) without guessing more.
      return {
        v: 1, decision: "deny", reason: "AUTH_REQUIRED", scope: { app: scope.app, feature: scope.feature, brand_slug: scope.brand ? scope.brand.slug : null },
        subject: { kind: "system" }, session: null, owner_epoch: null, entitlements: [], issued_at_ms: issued, expires_at_ms: issued,
      };
    }
    if (!response.ok) throw new G5RpcError(response.status, isRecord(body) ? safeToken(body.code) : null);
    // G5 returns the wire without times (section 6); a body with times or other keys is not that RPC's answer.
    if (!isRecord(body) || Object.keys(body).sort().join(",") !== RPC_WIRE_KEYS) throw new G5RpcError(response.status, "BAD_BODY");
    return { ...body, issued_at_ms: issued, expires_at_ms: body.decision === "allow" ? issued + G5_ALLOW_TTL_MS : issued };
  }

  return Object.freeze({
    fetchVerdict: (credential: unknown, scope: VerdictScope) => ask(credential, scope),
    // The same RPC with the same JWT: G5 derives the subject again; the port compares it with the first verdict.
    fetchRecheck: (credential: unknown, scope: VerdictScope) => ask(credential, scope),
  });
}
