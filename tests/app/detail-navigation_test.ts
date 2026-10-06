// Detail navigation is React Native + expo-router, so its contract is pinned by reading the source as text,
// like the rest of this suite (the pure parts are covered behaviourally in topic-detail-switch_test.ts).
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

test("topic detail: 「‹ 戻る」 (origin-based) and 「トピック一覧 ›」 (always the list) replace the old controls", async () => {
  const screen = await code("src/app/topic-detail.tsx");
  assert.ok(screen.includes("onPress={() => backFromTopicDetail(router, params.from)}") && screen.includes("<Text style={styles.navText}>‹ 戻る</Text>"));
  assert.ok(screen.includes("onPress={() => goTopicList(router, topic?.level)}") && screen.includes("<Text style={styles.navText}>トピック一覧 ›</Text>"), "the right action opens the list on the level being viewed");
  assert.ok(!/ホーム<|過去のトピック ›|goHome\(|goPastTopics/.test(screen), "no third Home button, no old labels");
  assert.ok(!/router\.(back|canGoBack)\(/.test(screen), "no history dependence");
  assert.ok(!/BackButton/.test(screen), "the single generic back control is replaced");
  const nav = await code("src/lib/detail-navigation.ts");
  assert.ok(nav.includes("router.dismissTo(HOME_ROUTE)") && nav.includes("router.dismissTo(TOPICS_ROUTE)") && nav.includes("router.dismissTo(NEWS_LIST_ROUTE)"));
  assert.ok(nav.includes("router.dismissTo({ pathname: TOPICS_ROUTE, params: topicListRouteParams(level) })"));
  assert.ok(!/canGoBack/.test(nav));
  assert.equal((nav.match(/router\.back\(\)/g) ?? []).length, 1, "the only back() is the explicit reports origin");
});

test("topic detail: both destinations are above every state, so loading / error / id-mismatch / deep-link states keep them", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  const navigation = screen.indexOf("styles.navRow");
  const states = screen.indexOf("status === 'loading' ?");
  assert.ok(navigation > 0 && states > navigation, "the nav row is rendered before (outside) the status branches");
  assert.ok(screen.indexOf("goTopicList(router, topic?.level)") < states && screen.indexOf("backFromTopicDetail(router, params.from)") < states);
});

test("topic detail: the selector sits between the notebook label and the Hero, with compact 初級/中級/上級 buttons", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  const order = ['accessibilityLabel="かぶモリ学習ノート"', "<LevelSwitcher", "styles.hero,"].map((needle) => screen.indexOf(needle));
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(screen.includes("active={topic.level}"), "selected state follows the active topic");
  assert.ok(screen.includes("同じ日の別のレベルに切り替えます。Homeの設定は変わりません。"));
  // The shared selector: three equal buttons in one row (fits any width), one cohesive control.
  const component = await read("src/components/level-switcher.tsx");
  assert.ok(component.includes('accessibilityRole="button"') && component.includes("accessibilityState={{ selected, busy: pending === level }}"));
  assert.ok(component.includes("const selected = active === level;"));
  assert.ok(/switcher: \{[^}]*flexDirection: 'row'/.test(component) && /segment: \{ flex: 1,/.test(component), "three equal segments in one row fit any width");
  assert.ok(component.includes("TOPIC_SWITCH_LEVELS.map("));
});

test("topic detail: switching resolves the SAME date, updates the route to the real topic, and never writes the Home preference", async () => {
  const screen = await code("src/app/topic-detail.tsx");
  assert.ok(screen.includes("const viewDate = typeof params.jstDate === 'string' ? params.jstDate : '';"));
  assert.ok(screen.includes("resolveTopicForLevel({ level: target, jstDate: viewDate, cache, fetchTopic: fetchDailyTopic })"));
  assert.ok(screen.includes("router.setParams(topicDetailRouteParams(next, viewDate, origin))"), "params become the exact id/level/jstDate, origin carried over");
  assert.ok(!/todayJst|new Date\(|Date\.now/.test(screen), "never falls back to today's date");
  // No Settings / storage writer reachable from the detail screen.
  const imports = [...new Set(screen.match(/from '[^']+'/g) ?? [])];
  // The only storage the detail touches is the device-local learning progress; never the Home level preference.
  assert.ok(!imports.some((entry) => /async-storage|topic-level/.test(entry)), imports.join(", "));
  assert.ok(imports.every((entry) => !/storage/.test(entry) || entry === "from '@/lib/topic-read-storage'"), imports.join(", "));
  assert.ok(!/writeTopicLevel|setItem|AsyncStorage|TOPIC_LEVEL_STORAGE_KEY/.test(screen));
  const lib = await code("src/lib/topic-detail-switch.ts");
  assert.ok(!/setItem|AsyncStorage|writeTopicLevel|localStorage/.test(lib) && !/^import (?!type)/m.test(lib), "the switch logic has no storage and no runtime imports");
});

test("topic detail: Home's level preference contract is unchanged", async () => {
  const home = await read("src/lib/home-topic.ts");
  assert.ok(home.includes("export const TOPIC_LEVEL_STORAGE_KEY = 'kabumori:topic-level:v1';"));
  const storage = await read("src/lib/topic-level-storage.ts");
  assert.ok(storage.includes("writeTopicLevelTo"));
  // Only Settings writes the level.
  const callers: string[] = [];
  for (const dir of ["src/app", "src/components", "src/hooks"]) {
    const stack = [new URL(`${dir}/`, repoRoot)];
    while (stack.length) {
      const current = stack.pop()!;
      for await (const entry of Deno.readDir(current)) {
        const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), current);
        if (entry.isDirectory) stack.push(url);
        else if (/\.tsx?$/.test(entry.name) && /writeTopicLevel\(/.test(await Deno.readTextFile(url))) callers.push(url.pathname);
      }
    }
  }
  assert.ok(callers.every((path) => /settings|use-topic-level|home-topic/.test(path)), callers.join(", "));
  assert.ok(!callers.some((path) => path.includes("topic-detail")));
});

test("topic detail: failure keeps the shown topic and shows a small message next to the selector (no blank page)", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  const failure = screen.slice(screen.indexOf("if (result.ok) {"), screen.indexOf("[cache, pendingLevel, topic, viewDate]"));
  assert.ok(failure.includes("setPendingLevel(null);") && failure.includes("setSwitchError(target);"));
  assert.ok(!failure.includes("setTopic(") || failure.indexOf("setTopic(") < failure.indexOf("} else {"), "the failure branch does not touch the topic");
  assert.ok(!failure.includes("setStatus("), "the failure branch does not change the page status");
  assert.ok(screen.includes("topicSwitchErrorMessage(switchError)") && screen.includes('accessibilityLiveRegion="polite"'));
});

test("topic detail: cache-aware route update -- the effect reuses a loaded topic instead of fetching it a second time", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  const effect = screen.slice(screen.indexOf("useEffect(() => {"), screen.indexOf("const viewDate"));
  assert.ok(effect.indexOf("cache.get(jstDate, level)") < effect.indexOf("fetchDailyTopic(level, jstDate)"));
  assert.ok(effect.includes("if (cached && cached.id === id) {"), "a cached topic is only reused when its id is exactly the route id");
  assert.ok(effect.includes("cache.set(jstDate, result);"), "a verified direct load joins the cache");
  assert.ok(screen.includes("const cached = cache.get(viewDate, target);"), "a loaded level switches instantly");
  assert.ok(screen.includes("switchSeq.current += 1") && screen.includes("if (seq !== switchSeq.current) return;"), "a stale result is dropped");
  assert.ok(!/AsyncStorage|persist|setItem/.test(await code("src/app/topic-detail.tsx")), "the cache is memory only");
});

test("topic detail: the direct-route id check still fails closed", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(screen.includes("if (!result || result.id !== id) {\n          setStatus('mismatch');"));
  assert.ok(screen.includes("if (!isTopicLevel(level) || !jstDate || !id) {"));
});

