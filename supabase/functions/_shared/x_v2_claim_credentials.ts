/**
 * Phase1E exact-account credential resolver for v2 X dispatch (source only;
 * no live caller yet).
 *
 * Invariant: a v2 claimed post may use credentials only for exactly
 * `claim.socialAccountId`. The database RPC derives the account from the open
 * pre-X attempt (attempt id + claim token) and rechecks platform, brand,
 * verification, publish permission and the account's own Vault reference.
 * This module never looks an account up by brand, never picks a first row,
 * never reads the legacy oauth_token_store or env tokens, never uses the AI
 * Lab hardcoded account, and never falls back to another account.
 *
 * Server-only: the service_role key and the returned token must never reach a
 * mobile/admin/browser client. The token is held in a private field and is
 * redacted from JSON/inspect output; errors carry only a fixed code.
 */

export type XV2Claim = {
  attemptId: string;
  claimToken: string;
  socialAccountId: string;
  brandId: string;
};

export const X_CREDENTIAL_ERROR_CODES = [
  "X_CREDENTIAL_REQUEST_INVALID",
  "X_CLAIM_NOT_PRE_X",
  "X_CLAIM_ACCOUNT_MISMATCH",
  "X_CLAIM_NOT_RUNNING",
  "X_ACCOUNT_NOT_FOUND",
  "X_ACCOUNT_NOT_X",
  "X_ACCOUNT_BRAND_MISMATCH",
  "X_ACCOUNT_NOT_VERIFIED",
  "X_ACCOUNT_PUBLISH_DISABLED",
  "X_CREDENTIAL_NOT_CONFIGURED",
  "X_CREDENTIAL_UNAVAILABLE",
  "X_CREDENTIAL_IDENTITY_MISMATCH",
  "X_CREDENTIAL_READ_FAILED",
] as const;
export type XCredentialErrorCode = typeof X_CREDENTIAL_ERROR_CODES[number];

/** Codes where a later retry can succeed without operator action. */
const RETRYABLE_CODES = new Set<XCredentialErrorCode>(["X_CREDENTIAL_READ_FAILED", "X_CLAIM_NOT_RUNNING"]);

export class XCredentialResolutionError extends Error {
  readonly code: XCredentialErrorCode;
  /** Every resolver failure happens before the provider-start boundary. */
  readonly outcome: "pre_x_retryable" | "pre_x_terminal";

  constructor(code: XCredentialErrorCode) {
    super(code);
    this.name = "XCredentialResolutionError";
    this.code = code;
    this.outcome = RETRYABLE_CODES.has(code) ? "pre_x_retryable" : "pre_x_terminal";
  }
}

const REDACTED = "[redacted XAccountCredential]";

/** Credential for one exact X account. The token cannot be serialized. */
export class XAccountCredential {
  readonly socialAccountId: string;
  readonly brandId: string;
  readonly platformUserId: string;
  readonly #accessToken: string;

  constructor(identity: { socialAccountId: string; brandId: string; platformUserId: string }, accessToken: string) {
    this.socialAccountId = identity.socialAccountId;
    this.brandId = identity.brandId;
    this.platformUserId = identity.platformUserId;
    this.#accessToken = accessToken;
  }

  /** The only way to use the token: as a Bearer header for this account. */
  bearerHeader(): string {
    return `Bearer ${this.#accessToken}`;
  }

  toJSON(): Record<string, string> {
    return { socialAccountId: this.socialAccountId, brandId: this.brandId, platformUserId: this.platformUserId };
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.for("Deno.customInspect")](): string {
    return REDACTED;
  }
}

export type XClaimCredentialReader = {
  /** Returns the raw RPC row or throws XCredentialResolutionError. */
  readForClaim(claim: XV2Claim, requirePublishEnabled: boolean): Promise<unknown>;
};

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertClaim(claim: XV2Claim): void {
  if (!claim || !nonBlank(claim.attemptId) || !nonBlank(claim.claimToken) ||
      !nonBlank(claim.socialAccountId) || !nonBlank(claim.brandId)) {
    throw new XCredentialResolutionError("X_CREDENTIAL_REQUEST_INVALID");
  }
}

/**
 * Resolve the credential for exactly the claimed account. The reader is the
 * only secret source; the returned identity must equal the claim or the
 * credential is discarded.
 */
export async function resolveXCredentialForClaim(
  claim: XV2Claim,
  reader: XClaimCredentialReader,
  { requirePublishEnabled = true }: { requirePublishEnabled?: boolean } = {},
): Promise<XAccountCredential> {
  assertClaim(claim);
  const row = await reader.readForClaim(claim, requirePublishEnabled);
  const record = Array.isArray(row) ? row[0] : row;
  if (Array.isArray(row) && row.length !== 1) {
    throw new XCredentialResolutionError("X_CREDENTIAL_UNAVAILABLE");
  }
  if (typeof record !== "object" || record === null) {
    throw new XCredentialResolutionError("X_CREDENTIAL_UNAVAILABLE");
  }
  const { social_account_id, brand_id, platform_user_id, access_token } = record as Record<string, unknown>;
  if (social_account_id !== claim.socialAccountId || brand_id !== claim.brandId) {
    throw new XCredentialResolutionError("X_CLAIM_ACCOUNT_MISMATCH");
  }
  if (!nonBlank(platform_user_id)) throw new XCredentialResolutionError("X_ACCOUNT_NOT_VERIFIED");
  if (!nonBlank(access_token)) throw new XCredentialResolutionError("X_CREDENTIAL_UNAVAILABLE");
  return new XAccountCredential(
    { socialAccountId: social_account_id, brandId: brand_id, platformUserId: platform_user_id },
    access_token,
  );
}

function knownCode(message: unknown): XCredentialErrorCode | null {
  if (typeof message !== "string") return null;
  return (X_CREDENTIAL_ERROR_CODES as readonly string[]).includes(message) ? message as XCredentialErrorCode : null;
}

/**
 * Server adapter for `read_x_publish_credential_for_claim_v2` (service_role
 * only). Error bodies are reduced to a known code; nothing else is surfaced.
 */
export function createXClaimCredentialRpcReader({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): XClaimCredentialReader {
  const endpoint = `${supabaseUrl.replace(/\/$/u, "")}/rest/v1/rpc/read_x_publish_credential_for_claim_v2`;
  return {
    async readForClaim(claim, requirePublishEnabled) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            p_attempt_id: claim.attemptId,
            p_claim_token: claim.claimToken,
            p_social_account_id: claim.socialAccountId,
            p_expected_brand_id: claim.brandId,
            p_require_publish_enabled: requirePublishEnabled,
          }),
        });
      } catch {
        throw new XCredentialResolutionError("X_CREDENTIAL_READ_FAILED");
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new XCredentialResolutionError(response.ok ? "X_CREDENTIAL_UNAVAILABLE" : "X_CREDENTIAL_READ_FAILED");
      }
      if (!response.ok) {
        const code = knownCode((payload as { message?: unknown } | null)?.message);
        throw new XCredentialResolutionError(code ?? "X_CREDENTIAL_READ_FAILED");
      }
      return payload;
    },
  };
}
