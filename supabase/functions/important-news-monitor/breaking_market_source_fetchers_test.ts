import assert from "node:assert/strict";
import test from "node:test";
import {
  BREAKING_MARKET_QUERIES,
  MAX_BREAKING_MARKET_SEARCHES_PER_FETCH,
  collectBreakingMarketCandidates,
  collectBreakingMarketSourceUrls,
  countBreakingMarketWebSearchCalls,
  fetchBreakingMarketQuery,
  isFreshBreakingMarketPublishedAt,
  selectBreakingMarketQueriesForCycle,
  type BreakingMarketQuery,
} from "./breaking_market_source_fetchers.ts";

const now = new Date("2026-09-04T12:00:00Z");

function rawResponse(candidatesJson: unknown, sourceUrls: string[]) {
  return {
    output: [
      {
        type: "web_search_call",
        action: { sources: sourceUrls.map((url) => ({ url })) },
      },
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify({ candidates: candidatesJson }) }],
      },
    ],
  };
}

test("1: breaking_market queries are a distinct, additive list", () => {
  assert.ok(BREAKING_MARKET_QUERIES.length >= 4);
  const keys = BREAKING_MARKET_QUERIES.map((query) => query.key);
  assert.equal(new Set(keys).size, keys.length);
});

// STEP 11 #3: independent quota — the rotation selector itself never exceeds the hard cap regardless of
// how many queries exist, and never depends on how many corporate/market_macro candidates were fetched
// this cycle (they are computed in entirely separate code paths in index.ts).
test("3: at most MAX_BREAKING_MARKET_SEARCHES_PER_FETCH queries are ever selected in one cycle", () => {
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const t = new Date(now.getTime() + cycle * 20 * 60 * 1000);
    const selected = selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, t);
    assert.ok(selected.length <= MAX_BREAKING_MARKET_SEARCHES_PER_FETCH);
    assert.ok(selected.length > 0);
  }
});

test("rotation is deterministic within a cycle and covers every query within a few cycles", () => {
  const first = selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, now);
  const again = selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, now);
  assert.deepEqual(first.map((q) => q.key), again.map((q) => q.key));

  const seen = new Set<string>();
  for (let cycle = 0; cycle < BREAKING_MARKET_QUERIES.length; cycle += 1) {
    const t = new Date(now.getTime() + cycle * 20 * 60 * 1000);
    for (const query of selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, t)) seen.add(query.key);
  }
  assert.equal(seen.size, BREAKING_MARKET_QUERIES.length);
});

const query: BreakingMarketQuery = {
  key: "trump_tariff_semiconductor",
  searchQuery: "Trump tariff sanctions China Japan semiconductor export controls announcement today",
  defaultCategory: "tariffs",
  defaultTopicKey: "breaking:trump_tariff",
};

// STEP 11 #7/#9 groundwork + the STEP 3 hard rule: a candidate whose source_url was never actually
// visited by the web_search tool (not present in web_search_call.action.sources) must never survive.
test("10: Trump tariff candidate is accepted only when its source_url was actually visited", () => {
  const raw = [{
    title: "US announces new semiconductor tariffs on China",
    summary: "The US announced new tariffs targeting semiconductor exports to China.",
    source_url: "https://www.reuters.com/technology/us-tariffs-china-semiconductor-2026-09-04/",
    published_at: "2026-09-04T10:00:00Z",
    category: "tariffs",
  }];
  const visited = new Set(["https://www.reuters.com/technology/us-tariffs-china-semiconductor-2026-09-04/"]);
  const accepted = collectBreakingMarketCandidates(query, raw, visited, now);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].sourceType, "breaking_market");
  assert.equal(accepted[0].companyCode, null);
  assert.equal(accepted[0].category, "tariffs");

  const notVisited = collectBreakingMarketCandidates(query, raw, new Set(), now);
  assert.equal(notVisited.length, 0);
});

test("11: war/conflict candidate normalizes with geopolitics category and no company identity", () => {
  const warQuery: BreakingMarketQuery = {
    key: "war_geopolitics_taiwan", searchQuery: "war ceasefire military conflict Taiwan Middle East",
    defaultCategory: "geopolitics", defaultTopicKey: "breaking:conflict",
  };
  const raw = [{
    title: "Ceasefire reached in regional conflict",
    summary: "A ceasefire agreement was reached between the parties.",
    source_url: "https://apnews.com/article/ceasefire-2026",
    published_at: "2026-09-04T09:00:00Z",
    category: "war_ceasefire",
  }];
  const visited = new Set(["https://apnews.com/article/ceasefire-2026"]);
  const accepted = collectBreakingMarketCandidates(warQuery, raw, visited, now);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].category, "war_ceasefire");
  assert.equal(accepted[0].companyName, null);
  assert.equal(accepted[0].entityKey, "breaking:conflict");
});

