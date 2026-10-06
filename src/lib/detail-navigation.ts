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

export type DismissRouter = { dismissTo(href: '/' | '/topics' | '/news'): void };

export type NewsHomeRouter = {
  canDismiss(): boolean;
  dismissAll(): void;
  navigate(href: '/'): void;
};

export function goHome(router: DismissRouter): void {
  router.dismissTo(HOME_ROUTE);
}

export function goTopicList(router: DismissRouter): void {
  router.dismissTo(TOPICS_ROUTE);
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
