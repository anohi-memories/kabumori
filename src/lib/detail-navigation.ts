// Navigation model of the detail screens (no RN imports, testable with Deno).
//
// Left = a contextual 「‹ 戻る」, right = an always-available list (トピック一覧 / ニュース一覧).
//
// Both details (topic and news) are routes of the ROOT stack, above the tabs. That is what makes the native
// edge swipe and the 戻る button agree: popping a root screen reveals exactly the screen it was opened from
// (Home, the topic list, the news tab's list, a report) with no screen in between, so a swipe can never
// reveal a list that 戻る would skip.
//
// 戻る is still resolved from an EXPLICIT origin that the entry point passes as the `from` route param
// (home | topics | news | reports), never from stack inspection. A missing or unknown origin (a cold deep
// link) falls back safely to Home. The list action ignores the origin entirely. The origin lives only in the
// route params: nothing is stored, nothing touches the backend.
//
// dismissTo(href) is expo-router's POP_TO: if the target already sits below in the current stack it pops
// straight back to it (no stacked copies, no Home <-> detail <-> list loop); if it does not (a deep link,
// a notification), it replaces the current screen with the target instead of failing.

import type { TopicLevel } from './home-topic';

export const HOME_ROUTE = '/';
export const TOPICS_ROUTE = '/topics';
export const NEWS_LIST_ROUTE = '/news';
export const NEWS_DETAIL_ROUTE = '/news-detail';

export type DetailOrigin = 'home' | 'topics' | 'news' | 'reports';

/** Name of the route param carrying the origin. */
export const DETAIL_ORIGIN_PARAM = 'from';

/** Reads the `from` param (a string, or the first of an array); null for anything that is not a known origin. */
export function parseDetailOrigin(value: unknown): DetailOrigin | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'home' || raw === 'topics' || raw === 'news' || raw === 'reports' ? raw : null;
}

/** Where the topic detail's 「戻る」 goes: the topic list only when it was opened from it, otherwise Home. */
export function topicBackTarget(from: unknown): 'home' | 'topics' {
  return parseDetailOrigin(from) === 'topics' ? 'topics' : 'home';
}

/**
 * Where the news detail's 「戻る」 goes: the news list when it was opened from it, the report when it was
 * opened from a report, otherwise Home (Home cards, an unknown origin, a cold deep link).
 */
export function newsBackTarget(from: unknown): 'home' | 'news' | 'report' {
  const origin = parseDetailOrigin(from);
  if (origin === 'news') return 'news';
  if (origin === 'reports') return 'report';
  return 'home';
}

/**
 * The topic list can be opened on a specific level (the level currently viewed in a detail). `req` is a
 * fresh request id: asking for the same level twice is still a new request, so the list applies it again.
 */
export type TopicListHref = { pathname: '/topics'; params: { level: TopicLevel; req: string } };

export type DismissHref = '/' | '/topics' | '/news' | TopicListHref;

export type DismissRouter = { dismissTo(href: DismissHref): void };

export function topicListRouteParams(level: TopicLevel, now: number = Date.now()): TopicListHref['params'] {
  return { level, req: String(now) };
}

export function goHome(router: DismissRouter): void {
  router.dismissTo(HOME_ROUTE);
}

/**
 * The topic list. With a level it opens (or reveals) the list on that level -- the detail's right-hand
 * 「トピック一覧 ›」 passes the level being viewed. Without one the list is revealed as it is, keeping
 * whatever level and loaded rows it already has (the origin-based 戻る uses this form).
 */
export function goTopicList(router: DismissRouter, level?: TopicLevel | null): void {
  if (level) router.dismissTo({ pathname: TOPICS_ROUTE, params: topicListRouteParams(level) });
  else router.dismissTo(TOPICS_ROUTE);
}

export function goNewsList(router: DismissRouter): void {
  router.dismissTo(NEWS_LIST_ROUTE);
}

/** Topic detail 「‹ 戻る」: the origin's screen (Home, or the topic list); Home when the origin is unknown. */
export function backFromTopicDetail(router: DismissRouter, from: unknown): void {
  if (topicBackTarget(from) === 'topics') goTopicList(router);
  else goHome(router);
}

/**
 * News detail 「‹ 戻る」: the origin's screen -- Home, the news list, or the report it was opened from; Home
 * when the origin is unknown. A report is a dynamic route that the origin param does not identify, so for it
 * the one root screen above the report is popped: the origin is explicit (`from=reports`) and, with the
 * detail on the root stack, the predecessor is the report by construction.
 */
export function backFromNewsDetail(router: DismissRouter & { back(): void }, from: unknown): void {
  const target = newsBackTarget(from);
  if (target === 'news') goNewsList(router);
  else if (target === 'report') router.back();
  else goHome(router);
}

// ---- deep links ---------------------------------------------------------------------------------------------
// `kabumori://news/<id>` (and a bare `/news/<id>`) used to land on a nested news-tab route. The detail now
// lives on the root stack, so incoming links are rewritten to it; the news list (`/news`) is untouched.
const NEWS_DETAIL_LINK = /^(?:[a-z][a-z0-9+.-]*:\/\/)?\/?news\/([^/?#]+)(?:[?#].*)?$/i;

/** The root-stack route for a `news/<id>` link, or null when the link is anything else. */
export function newsDetailRedirectPath(path: string): string | null {
  const match = NEWS_DETAIL_LINK.exec(path);
  if (!match) return null;
  return `${NEWS_DETAIL_ROUTE}?id=${match[1]}`;
}
