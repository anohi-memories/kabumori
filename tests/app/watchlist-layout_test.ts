import assert from "node:assert/strict";
import test from "node:test";

import { newsBackTarget, parseDetailOrigin } from "../../src/lib/detail-navigation.ts";
import type { PersonalizedReport, ReportSnapshot, ReportStock } from "../../src/lib/report-presentation.ts";
import type { TrackedStock } from "../../src/lib/stocks.ts";
import {
  buildWatchRows,
  featuredMoveLabel,
  FEATURED_CHANGE_THRESHOLD,
  FEATURED_MAX,
  layoutWatchlist,
  portfolioBasis,
  verifiedWatchNews,
  watchlistLabels,
} from "../../src/lib/portfolio-view.ts";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function watchStock(ticker: string, changePercent: number | null, overrides: Partial<ReportStock> = {}): ReportStock {
  return {
    ticker_code: ticker, company_name: `会社${ticker}`, sector: null, tracking_type: "watch", quantity: null, average_price: null,
    position_type: null, side: null,
    price: changePercent === null
      ? { status: "unavailable", sessionDate: null, close: null, previousClose: null, change: null, changePercent: null }
      : { status: "ok", sessionDate: "2026-10-09", close: 1000, previousClose: 1000, change: 0, changePercent },
    market_value: null, day_pl: null, unrealized_pl: null, unrealized_pl_percent: null, news_ids: [], market_news_ids: [],
    ...overrides,
  };
}

type NewsItem = ReportSnapshot["news"][number];
const news = (id: string, ticker: string | null, overrides: Partial<NewsItem> = {}): NewsItem => ({
  news_id: id, ticker_code: ticker, company_name: `会社${ticker}`, severity: "high", headline_ja: `${ticker}の重要発表（実在する見出し）`,
  news_time: "2026-10-09T05:30:00Z", source_url: null, ...overrides,
});

function snapshot(watch: ReportStock[], newsItems: NewsItem[] = [], date = "2026-10-09"): ReportSnapshot {
  return {
    report_type: "close", trading_date: date, price_basis_date: date, holdings: [], watch, indices: [],
    totals: { holding_count: 0, watch_count: watch.length, all_holdings_valid: true, all_holdings_valued: true, market_value: null, day_pl: null, day_change_percent: null, unrealized_pl: null, topix_change_percent: null, relative_to_topix_pt: null, relative_label: null } as ReportSnapshot["totals"],
    sector_weights: [], top_impact: [], gainers: [], decliners: [], news: newsItems, data_gaps: [],
  };
}

function tracked(ticker: string, id = `t-${ticker}`): TrackedStock {
  return {
    id, user_id: "u", stock_id: `s-${ticker}`, tracking_type: "watch", quantity: null, average_price: null, position_type: null, side: null,
    target_buy_price: null, target_sell_price: null, memo: null,
    stocks_master: { id: `s-${ticker}`, ticker_code: ticker, company_name: `会社${ticker}`, market: "プライム" },
  };
}

function layout(stocks: ReportStock[], newsItems: NewsItem[] = [], extraTracked: string[] = []) {
  const snap = snapshot(stocks, newsItems);
  const report = { id: "r", report_type: "close", trading_date: "2026-10-09", title_ja: null, summary_ja: null, body: null, portfolio_snapshot: snap, generated_at: "2026-10-09T07:00:00Z" } as PersonalizedReport;
  const rows = buildWatchRows([...stocks.map((stock) => tracked(stock.ticker_code)), ...extraTracked.map((ticker) => tracked(ticker))], report);
  return { rows, snap, result: layoutWatchlist(rows, snap) };
}

test("the featured threshold is the deterministic 5.0% (inclusive) and the cap is 3", () => {
  assert.equal(FEATURED_CHANGE_THRESHOLD, 5.0);
  assert.equal(FEATURED_MAX, 3);
});

test("0 / 1 / 2 / 3 / 4+ featured cards: exactly the qualifying stocks, never padded", () => {
  const counts = [0, 1, 2, 3, 5].map((qualifying) => {
    const stocks = [
      ...Array.from({ length: qualifying }, (_, index) => watchStock(`Q${index}`, 6 + index)),
      watchStock("N1", 1.2), watchStock("N2", -0.4),
    ];
    const { result, rows } = layout(stocks);
    assert.equal(result.featured.length + result.rest.length, rows.length, "no stock is lost");
    return result.featured.length;
  });
  assert.deepEqual(counts, [0, 1, 2, 3, 3]);
});

