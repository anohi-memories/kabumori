// POSTONA Threads — the two G4 ports a scheduled (G3) Threads post needs, as thin offline adapters. SOURCE CANDIDATE
// (G4-02, Issue #319): hard-disabled, wired to nothing, no database, no token, no network of its own.
//
// The interface is G3's (Issue #319 coordination from G3 #318; G3 PR #334 threads_dispatch.ts declares the same
// shapes and maps the outcomes): G4 implements, G3 owns the reservation, the dispatcher, the result and the receipt.
//
//   ThreadsCredentialPort.credentialFor(socialAccountId) -> { socialAccountId, threadsUserId, accessToken, generation }
//     | null. The decision, the token and the reservation schema's generation (64 lowercase hex) must come from ONE
//     database statement (as X PR #282 003). That statement does NOT exist (a later SQL task; G3 owns the generation
//     function, G5 the entitlement). This adapter takes exactly one call per lookup and refuses every row it cannot
//     prove is this account's; with no call, an undecided service key, or the gate closed, it answers null.
//   ThreadsSendPort.send(credential, text) -> ThreadsSendOutcome. ONE two-step text publish composed from the existing
//     transport in threads_publish_contract.ts (no new request code): create container -> wait for FINISHED -> publish
//     -> read back. Every step is one request, nothing is retried, an unknown is never turned into "not written":
//       container not written                 -> not_written container  (no post: nothing was created)
//       container unknown                     -> unknown container      (no container id is held: never a post)
//       container ERROR / EXPIRED / not ready / status unreadable
//                                             -> not_written publish    (publish never requested: no post)
//       container already PUBLISHED (not by us) -> unknown publish      (a post may exist; never published again)
//       publish not written                   -> not_written publish
//       publish unknown                       -> unknown publish        (resolved read-only by the owner, never resent)
//       read-back: same id, same owner, permalink -> published confirmed
//       read-back: another id or owner         -> published mismatch
//       read-back fails otherwise              -> published unknown
//     `unknown readback` is not produced: once the publish answered a media id the outcome is `published` with the
//     read-back state, which G3 maps to the same `uncertain`.
//
// Not closed here, and not claimed: G3's preflight runs once before send; the container wait (default up to 3 status
// reads, 3 s apart) sits between that preflight and the publish request, and nothing re-checks the lifecycle in
// between (the manual flow re-releases before every step). Proposed to G3, not implemented: a re-check hook before
// the publish request.
//
// The service key a Threads post is entitled under is G5's decision and is not made: THREADS_POSTING_SERVICE_KEY is
// null, so the credential port is unavailable; `x_autopost` (X) and `kabumori` (the app) are refused, never reused.
import {
  createThreadsTextContainer,
  type FetchLike,
  isThreadsNumericId,
  publishThreadsContainer,
  readThreadsContainerStatus,
  readThreadsPublishedPost,
  ThreadsPublishError,
} from "./threads_publish_contract.ts";

export const THREADS_CREDENTIAL_PORT_ENABLED = false;
export const THREADS_SEND_PORT_ENABLED = false;
/** G5 decides. Until then no Threads credential is handed to a scheduled post. */
export const THREADS_POSTING_SERVICE_KEY: string | null = null;
const REFUSED_SERVICE_KEYS: ReadonlySet<string> = new Set(["x_autopost", "kabumori"]);

// ---- types (structurally identical to G3's declarations in threads_dispatch.ts) --------------------------------

export type ThreadsGenerationCredential = Readonly<{
  socialAccountId: string;
  threadsUserId: string;
  accessToken: string;
  /** 64 lowercase hex, from the reservation schema's generation function, in the same statement as the token. */
  generation: string;
}>;
export type ThreadsCredentialPort = {
  readonly available: boolean;
  credentialFor(socialAccountId: string): Promise<ThreadsGenerationCredential | null>;
};
export type ThreadsSendStage = "container" | "publish" | "readback";
export type ThreadsSendOutcome =
  | { kind: "published"; mediaId: string; readBack: "confirmed" | "unknown" | "mismatch" }
  | { kind: "not_written"; stage: "container" | "publish"; code: string }
  | { kind: "unknown"; stage: ThreadsSendStage; code: string };
