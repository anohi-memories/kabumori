/**
 * Generic exact-account X credentials for the live (legacy, unbound)
 * dispatcher: every non-Kabumori brand's Vault-backed X account, current and
 * future, with no brand-specific branch.
 *
 * Authority: the running scheduled post. The database derives the post
 * brand's one and only X account, re-checks that it is the account the
 * caller named, and reads/writes only that account's own Vault secrets
 * (20260925140000_x_account_credential_refresh_core.sql). No secret id, token
 * store or other account's token is ever used.
 *
 * Refresh policy per publish attempt (this object lives for one attempt):
 *   - proactive: when the stored expiry says the access token is (nearly)
 *     expired, refresh before the X request;
 *   - reactive: a 401 from X means the request was not accepted, so if no
 *     refresh ran yet and no X write was accepted in this attempt, refresh
 *     once and retry the exact same request once;
 *   - at most one refresh and one retry; never after an accepted X write;
 *     a 401 on a freshly refreshed token marks re-authorization required;
 *   - refresh outcomes other than a committed rotation fail the attempt with
 *     the fixed code (uncertain results are never replayed).
 * Refresh runs only when X_VAULT_ACCOUNT_REFRESH=enabled (global kill switch)
 * AND the exact account's rollout authority allows it (Stage 3A, enforced in
 * the database before any Vault read). Otherwise a 401 is recorded on the
 * account without calling the token endpoint. A proactive refresh that the
 * database refuses before any token request (rollout off, pilot limits,
 * another refresh in progress) keeps the current token for this request.
 *
 * Nothing here logs or returns token material; errors carry fixed codes only.
 */
import {
  runXTokenRefresh,
  type XOAuthClientResolver,
  XRefreshLease,
} from "../_shared/x_v2_account_refresh.ts";

const CODE = /^[A-Z][A-Z0-9_]{1,99}$/u;
/** Refusals of the account's rollout authority (Stage 3A): no refresh, record the 401. */
const ROLLOUT_REFUSALS = new Set([
  "X_REFRESH_ROLLOUT_OFF", "X_REFRESH_PILOT_EXPIRED", "X_REFRESH_PILOT_LIMIT_REACHED", "X_REFRESH_PILOT_BLOCKED_BY_ERROR",
]);
const PROACTIVE_MARGIN_MS = 5 * 60_000;

export type VaultAccountRef = { scheduledPostId: string; socialAccountId: string; brandId: string };
export type VaultAccountCredential = { accessToken: string; accessExpiresAt: string | null };
export type XRequestResult = { status: number; body: unknown };

/** The core RPCs, each bound to the running post + its exact account. */
export type VaultAccountCredentialRpc = {
  read(ref: VaultAccountRef): Promise<VaultAccountCredential>;
  begin(ref: VaultAccountRef): Promise<XRefreshLease>;
  commit(lease: XRefreshLease, ref: VaultAccountRef, accessToken: string, refreshToken: string | null, expiresIn: number | null): Promise<string>;
  release(lease: XRefreshLease, ref: VaultAccountRef, outcome: "not_rotated" | "reauth_required" | "uncertain", code: string): Promise<string>;
  recordRejectedAfterRefresh(ref: VaultAccountRef): Promise<string>;
  recordAccessUnauthorized(ref: VaultAccountRef): Promise<string>;
};

function fixedCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return CODE.test(message) ? message : fallback;
}

export class VaultAccountXAuth {
  readonly #ref: VaultAccountRef;
  readonly #rpc: VaultAccountCredentialRpc;
  readonly #resolveClient: XOAuthClientResolver;
  readonly #refreshEnabled: boolean;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number | undefined;
  readonly #now: () => number;
  #accessToken: string;
  #accessExpiresAt: number | null;
  #refreshUsed = false;
  #refreshed = false;
  #xWriteAccepted = false;

  private constructor(
    ref: VaultAccountRef, rpc: VaultAccountCredentialRpc, credential: VaultAccountCredential,
    options: { resolveClient: XOAuthClientResolver; refreshEnabled: boolean; fetchImpl: typeof fetch; timeoutMs?: number; now: () => number },
  ) {
    this.#ref = ref;
    this.#rpc = rpc;
    this.#resolveClient = options.resolveClient;
    this.#refreshEnabled = options.refreshEnabled;
    this.#fetchImpl = options.fetchImpl;
    this.#timeoutMs = options.timeoutMs;
    this.#now = options.now;
    this.#accessToken = credential.accessToken;
    this.#accessExpiresAt = parseExpiry(credential.accessExpiresAt);
  }

