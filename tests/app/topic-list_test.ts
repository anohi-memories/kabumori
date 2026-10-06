import assert from "node:assert/strict";
import test from "node:test";

import {
  goTopicList,
  topicListRouteParams,
  type DismissHref,
} from "../../src/lib/detail-navigation.ts";
import type { HomeTopic, TopicLevel } from "../../src/lib/home-topic.ts";
import { pastJstDates } from "../../src/lib/topic-history.ts";
import {
  applyPage,
  beginLoad,
  canLoadMore,
  createTopicListState,
  loadTopicListPage,
  shouldAutoLoad,
  TOPIC_LIST_MAX_DAYS,
  TOPIC_LIST_PAGE_DAYS,
  visibleRows,
} from "../../src/lib/topic-list.ts";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const TODAY = "2026-10-06";

// What the screen does: the next PAGE_DAYS dates after a level's loaded days, then one page of that level.
const loadPage = (level: TopicLevel, loadedDays: number, fetchTopic: (level: TopicLevel, jstDate: string) => Promise<HomeTopic | null>) =>
  loadTopicListPage({ level, dates: pastJstDates(TODAY, TOPIC_LIST_PAGE_DAYS, loadedDays), fetchTopic });

function fetcher(options: { fail?: TopicLevel[]; delayMs?: Partial<Record<TopicLevel, number>> } = {}) {
  const calls: Array<[TopicLevel, string]> = [];
  const fetchTopic = async (level: TopicLevel, jstDate: string): Promise<HomeTopic | null> => {
    calls.push([level, jstDate]);
    const delay = options.delayMs?.[level] ?? 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (options.fail?.includes(level)) throw new Error("boom");
    return { id: `${level}:${jstDate}`, level, category: "指標", title: `${level} ${jstDate}`, body: "本文。" };
  };
  return { calls, fetchTopic };
}

test("the list keeps PAGE_DAYS = 14 and MAX_DAYS = 98", () => {
  assert.equal(TOPIC_LIST_PAGE_DAYS, 14);
  assert.equal(TOPIC_LIST_MAX_DAYS, 98);
});

test("a page fetches only the selected level, for the correct date sequence of that level", async () => {
  const { calls, fetchTopic } = fetcher();
  const first = await loadPage("intermediate", 0, fetchTopic);
  assert.equal(calls.length, 14);
  assert.ok(calls.every(([level]) => level === "intermediate"), "never another level");
  assert.deepEqual(calls[0], ["intermediate", "2026-10-06"]);
  assert.deepEqual(calls[13], ["intermediate", "2026-09-23"]);
  assert.equal(first.allFailed, false);
  // The next page continues right after the loaded days.
  const second = fetcher();
  await loadPage("intermediate", 14, second.fetchTopic);
  assert.deepEqual(second.calls[0], ["intermediate", "2026-09-22"]);
});

test("every level has its own date sequence from today; levels never share loaded days", async () => {
  let state = createTopicListState();
  const { calls, fetchTopic } = fetcher();
  for (const level of ["beginner", "advanced"] as const) {
    state = beginLoad(state, level);
    state = applyPage(state, level, await loadPage(level, state[level].loadedDays, fetchTopic));
  }
  assert.equal(state.beginner.loadedDays, 14);
  assert.equal(state.advanced.loadedDays, 14);
  assert.equal(state.intermediate.loadedDays, 0, "an unvisited level is untouched");
  assert.equal(calls.filter(([level]) => level === "intermediate").length, 0, "nothing fetched for an unvisited level");
  assert.deepEqual(calls.filter(([level]) => level === "advanced")[0], ["advanced", TODAY]);
});

test("switching back to a loaded level restores its rows with no refetch", async () => {
  let state = createTopicListState();
  const { calls, fetchTopic } = fetcher();
  state = beginLoad(state, "beginner");
  state = applyPage(state, "beginner", await loadPage("beginner", 0, fetchTopic));
  const before = calls.length;
  // Switch to another level and back: the screen only asks shouldAutoLoad, which is false for a loaded level.
  assert.equal(shouldAutoLoad(state.beginner), false);
  assert.equal(visibleRows(state.beginner).length, 14);
  assert.equal(calls.length, before, "no new request");
  assert.equal(shouldAutoLoad(state.intermediate), true, "a never-loaded level loads its first page");
});

