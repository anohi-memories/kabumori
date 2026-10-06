import assert from "node:assert/strict";
import test from "node:test";

import {
  backFromNewsDetail,
  backFromTopicDetail,
  goNewsList,
  goTopicList,
  newsBackTarget,
  parseDetailOrigin,
  topicBackTarget,
} from "../../src/lib/detail-navigation.ts";
import type { HomeTopic } from "../../src/lib/home-topic.ts";
import { topicDetailRouteParams } from "../../src/lib/topic-detail-switch.ts";

// A recording router. Anything that depends on history (back / canGoBack) is recorded too, so the tests
// can assert it is never used: origin routing is asserted, not stack accident.
function recorder() {
  const calls: string[] = [];
  const reset = () => calls.push("reset");
  const router = {
    dismissTo: (href: string) => calls.push(`dismissTo:${href}`),
    navigate: (href: string) => calls.push(`navigate:${href}`),
    back: () => calls.push("back"),
    canGoBack: () => {
      calls.push("canGoBack");
      return false;
    },
  };
  return { calls, router, reset };
}

test("parseDetailOrigin accepts exactly home / topics / news (a string or the first of an array)", () => {
  assert.equal(parseDetailOrigin("home"), "home");
  assert.equal(parseDetailOrigin("topics"), "topics");
  assert.equal(parseDetailOrigin("news"), "news");
  assert.equal(parseDetailOrigin(["topics", "home"]), "topics");
  for (const bad of [undefined, null, "", "Home", "reports", "/topics", 3, {}, []]) {
    assert.equal(parseDetailOrigin(bad), null, String(bad));
  }
});

test("topic: Home -> detail -> 戻る goes to Home", () => {
  const { calls, router } = recorder();
  backFromTopicDetail(router, "home");
  assert.deepEqual(calls, ["dismissTo:/"]);
});

test("topic: topics -> detail -> 戻る goes to the topic list", () => {
  const { calls, router } = recorder();
  backFromTopicDetail(router, "topics");
  assert.deepEqual(calls, ["dismissTo:/topics"]);
});

test("topic: a cold deep link / unknown / foreign origin -> 戻る falls back to Home", () => {
  for (const from of [undefined, null, "", "garbage", "news", ["x"]]) {
    const { calls, router } = recorder();
    backFromTopicDetail(router, from);
    assert.deepEqual(calls, ["dismissTo:/"], String(from));
    assert.equal(topicBackTarget(from), "home");
  }
});

test("topic: the right 「トピック一覧」 opens the topic list from every origin", () => {
  for (const from of ["home", "topics", undefined, "garbage"]) {
    const { calls, router } = recorder();
    goTopicList(router); // the right action takes no origin at all
    assert.deepEqual(calls, ["dismissTo:/topics"], String(from));
  }
});

test("topic: a level switch keeps the origin in the route params (and adds none when there was none)", () => {
  const topic: HomeTopic = { id: "t-adv", level: "advanced", category: null, title: "題", body: "本文。" };
  assert.deepEqual(topicDetailRouteParams(topic, "2026-10-01", "topics"), { id: "t-adv", level: "advanced", jstDate: "2026-10-01", from: "topics" });
  assert.deepEqual(topicDetailRouteParams(topic, "2026-10-01", "home"), { id: "t-adv", level: "advanced", jstDate: "2026-10-01", from: "home" });
  assert.deepEqual(topicDetailRouteParams(topic, "2026-10-01"), { id: "t-adv", level: "advanced", jstDate: "2026-10-01" });
  assert.ok(!("from" in topicDetailRouteParams(topic, "2026-10-01", null)));
});

test("news: Home card / holding row -> detail -> 戻る selects Home FIRST, then empties the news stack", () => {
  const { calls, router, reset } = recorder();
  backFromNewsDetail(router, "home", reset);
  assert.deepEqual(calls, ["navigate:/", "reset"], "Home first: the news list never flashes on the way");
});

test("news: news list -> detail -> 戻る goes to the news list", () => {
  const { calls, router } = recorder();
  backFromNewsDetail(router, "news");
  assert.deepEqual(calls, ["dismissTo:/news"]);
});

test("news: a cold deep link / unknown / foreign origin -> 戻る falls back to Home", () => {
  for (const from of [undefined, null, "", "garbage", "topics", "reports"]) {
    const { calls, router, reset } = recorder();
    backFromNewsDetail(router, from, reset);
    assert.deepEqual(calls, ["navigate:/", "reset"], String(from));
    assert.equal(newsBackTarget(from), "home");
  }
});

test("news: the right 「ニュース一覧」 opens the news list from every origin", () => {
  for (const from of ["home", "news", undefined, "garbage"]) {
    const { calls, router } = recorder();
    goNewsList(router);
    assert.deepEqual(calls, ["dismissTo:/news"], String(from));
  }
});

test("neither Back nor the list action ever uses back() / canGoBack()", () => {
  const all = recorder();
  for (const from of ["home", "topics", "news", undefined]) {
    backFromTopicDetail(all.router, from);
    backFromNewsDetail(all.router, from);
  }
  goTopicList(all.router);
  goNewsList(all.router);
  assert.ok(all.calls.every((call) => call !== "back" && call !== "canGoBack"), all.calls.join(","));
});
