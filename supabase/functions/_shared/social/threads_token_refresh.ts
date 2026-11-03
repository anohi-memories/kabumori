// POSTONA Threads — long-lived token refresh: the policy, the Meta request/response contract, and a single-flight
// coordinator over a STORE PORT (F4). DESIGN CANDIDATE ONLY: imported by no Edge entry, scheduled by nothing,
// THREADS_TOKEN_REFRESH_ENABLED = false. The store (credential persistence and rotation in Vault, the account lease, the
// F5 lifecycle fence) belongs to H5 / G4 SQL / F5 and is NOT implemented here; tests use a fake. No network in tests.
//
// Documented by Meta (developers.facebook.com/docs/threads/get-started/long-lived-tokens):
//   GET /refresh_access_token?grant_type=th_refresh_token&access_token=<long-lived token>
//   only for a token "at least 24 hours old" that has "not expired"; the answer has access_token, token_type,
//   expires_in; the refreshed token is valid 60 days; a token not refreshed within 60 days expires for good.
// NOT documented (design assumptions, marked so in docs/postona/threads-token-refresh-design.md): whether the token
// string changes, whether the previous string stays valid, error codes/limits. Hence a lost or malformed answer is
// UNCERTAIN (never "refreshed", never "re-authenticate"), and the store keeps the old credential until it is proven bad.

export const THREADS_TOKEN_REFRESH_ENABLED = false;
/** Host as fixed by the repository's Meta notes (docs/postona/threads-connection-phase2b.md, T3). */
export const THREADS_REFRESH_ENDPOINT = "https://graph.threads.net/refresh_access_token";
export const MIN_TOKEN_AGE_MS = 24 * 3600 * 1000;
/** Same cap as the credential custody record (expires_at in (now, now + 61 days]). */
export const MAX_TOKEN_LIFETIME_MS = 61 * 24 * 3600 * 1000;
/** Assumption: refresh once inside the last 14 days, leaving room for missed runs before the 60-day end. */
export const REFRESH_WINDOW_MS = 14 * 24 * 3600 * 1000;
export const REFRESH_TIMEOUT_MS = 10_000;

export type RefreshDecision = "not_due" | "too_young" | "refresh_now" | "reauth_required";

/**
 * When to refresh. An unknown issue time or expiry (custody reader NULL) or an expired token can only be fixed by the
 * person reconnecting: reauth_required. Younger than 24 h: Meta refuses, so not attempted.
 */
