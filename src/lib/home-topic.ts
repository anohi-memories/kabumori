// Pure contract + logic for the home "今日のトピック" card and its level
// preference. Storage access is injectable (a minimal getItem/setItem
// interface) so every rule here -- fail-soft defaults, "never claim a
// failed write succeeded", difficulty mapping, RPC row validation -- is
// directly testable with an in-memory mock, without importing AsyncStorage
// or the Supabase client. This module has no RN imports so it can be tested
// with Deno and bundled by Metro.

export type TopicLevel = 'beginner' | 'intermediate' | 'advanced';

export const TOPIC_LEVELS: readonly TopicLevel[] = ['beginner', 'intermediate', 'advanced'];

export const TOPIC_LEVEL_LABEL: Record<TopicLevel, string> = {
  beginner: '初心者向け',
  intermediate: '中級者向け',
  advanced: '上級者向け',
};

export const TOPIC_LEVEL_HINT: Record<TopicLevel, string> = {
  beginner: '基本用語や仕組みをやさしく',
  intermediate: '指標・需給・決算など一歩踏み込む',
  advanced: '実践的な材料の読み方や相場とのつながり',
};

export type HomeTopic = {
  id: string;
  level: TopicLevel;
  category: string | null;
  title: string;
  body: string;
};

// The DB's public.tips.difficulty values, distinct from the app's TopicLevel
// -- kept as its own map (not string-keyed guessing) so an unrecognized DB
// value is rejected rather than silently coerced.
const DIFFICULTY_TO_LEVEL: Record<string, TopicLevel> = {
  '初級': 'beginner',
  '中級': 'intermediate',
  '実践': 'advanced',
};

export function isTopicLevel(value: unknown): value is TopicLevel {
  return typeof value === 'string' && (TOPIC_LEVELS as readonly string[]).includes(value);
}

/** Maps a stored public.tips.difficulty value to the app's TopicLevel; null for anything else. */
export function mapDifficultyToLevel(difficulty: unknown): TopicLevel | null {
  return typeof difficulty === 'string' ? DIFFICULTY_TO_LEVEL[difficulty] ?? null : null;
}

export const TOPIC_LEVEL_STORAGE_KEY = 'kabumori:topic-level:v1';

export type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

/**
 * Reads the stored level preference. Fails soft to 'beginner' -- the default
 * -- on a read error, a missing value, or a malformed/unrecognized stored
 * string, exactly like useOnboardingV1's "never trap the user" rule.
 */
export async function readTopicLevelFrom(storage: KeyValueStorage): Promise<TopicLevel> {
  try {
    const value = await storage.getItem(TOPIC_LEVEL_STORAGE_KEY);
    return isTopicLevel(value) ? value : 'beginner';
  } catch {
    return 'beginner';
  }
}

/**
 * Writes the level preference. Returns whether the write actually
 * succeeded -- callers must not tell the user "saved" on a false return,
 * per this task's explicit "do not misreport a failed write" requirement.
 */
export async function writeTopicLevelTo(storage: KeyValueStorage, level: TopicLevel): Promise<boolean> {
  try {
    await storage.setItem(TOPIC_LEVEL_STORAGE_KEY, level);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates one row from get_daily_kabumori_tip into a HomeTopic, or null if
 * the shape is unusable. Never invents a title/body: an empty/whitespace
 * base_text or title is treated the same as no row.
 */
export function parseDailyTipRow(row: unknown): HomeTopic | null {
  if (!row || typeof row !== 'object') return null;
  const candidate = row as Record<string, unknown>;
  const level = mapDifficultyToLevel(candidate.difficulty);
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
  const body = typeof candidate.base_text === 'string' ? candidate.base_text.trim() : '';
  const category = typeof candidate.category === 'string' && candidate.category.trim() ? candidate.category.trim() : null;
  if (!level || !id || !title || !body) return null;
  return { id, level, category, title, body };
}

export type TopicCardStatus = 'loading' | 'error' | 'topic' | 'empty';

/**
 * Same explicit-branch shape as the report hero's reportCardStatus: a fetch
 * error must never be shown as "準備中" (the honest no-topic-yet state).
 */
export function topicCardStatus(hasTopic: boolean, loading: boolean, error: string): TopicCardStatus {
  if (loading && !hasTopic) return 'loading';
  if (!hasTopic && error) return 'error';
  if (hasTopic) return 'topic';
  return 'empty';
}

/** Identifies which (level, JST date) a loaded topic was fetched for. */
export type TopicRequestKey = {
  level: TopicLevel;
  jstDate: string;
};

/**
 * A loaded topic may only keep being shown as current if it was fetched for
 * exactly today's date and the currently selected level. Changing the level,
 * or the JST date rolling over while the app stays mounted, must never leave
 * a stale topic on screen looking current -- even if a later refresh for the
 * new key fails. A same-key refresh failure is allowed to keep showing the
 * already-loaded topic (that's the ordinary "stale is better than a scary
 * error" tradeoff already used by the report hero).
 */
export function topicKeyMatches(loaded: TopicRequestKey | null, current: TopicRequestKey): boolean {
  return loaded !== null && loaded.level === current.level && loaded.jstDate === current.jstDate;
}