test("history -> detail -> Home and Home -> detail -> past topics exist as real routes", async () => {
  const topics = await read("src/app/topics.tsx");
  assert.ok(topics.includes("pathname: '/topic-detail'") && topics.includes("jstDate: row.date"), "history -> detail");
  const homeIndex = await read("src/app/(tabs)/index.tsx");
  assert.ok(homeIndex.includes("pathname: '/topic-detail'"), "Home -> detail");
  const root = await read("src/app/_layout.tsx");
  assert.ok(root.includes('<Stack.Screen name="(tabs)" />') && root.includes('<Stack.Screen name="topics" />') && root.includes('<Stack.Screen name="topic-detail" />'));
  // The list itself is unchanged: still driven by the Settings level and still ends in the same detail route.
  assert.ok(topics.includes("readTopicLevel()"));
});

test("news detail is a ROOT-stack route (like the topic detail): a native swipe pops straight to where it was opened from", async () => {
  const root = await read("src/app/_layout.tsx");
  assert.ok(root.includes('<Stack.Screen name="news-detail" />'));
  const file = await Deno.stat(new URL("src/app/news-detail.tsx", repoRoot));
  assert.ok(file.isFile);
  // The nested news-tab detail route is gone, so there is no screen that can sit between the swipe and its origin.
  const removed = await Deno.stat(new URL("src/app/(tabs)/news/[id].tsx", repoRoot)).catch(() => null);
  assert.equal(removed, null);
  const layout = await code("src/app/(tabs)/news/_layout.tsx");
  assert.ok(layout.includes('<Stack.Screen name="index" />') && !layout.includes("[id]") && !/headerLeft|headerRight/.test(layout));
});

