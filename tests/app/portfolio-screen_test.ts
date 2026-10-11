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
    "<StocksHeader",
    "<StocksSwitch",
    "<AssetSummaryCard",
    "<AiSummaryCard",
    "<ImpactCard",
    "<HoldingsHeader",
    "<HoldingsList",
    "<AskAiCta />",
  ].map((needle) => screen.indexOf(needle));
  assert.ok(order.every((position) => position >= 0), order.join(","));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "header, switch, summary, AI, impact, holdings, CTA");
  assert.ok(screen.includes("useState<StocksView>('portfolio')"), "portfolio is the default view");
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
  assert.ok(screen.includes("reportsFailed() { setReportError(true); }"), "a failed report only raises the banner");
  assert.ok(screen.includes("runPortfolioLoad(loadGate, { fetchRegistrations, fetchReports: () => fetchRecentReports(20) }, sink)"));
  assert.ok(screen.includes("レポートのデータを読み込めませんでした。引っ張って更新できます。"));
  assert.ok(screen.includes("<RefreshControl"), "pull to refresh");
  assert.ok(screen.includes("一覧を読み込めませんでした。"), "the tracked_stocks failure message is kept");
  assert.ok(screen.includes("buildHoldingRows(items, report, registrationMatchesSnapshot)"), "holdings are built from the registrations, not from the report");
});

// Stale-valuation guard: the saved valuation is paired with the registrations only once they are KNOWN, with the
// same exact-match predicate the stock detail uses.
test("the tab pairs the saved valuation only with registrations it actually read, through the detail's own predicate", async () => {
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(screen.includes("import { registrationMatchesSnapshot, trackedDetailHref } from '@/lib/stock-detail-view';"));
  assert.ok(screen.includes("const [registrationsReady, setRegistrationsReady] = useState(false);"));
  assert.ok(screen.includes("const registrations = registrationsReady ? items : null;"), "an unknown / pending set is null, never []");
  assert.ok(screen.includes("assetSummary(basis?.snapshot ?? null, registrations, registrationMatchesSnapshot)"));
  assert.ok(screen.includes("topImpacts(basis?.snapshot ?? null, registrations, registrationMatchesSnapshot)"));
  assert.ok(screen.includes("registrationsReady && !loading && !message"), "the 'no holdings yet' empty state needs a verified-empty account");
  const view = await code("src/lib/portfolio-view.ts");
  assert.ok(!/from '[^']*stock-detail-view'/.test(view), "the pure module receives the predicate; it does not import it");
});