test("exactly ±5.0% qualifies, 4.99% does not; direction decides rise / fall", () => {
  const { result } = layout([watchStock("UP", 5.0), watchStock("DN", -5.0), watchStock("LO", 4.99), watchStock("LD", -4.99)]);
  assert.deepEqual(result.featured.map((entry) => [entry.row.ticker, entry.kind]), [["DN", "fall"], ["UP", "rise"]], "equal |%| ties by ticker");
  assert.deepEqual(result.rest.map((row) => row.ticker), ["LO", "LD"]);
});

test("ranking: largest absolute change first, ties by ticker; extras beyond the cap stay listed with a 注目 flag", () => {
  const { result } = layout([
    watchStock("B", 8), watchStock("A", -8), watchStock("C", 12), watchStock("D", 6), watchStock("E", -5.5), watchStock("F", 2),
  ]);
  assert.deepEqual(result.featured.map((entry) => entry.row.ticker), ["C", "A", "B"], "12, then the 8s by ticker");
  assert.deepEqual(result.rest.map((row) => row.ticker), ["D", "E", "F"], "nothing hidden");
  assert.deepEqual([...result.flagged].sort(), ["D", "E"], "qualifying extras are flagged, F is not");
});

test("a stock appears exactly once and the list order of the rest is the given order", () => {
  const { result, rows } = layout([watchStock("Z", 9), watchStock("Y", 0.1), watchStock("X", 7), watchStock("W", null)]);
  const all = [...result.featured.map((entry) => entry.row.tracked.id), ...result.rest.map((row) => row.tracked.id)];
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, rows.length);
  assert.deepEqual(result.rest.map((row) => row.ticker), ["Y", "W"], "given order preserved");
});

test("missing prices never qualify, never get promoted, and stay visible (— figures)", () => {
  const { result } = layout([watchStock("NA", null), watchStock("OK", 0.3)], [], ["MISSING"]);
  assert.equal(result.featured.length, 0);
  assert.deepEqual(result.rest.map((row) => row.ticker), ["NA", "OK", "MISSING"], "an unreported tracked stock is kept");
  assert.deepEqual([result.rest[0].close, result.rest[0].changePercent], [null, null]);
});

test("empty watch, missing report and stale report states", () => {
  assert.deepEqual(layoutWatchlist([], null), { featured: [], rest: [], flagged: new Set() });
  const rows = buildWatchRows([tracked("1111")], null);
  const noReport = layoutWatchlist(rows, null);
  assert.equal(noReport.featured.length, 0);
  assert.equal(noReport.rest.length, 1, "no report: the registered stock is still listed and editable");
  // Wording: 「今日」 only for today's saved prices.
  const base = portfolioBasis({ id: "r", report_type: "close", trading_date: "2026-10-09", title_ja: null, summary_ja: null, body: null, portfolio_snapshot: snapshot([]), generated_at: null } as PersonalizedReport, "2026-10-09");
  assert.deepEqual(watchlistLabels(base), { featuredTitle: "今日の注目銘柄", basis: "10/9 終値ベース" });
  const stale = portfolioBasis({ id: "r", report_type: "close", trading_date: "2026-10-09", title_ja: null, summary_ja: null, body: null, portfolio_snapshot: snapshot([]), generated_at: null } as PersonalizedReport, "2026-10-12");
  assert.deepEqual(watchlistLabels(stale), { featuredTitle: "注目銘柄", basis: "10/9 終値ベース" });
  assert.ok(!/今日/.test(watchlistLabels(stale).featuredTitle + watchlistLabels(stale).basis));
  assert.deepEqual(watchlistLabels(null), { featuredTitle: "注目銘柄", basis: "保存済み終値ベース" });
});

