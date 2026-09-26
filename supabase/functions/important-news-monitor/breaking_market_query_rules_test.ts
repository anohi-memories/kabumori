// Search-string rules for the breaking_market lane (2026-09-25). Production diagnostics showed the model
// turning the topic into "site:reuters.com OR site:apnews.com ..." (no topic words, stale .gov pages) or
// "site:nhk.or.jp ..." (zero sources returned). The request now tells the model
// how to build its search string and hands it dated recency words; nothing else in the request changes.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BREAKING_MARKET_QUERIES,
  BREAKING_MARKET_NEWS_DOMAINS,
  BREAKING_MARKET_SOURCE_DOMAINS,
  breakingMarketRecencyTerms,
  breakingMarketRequestBody,
  summarizeBreakingMarketWebSearch,
  type BreakingMarketQuery,
} from "./breaking_market_source_fetchers.ts";

const byKey = (key: string) => BREAKING_MARKET_QUERIES.find((query) => query.key === key) as BreakingMarketQuery;
const NOW = new Date("2026-09-25T06:00:00Z"); // 15:00 JST

function input(query: BreakingMarketQuery, now = NOW): string {
  return breakingMarketRequestBody(query, now).input as string;
}

function instructions(query: BreakingMarketQuery): string {
  return breakingMarketRequestBody(query, NOW).instructions as string;
}

test("recency terms are dated from the runtime clock in JST, never hard-coded", () => {
  assert.equal(breakingMarketRecencyTerms(NOW), "latest breaking news September 25 2026");
  // 23:59 JST vs 00:00 JST the next day (UTC 14:59 / 15:00).
  assert.equal(breakingMarketRecencyTerms(new Date("2026-09-25T14:59:00Z")), "latest breaking news September 25 2026");
  assert.equal(breakingMarketRecencyTerms(new Date("2026-09-25T15:00:00Z")), "latest breaking news September 26 2026");
  assert.equal(breakingMarketRecencyTerms(new Date("2026-12-31T15:30:00Z")), "latest breaking news January 1 2027");
  assert.match(input(byKey("critical_market_events"), new Date("2027-03-02T01:00:00Z")), /recency terms: latest breaking news March 2 2027/);
});

test("the instructions forbid site: operators, domain and outlet names and require topic words", () => {
  const text = instructions(byKey("critical_market_events"));
  assert.match(text, /site:演算子、ドメイン名、媒体名（Reuters、AP等）を検索語に入れません/);
  assert.match(text, /search topicの具体語/);
  assert.match(text, /12語程度までの短い英語の検索語/);
  assert.match(text, /recency termsをそのまま含めます/);
});

for (const key of [
  "critical_market_events",
  "disaster_infrastructure",
  "financial_system_infrastructure",
  "japan_security_emergency",
  "war_geopolitics_taiwan",
  "shipping_chokepoints",
]) {
  test(`${key}: the input carries the topic's own words and the recency terms, and no site: operator`, () => {
    const query = byKey(key);
    const text = input(query);
    assert.ok(text.includes(`search topic: ${query.searchQuery}`), "topic vocabulary comes from the existing definition");
    assert.ok(text.includes("recency terms: latest breaking news September 25 2026"));
    assert.doesNotMatch(text, /site:/i);
    for (const domain of BREAKING_MARKET_SOURCE_DOMAINS) assert.ok(!text.includes(domain), `${domain} must not be suggested`);
    assert.doesNotMatch(query.searchQuery, /site:/i);
  });
}

test("every topic's own vocabulary is concrete, not a bare outlet or 'latest news' string", () => {
  const generic = new Set(["breaking", "today", "news", "latest", "reuters", "ap", "bloomberg", "nikkei"]);
  for (const query of BREAKING_MARKET_QUERIES) {
    const concrete = query.searchQuery.toLowerCase().split(/\s+/).filter((word) => word && !generic.has(word));
    assert.ok(concrete.length >= 5, `${query.key} needs topic words`);
  }
});

test("regression: model, context size, tool limit and output schema are unchanged; the filter is the news outlets", () => {
  for (const query of BREAKING_MARKET_QUERIES) {
    const body = breakingMarketRequestBody(query, NOW);
    assert.equal(body.model, "gpt-5.6-luna");
    assert.equal(body.max_tool_calls, 1);
    assert.equal(body.max_output_tokens, 1200);
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal(body.tool_choice, "required");
    assert.deepEqual(body.include, ["web_search_call.action.sources"]);
    assert.deepEqual(body.tools, [{
      type: "web_search",
      filters: { allowed_domains: BREAKING_MARKET_NEWS_DOMAINS },
      search_context_size: "low",
    }]);
    const format = (body.text as { format: { name: string; strict: boolean } }).format;
    assert.equal(format.name, "breaking_market_candidates");
    assert.equal(format.strict, true);
  }
});

test("regression: the freshness and opened-URL rules are still in the instructions", () => {
  const text = instructions(byKey("shipping_chokepoints"));
  assert.match(text, /直近3時間以内に発生・発表され、記事も直近3時間以内に公開された材料だけを候補にします/);
  assert.match(text, /source_urlが無い、または検索結果で実際に開いていないURLを候補にしません/);
  assert.match(instructions(byKey("critical_market_events")), /event_atをsource_urlで時刻まで確認できる候補だけを返します/);
});

// URL date metadata (observability only) --------------------------------------------------------------

function urlDateOf(url: string): string | null {
  const summary = summarizeBreakingMarketWebSearch({
    output: [{ type: "web_search_call", action: { type: "search", sources: [{ url }] } }],
  });
  return summary.sourcesSample[0].urlDate;
}

test("URL dates: real dates are kept", () => {
  assert.equal(urlDateOf("https://www.reuters.com/world/houthis-claim-attacks-2026-09-25/"), "2026-09-25");
  assert.equal(urlDateOf("https://www.mod.go.jp/j/press/news/2026/09/20i.html"), "2026-09-20");
  assert.equal(urlDateOf("https://www.federalreserve.gov/newsevents/2026-09-16.htm"), "2026-09-16");
});

test("URL dates: leap days are validated against the calendar", () => {
  assert.equal(urlDateOf("https://apnews.com/2028/02/29/story"), "2028-02-29");
  assert.equal(urlDateOf("https://apnews.com/2026/02/29/story"), null);
});

test("URL dates: impossible dates and hash fragments are not dates", () => {
  assert.equal(urlDateOf("https://www.mod.go.jp/en/article/2026/08/34ec41a27fb63ffa3223e8303b8b5f187346e5c6.html"), null);
  assert.equal(urlDateOf("https://apnews.com/2026/13/01/story"), null);
  assert.equal(urlDateOf("https://apnews.com/2026/04/31/story"), null);
  assert.equal(urlDateOf("https://apnews.com/2026/00/10/story"), null);
  assert.equal(urlDateOf("https://apnews.com/article/93dfe17125c63897b232f6461d81d85c"), null);
});