export function refreshDecision(input: { now: number; issuedAt: number | null; expiresAt: number | null; windowMs?: number }): RefreshDecision {
  const { now, issuedAt, expiresAt } = input;
  if (issuedAt === null || expiresAt === null || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return "reauth_required";
  if (now >= expiresAt) return "reauth_required";
  if (now - issuedAt < MIN_TOKEN_AGE_MS) return "too_young";
  if (expiresAt - now > (input.windowMs ?? REFRESH_WINDOW_MS)) return "not_due";
  return "refresh_now";
}

const TOKEN_SHAPE = /^[A-Za-z0-9._|-]{20,2048}$/;

/** The refresh URL for one stored token. A token of an unexpected shape is never sent (and never echoed). */
export function buildRefreshUrl(accessToken: string): string {
  if (typeof accessToken !== "string" || !TOKEN_SHAPE.test(accessToken)) throw new Error("THREADS_REFRESH_TOKEN_SHAPE_INVALID");
  const url = new URL(THREADS_REFRESH_ENDPOINT);
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", accessToken);
  return url.href;
}

export type RefreshOutcome =
  | { kind: "refreshed"; accessToken: string; expiresAt: number }
  /** Meta says this credential is no longer valid (OAuthException 190): the person must reconnect. */
  | { kind: "reauth_required"; code: "THREADS_REFRESH_TOKEN_INVALID" }
  /** A definite refusal of this attempt (other 4xx): the stored credential is kept; tried again in a later window. */
  | { kind: "rejected"; code: "THREADS_REFRESH_REJECTED" }
  /** No proven answer (429, 5xx, network, timeout, malformed 200): keep the stored credential, never conclude. */
  | { kind: "uncertain"; code: "THREADS_REFRESH_UNAVAILABLE" | "THREADS_REFRESH_RESPONSE_MALFORMED" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `requestedAt` is taken BEFORE the request (a conservative clock: latency never extends the expiry). */
export function parseRefreshResponse(status: number, bodyText: string | null, requestedAt: number): RefreshOutcome {
  let body: unknown = null;
  try { body = bodyText === null ? null : JSON.parse(bodyText); } catch { body = null; }
  if (status === 200) {
    if (!isRecord(body)) return { kind: "uncertain", code: "THREADS_REFRESH_RESPONSE_MALFORMED" };
    const { access_token: token, token_type: type, expires_in: expiresIn } = body;
    if (typeof token !== "string" || !TOKEN_SHAPE.test(token) || (type !== undefined && (typeof type !== "string" || type.toLowerCase() !== "bearer"))
      || typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn * 1000 > MAX_TOKEN_LIFETIME_MS) {
      return { kind: "uncertain", code: "THREADS_REFRESH_RESPONSE_MALFORMED" };
    }
    return { kind: "refreshed", accessToken: token, expiresAt: requestedAt + expiresIn * 1000 };
  }
  if (status === 429 || status >= 500 || status < 400) return { kind: "uncertain", code: "THREADS_REFRESH_UNAVAILABLE" };
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (error && error.code === 190) return { kind: "reauth_required", code: "THREADS_REFRESH_TOKEN_INVALID" };
  return { kind: "rejected", code: "THREADS_REFRESH_REJECTED" };
}

/** What one claim of an account gives the refresher (owned and implemented by H5 / G4 SQL / F5, not here). */
export type RefreshClaim = Readonly<{
  lease: string;
  /** Identifies the exact stored credential (e.g. the Vault secret id + custody row); the commit is a compare-and-set on it. */
  credentialVersion: string;
  issuedAt: number | null;
  expiresAt: number | null;
  accessToken: string;
}>;
export type RefreshStore = {
  /**
   * Exclusive per-account lease. "busy" while a publish, delete, disconnect, cleanup or another refresh holds the
   * account; null when it is not (any more) a verified Threads account of an ACTIVE POSTONA service (F5 fence), e.g.
   * disconnected, deleted, service ended, or moved to another workspace.
   */
  claim(accountId: string): Promise<RefreshClaim | "busy" | null>;
  /** Store the new credential only if the account still holds `credentialVersion` (else "conflict": nothing written). */
  commit(lease: string, credentialVersion: string, next: { accessToken: string; expiresAt: number; refreshedAt: number }): Promise<"committed" | "conflict">;
  /** Mark that the person must reconnect (the account shows 要再接続), only if still `credentialVersion`. */
  markReauthRequired(lease: string, credentialVersion: string, code: string): Promise<void>;
  release(lease: string): Promise<void>;
};

export type RefreshResult =
  | "disabled" | "gone" | "busy" | "not_due" | "too_young" | "refreshed" | "reauth_required" | "rejected" | "uncertain" | "conflict";

/**
 * One refresh attempt for one account, server side, never for a request of a person (no session, no user id input).
 * Returns only a fixed result word: the token never leaves this function except into store.commit.
 */
export function createThreadsTokenRefresher(deps: {
  store: RefreshStore;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  enabled?: boolean;
}) {
  return {
    async refresh(accountId: string): Promise<RefreshResult> {
      if ((deps.enabled ?? THREADS_TOKEN_REFRESH_ENABLED) !== true) return "disabled";
      const claim = await deps.store.claim(accountId);
      if (claim === null) return "gone";
      if (claim === "busy") return "busy";
      try {
        const decision = refreshDecision({ now: deps.now(), issuedAt: claim.issuedAt, expiresAt: claim.expiresAt });
        if (decision === "not_due" || decision === "too_young") return decision;
        if (decision === "reauth_required") {
          await deps.store.markReauthRequired(claim.lease, claim.credentialVersion, "THREADS_TOKEN_EXPIRED_OR_UNKNOWN");
          return "reauth_required";
        }
        let url: string;
        try { url = buildRefreshUrl(claim.accessToken); } catch { return "uncertain"; }
        const requestedAt = deps.now();
        let outcome: RefreshOutcome;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
        try {
          const response = await deps.fetch(url, { method: "GET", redirect: "error", signal: controller.signal });
          outcome = parseRefreshResponse(response.status, await response.text().catch(() => null), requestedAt);
        } catch {
          outcome = { kind: "uncertain", code: "THREADS_REFRESH_UNAVAILABLE" };
        } finally {
          clearTimeout(timer);
        }
        if (outcome.kind === "refreshed") {
          const stored = await deps.store.commit(claim.lease, claim.credentialVersion, { accessToken: outcome.accessToken, expiresAt: outcome.expiresAt, refreshedAt: requestedAt });
          return stored === "committed" ? "refreshed" : "conflict";
        }
        if (outcome.kind === "reauth_required") {
          await deps.store.markReauthRequired(claim.lease, claim.credentialVersion, outcome.code);
          return "reauth_required";
        }
        return outcome.kind;
      } finally {
        await deps.store.release(claim.lease);
      }
    },
  };
}
