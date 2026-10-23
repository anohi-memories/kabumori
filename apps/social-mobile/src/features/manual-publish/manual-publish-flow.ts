// Async steps of the manual X single post, kept out of the screen so they can be proven without React:
// the readiness check and the one send. Everything external (the port, the clock, ids, the memory of an
// unresolved attempt, the durable record of it) is injected; this file imports no network client.

import { sha256Hex } from './manual-publish-hash.ts';
import { buildTarget, isRequestId, mayRetryAttempt, resultOf, targetIsSendable, type UnresolvedAttempt } from './manual-publish-model.ts';
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
  /**
   * A per-user counter that moves on EVERY mark and clear (also a clear of nothing). A reader of the device record takes it
   * before the read and compares it after: if it moved, the memory changed while the record was being read, so the snapshot
   * may be older than that change (e.g. an acknowledge cleared the attempt the snapshot still shows).
   */
  version(userId: string): number;
}

export function createAttemptMemory(): AttemptMemory {
  const entries = new Map<string, UnresolvedAttempt>();
  const versions = new Map<string, number>();
  const bump = (userId: string) => { versions.set(userId, (versions.get(userId) ?? 0) + 1); };
  return {
    get: (userId) => (userId === null ? null : entries.get(userId) ?? null),
    mark: (userId, entry) => { entries.set(userId, entry); bump(userId); },
    clear: (userId) => { entries.delete(userId); bump(userId); },
    version: (userId) => versions.get(userId) ?? 0,
  };
}

/** The screen's memory (module scope: shared by every visit of the screen in this app process). */
export const attemptMemory: AttemptMemory = createAttemptMemory();

// ---- the send that is still out -------------------------------------------------------------------------------------

/** The attempt of a send that is out, with the exact text (it lives in this process only, like the attempt memory). */
export type InFlightAttempt = UnresolvedAttempt & Readonly<{ text: string }>;

/**
 * Identifies ONE send (one call of `begin`): only the holder of its handle can end it. A later send of the same user, even
 * with the same attempt id (a re-ask), has another generation, so an old send can never end or answer a newer one.
 */
export type InFlightHandle = Readonly<{ userId: string; requestId: string; generation: number }>;

/** What a screen that opens while a send is out needs: the attempt it shows, and the answer it waits for. */
export type InFlightTakeOver = Readonly<{ attempt: InFlightAttempt; retry: boolean; answer: Promise<ManualPublishOutcome> }>;

/**
 * Remembers, per signed-in user and for the life of the app process, the ONE send that is not finished yet. A send is
 * registered by `begin` BEFORE its first asynchronous step (the record on the device is written and read back first, and
 * only then is the port called) and finished by `end` only AFTER the attempt memory and the durable record say what the
 * answer is. In between -- preparing, out, or answered but not yet recorded -- the user has exactly one send:
 *   - `begin` refuses (null) while that user's earlier send is not finished: an unfinished send is never replaced, so a
 *     second request with the same id cannot start meanwhile;
 *   - a screen that opens meanwhile (it was left, or re-created because the sign-in session mark changed) can `takeOver`
 *     the send: it must not call it "unconfirmed" or offer a re-ask, and it shows the real answer when it comes;
 *   - `end` settles only the send of the handle it is given.
 * A finished send is forgotten (no text is kept).
 */
export interface InFlightSends {
  /** Register the send before anything is awaited. Null: this user's earlier send is not finished, nothing was changed. */
  begin(userId: string, attempt: InFlightAttempt, retry: boolean): InFlightHandle | null;
  /** Finish the send of this handle with its answer. A handle that is not the current send (already ended, older) is ignored. */
  end(handle: InFlightHandle, outcome: ManualPublishOutcome): void;
  /** True only while this user's send with this attempt id is not finished. */
  isOut(userId: string | null, requestId: string): boolean;
  /** This user's unfinished send, to wait for its answer; null when there is none (an acknowledge in progress is not a send). */
  takeOver(userId: string | null): InFlightTakeOver | null;
  /**
   * Reserve the user's one operation for an ACKNOWLEDGE (clear the record on the device, then the memory). Null while this
   * user has any unfinished operation -- a send or another acknowledge. While it is held, `begin` refuses too, so a send can
   * neither start under a clear that is still running nor be cleared away by it.
   */
  beginAcknowledge(userId: string): InFlightHandle | null;
  /** Finish the acknowledge of this handle (a handle that is not the current operation, or a send's, is ignored). */
  release(handle: InFlightHandle): void;
}

