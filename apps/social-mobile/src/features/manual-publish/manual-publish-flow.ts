// Async steps of the manual X single post, kept out of the screen so they can be proven without React:
// the readiness check and the one send. Everything external (the port, the clock, ids, the memory of an
// unconfirmed attempt) is injected; this file imports no network client.

import { buildTarget, resultOf, targetIsSendable } from './manual-publish-model.ts';
import type { ManualPublishOutcome, ManualPublishPort, PortReadiness, ReadinessRecord } from './manual-publish-port.ts';

// ---- memory of an attempt that may have posted -----------------------------------------------------------------

export type AttemptMemoryEntry = Readonly<{ accountId: string; requestId: string }>;

/**
 * Remembers, per signed-in user and for the life of the app process, an attempt whose outcome is not known to
 * be "not posted". It is written BEFORE the send starts and cleared only by a proven answer (`published` or
 * `rejected`) or by the user's acknowledgement. Leaving the screen mid-send therefore cannot make a second,
 * identical send look safe. (It does not survive an app restart; the server-side idempotency key does.)
 */
export interface AttemptMemory {
  get(userId: string | null): AttemptMemoryEntry | null;
  mark(userId: string, entry: AttemptMemoryEntry): void;
  clear(userId: string): void;
}

export function createAttemptMemory(): AttemptMemory {
  const entries = new Map<string, AttemptMemoryEntry>();
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
 *   - a target the provider cannot take is refused here, before the port (nothing sent);
 *   - a port that throws or answers nonsense is `uncertain` (it may have sent), never `rejected`.
 */
export async function runSend(deps: FlowDeps, args: Readonly<{ userId: string; accountId: string; text: string; requestId: string }>): Promise<ManualPublishOutcome> {
  const { userId, accountId, text, requestId } = args;
  const target = buildTarget(requestId, accountId, text);
  if (!targetIsSendable(target)) return { kind: 'rejected', targetId: requestId, code: 'TARGET_NOT_SENDABLE' };
  deps.memory.mark(userId, { accountId, requestId });
  let outcome: ManualPublishOutcome;
  try {
    outcome = await deps.port.send(target);
  } catch {
    return { kind: 'uncertain', targetId: requestId, code: 'SEND_THREW' };
  }
  const kind = (outcome as { kind?: unknown } | null)?.kind;
  if (kind !== 'published' && kind !== 'rejected' && kind !== 'uncertain') return { kind: 'uncertain', targetId: requestId, code: 'OUTCOME_INVALID' };
  // Clear the memory only for what the screen will show as proven (sent / not posted); anything else stays.
  if (resultOf(requestId, outcome).kind !== 'uncertain') deps.memory.clear(userId);
  return outcome;
}
