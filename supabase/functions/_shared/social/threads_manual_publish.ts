// POSTONA Threads — ONE user-initiated text post, end to end, with every authority decision in the
// database and every provider call through threads_publish_contract.ts.
//
// SOURCE CANDIDATE. Unwired: the only caller is the hard-disabled Edge source
// supabase/functions/social-mobile-threads-publish/, whose static gate is false.
//
// The flow for one attempt (one tap, one idempotency key, one exact text):
//
//   begin (caller JWT)      reserve the attempt: verified caller, active POSTONA service, owner/admin of
//                           the account's workspace, a verified Threads account, the per-account manual
//                           publish permission, the exact text stored. Replays of the same key return
//                           the same attempt; at most one open attempt per account.
//   release (caller JWT +   immediately before EACH provider call, ONE database transaction re-decides
//   server attestation)     everything (G5 lifecycle fence, the caller's Auth session, workspace,
//                           membership, account, credential expiry, manual permission), moves the attempt
//                           with a compare-and-set and only then hands this account's credential to the
//                           server, with a record grant bound to the same user and session. A signed-in
//                           client can call it but cannot attest, so it never obtains a token
//                           (threads_publish_release_candidate.sql; the K4 P1 fix).
//   provider call           exactly one request (threads_publish_contract.ts).
//   record (caller JWT +    the provider's answer, bound to the grant, the same user and session, attested
//   server attestation)     over the exact result, through a fixed transition table. An unknown publish
//                           outcome is recorded as `uncertain`, never resent.
//
// Not closed, and not claimed: between the release commit and the HTTP request (milliseconds, at most
// the 10 s request bound) a lifecycle change cannot stop a request already released. Every LATER write
// needs a new release.
//
// The send onset (G4-02 #13, H1 #41 P2) is the publish release's COMMIT. From then the database refuses a
// reconnect / re-bind of the account (candidate postona_g4_threads_manual_publish_verdict/002's send fence) while
// the attempt is `publishing` or `uncertain`, so the one publish request is ordered before any new connection.
// G4-02 #14 (H1 #42 P2): no clock ends that lease. It ends only when this server records its answer for the
// request (publish_returned / failed), or when the read-only reconcile records the provider's own final container
// status (PUBLISHED -> published*, ERROR / EXPIRED -> failed). The database turning an abandoned `publishing` into
// `uncertain` (THREADS_STALE_IN_FLIGHT_SECONDS) keeps it. This server also starts that request within
// THREADS_PUBLISH_SEND_START_WINDOW_MS of asking for the release (or records that nothing was sent), and the
// request is bounded at 10 s: that keeps a send from going out stale and the lease short, and is checked on this
// server's own clocks only; the fence does not rely on it. A disconnect / stop / G5 end is not fenced: it never
// resumes a send, and a send already leased is ordered before it.
//
// Statuses (THREADS_ATTEMPT_STATUSES): reserved -> creating_container -> container_created -> publishing
// -> publish_returned -> published, plus failed / uncertain / published_unidentified. Only `published`
// (read back with a permalink, same id, same owner) and `published_unidentified` (the provider's own
// container status says PUBLISHED) mean a post exists. `publish_returned` is what the provider SAID and
// is shown as "confirming", never as success.
//
// Why a lost container answer is a failure and not uncertain: without the container id nothing can
// publish it, and we never send auto_publish_text, so no post can exist from that attempt.

import {
  checkThreadsText,
  createThreadsTextContainer,
  type FetchLike,
  publishThreadsContainer,
  readThreadsContainerStatus,
  readThreadsPublishedPost,
  type ThreadsContainerStatus,
  type ThreadsCredential,
  ThreadsPublishError,
  type ThreadsPublishErrorCode,
} from "./threads_publish_contract.ts";

// --- Attempt model (mirrored by the SQL candidate's CHECK and transition rules) ---------------------------

export const THREADS_ATTEMPT_STATUSES = [
  "reserved",
  "creating_container",
  "container_created",
  "publishing",
  "publish_returned",
  "published",
  "published_unidentified",
  "failed",
  "uncertain",
] as const;
export type ThreadsAttemptStatus = (typeof THREADS_ATTEMPT_STATUSES)[number];

export const THREADS_TERMINAL_STATUSES: ReadonlySet<ThreadsAttemptStatus> = new Set(["published", "published_unidentified", "failed"]);