export function createInFlightSends(): InFlightSends {
  type Entry = { handle: InFlightHandle; op: 'send' | 'acknowledge'; attempt: InFlightAttempt | null; retry: boolean; promise: Promise<ManualPublishOutcome>; settle: (outcome: ManualPublishOutcome) => void };
  const entries = new Map<string, Entry>();
  let generation = 0;
  return {
    begin(userId, attempt, retry) {
      if (entries.has(userId)) return null;
      let settle: (outcome: ManualPublishOutcome) => void = () => {};
      const promise = new Promise<ManualPublishOutcome>((resolve) => { settle = resolve; });
      generation += 1;
      const handle: InFlightHandle = { userId, requestId: attempt.requestId, generation };
      entries.set(userId, { handle, op: 'send', attempt, retry, promise, settle });
      return handle;
    },
    beginAcknowledge(userId) {
      if (entries.has(userId)) return null;
      let settle: (outcome: ManualPublishOutcome) => void = () => {};
      const promise = new Promise<ManualPublishOutcome>((resolve) => { settle = resolve; });
      generation += 1;
      const handle: InFlightHandle = { userId, requestId: '', generation };
      entries.set(userId, { handle, op: 'acknowledge', attempt: null, retry: false, promise, settle });
      return handle;
    },
    release(handle) {
      const entry = entries.get(handle.userId);
      if (entry === undefined || entry.op !== 'acknowledge' || entry.handle.generation !== handle.generation) return;
      entries.delete(handle.userId);
      entry.settle({ kind: 'unavailable', targetId: '', code: 'RELEASED' });
    },
    end(handle, outcome) {
      const entry = entries.get(handle.userId);
      if (entry === undefined || entry.op !== 'send' || entry.handle.generation !== handle.generation) return;
      entries.delete(handle.userId);
      entry.settle(outcome);
    },
    isOut: (userId, requestId) => {
      const entry = userId === null ? undefined : entries.get(userId);
      return entry !== undefined && entry.op === 'send' && entry.handle.requestId === requestId;
    },
    takeOver: (userId) => {
      const entry = userId === null ? undefined : entries.get(userId);
      return entry === undefined || entry.op !== 'send' || entry.attempt === null ? null : { attempt: entry.attempt, retry: entry.retry, answer: entry.promise };
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
  // A read is a snapshot of the moment it was taken. If the memory of this user changed while it was being read, the snapshot
  // may be older than that change: when the memory knows an attempt now, that attempt wins (see reconcileLoadedRead) and the
  // snapshot is not put into the memory; when the memory was emptied meanwhile (an acknowledge, a proven end), the snapshot
  // may still show the attempt that was just dropped -- it is never put back: the record is read again. A memory that keeps
  // changing under the reads is treated as an unreadable record (fail closed; the visit can read again).
  for (let round = 0; round < LOAD_ROUNDS; round += 1) {
    const before = deps.memory.version(userId);
    let read: StoreRead;
    try {
      read = await deps.store.read(userId);
    } catch {
      read = { kind: 'unreadable', reason: 'io' };
    }
    if (deps.memory.version(userId) !== before) {
      if (deps.memory.get(userId) !== null) return read;
      continue;
    }
    // The text-less record of an earlier run never replaces what this process knows: an attempt of this process is already in
    // the memory (with its text), and a send that is still being prepared or recorded is about to put its own entry there.
    if (read.kind === 'found' && deps.memory.get(userId) === null && (deps.inflight?.takeOver(userId) ?? null) === null) {
      deps.memory.mark(userId, restoredAttemptOf(read.attempt));
    }
    return read;
  }
  return { kind: 'unreadable', reason: 'io' };
}

/** How many times a visit reads the record again when the memory changed under the read (see loadPersistedAttempt). */
const LOAD_ROUNDS = 3;

/**
 * The code of a start that `runSend` did not make because this process already knows an unresolved attempt of the user that this
 * start may not re-ask (another id, not declared as a re-ask, or an attempt that is uncertain now). The screen that gets it shows
 * the attempt as the process knows it (see `send_not_started`) instead of what it believed.
 */
export const UNRESOLVED_REFUSAL_CODE = 'LOCAL_UNRESOLVED_ATTEMPT';

/**
 * The code of a re-ask that `runSend` did not make because the process no longer knows the attempt (it was acknowledged or
 * ended on another screen). The screen that gets it drops the attempt it showed (see `send_not_started` with no attempt).
 */
export const ATTEMPT_CLEARED_CODE = 'LOCAL_ATTEMPT_CLEARED';

/** What a visit shows once its read of the device record is back. */
export type LoadedView =
  | Readonly<{ kind: 'send'; takeOver: InFlightTakeOver }>
  | Readonly<{ kind: 'memory'; attempt: UnresolvedAttempt }>
  | Readonly<{ kind: 'record'; read: StoreRead }>;

/**
 * A read of the device record is a SNAPSHOT of the moment it was taken. By the time it is delivered, this process may
 * have started a send, or finished one that is still unresolved, or replaced the attempt the record described: the
 * snapshot is then old, and applying it would hide the current state (an old "nothing" would open an empty editor
 * beside an unresolved attempt; an old record would show an attempt that is no longer the current one). So what this
 * process knows NOW wins, in this order:
 *   1. a send that is not finished (the visit waits for it);
 *   2. the attempt in the process memory (unresolved: shown as it is, with its text);
 *   3. only if the process knows nothing, the snapshot itself.
 * The memory is the newer truth because every change of an attempt is written to it first (and an acknowledged or proven
 * end clears it), while the snapshot can only be as new as the moment it was read.
 */
export function reconcileLoadedRead(deps: FlowDeps, userId: string, read: StoreRead): LoadedView {
  const send = deps.inflight?.takeOver(userId) ?? null;
  if (send !== null) return { kind: 'send', takeOver: send };
  const known = deps.memory.get(userId);
  if (known !== null) return { kind: 'memory', attempt: known };
  return { kind: 'record', read };
}

/** The result of an acknowledge. `refused` means NOTHING was cleared: the screen must show the attempt as it is now. */
export type AcknowledgeResult =
  | Readonly<{ kind: 'cleared' }>
  | Readonly<{ kind: 'failed' }>
  | Readonly<{ kind: 'refused'; reason: 'in_progress' | 'stale' }>;

/**
 * The user's explicit "I checked X": forget the unresolved attempt. Only when the durable record is really gone is the
 * process memory cleared too; a record that cannot be removed keeps blocking (fail closed) and `failed` is returned.
 *
 * It is an operation on the user's record, so it takes the same per-user reservation as a send, for the whole of the
 * clear, the read-back and the memory update:
 *   - while a send (or another acknowledge) of this user is unfinished it is REFUSED -- the screen that asks may be showing
 *     an old result, and the answer to the send that is out is not known: its record must stay;
 *   - while it runs, a send cannot start (the registry refuses), so a clear can never remove the record of a send that
 *     began after the check;
 *   - when the screen names the attempt it shows (`expectedRequestId`) and the process knows another one, it is REFUSED:
 *     an old screen cannot erase a newer attempt.
 */
export async function acknowledgeAttempt(deps: FlowDeps, userId: string, expectedRequestId: string | null): Promise<AcknowledgeResult> {
  let handle: InFlightHandle | null = null;
  if (deps.inflight !== undefined) {
    handle = deps.inflight.beginAcknowledge(userId);
    if (handle === null) return { kind: 'refused', reason: 'in_progress' };
  }
  try {
    const known = deps.memory.get(userId);
    if (expectedRequestId !== null && known !== null && known.requestId !== expectedRequestId) return { kind: 'refused', reason: 'stale' };
    let cleared: boolean;
    try {
      cleared = await deps.store.clear(userId);
    } catch {
      cleared = false;
    }
    if (!cleared) return { kind: 'failed' };
    deps.memory.clear(userId);
    return { kind: 'cleared' };
  } finally {
    if (handle !== null) deps.inflight?.release(handle);
  }
}

/** `acknowledgeAttempt` for a caller that names no attempt: true only if the record is really gone. */
export async function runAcknowledge(deps: FlowDeps, userId: string): Promise<boolean> {
  return (await acknowledgeAttempt(deps, userId, null)).kind === 'cleared';
}

// ---- send -----------------------------------------------------------------------------------------------------------

/**
 * The one send of one attempt. Precondition (checked by the caller with `sendGate` and by the reducer): the
 * gate allowed it. Never throws and always returns an outcome for `requestId`:
 *   - with a registry (`deps.inflight`) the send is registered before anything is awaited and stays registered until the
 *     memory and the durable record are final; a start while the user's earlier send is unfinished is refused
 *     (`LOCAL_SEND_IN_PROGRESS`) without touching memory, record or port;
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
  // The send is registered BEFORE the first await: from here until the end of this call the user has exactly this one
  // send, so a screen that opens while the record is still being written, or while the answer is still being recorded,
  // waits for it instead of reading half-written state -- and a second start for this user is refused, never run alongside.
  const notStarted = (code: string): ManualPublishOutcome => (retry ? { kind: 'unavailable', targetId: requestId, code } : refuse(code));
  let handle: InFlightHandle | null = null;
  if (deps.inflight !== undefined) {
    handle = deps.inflight.begin(userId, { ...entry, text }, retry);
    // Nothing was changed: the earlier send keeps its memory, its record and its waiters. A retry stays unresolved.
    if (handle === null) return notStarted('LOCAL_SEND_IN_PROGRESS');
  }
  // Whatever a screen believes (it may be showing an old snapshot or an old confirmation), this process may already know an
  // unresolved attempt of this user, in a state the screen has not seen. Only a re-ask of THAT attempt -- the same id AND an
  // attempt that may be re-asked NOW (pending / unconfirmed, never uncertain) -- may start; anything else is refused before the
  // port, the record and the memory are touched. (Still the same synchronous step as the registration above: nobody saw the
  // entry in between.) A re-ask of an attempt that is uncertain now is answered as what it is -- uncertain -- never as a
  // refusal or "unavailable", which a caller could apply as a downgrade to unconfirmed (re-askable).
  const unresolved = deps.memory.get(userId);
  if (unresolved !== null && (!retry || unresolved.requestId !== requestId || !mayRetryAttempt(unresolved))) {
    const refusal: ManualPublishOutcome = retry && unresolved.requestId === requestId
      ? { kind: 'uncertain', targetId: requestId, code: UNRESOLVED_REFUSAL_CODE }
      : notStarted(UNRESOLVED_REFUSAL_CODE);
    if (handle !== null) deps.inflight?.end(handle, refusal);
    return refusal;
  }
  let outcome: ManualPublishOutcome;
  try {
    const send = { userId, accountId, text, requestId, consent, retry, entry, target };
    // A re-ask the process memory knows nothing about is checked against the device record first (still under the reservation).
    outcome = await (unresolved === null && retry ? reAskWithoutMemory(deps, send) : prepareAndSend(deps, send));
  } catch {
    // Never leave a waiter hanging, and never leave the attempt looking settled: whatever went wrong, the send may have gone out.
    try { deps.memory.mark(userId, { ...entry, kind: 'uncertain' }); } catch { /* the outcome below is still uncertain */ }
    outcome = { kind: 'uncertain', targetId: requestId, code: 'SEND_STATE_LOST' };
  }
  // Only now, after the memory and the durable record say what the answer is, whoever waits for this send is told.
  if (handle !== null) deps.inflight?.end(handle, outcome);
  return outcome;
}

