/**
 * Phase1I exact-account pre-X token refresh (source only; no live caller).
 *
 * Flow for one v2 claim that is still pre-X:
 *   1. begin_x_account_refresh_v2 — the DB checks the exact claim/account and
 *      takes the account's single-flight lease; it returns the refresh token
 *      to this module only.
 *   2. exactly one POST to X's OAuth token endpoint (no redirect follow, no
 *      retry, timeout).
 *   3. confirmed tokens -> commit_x_account_refresh_v2 writes them to the same
 *      account's own Vault secrets and releases the lease in one transaction;
 *      otherwise release_x_account_refresh_v2 with the honest outcome.
 *
 * X refresh tokens are single-use. Whenever X may have rotated the token but
 * the result was not stored (network error, timeout, 5xx, 3xx, unparsable 2xx,
 * failed commit), the account is left 'uncertain' for operator re-connection;
 * it is never refreshed again automatically.
 *
 * Nothing here returns, logs, or throws a token, a response body, or a Vault
 * reference. The dispatcher only sees { postOutcome, code }.
 */
import type { XV2Claim } from "./x_v2_claim_credentials.ts";

const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const DEFAULT_TIMEOUT_MS = 15_000;
const CODE = /^[A-Z][A-Z0-9_]{1,99}$/u;

export type XOAuthClient = { clientId: string; clientSecret: string };
/** Resolves an account's oauth_client_ref to the app client it was issued by; null = not configured. */
export type XOAuthClientResolver = (oauthClientRef: string) => XOAuthClient | null;

/** Refresh token lease: the token is private and redacted from every serialization. */
export class XRefreshLease {
  readonly leaseToken: string;
  readonly oauthClientRef: string;
  readonly #refreshToken: string;
  constructor(leaseToken: string, oauthClientRef: string, refreshToken: string) {
    this.leaseToken = leaseToken;
    this.oauthClientRef = oauthClientRef;
    this.#refreshToken = refreshToken;
  }
  /** Only for building the token request body. */
  refreshTokenForRequest(): string {
    return this.#refreshToken;
  }
  toJSON() {
    return { leaseToken: "[redacted]", oauthClientRef: this.oauthClientRef };
  }
  toString() {
    return "[redacted XRefreshLease]";
  }
  [Symbol.for("Deno.customInspect")]() {
    return "[redacted XRefreshLease]";
  }
}

export type XAccountRefreshLedger = {
  /** begin_x_account_refresh_v2; throws Error(code) on refusal. */
  begin(claim: XV2Claim): Promise<XRefreshLease>;
  /** commit_x_account_refresh_v2; resolves "committed" | "lease_lost" | "account_changed". */
  commit(lease: XRefreshLease, socialAccountId: string, accessToken: string, refreshToken: string | null): Promise<string>;
  /** release_x_account_refresh_v2. */
  release(lease: XRefreshLease, socialAccountId: string, outcome: "not_rotated" | "reauth_required" | "uncertain", code: string): Promise<string>;
};

export type XAccountRefreshResult = {
  kind: "refreshed" | "not_started" | "not_rotated" | "reauth_required" | "uncertain";
  /** How the dispatcher must settle the pre-X attempt. */
  postOutcome: "pre_x_retryable" | "pre_x_terminal";
  code: string;
  tokenRequests: 0 | 1;
};

/** Refusals from begin that another run can clear by itself. */
const RETRYABLE_BEGIN_CODES = new Set(["X_REFRESH_IN_PROGRESS", "X_REFRESH_UNAVAILABLE", "V2_LEDGER_UNAVAILABLE"]);

function code(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return CODE.test(message) ? message : fallback;
}

type TokenClassification =
  | { kind: "confirmed"; accessToken: string; refreshToken: string | null }
  | { kind: "not_rotated"; code: string; retryable: boolean }
  | { kind: "reauth_required"; code: string }
  | { kind: "uncertain"; code: string };

