/**
 * POSTONA X reservation delivery boundary (G3 source candidate, 2026-10-11). NOT wired to any Edge Function,
 * Cron or live queue, and never fed into the existing brand_post / claim_due_post path.
 *
 * One delivery run:
 *   publisher unavailable -> claim nothing (the production publisher is NOT_AVAILABLE until G5 x_autopost,
 *                            G4 verified X account (Issue #131) and the pre/post write checks are reviewed);
 *   claimDue              -> exclusive leases on due, consented, publishable manual rows (SQL candidate);
 *   prePublishCheck       -> immediately before provider IO, the lease is still ours and the row is still
 *                            publishable (owner, entitlement, verified account, consent bound to text + time);
 *   publish               -> exactly once per lease; never retried by this module;
 *   finish                -> published (with provider post id) | failed_before_send (provably not sent)
 *                            | uncertain (anything else: timeout, unknown response, crash) -- an uncertain row
 *                            is never re-claimed, so X is never posted to twice blindly. A finish after the
 *                            lease deadline answers 'lease_lost' (row fenced to uncertain): never a success.
 * Manual text is sent exactly as stored (no AI generation). AI slots are not claimed in V1.
 *
 * F3 dispatch (2026-10-16, SQL candidate 004): a row this run claimed but did NOT send is handed back to 'planned'
 * instead of aging into 'uncertain' -- when the pre-publish check says RELEASED (G5's fence busy, or the lease ran
 * out before the send), when the check cannot be read (nothing was sent yet), and when the run is asked to stop
 * (shouldStop: graceful shutdown before the next send). A row that MAY have been sent is never handed back.
 */

export type ClaimedReservation = {
  reservationId: string;
  leaseToken: string;
  socialAccountId: string;
  body: string;
};

export type PrePublishVerdict = "OK" | "LEASE_LOST" | "NOT_PUBLISHABLE" | "RELEASED";
export type FinishOutcome = "published" | "failed_before_send" | "uncertain";

/** The reservation store (SQL candidate functions claim_due / pre_publish_check / finish). */
export type ReservationDeliveryStore = {
  claimDue(worker: string, leaseSeconds: number, limit: number): Promise<ClaimedReservation[]>;
  prePublishCheck(reservationId: string, leaseToken: string): Promise<PrePublishVerdict>;
  finish(reservationId: string, leaseToken: string, outcome: FinishOutcome, providerPostId: string | null, code: string | null): Promise<string>;
  /** Hands back a claimed row that was NOT sent: 'released' | 'lease_lost'. */
  releaseUnsent(reservationId: string, leaseToken: string): Promise<string>;
};

/** Provider adapter. `sent: false` only when the provider provably did not accept the post. */
export type PublishResult =
  | { kind: "published"; providerPostId: string }
  | { kind: "rejected_before_send"; code: string }
  | { kind: "unknown"; code: string };

export type ReservationPublisher = {
  readonly available: boolean;
  publish(socialAccountId: string, text: string): Promise<PublishResult>;
};

/** The only production publisher in this candidate: never available, never reaches a provider. */
export const PRODUCTION_PUBLISHER_NOT_AVAILABLE: ReservationPublisher = Object.freeze({
  available: false as const,
  publish(): Promise<PublishResult> {
    return Promise.resolve({ kind: "rejected_before_send" as const, code: "PUBLISHER_NOT_AVAILABLE" });
  },
});

export type DeliveryReport = {
  claimed: number;
  published: number;
  failedBeforeSend: number;
  uncertain: number;
  skipped: number;
  /** Claimed, not sent, handed back to 'planned'. */
  released: number;
  notAvailable: boolean;
  /** The run was asked to stop before it finished its claims. */
  stopped: boolean;
};

const POST_ID_RE = /^[0-9]{1,30}$/u;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/u;

function safeCode(code: string, fallback: string): string {
  return CODE_RE.test(code) ? code : fallback;
}

export async function runReservationDelivery(input: {
  store: ReservationDeliveryStore;
  publisher: ReservationPublisher;
  worker: string;
  leaseSeconds?: number;
  limit?: number;
  /** Checked before each send: true = graceful shutdown (the rest is handed back unsent). */
  shouldStop?: () => boolean;
}): Promise<DeliveryReport> {
  const report: DeliveryReport = {
    claimed: 0, published: 0, failedBeforeSend: 0, uncertain: 0, skipped: 0, released: 0, notAvailable: false, stopped: false,
  };
  // Never sent: try to hand it back; if that cannot be confirmed, the row is only skipped (its lease will expire).
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
  // Nothing is claimed unless a publisher can actually run: a claim without a sender would only age into
  // 'uncertain' rows the user cannot cancel.
  if (input.publisher.available !== true) {
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
    let verdict: PrePublishVerdict | null;
    try {
      verdict = await input.store.prePublishCheck(item.reservationId, item.leaseToken);
    } catch {
      verdict = null; // cannot prove the row is still ours: do not send
    }
    if (verdict === null) {
      await handBack(item); // nothing was sent: hand it back if it is still ours
      continue;
    }
    if (verdict === "RELEASED") {
      report.released += 1; // the store already handed it back (never sent)
      continue;
    }
    if (verdict !== "OK") {
      report.skipped += 1; // NOT_PUBLISHABLE is already recorded as failed by the store; LEASE_LOST is not ours
      continue;
    }
    let result: PublishResult;
    try {
      result = await input.publisher.publish(item.socialAccountId, item.body);
    } catch {
      result = { kind: "unknown", code: "PUBLISHER_THREW" };
    }
    if (result.kind === "published" && !POST_ID_RE.test(result.providerPostId)) {
      result = { kind: "unknown", code: "PROVIDER_POST_ID_INVALID" };
    }
    // Only the outcome the store actually recorded counts. Anything else -- 'lease_lost' (the lease ran out
    // before finish: the store fenced the row to uncertain) or an unexpected answer -- is uncertain.
    // G3-32 C3: a finish whose answer could not be read is asked ONCE more with the same arguments (the store's finish
    // is idempotent for the same lease + the same success; any other repeat answers lease_lost / LEASE_LOST). This only
    // re-reads the record: the provider is never called again.
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
      // The outcome could not be recorded (twice): the lease will expire into 'uncertain'. Never re-send.
      report.uncertain += 1;
    }
  }
  return report;
}
