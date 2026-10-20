// Async steps of the manual X single post, kept out of the screen so they can be proven without React:
// the readiness check and the one send. Everything external (the port, the clock, ids, the memory of an
// unresolved attempt, the durable record of it) is injected; this file imports no network client.

import { sha256Hex } from './manual-publish-hash.ts';
import { buildTarget, isRequestId, resultOf, targetIsSendable, type UnresolvedAttempt } from './manual-publish-model.ts';
import type { ManualPublishConsent, ManualPublishOutcome, ManualPublishPort, PortReadiness, ReadinessRecord } from './manual-publish-port.ts';
import type { AttemptStore, PersistedAttempt, StoreRead } from './manual-publish-store.ts';

// ---- memory of an attempt that may have posted -----------------------------------------------------------------

/**
 * Remembers, per signed-in user and for the life of the app process, an attempt whose outcome is not known to
 * be "not posted" -- with the exact text, its hash and the attempt id, so the SAME attempt can be retried
 * after the screen was left. It is written BEFORE the send starts and cleared only by a proven end (`published`,
 * `rejected`, `refused`) or by the user's acknowledgement. Leaving the screen mid-send therefore cannot make a
 * second, identical send look safe. It does not survive an app restart: the hash-only record in the AttemptStore
 * does (see manual-publish-store.ts), and the server-side idempotency key makes a same-id retry safe.
 */
export interface AttemptMemory {
  get(userId: string | null): UnresolvedAttempt | null;
  mark(userId: string, entry: UnresolvedAttempt): void;
  clear(userId: string): void;
}

export function createAttemptMemory(): AttemptMemory {
  const entries = new Map<string, UnresolvedAttempt>();
  return {
    get: (userId) => (userId === null ? null : entries.get(userId) ?? null),
    mark: (userId, entry) => { entries.set(userId, entry); },
    clear: (userId) => { entries.delete(userId); },
  };
}

/** The screen's memory (module scope: shared by every visit of the screen in this app process). */
export const attemptMemory: AttemptMemory = createAttemptMemory();

// ---- the send that is still out -------------------------------------------------------------------------------------

/**
 * Remembers, per signed-in user and for the life of the app process, the ONE send whose answer has not come back yet --
 * and, once it has, that answer. The screen that started the send may be gone when the answer arrives (it was left, or it
 * was re-created because the sign-in session mark changed): a screen that opens while the send is still out must not call
 * it "unconfirmed" and offer a re-ask while the first request is still on its way, and it must show the real answer when
 * it comes. `end` is called only AFTER the attempt memory and the durable record were updated, so whoever waits sees them final.
 */
export interface InFlightSends {
  begin(userId: string, requestId: string): void;
  end(userId: string, requestId: string, outcome: ManualPublishOutcome): void;
  /** True only while this user's send with this id has not ended yet. */
  isOut(userId: string | null, requestId: string): boolean;
  /** The answer of this user's most recent send, if it has this id (already ended or still out); otherwise null. */
  wait(userId: string, requestId: string): Promise<ManualPublishOutcome> | null;
}

export function createInFlightSends(): InFlightSends {
  type Entry = { requestId: string; out: boolean; promise: Promise<ManualPublishOutcome>; settle: (outcome: ManualPublishOutcome) => void };
  const entries = new Map<string, Entry>();
  return {
    begin(userId, requestId) {
      let settle: (outcome: ManualPublishOutcome) => void = () => {};
      const promise = new Promise<ManualPublishOutcome>((resolve) => { settle = resolve; });
      entries.set(userId, { requestId, out: true, promise, settle });
    },
    end(userId, requestId, outcome) {
      const entry = entries.get(userId);
      if (entry === undefined || entry.requestId !== requestId || !entry.out) return;
      entry.out = false;
      entry.settle(outcome);
    },
    isOut: (userId, requestId) => {
      const entry = userId === null ? undefined : entries.get(userId);
      return entry !== undefined && entry.requestId === requestId && entry.out;
    },
    wait: (userId, requestId) => {
      const entry = entries.get(userId);
      return entry !== undefined && entry.requestId === requestId ? entry.promise : null;
    },
  };
}

