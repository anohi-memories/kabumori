/**
 * POSTONA X, M1 -- G4's server-only XPostingCredentialSource (F4 / G4, Issue #131 minimal source; Issue #269 directive).
 * SOURCE CANDIDATE: imported by no Edge entry; X_POSTING_CREDENTIAL_SOURCE_ENABLED = false.
 *
 * It answers F3's port (PR #224 x_publisher.ts `XPostingCredentialSource`; contract C1-C5 in PR #257
 * x_credential_contract.ts) from the database G4 owns: `public.x_posting_access_token_for(account)` decides, in one
 * statement, whether the account is still the attested connection of its workspace's single owner whose POSTONA is
 * active, whether the refresh state is idle and the token is not about to expire -- and only then hands over the
 * current access token of exactly that account (supabase/candidates/postona_x_identity_credential/001_*.sql).
 *
 * Server only: `query` is the trusted owner channel (the reservation / single-post server's database connection, never
 * a client and never PostgREST). Granting the SQL function to the worker's role is a separate, coordinated step.
 * No token is stored, logged, returned in an error or put anywhere but the return value of accessTokenFor / credentialFor.
 *
 * credentialFor (F3 PR #278's generation-bound port, G1-G5) answers { token, generation } from ONE statement:
 * `public.x_posting_credential_for(account)` (003) reads G4's decision, the token and F3's own
 * postona_x_resv.x_credential_generation(account) (64 lowercase hex) in one snapshot -- never two getters.
 */

/** The shape F3's publisher consumes (structurally identical to PR #224's XPostingCredentialSource). */
export type XPostingCredentialSource = {
  readonly available: boolean;
  accessTokenFor(socialAccountId: string): Promise<string | null>;
};

/** F3 PR #278's generation-bound credential (structurally identical to x_credential_generation.ts). */
export type XGenerationCredential = { token: string; generation: string };

/** G4's port: F3's token-only source (PR #224 worker) and F3's generation-bound source (PR #278 single post). */
export type XPostingCredentialPort = XPostingCredentialSource & {
  credentialFor(socialAccountId: string): Promise<XGenerationCredential | null>;
};

/** One parameterized statement on the trusted owner channel; rows as plain objects. */
export type OwnerQuery = (sql: string, params: readonly unknown[]) => Promise<ReadonlyArray<Record<string, unknown>>>;

export const X_POSTING_CREDENTIAL_SOURCE_ENABLED = false;

const ACCOUNT_ID_RE = /^[a-z][a-z0-9_]{1,80}$/u;
const TOKEN_RE = /^[\x21-\x7e]{16,4096}$/u;
const GENERATION_RE = /^[0-9a-f]{64}$/u;

/** A fixed error: the database could not be asked. It never carries the cause (a driver message could quote data). */
export class XCredentialSourceUnavailable extends Error {
  constructor() {
    super("X_CREDENTIAL_SOURCE_UNAVAILABLE");
    this.name = "XCredentialSourceUnavailable";
  }
}

export function createXPostingCredentialSource(deps: { query: OwnerQuery; enabled?: boolean }): XPostingCredentialPort {
  const available = (deps.enabled ?? X_POSTING_CREDENTIAL_SOURCE_ENABLED) === true;
  const ask = async (sql: string, socialAccountId: string): Promise<Record<string, unknown> | null> => {
    let rows: ReadonlyArray<Record<string, unknown>>;
    try {
      rows = await deps.query(sql, [socialAccountId]);
    } catch {
      throw new XCredentialSourceUnavailable();
    }
    return Array.isArray(rows) && rows.length === 1 && typeof rows[0] === "object" && rows[0] !== null ? rows[0] : null;
  };
  return Object.freeze({
    available,
    async accessTokenFor(socialAccountId: string): Promise<string | null> {
      if (!available || typeof socialAccountId !== "string" || !ACCOUNT_ID_RE.test(socialAccountId)) return null;
      const token = (await ask("select public.x_posting_access_token_for($1) as token", socialAccountId))?.token;
      return typeof token === "string" && TOKEN_RE.test(token) ? token : null;
    },
    async credentialFor(socialAccountId: string): Promise<XGenerationCredential | null> {
      if (!available || typeof socialAccountId !== "string" || !ACCOUNT_ID_RE.test(socialAccountId)) return null;
      const row = await ask("select token, generation from public.x_posting_credential_for($1)", socialAccountId);
      const token = row?.token;
      const generation = row?.generation;
      return typeof token === "string" && TOKEN_RE.test(token) && typeof generation === "string" && GENERATION_RE.test(generation)
        ? { token, generation }
        : null;
    },
  });
}
