/**
 * Generation-bound X reservation DELIVERY worker (G3 SOURCE CANDIDATE, 2026-10-30, Issue #318 G3-49). Not deployed, wired to nothing.
 *
 * worker.ts's runReservationDelivery hands the publisher a token-only source (accessTokenFor): the token it sends with is read AFTER
 * pre_publish_check and is not tied to any generation, so a token read across a refresh / reconnect could be one the database never
 * checked. This worker closes that, as the Threads dispatcher (threads_dispatch.ts) and the single post (single_post.ts) already do:
 *   1. claim_due (004; 014's trigger pins the account's credential generation on the claimed row);
 *   2. per row, ONE credentialFor(account) -> { token, generation } (G4; xGenerationSourceFromG4Raw derives G3's value from G4's raw one);
 *   3. pre_publish_check_bound (015): 004's pre_publish_check unchanged, and when it answers OK the generation pinned at claim, which
 *      014's row_publishable has just found equal to the current one (G4 verified, the same connection);
 *   4. exactly one X create, only when the token's generation equals that pinned generation, with a one-shot source of that token;
 *   5. finish; any doubt is 'uncertain', never re-sent.
 * Never sent, recorded failed_before_send: no credential (G4 not verified / refresh / disconnected / unknown account / the source threw)
 * -> X_CREDENTIALS_UNAVAILABLE; a token of another generation (a reconnect, A->B->A, a stale source) -> CREDENTIAL_GENERATION_CHANGED.
 * Never sent, the store's answer: NOT_PUBLISHABLE (disconnect / reconnect / owner change / service end between claim and send, recorded
 * by the store), RELEASED (lease expired or too short before send, G5 busy), LEASE_LOST, or an unreadable check (handed back).
 * Nothing here logs; no token reaches the report, a code or an error.
 */
import { CREDENTIAL_GENERATION_RE, oneShotCredentialSource, X_ACCESS_TOKEN_RE, type XGenerationCredential, type XPostingGenerationCredentialSource } from "./x_credential_generation.ts";
import type { XPostingCredentialSource } from "./x_publisher.ts";
import type { ClaimedReservation, FinishOutcome, PrePublishVerdict, PublishResult, ReservationDeliveryStore, ReservationPublisher } from "./worker.ts";

export type BoundPrePublish = { verdict: PrePublishVerdict; credentialGeneration: string | null };

/** The reservation store with 015's bound pre-send check in place of 004's verdict-only one. */
export type BoundReservationDeliveryStore = Omit<ReservationDeliveryStore, "prePublishCheck"> & {
  prePublishCheckBound(reservationId: string, leaseToken: string): Promise<BoundPrePublish>;
};

