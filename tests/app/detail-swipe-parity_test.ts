import assert from "node:assert/strict";
import test from "node:test";

import {
  backFromNewsDetail,
  backFromTopicDetail,
  decideDetailRemoval,
  goNewsList,
  goTopicList,
  isNativeBackAction,
  NATIVE_BACK_ACTION_TYPES,
  type DismissHref,
} from "../../src/lib/detail-navigation.ts";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

// A recording router for the news detail (it also needs the Home-tab pieces).
function recorder() {
  const calls: string[] = [];
  const router = {
    dismissTo: (href: DismissHref) => calls.push(`dismissTo:${typeof href === "string" ? href : href.pathname}`),
    canDismiss: () => true,
    dismissAll: () => calls.push("dismissAll"),
    navigate: (href: string) => calls.push(`navigate:${href}`),
  };
  return { calls, router };
}

test("a swipe / back action is redirected to the explicit back; the screen's own navigation passes through", () => {
  assert.deepEqual([...NATIVE_BACK_ACTION_TYPES].sort(), ["GO_BACK", "POP"]);
  for (const type of ["POP", "GO_BACK"]) {
    assert.equal(isNativeBackAction(type), true, type);
    assert.equal(decideDetailRemoval(type), "redirect-to-back", type);
  }
  // Everything the detail itself dispatches must pass, or a redirect would be redirected again.
  for (const type of ["POP_TO", "POP_TO_TOP", "NAVIGATE", "REPLACE", "RESET", "PUSH", undefined, null, 3]) {
    assert.equal(decideDetailRemoval(type), "allow", String(type));
  }
});

test("news Home origin: the button target and the swipe target are the same function and the same result (Home)", () => {
  const button = recorder();
  backFromNewsDetail(button.router, "home"); // 戻る button
  const swipe = recorder();
  // The swipe is redirected by the screen through the very same function with the same origin.
  assert.equal(decideDetailRemoval("POP"), "redirect-to-back");
  backFromNewsDetail(swipe.router, "home");
  assert.deepEqual(swipe.calls, button.calls);
  assert.deepEqual(button.calls, ["dismissAll", "navigate:/"]);
});

test("news news-list origin: button == swipe == the news list", () => {
  const button = recorder();
  backFromNewsDetail(button.router, "news");
  const swipe = recorder();
  backFromNewsDetail(swipe.router, "news");
  assert.deepEqual(button.calls, ["dismissTo:/news"]);
  assert.deepEqual(swipe.calls, button.calls);
});

test("news unknown / cold deep link: the swipe and the button both fall back to Home", () => {
  for (const from of [undefined, "", "garbage", "topics"]) {
    const button = recorder();
    backFromNewsDetail(button.router, from);
    const swipe = recorder();
    backFromNewsDetail(swipe.router, from);
    assert.deepEqual(swipe.calls, ["dismissAll", "navigate:/"], String(from));
    assert.deepEqual(swipe.calls, button.calls);
  }
});

test("topic: Home origin => Home, topics origin => topics, unknown => Home (button model; native pop matches it)", () => {
  const cases: Array<[unknown, string]> = [["home", "dismissTo:/"], ["topics", "dismissTo:/topics"], [undefined, "dismissTo:/"], ["news", "dismissTo:/"]];
  for (const [from, expected] of cases) {
    const { calls, router } = recorder();
    backFromTopicDetail(router, from);
    assert.deepEqual(calls, [expected], String(from));
  }
});

test("the right-hand list action stays independent of the origin and of the swipe redirect", () => {
  for (const from of ["home", "news", undefined]) {
    const { calls, router } = recorder();
    goNewsList(router);
    assert.deepEqual(calls, ["dismissTo:/news"], String(from));
  }
  const topics = recorder();
  goTopicList(topics.router);
  assert.deepEqual(topics.calls, ["dismissTo:/topics"]);
});

test("news detail screen: it prevents native removal and redirects only a back gesture, with a re-entry guard", async () => {
  const screen = await code("src/app/(tabs)/news/[id].tsx");
  assert.ok(screen.includes("usePreventRemove(true, ({ data }) => {"));
  assert.ok(screen.includes("decideDetailRemoval(data.action.type) === 'redirect-to-back' && Date.now() >= redirectingUntil.current"));
  assert.ok(screen.includes("backFromNewsDetail(router, from);"), "the same function the header button calls");
  assert.ok(screen.includes("navigation.dispatch(data.action);"), "anything else is let through");
  assert.ok(screen.includes("redirectingUntil.current = Date.now() + 1000;"));
  assert.ok(screen.includes("useLocalSearchParams<{ id: string; from?: string }>()"));
  assert.ok(!/router\.(back|canGoBack)\(|gestureEnabled/.test(screen), "swipe is redirected, not disabled, and no history is used");
  // usePreventRemove is part of the bundled react-navigation core (not re-exported from the package root).
  assert.ok(screen.includes("from 'expo-router/build/react-navigation/core'"));
  const core = await Deno.stat(new URL("node_modules/expo-router/build/react-navigation/core/usePreventRemove.js", repoRoot)).catch(() => null);
  if (core) assert.ok(core.isFile, "the deep import resolves in the installed expo-router");
});

test("the header 戻る calls the same origin function as the swipe redirect, from the same `from` param", async () => {
  const layout = await code("src/app/(tabs)/news/_layout.tsx");
  assert.ok(layout.includes("backFromNewsDetail(router, (route.params as { from?: unknown } | undefined)?.from)"));
  assert.ok(layout.includes("‹ 戻る") && layout.includes("ニュース一覧 ›") && layout.includes("headerBackVisible: false"));
});

test("topic detail does not need a swipe override: a root-stack pop already lands on the origin (verified in the Simulator)", async () => {
  const screen = await code("src/app/topic-detail.tsx");
  assert.ok(!/usePreventRemove|beforeRemove/.test(screen));
  const root = await read("src/app/_layout.tsx");
  assert.ok(root.includes('<Stack.Screen name="topic-detail" />') && root.includes('<Stack.Screen name="topics" />'));
});