/** The steps a release can be made for, and the status each must find (the database enforces the same). */
export const THREADS_CLAIM_STEPS = ["create_container", "check_container", "publish", "confirm", "reconcile"] as const;
export type ThreadsClaimStep = (typeof THREADS_CLAIM_STEPS)[number];

/**
 * What a release requires and does: the status the attempt must be in, and the in-flight status a write
 * step moves it to (null: a read step, no move). A write step's release is a compare-and-set, so two
 * requests can never both send the same write.
 */
export const THREADS_CLAIM_RULES: Readonly<Record<ThreadsClaimStep, Readonly<{ from: ThreadsAttemptStatus; to: ThreadsAttemptStatus | null }>>> = Object.freeze({
  create_container: { from: "reserved", to: "creating_container" },
  check_container: { from: "container_created", to: null },
  publish: { from: "container_created", to: "publishing" },
  confirm: { from: "publish_returned", to: null },
  reconcile: { from: "uncertain", to: null },
});

/**
 * Steps that lead to a post need the per-account manual publish permission at release time.
 * The read-backs after a publish (confirm, reconcile) do not: withdrawing the permission must not stop
 * the person from learning whether their post went out.
 */
export const THREADS_PERMISSION_STEPS: ReadonlySet<ThreadsClaimStep> = new Set(["create_container", "check_container", "publish"]);

/**
 * An in-flight write abandoned (the server died between release and record) is settled by a reconcile
 * release once it is this old: `creating_container` -> failed STEP_INTERRUPTED (no container id was ever
 * recorded, so nothing can be published from it); `publishing` -> uncertain STEP_INTERRUPTED, then the
 * normal read-only reconciliation.
 */
export const THREADS_STALE_IN_FLIGHT_SECONDS = 120;

/**
 * G4-02 #13: the publish request must start within this long of asking for its release, measured on both the
 * monotonic clock and `deps.now()` (a clock that moved backwards also refuses). Otherwise nothing is sent and
 * the attempt is recorded `failed` STEP_INTERRUPTED (no post can exist: the container was never published).
 * G4-02 #14: both are this server's own clocks, compared only with themselves. The database's send lease is not a
 * duration (see the header), so no comparison with the database's clock is needed or made.
 */
export const THREADS_PUBLISH_SEND_START_WINDOW_MS = 30_000;
export const THREADS_PUBLISH_REQUEST_BOUND_MS = 10_000;
export const THREADS_ATTEMPT_MAX_AGE_SECONDS = 15 * 60;

/**
 * Every result a server may record, as [step, from status, to status]. Nothing else is accepted; in
 * particular nothing ever moves back to `reserved` or `container_created` (no resend), and a terminal
 * status never changes.
 */
export const THREADS_RECORD_TRANSITIONS: ReadonlyArray<readonly [ThreadsClaimStep, ThreadsAttemptStatus, ThreadsAttemptStatus]> = [
  ["create_container", "creating_container", "container_created"],
  ["create_container", "creating_container", "failed"],
  ["check_container", "container_created", "failed"],
  ["publish", "publishing", "publish_returned"],
  ["publish", "publishing", "failed"],
  ["publish", "publishing", "uncertain"],
  ["confirm", "publish_returned", "published"],
  ["reconcile", "uncertain", "published"],
  ["reconcile", "uncertain", "published_unidentified"],
  ["reconcile", "uncertain", "failed"],
  ["reconcile", "uncertain", "uncertain"], // still unknown: only the reason is updated
];

