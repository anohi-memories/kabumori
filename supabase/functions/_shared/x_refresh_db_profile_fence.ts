/**
 * G4-02 #8 / #9: a fence for the X token refresh writer on G5's personal MVP database. Wired (G4-02 #9, source only) into the one writer that
 * runs: x-test-post/vault_account_auth.ts, for personal workspaces only. _shared/x_v2_account_refresh.ts's ledger has no caller on this stack
 * and is not wired: withXRefreshPrecheck is what its caller must use if one appears.
 *
 * A personal workspace with no personal SQL (006 / 007) refuses every refresh: adopt the SQL before this code. Operator / organization
 * accounts never ask, so their path does not change.
 *
 * Only `begin` is fenced. X refresh tokens are single-use: once the provider has been called, the result must still reach commit /
 * release, or the new tokens are lost. So commit and release pass through untouched.
 */

/** A POSTONA person's derived workspace id ('u_' + md5(user)[1:24]: G5 S2-3, G4's X and Threads SQL). Anything else is not personal. */
export function isPersonalXWorkspaceId(brandId: unknown): boolean {
  return typeof brandId === "string" && /^u_[0-9a-f]{24}$/u.test(brandId);
}

/** A refusal the refresh routine reports as not started: it must never call the provider. */
const CODE = /^[A-Z][A-Z0-9_]{1,80}$/u;
export const X_REFRESH_DB_PROFILE_MISMATCH = "X_REFRESH_DB_PROFILE_MISMATCH";

export type XRefreshPrecheck = (socialAccountId: string) => Promise<void>;

/**
 * public.postona_x_refresh_precheck_v1 (candidates/postona_g4_x_oauth_personal_mvp/007), with the worker's service role. Only exactly
 * "allow" passes. No such function (full / not installed: 404), no privilege, another shape: X_REFRESH_DB_PROFILE_MISMATCH. A network
 * failure or a 5xx: X_REFRESH_UNAVAILABLE (the routine's existing "retry later"). A database refusal: its fixed code, as below.
 */
export function createXRefreshPrecheck(
  { supabaseUrl, serviceRoleKey, fetchImpl = fetch }: { supabaseUrl: string; serviceRoleKey: string; fetchImpl?: typeof fetch },
): XRefreshPrecheck {
  const url = `${supabaseUrl.replace(/\/$/u, "")}/rest/v1/rpc/postona_x_refresh_precheck_v1`;
  return async (socialAccountId) => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_social_account_id: socialAccountId }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error("X_REFRESH_UNAVAILABLE");
    }
    if (response.status >= 500) {
      await response.body?.cancel();
      throw new Error("X_REFRESH_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(X_REFRESH_DB_PROFILE_MISMATCH);
    }
    const answer = await response.json().catch(() => null);
    if (answer === "allow") return;
    if (answer === "DB_PROFILE_MISMATCH" || typeof answer !== "string" || !CODE.test(answer)) throw new Error(X_REFRESH_DB_PROFILE_MISMATCH);
    // already taken: the routine's existing retryable code; anything else stays a fixed, non-retryable refusal
    throw new Error(answer === "REFRESH_IN_PROGRESS" ? "X_REFRESH_IN_PROGRESS" : `X_REFRESH_PRECHECK_${answer}`);
  };
}

/** The same refresh port with the precheck before `begin`. `commit`, `release` and everything else are the port's own, untouched. */
export function withXRefreshPrecheck<Args extends unknown[], Lease, Port extends { begin(...args: Args): Promise<Lease> }>(
  port: Port,
  precheck: XRefreshPrecheck,
  accountIdOf: (...args: Args) => string,
): Port {
  const fenced = Object.create(port) as Port;
  fenced.begin = async (...args: Args) => {
    await precheck(accountIdOf(...args));
    return await port.begin(...args);
  };
  return fenced;
}