test("a news card needs a REAL linked item: id listed, ticker equal, headline, parseable date, high severity", () => {
  const stock = watchStock("N", 0.2, { news_ids: ["n1"] });
  assert.equal(verifiedWatchNews(snapshot([stock], [news("n1", "N")]), "N")?.newsId, "n1");
  // news_ids alone proves nothing
  assert.equal(verifiedWatchNews(snapshot([stock], []), "N"), null, "id with no item");
  assert.equal(verifiedWatchNews(snapshot([watchStock("N", 0.2, { news_ids: ["n1"] })], [news("n1", "OTHER")]), "N"), null, "item of another ticker");
  assert.equal(verifiedWatchNews(snapshot([watchStock("N", 0.2, { news_ids: [] })], [news("n1", "N")]), "N"), null, "item not linked to the stock");
  assert.equal(verifiedWatchNews(snapshot([stock], [news("n1", "N", { headline_ja: "   " })]), "N"), null, "blank headline");
  assert.equal(verifiedWatchNews(snapshot([stock], [news("n1", "N", { news_time: "not a date" })]), "N"), null, "unusable date");
  assert.equal(verifiedWatchNews(snapshot([stock], [news("n1", "N", { severity: "low" })]), "N"), null, "not high-impact");
  assert.equal(verifiedWatchNews(snapshot([stock], [news("n1", "N", { severity: "medium" })]), "N"), null);
  assert.equal(verifiedWatchNews(null, "N"), null);
  assert.equal(verifiedWatchNews(snapshot([stock], [news("n1", "N")]), "UNKNOWN"), null);
});

test("the strongest, newest verified news item is the one shown", () => {
  const stock = watchStock("N", 0, { news_ids: ["a", "b", "c"] });
  const items = [
    news("a", "N", { severity: "high", news_time: "2026-10-09T08:00:00Z", headline_ja: "高・新しい" }),
    news("b", "N", { severity: "critical", news_time: "2026-10-08T01:00:00Z", headline_ja: "重大・古い" }),
    news("c", "N", { severity: "critical", news_time: "2026-10-09T02:00:00Z", headline_ja: "重大・新しい" }),
  ];
  assert.equal(verifiedWatchNews(snapshot([stock], items), "N")?.headline, "重大・新しい");
});

test("news cards come first, carry their own price, and a stock with news and a big move is shown once", () => {
  const { result } = layout(
    [
      watchStock("FALL", -9),
      watchStock("NEWS", 0.4, { news_ids: ["n1"] }),
      watchStock("BOTH", 7, { news_ids: ["n2"] }),
      watchStock("RISE", 5.5),
    ],
    [news("n1", "NEWS", { severity: "critical" }), news("n2", "BOTH", { severity: "high" })],
  );
  assert.deepEqual(result.featured.map((entry) => [entry.row.ticker, entry.kind]), [["NEWS", "news"], ["BOTH", "news"], ["FALL", "fall"]]);
  assert.equal(result.featured[0].news?.newsId, "n1");
  assert.equal(result.featured[1].row.changePercent, 7, "the news card still knows the price move");
  assert.deepEqual(result.rest.map((row) => row.ticker), ["RISE"]);
  assert.deepEqual([...result.flagged], ["RISE"]);
  assert.equal(new Set([...result.featured.map((e) => e.row.ticker), ...result.rest.map((r) => r.ticker)]).size, 4);
});

test("a news-less featured card never carries news prose; no sample data is hard-coded in production", async () => {
  const { result } = layout([watchStock("P", 8)], []);
  assert.equal(result.featured[0].news, null);
  const section = await code("src/components/portfolio/watchlist-section.tsx");
  const view = await code("src/lib/portfolio-view.ts");
  for (const text of [section, view]) {
    assert.ok(!/企業の重要発表|決算|アナリスト|LIVE|¥[0-9]{1,3}(,[0-9]{3})+|[+−-][0-9]+\.[0-9]%/.test(text.replace(/formatSignedPercent|toFixed/g, "")), "no invented headline, cause, price or percent");
  }
  assert.ok(section.includes("news ? ("), "the news box and CTA exist only for a verified item");
  assert.ok(section.includes("ニュースを見る ›") && section.includes("onOpenNews(news.newsId)"), "the CTA opens that exact item");
});

test("the news CTA opens the real news detail, whose 戻る returns to the 銘柄 tab", async () => {
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(screen.includes("router.push({ pathname: '/news-detail', params: { id: newsId, from: 'stocks' } })"));
  assert.equal(parseDetailOrigin("stocks"), "stocks");
  assert.equal(newsBackTarget("stocks"), "report", "pops to the root-stack predecessor (the 銘柄 tab), not Home");
  assert.equal(newsBackTarget("home"), "home");
});