test("news detail: an in-screen row has an origin-based 「‹ 戻る」 (left) and an always-available 「ニュース一覧 ›」 (right)", async () => {
  const screen = await code("src/app/news-detail.tsx");
  assert.ok(screen.includes("onPress={() => backFromNewsDetail(router, from)}") && screen.includes("‹ 戻る"));
  assert.ok(screen.includes("onPress={() => goNewsList(router)}") && screen.includes("ニュース一覧 ›"));
  assert.ok(!/ホーム<|goHome\(/.test(screen), "no third Home button");
  assert.ok(!/usePreventRemove|beforeRemove|gestureEnabled|canGoBack|navigation\.dispatch/.test(screen), "no interception: the native pop already lands on the origin");
  assert.ok(!/expo-router\/build/.test(screen), "no package-internal import any more");
  assert.ok(/navTitle: \{ position: 'absolute', left: 0, right: 0, textAlign: 'center'/.test(screen), "the title is centred on the screen");
  const nav = await code("src/lib/detail-navigation.ts");
  assert.ok(!/dismissAll|canDismiss|resetStack|usePreventRemove/.test(nav));
  assert.ok(!/replace\(/.test(nav), "replace('/') would stack a second (tabs)");
});

test("news detail: the row is shared by every state, so loading and missing/error keep both destinations", async () => {
  const screen = await code("src/app/news-detail.tsx");
  assert.ok(screen.includes("function NewsDetailShell("));
  // loading, missing/error and the loaded article are all rendered inside the shell.
  assert.equal((screen.match(/<NewsDetailShell from=\{from\}>/g) ?? []).length, 3);
  assert.ok(screen.includes("edges={['top']}") && screen.includes("60 + insets.bottom"), "safe area; no tab bar covers the bottom any more");
  assert.ok(!/router\.(back|canGoBack)\(/.test(screen), "the in-body error button is direct too");
  assert.ok(screen.includes("onPress={() => goNewsList(router)} style={styles.backButton}") && screen.includes("一覧へ戻る"));
});

test("news detail: every entry opens the root route and passes its origin; a news/<id> link is rewritten to it", async () => {
  const entries: Array<[string, string]> = [
    ["src/components/home/home-market-news-grid.tsx", "from: 'home'"],
    ["src/components/home/home-holding-news-list.tsx", "from: 'home'"],
    ["src/app/(tabs)/news/index.tsx", "from: 'news'"],
    ["src/app/(tabs)/reports/[id].tsx", "from: 'reports'"],
  ];
  for (const [path, origin] of entries) {
    const text = await read(path);
    assert.ok(text.includes("pathname: '/news-detail'") && text.includes(origin), path);
    assert.ok(!text.includes("'/news/[id]'"), `${path} must not use the removed nested route`);
  }
  const intent = await read("src/app/+native-intent.tsx");
  assert.ok(intent.includes("newsDetailRedirectPath(path)"));
  const push = await read("src/hooks/use-push-notification-navigation.ts");
  assert.ok(push.includes("router.push('/news')"));
});

test("news: which items are returned, the access boundary and presentation are untouched by the navigation work", async () => {
  const detail = await read("src/app/news-detail.tsx");
  assert.ok(detail.includes("fetchMyImportantNewsItem(String(id))") && detail.includes("buildNewsPresentation(item)"));
});

test("every entry point passes its explicit origin as the `from` param", async () => {
  const push = (text: string, path: string) => assert.ok(text.includes(path), path);
  push(await read("src/app/(tabs)/index.tsx"), "jstDate: todayJstValue, from: 'home' },");
  push(await read("src/app/topics.tsx"), "jstDate: row.date, from: 'topics' },");
  push(await read("src/components/home/home-market-news-grid.tsx"), "params: { id: item.news_id, from: 'home' }");
  push(await read("src/components/home/home-holding-news-list.tsx"), "params: { id: item.news_id, from: 'home' }");
  push(await read("src/app/(tabs)/news/index.tsx"), "params: { id: item.news_id, from: 'news' }");
  push(await read("src/app/(tabs)/reports/[id].tsx"), "params: { id: item.news_id, from: 'reports' }");
});

test("the origin is read from route params only: no storage, no backend, no stack inspection", async () => {
  const nav = await code("src/lib/detail-navigation.ts");
  assert.ok(!/AsyncStorage|setItem|supabase|fetch\(|canGoBack|useNavigationState|getState\(/.test(nav));
  assert.ok(!/^import (?!type )/m.test(nav), "the navigation helpers have no runtime dependency (type imports only)");
  const screen = await code("src/app/topic-detail.tsx");
  assert.ok(screen.includes("const origin = parseDetailOrigin(params.from);"));
});