/**
 * A re-ask exists only for an attempt that still exists. Every visit puts the attempt it shows into the memory first (from the
 * memory, from the device record after a restart, or from its own send), so a re-ask with an EMPTY memory comes either from a
 * caller that never loaded the record, or from an old screen whose attempt was acknowledged or ended elsewhere. The device
 * record decides, read under the user's reservation (no acknowledge can run meanwhile):
 *   - no record of THIS attempt: it is gone (the user checked X for it, or it ended). Nothing is sent, nothing is written, and
 *     it is never re-created as a new in_flight from an old screen's state -- `refused` / `LOCAL_ATTEMPT_CLEARED`;
 *   - the record cannot be read: fail closed, exactly as a failed write of a re-ask (`unavailable`, kept unresolved);
 *   - the record is this attempt: it is put into the memory and the same rules as for a known attempt apply (it must be
 *     re-askable now and be the same account and text); then the re-ask goes on as usual.
 */
async function reAskWithoutMemory(deps: FlowDeps, args: Parameters<typeof prepareAndSend>[1]): Promise<ManualPublishOutcome> {
  const { userId, accountId, requestId, consent, entry } = args;
  let read: StoreRead;
  try {
    read = await deps.store.read(userId);
  } catch {
    read = { kind: 'unreadable', reason: 'io' };
  }
  if (read.kind === 'unreadable') {
    deps.memory.mark(userId, { ...entry, kind: 'unconfirmed' });
    return { kind: 'unavailable', targetId: requestId, code: 'LOCAL_STORE_UNAVAILABLE' };
  }
  if (read.kind === 'none' || read.attempt.requestId !== requestId) {
    return { kind: 'refused', targetId: requestId, code: ATTEMPT_CLEARED_CODE, retryable: false };
  }
  const restored = restoredAttemptOf(read.attempt);
  deps.memory.mark(userId, restored);
  if (!mayRetryAttempt(restored)) return { kind: 'uncertain', targetId: requestId, code: UNRESOLVED_REFUSAL_CODE };
  if (restored.accountId !== accountId || restored.contentSha256 !== consent.contentSha256) {
    return { kind: 'unavailable', targetId: requestId, code: UNRESOLVED_REFUSAL_CODE };
  }
  return prepareAndSend(deps, args);
}