export type ThreadsSendPort = {
  readonly available: boolean;
  readonly transport: "threads" | "simulated";
  send(credential: Readonly<{ threadsUserId: string; accessToken: string }>, text: string): Promise<ThreadsSendOutcome>;
};

// ---- credential port --------------------------------------------------------------------------------------------

/**
 * The ONE database call that would return the decision, the token and the generation together (not implemented; a
 * later SQL task). It answers the row for this account under this service key, or null.
 */
export type ThreadsCredentialStatement = (socialAccountId: string, serviceKey: string) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GENERATION = /^[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z0-9._|-]{16,4096}$/u;
const ROW_KEYS = "access_token,generation,social_account_id,threads_user_id";

export function acceptableServiceKey(key: string | null): key is string {
  return typeof key === "string" && /^[a-z][a-z0-9_]{2,62}$/u.test(key) && !REFUSED_SERVICE_KEYS.has(key);
}

/** The row of exactly this account, or null. A list must hold exactly one row; unknown or missing columns refuse. */
export function parseThreadsCredentialRow(requestedAccountId: string, answer: unknown): ThreadsGenerationCredential | null {
  const row = Array.isArray(answer) ? (answer.length === 1 ? answer[0] : null) : answer;
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== ROW_KEYS) return null;
  if (r.social_account_id !== requestedAccountId) return null;
  if (!isThreadsNumericId(r.threads_user_id)) return null;
  if (typeof r.access_token !== "string" || !TOKEN.test(r.access_token)) return null;
  if (typeof r.generation !== "string" || !GENERATION.test(r.generation)) return null;
  return Object.freeze({
    socialAccountId: requestedAccountId,
    threadsUserId: r.threads_user_id,
    accessToken: r.access_token,
    generation: r.generation,
  });
}

/** Fail-closed: closed gate, undecided or reused service key, or no statement -> unavailable, always null. */
export function createGatedThreadsCredentialPort(
  enabled: boolean,
  serviceKey: string | null,
  statement: ThreadsCredentialStatement | null,
): ThreadsCredentialPort {
  const available = enabled && acceptableServiceKey(serviceKey) && typeof statement === "function";
  return Object.freeze({
    available,
    async credentialFor(socialAccountId: string): Promise<ThreadsGenerationCredential | null> {
      if (!available || !UUID.test(socialAccountId)) return null;
      try {
        // One call per lookup, nothing cached: an owner change or a newer credential is the statement's answer.
        return parseThreadsCredentialRow(socialAccountId, await statement!(socialAccountId, serviceKey as string));
      } catch {
        return null;
      }
    },
  });
}

/** The deployable credential port: closed (gate false, service key undecided, no statement exists). */
export function createThreadsCredentialPort(statement: ThreadsCredentialStatement | null = null): ThreadsCredentialPort {
  return createGatedThreadsCredentialPort(THREADS_CREDENTIAL_PORT_ENABLED, THREADS_POSTING_SERVICE_KEY, statement);
}

// ---- send port --------------------------------------------------------------------------------------------------

export type ThreadsSendOptions = Readonly<{
  /** Container status reads before giving up (no publish). Default 3. */
  containerChecks?: number;
  containerCheckDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}>;

const codeOf = (error: unknown) => (error instanceof ThreadsPublishError ? error.code : "THREADS_UNAVAILABLE");
const writtenOf = (error: unknown) => (error instanceof ThreadsPublishError ? error.outcome : "unknown");

