// POSTONA Threads — read-before-rebind recovery (G4-02 #15 / #16, H1 #43 P2 / H1 #44, Issue #561). SOURCE CANDIDATE, unwired
// (the connect Edge entry stays hard-disabled; production NO_GO).
//
// The deadlock it ends: an attempt is `uncertain` (its publish answer was lost, or the server stopped) and the stored
// credential has expired. Reconcile cannot read (CREDENTIALS_EXPIRED), the send fence refuses the reconnect that would bring
// a new credential (002), and disconnect keeps the account while a post may exist (PUBLISH_IN_FLIGHT).
//
// The way out is the person's own reconnect of the SAME Threads user. H5's runtime has just exchanged the code and read /me
// with the new token; G4's owner bridge reads -- GET only, ONE request per open attempt: its container -- and turns the
// container's own status into final evidence exactly as reconcile does (threads_manual_publish.ts containerStatusEvidence):
//   PUBLISHED        -> `published_unidentified` (a post exists; G4-02 #16 / H1 #44 P2-1: which post is not provable, so no
//                       post id and no permalink are ever attributed -- no listing, no text match)
//   ERROR / EXPIRED  -> `failed` CONTAINER_ERROR / CONTAINER_EXPIRED (it can never be published)
//   anything else    -> (FINISHED, IN_PROGRESS, a failed / timed-out / foreign read) nothing; the fence keeps refusing
// The evidence is written in the SAME transaction as the normal completion, after its claimed-state check and before its
// G5 generation / session checks and the binding write (G4-02 #16 / H1 #44 P3): if the completion refuses, the evidence is
// rolled back with it. It never writes to Threads, never resends, never stores the token. NOT_VERIFIED on real Threads:
// whether a token from a NEW grant can read a container made under the old one.

import { type FetchLike, readThreadsContainerStatus, type ThreadsCredential } from "../../functions/_shared/social/threads_publish_contract.ts";
import { containerStatusEvidence } from "../../functions/_shared/social/threads_manual_publish.ts";

/** One open attempt, as postona_threads_binding.reconnect_recovery_candidates returns it. */
export type RecoveryCandidate = Readonly<{ attemptId: string; containerId: string }>;

/** Final evidence only (never a post id). */
export type RecoveryEvidence = NonNullable<ReturnType<typeof containerStatusEvidence>>;

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
  try {
    return containerStatusEvidence((await readThreadsContainerStatus(fetchImpl, credential, c.containerId)).status);
  } catch {
    return null;
  }
}
