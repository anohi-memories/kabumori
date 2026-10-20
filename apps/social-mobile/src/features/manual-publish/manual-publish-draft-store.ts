// A short-lived copy of the manual X post DRAFT (F1/G1, source-only), so that leaving the screen -- most notably a
// callback route (`oauth-callback` / `auth-callback`) that replaces the screen with the home screen -- does not throw
// away what the person typed (G2 QA U1). It is NOT the record of an unresolved send (that is manual-publish-store.ts,
// which never holds text).
//
// What is stored (and nothing else): the draft text, the chosen X account id (or null), a mark of the sign-in session
// and the time of the last edit. NEVER a token, a consent, a confirmation, a reservation or a clientRequestId. A
// restored draft always starts in the editor: the person must open the confirmation, tick the consent and the send
// gate must be open again; nothing here can make a send happen.
//
// Fail closed, every doubt means "no draft" (and the record is removed):
//   - one record per signed-in user (another user never reads it);
//   - it belongs to ONE sign-in session: after signing out and in again (a new session mark) it is discarded;
//   - it expires 24 hours after the last edit (and a time in the future is not believed);
//   - the chosen account must still be one of the current X accounts and still connected, otherwise the whole draft
//     is discarded; a corrupt / unknown-version / unreadable record is discarded, never trusted;
//   - it is removed when the text is emptied, when a send starts (the text then lives only in that attempt, whose
//     durable record is hash-only), and by the explicit "discard draft" button.
// A write that fails only means the draft is not kept; it never blocks or changes anything else.

import type { SocialAccount } from '../../domain/types.ts';
import { ACCOUNT_RE } from './single-post-contract.ts';
import { USER_RE, type KeyValueStorage } from './manual-publish-store.ts';

export const DRAFT_VERSION = 1;
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A person cannot post more than this; a longer text is not kept at all. */
export const DRAFT_MAX_TEXT_UNITS = 4000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const KEYS = ['accountId', 'savedAt', 'sessionMark', 'text', 'v'].join(',');

export type DraftRecord = Readonly<{ accountId: string | null; text: string; sessionMark: string; savedAt: number }>;

export type DraftRead =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'found'; record: DraftRecord }>
  | Readonly<{ kind: 'unreadable'; reason: 'io' | 'corrupt' | 'version' }>;

export interface DraftStore {
  read(userId: string): Promise<DraftRead>;
  write(userId: string, record: DraftRecord): Promise<boolean>;
  clear(userId: string): Promise<boolean>;
}

export const draftKeyOf = (userId: string) => `postona.manual-publish.draft.v${DRAFT_VERSION}:${userId}`;

function serialize(record: DraftRecord): string {
  // An explicit whitelist: a field added to the type later is NOT stored unless this line is changed on purpose.
  return JSON.stringify({ v: DRAFT_VERSION, accountId: record.accountId, text: record.text, sessionMark: record.sessionMark, savedAt: record.savedAt });
}

export function parseDraft(raw: string): DraftRead {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable', reason: 'corrupt' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'unreadable', reason: 'corrupt' };
  const v = value as Record<string, unknown>;
  if (typeof v.v === 'number' && v.v !== DRAFT_VERSION) return { kind: 'unreadable', reason: 'version' };
  if (Object.keys(v).sort().join(',') !== KEYS || v.v !== DRAFT_VERSION) return { kind: 'unreadable', reason: 'corrupt' };
  const { accountId, text, sessionMark, savedAt } = v;
  if (
    !(accountId === null || (typeof accountId === 'string' && ACCOUNT_RE.test(accountId))) ||
    typeof text !== 'string' || text.length > DRAFT_MAX_TEXT_UNITS ||
    typeof sessionMark !== 'string' || sessionMark.length > 64 ||
    typeof savedAt !== 'number' || !Number.isFinite(savedAt)
  ) return { kind: 'unreadable', reason: 'corrupt' };
  return { kind: 'found', record: { accountId, text, sessionMark, savedAt } };
}

/**
 * Writes are applied strictly in the order they were asked for, one at a time, and a read waits for the writes before
 * it: so "type, type, empty" can never end with the older text on the device.
 */
export function createDraftStore(storage: KeyValueStorage): DraftStore {
  let tail: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  return {
    read: (userId) => inOrder(async () => {
      if (!USER_RE.test(userId)) return { kind: 'unreadable', reason: 'corrupt' } as const;
      let raw: string | null;
      try {
        raw = await storage.getItem(draftKeyOf(userId));
      } catch {
        return { kind: 'unreadable', reason: 'io' } as const;
      }
      if (raw === null) return { kind: 'none' } as const;
      if (typeof raw !== 'string') return { kind: 'unreadable', reason: 'corrupt' } as const;
      return parseDraft(raw);
    }),
    write: (userId, record) => inOrder(async () => {
      if (!USER_RE.test(userId)) return false;
      try {
        await storage.setItem(draftKeyOf(userId), serialize(record));
        return true;
      } catch {
        return false;
      }
    }),
    clear: (userId) => inOrder(async () => {
      if (!USER_RE.test(userId)) return false;
      try {
        await storage.removeItem(draftKeyOf(userId));
        return true;
      } catch {
        return false;
      }
    }),
  };
}

export type DraftDiscardReason = 'empty' | 'expired' | 'future' | 'other_session' | 'account_missing' | 'account_disconnected' | 'unreadable';

export type RestoreDecision =
  | Readonly<{ kind: 'restore'; text: string; accountId: string | null }>
  | Readonly<{ kind: 'discard'; reason: DraftDiscardReason }>;

/** Whether a stored draft may be put back into the editor now. Pure: every input is passed in. */
export function decideRestore(
  record: DraftRecord,
  now: { at: number; sessionMark: string; xAccounts: readonly SocialAccount[] },
): RestoreDecision {
  if (record.text.trim() === '') return { kind: 'discard', reason: 'empty' };
  if (record.savedAt > now.at + FUTURE_TOLERANCE_MS) return { kind: 'discard', reason: 'future' };
  if (now.at - record.savedAt > DRAFT_MAX_AGE_MS) return { kind: 'discard', reason: 'expired' };
  if (record.sessionMark !== now.sessionMark) return { kind: 'discard', reason: 'other_session' };
  if (record.accountId !== null) {
    const account = now.xAccounts.find((candidate) => candidate.id === record.accountId && candidate.platform === 'x');
    if (account === undefined) return { kind: 'discard', reason: 'account_missing' };
    if (account.connectionStatus === 'not_connected') return { kind: 'discard', reason: 'account_disconnected' };
  }
  return { kind: 'restore', text: record.text, accountId: record.accountId };
}

/**
 * Read the stored draft and decide. Anything that is not restored is removed from the device. Never throws. The
 * caller passes the CURRENT X accounts, so it must not call this while the account list is still loading.
 */
export async function loadDraftForRestore(
  drafts: DraftStore,
  userId: string,
  now: { at: number; sessionMark: string; xAccounts: readonly SocialAccount[] },
): Promise<RestoreDecision | Readonly<{ kind: 'none' }>> {
  let read: DraftRead;
  try {
    read = await drafts.read(userId);
  } catch {
    read = { kind: 'unreadable', reason: 'io' };
  }
  if (read.kind === 'none') return { kind: 'none' };
  const decision: RestoreDecision = read.kind === 'found' ? decideRestore(read.record, now) : { kind: 'discard', reason: 'unreadable' };
  if (decision.kind === 'discard') {
    try {
      await drafts.clear(userId);
    } catch {
      // a record that cannot be removed is still never restored
    }
  }
  return decision;
}
