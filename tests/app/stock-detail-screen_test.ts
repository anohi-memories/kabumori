// The 銘柄詳細 screen is React Native, so its contract is pinned by reading the source as text (the pure view
// model is covered behaviourally in stock-detail-view_test).
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

test("the detail is a root Stack screen, so the native edge swipe pops straight to the screen that opened it", async () => {
  const root = await read("src/app/_layout.tsx");
  assert.ok(root.includes('<Stack.Screen name="stock-detail" />'));
  const tabs = await read("src/app/(tabs)/_layout.tsx");
  assert.ok(!/stock-detail|stock_detail/.test(tabs), "not a tab and not nested in the tab group");
  const screen = await code("src/app/stock-detail.tsx");
  assert.ok(screen.includes("export default function StockDetailScreen()"));
  assert.ok(screen.includes("router.canGoBack() ? router.back() : router.replace('/')"), "back returns to the origin; a cold link falls back to Home");
  assert.ok(!screen.includes("usePreventRemove") && !/expo-router\/build/.test(screen));
});

test("the bottom menu is not touched: five tabs, no detail inside it, the root layout only gained one Stack.Screen", async () => {
  const tabs = await read("src/app/(tabs)/_layout.tsx");
  const labels = [...tabs.matchAll(/<NativeTabs\.Trigger\.Label>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels, ["ホーム", "銘柄", "ニュース", "レポート", "メニュー"]);
  const screen = await code("src/app/stock-detail.tsx");
  assert.ok(!/NativeTabs|TabBar|BottomTab/.test(screen), "no tab bar is duplicated inside the detail");
});

test("opening the detail never writes: the only mutations live in the existing editor, behind its own buttons", async () => {
  const screen = await code("src/app/stock-detail.tsx");
  assert.ok(!/\.(insert|update|upsert|delete)\(|\.rpc\(|functions\.invoke|fetch\(/.test(screen), "no write and no network call of its own");
  const selects = [...screen.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(selects, ["stocks_master", "tracked_stocks"], "reads only the user's registration and the shared stock record");
  assert.ok(screen.includes(".eq('user_id', authData.user.id)"), "the registration query is owner-constrained");
  assert.ok(screen.includes("supabase.auth.getUser()"));
  assert.ok(screen.includes("fetchRecentReports(20)"), "the saved reports through the existing reader");
  assert.ok(!/service_role|SERVICE_ROLE/.test(screen));
  // The editor opens only from the explicit button; closing it changes nothing.
  assert.ok(screen.includes("onPress={() => setEditing(true)}") && screen.includes("onClose={() => setEditing(false)}"));
  assert.ok(screen.includes("visible={editing && state.status === 'ready'}"));
  assert.ok(screen.includes("onSaved={() => { setEditing(false); void load(); }}"), "after a save the detail reloads in place");
  assert.ok(screen.includes("onDeleted={() => { setEditing(false); goBack(); }}"), "a deregistered stock has no detail to stay on");
});

test("the editing action is separate and labelled; an unregistered stock offers registration instead", async () => {
  const screen = await code("src/app/stock-detail.tsx");
  assert.ok(screen.includes("'登録内容を編集'") && screen.includes("'この銘柄を登録する'"));
  assert.ok(screen.includes("minHeight: 52"), "a comfortable tap target");
});

test("market figures are saved-close only: dated, flagged not-real-time, no chart, no live or AI wording", async () => {
  const screen = await code("src/app/stock-detail.tsx");
  assert.ok(screen.includes("NOT_REALTIME_NOTE") && screen.includes("price.basisLabel"));
  assert.ok(screen.includes("前日比") && screen.includes("前日終値") && screen.includes("終値"));
  assert.ok(!/Sparkline|<Svg|victory|chart/i.test(screen), "no fake chart");
  assert.ok(!/リアルタイム(価格|株価|更新)|ライブ|LIVE|AI予測|予想株価/.test(screen));
  assert.ok(screen.includes("formatPriceYen(") && screen.includes("formatSignedPercent("), "the shared formatters render '—' for a missing value");
});

test("news is shown only through the verified join and the existing news detail, returning to the detail", async () => {
  const screen = await code("src/app/stock-detail.tsx");
  assert.ok(screen.includes("view.news ?") && screen.includes("pathname: '/news-detail'") && screen.includes("from: 'stocks'"));
  const view = await code("src/lib/stock-detail-view.ts");
  assert.ok(view.includes("verifiedStockNews(snapshot, stock.ticker_code, kind)"));
  assert.ok(!/news_ids\.length/.test(view), "news_ids alone is never treated as an article");
  const nav = await read("src/lib/detail-navigation.ts");
  assert.ok(nav.includes("origin === 'reports' || origin === 'stocks'"), "the news back control pops to the screen below it -- the detail");
});

test("entry points: portfolio rows, watchlist rows/cards and registered search results open the detail; unregistered results still register", async () => {
  const explore = await code("src/app/(tabs)/explore.tsx");
  assert.ok(explore.includes("router.push(trackedDetailHref(trackedId))"));
  assert.ok(explore.includes("<HoldingsList") && explore.includes("onOpen={openDetail}"));
  assert.ok(explore.includes("<WatchlistSection") && (explore.match(/onOpen=\{openDetail\}/g) ?? []).length === 2, "holdings and watchlist");
  assert.ok(explore.includes("useState<StocksView>('portfolio')"), "the segment is local tab state, kept while the detail is open above the tab");
  const watch = await code("src/components/portfolio/watchlist-section.tsx");
  assert.ok((watch.match(/onPress=\{\(\) => onOpen\(row\.tracked\.id\)\}/g) ?? []).length === 2, "featured card and compact row");
  assert.ok(!/router\.|pathname/.test(watch.replace(/onOpenNews/g, "")), "the row components only call back");
  const search = await code("src/app/search.tsx");
  assert.ok(search.includes("router.push(searchResultDetailHref(item.id))") && search.includes("else setSelected(item)"));
  assert.ok(search.includes("<TrackedStockEditor") && search.includes("existing={null}"), "unregistered results keep the quick registration editor");
  assert.ok(search.includes("useFocusEffect") && search.includes("setRegisteredIds(new Set(data.map("), "badges are re-checked on return");
  assert.ok(!/setQuery\(''\)|setResults\(\[\]\);\s*router/.test(search), "the query and results are not cleared when opening a detail");
});

test("accessibility: labelled controls, an accessible price summary and a header role", async () => {
  const screen = await code("src/app/stock-detail.tsx");
  assert.ok(screen.includes('accessibilityRole="header"'));
  assert.ok(screen.includes("accessibilityLabel={summary}") && screen.includes("accessibilityHint="));
  const back = await read("src/components/back-button.tsx");
  assert.ok(back.includes("minHeight: 44"), "the shared back control already meets the 44pt target");
});
