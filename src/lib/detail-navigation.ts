// Explicit destinations for detail screens (no RN imports, testable with Deno). The detail screens must
// guarantee these destinations whichever entry opened them -- Home card, a list, a push notification or a
// cold deep link -- so none of this may depend on router.back()/router.canGoBack() or on the history that
// happened to exist.
//
// dismissTo(href) is expo-router's POP_TO: if the target already sits below in the current stack it pops
// straight back to it (no stacked copies, no Home <-> detail <-> list loop); if it does not (a deep link, a
// notification), it replaces the current screen with the target instead of failing.

export const HOME_ROUTE = '/';
export const TOPICS_ROUTE = '/topics';
export const NEWS_LIST_ROUTE = '/news';

export type DismissRouter = { dismissTo(href: '/' | '/topics' | '/news'): void };

export function goHome(router: DismissRouter): void {
  router.dismissTo(HOME_ROUTE);
}

export function goPastTopics(router: DismissRouter): void {
  router.dismissTo(TOPICS_ROUTE);
}

export function goNewsList(router: DismissRouter): void {
  router.dismissTo(NEWS_LIST_ROUTE);
}

export type NewsHomeRouter = {
  canDismiss(): boolean;
  dismissAll(): void;
  navigate(href: '/'): void;
};

// The news detail lives in the news tab's own nested stack, so dismissTo('/') cannot reach the Home tab from
// there (Simulator-verified: it does nothing). Instead the tab's stack is first emptied back to the list --
// so no detail stays behind when the news tab is opened later -- and then the Home tab is selected.
// replace('/') would stack a second (tabs) copy, and navigate('/') alone would leave the detail open.
export function goHomeFromNews(router: NewsHomeRouter): void {
  if (router.canDismiss()) router.dismissAll();
  router.navigate(HOME_ROUTE);
}