/** A store decision the caller can act on. Codes are fixed; nothing else crosses this boundary. */
export const THREADS_STORE_REFUSALS = [
  "AUTH_REQUIRED",
  "REQUEST_INVALID",
  "TEXT_INVALID",
  "ACCOUNT_NOT_FOUND", // missing, or the caller has no membership (indistinguishable on purpose)
  "PUBLISH_FORBIDDEN", // a member, but not the workspace owner/admin
  "WORKSPACE_INACTIVE", // not the person's own self-service POSTONA workspace, or its owner is ambiguous (F5 WORKSPACE_OWNER_UNKNOWN; automatic-publishing flags are not read)
  "SERVICE_NOT_ACTIVE", // G5 lifecycle: the caller's (T13) or the workspace owner's (F5) POSTONA not registered / ended / suspended
  "ACCOUNT_LIFECYCLE_BLOCKED", // G5 lifecycle (caller or workspace owner): deletion in progress, locked, or the fence unavailable
  "PLATFORM_NOT_SUPPORTED",
  "CONNECTION_NOT_VERIFIED",
  "CREDENTIALS_MISSING",
  "CREDENTIALS_EXPIRED", // the token's expiry is unknown, past, or within 5 minutes (custody owner's reader)
  "MANUAL_PUBLISH_NOT_PERMITTED",
  "PUBLISH_IN_PROGRESS", // another open attempt exists for this account
  "IDEMPOTENCY_CONFLICT", // the same key was used for different text
  "ATTEMPT_NOT_FOUND",
  "ATTEMPT_EXPIRED", // too old to continue to a publish; nothing was published
  "STALE_STEP", // the attempt is no longer in the status this step needs
  "GRANT_INVALID",
  "ATTESTATION_INVALID", // the server's own attestation was refused (key mismatch, replay, stale): a server fault
  "BUSY",
  "STORE_UNAVAILABLE",
] as const;
export type ThreadsStoreRefusal = (typeof THREADS_STORE_REFUSALS)[number];

export class ThreadsStoreError extends Error {
  constructor(readonly code: ThreadsStoreRefusal) {
    super(code);
    this.name = "ThreadsStoreError";
  }
}

/** What the database says about one attempt. Never carries a credential. */
export type ThreadsAttempt = Readonly<{
  attemptId: string;
  socialAccountId: string;
  status: ThreadsAttemptStatus;
  containerId: string | null;
  providerPostId: string | null;
  permalink: string | null;
  errorCode: string | null;
  /** True when this begin call returned an attempt that already existed for the same key and text. */
  replayed: boolean;
  createdAt: string;
}>;

/** Every error code an attempt can carry: the provider's fixed codes plus the flow's own. */
export const THREADS_ATTEMPT_ERROR_CODES = [
  "THREADS_REQUEST_INVALID",
  "THREADS_TOKEN_INVALID",
  "THREADS_PERMISSION_MISSING",
  "THREADS_RATE_LIMITED",
  "THREADS_REQUEST_REJECTED",
  "THREADS_UNAVAILABLE",
  "THREADS_RESPONSE_MALFORMED",
  "THREADS_IDENTITY_MISMATCH",
  "CONTAINER_OUTCOME_UNKNOWN", // no container id came back: nothing can have been published
  "CONTAINER_ERROR",
  "CONTAINER_EXPIRED",
  "STORED_TEXT_MISSING",
  "STORED_CONTAINER_MISSING",
  "PUBLISH_OUTCOME_UNKNOWN",
  "RECONCILE_CONTAINER_UNKNOWN",
  "PUBLISHED_POST_AMBIGUOUS",
  "PUBLISHED_POST_NOT_FOUND",
  "ATTEMPT_EXPIRED", // set by the database: too old to continue, nothing was published
  "STEP_INTERRUPTED", // set by the database: an in-flight step was abandoned (see the SQL candidate); or by the server: the publish request was not started inside its window, nothing was sent (G4-02 #13)
  "AUTHORIZATION_CHANGED", // set by the database: the connection changed after begin (G4-02 #12 candidate 002); nothing more was sent
] as const;
export type ThreadsAttemptErrorCode = (typeof THREADS_ATTEMPT_ERROR_CODES)[number];

/** What one release hands to the server: the record grant, the credential and that step's stored inputs. */
export type ThreadsReleasedStep = Readonly<{
  grant: string;
  credential: ThreadsCredential;
  /** The stored text (create_container, and reconcile to find the post by its exact text). */
  text: string | null;
  containerId: string | null;
  providerPostId: string | null;
  /** When the attempt was reserved; reconciliation only looks for posts after it. */
  attemptCreatedAt: string;
}>;

export type ThreadsStepResult =
  | Readonly<{ to: "container_created"; containerId: string }>
  | Readonly<{ to: "publish_returned"; providerPostId: string }>
  | Readonly<{ to: "published"; providerPostId: string; permalink: string }>
  | Readonly<{ to: "published_unidentified"; errorCode: ThreadsAttemptErrorCode }>
  | Readonly<{ to: "failed"; errorCode: ThreadsAttemptErrorCode }>
  | Readonly<{ to: "uncertain"; errorCode: ThreadsAttemptErrorCode }>;

