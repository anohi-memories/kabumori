// N4 BLOCKER regression (2026-09-29): a scheme-less BEA link ("www.bea.gov/news/...") was resolved as
// a relative path of the feed and stored raw as source_url; the DB CHECK (^https?://) then rolled back
// the whole batch. Links are now resolved once (resolveHttpUrl), bad items are dropped one by one.
import assert from "node:assert/strict";
import test from "node:test";
import { HostRateGate } from "./fetcher.ts";
import { canonicalizeUrl, resolveHttpUrl } from "./normalize.ts";
import { DiscoveryRun, normalizeItem, signalUrlKey } from "./pipeline.ts";
import { sourceById } from "./source_registry.ts";
import { InMemoryNewsSignalStore } from "./store.ts";
import { signalToRow } from "./supabase_store.ts";
import type { NewsSignal, RawItem } from "./types.ts";

const BEA = sourceById("us_bea")!;
const BEA_FEED = BEA.endpoint; // https://apps.bea.gov/rss/rss.xml
const NOW = new Date("2026-09-29T06:00:00Z");

const raw = (title: string, link: string): RawItem => ({
  title, link, external_id: null, summary: null, published_raw: "Mon, 29 Sep 2026 03:00:00 GMT", updated_raw: null,
  seen_raw: null, structured_ticker: null, image_url: null, publisher: null, language: null, country: null,
});
const ctx = (feedUrl: string) => ({ fetchedAt: NOW.toISOString(), now: NOW, aliasIndex: null, discoveredVia: "feed:test", feedUrl, itemIndex: 0 });

test("resolveHttpUrl: absolute, www-schemeless, relative, protocol-relative", () => {
  assert.equal(resolveHttpUrl("https://www.example.com/a"), "https://www.example.com/a");
  assert.equal(resolveHttpUrl("www.bea.gov/news/2026/example", BEA_FEED), "https://www.bea.gov/news/2026/example");
  assert.equal(resolveHttpUrl("/pressroom/releases/press592.php", "https://www.eia.gov/rss/press_rss.xml"),
    "https://www.eia.gov/pressroom/releases/press592.php");
  assert.equal(resolveHttpUrl("//www.example.gov/a", "https://example.gov/feed"), "https://www.example.gov/a");
  // Not generalized: a bare "host.tld/path" stays a relative path of the feed (no guessing).
  assert.equal(resolveHttpUrl("bea.gov/foo", BEA_FEED), "https://apps.bea.gov/rss/bea.gov/foo");
});

test("resolveHttpUrl: unsafe schemes and malformed links are null", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "ftp://ftp.example.gov/x",
    "not a url", "http://", "https://", "", "   ", "www.exa mple.gov/a", "https://ex\u0000ample.gov/"]) {
    assert.equal(resolveHttpUrl(bad, BEA_FEED), null, JSON.stringify(bad));
  }
});

test("BEA real case: source_url and canonical_url are the real BEA host, never apps.bea.gov/rss/www...", async () => {
  const signal = await normalizeItem(BEA, raw("GDP (Advance Estimate)", "www.bea.gov/news/2026/gdp-advance-estimate-example"), ctx(BEA_FEED));
  assert.ok(!("dropped" in signal));
  const s = signal as NewsSignal;
  assert.equal(s.source_url, "https://www.bea.gov/news/2026/gdp-advance-estimate-example");
  assert.equal(s.canonical_url, "https://www.bea.gov/news/2026/gdp-advance-estimate-example");
  assert.ok(!s.canonical_url.includes("apps.bea.gov/rss/www."));
  assert.equal(new URL(s.canonical_url).hostname, "www.bea.gov");
});

