/**
 * POSTONA Threads reservation dispatch -- G3 SOURCE CANDIDATE (2026-10-19, Issue #318 G3-01). OFFLINE ONLY: wired to no
 * Edge Function, Cron, worker run or database. The two ports it needs belong to G4 (Threads Provider / OAuth / credential)
 * and are NOT implemented here; the store needs a reservation SQL generalised to Threads that does not exist yet
 * (design only: docs/postona/g3-threads-posting-reservation-gap-20261019.md §4). THREADS_DISPATCH_ENABLED = false.
 *
 * What G3 owns here: the order and the decisions of sending ONE claimed Threads reservation, with the same rules as the
 * X paths (PR #224 worker, PR #272/#278 single post):
 *   1. the row must be a Threads row and its account the credential's account (never another provider / account);
 *   2. the credential AND its generation come from ONE call (G4 credentialFor, as X PR #282); a token-only port is
 *      not connected;
 *   3. the store's preflight is the LAST step before the provider: lease still ours, owner / workspace / entitlement /
 *      publish switch / freeze still allow it (G5 + G4 decided in SQL), and the generation it answers must equal the
 *      credential's -- else nothing is sent;
 *   4. exactly one send per lease, never retried here. G4's two-step publish (create container -> publish -> read back)
 *      decides what an outcome means, and this module maps it conservatively:
 *        container step not written / unknown  -> failed_before_send (no container id is held, so nothing is ever
 *                                                published: an unknown container can never become a post -- G4's
 *                                                threads_publish_contract.ts duplicate-safety rule)
 *        publish step not written              -> failed_before_send
 *        publish step unknown                  -> uncertain (resolved read-only later, never resent)
 *        published but read-back unknown / mismatch -> uncertain (never reported as sent)
 *        published + read-back confirms        -> published (media id)
 *   5. the outcome is recorded with the transport ('threads' only when G4's real transport is used; anything else is
 *      'simulated'); only what the store recorded counts; a row that MAY have been sent is never handed back.
 *   6. (2026-10-20, Issue #318 TASK 6/50) the send carries a PRE-PUBLISH hook: G4's two-step send waits for the container
 *      between this module's preflight and the publish request, so the send port is handed { beforePublish } to await
 *      AFTER the container is ready and BEFORE the publish request (contract proposed to G4, #319 6267703384; a port
 *      that ignores the third argument behaves as before). beforePublish re-runs the store's preflight for exactly the
 *      claimed row and lease (owner, workspace, G4 verified, G5 state, freeze / stop / deletion, publish switch,
 *      generation bound at claim, lease) within a bound, and answers true only for OK with the SAME generation the
 *      credential carried. Refused / unreadable / late / after the send returned -> false: the port must not publish.
 *      The hook never sees the token. A refusal the store already recorded (failed / released / lost) is not recorded
 *      again; an unverified refusal on a still-claimed row is recorded failed_before_send.
 * No token is logged, stored, returned or put into an error; codes are fixed.
 */

export const THREADS_DISPATCH_ENABLED = false as const;

// ---- G4 ports (contract only; G4 implements them) ------------------------------------------------------------

/** G4: the current Threads credential of exactly this account and its generation, read in ONE snapshot. */
export type ThreadsGenerationCredential = {
  socialAccountId: string;
  threadsUserId: string;
  accessToken: string;
  /** 64 lowercase hex, computed by the reservation schema's generation function in the same statement (as X 003). */
  generation: string;
};
export type ThreadsCredentialPort = {
  readonly available: boolean;
  credentialFor(socialAccountId: string): Promise<ThreadsGenerationCredential | null>;
};

export type ThreadsSendStage = "container" | "publish" | "readback";
/** What G4's two-step publish says happened. `not_written` = provably no write at that stage. */
export type ThreadsSendOutcome =
  | { kind: "published"; mediaId: string; readBack: "confirmed" | "unknown" | "mismatch" }
  | { kind: "not_written"; stage: "container" | "publish"; code: string }
  | { kind: "unknown"; stage: ThreadsSendStage; code: string };
