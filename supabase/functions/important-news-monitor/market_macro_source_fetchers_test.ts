import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchMarketMacroSource,
  isFreshMarketMacroPublishedAt,
  MARKET_MACRO_SOURCES,
  normalizeMarketMacroItem,
  parseMarketMacroRss,
  type MarketMacroSource,
} from "./market_macro_source_fetchers.ts";

const now = new Date("2026-09-04T12:00:00Z");
const source = (overrides: Partial<MarketMacroSource> = {}): MarketMacroSource => ({
  key: "boj", sourceName: "market_macro", feedUrl: "https://www.boj.or.jp/rss/whatsnew.xml",
  defaultCategory: "boj", defaultTopicKey: "macro:boj", ...overrides,
});

test("1: corporate lane sources are unaffected — market_macro sources are a distinct, additive list", () => {
  assert.equal(MARKET_MACRO_SOURCES.length, 5);
  assert.deepEqual(MARKET_MACRO_SOURCES.map((item) => item.key).sort(), [
    "boj", "eia", "fed", "un_peace_security", "ustr",
  ]);
});

test("8: BOJ event normalizes without company identity", () => {
  const candidate = normalizeMarketMacroItem(source(), {
    title: "日銀金融政策決定会合の結果について",
    url: "http://www.boj.or.jp/about/press/kk260904.pdf",
    publishedAt: "Fri, 04 Sep 2026 16:00:00 +0900",
    summary: null,
  }, now);
  assert.ok(candidate);
  assert.deepEqual(candidate, {
    sourceType: "market_macro", sourceName: "market_macro",
    sourceUrl: "https://www.boj.or.jp/about/press/kk260904.pdf",
    title: "日銀金融政策決定会合の結果について", bodySummary: null,
    companyName: null, companyCode: null, entityKey: "macro:boj",
    category: "boj", publishedAt: "2026-09-04T07:00:00.000Z",
  });
});

test("9: Fed event normalizes and refines category for FOMC/discount-rate titles", () => {
  const candidate = normalizeMarketMacroItem(source({
    key: "fed", feedUrl: "https://www.federalreserve.gov/feeds/press_all.xml",
    defaultCategory: "frb", defaultTopicKey: "macro:fed",
    refine: (title) => /fomc|discount rate/i.test(title)
      ? { category: "interest_rates", topicKey: "macro:fomc" } : null,
  }), {
    title: "Federal Reserve issues FOMC statement",
    url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260904a.htm",
    publishedAt: "Thu, 04 Sep 2026 08:00:00 GMT",
    summary: "FOMC statement",
  }, now);
  assert.ok(candidate);
  assert.equal(candidate.category, "interest_rates");
  assert.equal(candidate.entityKey, "macro:fomc");
  assert.equal(candidate.companyCode, null);
});

test("10: FX/policy event (USTR) normalizes and refines tariffs vs. china_policy", () => {
  const ustr = source({
    key: "ustr", defaultCategory: "us_government_policy", defaultTopicKey: "policy:ustr",
    refine: (title) => {
      if (/tariff/i.test(title)) return { category: "tariffs", topicKey: "policy:tariff" };
      if (/china/i.test(title)) return { category: "china_policy", topicKey: "policy:china_trade" };
      return null;
    },
  });
  const tariff = normalizeMarketMacroItem(ustr, {
    title: "USTR announces new tariff action",
    url: "https://ustr.gov/about/policy-offices/press-office/press-releases/2026/tariff-action",
    publishedAt: "Thu, 04 Sep 2026 12:00:00 +0000",
    summary: null,
  }, now);
  assert.equal(tariff?.category, "tariffs");
  assert.equal(tariff?.entityKey, "policy:tariff");

  const china = normalizeMarketMacroItem(ustr, {
    title: "USTR statement on China trade relations",
    url: "https://ustr.gov/about/policy-offices/press-office/press-releases/2026/china-statement",
    publishedAt: "Thu, 04 Sep 2026 12:00:00 +0000",
    summary: null,
  }, now);
  assert.equal(china?.category, "china_policy");
});

test("11: geopolitical event (UN News) normalizes and refines ceasefire/sanctions/taiwan", () => {
  const un = source({
    key: "un_peace_security", defaultCategory: "geopolitics", defaultTopicKey: "geo:un",
    refine: (title) => {
      if (/ceasefire/i.test(title)) return { category: "war_ceasefire", topicKey: "geo:ceasefire" };
      if (/sanction/i.test(title)) return { category: "sanctions", topicKey: "geo:sanctions" };
      if (/taiwan/i.test(title)) return { category: "geopolitics", topicKey: "geo:taiwan" };
      return null;
    },
  });
  const ceasefire = normalizeMarketMacroItem(un, {
    title: "UN welcomes ceasefire agreement",
    url: "https://news.un.org/feed/view/en/story/2026/09/1168300",
    publishedAt: "Thu, 04 Sep 2026 08:00:00 -0400",
    summary: null,
  }, now);
  assert.equal(ceasefire?.category, "war_ceasefire");
  const sanctions = normalizeMarketMacroItem(un, {
    title: "Security Council discusses new sanctions regime",
    url: "https://news.un.org/feed/view/en/story/2026/09/1168301",
    publishedAt: "Thu, 04 Sep 2026 08:00:00 -0400",
    summary: null,
  }, now);
  assert.equal(sanctions?.category, "sanctions");
});

