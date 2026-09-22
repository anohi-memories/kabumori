/**
 * Production-shaped, server-internal boundary for Phase 18 history learning.
 *
 * The caller must already have resolved the authenticated user's owned,
 * identity-verified X account. This module deliberately accepts only that
 * trusted account binding and an access-token reader; it has no client-facing
 * RPC, refresh-token selector, write capability, or token logging.
 */

export type TrustedHistoryAccountBinding = {
  accountId: string;
  workspaceId: string;
  platform: "x";
  connectionStatus: "identity_verified";
  platformUserId: string;
  accessTokenSecretRef: string;
};

export type HistoryAccessTokenReader = {
  /** Server-only adapter. It must never be exposed to a mobile/public caller. */
  readAccessToken(secretRef: string): Promise<string | null>;
};

export class HistoryAccessTokenReadError extends Error {
  constructor(readonly code: "HISTORY_ACCOUNT_NOT_CONFIGURED" | "HISTORY_ACCESS_TOKEN_UNAVAILABLE") {
    super(code);
    this.name = "HistoryAccessTokenReadError";
  }
}

function assertBinding(binding: TrustedHistoryAccountBinding): void {
  if (
    !binding.accountId.trim() ||
    !binding.workspaceId.trim() ||
    binding.platform !== "x" ||
    binding.connectionStatus !== "identity_verified" ||
    !binding.platformUserId.trim() ||
    !binding.accessTokenSecretRef.trim()
  ) {
    throw new HistoryAccessTokenReadError("HISTORY_ACCOUNT_NOT_CONFIGURED");
  }
}

/**
 * Reads exactly one trusted access-token reference after account verification.
 * No refresh reference or arbitrary secret id can enter this boundary.
 */
export async function readVerifiedHistoryAccessToken(
  binding: TrustedHistoryAccountBinding,
  reader: HistoryAccessTokenReader,
): Promise<string> {
  assertBinding(binding);
  const token = await reader.readAccessToken(binding.accessTokenSecretRef);
  if (typeof token !== "string" || token.length === 0) {
    throw new HistoryAccessTokenReadError("HISTORY_ACCESS_TOKEN_UNAVAILABLE");
  }
  return token;
}