async function prepareAndSend(
  deps: FlowDeps,
  args: Readonly<{
    userId: string;
    accountId: string;
    text: string;
    requestId: string;
    consent: ManualPublishConsent;
    retry: boolean;
    entry: UnresolvedAttempt;
    target: ReturnType<typeof buildTarget>;
  }>,
): Promise<ManualPublishOutcome> {
  const { userId, accountId, requestId, consent, retry, entry, target } = args;
  const record = (kind: PersistedAttempt['kind']): PersistedAttempt => ({ accountId, requestId, contentSha256: consent.contentSha256, kind, savedAt: deps.now() });
  if (!(await deps.store.write(userId, record('in_flight')))) {
    if (retry) {
      deps.memory.mark(userId, { ...entry, kind: 'unconfirmed' });
      return { kind: 'unavailable', targetId: requestId, code: 'LOCAL_STORE_UNAVAILABLE' };
    }
    // A fresh attempt that could not be recorded was never sent. A half-written record would only block the next
    // visit, so it is removed if it can be (there was no earlier record for this user to lose).
    await deps.store.clear(userId);
    return { kind: 'refused', targetId: requestId, code: 'LOCAL_STORE_UNAVAILABLE', retryable: false };
  }
  deps.memory.mark(userId, entry);
  return sendAndRecord(deps, { userId, requestId, entry, record, target });
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
