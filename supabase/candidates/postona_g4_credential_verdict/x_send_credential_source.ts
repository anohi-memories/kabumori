/**
 * G4-02 #19 (Issue #561): G4's X send credential source for G3's X send paths. G4 SOURCE CANDIDATE: not deployed, not wired into
 * any entry in this tree. G3 composes it (G3's code is G3's): for the manual send and the worker alike,
 *
 *   credentials = xGenerationSourceFromG4Raw(createG4XSendCredentialSource({ read: createXSendCredentialRpcRead({ ... }) }))
 *
 * (xGenerationSourceFromG4Raw: G3's _shared/postona_reservations/credential_generation_derivation.ts, PR #699.)
 *
 * The source answers G3's raw shape { token, g4Generation } for exactly one account per call, from ONE database read:
 * public.postona_x_send_credential_v1 (003_x_send_credential_read.sql), which re-checks G4's X verdict for the account's owner under
 * the account row's lock and reads the token in the same transaction. Fail-closed: anything but exactly one well-formed VERIFIED row
 * is null (answered, never thrown). Nothing is cached: each call is a new read, so a refresh, reconnect, disconnect, service end,
 * owner change or Vault change is seen by the next call. No token, account id or database answer is logged or put into an error.
 */

/** G4's X generation as 002 answers it: 'g4x1:' || connection_epoch. */
export const G4_X_GENERATION_RE = /^g4x1:[0-9]{1,19}$/u;
/** The same token shape G3 accepts (X_ACCESS_TOKEN_RE) and 003 checks. */
export const G4_X_ACCESS_TOKEN_RE = /^[\x21-\x7e]{16,4096}$/u;
/** The social_accounts id shape 003 accepts. */
export const G4_X_ACCOUNT_ID_RE = /^[a-z][a-z0-9_]{1,80}$/u;

export const X_SEND_CREDENTIAL_UNAVAILABLE = "X_SEND_CREDENTIAL_UNAVAILABLE";

/** One read of public.postona_x_send_credential_v1 for one account: the rows as the database answered them. */
export type XSendCredentialRead = (socialAccountId: string) => Promise<unknown>;

export type G4XRawCredential = { token: string; g4Generation: string };
export type G4XSendCredentialSource = {
  readonly available: true;
  credentialFor(socialAccountId: string): Promise<G4XRawCredential | null>;
};

export function createG4XSendCredentialSource({ read }: { read: XSendCredentialRead }): G4XSendCredentialSource {
  if (typeof read !== "function") throw new Error("G4_X_SEND_CREDENTIAL_READ_REQUIRED");
  return Object.freeze({
    available: true as const,
    async credentialFor(socialAccountId: string): Promise<G4XRawCredential | null> {
      if (typeof socialAccountId !== "string" || !G4_X_ACCOUNT_ID_RE.test(socialAccountId)) return null;
      let rows: unknown;
      try {
        rows = await read(socialAccountId);
      } catch {
        return null;
      }
      if (!Array.isArray(rows) || rows.length !== 1) return null;
      const row = rows[0] as Record<string, unknown> | null;
      if (!row || typeof row !== "object") return null;
      const { code, credential_generation: generation, access_token: token } = row;
      if (code !== "VERIFIED") return null;
      if (typeof generation !== "string" || !G4_X_GENERATION_RE.test(generation)) return null;
      if (typeof token !== "string" || !G4_X_ACCESS_TOKEN_RE.test(token)) return null;
      return { token, g4Generation: generation };
    },
  });
}

/**
 * The read over PostgREST with the server's service-role key (the only role 003 grants EXECUTE). https only; plain http only for a
 * loopback host (a local stack). No redirect, 5 s. A refusal, a 4xx / 5xx, a network failure or a body that is not JSON
 * throws X_SEND_CREDENTIAL_UNAVAILABLE (the source turns it into null). The response body never reaches an error or a log.
 */
export function createXSendCredentialRpcRead(
  { supabaseUrl, serviceRoleKey, fetchImpl = fetch, timeoutMs = 5000 }:
    { supabaseUrl: string; serviceRoleKey: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): XSendCredentialRead {
  let base: URL;
  try {
    base = new URL(supabaseUrl);
  } catch {
    throw new Error("G4_X_SEND_CREDENTIAL_URL_INVALID");
  }
  const loopback = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
  if (!(base.protocol === "https:" || (base.protocol === "http:" && loopback)) || base.username || base.password || base.search || base.hash) {
    throw new Error("G4_X_SEND_CREDENTIAL_URL_INVALID");
  }
  if (typeof serviceRoleKey !== "string" || serviceRoleKey.length < 16) throw new Error("G4_X_SEND_CREDENTIAL_KEY_REQUIRED");
  const url = `${base.origin}${base.pathname.replace(/\/$/u, "")}/rest/v1/rpc/postona_x_send_credential_v1`;
  return async (socialAccountId) => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ p_social_account_id: socialAccountId }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error(X_SEND_CREDENTIAL_UNAVAILABLE);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(X_SEND_CREDENTIAL_UNAVAILABLE);
    }
    try {
      return await response.json();
    } catch {
      throw new Error(X_SEND_CREDENTIAL_UNAVAILABLE);
    }
  };
}