async function classifyTokenResponse(response: Response): Promise<TokenClassification> {
  const status = response.status;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch { /* classified below; body never surfaced */ }
  if (status >= 200 && status < 300) {
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const access = record.access_token;
    const refresh = record.refresh_token;
    if (typeof access !== "string" || !access.trim()) return { kind: "uncertain", code: "X_REFRESH_RESPONSE_INVALID" };
    if (refresh !== undefined && refresh !== null && (typeof refresh !== "string" || !refresh.trim())) {
      return { kind: "uncertain", code: "X_REFRESH_RESPONSE_INVALID" };
    }
    if (typeof record.token_type === "string" && record.token_type.toLowerCase() !== "bearer") {
      return { kind: "uncertain", code: "X_REFRESH_RESPONSE_INVALID" };
    }
    return { kind: "confirmed", accessToken: access, refreshToken: typeof refresh === "string" ? refresh : null };
  }
  // 3xx is not followed; X may already have processed the grant.
  if (status < 400 || status === 408 || status >= 500) return { kind: "uncertain", code: `X_REFRESH_HTTP_${status}` };
  if (status === 429) return { kind: "not_rotated", code: "X_REFRESH_RATE_LIMITED", retryable: true };
  if (status === 400) {
    const error = (body as { error?: unknown } | null)?.error;
    return error === "invalid_grant"
      ? { kind: "reauth_required", code: "X_REFRESH_GRANT_REJECTED" }
      : { kind: "not_rotated", code: "X_REFRESH_REQUEST_REJECTED_400", retryable: false };
  }
  if (status === 401 || status === 403) return { kind: "not_rotated", code: `X_REFRESH_CLIENT_REJECTED_${status}`, retryable: false };
  return { kind: "not_rotated", code: `X_REFRESH_REJECTED_${status}`, retryable: false };
}

async function release(
  ledger: XAccountRefreshLedger, lease: XRefreshLease, accountId: string,
  outcome: "not_rotated" | "reauth_required" | "uncertain", errorCode: string,
): Promise<void> {
  try {
    await ledger.release(lease, accountId, outcome, errorCode);
  } catch {
    // The lease stays 'refreshing', which already blocks refresh and provider
    // start for this account: fail-closed, operator review.
  }
}

/**
 * Refresh exactly the claimed account's access token, before provider start.
 * Never throws; never exposes token material.
 */
export async function refreshXAccountPreX(
  {
    claim,
    ledger,
    resolveClient,
  }: { claim: XV2Claim; ledger: XAccountRefreshLedger; resolveClient: XOAuthClientResolver },
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<XAccountRefreshResult> {
  const notStarted = (c: string, retryable: boolean): XAccountRefreshResult => ({
    kind: "not_started", postOutcome: retryable ? "pre_x_retryable" : "pre_x_terminal", code: c, tokenRequests: 0,
  });
  if (!claim || [claim.attemptId, claim.claimToken, claim.socialAccountId, claim.brandId].some((v) => typeof v !== "string" || !v.trim())) {
    return notStarted("X_REFRESH_REQUEST_INVALID", false);
  }
  let lease: XRefreshLease;
  try {
    lease = await ledger.begin(claim);
  } catch (error) {
    const c = code(error, "X_REFRESH_UNAVAILABLE");
    return notStarted(c, RETRYABLE_BEGIN_CODES.has(c));
  }
  const client = (() => {
    try {
      return resolveClient(lease.oauthClientRef);
    } catch {
      return null;
    }
  })();
  if (!client || !client.clientId || !client.clientSecret) {
    await release(ledger, lease, claim.socialAccountId, "not_rotated", "X_REFRESH_CLIENT_NOT_CONFIGURED");
    return notStarted("X_REFRESH_CLIENT_NOT_CONFIGURED", false);
  }

  let classification: TokenClassification;
  try {
    const response = await fetchImpl(X_TOKEN_URL, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: lease.refreshTokenForRequest(),
        client_id: client.clientId,
      }),
    });
    classification = await classifyTokenResponse(response);
  } catch {
    classification = { kind: "uncertain", code: "X_REFRESH_NETWORK_UNCERTAIN" };
  }

  switch (classification.kind) {
    case "not_rotated":
      await release(ledger, lease, claim.socialAccountId, "not_rotated", classification.code);
      return { kind: "not_rotated", postOutcome: classification.retryable ? "pre_x_retryable" : "pre_x_terminal", code: classification.code, tokenRequests: 1 };
    case "reauth_required":
      await release(ledger, lease, claim.socialAccountId, "reauth_required", classification.code);
      return { kind: "reauth_required", postOutcome: "pre_x_terminal", code: classification.code, tokenRequests: 1 };
    case "uncertain":
      await release(ledger, lease, claim.socialAccountId, "uncertain", classification.code);
      return { kind: "uncertain", postOutcome: "pre_x_terminal", code: classification.code, tokenRequests: 1 };
    case "confirmed": {
      let committed: string;
      try {
        committed = await ledger.commit(lease, claim.socialAccountId, classification.accessToken, classification.refreshToken);
      } catch (error) {
        const c = code(error, "X_REFRESH_PERSIST_FAILED");
        await release(ledger, lease, claim.socialAccountId, "uncertain", "X_REFRESH_PERSIST_FAILED");
        return { kind: "uncertain", postOutcome: "pre_x_terminal", code: c, tokenRequests: 1 };
      }
      if (committed === "committed") {
        // Re-entry: the next run re-resolves and re-verifies the new token.
        return { kind: "refreshed", postOutcome: "pre_x_retryable", code: "X_ACCESS_TOKEN_REFRESHED_PRE_X", tokenRequests: 1 };
      }
      // lease_lost / account_changed: the new tokens were not stored.
      return {
        kind: "uncertain", postOutcome: "pre_x_terminal",
        code: committed === "account_changed" ? "X_REFRESH_ACCOUNT_CHANGED" : "X_REFRESH_LEASE_LOST", tokenRequests: 1,
      };
    }
  }
}