test("12: semiconductor macro (EIA-style catch-all source) normalizes without company identity", () => {
  const eia = source({
    key: "eia", feedUrl: "https://www.eia.gov/rss/press_rss.xml",
    defaultCategory: "other_market_moving", defaultTopicKey: "commodity:oil",
  });
  const candidate = normalizeMarketMacroItem(eia, {
    title: "EIA releases weekly petroleum status report",
    url: "/pressroom/releases/press591.php",
    publishedAt: "Tue, 01 Sep 2026 12:00:00 EST",
    summary: null,
  }, now);
  assert.ok(candidate);
  assert.equal(candidate.category, "other_market_moving");
  assert.equal(candidate.entityKey, "commodity:oil");
  assert.equal(candidate.sourceUrl, "https://www.eia.gov/pressroom/releases/press591.php");
  assert.equal(candidate.companyCode, null);
  assert.equal(candidate.companyName, null);
});

test("5: invalid (missing or non-https) source URL is rejected", () => {
  const missingUrl = normalizeMarketMacroItem(source(), {
    title: "何らかの発表", url: "", publishedAt: now.toISOString(), summary: null,
  }, now);
  assert.equal(missingUrl, null);

  const nonHttps = normalizeMarketMacroItem(source(), {
    title: "何らかの発表",
    url: "ftp://www.boj.or.jp/files/doc.pdf",
    publishedAt: now.toISOString(),
    summary: null,
  }, now);
  assert.equal(nonHttps, null);
});

test("6: future timestamp beyond clock-skew tolerance is rejected", () => {
  const farFuture = normalizeMarketMacroItem(source(), {
    title: "将来の発表",
    url: "https://www.boj.or.jp/about/press/kk-future.pdf",
    publishedAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    summary: null,
  }, now);
  assert.equal(farFuture, null);

  const withinSkew = normalizeMarketMacroItem(source(), {
    title: "直近の発表",
    url: "https://www.boj.or.jp/about/press/kk-recent.pdf",
    publishedAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    summary: null,
  }, now);
  assert.ok(withinSkew);
});

test("stale item well beyond the freshness window is rejected", () => {
  assert.equal(isFreshMarketMacroPublishedAt("2009-07-20T18:28:39.000Z", now), false);
  assert.equal(isFreshMarketMacroPublishedAt("2026-09-01T12:00:00.000Z", now), true);
});

test("7: duplicate market_macro items share the same content-hash inputs as any other candidate", async () => {
  const { createImportantNewsContentHash } = await import("./news_candidate_logic.ts");
  const a = normalizeMarketMacroItem(source(), {
    title: "日銀金融政策決定会合の結果について",
    url: "https://www.boj.or.jp/about/press/kk260904.pdf",
    publishedAt: "2026-09-04T07:00:00.000Z",
    summary: null,
  }, now);
  const b = normalizeMarketMacroItem(source(), {
    title: "日銀金融政策決定会合の結果について",
    url: "https://www.boj.or.jp/about/press/kk260904.pdf",
    publishedAt: "2026-09-04T07:00:00.000Z",
    summary: null,
  }, now);
  assert.ok(a && b);
  assert.equal(await createImportantNewsContentHash(a), await createImportantNewsContentHash(b));
});

test("RSS feed parsing extracts multiple market_macro items via the shared tag/link helpers", () => {
  const rss = `<rss><channel>
    <item>
      <title>Federal Reserve Board issues enforcement action</title>
      <link><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/enforcement20260904a.htm]]></link>
      <description><![CDATA[Federal Reserve Board issues enforcement action]]></description>
      <pubDate><![CDATA[Thu, 04 Sep 2026 12:00:00 GMT]]></pubDate>
    </item>
    <item>
      <title>Minutes of the Board's discount rate meeting</title>
      <link><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/monetary20260903a.htm]]></link>
      <description><![CDATA[Minutes of the discount rate meeting]]></description>
      <pubDate><![CDATA[Wed, 03 Sep 2026 18:00:00 GMT]]></pubDate>
    </item>
  </channel></rss>`;
  const fed = source({
    key: "fed", sourceName: "market_macro",
    feedUrl: "https://www.federalreserve.gov/feeds/press_all.xml",
    defaultCategory: "frb", defaultTopicKey: "macro:fed",
    refine: (title) => /discount rate/i.test(title)
      ? { category: "interest_rates", topicKey: "macro:fomc" } : null,
  });
  const candidates = parseMarketMacroRss(fed, rss, now);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].category, "frb");
  assert.equal(candidates[1].category, "interest_rates");
  assert.equal(candidates[1].entityKey, "macro:fomc");
});

test("fetchMarketMacroSource surfaces a stable error code on HTTP failure", async () => {
  await assert.rejects(
    () => fetchMarketMacroSource(source(), async () => new Response("", { status: 503 })),
    /MARKET_MACRO_FETCH_FAILED:503/,
  );
});

test("fetchMarketMacroSource returns normalized candidates from a live-shaped fetch", async () => {
  const rss = `<rss><channel><item>
    <title>日銀当座預金増減要因</title>
    <link>http://www.boj.or.jp/about/press/kk260904b.pdf</link>
    <pubDate>Fri, 04 Sep 2026 08:50:00 +0900</pubDate>
    <description></description>
  </item></channel></rss>`;
  const candidates = await fetchMarketMacroSource(
    source(),
    async () => new Response(rss, { status: 200 }),
    now,
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceUrl, "https://www.boj.or.jp/about/press/kk260904b.pdf");
  assert.equal(candidates[0].companyCode, null);
});