export type ThreadsSendPort = {
  readonly available: boolean;
  /** 'threads' only when this port reaches the real Threads API; tests and mocks are 'simulated'. */
  readonly transport: "threads" | "simulated";
  /** One two-step text publish with exactly this credential and text. Never retried by G4 either. When `hooks` is
   *  given, `beforePublish` is awaited after the container is ready and before the publish request; anything but
   *  true -> no publish request ({ kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" }). */
  send(credential: Readonly<{ threadsUserId: string; accessToken: string }>, text: string, hooks?: ThreadsSendHooks): Promise<ThreadsSendOutcome>;
};
/** The pre-publish re-check handed to the send port. Carries no token. */
export type ThreadsSendHooks = { beforePublish(): Promise<boolean> };
export const THREADS_PREPUBLISH_TIMEOUT_MS = 5_000;

// ---- the reservation store (G3; SQL design only) -------------------------------------------------------------

export type ClaimedThreadsReservation = {
  reservationId: string;
  leaseToken: string;
  provider: string;
  socialAccountId: string;
  body: string;
};
export type ThreadsPreflight = { verdict: "OK" | "LEASE_LOST" | "NOT_PUBLISHABLE" | "RELEASED"; credentialGeneration: string | null };
export type ThreadsDispatchOutcome = "published" | "failed_before_send" | "uncertain";
export type ThreadsDispatchStore = {
  claimDue(worker: string, leaseSeconds: number, limit: number): Promise<ClaimedThreadsReservation[]>;
  /** Fence again (owner, workspace, entitlement, publish switch, freeze, generation bound at claim) + lease. */
  preflight(reservationId: string, leaseToken: string): Promise<ThreadsPreflight>;
  record(reservationId: string, leaseToken: string, outcome: ThreadsDispatchOutcome, providerPostId: string | null, code: string | null,
    transport: "threads" | "simulated"): Promise<string>;
  releaseUnsent(reservationId: string, leaseToken: string): Promise<string>;
};

