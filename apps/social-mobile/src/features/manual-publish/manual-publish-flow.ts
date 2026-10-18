// Async steps of the manual X single post, kept out of the screen so they can be proven without React:
// the readiness check and the one send. Everything external (the port, the clock, ids, the memory of an
// unresolved attempt) is injected; this file imports no network client.

import { sha256Hex } from './manual-publish-hash.ts';
import { buildTarget, isRequestId, resultOf, targetIsSendable, type UnresolvedAttempt } from './manual-publish-model.ts';
import type { ManualPublishConsent, ManualPublishOutcome, ManualPublishPort, PortReadiness, ReadinessRecord } from './manual-publish-port.ts';

// ---- memory of an attempt that may have posted -----------------------------------------------------------------

/**
 * Remembers, per signed-in user and for the life of the app process, an attempt whose outcome is not known to
 * be "not posted" -- with the exact text, its hash and the attempt id, so the SAME attempt can be retried
 * after the screen was left. It is written BEFORE the send starts and cleared only by a proven end (`published`,
 * `rejected`, `refused`) or by the user's acknowledgement. Leaving the screen mid-send therefore cannot make a
 * second, identical send look safe. (It does not survive an app restart; the server-side idempotency key does.)
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

// ---- readiness ---------------------------------------------------------------------------------------------------

export type FlowDeps = Readonly<{
  port: ManualPublishPort;
  now: () => number;
  newRequestId: () => string;
  memory: AttemptMemory;
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

// ---- send -----------------------------------------------------------------------------------------------------------

/**
 * The one send of one attempt. Precondition (checked by the caller with `sendGate` and by the reducer): the
 * gate allowed it. Never throws and always returns an outcome for `requestId`:
 *   - a target the provider cannot take, or a consent that does not match the exact text, is refused here,
 *     before the port (nothing sent, nothing remembered);
 *   - a port that throws or answers nonsense is `uncertain` (it may have sent), never `rejected`.
 * The attempt is remembered (with its exact text and hash) before the port is called and updated by what it
 * answers: forgotten only for a proven end, kept as pending / unconfirmed / uncertain otherwise.
 */
export async function runSend(
  deps: FlowDeps,
  args: Readonly<{ userId: string; accountId: string; text: string; requestId: string; consent: ManualPublishConsent }>,
): Promise<ManualPublishOutcome> {
  const { userId, accountId, text, requestId, consent } = args;
  const refuse = (code: string): ManualPublishOutcome => ({ kind: 'refused', targetId: requestId, code, retryable: false });
  if (!isRequestId(requestId)) return refuse('LOCAL_ATTEMPT_ID_INVALID');
  const target = buildTarget(requestId, accountId, text, consent);
  if (!targetIsSendable(target)) return refuse(consent.contentSha256 === sha256Hex(text) ? 'LOCAL_TARGET_INVALID' : 'LOCAL_CONSENT_MISMATCH');
  const entry: UnresolvedAttempt = { accountId, requestId, contentSha256: consent.contentSha256, text, kind: 'in_flight' };
  deps.memory.mark(userId, entry);
  let outcome: ManualPublishOutcome;
  try {
    outcome = await deps.port.send(target);
  } catch {
    deps.memory.mark(userId, { ...entry, kind: 'uncertain' });
    return { kind: 'uncertain', targetId: requestId, code: 'SEND_THREW' };
  }
  const kind = (outcome as { kind?: unknown } | null)?.kind;
  const known = ['published', 'pending', 'rejected', 'refused', 'uncertain', 'unavailable'];
  if (typeof kind !== 'string' || !known.includes(kind)) {
    deps.memory.mark(userId, { ...entry, kind: 'uncertain' });
    return { kind: 'uncertain', targetId: requestId, code: 'OUTCOME_INVALID' };
  }
  const result = resultOf(requestId, outcome);
  if (result.kind === 'sent' || result.kind === 'failed' || result.kind === 'refused') deps.memory.clear(userId);
  else deps.memory.mark(userId, { ...entry, kind: result.kind });
  return outcome;
}