/** A caller whose bearer token the Auth server has just confirmed. The token is forwarded, never decoded. */
export type VerifiedCaller = Readonly<{ userId: string; bearerToken: string }>;

/**
 * The database boundary (SQL candidates in supabase/candidates/postona_threads_publish/). Everything runs
 * as the CALLER (their JWT: inside the database auth.uid() and the session are the caller's). release and
 * record additionally carry the server's attestation (added by the adapter, never by the app), so only
 * the publish server can obtain a credential or record a result. There is no service_role path.
 */
export interface ThreadsPublishStore {
  begin(caller: VerifiedCaller, input: Readonly<{ socialAccountId: string; idempotencyKey: string; text: string }>): Promise<ThreadsAttempt>;
  release(caller: VerifiedCaller, input: Readonly<{ attemptId: string; step: ThreadsClaimStep }>): Promise<ThreadsReleasedStep>;
  record(caller: VerifiedCaller, input: Readonly<{ attemptId: string; step: ThreadsClaimStep; grant: string; result: ThreadsStepResult }>): Promise<ThreadsAttempt>;
  read(caller: VerifiedCaller, attemptId: string): Promise<ThreadsAttempt>;
}

/** What the account screen needs: the per-account permission and the attempt to show. */
export type ThreadsAccountPublishState = Readonly<{
  socialAccountId: string;
  permitted: boolean;
  /** The one non-terminal attempt, if any (it blocks a new one). */
  openAttempt: ThreadsAttempt | null;
  /** The most recent finished attempt, if any. */
  lastAttempt: ThreadsAttempt | null;
}>;

/**
 * The explicit per-account manual publish permission (caller JWT, owner/admin). Granting needs a verified
 * Threads account and an active POSTONA service; withdrawing is always possible for an owner/admin.
 * `expected` is the value the person saw: a different current value is `stale` and changes nothing.
 */
export interface ThreadsPublishPermissionStore {
  setPermission(caller: VerifiedCaller, input: Readonly<{ socialAccountId: string; desired: boolean; expected: boolean }>):
    Promise<Readonly<{ status: "updated" | "unchanged" | "stale"; permitted: boolean }>>;
  accountState(caller: VerifiedCaller, socialAccountId: string): Promise<ThreadsAccountPublishState>;
}

export type ThreadsManualPublishDeps = Readonly<{
  store: ThreadsPublishStore;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Status checks before publishing (the first is immediate). Text containers are usually ready at once. */
  containerChecks?: number;
  containerCheckDelayMs?: number;
}>;

// --- Public operations -----------------------------------------------------------------------------------

/**
 * Reserve and drive one attempt as far as it can safely go in this request. Returns the attempt as the
 * database last recorded it. Throws ThreadsStoreError for a refusal; provider problems are recorded on
 * the attempt, not thrown.
 */
export async function publishThreadsTextNow(
  deps: ThreadsManualPublishDeps,
  caller: VerifiedCaller,
  input: Readonly<{ socialAccountId: string; idempotencyKey: string; text: string }>,
): Promise<ThreadsAttempt> {
  // The database re-checks the text, but nothing is reserved for a text the provider would refuse.
  if (!checkThreadsText(input.text).ok) throw new ThreadsStoreError("TEXT_INVALID");
  const attempt = await deps.store.begin(caller, input);
  // A replay of an attempt another request is driving (or has finished) is only reported.
  if (attempt.replayed || attempt.status !== "reserved") return attempt;
  return await drive(deps, caller, attempt);
}

/**
 * Continue an attempt the caller explicitly asked to continue: a container that was not ready yet, or a
 * publish whose read-back is still pending. Never re-runs a step that may already have happened.
 */
export async function resumeThreadsAttempt(deps: ThreadsManualPublishDeps, caller: VerifiedCaller, attemptId: string): Promise<ThreadsAttempt> {
  const attempt = await deps.store.read(caller, attemptId);
  if (attempt.status !== "container_created" && attempt.status !== "publish_returned") return attempt;
  return await drive(deps, caller, attempt);
}

