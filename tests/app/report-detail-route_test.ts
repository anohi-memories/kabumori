// The portfolio opens the report on the ROOT stack so a native swipe / back returns to the portfolio, while the
// レポート tab keeps its nested route. Route structure is pinned by reading the sources as text.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

test("the portfolio's AI card and 「詳しく見る」 open the root report detail, not the nested reports route", async () => {
  const sections = await code("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(sections.includes("router.push({ pathname: '/report-detail', params: { id: reportId } })"));
  assert.ok(!sections.includes("/reports/[id]"), "the portfolio never uses the nested route");
  assert.ok(sections.includes("onPress={() => openReport(summary.reportId)}"), "AI card");
  assert.ok(sections.includes("onPress={() => openReport(reportId)}"), "impact 詳しく見る");
});

test("the レポート tab (and Home) still open the nested /reports/[id], so a swipe there reveals the reports list", async () => {
  const list = await code("src/app/(tabs)/reports/index.tsx");
  assert.ok(list.includes("pathname: '/reports/[id]'") && !list.includes("/report-detail"));
  const layout = await code("src/app/(tabs)/reports/_layout.tsx");
  assert.ok(layout.includes('<Stack.Screen name="[id]"'), "the nested detail route is kept");
  assert.ok(await Deno.stat(new URL("src/app/(tabs)/reports/[id].tsx", repoRoot)).then(() => true, () => false));
  // Push notifications keep their deep link.
  const presentation = await read("src/lib/report-presentation.ts");
  assert.ok(presentation.includes("`/reports/${id}`"));
});

test("the root report-detail route re-exports the SAME implementation (no second copy to drift)", async () => {
  const route = await code("src/app/report-detail.tsx");
  assert.ok(route.includes("import ReportDetailScreen from './(tabs)/reports/[id]';"));
  assert.ok(route.includes("export default ReportDetailScreen;"));
  assert.ok(route.split("\n").filter((line) => line.trim()).length <= 3, "a thin re-export only");
  const detail = await code("src/app/(tabs)/reports/[id].tsx");
  assert.ok(detail.includes("export default function ReportDetailScreen()") && detail.includes("useLocalSearchParams<{ id: string }>()"));
});

test("the root Stack registers report-detail with a native header (so the interactive swipe stays enabled)", async () => {
  const root = await read("src/app/_layout.tsx");
  assert.ok(root.includes('name="report-detail"'));
  const block = root.slice(root.indexOf('name="report-detail"'), root.indexOf("/>", root.indexOf('name="report-detail"')));
  assert.ok(block.includes("headerShown: true") && block.includes("title: 'レポート'"));
  assert.ok(!/gestureEnabled|fullScreenGestureEnabled/.test(root), "the native swipe is not disabled");
  // The other root screens, including the news detail, are still registered.
  for (const screen of ["(tabs)", "topic-detail", "topics", "news-detail", "settings", "ai", "search"]) {
    assert.ok(root.includes(`<Stack.Screen name="${screen}" />`), screen);
  }
});

test("PR #95's root Auth / service-access contract is intact", async () => {
  const root = await read("src/app/_layout.tsx");
  assert.ok(root.includes("serviceSession"), "service session gate");
  assert.ok(root.includes("<ServiceAccessScreen") || root.includes("ServiceAccessScreen"));
  assert.ok(root.includes("useRegisterPushToken(serviceSession)") && root.includes("usePushNotificationNavigation(serviceSession)"));
  assert.ok(root.includes("function SignedInNavigator()") && root.includes(") : serviceSession ? ("));
  assert.ok(root.includes("<SignedInNavigator />"));
  assert.ok(await Deno.stat(new URL("src/components/service-access-screen.tsx", repoRoot)).then(() => true, () => false));
});

test("no interception or package-internal navigation import was added", async () => {
  for (const path of ["src/app/report-detail.tsx", "src/app/_layout.tsx", "src/components/portfolio/portfolio-sections.tsx", "src/app/(tabs)/reports/[id].tsx"]) {
    const text = await code(path);
    assert.ok(!/usePreventRemove|beforeRemove|expo-router\/build|PanGesture|panResponder/i.test(text), path);
  }
});

test("report -> linked news navigation is unchanged: it still opens the root news-detail with from=reports", async () => {
  const detail = await read("src/app/(tabs)/reports/[id].tsx");
  const links = detail.match(/router\.push\(\{ pathname: '\/news-detail', params: \{ id: item\.news_id, from: 'reports' \} \}\)/g) ?? [];
  assert.equal(links.length, 3, "all three report -> news links keep from=reports");
  const news = await read("src/app/news-detail.tsx");
  assert.ok(news.includes("backFromNewsDetail(router, from)"));
});

test("a direct open without a back stack falls back safely to the reports list", async () => {
  const detail = await code("src/app/(tabs)/reports/[id].tsx");
  assert.ok(detail.includes("router.canGoBack() ? router.back() : router.replace('/reports')"), "the missing-report button");
  assert.ok(detail.includes("一覧へ戻る"));
});
