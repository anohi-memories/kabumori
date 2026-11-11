// POSTONA Threads — read-before-rebind recovery (G4-02 #15, H1 #43 P2, Issue #561). SOURCE CANDIDATE, unwired (the connect
// Edge entry stays hard-disabled; production NO_GO).
//
// The deadlock it ends: an attempt is `uncertain` (its publish answer was lost, or the server stopped) and the stored
// credential has expired. Reconcile cannot read (CREDENTIALS_EXPIRED), the send fence refuses the reconnect that would bring
// a new credential (002), and disconnect keeps the account while a post may exist (PUBLISH_IN_FLIGHT).
//
// The way out is the person's own reconnect of the SAME Threads user. H5's runtime has just exchanged the code and read /me
// with the new token; BEFORE G4's owner bridge completes the binding, it reads -- GET only -- each open attempt's container
// status with that token and records only FINAL evidence (postona_threads_binding.settle_attempt_before_rebind):
//   PUBLISHED        -> the post exists: `published` (exactly one post with the exact text since the attempt began, read
//                       back with its permalink) or `published_unidentified`
//   ERROR / EXPIRED  -> it can never be published: `failed` CONTAINER_ERROR / CONTAINER_EXPIRED
//   anything else    -> (FINISHED, IN_PROGRESS, a failed / timed-out / foreign read) nothing is recorded; the fence keeps
//                       refusing the reconnect, which the person can try again later
// It never writes to Threads, never resends, never stores the token, and never turns "unknown" into "not posted". The rules
// are reconcileThreadsAttempt's (supabase/functions/_shared/social/threads_manual_publish.ts), with a token the database did
// not hand out. NOT_VERIFIED on real Threads: whether a token from a NEW grant can read a container made under the old one.

import {
  type FetchLike,
  listRecentThreadsPosts,
  readThreadsContainerStatus,
  readThreadsPublishedPost,
  type ThreadsCredential,
} from "../../functions/_shared/social/threads_publish_contract.ts";

/** One open attempt, as postona_threads_binding.reconnect_recovery_candidates returns it. */
export type RecoveryCandidate = Readonly<{ attemptId: string; containerId: string; createdAt: Date | string; text: string | null }>;

/** Final evidence only. */
export type RecoveryEvidence =
  | Readonly<{ to: "published"; providerPostId: string; permalink: string }>
  | Readonly<{ to: "published_unidentified"; errorCode: "PUBLISHED_POST_AMBIGUOUS" | "PUBLISHED_POST_NOT_FOUND" }>
  | Readonly<{ to: "failed"; errorCode: "CONTAINER_ERROR" | "CONTAINER_EXPIRED" }>;

/**
 * All reads of one recovery share this budget, so the bridge's completion stays inside H5's runtime deadline (8 s);
 * a read cut off by it is a failed read (no evidence).
 */
export const THREADS_RECOVERY_READ_BUDGET_MS = 4_000;

/** A fetch that only ever sends GET, and gives up when the budget is spent. */
export function readOnlyFetch(fetchImpl: FetchLike, deadline: number, now: () => number = Date.now): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") return Promise.reject(new TypeError("recovery reads only"));
    const left = deadline - now();
    if (left <= 0) return Promise.reject(new TypeError("recovery read budget spent"));
    const budget = AbortSignal.timeout(left);
    return fetchImpl(input, { ...init, method: "GET", signal: init?.signal ? AbortSignal.any([init.signal, budget]) : budget });
  };
}

/** The container's own status, read with the new token; null = no final evidence (nothing may be recorded). */
export async function readRecoveryEvidence(fetchImpl: FetchLike, credential: ThreadsCredential, c: RecoveryCandidate): Promise<RecoveryEvidence | null> {
  let status: string;
  try {
    status = (await readThreadsContainerStatus(fetchImpl, credential, c.containerId)).status;
  } catch {
    return null;
  }
  if (status === "error") return { to: "failed", errorCode: "CONTAINER_ERROR" };
  if (status === "expired") return { to: "failed", errorCode: "CONTAINER_EXPIRED" };
  if (status !== "published") return null;
  const began = c.createdAt instanceof Date ? c.createdAt.getTime() : Date.parse(c.createdAt);
  let matches: string[] = [];
  let permalink: string | null = null;
  try {
    if (!Number.isFinite(began)) throw new TypeError("no start time");
    const posts = await listRecentThreadsPosts(fetchImpl, credential, Math.floor(began / 1000) - 60);
    const exact = posts.filter((post) => c.text !== null && post.text === c.text);
    matches = exact.map((post) => post.mediaId);
    if (exact.length === 1) permalink = (await readThreadsPublishedPost(fetchImpl, credential, exact[0].mediaId)).permalink;
  } catch {
    matches = [];
  }
  if (matches.length === 1 && permalink !== null) return { to: "published", providerPostId: matches[0], permalink };
  return { to: "published_unidentified", errorCode: matches.length > 1 ? "PUBLISHED_POST_AMBIGUOUS" : "PUBLISHED_POST_NOT_FOUND" };
}
