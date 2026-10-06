// The portfolio dashboard and the search screen are React Native, so their contracts are pinned by reading the
// source as text, like the rest of this suite (the pure parts are covered behaviourally in portfolio-view_test).
import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeStockSearchTerm,
  STOCK_SEARCH_DEBOUNCE_MS,
  STOCK_SEARCH_LIMIT,
  stockSearchFilter,
} from "../../src/lib/stock-search.ts";
import { partitionTrackedStocks } from "../../src/lib/stock-sections.ts";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
const exists = (path: string) => Deno.stat(new URL(path, repoRoot)).then(() => true, () => false);

test("the 銘柄 tab opens on the canonical portfolio dashboard, in the canonical order", async () => {
  const screen = await read("src/app/(tabs)/explore.tsx");
  const order = [
    "<PortfolioHeader",
    "<AssetSummaryCard",
    "<AiSummaryCard",
    "<ImpactCard",
    "<HoldingsHeader",
    "<HoldingsList",
    "<AskAiCta />",
  ].map((needle) => screen.indexOf(needle));
  assert.ok(order.every((position) => position >= 0), order.join(","));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "header, summary, AI, impact, holdings, CTA");
  assert.ok(screen.includes("useState<'portfolio' | 'watchlist'>('portfolio')"), "portfolio is the default view");
  const sections = await read("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(sections.includes("PORTFOLIO") && sections.includes("ポートフォリオ") && sections.includes("ウォッチリスト"));
  assert.ok(sections.includes("このポートフォリオについてAIに聞く ›") && sections.includes("なぜ上がった？ リスクは？ 業種のバランスは？"));
  const holdings = await read("src/components/portfolio/holdings-section.tsx");
  assert.ok(holdings.includes("保有銘柄") && holdings.includes("{count}銘柄"));
});

