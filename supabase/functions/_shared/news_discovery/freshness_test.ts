// Freshness guard (N4, 2026-09-30): DIRECT sources drop items that are CERTAINLY older than
// max_item_age_days (default 30). Missing / unparsable timestamps and future timestamps are kept.
import assert from "node:assert/strict";
import test from "node:test";
import { HostRateGate } from "./fetcher.ts";
import { isStale, parseTimestamp } from "./normalize.ts";
import { DiscoveryRun, normalizeItem, signalUrlKey } from "./pipeline.ts";
import { DIRECT_MAX_ITEM_AGE_DAYS, NEWS_SOURCE_REGISTRY, sourceById } from "./source_registry.ts";
import { InMemoryNewsSignalStore } from "./store.ts";
import type { NewsSignal, RawItem } from "./types.ts";

const NOW = new Date("2026-09-30T06:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const BEA = sourceById("us_bea")!;
const FR = sourceById("us_federal_register")!;
const JMA = sourceById("jp_jma_eqvol")!;
const iso = (ms: number) => new Date(ms).toISOString();

function item(link: string, published: string | null, updated: string | null = null, title = "Release"): RawItem {
  return {
    title, link, external_id: null, summary: null, published_raw: published, updated_raw: updated, seen_raw: null,
    structured_ticker: null, image_url: null, publisher: null, language: null, country: null,
  };
}
const ctx = (feedUrl: string) => ({ fetchedAt: NOW.toISOString(), now: NOW, aliasIndex: null, discoveredVia: "feed:t", feedUrl, itemIndex: 0 });
const kept = (r: NewsSignal | { dropped: true; reason: string }) => !("dropped" in r);
const dropReason = (r: NewsSignal | { dropped: true; reason: string }) => ("dropped" in r ? r.reason : null);

test("policy: DIRECT default 30 days; GDELT / web_search / DISABLED have no age filter", () => {
  assert.equal(DIRECT_MAX_ITEM_AGE_DAYS, 30);
  for (const s of NEWS_SOURCE_REGISTRY) {
    if (s.policy === "DIRECT_SOURCE") assert.equal(s.max_item_age_days, 30, s.source_id);
    else assert.equal(s.max_item_age_days, null, s.source_id);
  }
});

test("boundaries: 29d23h kept, exactly 30d kept, 30d+1s dropped, 2013 dropped", async () => {
  const at = async (ageMs: number) => await normalizeItem(BEA, item("https://www.bea.gov/news/x", iso(NOW.getTime() - ageMs)), ctx(BEA.endpoint));
  assert.ok(kept(await at(29 * DAY + 23 * 60 * 60 * 1000)));
  assert.ok(kept(await at(30 * DAY)));
  assert.equal(dropReason(await at(30 * DAY + 1000)), "stale");
  assert.equal(dropReason(await normalizeItem(BEA, item("https://www.bea.gov/news/x", "Thu, 18 Apr 2013 12:30:00 GMT"), ctx(BEA.endpoint))), "stale");
});

test("date-only (Federal Register): kept within 30 days, dropped only when certainly older", async () => {
  // 2026-08-31 is 30 days before 2026-09-30: that calendar day can still be "now - 30d" somewhere -> kept.
  assert.ok(kept(await normalizeItem(FR, item("https://www.federalregister.gov/d/a", "2026-08-31"), ctx(FR.endpoint))));
  assert.ok(kept(await normalizeItem(FR, item("https://www.federalregister.gov/d/b", "2026-09-29"), ctx(FR.endpoint))));
  assert.equal(dropReason(await normalizeItem(FR, item("https://www.federalregister.gov/d/c", "2026-08-15"), ctx(FR.endpoint))), "stale");
  // Pure helper: a date-only value counts from the LAST instant that date exists anywhere
  // (UTC-12 end of day = date + 36h UTC), so it is never dropped a day early.
  const d = parseTimestamp("2026-08-30"); // last instant anywhere: 2026-08-31T12:00:00Z
  assert.equal(isStale(d, null, new Date("2026-09-30T12:00:00Z"), 30), false, "exactly 30 days after the latest instant");
  assert.equal(isStale(d, null, new Date("2026-09-30T12:00:01Z"), 30), true);
});

test("published wins over updated; updated is used only without published (JMA Atom)", async () => {
  const oldPublished = iso(NOW.getTime() - 60 * DAY);
  assert.equal(dropReason(await normalizeItem(BEA, item("https://www.bea.gov/news/y", oldPublished, NOW.toISOString()), ctx(BEA.endpoint))), "stale");
  const jma = await normalizeItem(JMA, item("https://www.data.jma.go.jp/x/1.xml", null, iso(NOW.getTime() - 60 * 1000), "震度速報"), ctx(JMA.endpoint));
  assert.ok(kept(jma));
  const jmaOld = await normalizeItem(JMA, item("https://www.data.jma.go.jp/x/2.xml", null, iso(NOW.getTime() - 31 * DAY), "震度速報"), ctx(JMA.endpoint));
  assert.equal(dropReason(jmaOld), "stale");
});

test("no timestamp / unparsable timestamp: kept with no_published_at", async () => {
  const none = await normalizeItem(BEA, item("https://www.bea.gov/news/z", null), ctx(BEA.endpoint)) as NewsSignal;
  assert.ok(kept(none));
  assert.ok(none.needs_verification.includes("no_published_at"));
  const bad = await normalizeItem(BEA, item("https://www.bea.gov/news/w", "sometime last spring"), ctx(BEA.endpoint)) as NewsSignal;
  assert.ok(kept(bad));
  assert.ok(bad.needs_verification.includes("no_published_at"));
});

test("future timestamp: kept and flagged future_timestamp (never removed by the freshness guard)", async () => {
  const future = await normalizeItem(BEA, item("https://www.bea.gov/news/f", iso(NOW.getTime() + 5 * 60 * 60 * 1000)), ctx(BEA.endpoint)) as NewsSignal;
  assert.ok(kept(future));
  assert.ok(future.needs_verification.includes("future_timestamp"));
});

test("BEA regression: an old scheme-less release is stale (not invalid_url); a fresh one is stored with https://", async () => {
  const old = await normalizeItem(BEA, item("www.bea.gov/news/2013/mnc2011", "Thu, 18 Apr 2013 12:30:00 GMT"), ctx(BEA.endpoint));
  assert.equal(dropReason(old), "stale");
  const fresh = await normalizeItem(BEA, item("www.bea.gov/news/2026/gdp", iso(NOW.getTime() - 2 * DAY)), ctx(BEA.endpoint)) as NewsSignal;
  assert.equal(fresh.source_url, "https://www.bea.gov/news/2026/gdp");
});

test("pipeline stats: stale counted in filtered and stale_filtered, not in normalize_failed or duplicates", async () => {
  const run = await DiscoveryRun.start({
    sources: [], store: new InMemoryNewsSignalStore(signalUrlKey), aliasIndex: null,
    gate: new HostRateGate(() => 0, () => Promise.resolve()), now: () => NOW,
  });
  const fresh = await run.ingest(BEA, [
    item("https://www.bea.gov/news/2026/a", iso(NOW.getTime() - DAY), null, "Fresh A"),
    item("www.bea.gov/news/2013/b", "Thu, 18 Apr 2013 12:30:00 GMT", null, "Old B"),
    item("https://www.bea.gov/news/2026/c", null, null, "Undated C"),
    item("javascript:alert(1)", iso(NOW.getTime() - DAY), null, "Broken D"),
  ], { via: "feed:us_bea", feedUrl: BEA.endpoint, fetchedAt: NOW.toISOString() });
  assert.deepEqual(fresh.map((s) => s.title), ["Fresh A", "Undated C"]);
  const s = run.statsFor(BEA);
  assert.deepEqual({ stale: s.stale_filtered, filtered: s.filtered, invalid: s.normalize_failed, dup: Object.values(s.duplicates).reduce((a, b) => a + b, 0) },
    { stale: 1, filtered: 1, invalid: 1, dup: 0 });
  const result = await run.finish();
  assert.equal(result.totals.stale_filtered, 1);
});

test("GDELT (DISCOVERY_ONLY) is untouched by the freshness guard", async () => {
  const gdelt = sourceById("gdelt_doc")!;
  const r = await normalizeItem(gdelt, { ...item("https://news.example/old", null), seen_raw: "20130418T123000Z" }, ctx(gdelt.endpoint));
  assert.ok(kept(r), "detected_at is never used for DIRECT freshness and GDELT has no window");
});