export type BoundDeliveryReport = {
  claimed: number;
  /** X create calls made (at most one per claimed row). */
  sends: number;
  published: number;
  failedBeforeSend: number;
  uncertain: number;
  skipped: number;
  released: number;
  notAvailable: boolean;
  stopped: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const POST_ID_RE = /^[0-9]{1,30}$/u;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/u;

function safeCode(code: string, fallback: string): string {
  return CODE_RE.test(code) ? code : fallback;
}

export async function runBoundXReservationDelivery(input: {
  store: BoundReservationDeliveryStore;
  credentials: XPostingGenerationCredentialSource;
  /** Builds the X publisher for exactly one send from a one-shot source of the checked token. */
  publisherFor: (source: XPostingCredentialSource) => ReservationPublisher;
  worker: string;
  leaseSeconds?: number;
  limit?: number;
  shouldStop?: () => boolean;
}): Promise<BoundDeliveryReport> {
  const report: BoundDeliveryReport = {
    claimed: 0, sends: 0, published: 0, failedBeforeSend: 0, uncertain: 0, skipped: 0, released: 0, notAvailable: false, stopped: false,
  };
  const handBack = async (item: ClaimedReservation) => {
    let answer = "";
    try {
      answer = await input.store.releaseUnsent(item.reservationId, item.leaseToken);
    } catch {
      answer = "";
    }
    if (answer === "released") report.released += 1;
    else report.skipped += 1;
  };
  // Nothing is claimed unless a generation-bound source exists: a claim that can never be sent only ages into 'uncertain'.
  if (input.credentials?.available !== true || typeof input.credentials.credentialFor !== "function" || typeof input.publisherFor !== "function") {
    report.notAvailable = true;
    return report;
  }
  const claimed = await input.store.claimDue(input.worker, input.leaseSeconds ?? 120, input.limit ?? 10);
  report.claimed = claimed.length;
  for (const [index, item] of claimed.entries()) {
    let stop = false;
    try {
      stop = input.shouldStop?.() === true;
    } catch {
      stop = true;
    }
    if (stop) {
      report.stopped = true;
      for (const rest of claimed.slice(index)) await handBack(rest);
      break;
    }
    if (!UUID_RE.test(item.reservationId) || !UUID_RE.test(item.leaseToken)) {
      report.skipped += 1;
      continue;
    }
    // 2. the token and its generation: one read, before the last check
    let credential: XGenerationCredential | null;
    try {
      credential = await input.credentials.credentialFor(item.socialAccountId);
    } catch {
      credential = null;
    }
    // 3. the last check before X, with the generation pinned at claim
    let checked: BoundPrePublish | null;
    try {
      checked = await input.store.prePublishCheckBound(item.reservationId, item.leaseToken);
    } catch {
      checked = null;
    }
    if (checked === null) {
      credential = null;
      await handBack(item); // nothing was sent
      continue;
    }
    if (checked.verdict === "RELEASED") {
      credential = null;
      report.released += 1;
      continue;
    }
    if (checked.verdict !== "OK") {
      credential = null;
      report.skipped += 1; // NOT_PUBLISHABLE is recorded failed by the store; LEASE_LOST is not ours
      continue;
    }
    // 4. exactly one X create, only with a token of the pinned generation
    let result: PublishResult;
    if (!credential || typeof credential.token !== "string" || !X_ACCESS_TOKEN_RE.test(credential.token)) {
      result = { kind: "rejected_before_send", code: "X_CREDENTIALS_UNAVAILABLE" };
    } else if (typeof checked.credentialGeneration !== "string" || !CREDENTIAL_GENERATION_RE.test(checked.credentialGeneration)
        || credential.generation !== checked.credentialGeneration) {
      result = { kind: "rejected_before_send", code: "CREDENTIAL_GENERATION_CHANGED" };
    } else {
      report.sends += 1;
      try {
        result = await input.publisherFor(oneShotCredentialSource(item.socialAccountId, credential.token)).publish(item.socialAccountId, item.body);
      } catch {
        result = { kind: "unknown", code: "PUBLISHER_THREW" };
      }
    }
    credential = null;
    if (result.kind === "published" && !POST_ID_RE.test(result.providerPostId)) {
      result = { kind: "unknown", code: "PROVIDER_POST_ID_INVALID" };
    }
    // 5. record the outcome; a finish answer that cannot be read is asked once more (idempotent), the provider never again
    const finishOnce = async (outcome: FinishOutcome, providerPostId: string | null, code: string | null) => {
      try {
        return await input.store.finish(item.reservationId, item.leaseToken, outcome, providerPostId, code);
      } catch {
        return await input.store.finish(item.reservationId, item.leaseToken, outcome, providerPostId, code);
      }
    };
    try {
      if (result.kind === "published") {
        const recorded = await finishOnce("published", result.providerPostId, null);
        if (recorded === "published") report.published += 1;
        else report.uncertain += 1;
      } else if (result.kind === "rejected_before_send") {
        const recorded = await finishOnce("failed_before_send", null, safeCode(result.code, "REJECTED_BEFORE_SEND"));
        if (recorded === "failed_before_send") report.failedBeforeSend += 1;
        else report.uncertain += 1;
      } else {
        await finishOnce("uncertain", null, safeCode(result.code, "OUTCOME_UNKNOWN"));
        report.uncertain += 1;
      }
    } catch {
      report.uncertain += 1; // the lease will expire into 'uncertain'; never re-sent
    }
  }
  return report;
}