test("no fake realtime: figures are labelled as saved close-report data and never 現在値", async () => {
  for (const path of ["src/app/(tabs)/explore.tsx", "src/components/portfolio/portfolio-sections.tsx", "src/components/portfolio/holdings-section.tsx", "src/lib/portfolio-view.ts"]) {
    const text = await code(path);
    assert.ok(!/現在値|リアルタイム価格です|ライブ/.test(text.replace("リアルタイム価格ではありません", "")), path);
  }
  const sections = await read("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(sections.includes("（保存済み大引け）") && sections.includes("評価額は大引けレポート作成後に表示されます"));
  const holdings = await read("src/components/portfolio/holdings-section.tsx");
  assert.ok(holdings.includes("labels.priceWord") && holdings.includes("最新レポート未反映"));
  const screen = await read("src/app/(tabs)/explore.tsx");
  assert.ok(screen.includes("リアルタイム価格ではありません"));
});

test("the data comes from the saved reports and the user's registrations; nothing is generated or invented", async () => {
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(screen.includes("fetchRecentReports(20)") && screen.includes("latestCloseReport(reports)"));
  assert.ok(screen.includes("from('tracked_stocks')") && screen.includes("is_active"));
  assert.ok(!/openai|anthropic|functions\.invoke|\.rpc\(|fetch\(/i.test(screen), "no AI / RPC / network call of its own");
  const view = await code("src/lib/portfolio-view.ts");
  assert.ok(!/supabase|fetch\(|Math\.random|Date\.now|new Date\(/.test(view), "pure and deterministic");
  assert.ok(!/^import (?!type )/m.test(view), "type-only imports (no runtime dependency)");
});

test("holdings and the report load independently: a failed report never hides the registrations", async () => {
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(screen.includes(".catch(() => setReportError(true))"));
  assert.ok(screen.includes("レポートのデータを読み込めませんでした。引っ張って更新できます。"));
  assert.ok(screen.includes("<RefreshControl"), "pull to refresh");
  assert.ok(screen.includes("一覧を読み込めませんでした。"), "the tracked_stocks failure message is kept");
  assert.ok(screen.includes("buildHoldingRows(items, report)"), "holdings are built from the registrations, not from the report");
});

test("holdings stay editable through the existing editor; the row says it edits the holding", async () => {
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(screen.includes("<TrackedStockEditor"));
  assert.ok(screen.includes("existing={selected}") && screen.includes("onSaved={() => { setSelected(null); void load(); }}") && screen.includes("onDeleted="));
  const holdings = await read("src/components/portfolio/holdings-section.tsx");
  assert.ok(holdings.includes('accessibilityHint="この保有銘柄の情報を編集します"'), "no pretend stock-detail screen");
  assert.ok(!/router\.push\(\{ pathname: '\/stock|stock-detail/.test(holdings));
  const editor = await read("src/components/tracked-stock-editor.tsx");
  assert.ok(editor.includes("tracked_stocks"), "the editor itself is unchanged in purpose");
});

test("the header has no logout; logout stays reachable from Settings", async () => {
  const screen = await read("src/app/(tabs)/explore.tsx");
  assert.ok(!/ログアウト|signOut/.test(screen));
  const settings = await read("src/app/settings.tsx");
  assert.ok(settings.includes("signOut"));
  const sections = await read("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(!/ログアウト|signOut/.test(sections));
});

test("impact and AI cards link to the exact report, and are omitted rather than faked", async () => {
  const sections = await code("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(sections.includes("router.push({ pathname: '/reports/[id]', params: { id: reportId } })"));
  assert.ok(sections.includes("onPress={() => openReport(summary.reportId)}") && sections.includes("onPress={() => openReport(reportId)}"));
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(screen.includes("{overview ? <AiSummaryCard"), "no stored overview => no AI card");
  assert.ok(screen.includes("basis && impacts.length > 0 ? <ImpactCard"), "no numeric day P/L => no impact section");
  assert.ok(!/…|moreAction|dead/.test(await code("src/components/portfolio/holdings-section.tsx")), "no dead … control");
});

test("no dead controls, no new dependency: the icons are native shapes", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.ok(!deps.some((name) => /chart|svg|icons|logo|gifted/i.test(name) && name !== "react-native-svg"), "no chart/icon package was added");
  const sections = await code("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(sections.includes("function SearchIcon()") && sections.includes("function BarsMark()"));
  assert.ok(await exists("src/components/portfolio/sparkline.tsx"));
  const spark = await code("src/components/portfolio/sparkline.tsx");
  assert.ok(!/^import .* from '(?!react-native')/m.test(spark), "the sparkline only needs react-native Views");
});

test("fallback avatar slot: one place renders it, no logo URL or company logo is hard-coded", async () => {
  const avatar = await code("src/components/portfolio/stock-avatar.tsx");
  assert.ok(avatar.includes("accessibilityLabel={`${name}のアイコン`}"), "the full company name is in the accessibility label");
  for (const path of ["src/components/portfolio/stock-avatar.tsx", "src/components/portfolio/holdings-section.tsx", "src/components/portfolio/portfolio-sections.tsx", "src/lib/portfolio-view.ts"]) {
    const text = await code(path);
    assert.ok(!/https?:\/\/|logo_url|require\('@\/assets/.test(text), path);
    assert.ok(!/トヨタ|三菱UFJ|ニッスイ|Toyota|MUFG|Nissui/i.test(text), `${path} hard-codes no company`);
  }
});

test("search is a real screen, not a redirect, and the portfolio's search icon opens it", async () => {
  const search = await code("src/app/search.tsx");
  assert.ok(!/Redirect/.test(search));
  assert.ok(search.includes("export default function SearchScreen()") && search.includes("<BackButton />") && search.includes("<TrackedStockEditor"));
  const portfolio = await code("src/app/(tabs)/explore.tsx");
  assert.ok(portfolio.includes("onSearch={() => router.push('/search')}"));
  const root = await read("src/app/_layout.tsx");
  assert.ok(root.includes('<Stack.Screen name="search" />'), "search was already a registered root screen");
});

test("search semantics are preserved: debounce, sanitizing, limit 30, registered check", async () => {
  assert.equal(STOCK_SEARCH_DEBOUNCE_MS, 350);
  assert.equal(STOCK_SEARCH_LIMIT, 30);
  assert.equal(sanitizeStockSearchTerm("  8136,%(x)  "), "8136   x");
  assert.equal(stockSearchFilter("サンリオ"), "ticker_code.ilike.%サンリオ%,company_name.ilike.%サンリオ%");
  assert.equal(stockSearchFilter("a,b"), "ticker_code.ilike.%a b%,company_name.ilike.%a b%");
  const search = await code("src/app/search.tsx");
  assert.ok(search.includes(".eq('is_listed', true)") && search.includes(".or(stockSearchFilter(term))") && search.includes(".limit(STOCK_SEARCH_LIMIT)"));
  assert.ok(search.includes("setTimeout(() => void search(term), STOCK_SEARCH_DEBOUNCE_MS)"));
  assert.ok(search.includes("currentRequest !== requestId.current"), "a stale response never overwrites a newer one");
  assert.ok(search.includes("from('tracked_stocks')") && search.includes(".in('stock_id'"), "registered-state check");
  assert.ok(search.includes("if (!registered) setSelected(item)"), "a registered result opens no duplicate editor");
  assert.ok(search.includes("registered ? '登録済み' : '登録する'"));
});

test("Watchlist is a working interim subview of the same tab (no new root route, no tags yet)", async () => {
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(screen.includes("onWatchlist={() => setView('watchlist')}"));
  assert.ok(screen.includes("‹ ポートフォリオ") && screen.includes("onPress={() => setView('portfolio')}"), "a clear way back");
  assert.ok(screen.includes("監視銘柄はまだありません。気になる銘柄を検索から登録できます。"), "honest empty state");
  assert.ok(screen.includes("onPress={() => setSelected(row.tracked)}") && screen.includes("この監視銘柄の情報を編集または削除します"), "watch records stay editable / deletable");
  assert.ok(!/\btags?\b|タグ|label_ids|category_id/i.test(screen), "no tag UI or schema is invented");
  const root = await read("src/app/_layout.tsx");
  assert.ok(!root.includes("watchlist"), "the root navigator is untouched");
});

test("watch records stay partitioned from holdings (existing helper unchanged)", () => {
  const item = (id: string, kind: "holding" | "watch") => ({ id, tracking_type: kind }) as unknown as Parameters<typeof partitionTrackedStocks>[0][number];
  const parts = partitionTrackedStocks([item("a", "holding"), item("b", "watch"), item("c", "holding")]);
  assert.deepEqual(parts.holding.map((x) => x.id), ["a", "c"]);
  assert.deepEqual(parts.watch.map((x) => x.id), ["b"]);
});

test("the portfolio work does not touch Settings / Auth / common-account code or the root navigator", async () => {
  for (const path of [
    "src/app/(tabs)/explore.tsx", "src/app/search.tsx", "src/lib/portfolio-view.ts",
    "src/components/portfolio/portfolio-sections.tsx", "src/components/portfolio/holdings-section.tsx",
    "src/components/portfolio/stock-avatar.tsx", "src/components/portfolio/sparkline.tsx",
  ]) {
    const text = await code(path);
    assert.ok(!/AuthProvider|use-auth|useAuth|@\/lib\/auth|common-account|service-enrollment|topic-level|writeTopicLevel/i.test(text), path);
  }
  assert.ok(!(await exists("src/components/portfolio-summary.tsx")), "the old summary block was replaced by the dashboard");
});

test("the screens keep the bottom space for the floating tab bar, and the CTA is the last block", async () => {
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(/BOTTOM_SPACE = 28/.test(screen) && screen.includes("paddingBottom: BOTTOM_SPACE"));
  assert.ok(screen.indexOf("<HoldingsList") < screen.indexOf("<AskAiCta />"));
});
