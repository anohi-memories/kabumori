import assert from "node:assert/strict";
import test from "node:test";

import {
  backFromNewsDetail,
  backFromTopicDetail,
  goNewsList,
  goTopicList,
  newsDetailRedirectPath,
  type DismissHref,
} from "../../src/lib/detail-navigation.ts";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

function recorder() {
  const calls: string[] = [];
  const router = {
    dismissTo: (href: DismissHref) => calls.push(`dismissTo:${typeof href === "string" ? href : href.pathname}`),
    back: () => calls.push("back"),
  };
  return { calls, router };
}

// Both details are ROOT-stack routes, so the native edge swipe pops exactly one root screen: the screen the
// detail was opened from. These tests pin that model; the Simulator proves the real swipes.

test("the news detail is a root-stack screen, exactly like the topic detail", async () => {
  const root = await read("src/app/_layout.tsx");
  assert.ok(root.includes('<Stack.Screen name="topic-detail" />') && root.includes('<Stack.Screen name="news-detail" />'));
  assert.ok(root.includes('<Stack.Screen name="(tabs)" />'));
  const nested = await Deno.stat(new URL("src/app/(tabs)/news/[id].tsx", repoRoot)).catch(() => null);
  assert.equal(nested, null, "no nested news-tab detail between the swipe and its origin");
});

test("no gesture interception is needed (and none is left): nothing prevents or redirects a native pop", async () => {
  for (const path of ["src/app/news-detail.tsx", "src/app/topic-detail.tsx", "src/app/(tabs)/news/_layout.tsx"]) {
    const text = await code(path);
    assert.ok(!/usePreventRemove|beforeRemove|gestureEnabled|expo-router\/build/.test(text), path);
  }
});

test("news Home origin: 戻る goes Home, which is where the root-stack swipe pops to", () => {
  const { calls, router } = recorder();
  backFromNewsDetail(router, "home");
  assert.deepEqual(calls, ["dismissTo:/"]);
});

test("news list origin: 戻る goes to the news list, which is where the swipe pops to", () => {
  const { calls, router } = recorder();
  backFromNewsDetail(router, "news");
  assert.deepEqual(calls, ["dismissTo:/news"]);
});

test("report origin: 戻る pops to the report, which is where the swipe pops to (no contradiction)", () => {
  const { calls, router } = recorder();
  backFromNewsDetail(router, "reports");
  assert.deepEqual(calls, ["back"]);
});

test("unknown / cold deep link: 戻る falls back to Home (a deep-linked root screen has nothing to swipe back to)", () => {
  for (const from of [undefined, "", "garbage"]) {
    const { calls, router } = recorder();
    backFromNewsDetail(router, from);
    assert.deepEqual(calls, ["dismissTo:/"], String(from));
  }
});

test("topic: Home origin => Home, topics origin => topics, unknown => Home", () => {
  const cases: Array<[unknown, string]> = [["home", "dismissTo:/"], ["topics", "dismissTo:/topics"], [undefined, "dismissTo:/"], ["news", "dismissTo:/"]];
  for (const [from, expected] of cases) {
    const { calls, router } = recorder();
    backFromTopicDetail(router, from);
    assert.deepEqual(calls, [expected], String(from));
  }
});

test("the right-hand list actions stay independent of the origin", () => {
  for (const from of ["home", "news", "reports", undefined]) {
    const { calls, router } = recorder();
    goNewsList(router);
    assert.deepEqual(calls, ["dismissTo:/news"], String(from));
  }
  const topics = recorder();
  goTopicList(topics.router);
  assert.deepEqual(topics.calls, ["dismissTo:/topics"]);
});

test("a news/<id> link is rewritten to the root-stack detail; the list and unrelated links are untouched", () => {
  assert.equal(newsDetailRedirectPath("kabumori://news/abc-123"), "/news-detail?id=abc-123");
  assert.equal(newsDetailRedirectPath("/news/abc-123"), "/news-detail?id=abc-123");
  assert.equal(newsDetailRedirectPath("news/abc-123"), "/news-detail?id=abc-123");
  assert.equal(newsDetailRedirectPath("kabumori://news/abc-123?x=1"), "/news-detail?id=abc-123");
  for (const path of ["kabumori://news", "/news", "/news/", "kabumori://reports/abc", "/topics", "/", "kabumori://news/a/b"]) {
    assert.equal(newsDetailRedirectPath(path), null, path);
  }
});