// --- PostgREST adapter ------------------------------------------------------------

export function createXAccountRefreshRpcLedger(
  { supabaseUrl, serviceRoleKey, fetchImpl = fetch }: { supabaseUrl: string; serviceRoleKey: string; fetchImpl?: typeof fetch },
): XAccountRefreshLedger {
  const base = supabaseUrl.replace(/\/$/u, "");
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" };
  const rpc = async (name: string, body: Record<string, unknown>): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, { method: "POST", headers, redirect: "manual", body: JSON.stringify(body) });
    } catch {
      throw new Error("X_REFRESH_UNAVAILABLE");
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch { /* empty */ }
    if (!response.ok) {
      const message = (payload as { message?: unknown } | null)?.message;
      throw new Error(typeof message === "string" && CODE.test(message) ? message : "X_REFRESH_UNAVAILABLE");
    }
    return payload;
  };
  return {
    async begin(claim) {
      const rows = await rpc("begin_x_account_refresh_v2", {
        p_attempt_id: claim.attemptId, p_claim_token: claim.claimToken,
        p_social_account_id: claim.socialAccountId, p_brand_id: claim.brandId,
      });
      const row = Array.isArray(rows) && rows.length === 1 ? rows[0] as Record<string, unknown> : null;
      if (!row || typeof row.lease_token !== "string" || typeof row.oauth_client_ref !== "string"
          || typeof row.refresh_token !== "string" || !row.refresh_token) {
        throw new Error("X_REFRESH_UNAVAILABLE");
      }
      return new XRefreshLease(row.lease_token, row.oauth_client_ref, row.refresh_token);
    },
    async commit(lease, socialAccountId, accessToken, refreshToken) {
      const out = await rpc("commit_x_account_refresh_v2", {
        p_lease_token: lease.leaseToken, p_social_account_id: socialAccountId,
        p_access_token: accessToken, p_refresh_token: refreshToken,
      });
      if (out !== "committed" && out !== "lease_lost" && out !== "account_changed") throw new Error("X_REFRESH_PERSIST_FAILED");
      return out;
    },
    async release(lease, socialAccountId, outcome, errorCode) {
      const out = await rpc("release_x_account_refresh_v2", {
        p_lease_token: lease.leaseToken, p_social_account_id: socialAccountId, p_outcome: outcome, p_error_code: errorCode,
      });
      if (typeof out !== "string") throw new Error("X_REFRESH_UNAVAILABLE");
      return out;
    },
  };
}

/** The only client today: oauth_client_ref 'default' -> the app's X OAuth client. */
export function defaultXOAuthClientResolver(getEnv: (name: string) => string | undefined): XOAuthClientResolver {
  return (ref) => {
    if (ref !== "default") return null;
    const clientId = getEnv("X_CLIENT_ID");
    const clientSecret = getEnv("X_CLIENT_SECRET");
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  };
}