test("12: FX intervention candidate normalizes with fx category", () => {
  const fxQuery: BreakingMarketQuery = {
    key: "fx_intervention_boj_fed_emergency", searchQuery: "Japan yen FX intervention MOF",
    defaultCategory: "fx", defaultTopicKey: "breaking:fx_intervention",
  };
  const raw = [{
    title: "Japan's Ministry of Finance intervenes in currency market",
    summary: "MOF confirmed intervention to counter yen depreciation.",
    source_url: "https://www.mof.go.jp/english/policy/international_policy/fx_intervention.html",
    published_at: "2026-09-04T11:00:00Z",
    category: "fx",
  }];
  const visited = new Set(["https://www.mof.go.jp/english/policy/international_policy/fx_intervention.html"]);
  const accepted = collectBreakingMarketCandidates(fxQuery, raw, visited, now);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].category, "fx");
  assert.equal(accepted[0].entityKey, "breaking:fx_intervention");
});

test("13+14: US CPI/payrolls candidate normalizes without company identity", () => {
  const dataQuery: BreakingMarketQuery = {
    key: "us_economic_data_surprise", searchQuery: "US CPI inflation jobs report payrolls surprise",
    defaultCategory: "us_government_policy", defaultTopicKey: "breaking:us_economic_data",
  };
  const raw = [{
    title: "US jobs report shows surprise slowdown in payrolls",
    summary: "Nonfarm payrolls came in well below expectations.",
    source_url: "https://www.bls.gov/news.release/empsit.nr0.htm",
    published_at: "2026-09-04T12:30:00Z",
    category: "us_government_policy",
  }];
  const visited = new Set(["https://www.bls.gov/news.release/empsit.nr0.htm"]);
  const accepted = collectBreakingMarketCandidates(
    dataQuery, raw, visited, new Date("2026-09-04T13:00:00Z"),
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].companyCode, null);
  assert.equal(accepted[0].companyName, null);
});

test("15: semiconductor export restriction candidate normalizes", () => {
  const raw = [{
    title: "Commerce Department tightens export rules for AI chips",
    summary: "New export restrictions target advanced semiconductor shipments.",
    source_url: "https://www.commerce.gov/news/press-releases/2026/09/export-controls-ai-chips",
    published_at: "2026-09-04T08:00:00Z",
    category: "semiconductor_ai",
  }];
  const visited = new Set(["https://www.commerce.gov/news/press-releases/2026/09/export-controls-ai-chips"]);
  const accepted = collectBreakingMarketCandidates(query, raw, visited, now);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].category, "semiconductor_ai");
});

test("16: bank collapse candidate normalizes with a valid category fallback", () => {
  const bankQuery: BreakingMarketQuery = {
    key: "bank_china_stimulus", searchQuery: "bank collapse failure China stimulus",
    defaultCategory: "china_policy", defaultTopicKey: "breaking:bank_or_china_policy",
  };
  const raw = [{
    title: "Major US regional bank fails, FDIC takes over",
    summary: "Regulators seized the bank after a run on deposits.",
    source_url: "https://www.reuters.com/business/finance/bank-failure-2026-09-04/",
    published_at: "2026-09-04T07:00:00Z",
    category: "not_a_real_category",
  }];
  const visited = new Set(["https://www.reuters.com/business/finance/bank-failure-2026-09-04/"]);
  const accepted = collectBreakingMarketCandidates(bankQuery, raw, visited, now);
  assert.equal(accepted.length, 1);
  // an invalid/unrecognized category from the model falls back to the query's own default, never crashes
  assert.equal(accepted[0].category, "china_policy");
});

test("17: market-move-as-news candidate (USDJPY/Nikkei/NASDAQ/SOX/oil) normalizes via the news query", () => {
  const moveQuery: BreakingMarketQuery = {
    key: "market_move_breaking", searchQuery: "USDJPY yen Nikkei futures NASDAQ SOX crude oil surge plunge",
    defaultCategory: "other_market_moving", defaultTopicKey: "breaking:market_move",
  };
  const raw = [{
    title: "Yen plunges 3 yen against dollar in early trading",
    summary: "USDJPY moved sharply following the policy announcement.",
    source_url: "https://www.bloomberg.com/news/articles/2026-09-04/yen-plunge",
    published_at: "2026-09-04T10:30:00Z",
    category: "fx",
  }];
  const visited = new Set(["https://www.bloomberg.com/news/articles/2026-09-04/yen-plunge"]);
  const accepted = collectBreakingMarketCandidates(moveQuery, raw, visited, now);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].entityKey, "breaking:market_move");
});