// K1 correction (PR #142): a focus reload / pull-to-refresh must not show the PREVIOUS load's registrations paired
// with the saved report as if they were current. The load sequence is the pure `runPortfolioLoad`; these tests drive
// it with controllable promises and record exactly what the screen's sink would receive.
type Reg = { id: string };
type Rep = { id: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function harness() {
  const { createLatestLoadGate, runPortfolioLoad } = await import("../../src/lib/portfolio-load.ts");
  type Result = { status: "ok"; items: Reg[] } | { status: "signed_out" } | { status: "failed" };
  const gate = createLatestLoadGate();
  const events: string[] = [];
  const sink = {
    begin: () => { events.push("begin"); },
    reports: (next: Rep) => { events.push(`reports:${next.id}`); },
    reportsFailed: () => { events.push("reportsFailed"); },
    registrations: (result: Result) => { events.push(`registrations:${result.status === "ok" ? result.items.map((i) => i.id).join(",") : result.status}`); },
    settled: (ready: boolean) => { events.push(`settled:${ready}`); },
  };
  // One controllable request pair per load.
  const pending: Array<{ regs: ReturnType<typeof deferred<Result>>; reps: ReturnType<typeof deferred<Rep>> }> = [];
  const start = () => {
    const regs = deferred<Result>();
    const reps = deferred<Rep>();
    pending.push({ regs, reps });
    events.push("call");
    return runPortfolioLoad<Reg, Rep>(gate, { fetchRegistrations: () => regs.promise, fetchReports: () => reps.promise }, sink);
  };
  return { events, pending, start };
}

test("a reload makes valuations ineligible before any request is awaited, and they come back only when this load settled", async () => {
  const h = await harness();
  const run = h.start();
  assert.deepEqual(h.events, ["call", "begin"], "begin() has already run synchronously, before the first await");
  const first = h.pending[0];
  await tick();
  // The report arrives first: it is applied, but nothing is settled -- the surfaces still get no registrations.
  first.reps.resolve({ id: "r-new" });
  await tick();
  assert.ok(h.events.includes("reports:r-new"));
  assert.ok(!h.events.some((e) => e.startsWith("settled")), "not eligible while the registrations are pending");
  first.regs.resolve({ status: "ok", items: [{ id: "a" }] });
  await run;
  assert.deepEqual(h.events.filter((e) => e !== "call"), ["begin", "reports:r-new", "registrations:a", "settled:true"]);
  assert.ok(h.events.indexOf("settled:true") > h.events.indexOf("registrations:a"), "ready is the LAST event of the load");
});

test("the registrations are applied in the same load generation as its report: settled only after both", async () => {
  const h = await harness();
  const run = h.start();
  const first = h.pending[0];
  first.regs.resolve({ status: "ok", items: [{ id: "a" }] });
  await tick();
  assert.ok(h.events.includes("registrations:a"));
  assert.ok(!h.events.includes("settled:true"), "registrations alone do not re-open valuations; the report is still pending");
  first.reps.resolve({ id: "r1" });
  await run;
  assert.equal(h.events.at(-1), "settled:true");
});

test("signed out, a failed read, or a thrown read stays unknown (settled false) and never reads as 'no holdings'", async () => {
  for (const outcome of ["signed_out", "failed", "throws"] as const) {
    const h = await harness();
    const run = h.start();
    const first = h.pending[0];
    first.reps.resolve({ id: "r1" });
    if (outcome === "throws") first.regs.reject(new Error("network"));
    else first.regs.resolve({ status: outcome });
    await run;
    assert.equal(h.events.at(-1), "settled:false", outcome);
    assert.ok(h.events.includes(outcome === "throws" ? "registrations:failed" : `registrations:${outcome}`), outcome);
    assert.ok(!h.events.includes("settled:true"), outcome);
  }
});

test("a failed report with a successful registration read still settles (the last good report is paired as before)", async () => {
  const h = await harness();
  const run = h.start();
  const first = h.pending[0];
  first.reps.reject(new Error("offline"));
  first.regs.resolve({ status: "ok", items: [{ id: "a" }] });
  await run;
  const seq = h.events.filter((e) => e !== "call");
  assert.deepEqual([seq[0], seq.at(-1)], ["begin", "settled:true"]);
  assert.deepEqual([...seq.slice(1, -1)].sort(), ["registrations:a", "reportsFailed"], "both results applied before settling, in either arrival order");
});

test("overlapping reloads: a slower older load can neither overwrite newer data nor re-open valuations", async () => {
  const h = await harness();
  const older = h.start();           // e.g. the tab-focus load
  const newer = h.start();           // e.g. a pull-to-refresh right behind it
  const [a, b] = h.pending;
  // The newer load finishes first.
  b.reps.resolve({ id: "r-B" });
  b.regs.resolve({ status: "ok", items: [{ id: "B" }] });
  await newer;
  const afterNewer = h.events.slice();
  assert.equal(afterNewer.at(-1), "settled:true");
  // The older load answers afterwards: nothing it carries may reach the sink.
  a.reps.resolve({ id: "r-A" });
  a.regs.resolve({ status: "ok", items: [{ id: "A" }] });
  await older;
  assert.deepEqual(h.events, afterNewer, "the stale load is silent");
  assert.ok(!h.events.includes("registrations:A") && !h.events.includes("reports:r-A"));
});

test("overlapping reloads: an older load that answers FIRST does not open valuations while the newer one is pending", async () => {
  const h = await harness();
  const older = h.start();
  const newer = h.start();
  const [a, b] = h.pending;
  a.reps.resolve({ id: "r-A" });
  a.regs.resolve({ status: "ok", items: [{ id: "A" }] });
  await older;
  assert.ok(!h.events.includes("settled:true"), "stale: it must not re-open valuations");
  assert.ok(!h.events.includes("registrations:A"));
  b.reps.resolve({ id: "r-B" });
  b.regs.resolve({ status: "ok", items: [{ id: "B" }] });
  await newer;
  const seq = h.events.filter((e) => e !== "call");
  assert.deepEqual(seq.slice(0, 2), ["begin", "begin"]);
  assert.equal(seq.at(-1), "settled:true");
  assert.deepEqual([...seq.slice(2, -1)].sort(), ["registrations:B", "reports:r-B"], "only the newer load's data, then settled");
});

test("the next successful load recovers the original values: begin -> settled(true) again after a failed one", async () => {
  const h = await harness();
  const first = h.start();
  h.pending[0].reps.resolve({ id: "r1" });
  h.pending[0].regs.resolve({ status: "failed" });
  await first;
  const second = h.start();
  h.pending[1].reps.resolve({ id: "r2" });
  h.pending[1].regs.resolve({ status: "ok", items: [{ id: "a" }] });
  await second;
  assert.deepEqual(h.events.filter((e) => e.startsWith("settled")), ["settled:false", "settled:true"]);
});

test("the gate is latest-wins and pure", async () => {
  const { createLatestLoadGate } = await import("../../src/lib/portfolio-load.ts");
  const gate = createLatestLoadGate();
  const a = gate.begin();
  assert.equal(gate.isLatest(a), true);
  const b = gate.begin();
  assert.deepEqual([gate.isLatest(a), gate.isLatest(b)], [false, true]);
  const text = await Deno.readTextFile(new URL("../../src/lib/portfolio-load.ts", import.meta.url));
  assert.ok(!/^import /m.test(text), "no import at all (no RN, no Supabase)");
});

test("the tab hands every load to runPortfolioLoad; the sink closes valuations at begin and opens them only at settled", async () => {
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(screen.includes("import { createLatestLoadGate, runPortfolioLoad"));
  assert.ok(screen.includes("const [loadGate] = useState(createLatestLoadGate);"));
  assert.ok(/begin\(\) \{\s*setRegistrationsReady\(false\);\s*setLoading\(true\);\s*setMessage\(''\);/.test(screen), "begin closes valuations before anything else");
  assert.ok(/settled\(ready\) \{\s*setLoading\(false\);\s*setRegistrationsReady\(ready\);/.test(screen), "ready is applied only by settled");
  assert.equal((screen.match(/setRegistrationsReady\(/g) ?? []).length, 2, "begin and settled are the only writers");
  assert.ok(screen.includes("runPortfolioLoad(loadGate,") && !/await supabase\.auth\.getUser\(\);\s*if \(authError[\s\S]{0,40}setItems/.test(screen));
  // Cached registrations stay LISTED while a reload is pending, but are never priced or valued.
  assert.ok(screen.includes("buildHoldingRows(items, null, registrationMatchesSnapshot)"));
  assert.ok(screen.includes("hasReport={!!basis && registrationsReady}"), "no 未反映 tag for rows that are merely waiting for the reload");
  // The three financial surfaces never see the cached set.
  assert.ok(screen.includes("assetSummary(basis?.snapshot ?? null, registrations, registrationMatchesSnapshot)"));
  assert.ok(screen.includes("topImpacts(basis?.snapshot ?? null, registrations, registrationMatchesSnapshot)"));
});

test("a withheld valuation is explained, never spoken or drawn as current", async () => {
  const holdings = await code("src/components/portfolio/holdings-section.tsx");
  assert.ok(holdings.includes("row.valuationChanged ? REGISTRATION_CHANGED_NOTE"), "the accessibility label carries the note instead of the old P/L");
  assert.ok(holdings.includes("row.reflected && !row.valuationChanged && (!!row.tag || !!row.line)"), "report prose about the old position is hidden");
  const sections = await code("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(sections.includes("summary.withheld === 'changed' ? <Text style={styles.note}>{REGISTRATION_CHANGED_NOTE}</Text> : null"));
  assert.ok(sections.includes("資産評価額 更新待ち"));
  assert.ok(!/withheld[^;\n]*formatAmount/.test(sections), "no amount is formatted from a withheld total");
});

test("a holding row opens the read-only 銘柄詳細 (not the editor); the editor is reached from there", async () => {
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(!screen.includes("<TrackedStockEditor") && !screen.includes("setSelected"), "viewing never opens the editor from the tab");
  assert.ok(screen.includes("router.push(trackedDetailHref(trackedId))") && screen.includes("onOpen={openDetail}"));
  const holdings = await read("src/components/portfolio/holdings-section.tsx");
  assert.ok(holdings.includes('accessibilityHint="この保有銘柄の詳細を開きます"'));
  assert.ok(!/router\.|pathname/.test(holdings), "the row only calls back; the screen decides where it goes");
  const detail = await code("src/app/stock-detail.tsx");
  assert.ok(detail.includes("<TrackedStockEditor") && detail.includes("登録内容を編集"));
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
  assert.ok(sections.includes("router.push({ pathname: '/report-detail', params: { id: reportId } })"));
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
    // The one allowed asset is the approved decorative background of the asset-summary card (not a company logo).
    const text = (await code(path)).replace(/const ASSET_CARD_BACKGROUND = require\('@\/assets\/images\/portfolio\/portfolio_asset_card_growth_background\.webp'\);/, "");
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
  assert.ok(search.includes("if (registered) router.push(searchResultDetailHref(item.id)); else setSelected(item);"), "registered -> detail, unregistered -> the registration editor");
  assert.ok(search.includes("registered ? '登録済み ›' : '登録する'"));
});

test("Watchlist is a subview of the SAME 銘柄 tab behind a two-segment switch (no new route, no sixth tab, no tags)", async () => {
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(screen.includes("<StocksSwitch view={view} onChange={setView} />"), "one shared switch, both directions");
  assert.ok(screen.includes("{view === 'portfolio' ? ("), "the two subviews render under the same header");
  assert.ok(!/ウォッチリスト.*router\.push|router\.push\([^)]*watch/i.test(screen), "switching is local state, not navigation");
  assert.ok(screen.includes("監視銘柄はまだありません。気になる銘柄を検索から登録できます。"), "honest empty state");
  assert.ok(screen.includes("onOpen={openDetail}"), "watch rows and featured cards open the detail, where the existing editor is one button away");
  assert.ok(!screen.includes("<TrackedStockEditor"));
  assert.ok(!/\btags?\b|タグ|label_ids|category_id/i.test(screen), "no tag UI or schema is invented");
  const root = await read("src/app/_layout.tsx");
  assert.ok(!root.includes("watchlist"), "the root navigator is untouched");
  const switcher = await code("src/components/portfolio/portfolio-sections.tsx");
  assert.ok(switcher.includes('accessibilityRole="tablist"') && switcher.includes('accessibilityRole="tab"'));
  assert.ok(switcher.includes("accessibilityState={{ selected }}") && switcher.includes("onPress={() => onChange(item.view)}"));
  assert.ok(switcher.includes("{ view: 'portfolio', label: 'ポートフォリオ' }") && switcher.includes("{ view: 'watchlist', label: 'ウォッチリスト' }"));
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
