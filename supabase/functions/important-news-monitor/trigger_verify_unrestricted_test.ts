// Headline-trigger verification searches the whole web (no allowed_domains) since 2026-09-26, while
// the set of hosts a candidate may cite is unchanged. The search may surface any site; only fresh,
// visited articles on NEWS_ARTICLE_HOSTS become candidates.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BREAKING_MARKET_NEWS_DOMAINS,
  BREAKING_MARKET_QUERIES,
  breakingMarketRequestBody,
  breakingMarketSearchDomains,
  fetchBreakingMarketQueryWithDiagnostics,
} from "./breaking_market_source_fetchers.ts";
import {
  NEWS_ARTICLE_HOSTS,
  runHeadlineTriggerLane,
  triggerHistoryFromRuns,
  type TriggerHeadline,
  type TriggerHistory,
  verifyBreakingQuery,
  type VerifyRunner,
} from "./headline_trigger_logic.ts";
import { triggerVerifyUsageEvents } from "./usage_metering.ts";

const NOW = new Date("2026-09-26T06:00:00Z");
const EMPTY: TriggerHistory = { seenUrls: new Set(), seenTitles: new Set(), deferred: [] };
const HEADLINE: TriggerHeadline = {
  id: "", source: "bbc_world", title: "Iran offers US deal to reopen Strait of Hormuz in seven days",
  url: "https://www.bbc.co.uk/news/articles/cqgmrr9ekr7ko", publishedAt: "2026-09-26T04:14:30Z", summary: null,
};

const triage = (headlines: TriggerHeadline[]) => Promise.resolve({
  results: new Map([[headlines[0].id, { decision: "verify" as const, category: "geopolitics" as const, reason: "r", searchTerms: "Iran offers US deal reopen Strait of Hormuz seven days" }]]),
  inputTokens: 1000, outputTokens: 50,
});

type Found = { url: string; publishedAt?: string; visited?: boolean };

/** A verify step through the real breaking fetcher; the fake API returns the given model candidates. */
function verifyReturning(found: Found[], sent: Array<Record<string, unknown>> = []): VerifyRunner {
  return (query, now) => fetchBreakingMarketQueryWithDiagnostics("k", query, now, (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response(JSON.stringify({
      status: "completed",
      usage: { input_tokens: 11000, output_tokens: 300 },
      output: [
        { type: "web_search_call", action: { type: "search", sources: found.filter((item) => item.visited !== false).map((item) => ({ url: item.url })) } },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify({ candidates: found.map((item) => ({
          title: "Iran proposes a deal to reopen the Strait of Hormuz in 7 days", summary: "s", source_url: item.url,
          published_at: item.publishedAt ?? "2026-09-26T04:30:00Z", event_at: null, category: "geopolitics",
        })) }) }] },
      ],
    }), { status: 200 }));
  });
}

async function run(found: Found[], sent: Array<Record<string, unknown>> = []) {
  return await runHeadlineTriggerLane({ headlines: [HEADLINE], feeds: {}, history: EMPTY, triage, verify: verifyReturning(found, sent), now: NOW });
}

test("the trigger verify request carries no allowed_domains; everything else in the tool is unchanged", async () => {
  const sent: Array<Record<string, unknown>> = [];
  await run([], sent);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].tools, [{ type: "web_search", search_context_size: "low" }]);
  assert.equal(sent[0].max_tool_calls, 1);
  assert.equal(sent[0].model, "gpt-5.6-luna");
  assert.equal(breakingMarketSearchDomains(verifyBreakingQuery("q", "geopolitics")), null);
});

test("the generic breaking searches still send the news-outlet allowed_domains", () => {
  for (const query of BREAKING_MARKET_QUERIES) {
    const tools = breakingMarketRequestBody(query, NOW).tools as Array<{ filters?: { allowed_domains: string[] } }>;
    assert.deepEqual(tools[0].filters?.allowed_domains, BREAKING_MARKET_NEWS_DOMAINS, query.key);
  }
});

test("an article on an allowed host can become a candidate", async () => {
  const result = await run([{ url: "https://apnews.com/article/iran-us-war-negotiations-strait-hormuz-d8b9749fee99a11dd77513d326b824b6" }]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.items[0].candidateCreated, true);
  assert.equal(result.diagnostics.items[0].verifyRawCandidateCount, 1);
});

test("a fresh article from a site outside the allowed domains is not a candidate (and is recorded)", async () => {
  const result = await run([
    { url: "https://www.bbc.co.uk/news/articles/cqgmrr9ekr7ko" },
    { url: "https://www.aljazeera.com/news/2026/9/26/iran-hormuz" },
    { url: "https://www.cnn.com/2026/09/26/middleeast/iran-hormuz" },
  ]);
  assert.equal(result.candidates.length, 0);
  const [item] = result.diagnostics.items;
  assert.equal(item.verifyRawCandidateCount, 3);
  assert.deepEqual(item.verifyRejections, { disallowed_domain: 3 });
});

test("official domains pass source validation but never become trigger candidates", async () => {
  const result = await run([{ url: "https://www.whitehouse.gov/briefings-statements/2026/09/iran/" }]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.items[0].rejectionReason, "verify_non_article_host");
});

test("noise subdomains of allowed outlets never become candidates", async () => {
  const noise = [
    "https://assist.bloomberg.com/x", "https://research.bloomberg.com/x", "https://professional.content.cirrus.bloomberg.com/x",
    "https://pitch.nikkei.com/x", "https://promotion.asia.nikkei.com/x", "https://help.asia.nikkei.com/x",
    "https://bookplus.nikkei.com/x", "https://marketing.nikkei.com/x",
  ];
  for (const url of noise) assert.ok(!NEWS_ARTICLE_HOSTS.includes(new URL(url).hostname), url);
  const result = await run(noise.map((url) => ({ url })));
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.items[0].rejectionReason, "verify_non_article_host");
});

test("the 6h freshness and visited-URL gates still apply", async () => {
  const stale = await run([{ url: "https://apnews.com/article/old", publishedAt: "2026-09-25T20:00:00Z" }]);
  assert.equal(stale.candidates.length, 0);
  assert.deepEqual(stale.diagnostics.items[0].verifyRejections, { stale_published_at: 1 });
  const unvisited = await run([{ url: "https://apnews.com/article/claimed", visited: false }]);
  assert.equal(unvisited.candidates.length, 0);
  assert.deepEqual(unvisited.diagnostics.items[0].verifyRejections, { source_not_visited: 1 });
});

test("usage metering, diagnostics and dedupe history are unchanged by the unrestricted search", async () => {
  const result = await run([{ url: "https://www.reuters.com/world/middle-east/iran-hormuz-2026-09-26/" }]);
  const usage = triggerVerifyUsageEvents(result.verifyDiagnostics, "run-1");
  assert.deepEqual(usage.map((event) => [event.feature, event.webSearchCalls]), [["news_trigger_verify_search|geopolitics", 1]]);
  const history = triggerHistoryFromRuns([{ items: result.diagnostics.items }], NOW);
  assert.ok(history.seenUrls.has("https://bbc.co.uk/news/articles/cqgmrr9ekr7ko"));
  assert.equal(history.deferred.length, 0, "a searched headline is not searched again");
});