/** One two-step publish. Never throws, never retries, never logs. */
async function sendOnce(
  fetchImpl: FetchLike,
  credential: Readonly<{ threadsUserId: string; accessToken: string }>,
  text: string,
  options: ThreadsSendOptions,
): Promise<ThreadsSendOutcome> {
  const cred = { threadsUserId: credential?.threadsUserId, accessToken: credential?.accessToken };
  let containerId: string;
  try {
    containerId = (await createThreadsTextContainer(fetchImpl, cred, text)).containerId;
  } catch (error) {
    return writtenOf(error) === "not_written"
      ? { kind: "not_written", stage: "container", code: codeOf(error) }
      : { kind: "unknown", stage: "container", code: codeOf(error) };
  }

  const checks = Math.min(10, Math.max(1, Math.trunc(options.containerChecks ?? 3)));
  const delay = Math.max(0, options.containerCheckDelayMs ?? 3000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let ready = false;
  for (let check = 0; check < checks && !ready; check += 1) {
    if (check > 0) await sleep(delay);
    let status: string;
    try {
      status = (await readThreadsContainerStatus(fetchImpl, cred, containerId)).status;
    } catch {
      return { kind: "not_written", stage: "publish", code: "THREADS_CONTAINER_STATUS_UNREADABLE" };
    }
    if (status === "error") return { kind: "not_written", stage: "publish", code: "THREADS_CONTAINER_ERROR" };
    if (status === "expired") return { kind: "not_written", stage: "publish", code: "THREADS_CONTAINER_EXPIRED" };
    if (status === "published") return { kind: "unknown", stage: "publish", code: "THREADS_CONTAINER_ALREADY_PUBLISHED" };
    ready = status === "finished";
  }
  if (!ready) return { kind: "not_written", stage: "publish", code: "THREADS_CONTAINER_NOT_READY" };

  let mediaId: string;
  try {
    mediaId = (await publishThreadsContainer(fetchImpl, cred, containerId)).mediaId;
  } catch (error) {
    return writtenOf(error) === "not_written"
      ? { kind: "not_written", stage: "publish", code: codeOf(error) }
      : { kind: "unknown", stage: "publish", code: codeOf(error) };
  }

  try {
    await readThreadsPublishedPost(fetchImpl, cred, mediaId);
    return { kind: "published", mediaId, readBack: "confirmed" };
  } catch (error) {
    const mismatch = error instanceof ThreadsPublishError && error.code === "THREADS_IDENTITY_MISMATCH";
    return { kind: "published", mediaId, readBack: mismatch ? "mismatch" : "unknown" };
  }
}

/**
 * `transport` is what the port declares to G3: 'threads' only for the deployable port over the real network;
 * every test or mock port is 'simulated'. A closed port sends nothing and answers not_written at the container step.
 */
export function createGatedThreadsSendPort(
  enabled: boolean,
  transport: "threads" | "simulated",
  fetchImpl: FetchLike,
  options: ThreadsSendOptions = {},
): ThreadsSendPort {
  const available = enabled && typeof fetchImpl === "function" && (transport === "threads" || transport === "simulated");
  return Object.freeze({
    available,
    transport: transport === "threads" ? "threads" : "simulated",
    async send(credential: Readonly<{ threadsUserId: string; accessToken: string }>, text: string): Promise<ThreadsSendOutcome> {
      if (!available) return { kind: "not_written", stage: "container", code: "THREADS_SEND_DISABLED" };
      try {
        return await sendOnce(fetchImpl, credential, text, options);
      } catch {
        // Unreachable by construction (every step catches); if it ever happens a write may have occurred.
        return { kind: "unknown", stage: "publish", code: "THREADS_UNAVAILABLE" };
      }
    },
  });
}

/** The deployable send port: the real network, closed while THREADS_SEND_PORT_ENABLED is false. */
export function createThreadsSendPort(fetchImpl: FetchLike = fetch, options: ThreadsSendOptions = {}): ThreadsSendPort {
  return createGatedThreadsSendPort(THREADS_SEND_PORT_ENABLED, "threads", fetchImpl, options);
}
