// POSTONA Phase 2b — the typed boundary between a future Threads connect Edge Function and the candidate
// database functions (supabase/candidates/postona_threads_oauth_workspace_candidate.sql), plus the T10
// provider-cleanup result contract. Pure and unwired: nothing imports it, it makes no request, and the
// RPCs it describes are not granted to anyone (see the candidate). Shared contract:
// docs/postona/threads-g5-t9-t10-t13-shared-contract-20261010.md.

// --- RPCs (names and payloads exactly as the candidate defines them) --------------------------------------

export const THREADS_CONNECT_RPC = Object.freeze({
  begin: "begin_social_mobile_threads_oauth_connection",
  consume: "consume_social_mobile_threads_oauth_state",
  complete: "complete_social_mobile_threads_oauth_connection",
});

/** A state lives at most this long (the candidate refuses longer). */
export const THREADS_OAUTH_STATE_MAX_TTL_MS = 10 * 60 * 1000;

export class ThreadsConnectRpcInputError extends Error {
  constructor(readonly code: "STATE_HASH_INVALID" | "REDIRECT_URI_INVALID" | "EXPIRY_INVALID" | "STATE_ID_INVALID" | "IDENTITY_INVALID" | "TOKEN_INVALID" | "KEY_INVALID") {
    super(code);
    this.name = "ThreadsConnectRpcInputError";
  }
}

const STATE_HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER_USER_ID = /^[1-9][0-9]{0,31}$/;
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const ACCESS_TOKEN = /^[A-Za-z0-9._|-]{16,4096}$/;

export function beginRpcPayload(input: Readonly<{ stateHash: string; redirectUri: string; expiresAt: Date; now: Date }>):
  Readonly<{ p_state_hash: string; p_redirect_uri: string; p_expires_at: string }> {
  if (!STATE_HASH.test(input.stateHash)) throw new ThreadsConnectRpcInputError("STATE_HASH_INVALID");
  if (!/^https:\/\/[^#*@\s]+$/.test(input.redirectUri) || input.redirectUri.length > 2048) {
    throw new ThreadsConnectRpcInputError("REDIRECT_URI_INVALID");
  }
  const ttl = input.expiresAt.getTime() - input.now.getTime();
  if (!(ttl > 0 && ttl <= THREADS_OAUTH_STATE_MAX_TTL_MS)) throw new ThreadsConnectRpcInputError("EXPIRY_INVALID");
  return { p_state_hash: input.stateHash, p_redirect_uri: input.redirectUri, p_expires_at: input.expiresAt.toISOString() };
}

export function consumeRpcPayload(stateHash: string): Readonly<{ p_state_hash: string }> {
  if (!STATE_HASH.test(stateHash)) throw new ThreadsConnectRpcInputError("STATE_HASH_INVALID");
  return { p_state_hash: stateHash };
}

// --- Server attestation (complete) --------------------------------------------------------------------------

/** Vault secret name the candidate reads; the Edge exchange holds the same key. */
export const THREADS_CONNECT_ATTESTATION_VAULT_NAME = "postona_threads_connect_attestation_v1";
export const THREADS_CONNECT_ATTESTATION_VERSION = "postona-threads-connect-v1";

export type ThreadsConnectAttested = Readonly<{
  oauthStateId: string;
  providerUserId: string;
  handle: string | null;
  accessToken: string;
}>;

function checkAttested(input: ThreadsConnectAttested): void {
  if (!UUID.test(input.oauthStateId)) throw new ThreadsConnectRpcInputError("STATE_ID_INVALID");
  if (!PROVIDER_USER_ID.test(input.providerUserId) || (input.handle !== null && !HANDLE.test(input.handle))) {
    throw new ThreadsConnectRpcInputError("IDENTITY_INVALID");
  }
  if (!ACCESS_TOKEN.test(input.accessToken)) throw new ThreadsConnectRpcInputError("TOKEN_INVALID");
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * HMAC-SHA256 (hex) over: version, state id, provider user id, handle ('' when absent) and the hex
 * SHA-256 of the token, joined by "\n" — exactly what the candidate recomputes. The token itself is
 * never part of the message.
 */
export async function threadsConnectAttestation(key: string, input: ThreadsConnectAttested): Promise<string> {
  if (key.length < 32) throw new ThreadsConnectRpcInputError("KEY_INVALID");
  checkAttested(input);
  const encoder = new TextEncoder();
  const tokenHash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(input.accessToken)));
  const message = [THREADS_CONNECT_ATTESTATION_VERSION, input.oauthStateId, input.providerUserId, input.handle ?? "", tokenHash].join("\n");
  const hmacKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(message)));
}

