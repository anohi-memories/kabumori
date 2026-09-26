// Headline-trigger verification instructions name the citable outlets (2026-09-27). After the domain
// filter was removed (b51f903) the instructions still said "allowed domains" / "already restricted by
// the search tool" without naming any domain, so the model could treat every source as not allowed.
// Only the unrestricted (trigger) request changes; generic breaking instructions are byte-identical.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BREAKING_MARKET_QUERIES,
  breakingMarketRequestBody,
  fetchBreakingMarketQueryWithDiagnostics,
} from "./breaking_market_source_fetchers.ts";
import {
  runHeadlineTriggerLane,
  type TriggerHeadline,
  type TriggerHistory,
  verifyBreakingQuery,
} from "./headline_trigger_logic.ts";

const NOW = new Date("2026-09-27T01:00:00Z");
const VERIFY = verifyBreakingQuery("Trump Iran seven-day roadmap Strait of Hormuz latest breaking news September 27 2026", "war_ceasefire");

function instructions(body: Record<string, unknown>): string {
  return body.instructions as string;
}

test("generic breaking instructions keep the original allowed-domain wording and no outlet rule", () => {
  for (const query of BREAKING_MARKET_QUERIES) {
    const text = instructions(breakingMarketRequestBody(query, NOW));
    assert.match(text, /対象ドメインは検索ツール側で既に制限されています。/, query.key);
    assert.match(text, /実際に開いた許可ドメインのURL/, query.key);
    assert.doesNotMatch(text, /候補にできる出典は Reuters/, query.key);
  }
});

test("trigger verify instructions name the outlets and drop the 'already restricted' claim", () => {
  const text = instructions(breakingMarketRequestBody(VERIFY, NOW));
  assert.doesNotMatch(text, /許可ドメイン/);
  assert.doesNotMatch(text, /検索ツール側で既に制限/);
  assert.match(text, /下記の報道機関の記事として検索結果で実際に確認できた、直近3時間以内に発生・発表され/);
  assert.match(text, /実際に開いた、下記の報道機関の記事URL/);
  for (const domain of ["reuters.com", "apnews.com", "bloomberg.com", "nikkei.com", "asia.nikkei.com", "nhk.or.jp"]) {
    assert.ok(text.includes(domain), domain);
  }
  assert.match(text, /それ以外のサイトしか見つからない場合はcandidatesを空配列にします/);
});

test("the other verify rules are unchanged: site: ban, topic words, recency terms, opened-URL rule", () => {
  const text = instructions(breakingMarketRequestBody(VERIFY, NOW));
  assert.match(text, /site:演算子、ドメイン名、媒体名（Reuters、AP等）を検索語に入れません。search topicの具体語から/);
  assert.match(text, /検索語には必ずrecency termsをそのまま含めます/);
  assert.match(text, /source_urlが無い、または検索結果で実際に開いていないURLを候補にしません/);
});

test("only the instructions (and the already-removed filter) differ from a news-scope request", () => {
  const verify = breakingMarketRequestBody(VERIFY, NOW);
  const news = breakingMarketRequestBody({ ...VERIFY, searchScope: "news" }, NOW);
  const strip = (body: Record<string, unknown>) => ({ ...body, instructions: null, tools: null });
  assert.deepEqual(strip(verify), strip(news));
  assert.deepEqual(verify.tools, [{ type: "web_search", search_context_size: "low" }]);
  assert.equal(verify.model, "gpt-5.6-luna");
  assert.equal(verify.max_tool_calls, 1);
});

test("the persisted verify sample keeps five sources with their URL dates", async () => {
  const urls = [
    "https://apnews.com/article/692e1e171a791be0c9b9c1f56718a0d0",
    "https://www.reuters.com/world/middle-east/iran-2026-09-26/",
    "https://www.aljazeera.com/news/2026/9/26/iran",
    "https://www.washingtonpost.com/world/2026/09/25/iran/",
    "https://www.bloomberg.com/news/articles/2026-09-26/iran",
    "https://www.cnn.com/2026/09/26/iran",
  ];
  const headline: TriggerHeadline = {
    id: "", source: "al_jazeera", title: "Trump rejects Iran’s seven-day roadmap to reopen Strait of Hormuz",
    url: "https://www.aljazeera.com/news/2026/9/26/trump-rejects", publishedAt: "2026-09-26T15:30:00Z", summary: null,
  };
  const history: TriggerHistory = { seenUrls: new Set(), seenTitles: new Set(), deferred: [] };
  const result = await runHeadlineTriggerLane({
    headlines: [headline], feeds: {}, history, now: NOW,
    triage: (items) => Promise.resolve({
      results: new Map([[items[0].id, { decision: "verify" as const, category: "war_ceasefire" as const, reason: "r", searchTerms: "Trump Iran seven-day roadmap Strait of Hormuz" }]]),
      inputTokens: 1, outputTokens: 1,
    }),
    verify: (query, now) => fetchBreakingMarketQueryWithDiagnostics("k", query, now, () => Promise.resolve(new Response(JSON.stringify({
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 1 },
      output: [
        { type: "web_search_call", action: { type: "search", sources: urls.map((url) => ({ url })) } },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify({ candidates: [] }) }] },
      ],
    }), { status: 200 }))),
  });
  const sample = result.diagnostics.items[0].verifySourcesSample;
  assert.equal(sample.length, 5);
  // Al Jazeera's single-digit /2026/9/26/ paths are not read as dates (the URL-date reader is unchanged).
  assert.deepEqual(sample.map((item) => item.urlDate), [null, "2026-09-26", null, "2026-09-25", "2026-09-26"]);
});