/** The process-wide registry (module scope, like the attempt memory). */
export const inFlightSends: InFlightSends = createInFlightSends();

// ---- readiness ---------------------------------------------------------------------------------------------------

export type FlowDeps = Readonly<{
  port: ManualPublishPort;
  now: () => number;
  newRequestId: () => string;
  memory: AttemptMemory;
  /** The durable, hash-only record of an unresolved attempt (survives an app restart). */
  store: AttemptStore;
  /** Optional: where a send that is out is registered, so a screen that opens meanwhile can wait for its answer. */
  inflight?: InFlightSends;
}>;

function sanitizeReadiness(value: unknown): PortReadiness {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === 'ready') return { kind: 'ready' };
  if (kind === 'not_connected') return { kind: 'not_connected' };
  if (kind === 'unavailable') {
    const code = (value as { code?: unknown }).code;
    return { kind: 'unavailable', code: typeof code === 'string' && code !== '' ? code : 'UNAVAILABLE' };
  }
  // An answer the screen does not understand is never `ready`.
  return { kind: 'unavailable', code: 'READINESS_INVALID' };
}

/** Ask the port whether this exact account can send now. Never throws; a failure is `unavailable`. */
export async function runReadinessCheck(deps: FlowDeps, accountId: string): Promise<ReadinessRecord> {
  let result: PortReadiness;
  try {
    result = sanitizeReadiness(await deps.port.checkReadiness(accountId));
  } catch {
    result = { kind: 'unavailable', code: 'READINESS_CHECK_FAILED' };
  }
  return { accountId, checkedAt: deps.now(), result };
}

// ---- restart: the durable record --------------------------------------------------------------------------------------

/** What the device remembers of an attempt after a restart: everything but the text (never stored). */
export function restoredAttemptOf(attempt: PersistedAttempt): UnresolvedAttempt {
  return { accountId: attempt.accountId, requestId: attempt.requestId, contentSha256: attempt.contentSha256, text: null, kind: attempt.kind };
}

/**
 * Read the durable record of this user's unresolved attempt (the first thing a visit does when the process has no
 * memory of one). A record that is found is also put into the process memory, so every later visit of this
 * process sees it without reading again. Never throws.
 */
export async function loadPersistedAttempt(deps: FlowDeps, userId: string): Promise<StoreRead> {
  let read: StoreRead;
  try {
    read = await deps.store.read(userId);
  } catch {
    read = { kind: 'unreadable', reason: 'io' };
  }
  if (read.kind === 'found') deps.memory.mark(userId, restoredAttemptOf(read.attempt));
  return read;
}

/**
 * The user's explicit "I checked X": forget the unresolved attempt. Only when the durable record is really gone is
 * the process memory cleared too; a record that cannot be removed keeps blocking (fail closed) and `false` is returned.
 */
export async function runAcknowledge(deps: FlowDeps, userId: string): Promise<boolean> {
  let cleared: boolean;
  try {
    cleared = await deps.store.clear(userId);
  } catch {
    cleared = false;
  }
  if (!cleared) return false;
  deps.memory.clear(userId);
  return true;
}

// ---- send -----------------------------------------------------------------------------------------------------------

/**
 * The one send of one attempt. Precondition (checked by the caller with `sendGate` and by the reducer): the
 * gate allowed it. Never throws and always returns an outcome for `requestId`:
 *   - a target the provider cannot take, or a consent that does not match the exact text, is refused here,
 *     before the port (nothing sent, nothing remembered);
 *   - the attempt is first written to the DURABLE store and read back; if that fails nothing is sent at all
 *     (a send that could not be remembered across a restart is never started). For a fresh attempt that is a
 *     plain refusal; for a retry of an unresolved attempt it is `unavailable`, which keeps the attempt unresolved
 *     (a failed local write proves nothing about the earlier send);
 *   - a port that throws or answers nonsense is `uncertain` (it may have sent), never `rejected`.
 * The attempt is remembered (in memory with its exact text, durably as id + account + hash) before the port is
 * called and updated by what it answers: forgotten only for a proven end, kept as pending / unconfirmed /
 * uncertain otherwise. If an update of the durable record fails after the send, the earlier `in_flight` record
 * stays, which a restart shows as "unconfirmed" -- still blocked, still retryable only with the same id.
 */