  /**
   * Reads the exact account's access token. Runs before any content
   * generation, so an account that is refreshing, blocked ('uncertain') or
   * needs re-authorization fails closed without generation or X cost.
   */
  static async load(
    ref: VaultAccountRef,
    rpc: VaultAccountCredentialRpc,
    {
      resolveClient,
      refreshEnabled,
      fetchImpl = fetch,
      timeoutMs,
      now = Date.now,
    }: { resolveClient: XOAuthClientResolver; refreshEnabled: boolean; fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number },
  ): Promise<VaultAccountXAuth> {
    if ([ref?.scheduledPostId, ref?.socialAccountId, ref?.brandId].some((v) => typeof v !== "string" || !v.trim())) {
      throw new Error("X_CREDENTIAL_REQUEST_INVALID");
    }
    let credential: VaultAccountCredential;
    try {
      credential = await rpc.read(ref);
    } catch (error) {
      throw new Error(fixedCode(error, "X_CREDENTIAL_UNAVAILABLE"));
    }
    if (typeof credential?.accessToken !== "string" || !credential.accessToken) throw new Error("X_CREDENTIAL_UNAVAILABLE");
    return new VaultAccountXAuth(ref, rpc, credential, { resolveClient, refreshEnabled, fetchImpl, timeoutMs, now });
  }

  get refreshExecuted(): boolean {
    return this.#refreshed;
  }

  /**
   * Sends one intended X request with the account's access token, applying
   * the refresh policy above. Returns X's final response (the caller handles
   * non-2xx); throws only fixed codes.
   */
  async send(request: (accessToken: string) => Promise<XRequestResult>): Promise<XRequestResult> {
    if (this.#refreshEnabled && !this.#refreshUsed && !this.#xWriteAccepted && this.#accessExpiresAt !== null
        && this.#accessExpiresAt - this.#now() <= PROACTIVE_MARGIN_MS) {
      await this.#refresh("proactive");
    }
    const first = await request(this.#accessToken);
    if (first.status !== 401) return this.#observe(first);
    if (this.#refreshed) return await this.#rejectedAfterRefresh();
    if (!this.#refreshEnabled || this.#refreshUsed || this.#xWriteAccepted) {
      await this.#quiet(() => this.#rpc.recordAccessUnauthorized(this.#ref));
      throw new Error("X_ACCESS_TOKEN_UNAUTHORIZED");
    }
    // 401: X did not accept the request, so refreshing and replaying it once is safe.
    await this.#refresh("reactive");
    const retried = await request(this.#accessToken);
    if (retried.status === 401) return await this.#rejectedAfterRefresh();
    return this.#observe(retried);
  }

  #observe(result: XRequestResult): XRequestResult {
    if (result.status >= 200 && result.status < 300) this.#xWriteAccepted = true;
    return result;
  }

  async #rejectedAfterRefresh(): Promise<never> {
    await this.#quiet(() => this.#rpc.recordRejectedAfterRefresh(this.#ref));
    throw new Error("X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH");
  }

  async #refresh(trigger: "proactive" | "reactive"): Promise<void> {
    const ref = this.#ref;
    const outcome = await runXTokenRefresh({
      begin: () => this.#rpc.begin(ref),
      commit: (lease, access, refresh, expiresIn) => this.#rpc.commit(lease, ref, access, refresh, expiresIn),
      release: (lease, result, code) => this.#rpc.release(lease, ref, result, code),
    }, this.#resolveClient, { fetchImpl: this.#fetchImpl, timeoutMs: this.#timeoutMs });
    // Only expected pre-request refusals may keep a still-valid token.
    // An unavailable reader or changed account authority must fail closed.
    if (outcome.kind === "not_started" && trigger === "proactive"
        && (ROLLOUT_REFUSALS.has(outcome.code) || outcome.code === "X_REFRESH_IN_PROGRESS")) return;
    this.#refreshUsed = true;
    if (outcome.kind === "not_started" && ROLLOUT_REFUSALS.has(outcome.code)) {
      await this.#quiet(() => this.#rpc.recordAccessUnauthorized(ref));
    }
    if (outcome.kind !== "refreshed") throw new Error(outcome.code);
    // Use what was durably stored, read back through the same exact-account reader.
    let credential: VaultAccountCredential;
    try {
      credential = await this.#rpc.read(ref);
    } catch (error) {
      throw new Error(fixedCode(error, "X_CREDENTIAL_UNAVAILABLE"));
    }
    if (typeof credential?.accessToken !== "string" || !credential.accessToken) throw new Error("X_CREDENTIAL_UNAVAILABLE");
    this.#accessToken = credential.accessToken;
    this.#accessExpiresAt = parseExpiry(credential.accessExpiresAt);
    this.#refreshed = true;
  }

  async #quiet(record: () => Promise<unknown>): Promise<void> {
    try {
      await record();
    } catch {
      // Health recording is best effort; the attempt already fails with a fixed code.
    }
  }