test("7: invalid (non-https or disallowed domain) source URL is rejected", () => {
  const raw = [
    {
      title: "Suspicious candidate", summary: "x",
      source_url: "not-a-valid-url", published_at: now.toISOString(), category: "tariffs",
    },
    {
      title: "Off-allowlist candidate", summary: "x",
      source_url: "https://random-blog.example.com/post", published_at: now.toISOString(), category: "tariffs",
    },
  ];
  const visited = new Set(["https://random-blog.example.com/post"]);
  const accepted = collectBreakingMarketCandidates(query, raw, visited, now);
  assert.equal(accepted.length, 0);
});

test("8: stale (older than 24h) breaking news is rejected; a future timestamp beyond skew is rejected", () => {
  assert.equal(isFreshBreakingMarketPublishedAt("2026-09-02T12:00:00Z", now), false);
  assert.equal(isFreshBreakingMarketPublishedAt("2026-09-04T00:00:00Z", now), true);
  assert.equal(isFreshBreakingMarketPublishedAt(
    new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(), now,
  ), false);
});

test("9: the same event across two searches shares dedupe-relevant fields (title/url) for downstream dedupe", async () => {
  const { createImportantNewsContentHash } = await import("./news_candidate_logic.ts");
  const raw = [{
    title: "US announces new semiconductor tariffs on China",
    summary: "The US announced new tariffs targeting semiconductor exports to China.",
    source_url: "https://www.reuters.com/technology/us-tariffs-china-semiconductor-2026-09-04/",
    published_at: "2026-09-04T10:00:00Z",
    category: "tariffs",
  }];
  const visited = new Set(["https://www.reuters.com/technology/us-tariffs-china-semiconductor-2026-09-04/"]);
  const first = collectBreakingMarketCandidates(query, raw, visited, now)[0];
  const second = collectBreakingMarketCandidates(query, raw, visited, now)[0];
  assert.equal(await createImportantNewsContentHash(first), await createImportantNewsContentHash(second));
  assert.equal(first.sourceUrl, second.sourceUrl);
});

test("collectBreakingMarketSourceUrls only collects URLs on the allowed domain list", () => {
  const raw = rawResponse([], [
    "https://www.reuters.com/world/story-1",
    "https://malicious.example.com/fake-source",
  ]);
  const found = collectBreakingMarketSourceUrls(raw);
  assert.equal(found.has("https://www.reuters.com/world/story-1"), true);
  assert.equal(found.has("https://malicious.example.com/fake-source"), false);
});

test("countBreakingMarketWebSearchCalls counts exactly the web_search_call output items", () => {
  const raw = rawResponse([], ["https://www.reuters.com/world/story-1"]);
  assert.equal(countBreakingMarketWebSearchCalls(raw), 1);
});

test("fetchBreakingMarketQuery only returns candidates whose URLs the tool actually visited", async () => {
  const raw = rawResponse(
    [{
      title: "US announces new semiconductor tariffs on China",
      summary: "Summary text.",
      source_url: "https://www.reuters.com/technology/us-tariffs-china-semiconductor-2026-09-04/",
      published_at: "2026-09-04T10:00:00Z",
      category: "tariffs",
    }],
    ["https://www.reuters.com/technology/us-tariffs-china-semiconductor-2026-09-04/"],
  );
  const candidates = await fetchBreakingMarketQuery(
    "test-key", query, now, async () => new Response(JSON.stringify(raw), { status: 200 }),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceType, "breaking_market");
});

test("fetchBreakingMarketQuery surfaces a stable error code that includes the query key on HTTP failure", async () => {
  await assert.rejects(
    () => fetchBreakingMarketQuery("test-key", query, now, async () => new Response("", { status: 503 })),
    /BREAKING_MARKET_SEARCH_FAILED:trump_tariff_semiconductor:503/,
  );
});

test("fetchBreakingMarketQuery returns no candidates when the model finds nothing (empty candidates array)", async () => {
  const raw = rawResponse([], []);
  const candidates = await fetchBreakingMarketQuery(
    "test-key", query, now, async () => new Response(JSON.stringify(raw), { status: 200 }),
  );
  assert.deepEqual(candidates, []);
});
