/**
 * Production-shaped, server-internal boundary for Phase 18 history learning.
 *
 * The caller must already have resolved the authenticated user's owned,
 * identity-verified X account. The candidate RPC repeats the owner/account
 * checks in the database before reading the access secret. This module has no
 * refresh-token selector, generic secret lookup, write capability, or logging.
 */

export type TrustedHistoryAccountBinding = {
  authUserId: string;
  accountId: string;
  workspaceId: string;
  platform: "x";
  connectionStatus: "identity_verified";
  platformUserId: string;
};

export type HistoryAccessTokenReader = {
  /** Server-only RPC adapter. It must never be exposed to a mobile/public caller. */
  readAccessToken(binding: TrustedHistoryAccountBinding): Promise<string | null>;
};

export type HistoryAccessTokenRpcConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
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
    !binding.authUserId.trim() ||
    !binding.workspaceId.trim() ||
    binding.platform !== "x" ||
    binding.connectionStatus !== "identity_verified" ||
    !binding.platformUserId.trim()
  ) {
    throw new HistoryAccessTokenReadError("HISTORY_ACCOUNT_NOT_CONFIGURED");
  }
}

/**
 * Reads the access token for the already-resolved identity. The RPC accepts
 * only the trusted user/account ids and independently rechecks ownership; no
 * Vault reference (access or refresh) is accepted from this layer.
 */
export async function readVerifiedHistoryAccessToken(
  binding: TrustedHistoryAccountBinding,
  reader: HistoryAccessTokenReader,
): Promise<string> {
  assertBinding(binding);
  const token = await reader.readAccessToken(binding);
  if (typeof token !== "string" || token.length === 0) {
    throw new HistoryAccessTokenReadError("HISTORY_ACCESS_TOKEN_UNAVAILABLE");
  }
  return token;
}

/**
 * Source-only server adapter for the dedicated service_role-only RPC.
 * Callers provide a verified binding, never a Vault secret reference.
 */
export function createHistoryAccessTokenRpcReader({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}: HistoryAccessTokenRpcConfig): HistoryAccessTokenReader {
  const endpoint = `${supabaseUrl.replace(/\/$/u, "")}/rest/v1/rpc/read_social_mobile_history_access_token`;
  return {
    async readAccessToken(binding) {
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
            p_user_id: binding.authUserId,
            p_social_account_id: binding.accountId,
          }),
        });
      } catch {
        return null;
      }
      if (!response.ok) return null;
      try {
        const token: unknown = await response.json();
        return typeof token === "string" && token.length > 0 ? token : null;
      } catch {
        return null;
      }
    },
  };
}