  toJSON() {
    return { socialAccountId: this.#ref.socialAccountId, refreshExecuted: this.#refreshed };
  }
  toString() {
    return "[redacted VaultAccountXAuth]";
  }
  [Symbol.for("Deno.customInspect")]() {
    return "[redacted VaultAccountXAuth]";
  }
}

function parseExpiry(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

// --- PostgREST adapter ------------------------------------------------------------

export function createVaultAccountCredentialRpc(
  { supabaseUrl, serviceRoleKey, fetchImpl = fetch }: { supabaseUrl: string; serviceRoleKey: string; fetchImpl?: typeof fetch },
): VaultAccountCredentialRpc {
  const base = supabaseUrl.replace(/\/$/u, "");
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" };
  const rpc = async (name: string, body: Record<string, unknown>, fallback: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, { method: "POST", headers, redirect: "manual", body: JSON.stringify(body) });
    } catch {
      throw new Error(fallback);
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch { /* empty */ }
    if (!response.ok) {
      const message = (payload as { message?: unknown } | null)?.message;
      throw new Error(typeof message === "string" && CODE.test(message) ? message : fallback);
    }
    return payload;
  };
  const post = (ref: VaultAccountRef) => ({
    p_scheduled_post_id: ref.scheduledPostId, p_social_account_id: ref.socialAccountId, p_brand_id: ref.brandId,
  });
  const single = (rows: unknown): Record<string, unknown> | null =>
    Array.isArray(rows) && rows.length === 1 && typeof rows[0] === "object" && rows[0] !== null ? rows[0] as Record<string, unknown> : null;
  return {
    async read(ref) {
      const row = single(await rpc("read_x_publish_credential_for_legacy_post", post(ref), "X_CREDENTIAL_UNAVAILABLE"));
      if (!row || row.social_account_id !== ref.socialAccountId || row.brand_id !== ref.brandId
          || typeof row.access_token !== "string" || !row.access_token
          || (row.access_expires_at !== null && typeof row.access_expires_at !== "string")) {
        throw new Error("X_CREDENTIAL_UNAVAILABLE");
      }
      return { accessToken: row.access_token, accessExpiresAt: row.access_expires_at as string | null };
    },
    async begin(ref) {
      const row = single(await rpc("begin_x_account_refresh_legacy_post", post(ref), "X_REFRESH_UNAVAILABLE"));
      if (!row || typeof row.lease_token !== "string" || typeof row.oauth_client_ref !== "string"
          || typeof row.refresh_token !== "string" || !row.refresh_token) {
        throw new Error("X_REFRESH_UNAVAILABLE");
      }
      return new XRefreshLease(row.lease_token, row.oauth_client_ref, row.refresh_token);
    },
    async commit(lease, ref, accessToken, refreshToken, expiresIn) {
      const out = await rpc("commit_x_account_refresh_legacy_post", {
        p_lease_token: lease.leaseToken, p_social_account_id: ref.socialAccountId,
        p_access_token: accessToken, p_refresh_token: refreshToken, p_expires_in: expiresIn,
      }, "X_REFRESH_PERSIST_FAILED");
      if (out !== "committed" && out !== "lease_lost" && out !== "account_changed") throw new Error("X_REFRESH_PERSIST_FAILED");
      return out;
    },
    async release(lease, ref, outcome, errorCode) {
      const out = await rpc("release_x_account_refresh_v2", {
        p_lease_token: lease.leaseToken, p_social_account_id: ref.socialAccountId, p_outcome: outcome, p_error_code: errorCode,
      }, "X_REFRESH_UNAVAILABLE");
      if (typeof out !== "string") throw new Error("X_REFRESH_UNAVAILABLE");
      return out;
    },
    async recordRejectedAfterRefresh(ref) {
      const out = await rpc("record_x_account_rejected_after_refresh", post(ref), "X_REFRESH_UNAVAILABLE");
      if (typeof out !== "string") throw new Error("X_REFRESH_UNAVAILABLE");
      return out;
    },
    async recordAccessUnauthorized(ref) {
      const out = await rpc("record_x_account_access_unauthorized", post(ref), "X_REFRESH_UNAVAILABLE");
      if (typeof out !== "string") throw new Error("X_REFRESH_UNAVAILABLE");
      return out;
    },
  };
}
