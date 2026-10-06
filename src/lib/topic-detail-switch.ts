// Pure logic for switching the level on the topic detail screen (no RN imports, so it is testable with
// Deno and bundled by Metro). Switching is a viewing aid inside the open detail: it resolves the
// deterministic (level, SAME jstDate) topic through the existing read-only fetch, keeps what was already
// loaded in a small in-memory cache, and never touches the Settings level preference that drives Home.

import type { DetailOrigin } from './detail-navigation';
import type { HomeTopic, TopicLevel } from './home-topic';

/** Compact labels for the 3-way selector (the Hero badge keeps the longer 初心者向け wording). */
export const TOPIC_SWITCH_LEVELS: readonly { level: TopicLevel; label: string }[] = [
  { level: 'beginner', label: '初級' },
  { level: 'intermediate', label: '中級' },
  { level: 'advanced', label: '上級' },
];

/** In-memory (per open screen) cache keyed by date + level. Never persisted. */
export type TopicViewCache = {
  get(jstDate: string, level: TopicLevel): HomeTopic | undefined;
  set(jstDate: string, topic: HomeTopic): void;
};

export function createTopicViewCache(): TopicViewCache {
  const entries = new Map<string, HomeTopic>();
  const key = (jstDate: string, level: TopicLevel) => `${jstDate}|${level}`;
  return {
    get: (jstDate, level) => entries.get(key(jstDate, level)),
    set: (jstDate, topic) => {
      entries.set(key(jstDate, topic.level), topic);
    },
  };
}

/** Tapping the level that is already shown does nothing (no fetch, no route change). */
export function decideLevelSwitch(active: TopicLevel, target: TopicLevel): 'noop' | 'switch' {
  return active === target ? 'noop' : 'switch';
}

export type TopicSwitchResult =
  | { ok: true; topic: HomeTopic; fromCache: boolean }
  | { ok: false; reason: 'error' | 'unavailable' };

/**
 * Resolves the topic for `level` on exactly `jstDate` (never "today" unless that is the date being viewed).
 * A cached topic is returned without a network call. A fetched topic must really be the requested level,
 * otherwise it is treated as unavailable. Failures never throw: the caller keeps the current content.
 */
export async function resolveTopicForLevel(options: {
  level: TopicLevel;
  jstDate: string;
  cache: TopicViewCache;
  fetchTopic: (level: TopicLevel, jstDate: string) => Promise<HomeTopic | null>;
}): Promise<TopicSwitchResult> {
  const { level, jstDate, cache, fetchTopic } = options;
  const cached = cache.get(jstDate, level);
  if (cached) return { ok: true, topic: cached, fromCache: true };
  try {
    const topic = await fetchTopic(level, jstDate);
    if (!topic || topic.level !== level) return { ok: false, reason: 'unavailable' };
    cache.set(jstDate, topic);
    return { ok: true, topic, fromCache: false };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * The exact route params of a displayed topic: its real id, its real level and the date being viewed. The
 * origin (`from`, how the screen was opened) is carried over unchanged so 「戻る」 keeps working after a switch.
 */
export function topicDetailRouteParams(
  topic: HomeTopic,
  jstDate: string,
  origin: DetailOrigin | null = null,
): { id: string; level: TopicLevel; jstDate: string; from?: DetailOrigin } {
  const params = { id: topic.id, level: topic.level, jstDate };
  return origin ? { ...params, from: origin } : params;
}

export function topicSwitchErrorMessage(level: TopicLevel): string {
  const label = TOPIC_SWITCH_LEVELS.find((entry) => entry.level === level)?.label ?? '';
  return `${label}のトピックを取得できませんでした。表示中の内容はそのままです。`;
}
