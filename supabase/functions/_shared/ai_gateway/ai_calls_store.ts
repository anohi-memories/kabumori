// G6 runtime candidate (2026-10-19, G6-01): the gateway's CallStore over the ai_calls RPCs of migration
// 20261017120000 (PR249), called through PostgREST with the service key, like SupabaseLedgerBudgetGuard does for the
// ledger. NOT deployed; since G6-24 only the (undeployed) postona-post-assist entry reaches it (see
// docs/ai-provider/G6_AI_GATEWAY_RUNTIME_SOURCE.md).
//
// claim  -> public.ai_calls_claim:    {kind: acquired, owner} | {kind: busy} | {kind: conflict} | {kind: complete, fingerprint, result}
// complete -> public.ai_calls_complete: {state: complete, duplicate}
// Any other answer, an HTTP error or a lost connection throws: the gateway then answers STORE_UNAVAILABLE before
// anything is sent (claim) or UNKNOWN without resending (complete). Errors carry the RPC name, the HTTP status and a
// sanitised PostgREST code, never a body, a key or a payload. The key is a SecretValue revealed only into headers.
// G6-27: a claim that PostgREST refused itself (definiteRefusal: the RPC not adopted = 404 PGRST202, not permitted, a shape
// it does not take) throws AiCallsClaimRefused, which the gateway answers as not sent without a same-key retry. A redirect is
// never followed (the service key is in the headers): it is such a refusal.
import type { FetchLike } from "../ai_provider/adapter.ts";
import { safeToken } from "../ai_provider/redact.ts";
import type { SecretValue } from "../ai_provider/secrets.ts";
import { type CallClaim, type CallIdentity, type CallStore, CallStoreRefusedError, type ClaimContext, type StoredOutcome } from "./gateway.ts";

export type AiCallsStoreOptions = Readonly<{
  /** The project URL, e.g. https://<ref>.supabase.co (http only for a local loopback test server). */
  supabaseUrl: string;
  /** The server-side secret key that alone may execute the ai_calls RPCs. */
  serviceKey: SecretValue;
  fetch?: FetchLike;
  /** Per RPC call (default 10 s). */
  rpcTimeoutMs?: number;
}>;

const rpcFailed = (rpc: string, status: number | null, code: string | null) => `AI_CALLS_RPC_FAILED:${rpc}:${status ?? "network"}${code ? `:${code}` : ""}`;

export class AiCallsRpcError extends Error {
  readonly rpc: string;
  readonly status: number | null;
  constructor(rpc: string, status: number | null, code: string | null) {
    super(rpcFailed(rpc, status, code));
    this.rpc = rpc;
    this.status = status;
  }
}
/** G6-27: ai_calls_claim refused by PostgREST itself (definiteRefusal): nothing was claimed; the same key cannot succeed. */
export class AiCallsClaimRefused extends CallStoreRefusedError {
  readonly status: number;
  constructor(status: number, code: string | null) {
    super(rpcFailed("ai_calls_claim", status, code));
    this.status = status;
  }
}

/**
 * G6-27: PostgREST answered and refused the call itself: 3xx (never followed) or 4xx other than 408 / 429. The RPC is not adopted
 * (404 PGRST202: not in the schema cache), not permitted, or does not take this shape; an RPC that raised was rolled back. Nothing
 * ran, and asking again unchanged cannot succeed. 5xx, 408, 429 and no answer may be transient.
 */
export const definiteRefusal = (status: number): boolean => status >= 300 && status < 500 && status !== 408 && status !== 429;

const OWNER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysAre = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(",") === keys;

/** True for http://127.0.0.1 / http://localhost (a local test server) and every https URL. */
export function supabaseUrlAllowed(supabaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    return false;
  }
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  return url.protocol === "https:" || loopback;
}

export class SupabaseAiCallsStore implements CallStore {
  readonly #base: string;
  readonly #key: SecretValue;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: AiCallsStoreOptions) {
    if (!supabaseUrlAllowed(options.supabaseUrl)) throw new Error("AI_CALLS_URL_NOT_HTTPS");
    const url = new URL(options.supabaseUrl);
    this.#base = `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    this.#key = options.serviceKey;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    const timeout = options.rpcTimeoutMs ?? 10_000;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) throw new Error("AI_CALLS_RPC_TIMEOUT_INVALID");
    this.#timeoutMs = timeout;
  }

  async #rpc(name: "ai_calls_claim" | "ai_calls_complete", p: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: {
          "apikey": this.#key.reveal(),
          "Authorization": `Bearer ${this.#key.reveal()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p }),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "manual",
      });
    } catch {
      throw new AiCallsRpcError(name, null, null);
    }
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const code = isRecord(body) ? safeToken(body.code) : null;
      if (name === "ai_calls_claim" && definiteRefusal(response.status)) throw new AiCallsClaimRefused(response.status, code);
      throw new AiCallsRpcError(name, response.status, code);
    }
    if (!isRecord(body)) throw new AiCallsRpcError(name, response.status, "BAD_BODY");
    return body;
  }

  async claim(identity: CallIdentity, context: ClaimContext): Promise<CallClaim> {
    const c = await this.#rpc("ai_calls_claim", claimIdentityPayload(identity, context));
    if (c.kind === "acquired" && keysAre(c, "kind,owner") && typeof c.owner === "string" && OWNER.test(c.owner)) return { kind: "acquired", owner: c.owner };
    if ((c.kind === "busy" || c.kind === "conflict") && keysAre(c, "kind")) return { kind: c.kind };
    if (c.kind === "complete" && keysAre(c, "fingerprint,kind,result") && typeof c.fingerprint === "string" && FINGERPRINT.test(c.fingerprint) && isRecord(c.result)) {
      // The gateway checks the stored outcome field by field before it answers from it.
      return { kind: "complete", fingerprint: c.fingerprint, outcome: c.result as unknown as StoredOutcome };
    }
    throw new AiCallsRpcError("ai_calls_claim", 200, "BAD_BODY");
  }

  async complete(identity: CallIdentity, owner: string, outcome: StoredOutcome): Promise<void> {
    const r = await this.#rpc("ai_calls_complete", {
      call_key: identity.key,
      tenant_tag: identity.tenantTag,
      fingerprint: identity.fingerprint,
      owner,
      result: outcome,
    });
    if (r.state !== "complete" || typeof r.duplicate !== "boolean" || !keysAre(r, "duplicate,state")) throw new AiCallsRpcError("ai_calls_complete", 200, "BAD_BODY");
  }
}

/** The call identity as ai_calls_claim (and ai_calls_claim_held) read it. */
export function claimIdentityPayload(identity: CallIdentity, context: ClaimContext): Record<string, unknown> {
  const s = context.subject;
  const p: Record<string, unknown> = {
    call_key: identity.key,
    tenant_tag: identity.tenantTag,
    fingerprint: identity.fingerprint,
    application: context.app,
    feature: context.storeFeature,
    subject_kind: s.kind,
  };
  if (s.kind === "user") {
    p.user_id = s.userId;
    // The brand slug is kept for audit display only (ai_calls.brand_ref); it is never an identity.
    if (s.brand) p.brand_ref = s.brand.slug;
  }
  return p;
}

/** G6-20: the owner-held identity (ai_calls_claim_held's input): the claim identity plus the ORIGINAL claim token. */
export function heldPayload(identity: CallIdentity, context: ClaimContext, owner: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...claimIdentityPayload(identity, context), owner });
}
