// Observability for the breaking_market zero-candidate investigation (2026-09-25): up to five source
// metadata rows per query, the opened pages and the issued search strings are kept in run diagnostics.
// None of it may change the request or the candidates.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BREAKING_MARKET_QUERIES,
  BREAKING_MARKET_SOURCE_SAMPLE_LIMIT,
  breakingMarketRequestBody,
  fetchBreakingMarketQueryWithDiagnostics,
  summarizeBreakingMarketWebSearch,
  type BreakingMarketQuery,
} from "./breaking_market_source_fetchers.ts";
import { buildCollectionRunDiagnostics } from "./news_collection_diagnostics.ts";

const query = BREAKING_MARKET_QUERIES.find((item) => item.key === "shipping_chokepoints") as BreakingMarketQuery;
const now = new Date("2026-09-25T04:00:00Z");
const AP = "https://apnews.com/article/93dfe17125c63897b232f6461d81d85c";
const REUTERS = "https://www.reuters.com/world/middle-east/houthis-claim-attacks-saudi-facilities-2026-09-25/";

function searchCall(sources: unknown[], extra: Record<string, unknown> = {}) {
  return { type: "web_search_call", status: "completed", action: { type: "search", query: "Red Sea shipping attack", sources, ...extra } };
}

function payload(output: unknown[], candidates: unknown[] = []) {
  return {
    status: "completed",
    usage: { input_tokens: 12000, output_tokens: 300 },
    output: [
      ...output,
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ candidates }) }] },
    ],
  };
}

test("zero sources: an empty sample and no opened pages", () => {
  const summary = summarizeBreakingMarketWebSearch(payload([searchCall([])]));
  assert.equal(summary.sourceCount, 0);
  assert.deepEqual(summary.sourcesSample, []);
  assert.deepEqual(summary.openedUrls, []);
  assert.deepEqual(summary.searchQueries, ["Red Sea shipping attack"]);
});

test("one source: url, domain, title, tool date and URL date are kept", () => {
  const summary = summarizeBreakingMarketWebSearch(payload([
    searchCall([{ type: "url", url: REUTERS, title: "Houthis claim attacks on Saudi facilities", published_date: "2026-09-25T03:41:00Z" }]),
  ]));
  assert.deepEqual(summary.sourcesSample, [{
    url: REUTERS,
    domain: "reuters.com",
    title: "Houthis claim attacks on Saudi facilities",
    publishedAt: "2026-09-25T03:41:00Z",
    urlDate: "2026-09-25",
    opened: false,
  }]);
});

test("five sources are all kept; six or more are capped at five in the tool's order", () => {
  const urls = Array.from({ length: 7 }, (_, index) => `https://apnews.com/article/story-${index}`);
  const five = summarizeBreakingMarketWebSearch(payload([searchCall(urls.slice(0, 5).map((url) => ({ url })))]));
  assert.equal(five.sourcesSample.length, 5);
  const seven = summarizeBreakingMarketWebSearch(payload([searchCall(urls.map((url) => ({ url })))]));
  assert.equal(BREAKING_MARKET_SOURCE_SAMPLE_LIMIT, 5);
  assert.equal(seven.sourceCount, 7, "the count still reports every source");
  assert.deepEqual(seven.sourcesSample.map((item) => item.url), urls.slice(0, 5));
});

test("missing url, title or date become null instead of dropping the row", () => {
  const summary = summarizeBreakingMarketWebSearch(payload([
    searchCall([{ type: "url" }, { url: AP }, "not-an-object", { url: "not a url" }]),
  ]));
  assert.deepEqual(summary.sourcesSample, [
    { url: null, domain: null, title: null, publishedAt: null, urlDate: null, opened: false },
    { url: AP, domain: "apnews.com", title: null, publishedAt: null, urlDate: null, opened: false },
    { url: null, domain: null, title: null, publishedAt: null, urlDate: null, opened: false },
    { url: "not a url", domain: null, title: null, publishedAt: null, urlDate: null, opened: false },
  ]);
});

test("an opened page is listed and flagged on its sample row", () => {
  const summary = summarizeBreakingMarketWebSearch(payload([
    searchCall([{ url: AP }, { url: REUTERS }]),
    { type: "web_search_call", status: "completed", action: { type: "open_page", url: REUTERS } },
  ]));
  assert.deepEqual(summary.openedUrls, [REUTERS]);
  assert.deepEqual(summary.sourcesSample.map((item) => [item.domain, item.opened]), [["apnews.com", false], ["reuters.com", true]]);
});

test("long values are clipped and nothing but metadata is kept", () => {
  const summary = summarizeBreakingMarketWebSearch(payload([
    searchCall([{ url: `${AP}?q=${"x".repeat(500)}`, title: "t".repeat(400), snippet: "full article text", content: "body" }], {
      query: "q".repeat(400),
    }),
  ]));
  const [row] = summary.sourcesSample;
  assert.equal(row.url?.length, 300);
  assert.equal(row.title?.length, 160);
  assert.equal(summary.searchQueries[0].length, 200);
  assert.deepEqual(Object.keys(row).sort(), ["domain", "opened", "publishedAt", "title", "url", "urlDate"]);
});

test("the sample reaches the query diagnostics and the persisted run diagnostics", async () => {
  const raw = payload([
    searchCall([{ url: AP, title: "Houthis declare blockade" }]),
    { type: "web_search_call", status: "completed", action: { type: "open_page", url: AP } },
  ]);
  const result = await fetchBreakingMarketQueryWithDiagnostics("k", query, now, () =>
    Promise.resolve(new Response(JSON.stringify(raw), { status: 200 })));
  assert.deepEqual(result.diagnostics.openedUrls, [AP]);
  assert.equal(result.diagnostics.searchSourcesSample?.[0].title, "Houthis declare blockade");
  assert.deepEqual(result.diagnostics.searchQueries, ["Red Sea shipping attack"]);
  const run = buildCollectionRunDiagnostics({ marketMacroProviders: [], breakingMarketQueries: [result.diagnostics] });
  const persisted = run.breakingMarket.queries[0] as Record<string, unknown>;
  assert.deepEqual(persisted.searchSourcesSample, result.diagnostics.searchSourcesSample);
  assert.deepEqual(persisted.openedUrls, [AP]);
  assert.equal(run.version, 1);
});

test("candidates and the request are unchanged by the observability fields", async () => {
  const candidate = {
    title: "Houthis declare blockade on Saudi shipping in Bab el-Mandeb and Red Sea",
    summary: "Yemen's Houthis declared a blockade on Saudi shipping.",
    source_url: AP,
    published_at: "2026-09-25T03:30:00Z",
    event_at: "2026-09-25T03:10:00Z",
    category: "geopolitics",
  };
  const withSample = payload([searchCall([{ url: AP, title: "t" }])], [candidate]);
  const bare = payload([{ type: "web_search_call", action: { sources: [{ url: AP }] } }], [candidate]);
  const respond = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  const a = await fetchBreakingMarketQueryWithDiagnostics("k", query, now, respond(withSample));
  const b = await fetchBreakingMarketQueryWithDiagnostics("k", query, now, respond(bare));
  assert.deepEqual(a.candidates, b.candidates);
  assert.equal(a.candidates.length, 1);
  const body = breakingMarketRequestBody(query, now);
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.max_tool_calls, 1);
  assert.deepEqual((body.tools as Array<{ search_context_size: string }>)[0].search_context_size, "low");
});