/**
 * G4-02 #16 (H1 #44 P2-1): what a container's own status proves, and nothing more. PUBLISHED proves a post exists from that
 * container; it does NOT say which post (the container answer carries no post id, and a listing matched by text, time or
 * "the only one" can pick another post of the same account -- measured by H1 #44). So an attempt whose publish answer never
 * arrived is settled `published_unidentified` (PUBLISHED_POST_NOT_FOUND: no post was attributed) and never gets a post id
 * or a permalink here; a post id is only ever stored from the provider's own publish answer (publish_returned -> confirm).
 * ERROR / EXPIRED prove it can never be published. Anything else (FINISHED, IN_PROGRESS) proves nothing: null.
 */
export function containerStatusEvidence(status: ThreadsContainerStatus):
  | Readonly<{ to: "published_unidentified"; errorCode: "PUBLISHED_POST_NOT_FOUND" }>
  | Readonly<{ to: "failed"; errorCode: "CONTAINER_ERROR" | "CONTAINER_EXPIRED" }>
  | null {
  if (status === "published") return { to: "published_unidentified", errorCode: "PUBLISHED_POST_NOT_FOUND" };
  if (status === "error") return { to: "failed", errorCode: "CONTAINER_ERROR" };
  if (status === "expired") return { to: "failed", errorCode: "CONTAINER_EXPIRED" };
  return null;
}

/**
 * Resolve an uncertain publish read-only: the container's own status decides (containerStatusEvidence). PUBLISHED ->
 * `published_unidentified` (a post exists; which one is not provable); ERROR / EXPIRED -> provably never published;
 * anything else stays uncertain. Never publishes, never lists posts to guess an id.
 */
export async function reconcileThreadsAttempt(deps: ThreadsManualPublishDeps, caller: VerifiedCaller, attemptId: string): Promise<ThreadsAttempt> {
  const attempt = await deps.store.read(caller, attemptId);
  if (attempt.status !== "uncertain" && attempt.status !== "creating_container" && attempt.status !== "publishing") return attempt;
  let redeemed: ThreadsReleasedStep;
  try {
    // For an abandoned in-flight write the database settles it first (see THREADS_STALE_IN_FLIGHT_SECONDS).
    redeemed = await deps.store.release(caller, { attemptId, step: "reconcile" });
  } catch (error) {
    if (error instanceof ThreadsStoreError && error.code === "STALE_STEP") return await deps.store.read(caller, attemptId);
    throw error;
  }
  const record = (result: ThreadsStepResult) => deps.store.record(caller, { attemptId, step: "reconcile", grant: redeemed.grant, result });
  if (redeemed.containerId === null) return await record({ to: "uncertain", errorCode: "RECONCILE_CONTAINER_UNKNOWN" });
  let status: ThreadsContainerStatus;
  try {
    status = (await readThreadsContainerStatus(deps.fetch, redeemed.credential, redeemed.containerId)).status;
  } catch (error) {
    return await record({ to: "uncertain", errorCode: providerCode(error) });
  }
  return await record(containerStatusEvidence(status) ?? { to: "uncertain", errorCode: "PUBLISH_OUTCOME_UNKNOWN" });
}

// --- Internals -------------------------------------------------------------------------------------------

async function drive(deps: ThreadsManualPublishDeps, caller: VerifiedCaller, start: ThreadsAttempt): Promise<ThreadsAttempt> {
  let attempt = start;
  if (attempt.status === "reserved") attempt = await createContainerStep(deps, caller, attempt);
  if (attempt.status === "container_created") attempt = await publishWhenReady(deps, caller, attempt);
  if (attempt.status === "publish_returned") attempt = await confirmStep(deps, caller, attempt);
  return attempt;
}

async function createContainerStep(deps: ThreadsManualPublishDeps, caller: VerifiedCaller, attempt: ThreadsAttempt): Promise<ThreadsAttempt> {
  const redeemed = await deps.store.release(caller, { attemptId: attempt.attemptId, step: "create_container" });
  const record = (result: ThreadsStepResult) =>
    deps.store.record(caller, { attemptId: attempt.attemptId, step: "create_container", grant: redeemed.grant, result });
  if (redeemed.text === null) return await record({ to: "failed", errorCode: "STORED_TEXT_MISSING" });
  try {
    const { containerId } = await createThreadsTextContainer(deps.fetch, redeemed.credential, redeemed.text);
    return await record({ to: "container_created", containerId });
  } catch (error) {
    // Either way no post can exist: a refused container was never made, and a container whose id we
    // never received can never be published by us (and expires unpublished).
    return await record({
      to: "failed",
      errorCode: error instanceof ThreadsPublishError && error.outcome === "not_written" ? error.code : "CONTAINER_OUTCOME_UNKNOWN",
    });
  }
}

