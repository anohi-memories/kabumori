import assert from "node:assert/strict";
import test from "node:test";

import {
  goHome,
  goHomeFromNews,
  resetStackWhenHidden,
  goNewsList,
  goTopicList,
  HOME_ROUTE,
  NEWS_LIST_ROUTE,
  TOPICS_ROUTE,
} from "../../src/lib/detail-navigation.ts";
import type { HomeTopic, TopicLevel } from "../../src/lib/home-topic.ts";
import {
  createTopicViewCache,
  decideLevelSwitch,
  resolveTopicForLevel,
  topicDetailRouteParams,
  topicSwitchErrorMessage,
  TOPIC_SWITCH_LEVELS,
} from "../../src/lib/topic-detail-switch.ts";

const topic = (level: TopicLevel, title = `${level}の話題`): HomeTopic => ({
  id: `id-${level}`,
  level,
  category: "指標",
  title,
  body: "本文です。",
});

// A fake fetch that records every (level, jstDate) it is asked for.
function fakeFetch(options: { fail?: TopicLevel[]; empty?: TopicLevel[]; wrongLevel?: TopicLevel[] } = {}) {
  const calls: Array<[TopicLevel, string]> = [];
  const fetchTopic = async (level: TopicLevel, jstDate: string): Promise<HomeTopic | null> => {
    calls.push([level, jstDate]);
    if (options.fail?.includes(level)) throw new Error("boom");
    if (options.empty?.includes(level)) return null;
    if (options.wrongLevel?.includes(level)) return topic("beginner");
    return { ...topic(level), id: `${jstDate}:${level}` };
  };
  return { calls, fetchTopic };
}

test("the selector offers 初級 / 中級 / 上級, in that order, for the three levels", () => {
  assert.deepEqual(TOPIC_SWITCH_LEVELS, [
    { level: "beginner", label: "初級" },
    { level: "intermediate", label: "中級" },
    { level: "advanced", label: "上級" },
  ]);
});

test("same-date invariant: every switch asks for exactly the date being viewed, never today", async () => {
  const cache = createTopicViewCache();
  const { calls, fetchTopic } = fakeFetch();
  const pastDate = "2026-09-20";
  for (const level of ["beginner", "intermediate", "advanced"] as const) {
    const result = await resolveTopicForLevel({ level, jstDate: pastDate, cache, fetchTopic });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(calls, [
    ["beginner", pastDate],
    ["intermediate", pastDate],
    ["advanced", pastDate],
  ]);
});

test("success returns the real target topic, and the route params become its exact id / level / jstDate", async () => {
  const cache = createTopicViewCache();
  const { fetchTopic } = fakeFetch();
  const result = await resolveTopicForLevel({ level: "advanced", jstDate: "2026-09-20", cache, fetchTopic });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.topic.id, "2026-09-20:advanced");
  assert.deepEqual(topicDetailRouteParams(result.topic, "2026-09-20"), {
    id: "2026-09-20:advanced",
    level: "advanced",
    jstDate: "2026-09-20",
  });
});

test("switching back to an already loaded level is served from memory: no second network call", async () => {
  const cache = createTopicViewCache();
  const { calls, fetchTopic } = fakeFetch();
  const date = "2026-10-01";
  const first = await resolveTopicForLevel({ level: "intermediate", jstDate: date, cache, fetchTopic });
  const again = await resolveTopicForLevel({ level: "intermediate", jstDate: date, cache, fetchTopic });
  assert.ok(first.ok && again.ok);
  if (first.ok && again.ok) {
    assert.equal(first.fromCache, false);
    assert.equal(again.fromCache, true);
    assert.equal(again.topic, first.topic);
  }
  assert.equal(calls.length, 1, "one fetch for two visits");
});

test("the cache is keyed by date AND level: another date or level never reuses an entry", async () => {
  const cache = createTopicViewCache();
  const { calls, fetchTopic } = fakeFetch();
  await resolveTopicForLevel({ level: "beginner", jstDate: "2026-10-01", cache, fetchTopic });
  await resolveTopicForLevel({ level: "beginner", jstDate: "2026-10-02", cache, fetchTopic });
  await resolveTopicForLevel({ level: "advanced", jstDate: "2026-10-01", cache, fetchTopic });
  assert.equal(calls.length, 3);
  assert.equal(cache.get("2026-10-01", "beginner")?.id, "2026-10-01:beginner");
  assert.equal(cache.get("2026-10-02", "beginner")?.id, "2026-10-02:beginner");
  assert.equal(cache.get("2026-10-02", "advanced"), undefined);
});

test("a topic loaded for the open route is reusable by the route-param update (no double fetch after a switch)", async () => {
  const cache = createTopicViewCache();
  const { calls, fetchTopic } = fakeFetch();
  const result = await resolveTopicForLevel({ level: "advanced", jstDate: "2026-10-03", cache, fetchTopic });
  assert.ok(result.ok);
  if (!result.ok) return;
  // The screen's effect runs again with the new params and looks here before it would fetch.
  const params = topicDetailRouteParams(result.topic, "2026-10-03");
  const cached = cache.get(params.jstDate, params.level);
  assert.equal(cached?.id, params.id);
  assert.equal(calls.length, 1);
});

