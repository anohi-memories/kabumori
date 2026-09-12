import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDedupeKey,
  computeContentHash,
  finalizeMarketEvent,
  normalizeSourceUrl,
  normalizeText,
  type MarketEventInput,
} from "./mic_normalize_logic.ts";

test("normalizeText collapses whitespace, NFKC-normalizes, and lowercases", () => {
  assert.equal(normalizeText("  Ｈｅｌｌｏ   World\n"), "hello world");
});

test("normalizeSourceUrl strips utm/ref/source/campaign params and sorts the rest", () => {
  const url = "https://Example.com/path/?utm_source=x&b=2&a=1&ref=y&campaign=z#frag";
  assert.equal(normalizeSourceUrl(url), "https://example.com/path?a=1&b=2");
});

test("normalizeSourceUrl collapses trailing and duplicate slashes", () => {
  assert.equal(normalizeSourceUrl("https://example.com/a//b///"), "https://example.com/a/b");
});

test("normalizeSourceUrl rejects non-https URLs", () => {
  assert.throws(() => normalizeSourceUrl("http://example.com/a"), /NORMALIZE_URL_REQUIRES_HTTPS/);
});

test("computeContentHash is stable for the same normalized inputs", async () => {
  const a = await computeContentHash({ title: "Fed raises rates", summary: "25bp hike", entityIdentity: "FRB" });
  const b = await computeContentHash({ title: "  FED Raises Rates  ", summary: "25BP Hike", entityIdentity: "frb" });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("computeContentHash differs when the entity differs", async () => {
  const a = await computeContentHash({ title: "Earnings beat", summary: "Q2 results", entityIdentity: "AAPL" });
  const b = await computeContentHash({ title: "Earnings beat", summary: "Q2 results", entityIdentity: "MSFT" });
  assert.notEqual(a, b);
});

test("buildDedupeKey returns the normalized source URL", () => {
  const input: MarketEventInput = {
    occurredAt: null,
    publishedAt: "2026-09-12T00:00:00.000Z",
    eventType: "other",
    category: "test",
    title: "t",
    summary: "s",
    sourceName: "n",
    sourceUrl: "https://example.com/x?utm_source=foo",
    sourceKey: "fred",
  };
  assert.equal(buildDedupeKey(input), "https://example.com/x");
});

test("buildDedupeKey returns null for an unparseable URL instead of throwing", () => {
  const input: MarketEventInput = {
    occurredAt: null,
    publishedAt: "2026-09-12T00:00:00.000Z",
    eventType: "other",
    category: "test",
    title: "t",
    summary: "s",
    sourceName: "n",
    sourceUrl: "not-a-url",
    sourceKey: "fred",
  };
  assert.equal(buildDedupeKey(input), null);
});

test("finalizeMarketEvent attaches a valid contentHash and dedupeKey", async () => {
  const input: MarketEventInput = {
    occurredAt: null,
    publishedAt: "2026-09-12T00:00:00.000Z",
    eventType: "regulatory",
    category: "sec_filing",
    entityId: "AAPL",
    ticker: "AAPL",
    title: "Apple Inc. 8-K filing",
    summary: "Apple Inc. filed SEC Form 8-K.",
    sourceName: "SEC EDGAR",
    sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/0001/doc.htm",
    sourceKey: "sec_edgar",
  };
  const finalized = await finalizeMarketEvent(input);
  assert.match(finalized.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(finalized.dedupeKey, "https://www.sec.gov/Archives/edgar/data/320193/0001/doc.htm");
});