test("load more extends only the active level", async () => {
  let state = createTopicListState();
  const { calls, fetchTopic } = fetcher();
  for (const level of ["beginner", "advanced"] as const) {
    state = beginLoad(state, level);
    state = applyPage(state, level, await loadPage(level, 0, fetchTopic));
  }
  calls.length = 0;
  state = beginLoad(state, "advanced");
  state = applyPage(state, "advanced", await loadPage("advanced", state.advanced.loadedDays, fetchTopic));
  assert.ok(calls.every(([level]) => level === "advanced"));
  assert.equal(state.advanced.loadedDays, 28);
  assert.equal(state.advanced.rows.length, 28);
  assert.equal(state.beginner.loadedDays, 14, "the other level is untouched");
  assert.equal(state.beginner.rows.length, 14);
});

test("a slow result for a level the user already left lands in ITS level and never pollutes the new one", async () => {
  let state = createTopicListState();
  const { fetchTopic } = fetcher({ delayMs: { beginner: 40 } });
  // Beginner starts loading (slow); the user switches to advanced, which loads fast.
  state = beginLoad(state, "beginner");
  const slow = loadPage("beginner", 0, fetchTopic);
  state = beginLoad(state, "advanced");
  state = applyPage(state, "advanced", await loadPage("advanced", 0, fetchTopic));
  const advancedRowsBefore = state.advanced.rows.map((row) => row.topic?.id);
  state = applyPage(state, "beginner", await slow);
  assert.deepEqual(state.advanced.rows.map((row) => row.topic?.id), advancedRowsBefore, "the visible level is unchanged");
  assert.ok(state.advanced.rows.every((row) => row.topic?.level === "advanced"));
  assert.ok(state.beginner.rows.every((row) => row.topic?.level === "beginner"));
  assert.equal(state.beginner.rows.length, 14);
});

test("a level that is already loading is not requested twice", () => {
  let state = createTopicListState();
  state = beginLoad(state, "beginner");
  assert.equal(beginLoad(state, "beginner"), state, "the same state object: no second begin");
  assert.equal(canLoadMore(state.beginner), false);
  assert.equal(shouldAutoLoad(state.beginner), false);
});

test("a first page that fails entirely is not retried in a loop, does not advance, and can be retried by hand", async () => {
  let state = createTopicListState();
  const { fetchTopic } = fetcher({ fail: ["beginner"] });
  state = beginLoad(state, "beginner");
  state = applyPage(state, "beginner", await loadPage("beginner", 0, fetchTopic));
  assert.equal(state.beginner.error, true);
  assert.equal(state.beginner.loadedDays, 0, "the same page is retried, nothing skipped");
  assert.equal(shouldAutoLoad(state.beginner), false, "no automatic retry loop");
  assert.equal(canLoadMore(state.beginner), true, "the button can retry");
  // A good retry clears the error.
  const ok = fetcher();
  state = beginLoad(state, "beginner");
  state = applyPage(state, "beginner", await loadPage("beginner", 0, ok.fetchTopic));
  assert.equal(state.beginner.error, false);
  assert.equal(state.beginner.loadedDays, 14);
});

test("load more stops at MAX_DAYS", () => {
  let state = createTopicListState();
  for (let index = 0; index < TOPIC_LIST_MAX_DAYS / TOPIC_LIST_PAGE_DAYS; index += 1) {
    state = beginLoad(state, "advanced");
    state = applyPage(state, "advanced", { rows: [], allFailed: false });
  }
  assert.equal(state.advanced.loadedDays, 98);
  assert.equal(canLoadMore(state.advanced), false);
});

test("detail -> list: the right action requests the viewed level; 戻る reveals the list as it is", () => {
  const calls: DismissHref[] = [];
  const router = { dismissTo: (href: DismissHref) => calls.push(href) };
  goTopicList(router, "advanced");
  goTopicList(router);
  goTopicList(router, null);
  assert.deepEqual(calls[0], { pathname: "/topics", params: { level: "advanced", req: calls[0] && typeof calls[0] === "object" ? calls[0].params.req : "" } });
  assert.equal(calls[1], "/topics", "no level => no params, the existing list keeps its level and rows");
  assert.equal(calls[2], "/topics");
});

test("each explicit list request is a new request (same level twice still re-applies)", () => {
  assert.deepEqual(topicListRouteParams("beginner", 1000), { level: "beginner", req: "1000" });
  assert.notDeepEqual(topicListRouteParams("beginner", 1000), topicListRouteParams("beginner", 1001));
});

