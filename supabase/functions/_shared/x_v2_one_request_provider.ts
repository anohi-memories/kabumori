/**
 * Phase1E one-request X provider seam for v2 dispatch (source only; no live
 * caller yet).
 *
 * Contract:
 * - Everything that can fail without creating a post happens BEFORE the
 *   durable provider-start boundary: credential resolution and an identity
 *   check (GET /2/users/me must return the account's own platform_user_id).
 *   A token that X rejects there yields a pre-X outcome; no create is sent.
 * - `markProviderStarted` (the caller's mark_post_provider_started_v2) is
 *   awaited before the create request. If it fails, nothing is sent.
 * - After the boundary exactly one POST /2/tweets is made. There is no token
 *   refresh and no second create on 401 or any other status.
 * - The result is classified explicitly: created / rejected (X answered and
 *   did not create) / uncertain (the post may exist). Response bodies and the
 *   token are never logged or placed in outcome codes.
 *
 * Not compatible with this primitive yet: tip threads (several creates) and
 * morning_greeting (media upload + create). Legacy postToX/postThreadToX,
 * postToXWithRefresh and requestXWithAuthRefresh keep their refresh-and-retry
 * behavior and stay legacy-only.
 */
import {
  resolveXCredentialForClaim,
  XCredentialResolutionError,
  type XAccountCredential,
  type XClaimCredentialReader,
  type XV2Claim,
} from "./x_v2_claim_credentials.ts";

const X_USERS_ME_URL = "https://api.x.com/2/users/me";
const X_CREATE_POST_URL = "https://api.x.com/2/tweets";
const DEFAULT_TIMEOUT_MS = 15_000;

export type XV2ProviderOutcome =
  | { kind: "pre_x_retryable"; code: string; createRequests: 0 }
  | { kind: "pre_x_terminal"; code: string; createRequests: 0 }
  | { kind: "x_created"; xPostId: string; httpStatus: number; createRequests: 1 }
  | { kind: "x_rejected"; code: string; httpStatus: number; createRequests: 1 }
  | { kind: "x_outcome_uncertain"; code: string; httpStatus: number | null; createRequests: 1 };

type ProviderOptions = { fetchImpl?: typeof fetch; timeoutMs?: number };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function dataId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Pre-X: proves the token is accepted and belongs to exactly this account. */
export async function verifyXCredentialIdentityPreX(
  credential: XAccountCredential,
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: ProviderOptions = {},
): Promise<{ kind: "ok" } | Extract<XV2ProviderOutcome, { createRequests: 0 }>> {
  let response: Response;
  try {
    response = await fetchImpl(X_USERS_ME_URL, {
      method: "GET",
      redirect: "manual",
      headers: { Authorization: credential.bearerHeader() },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "pre_x_retryable", code: "X_IDENTITY_CHECK_UNAVAILABLE", createRequests: 0 };
  }
  const body = await readJson(response);
  if (response.status === 401) {
    // Refresh is not allowed on the v2 path; it must happen out of band, pre-X.
    return { kind: "pre_x_retryable", code: "X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X", createRequests: 0 };
  }
  if (response.status === 403) {
    return { kind: "pre_x_terminal", code: "X_IDENTITY_CHECK_FORBIDDEN", createRequests: 0 };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "pre_x_retryable", code: "X_IDENTITY_CHECK_UNAVAILABLE", createRequests: 0 };
  }
  if (dataId(body) !== credential.platformUserId) {
    return { kind: "pre_x_terminal", code: "X_CREDENTIAL_IDENTITY_MISMATCH", createRequests: 0 };
  }
  return { kind: "ok" };
}

function classifyCreateResponse(status: number, body: unknown): XV2ProviderOutcome {
  if (status >= 200 && status < 300) {
    const id = dataId(body);
    return id
      ? { kind: "x_created", xPostId: id, httpStatus: status, createRequests: 1 }
      : { kind: "x_outcome_uncertain", code: "X_CREATE_RESPONSE_MISSING_POST_ID", httpStatus: status, createRequests: 1 };
  }
  // Redirects and unexpected statuses are not proof that X rejected the create.
  if (status < 400 || status === 408 || status >= 500) {
    return { kind: "x_outcome_uncertain", code: `X_CREATE_HTTP_${status}`, httpStatus: status, createRequests: 1 };
  }
  // Other 4xx (including 401 and 429): X answered and did not create.
  return { kind: "x_rejected", code: `X_CREATE_REJECTED_${status}`, httpStatus: status, createRequests: 1 };
}

/**
 * Identity check, durable provider-start mark, then exactly one create.
 * `markProviderStarted` must commit mark_post_provider_started_v2 for the
 * same claim before it resolves.
 */
export async function createXTextPostOnceV2(
  {
    credential,
    text,
    markProviderStarted,
  }: {
    credential: XAccountCredential;
    text: string;
    markProviderStarted: () => Promise<void>;
  },
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: ProviderOptions = {},
): Promise<XV2ProviderOutcome> {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { kind: "pre_x_terminal", code: "X_CREATE_TEXT_EMPTY", createRequests: 0 };
  }
  const identity = await verifyXCredentialIdentityPreX(credential, { fetchImpl, timeoutMs });
  if (identity.kind !== "ok") return identity;

  try {
    await markProviderStarted();
  } catch {
    return { kind: "pre_x_retryable", code: "X_PROVIDER_START_NOT_RECORDED", createRequests: 0 };
  }

  let response: Response;
  try {
    response = await fetchImpl(X_CREATE_POST_URL, {
      method: "POST",
      redirect: "manual",
      headers: { Authorization: credential.bearerHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "x_outcome_uncertain", code: "X_CREATE_NETWORK_UNCERTAIN", httpStatus: null, createRequests: 1 };
  }
  return classifyCreateResponse(response.status, await readJson(response));
}

/**
 * Composition for a future v2 dispatcher: resolve the exact-account credential
 * for the claim, then run the one-request create. A resolver failure returns a
 * pre-X outcome and makes no X request at all.
 */
export async function publishClaimedXTextPostV2(
  {
    claim,
    text,
    reader,
    markProviderStarted,
  }: {
    claim: XV2Claim;
    text: string;
    reader: XClaimCredentialReader;
    markProviderStarted: () => Promise<void>;
  },
  options: ProviderOptions = {},
): Promise<XV2ProviderOutcome> {
  let credential: XAccountCredential;
  try {
    credential = await resolveXCredentialForClaim(claim, reader, { requirePublishEnabled: true });
  } catch (error) {
    if (error instanceof XCredentialResolutionError) {
      return { kind: error.outcome, code: error.code, createRequests: 0 };
    }
    return { kind: "pre_x_retryable", code: "X_CREDENTIAL_READ_FAILED", createRequests: 0 };
  }
  return await createXTextPostOnceV2({ credential, text, markProviderStarted }, options);
}
