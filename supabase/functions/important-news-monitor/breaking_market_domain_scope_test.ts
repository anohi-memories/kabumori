// Role-split search domains for the breaking_market lane (2026-09-26). The web_search filter uses the news
// outlets, so evergreen official pages cannot crowd out fresh reporting; the union of news and official
// domains still decides which source_url a candidate may carry, exactly as before.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BREAKING_MARKET_NEWS_DOMAINS,
  BREAKING_MARKET_OFFICIAL_DOMAINS,
  BREAKING_MARKET_QUERIES,
  BREAKING_MARKET_SOURCE_DOMAINS,
  breakingMarketRequestBody,
  breakingMarketSearchDomains,
  collectBreakingMarketCandidates,
  collectBreakingMarketSourceUrls,
  type BreakingMarketQuery,
} from "./breaking_market_source_fetchers.ts";

// The allowed list as shipped before the split (e2bc8b9), in declaration order.
const PREVIOUS_ALLOWED = [
  "reuters.com", "apnews.com", "bloomberg.com", "nikkei.com",
  "mof.go.jp", "boj.or.jp", "federalreserve.gov", "ustr.gov",
  "whitehouse.gov", "commerce.gov", "bis.doc.gov", "state.gov",
  "bls.gov", "bea.gov", "treasury.gov",
  "centcom.mil", "defense.gov",
  "jma.go.jp", "mod.go.jp", "kantei.go.jp", "jpx.co.jp", "fdma.go.jp", "nhk.or.jp",
];
const OFFICIAL_HOST = /\.(gov|mil)$|\.go\.jp$|^boj\.or\.jp$|^jpx\.co\.jp$/;
const NOW = new Date("2026-09-26T03:00:00Z");

test("no domain was added or removed: news + official is exactly the previous allowed list", () => {
  assert.deepEqual([...BREAKING_MARKET_SOURCE_DOMAINS].sort(), [...PREVIOUS_ALLOWED].sort());
  assert.equal(new Set(BREAKING_MARKET_SOURCE_DOMAINS).size, BREAKING_MARKET_SOURCE_DOMAINS.length);
  const overlap = BREAKING_MARKET_NEWS_DOMAINS.filter((domain) => BREAKING_MARKET_OFFICIAL_DOMAINS.includes(domain));
  assert.deepEqual(overlap, []);
});

test("the news list is the existing outlets and contains no official host", () => {
  assert.deepEqual(BREAKING_MARKET_NEWS_DOMAINS, ["reuters.com", "apnews.com", "bloomberg.com", "nikkei.com", "nhk.or.jp"]);
  for (const domain of BREAKING_MARKET_NEWS_DOMAINS) assert.doesNotMatch(domain, OFFICIAL_HOST, domain);
});

test("the official list keeps every official source the topics relied on", () => {
  for (const domain of ["boj.or.jp", "federalreserve.gov", "bls.gov", "mof.go.jp", "jma.go.jp", "mod.go.jp", "kantei.go.jp", "fdma.go.jp", "centcom.mil"]) {
    assert.ok(BREAKING_MARKET_OFFICIAL_DOMAINS.includes(domain), domain);
  }
  for (const domain of BREAKING_MARKET_OFFICIAL_DOMAINS) assert.match(domain, OFFICIAL_HOST, domain);
});

test("every shipped topic searches the news outlets; critical, security and disaster included", () => {
  for (const query of BREAKING_MARKET_QUERIES) {
    const tools = breakingMarketRequestBody(query, NOW).tools as Array<{ filters: { allowed_domains: string[] } }>;
    assert.deepEqual(tools[0].filters.allowed_domains, BREAKING_MARKET_NEWS_DOMAINS, query.key);
    for (const domain of tools[0].filters.allowed_domains) assert.doesNotMatch(domain, OFFICIAL_HOST, `${query.key}: ${domain}`);
  }
});

test("the scope switch maps each role to its list, defaulting to news", () => {
  const base = BREAKING_MARKET_QUERIES[0];
  assert.deepEqual(breakingMarketSearchDomains({ ...base, searchScope: undefined }), BREAKING_MARKET_NEWS_DOMAINS);
  assert.deepEqual(breakingMarketSearchDomains({ ...base, searchScope: "official" }), BREAKING_MARKET_OFFICIAL_DOMAINS);
  assert.deepEqual(breakingMarketSearchDomains({ ...base, searchScope: "news_and_official" }), BREAKING_MARKET_SOURCE_DOMAINS);
});

test("one search per query: tool count, tool-call limit and context size are unchanged by the split", () => {
  for (const query of BREAKING_MARKET_QUERIES) {
    const body = breakingMarketRequestBody(query, NOW);
    assert.equal((body.tools as unknown[]).length, 1);
    assert.equal(body.max_tool_calls, 1);
    assert.equal((body.tools as Array<{ search_context_size: string }>)[0].search_context_size, "low");
    assert.equal(body.model, "gpt-5.6-luna");
  }
});

test("candidate validation still accepts an official source_url the tool actually visited", () => {
  const query = BREAKING_MARKET_QUERIES.find((item) => item.key === "japan_security_emergency") as BreakingMarketQuery;
  const url = "https://www.mod.go.jp/j/press/news/2026/09/26a.html";
  const visited = collectBreakingMarketSourceUrls({ output: [{ type: "web_search_call", action: { sources: [{ url }] } }] });
  assert.deepEqual([...visited], [url], "official hosts still count as visited allowed sources");
  const candidates = collectBreakingMarketCandidates(query, [{
    title: "North Korea fires ballistic missile toward Sea of Japan",
    summary: "Japan's defense ministry said North Korea fired a ballistic missile.",
    source_url: url,
    published_at: "2026-09-26T02:30:00Z",
    event_at: "2026-09-26T02:10:00Z",
    category: "major_security_incident",
  }], visited, NOW);
  assert.equal(candidates.length, 1);
});
