// Home opens the shared market report (きょうの市況) on the ROOT stack, so 戻る / the edge swipe lands on Home instead of
// switching to the レポート tab and revealing its list. Home no longer opens a personalized report: the
// personalized reports stay reachable from the レポート tab and the portfolio. Route structure is pinned by
// reading the sources as text.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

test("Home's 「レポートを見る」 opens the shared market report with the exact published report (type, date, id, strict)", async () => {
  const home = await code("src/app/(tabs)/index.tsx");
  assert.ok(home.includes("router.push({ pathname: '/market-report', params: homeMarketRouteParams(market.report) })"));
  assert.equal((home.match(/pathname: '\/market-report'/g) ?? []).length, 1, "one report entry on Home");
  assert.ok(!home.includes("/report-detail"), "Home does not open a personalized report any more");
});

test("Home never uses the nested /reports/[id] (it would switch the tab and land on the reports list)", async () => {
  const home = await code("src/app/(tabs)/index.tsx");
  assert.ok(!home.includes("/reports/[id]") && !/pathname:\s*'\/reports/.test(home));
});

test("each origin keeps its own contract: Home and the portfolio -> root, the レポート tab -> nested", async () => {
  const origins: Array<[string, string, boolean]> = [
    ["src/app/(tabs)/index.tsx", "/market-report", true],
    ["src/app/(tabs)/index.tsx", "/report-detail", false],
    ["src/components/portfolio/portfolio-sections.tsx", "/report-detail", true],
    ["src/app/(tabs)/reports/index.tsx", "/reports/[id]", true],
  ];
  for (const [file, route, expected] of origins) {
    const text = await code(file);
    assert.equal(text.includes(`pathname: '${route}'`), expected, `${file} -> ${route}`);
  }
  const reports = await code("src/app/(tabs)/reports/index.tsx");
  assert.ok(!reports.includes("/report-detail"), "the レポート tab list -> detail -> back stays on the reports list");
  const explore = await code("src/app/(tabs)/explore.tsx");
  assert.ok(!explore.includes("/reports/") && !explore.includes("/report-detail"), "the 銘柄 tab goes through the portfolio sections only");
});

test("the root route is the same screen as the nested one (no second copy) and is registered with a native header", async () => {
  const route = await code("src/app/report-detail.tsx");
  assert.ok(route.includes("import ReportDetailScreen from './(tabs)/reports/[id]';"));
  const root = await read("src/app/_layout.tsx");
  assert.ok(root.includes('name="report-detail"'));
});