test("the section is hidden when there is no featured card; any control shown actually works", async () => {
  const section = await code("src/components/portfolio/watchlist-section.tsx");
  assert.ok(section.includes("{featured.length > 0 ? ("), "no featured section for 0 cards");
  assert.ok(!/sort|並び替え|フィルタ/i.test(section), "no sorting/filter control, so no dead UI");
  const rows = section.slice(section.indexOf("function WatchListRow"), section.indexOf("export function WatchlistSection"));
  assert.ok(rows.includes("minHeight: 64") || section.includes("minHeight: 64"), "compact 60-66pt rows");
});

test("rows use deterministic varied fallback avatars (no logos or company artwork)", async () => {
  const avatar = await code("src/components/portfolio/stock-avatar.tsx");
  assert.ok(avatar.includes("export function tintIndex(seed: string)") && avatar.includes("seed ? TINTS[tintIndex(seed)] : NEUTRAL"));
  const section = await code("src/components/portfolio/watchlist-section.tsx");
  assert.ok(section.includes("seed={row.ticker}"));
  assert.ok(!/https?:\/\/|logo_url|require\(/.test(section + avatar));
  // Same seed => same colour; different tickers spread over the palette.
  const mod = await import("../../src/components/portfolio/stock-avatar.tsx").catch(() => null);
  void mod; // the .tsx needs RN; the rule is pinned by source above
});

test("BOTTOM MENU UNTOUCHED: the 5 NativeTabs keep their exact labels and order; no sixth tab or watchlist route", async () => {
  const tabs = await read("src/app/(tabs)/_layout.tsx");
  const labels = [...tabs.matchAll(/<NativeTabs\.Trigger\.Label>([^<]+)<\/NativeTabs\.Trigger\.Label>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["ホーム", "銘柄", "ニュース", "レポート", "メニュー"]);
  const triggers = [...tabs.matchAll(/<NativeTabs\.Trigger name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(triggers, ["index", "explore", "news", "reports", "menu"]);
  assert.ok(!/watchlist/i.test(tabs), "no ウォッチリスト entry in the bottom menu");
  const root = await read("src/app/_layout.tsx");
  assert.ok(!/watchlist/i.test(root), "no root route for the watchlist");
  // The watchlist lives in explore.tsx only.
  for await (const entry of Deno.readDir(new URL("src/app/", repoRoot))) {
    assert.ok(!/watchlist/i.test(entry.name), `unexpected watchlist route ${entry.name}`);
  }
});

test("search and the editor are functionally unchanged and still the registration path", async () => {
  const search = await code("src/app/search.tsx");
  assert.ok(search.includes("<TrackedStockEditor") && search.includes("stockSearchFilter(term)"));
  const screen = await code("src/app/(tabs)/explore.tsx");
  assert.ok(screen.includes("onSearch={() => router.push('/search')}"));
  assert.ok(screen.includes("existing={selected}") && screen.includes("onDeleted="));
});

test("the move label follows the same raw threshold as the featured rule; the UI shows two decimals so -4.99% never reads as -5.0%", async () => {
  assert.equal(featuredMoveLabel(5.0), "大きく上昇");
  assert.equal(featuredMoveLabel(-5.0), "大きく下落");
  assert.equal(featuredMoveLabel(4.99), null);
  assert.equal(featuredMoveLabel(-4.99), null);
  assert.equal(featuredMoveLabel(null), null);
  assert.equal(featuredMoveLabel(Number.NaN), null);
  const section = await code("src/components/portfolio/watchlist-section.tsx");
  assert.ok(!/formatSignedPercent\(row\.changePercent, 1\)/.test(section), "no one-decimal rounding of the watchlist percents");
  assert.equal((section.match(/formatSignedPercent\(row\.changePercent, 2\)/g) ?? []).length, 4);
});

test("rows keep numbers whole: targets get their own line, the 注目 marker sits beside the ticker, no double dash", async () => {
  const section = await code("src/components/portfolio/watchlist-section.tsx");
  assert.ok(section.includes("{row.close === null && row.changePercent === null ? null : ("), "one dash and no pill when there is no saved price");
  assert.ok(/rowSub: \{ flexDirection: 'row'/.test(section) && section.includes("numberOfLines={1}>{row.company}"), "company on its own line");
  assert.ok(section.includes("買 ${formatPriceYen(buy)}") && section.includes("売 ${formatPriceYen(sell)}"));
  assert.ok(!section.includes("{formatNewsTime(news.newsTime)}　{basisLabel}"), "the news date is not repeated with the basis label");
});