test("topics screen: the Settings level is only the initial default; an explicit level param wins; switching writes nothing", async () => {
  const screen = await code("src/app/topics.tsx");
  assert.ok(screen.includes("if (isTopicLevel(params.level)) {\n      select(params.level);"), "an explicit level wins");
  assert.ok(screen.includes("if (selectedRef.current) return;"), "a later param-less return never resets the user's choice");
  assert.ok(screen.includes("void readTopicLevel().then((stored) => {") && screen.includes("if (active && !selectedRef.current) select(stored);"));
  assert.equal((screen.match(/readTopicLevel\(/g) ?? []).length, 1, "the Settings level is read in one place only");
  assert.ok(!/writeTopicLevel|setItem|TOPIC_LEVEL_STORAGE_KEY|writeTopicLevelTo/.test(screen), "no Home preference write");
  assert.ok(screen.includes("onSelect={select}"), "switching only changes local screen state");
});

test("topics screen: only the selected level loads, each level keeps its own state, and a level is loaded once", async () => {
  const screen = await code("src/app/topics.tsx");
  assert.ok(screen.includes("if (selected && shouldAutoLoad(listsRef.current[selected])) void loadMore(selected);"));
  assert.ok(screen.includes("update((state) => applyPage(state, level, page));"), "a page is applied to the level it was loaded for");
  assert.ok(screen.includes("pastJstDates(today.current, TOPIC_LIST_PAGE_DAYS, entry.loadedDays)"), "the page continues after that level's own loaded days");
  assert.equal((screen.match(/fetchDailyTopic/g) ?? []).length, 2, "import + the one by-reference use");
  assert.ok(!/TOPIC_LEVELS\.map|for \(const level of/.test(screen), "never loops over all levels to fetch");
  assert.ok(screen.includes("if (entry.loading) return;"));
});

test("topics screen: the selector is shown, learned/unread is on every row with an accessible label, focus refreshes it", async () => {
  const screen = await code("src/app/topics.tsx");
  assert.ok(screen.includes("<LevelSwitcher") && screen.includes("active={level}"));
  assert.ok(screen.includes("useFocusEffect(") && screen.includes("void topicReadStore.read().then((ids) => {"), "read state reloads on focus");
  assert.ok(screen.includes("isTopicRead(readIds, row.topic.id)"));
  assert.ok(screen.includes("✓ 学習済み") && screen.includes(">未読<"));
  assert.ok(screen.includes("${read ? '学習済み' : '未読'}"), "the state is in the accessibility label");
  assert.ok(!/numberOfLines=\{[3-9]\}/.test(screen));
});

test("topics screen: the old 'change it in Settings' copy is replaced", async () => {
  const screen = await read("src/app/topics.tsx");
  assert.ok(!screen.includes("レベルは設定から変更できます。"));
  assert.ok(screen.includes("ここでレベルを切り替えられます。設定のレベルは、ホームに表示するトピックだけを決めます。"));
});

test("Settings separation: only Settings-side code writes the Home level; the list, detail and selector never do", async () => {
  const callers: string[] = [];
  for (const dir of ["src/app", "src/components", "src/hooks", "src/lib"]) {
    const stack = [new URL(`${dir}/`, repoRoot)];
    while (stack.length) {
      const current = stack.pop()!;
      for await (const entry of Deno.readDir(current)) {
        const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), current);
        if (entry.isDirectory) stack.push(url);
        else if (/\.tsx?$/.test(entry.name)) {
          const text = await Deno.readTextFile(url);
          if (/writeTopicLevel\(|writeTopicLevelTo\(/.test(text)) callers.push(url.pathname.replace(repoRoot.pathname, ""));
        }
      }
    }
  }
  assert.ok(callers.every((path) => /settings|topic-level-storage|home-topic\.ts$/.test(path)), callers.join(", "));
  for (const path of ["src/app/topics.tsx", "src/app/topic-detail.tsx", "src/components/level-switcher.tsx", "src/lib/topic-list.ts", "src/lib/topic-detail-switch.ts"]) {
    assert.ok(!/writeTopicLevel|kabumori:topic-level:v1/.test(await code(path)), path);
  }
  // Home still reads the Settings preference as before.
  const homeIndex = await read("src/app/(tabs)/index.tsx");
  assert.ok(/readTopicLevel/.test(homeIndex));
});

test("no new backend: the list/read-state work adds no RPC, endpoint or migration", async () => {
  for (const path of ["src/lib/topic-list.ts", "src/lib/topic-read.ts", "src/app/topics.tsx"]) {
    assert.ok(!/supabase|\.rpc\(|fetch\(/i.test(await code(path)), path);
  }
});

test("topics screen: an explicit level request scrolls the list to its top; the selector keeps its place while Settings is read", async () => {
  const screen = await code("src/app/topics.tsx");
  assert.ok(screen.includes("scrollRef.current?.scrollTo({ y: 0, animated: false });"));
  assert.ok(screen.includes("<ScrollView ref={scrollRef}"));
  assert.ok(screen.includes("{!level ? <View style={styles.switcherPlaceholder} /> : null}"));
  assert.ok(/switcherPlaceholder: \{ height: 48, marginTop: 12 \}/.test(screen), "same height as the selector: no layout jump");
});
