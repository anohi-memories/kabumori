// Pure state for the topic list's own level switcher (no RN imports, testable with Deno).
//
// Settings only decides what Home shows (and, once, which level the list opens on). Inside the list every
// level can be browsed: each level has its own in-memory page state, so
//  - only the SELECTED level is ever fetched (never all three eagerly),
//  - switching back to a level that was already loaded restores it without refetching,
//  - "さらに過去" extends only that level,
//  - a slow response of a level the user already left lands in that level's own entry and can never be
//    appended to the level that is on screen now.
// The fetch itself stays the same deterministic fetchDailyTopic(level, date); nothing is persisted here.

import type { HomeTopic, TopicLevel } from './home-topic';

export const TOPIC_LIST_PAGE_DAYS = 14;
export const TOPIC_LIST_MAX_DAYS = 98;

export type TopicListRow = { date: string; topic: HomeTopic | null; failed: boolean };

export type LevelListState = {
  rows: TopicListRow[];
  /** Days already loaded for this level (the next page starts after them). */
  loadedDays: number;
  loading: boolean;
  /** Set once the first page was attempted, so a failed first page is not retried in a loop. */
  attempted: boolean;
  error: boolean;
};

export type TopicListState = Record<TopicLevel, LevelListState>;

const emptyLevel = (): LevelListState => ({ rows: [], loadedDays: 0, loading: false, attempted: false, error: false });

export function createTopicListState(): TopicListState {
  return { beginner: emptyLevel(), intermediate: emptyLevel(), advanced: emptyLevel() };
}

export type TopicListPage = { rows: TopicListRow[]; allFailed: boolean };

/**
 * Loads one page of exactly one level: the given dates (the caller passes the next PAGE_DAYS dates after
 * the level's loaded days, newest first, from topic-history's pastJstDates).
 */
export async function loadTopicListPage(options: {
  level: TopicLevel;
  dates: readonly string[];
  fetchTopic: (level: TopicLevel, jstDate: string) => Promise<HomeTopic | null>;
}): Promise<TopicListPage> {
  const { level, dates, fetchTopic } = options;
  const results = await Promise.allSettled(dates.map((date) => fetchTopic(level, date)));
  const rows = dates.map((date, index): TopicListRow => {
    const result = results[index];
    return result.status === 'fulfilled' ? { date, topic: result.value, failed: false } : { date, topic: null, failed: true };
  });
  return { rows, allFailed: rows.length > 0 && rows.every((row) => row.failed) };
}

/** The first page of a level loads automatically, exactly once (until the level is attempted). */
export function shouldAutoLoad(level: LevelListState): boolean {
  return !level.attempted && !level.loading;
}

export function canLoadMore(level: LevelListState): boolean {
  return !level.loading && level.loadedDays < TOPIC_LIST_MAX_DAYS;
}

/** Marks one level as loading. A level that is already loading is left as is (no double request). */
export function beginLoad(state: TopicListState, level: TopicLevel): TopicListState {
  if (state[level].loading) return state;
  return { ...state, [level]: { ...state[level], loading: true } };
}

/**
 * Applies a loaded page to ITS level only. A page where every date failed does not advance the loaded days,
 * so the same page can be retried; otherwise the days advance by one page and the rows are appended.
 */
export function applyPage(state: TopicListState, level: TopicLevel, page: TopicListPage): TopicListState {
  const current = state[level];
  const next: LevelListState = page.allFailed
    ? { ...current, loading: false, attempted: true, error: true }
    : {
        rows: [...current.rows, ...page.rows],
        loadedDays: current.loadedDays + TOPIC_LIST_PAGE_DAYS,
        loading: false,
        attempted: true,
        error: false,
      };
  return { ...state, [level]: next };
}

/** Rows that can be shown: dates whose topic is missing (or failed) are left out, as before. */
export function visibleRows(level: LevelListState): TopicListRow[] {
  return level.rows.filter((row) => row.topic);
}