export async function runSend(
  deps: FlowDeps,
  args: Readonly<{ userId: string; accountId: string; text: string; requestId: string; consent: ManualPublishConsent; retry: boolean }>,
): Promise<ManualPublishOutcome> {
  const { userId, accountId, text, requestId, consent, retry } = args;
  const refuse = (code: string): ManualPublishOutcome => ({ kind: 'refused', targetId: requestId, code, retryable: false });
  if (!isRequestId(requestId)) return refuse('LOCAL_ATTEMPT_ID_INVALID');
  const target = buildTarget(requestId, accountId, text, consent);
  if (!targetIsSendable(target)) return refuse(consent.contentSha256 === sha256Hex(text) ? 'LOCAL_TARGET_INVALID' : 'LOCAL_CONSENT_MISMATCH');
  const entry: UnresolvedAttempt = { accountId, requestId, contentSha256: consent.contentSha256, text, kind: 'in_flight' };
  const record = (kind: PersistedAttempt['kind']): PersistedAttempt => ({ accountId, requestId, contentSha256: consent.contentSha256, kind, savedAt: deps.now() });
  if (!(await deps.store.write(userId, record('in_flight')))) {
    if (retry) {
      deps.memory.mark(userId, { ...entry, kind: 'unconfirmed' });
      return { kind: 'unavailable', targetId: requestId, code: 'LOCAL_STORE_UNAVAILABLE' };
    }
    // A fresh attempt that could not be recorded was never sent. A half-written record would only block the next
    // visit, so it is removed if it can be (there was no earlier record for this user to lose).
    await deps.store.clear(userId);
    return refuse('LOCAL_STORE_UNAVAILABLE');
  }
  deps.memory.mark(userId, entry);
  deps.inflight?.begin(userId, requestId);
  let outcome: ManualPublishOutcome;
  try {
    outcome = await sendAndRecord(deps, { userId, requestId, entry, record, target });
  } catch {
    // Never leave a waiter hanging: whatever went wrong, the send may have gone out.
    outcome = { kind: 'uncertain', targetId: requestId, code: 'SEND_STATE_LOST' };
  }
  // Only now, after the memory and the durable record say what the answer is, whoever waits for this send is told.
  deps.inflight?.end(userId, requestId, outcome);
  return outcome;
}

async function sendAndRecord(
  deps: FlowDeps,
  args: Readonly<{
    userId: string;
    requestId: string;
    entry: UnresolvedAttempt;
    record: (kind: PersistedAttempt['kind']) => PersistedAttempt;
    target: ReturnType<typeof buildTarget>;
  }>,
): Promise<ManualPublishOutcome> {
  const { userId, requestId, entry, record, target } = args;
  const keep = async (kind: Exclude<PersistedAttempt['kind'], 'in_flight'>) => {
    deps.memory.mark(userId, { ...entry, kind });
    await deps.store.write(userId, record(kind)); // best effort: the in_flight record already blocks
  };
  let outcome: ManualPublishOutcome;
  try {
    outcome = await deps.port.send(target);
  } catch {
    await keep('uncertain');
    return { kind: 'uncertain', targetId: requestId, code: 'SEND_THREW' };
  }
  const kind = (outcome as { kind?: unknown } | null)?.kind;
  const known = ['published', 'pending', 'rejected', 'refused', 'uncertain', 'unavailable'];
  if (typeof kind !== 'string' || !known.includes(kind)) {
    await keep('uncertain');
    return { kind: 'uncertain', targetId: requestId, code: 'OUTCOME_INVALID' };
  }
  const result = resultOf(requestId, outcome);
  if (result.kind === 'sent' || result.kind === 'failed' || result.kind === 'refused') {
    // A proven end. If the durable record cannot be removed it stays, and a restart shows it as "unconfirmed":
    // retrying the same id then gets the stored answer. Never the other way round.
    await deps.store.clear(userId);
    deps.memory.clear(userId);
  } else {
    // A simulated answer proves nothing about X: it is kept like an uncertain one (never resent).
    await keep(result.kind === 'simulated' ? 'uncertain' : result.kind);
  }
  return outcome;
}