export async function completeRpcPayload(key: string, input: ThreadsConnectAttested): Promise<
  Readonly<{ p_oauth_state_id: string; p_platform_user_id: string; p_handle: string | null; p_access_token: string; p_attestation: string }>
> {
  const attestation = await threadsConnectAttestation(key, input);
  return {
    p_oauth_state_id: input.oauthStateId,
    p_platform_user_id: input.providerUserId,
    p_handle: input.handle,
    p_access_token: input.accessToken,
    p_attestation: attestation,
  };
}

// --- Refusals the RPCs can return -----------------------------------------------------------------------------

/** From G5's service-write guard (T13; final names are G5's). Any of them: write nothing, ask nothing to retry. */
export const T13_REFUSAL_CODES = Object.freeze([
  "ACCOUNT_LIFECYCLE_AUTH_REQUIRED",
  "ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND",
  "ACCOUNT_DELETION_IN_PROGRESS",
  "ACCOUNT_LOCKED",
  "SERVICE_NOT_REGISTERED",
  "SERVICE_DELETION_IN_PROGRESS",
  "SERVICE_NOT_ACTIVE",
  "ACCOUNT_LIFECYCLE_SERVICE_INVALID",
  "ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE",
] as const);

/** From the candidate itself. */
export const THREADS_CONNECT_RPC_REFUSAL_CODES = Object.freeze([
  "THREADS_OAUTH_STATE_INPUT_INVALID",
  "THREADS_OAUTH_STATE_NOT_CONSUMABLE",
  "THREADS_CONNECT_INPUT_INVALID",
  "THREADS_CONNECT_ATTESTATION_UNAVAILABLE",
  "THREADS_CONNECT_ATTESTATION_INVALID",
  "THREADS_ACCOUNT_NOT_OWNED",
  "THREADS_ACCOUNT_CONFLICT",
  "THREADS_IDENTITY_ACCOUNT_MISMATCH",
  "THREADS_CREDENTIAL_SHAPE_INVALID",
  "THREADS_ACCOUNT_ALREADY_CONNECTED",
  "SOCIAL_MOBILE_WORKSPACE_USER_REQUIRED",
  "SOCIAL_MOBILE_WORKSPACE_CONFLICT",
  "SOCIAL_MOBILE_WORKSPACE_NOT_SELF_SERVICE",
  "SOCIAL_MOBILE_WORKSPACE_SHARED",
  "SOCIAL_MOBILE_WORKSPACE_ROLE_MISMATCH",
  "SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS",
] as const);

// --- T10: provider-aware cleanup results (contract only; G5 owns the lifecycle state machine) ----------------

export const PROVIDER_CLEANUP_RESULTS = Object.freeze([
  "confirmed_remote_revoked", // the provider confirmed the grant is gone (X revoke; never Threads today)
  "local_removed_remote_unverified", // our token and reference are gone and re-read clean; the remote grant may remain
  "reconciliation_required", // an outcome is unknown or partial: an operator / resumable step must finish it
  "blocked", // a precondition refuses cleanup (e.g. a shared secret reference): nothing done
] as const);
export type ProviderCleanupResult = (typeof PROVIDER_CLEANUP_RESULTS)[number];

/** No official Threads endpoint revokes a user token (re-read 2026-10-10). */
export const THREADS_REMOTE_REVOKE_AVAILABLE = false;

export type ThreadsLocalCleanupFacts = Readonly<{
  /** The access secret reference is shared with another row: never delete, never report done. */
  secretSharedWithAnotherRow: boolean;
  /** Vault delete of the access secret: confirmed / failed / outcome unknown (no reply). */
  vaultDelete: "confirmed" | "failed" | "unknown" | "not_needed";
  /** The row's credential reference cleared and publishing off, read back after the write. */
  readBackClean: boolean;
}>;

/**
 * Truthful Threads cleanup result. While no remote revoke exists it can never be
 * confirmed_remote_revoked; a local deletion is reported as local_removed_remote_unverified only when
 * it is confirmed and re-read clean; anything unknown or failed needs reconciliation.
 */
export function classifyThreadsCleanup(facts: ThreadsLocalCleanupFacts): ProviderCleanupResult {
  if (facts.secretSharedWithAnotherRow) return "blocked";
  if (facts.vaultDelete === "failed" || facts.vaultDelete === "unknown" || !facts.readBackClean) return "reconciliation_required";
  return THREADS_REMOTE_REVOKE_AVAILABLE ? "confirmed_remote_revoked" : "local_removed_remote_unverified";
}
