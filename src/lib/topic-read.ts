// Local-device "learned" state for the topic list (no RN imports, so it is testable with Deno; the
// AsyncStorage binding lives in topic-read-storage.ts). Learning progress is stored on this device only:
// no Supabase table, no RPC, no account sync, no network.
//
// Identity: `topic.id` is public.tips.id (get_daily_kabumori_tip returns the tips row; the pick is a hash of
// date+level over the active rows ordered by id). The same row therefore comes back, with the same id, on
// different dates, so learning a topic once keeps it learned wherever it reappears -- the user intent is
// learning progress, not "this exact dated row was tapped". The id alone is the key (a tip has exactly one
// difficulty, so adding the level would only reset progress if a tip were ever re-levelled).

import type { KeyValueStorage } from './home-topic';

export const TOPIC_READ_STORAGE_KEY = 'kabumori:topic-read:v1';

/** Small and bounded: the newest ids win, the oldest fall off. */
export const TOPIC_READ_MAX = 500;

const MAX_ID_LENGTH = 100;

/** Parses the stored JSON array of ids. Missing, corrupt or wrongly-shaped data is simply "nothing read yet". */
export function parseReadIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const id = entry.trim();
      if (!id || id.length > MAX_ID_LENGTH || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids.slice(-TOPIC_READ_MAX);
  } catch {
    return [];
  }
}

/** Adds one id: deduplicated (an existing id just moves to the newest position) and bounded. */
export function addReadId(ids: readonly string[], id: string): string[] {
  const clean = id.trim();
  if (!clean || clean.length > MAX_ID_LENGTH) return [...ids];
  return [...ids.filter((existing) => existing !== clean), clean].slice(-TOPIC_READ_MAX);
}

export function isTopicRead(readIds: ReadonlySet<string>, id: string): boolean {
  return readIds.has(id);
}

export type TopicReadStore = {
  /** All learned ids; an unreadable store is an empty set. */
  read(): Promise<Set<string>>;
  /** Marks one topic learned. Resolves to whether the write succeeded; never throws. */
  mark(id: string): Promise<boolean>;
};

/**
 * Store over any KeyValueStorage. Writes are serialized, so two marks that happen close together (e.g. quick
 * level switches in the detail) are both kept instead of overwriting each other.
 */
export function createTopicReadStore(storage: KeyValueStorage): TopicReadStore {
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<string[]> => {
    try {
      return parseReadIds(await storage.getItem(TOPIC_READ_STORAGE_KEY));
    } catch {
      return [];
    }
  };

  return {
    read: async () => new Set(await load()),
    mark: (id) => {
      const run = async (): Promise<boolean> => {
        try {
          const next = addReadId(await load(), id);
          await storage.setItem(TOPIC_READ_STORAGE_KEY, JSON.stringify(next));
          return true;
        } catch {
          return false;
        }
      };
      const result = queue.then(run, run);
      queue = result;
      return result;
    },
  };
}