export type ThreadsDispatchReport = {
  claimed: number;
  published: number;
  failedBeforeSend: number;
  uncertain: number;
  released: number;
  skipped: number;
  sends: number;
  /** beforePublish calls answered (true or false). */
  prepublishRechecks: number;
  /** Sends the pre-publish re-check stopped before the publish request. */
  prepublishRefused: number;
  notAvailable: boolean;
  stopped: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const THREADS_ID_RE = /^[1-9][0-9]{0,31}$/u;
const TOKEN_RE = /^[A-Za-z0-9._|-]{16,4096}$/u;
const GENERATION_RE = /^[0-9a-f]{64}$/u;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const safeCode = (code: unknown, fallback: string) => (typeof code === "string" && CODE_RE.test(code) ? code : fallback);

/** The decision for one provider outcome (rule 4). Pure; exported for the contract tests and for G4's port tests. */
export function dispatchOutcomeOf(outcome: unknown): { outcome: ThreadsDispatchOutcome; providerPostId: string | null; code: string } {
  const o = (typeof outcome === "object" && outcome !== null ? outcome : {}) as Record<string, unknown>;
  if (o.kind === "published") {
    if (typeof o.mediaId !== "string" || !THREADS_ID_RE.test(o.mediaId)) return { outcome: "uncertain", providerPostId: null, code: "THREADS_MEDIA_ID_INVALID" };
    if (o.readBack === "confirmed") return { outcome: "published", providerPostId: o.mediaId, code: "PUBLISHED" };
    return { outcome: "uncertain", providerPostId: null, code: o.readBack === "mismatch" ? "THREADS_READBACK_MISMATCH" : "THREADS_READBACK_UNKNOWN" };
  }
  if (o.kind === "not_written" && (o.stage === "container" || o.stage === "publish")) {
    return { outcome: "failed_before_send", providerPostId: null, code: safeCode(o.code, "THREADS_NOT_WRITTEN") };
  }
  if (o.kind === "unknown" && o.stage === "container") {
    // No container id is held, so this attempt can never publish anything: provably not a post.
    return { outcome: "failed_before_send", providerPostId: null, code: "THREADS_CONTAINER_UNKNOWN_NOT_POSTED" };
  }
  return { outcome: "uncertain", providerPostId: null, code: safeCode(o.code, "THREADS_OUTCOME_UNKNOWN") };
}

/** Send one claimed row. Returns what the report counts; never throws. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PREPUBLISH_TIMEOUT")), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function dispatchOne(item: ClaimedThreadsReservation, deps: { store: ThreadsDispatchStore; credentials: ThreadsCredentialPort; sender: ThreadsSendPort; prepublishTimeoutMs: number },
  report: ThreadsDispatchReport, handBack: (item: ClaimedThreadsReservation) => Promise<void>): Promise<void> {
  // 1. only a Threads row with well-formed ids
  if (item.provider !== "threads" || !UUID_RE.test(item.reservationId) || !UUID_RE.test(item.leaseToken)) {
    await handBack(item);
    return;
  }
  // 2. the credential and its generation, one call
  let credential: ThreadsGenerationCredential | null;
  try {
    credential = await deps.credentials.credentialFor(item.socialAccountId);
  } catch {
    credential = null;
  }
  // 3. the last check before the provider
  let preflight: ThreadsPreflight | null;
  try {
    preflight = await deps.store.preflight(item.reservationId, item.leaseToken);
  } catch {
    preflight = null;
  }
  if (preflight === null) {
    await handBack(item); // nothing was sent
    return;
  }
  if (preflight.verdict === "RELEASED") {
    report.released += 1;
    return;
  }
  if (preflight.verdict !== "OK") {
    report.skipped += 1; // NOT_PUBLISHABLE recorded by the store; LEASE_LOST is not ours
    return;
  }
  let decided: { outcome: ThreadsDispatchOutcome; providerPostId: string | null; code: string };
  if (!credential || credential.socialAccountId !== item.socialAccountId || !THREADS_ID_RE.test(credential.threadsUserId) || !TOKEN_RE.test(credential.accessToken)) {
    decided = { outcome: "failed_before_send", providerPostId: null, code: "THREADS_CREDENTIALS_UNAVAILABLE" };
  } else if (typeof preflight.credentialGeneration !== "string" || !GENERATION_RE.test(preflight.credentialGeneration) || credential.generation !== preflight.credentialGeneration) {
    decided = { outcome: "failed_before_send", providerPostId: null, code: "CREDENTIAL_GENERATION_CHANGED" };
  } else {
    // 4. exactly one send, with the pre-publish re-check of exactly this row and lease
    let outcome: unknown;
    const boundGeneration = credential.generation;
    let hookOpen = true;
    let hook: { verdict: "not_called" | "ok" | "store_refused" | "unverified" | "generation_changed"; storeVerdict: ThreadsPreflight["verdict"] | null } = { verdict: "not_called", storeVerdict: null };
    const hooks: ThreadsSendHooks = {
      async beforePublish() {
        if (!hookOpen) return false;
        report.prepublishRechecks += 1;
        let again: ThreadsPreflight | null;
        try {
          again = await within(deps.store.preflight(item.reservationId, item.leaseToken), deps.prepublishTimeoutMs);
        } catch {
          again = null;
        }
        if (!hookOpen) return false; // answered after the send returned: never a permission
        if (again && again.verdict === "OK" && again.credentialGeneration === boundGeneration) {
          hook = { verdict: "ok", storeVerdict: "OK" };
          return true;
        }
        hook = again && again.verdict !== "OK" ? { verdict: "store_refused", storeVerdict: again.verdict }
          : again ? { verdict: "generation_changed", storeVerdict: "OK" } : { verdict: "unverified", storeVerdict: null };
        return false;
      },
    };
    report.sends += 1;
    try {
      outcome = await deps.sender.send({ threadsUserId: credential.threadsUserId, accessToken: credential.accessToken }, item.body, hooks);
    } catch {
      outcome = { kind: "unknown", stage: "publish", code: "THREADS_SENDER_THREW" };
    } finally {
      hookOpen = false;
    }
    const o = (typeof outcome === "object" && outcome !== null ? outcome : {}) as Record<string, unknown>;
    const notWritten = o.kind === "not_written";
    if (hook.verdict !== "not_called" && hook.verdict !== "ok" && notWritten) {
      report.prepublishRefused += 1;
      if (hook.verdict === "store_refused") {
        // The store already decided this row (failed / handed back / not ours): nothing to record again.
        if (hook.storeVerdict === "RELEASED") report.released += 1;
        else report.skipped += 1;
        credential = null;
        return;
      }
      decided = { outcome: "failed_before_send", providerPostId: null, code: hook.verdict === "generation_changed" ? "CREDENTIAL_GENERATION_CHANGED" : "THREADS_PREPUBLISH_UNVERIFIED" };
    } else {
      // Includes a port that ignored a refusal and wrote anyway: what it says happened is what is recorded.
      decided = dispatchOutcomeOf(outcome);
    }
  }
  credential = null;
  // 5. record; only what the store recorded counts
  const transport = deps.sender.transport === "threads" ? "threads" : "simulated";
  try {
    const recorded = await deps.store.record(item.reservationId, item.leaseToken, decided.outcome, decided.providerPostId, decided.code, transport);
    if (decided.outcome === "published" && recorded === "published") report.published += 1;
    else if (decided.outcome === "failed_before_send" && recorded === "failed_before_send") report.failedBeforeSend += 1;
    else report.uncertain += 1;
  } catch {
    report.uncertain += 1; // the lease will expire into 'uncertain'; never re-send
  }
}

export async function runThreadsReservationDelivery(input: {
  enabled: boolean;
  store: ThreadsDispatchStore;
  credentials: ThreadsCredentialPort;
  sender: ThreadsSendPort;
  worker: string;
  leaseSeconds?: number;
  limit?: number;
  shouldStop?: () => boolean;
  /** Bound of one pre-publish re-check (default THREADS_PREPUBLISH_TIMEOUT_MS); a late answer refuses. */
  prepublishTimeoutMs?: number;
}): Promise<ThreadsDispatchReport> {
  const report: ThreadsDispatchReport = {
    claimed: 0, published: 0, failedBeforeSend: 0, uncertain: 0, released: 0, skipped: 0, sends: 0, prepublishRechecks: 0, prepublishRefused: 0, notAvailable: false, stopped: false,
  };
  // Nothing is claimed unless every part can run: a claim without a sender only ages into rows the user cannot cancel.
  if (input.enabled !== true || input.credentials?.available !== true || typeof input.credentials.credentialFor !== "function"
      || input.sender?.available !== true || typeof input.sender.send !== "function") {
    report.notAvailable = true;
    return report;
  }
  const handBack = async (item: ClaimedThreadsReservation) => {
    let answer = "";
    try {
      answer = await input.store.releaseUnsent(item.reservationId, item.leaseToken);
    } catch {
      answer = "";
    }
    if (answer === "released") report.released += 1;
    else report.skipped += 1;
  };
  const claimed = await input.store.claimDue(input.worker, input.leaseSeconds ?? 120, Math.min(Math.max(input.limit ?? 10, 1), 50));
  report.claimed = claimed.length;
  const seen = new Set<string>();
  for (const [index, item] of claimed.entries()) {
    let stop = false;
    try {
      stop = input.shouldStop?.() === true;
    } catch {
      stop = true;
    }
    if (stop) {
      report.stopped = true;
      for (const rest of claimed.slice(index)) if (!seen.has(rest.reservationId)) await handBack(rest);
      break;
    }
    if (seen.has(item.reservationId)) {
      report.skipped += 1; // the same row twice in one claim answer: never a second send
      continue;
    }
    seen.add(item.reservationId);
    await dispatchOne(item, { store: input.store, credentials: input.credentials, sender: input.sender,
      prepublishTimeoutMs: Math.min(Math.max(input.prepublishTimeoutMs ?? THREADS_PREPUBLISH_TIMEOUT_MS, 1), 30_000) }, report, handBack);
  }
  return report;
}