async function publishWhenReady(deps: ThreadsManualPublishDeps, caller: VerifiedCaller, attempt: ThreadsAttempt): Promise<ThreadsAttempt> {
  const checks = Math.max(1, deps.containerChecks ?? 3);
  const delay = Math.max(0, deps.containerCheckDelayMs ?? 3000);
  for (let check = 0; check < checks; check += 1) {
    if (check > 0) await deps.sleep(delay);
    const redeemed = await deps.store.release(caller, { attemptId: attempt.attemptId, step: "check_container" });
    let status: ThreadsContainerStatus;
    try {
      status = (await readThreadsContainerStatus(deps.fetch, redeemed.credential, String(redeemed.containerId))).status;
    } catch {
      // A failed status read changes nothing; the person can continue later.
      return attempt;
    }
    if (status === "error" || status === "expired") {
      return await deps.store.record(caller, {
        attemptId: attempt.attemptId,
        step: "check_container",
        grant: redeemed.grant,
        result: { to: "failed", errorCode: status === "error" ? "CONTAINER_ERROR" : "CONTAINER_EXPIRED" },
      });
    }
    // PUBLISHED before we ever claimed publish cannot come from this flow; do not touch it.
    if (status === "published") return attempt;
    if (status === "finished") return await publishStep(deps, caller, attempt);
  }
  return attempt;
}

async function publishStep(deps: ThreadsManualPublishDeps, caller: VerifiedCaller, attempt: ThreadsAttempt): Promise<ThreadsAttempt> {
  const askedAt = { wall: deps.now().getTime(), mono: performance.now() };
  const redeemed = await deps.store.release(caller, { attemptId: attempt.attemptId, step: "publish" });
  const record = (result: ThreadsStepResult) =>
    deps.store.record(caller, { attemptId: attempt.attemptId, step: "publish", grant: redeemed.grant, result });
  if (redeemed.containerId === null) return await record({ to: "uncertain", errorCode: "STORED_CONTAINER_MISSING" });
  // G4-02 #13: only inside the send lease (see THREADS_PUBLISH_SEND_START_WINDOW_MS); checked last, right before the request
  const wall = deps.now().getTime() - askedAt.wall;
  const mono = performance.now() - askedAt.mono;
  if (!(wall >= 0 && wall <= THREADS_PUBLISH_SEND_START_WINDOW_MS && mono <= THREADS_PUBLISH_SEND_START_WINDOW_MS)) {
    return await record({ to: "failed", errorCode: "STEP_INTERRUPTED" });
  }
  try {
    const { mediaId } = await publishThreadsContainer(deps.fetch, redeemed.credential, redeemed.containerId);
    return await record({ to: "publish_returned", providerPostId: mediaId });
  } catch (error) {
    if (error instanceof ThreadsPublishError && error.outcome === "not_written") return await record({ to: "failed", errorCode: error.code });
    // The publish may have happened. Recorded, never resent; reconciliation is read-only.
    return await record({ to: "uncertain", errorCode: providerCode(error) });
  }
}

async function confirmStep(deps: ThreadsManualPublishDeps, caller: VerifiedCaller, attempt: ThreadsAttempt): Promise<ThreadsAttempt> {
  const redeemed = await deps.store.release(caller, { attemptId: attempt.attemptId, step: "confirm" });
  if (redeemed.providerPostId === null) return attempt;
  try {
    const post = await readThreadsPublishedPost(deps.fetch, redeemed.credential, redeemed.providerPostId);
    return await deps.store.record(caller, {
      attemptId: attempt.attemptId,
      step: "confirm",
      grant: redeemed.grant,
      result: { to: "published", providerPostId: post.mediaId, permalink: post.permalink },
    });
  } catch {
    // Not confirmed yet: the attempt stays `publish_returned` (shown as "confirming"), never as success.
    return await deps.store.read(caller, attempt.attemptId);
  }
}

function providerCode(error: unknown): ThreadsPublishErrorCode {
  return error instanceof ThreadsPublishError ? error.code : "THREADS_UNAVAILABLE";
}