test("failure never throws and never changes what is cached; the screen keeps the current content", async () => {
  for (const mode of [{ fail: ["advanced"] }, { empty: ["advanced"] }, { wrongLevel: ["advanced"] }] as const) {
    const cache = createTopicViewCache();
    const { fetchTopic } = fakeFetch(mode);
    const loaded = await resolveTopicForLevel({ level: "beginner", jstDate: "2026-10-01", cache, fetchTopic });
    assert.ok(loaded.ok);
    const failed = await resolveTopicForLevel({ level: "advanced", jstDate: "2026-10-01", cache, fetchTopic });
    assert.equal(failed.ok, false);
    assert.equal(cache.get("2026-10-01", "advanced"), undefined, "a failure is not cached");
    assert.equal(cache.get("2026-10-01", "beginner")?.level, "beginner", "the loaded level is untouched");
  }
  const { fetchTopic } = fakeFetch({ fail: ["advanced"], empty: ["intermediate"] });
  const cache = createTopicViewCache();
  assert.deepEqual(await resolveTopicForLevel({ level: "advanced", jstDate: "d", cache, fetchTopic }), { ok: false, reason: "error" });
  assert.deepEqual(await resolveTopicForLevel({ level: "intermediate", jstDate: "d", cache, fetchTopic }), { ok: false, reason: "unavailable" });
});

test("a retry after a failure fetches again (failures are not sticky)", async () => {
  const cache = createTopicViewCache();
  let attempts = 0;
  const fetchTopic = async (level: TopicLevel): Promise<HomeTopic | null> => {
    attempts += 1;
    if (attempts === 1) throw new Error("offline");
    return topic(level);
  };
  assert.equal((await resolveTopicForLevel({ level: "advanced", jstDate: "d", cache, fetchTopic })).ok, false);
  assert.equal((await resolveTopicForLevel({ level: "advanced", jstDate: "d", cache, fetchTopic })).ok, true);
  assert.equal(attempts, 2);
});

test("tapping the level that is already shown is a no-op; any other level is a switch", () => {
  assert.equal(decideLevelSwitch("beginner", "beginner"), "noop");
  assert.equal(decideLevelSwitch("beginner", "advanced"), "switch");
  assert.equal(decideLevelSwitch("advanced", "intermediate"), "switch");
});

test("the inline error names the level and says the shown content is unchanged", () => {
  assert.equal(topicSwitchErrorMessage("advanced"), "上級のトピックを取得できませんでした。表示中の内容はそのままです。");
});

test("destination helpers go straight to Home, the topic list and the news list -- never back()", () => {
  const calls: string[] = [];
  const router = {
    dismissTo: (href: string) => calls.push(`dismissTo:${href}`),
    back: () => calls.push("back"),
    canGoBack: () => {
      calls.push("canGoBack");
      return false; // no history at all (cold deep link / notification)
    },
    push: () => calls.push("push"),
    replace: () => calls.push("replace"),
  };
  goHome(router);
  goTopicList(router);
  goNewsList(router);
  assert.deepEqual(calls, ["dismissTo:/", "dismissTo:/topics", "dismissTo:/news"]);
  assert.equal(HOME_ROUTE, "/");
  assert.equal(TOPICS_ROUTE, "/topics");
  assert.equal(NEWS_LIST_ROUTE, "/news");
});

test("news detail Home: selects the Home tab first, then empties the news stack -- no history dependence", () => {
  const calls: string[] = [];
  goHomeFromNews({ navigate: (href: string) => calls.push(`navigate:${href}`) }, () => calls.push("reset"));
  assert.deepEqual(calls, ["navigate:/", "reset"]);

  // Without a reset (nothing to clean up) Home is still reached.
  const cold: string[] = [];
  goHomeFromNews({ navigate: (href: string) => cold.push(`navigate:${href}`) });
  assert.deepEqual(cold, ["navigate:/"]);
});

// A fake stack navigation: `blur` listeners can be fired by hand.
function fakeStack() {
  const listeners = new Set<() => void>();
  const log: string[] = [];
  return {
    log,
    listeners,
    navigation: {
      addListener: (_type: "blur", callback: () => void) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
      popToTop: () => log.push("popToTop"),
    },
    blur: () => [...listeners].forEach((callback) => callback()),
  };
}

test("the news stack is emptied only after the news tab is hidden (blur), and only once", () => {
  const stack = fakeStack();
  resetStackWhenHidden(stack.navigation, 10_000);
  assert.deepEqual(stack.log, [], "nothing is popped while the detail is still on screen");
  stack.blur();
  assert.deepEqual(stack.log, ["popToTop"]);
  stack.blur();
  assert.deepEqual(stack.log, ["popToTop"], "a second blur does nothing");
  assert.equal(stack.listeners.size, 0, "the listener is removed");
});

test("if the tab never goes away the listener is dropped and the visible detail is never popped", async () => {
  const stack = fakeStack();
  resetStackWhenHidden(stack.navigation, 15);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(stack.listeners.size, 0);
  stack.blur();
  assert.deepEqual(stack.log, []);
});
