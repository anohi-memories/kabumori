// Durable record of an UNRESOLVED manual X post attempt (F1, M2, source-only). The in-process memory of the
// flow is lost when the app restarts; this record is what lets the next launch know that an earlier attempt
// may have reached X, so a second, identical post is not offered by accident.
//
// What is stored (and nothing else): the attempt id (the server's idempotency key), the account id, the SHA-256
// of the exact text, the kind of the unresolved state and the time it was saved. NEVER the post text, a token, a
// consent flag or anything from the server. Consequence: after a restart the text is not known; the user types
// the same text again and, only if its hash equals the stored one, the SAME attempt id can be re-asked (the F3
// server answers the stored state of that id and never sends twice).
//
// What this record is NOT: proof. It cannot show that a post was made or was not made. It only makes the screen
// fail closed. Every doubt is a block:
//   - a write must be read back identical before a send is allowed (a silent or failed write => no send);
//   - an unreadable, corrupt or unknown-version record => no send until the record is read, or (corrupt) cleared
//     by an explicit "I checked X" action; it is never ignored and never deleted silently;
//   - there is no expiry: an old record blocks exactly like a new one;
//   - one record per signed-in user; another user (or a new sign-in of another person) never sees it.
// The storage itself is injected (the app passes AsyncStorage in manual-publish-storage.ts), so the logic is
// proven offline with a fake that can fail in every way.

import type { UnresolvedKind } from './manual-publish-model.ts';
import { ACCOUNT_RE, SHA_RE, UUID_RE } from './single-post-contract.ts';

export type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type PersistedAttempt = Readonly<{
  accountId: string;
  requestId: string;
  contentSha256: string;
  kind: UnresolvedKind;
  savedAt: number;
}>;

export type StoreRead =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'found'; attempt: PersistedAttempt }>
  | Readonly<{ kind: 'unreadable'; reason: 'io' | 'corrupt' | 'version' }>;

export interface AttemptStore {
  read(userId: string): Promise<StoreRead>;
  /** True only when the record was written AND read back identical. */
  write(userId: string, attempt: PersistedAttempt): Promise<boolean>;
  /** True only when the record is gone (read back as absent). */
  clear(userId: string): Promise<boolean>;
}

export const STORE_VERSION = 1;
const KINDS: readonly UnresolvedKind[] = ['in_flight', 'pending', 'unconfirmed', 'uncertain'];
const KEYS = ['accountId', 'contentSha256', 'kind', 'requestId', 'savedAt', 'v'].join(',');
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/u;

export const storeKeyOf = (userId: string) => `postona.manual-publish.unresolved.v${STORE_VERSION}:${userId}`;

function serialize(attempt: PersistedAttempt): string {
  // An explicit whitelist: a field added to the type later is NOT stored unless this line is changed on purpose.
  return JSON.stringify({ v: STORE_VERSION, accountId: attempt.accountId, requestId: attempt.requestId, contentSha256: attempt.contentSha256, kind: attempt.kind, savedAt: attempt.savedAt });
}

export function parseStored(raw: string): StoreRead {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable', reason: 'corrupt' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'unreadable', reason: 'corrupt' };
  const v = value as Record<string, unknown>;
  if (typeof v.v === 'number' && v.v !== STORE_VERSION) return { kind: 'unreadable', reason: 'version' };
  if (Object.keys(v).sort().join(',') !== KEYS || v.v !== STORE_VERSION) return { kind: 'unreadable', reason: 'corrupt' };
  const { accountId, requestId, contentSha256, kind, savedAt } = v;
  if (
    typeof accountId !== 'string' || !ACCOUNT_RE.test(accountId) ||
    typeof requestId !== 'string' || !UUID_RE.test(requestId) ||
    typeof contentSha256 !== 'string' || !SHA_RE.test(contentSha256) ||
    typeof kind !== 'string' || !KINDS.includes(kind as UnresolvedKind) ||
    typeof savedAt !== 'number' || !Number.isFinite(savedAt)
  ) return { kind: 'unreadable', reason: 'corrupt' };
  return { kind: 'found', attempt: { accountId, requestId, contentSha256, kind: kind as UnresolvedKind, savedAt } };
}

export function createAttemptStore(storage: KeyValueStorage): AttemptStore {
  return {
    async read(userId) {
      if (!USER_RE.test(userId)) return { kind: 'unreadable', reason: 'corrupt' };
      let raw: string | null;
      try {
        raw = await storage.getItem(storeKeyOf(userId));
      } catch {
        return { kind: 'unreadable', reason: 'io' };
      }
      if (raw === null) return { kind: 'none' };
      if (typeof raw !== 'string') return { kind: 'unreadable', reason: 'corrupt' };
      return parseStored(raw);
    },
    async write(userId, attempt) {
      if (!USER_RE.test(userId)) return false;
      const key = storeKeyOf(userId);
      const value = serialize(attempt);
      try {
        await storage.setItem(key, value);
        return (await storage.getItem(key)) === value;
      } catch {
        return false;
      }
    },
    async clear(userId) {
      if (!USER_RE.test(userId)) return false;
      const key = storeKeyOf(userId);
      try {
        await storage.removeItem(key);
        return (await storage.getItem(key)) === null;
      } catch {
        return false;
      }
    },
  };
}