test("www + query: source_url keeps the link as resolved; canonical drops tracking, keeps identity params", async () => {
  const signal = await normalizeItem(BEA, raw("Release", "www.example.gov/a?utm_source=rss&id=3"), ctx(BEA_FEED)) as NewsSignal;
  assert.equal(signal.source_url, "https://www.example.gov/a?utm_source=rss&id=3");
  assert.equal(signal.canonical_url, "https://www.example.gov/a?id=3");
  assert.equal(canonicalizeUrl("www.example.gov/a?utm_source=rss&id=3"), "https://www.example.gov/a?id=3");
});

test("existing behaviour kept: relative EIA link, absolute link, tracking removal", async () => {
  const eia = sourceById("us_eia_press")!;
  const rel = await normalizeItem(eia, raw("EIA release", "/pressroom/releases/press592.php"), ctx(eia.endpoint)) as NewsSignal;
  assert.equal(rel.source_url, "https://www.eia.gov/pressroom/releases/press592.php");
  assert.equal(rel.canonical_url, "https://www.eia.gov/pressroom/releases/press592.php");
  const abs = await normalizeItem(eia, raw("Abs", "https://WWW.Example.com:443/a/?b=2&utm_campaign=x&a=1#frag"), ctx(eia.endpoint)) as NewsSignal;
  assert.equal(abs.source_url, "https://www.example.com/a/?b=2&utm_campaign=x&a=1#frag");
  assert.equal(abs.canonical_url, "https://www.example.com/a?a=1&b=2");
});

test("unsafe or malformed link drops only that item (invalid_url)", async () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///x", "ftp://x.example/y", "not a url"]) {
    const result = await normalizeItem(BEA, raw("x", bad), ctx(BEA_FEED));
    assert.deepEqual("dropped" in result && result.reason, "invalid_url", bad);
  }
});

test("mixed batch: one broken link never removes the valid items (pipeline, same source/run)", async () => {
  const store = new InMemoryNewsSignalStore(signalUrlKey);
  const run = await DiscoveryRun.start({ sources: [], store, aliasIndex: null, gate: new HostRateGate(() => 0, () => Promise.resolve()), now: () => NOW });
  const fresh = await run.ingest(BEA, [
    raw("Normal absolute release", "https://www.bea.gov/news/2026/personal-income"),
    raw("BEA scheme-less release", "www.bea.gov/news/2026/gdp-advance-estimate-example"),
    raw("Broken link", "javascript:alert(1)"),
    raw("Relative release", "/news/2026/trade-balance"),
  ], { via: "feed:us_bea", feedUrl: BEA_FEED, fetchedAt: NOW.toISOString() });
  assert.deepEqual(fresh.map((s) => s.source_url), [
    "https://www.bea.gov/news/2026/personal-income",
    "https://www.bea.gov/news/2026/gdp-advance-estimate-example",
    "https://apps.bea.gov/news/2026/trade-balance",
  ]);
  const stats = run.statsFor(BEA);
  assert.equal(stats.normalize_failed, 1, "only the broken item is dropped");
  // Every signal the pipeline produces satisfies the DB URL contract (serializer invariant never trips).
  for (const signal of fresh) {
    const row = signalToRow(signal);
    assert.match(String(row.source_url), /^https?:\/\//);
    assert.match(String(row.canonical_url), /^https?:\/\//);
  }
  const result = await run.finish();
  assert.equal(result.totals.inserted, 3);
});

test("signalToRow refuses a non-absolute URL as an internal bug (never reinterprets it)", () => {
  const base = { source_id: "us_bea", discovery_only: false, ticker_candidates: [], entities: [], raw_reference: { feed_url: BEA_FEED, item_index: 0 } };
  assert.throws(() => signalToRow({ ...base, source_url: "www.bea.gov/x", canonical_url: "https://www.bea.gov/x" } as unknown as NewsSignal),
    /NEWS_SIGNAL_URL_INVARIANT:us_bea/);
  assert.throws(() => signalToRow({ ...base, source_url: "https://www.bea.gov/x", canonical_url: "javascript:alert(1)" } as unknown as NewsSignal),
    /NEWS_SIGNAL_URL_INVARIANT/);
});
