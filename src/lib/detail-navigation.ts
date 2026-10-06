// Navigation model of the detail screens (no RN imports, testable with Deno).
//
// Left = a contextual 「‹ 戻る」, right = an always-available list (トピック一覧 / ニュース一覧).
//
// Back is resolved from an EXPLICIT origin that the entry point passes as the `from` route param
// (home | topics | news), not from whatever the navigation stack happens to contain -- the nested news
// stack makes the visual origin differ from the real predecessor. A missing or unknown origin (a cold deep
// link, a report, anything else) falls back safely to Home. The list action ignores the origin entirely.
// The origin lives only in the route params: nothing is stored, nothing touches the backend.
//
// dismissTo(href) is expo-router's POP_TO: if the target already sits below in the current stack it pops
// straight back to it (no stacked copies, no Home <-> detail <-> list loop); if it does not (a deep link,
// a notification), it replaces the current screen with the target instead of failing.

import type { TopicLevel } from './home-topic';

export const HOME_ROUTE = '/';
export const TOPICS_ROUTE = '/topics';
export const NEWS_LIST_ROUTE = '/news';

export type DetailOrigin = 'home' | 'topics' | 'news';

/** Name of the route param carrying the origin. */
export const DETAIL_ORIGIN_PARAM = 'from';

/** Reads the `from` param (a string, or the first of an array); null for anything that is not a known origin. */
export function parseDetailOrigin(value: unknown): DetailOrigin | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'home' || raw === 'topics' || raw === 'news' ? raw : null;
}

/** Where the topic detail's 「戻る」 goes: the topic list only when it was opened from it, otherwise Home. */
export function topicBackTarget(from: unknown): 'home' | 'topics' {
  return parseDetailOrigin(from) === 'topics' ? 'topics' : 'home';
}

/** Where the news detail's 「戻る」 goes: the news list only when it was opened from it, otherwise Home. */
export function newsBackTarget(from: unknown): 'home' | 'news' {
  return parseDetailOrigin(from) === 'news' ? 'news' : 'home';
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

export type NewsHomeRouter = {
  canDismiss(): boolean;
  dismissAll(): void;
  navigate(href: '/'): void;
};

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

// The news detail lives in the news tab's own nested stack, so dismissTo('/') cannot reach the Home tab from
// there (Simulator-verified: it does nothing). Instead the tab's stack is first emptied back to the list --
// so no detail stays behind when the news tab is opened later -- and then the Home tab is selected.
// replace('/') would stack a second (tabs) copy, and navigate('/') alone would leave the detail open.
export function goHomeFromNews(router: NewsHomeRouter): void {
  if (router.canDismiss()) router.dismissAll();
  router.navigate(HOME_ROUTE);
}

/** Topic detail 「‹ 戻る」: the origin's screen (Home, or the topic list); Home when the origin is unknown. */
export function backFromTopicDetail(router: DismissRouter, from: unknown): void {
  if (topicBackTarget(from) === 'topics') goTopicList(router);
  else goHome(router);
}

/** News detail 「‹ 戻る」: the origin's screen (Home, or the news list); Home when the origin is unknown. */
export function backFromNewsDetail(router: DismissRouter & NewsHomeRouter, from: unknown): void {
  if (newsBackTarget(from) === 'news') goNewsList(router);
  else goHomeFromNews(router);
}

// ---- native back gesture parity -------------------------------------------------------------------------
// The iOS edge swipe pops the screen natively, so on its own it goes to whatever sits below in the stack
// (the news list for a Home-origin news detail), which can differ from 「‹ 戻る」. The detail therefore
// prevents the native removal and re-resolves it through the same origin-based function the button uses.
// Only a back gesture / back action is redirected; the screen's own explicit navigation (POP_TO, POP_TO_TOP,
// NAVIGATE, REPLACE ...) must pass through untouched or it would be caught in a loop.

/** Navigation action types produced by an edge swipe (POP) or a back action (GO_BACK). */
export const NATIVE_BACK_ACTION_TYPES: readonly string[] = ['POP', 'GO_BACK'];

export function isNativeBackAction(actionType: unknown): boolean {
  return typeof actionType === 'string' && NATIVE_BACK_ACTION_TYPES.includes(actionType);
}

/** What the detail does with a removal it was asked to allow: redirect a back gesture, let anything else pass. */
export function decideDetailRemoval(actionType: unknown): 'redirect-to-back' | 'allow' {
  return isNativeBackAction(actionType) ? 'redirect-to-back' : 'allow';
}
