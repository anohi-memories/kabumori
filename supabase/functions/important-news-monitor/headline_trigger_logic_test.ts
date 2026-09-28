import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVerifyQuery,
  HEADLINE_TRIGGER_LANE_ENABLED,
  isNewsArticleHost,
  MAX_TRIGGER_CANDIDATES_PER_RUN,
  NEWS_ARTICLE_HOSTS,
  SECONDARY_VERIFY_MAX_PER_RUN,
  triggerArticleType,
  TRIGGER_PRIMARY_SOURCES,
  parseTriageOutput,
  parseTriggerFeed,
  runHeadlineTriggerLane,
  selectNewHeadlines,
  TRIGGER_SOURCES,
  TRIGGER_TRIAGE_MODEL,
  triggerHistoryFromRuns,
  triggerTriageRequestBody,
  openAiTriageRunner,
  type TriageResult,
  type TriggerHeadline,
  type TriggerHistory,
  type VerifyRunner,
  verifyBreakingQuery,
} from "./headline_trigger_logic.ts";
import {
  BREAKING_MARKET_NEWS_DOMAINS,
  breakingMarketRequestBody,
  type BreakingMarketQueryDiagnostics,
} from "./breaking_market_source_fetchers.ts";
import { type IncomingNewsCandidate, isImportantNewsCategory } from "./news_candidate_logic.ts";
import { buildCollectionRunDiagnostics } from "./news_collection_diagnostics.ts";
import { triggerTriageUsageEvents, triggerVerifyUsageEvents } from "./usage_metering.ts";
import { supabaseUsageWriter } from "./usage_ledger.ts";

const NOW = new Date("2026-09-26T04:00:00Z"); // 13:00 JST
const BBC = TRIGGER_SOURCES.find((source) => source.key === "bbc_world")!;
const AJ = TRIGGER_SOURCES.find((source) => source.key === "al_jazeera")!;
const EMPTY_HISTORY: TriggerHistory = { seenUrls: new Set(), seenTitles: new Set(), deferred: [] };

function rss(items: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`;
}

function item(title: string, link: string, pubDate: string, description = ""): string {
  return `<item><title><![CDATA[${title}]]></title><description><![CDATA[${description}]]></description>` +
    `<link>${link}</link><pubDate>${pubDate}</pubDate></item>`;
}

// --- Feeds -----------------------------------------------------------------------------------------

test("the lane is on, reads BBC World and Al Jazeera from the shadow feed definitions", () => {
  assert.equal(HEADLINE_TRIGGER_LANE_ENABLED, true);
  assert.deepEqual(TRIGGER_SOURCES.map((source) => [source.key, source.feedUrl]), [
    ["bbc_world", "https://feeds.bbci.co.uk/news/world/rss.xml"],
    ["al_jazeera", "https://www.aljazeera.com/xml/rss/all.xml"],
  ]);
});

test("BBC feed: fresh items parse with https URL, title, time and short summary", () => {
  const items = parseTriggerFeed(BBC, rss(item(
    "Iran offers US deal to reopen Strait of Hormuz in seven days",
    "https://www.bbc.co.uk/news/articles/cqgmrr9ekr7ko?at_medium=RSS",
    "Sat, 26 Sep 2026 04:14:30 GMT",
    "Tehran says it will reopen the waterway within a week if Washington agrees.",
  )), new Date("2026-09-26T04:30:00Z"));
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "bbc_world");
  assert.equal(items[0].publishedAt, "2026-09-26T04:14:30.000Z");
  assert.match(items[0].url, /^https:\/\/www\.bbc\.co\.uk\/news\/articles\//);
  assert.match(items[0].summary ?? "", /reopen the waterway/);
});

test("Al Jazeera feed: CDATA titles and http links are handled", () => {
  const items = parseTriggerFeed(AJ, rss(item(
    "Iran war live: Tehran offers US plan to reopen Hormuz within seven days",
    "http://www.aljazeera.com/news/liveblog/2026/9/26/iran-war-live",
    "Sat, 26 Sep 2026 00:00:00 +0000",
  )), NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://www.aljazeera.com/news/liveblog/2026/9/26/iran-war-live");
  assert.equal(items[0].summary, null);
});

test("empty, malformed, undated and stale items are dropped", () => {
  assert.deepEqual(parseTriggerFeed(BBC, rss(""), NOW), []);
  assert.deepEqual(parseTriggerFeed(BBC, "not xml at all", NOW), []);
  const items = parseTriggerFeed(BBC, rss([
    item("", "https://www.bbc.co.uk/news/a", "Sat, 26 Sep 2026 03:00:00 GMT"),
    item("No link", "", "Sat, 26 Sep 2026 03:00:00 GMT"),
    item("No date", "https://www.bbc.co.uk/news/b", ""),
    item("Seven hours old", "https://www.bbc.co.uk/news/c", "Fri, 25 Sep 2026 21:00:00 GMT"),
    item("Fresh", "https://www.bbc.co.uk/news/d", "Sat, 26 Sep 2026 03:30:00 GMT"),
  ].join("")), NOW);
  assert.deepEqual(items.map((headline) => headline.title), ["Fresh"]);
});

function headline(title: string, url: string, publishedAt = "2026-09-26T03:30:00Z", source = "al_jazeera"): TriggerHeadline {
  return { id: "", source, title, url, publishedAt, summary: null };
}

test("duplicates within the batch and against history are removed, newest first, ids assigned", () => {
  const history: TriggerHistory = {
    seenUrls: new Set(["https://aljazeera.com/news/old"]),
    seenTitles: new Set(["seen elsewhere"]),
    deferred: [],
  };
  const selected = selectNewHeadlines([
    headline("Older", "https://www.aljazeera.com/news/older", "2026-09-26T01:00:00Z"),
    headline("Newest", "https://www.aljazeera.com/news/newest", "2026-09-26T03:50:00Z"),
    headline("Same URL again", "https://www.aljazeera.com/news/newest?utm=1", "2026-09-26T03:40:00Z"),
    headline("Newest!", "https://www.bbc.co.uk/news/other", "2026-09-26T03:45:00Z", "bbc_world"),
    headline("Old url", "https://www.aljazeera.com/news/old", "2026-09-26T03:00:00Z"),
    headline("Seen elsewhere", "https://www.bbc.co.uk/news/x", "2026-09-26T03:00:00Z", "bbc_world"),
  ], history);
  assert.deepEqual(selected.map((item) => [item.id, item.title]), [["h1", "Newest"], ["h2", "Older"]]);
});

test("history keeps every triaged URL/title and returns only budget-deferred fresh verifies", () => {
  const history = triggerHistoryFromRuns([
    { items: [
      { url: "https://www.aljazeera.com/news/a", titleKey: "a", decision: "verify", candidateCreated: false, rejectionReason: "candidate_deferred_budget", publishedAt: "2026-09-26T02:00:00Z", triagedAt: "2026-09-26T03:00:00Z", title: "A", source: "al_jazeera", summary: "s" },
      { url: "https://www.aljazeera.com/news/b", titleKey: "b", decision: "ignore", candidateCreated: false, rejectionReason: null, publishedAt: "2026-09-26T02:00:00Z", triagedAt: "2026-09-26T03:00:00Z" },
      { url: "https://www.aljazeera.com/news/c", titleKey: "c", decision: "verify", candidateCreated: false, rejectionReason: "candidate_deferred_budget", publishedAt: "2026-09-25T20:00:00Z", triagedAt: "2026-09-26T03:00:00Z" },
      { url: "https://www.aljazeera.com/news/e", titleKey: "e", decision: "verify", candidateCreated: false, rejectionReason: "duplicate", publishedAt: "2026-09-26T02:00:00Z", triagedAt: "2026-09-26T03:00:00Z" },
      { url: "https://www.aljazeera.com/news/f", titleKey: "f", decision: "verify", verifyAttempted: false, rejectionReason: "verify_deferred_budget", publishedAt: "2026-09-26T02:00:00Z", triagedAt: "2026-09-26T03:00:00Z" },
    ] },
    { items: [
      { url: "https://www.aljazeera.com/news/d", titleKey: "d", decision: "verify", candidateCreated: false, rejectionReason: "candidate_deferred_budget", publishedAt: "2026-09-26T02:00:00Z", triagedAt: "2026-09-26T02:00:00Z" },
      { url: "https://www.aljazeera.com/news/d", titleKey: "d", decision: "verify", candidateCreated: true, rejectionReason: null, publishedAt: "2026-09-26T02:00:00Z", triagedAt: "2026-09-26T03:00:00Z" },
    ] },
    { items: null },
    null,
  ], NOW);
  assert.equal(history.seenUrls.size, 6);
  assert.deepEqual([...history.seenTitles].sort(), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(history.deferred.map((item) => item.titleKey), ["a"],
    "c is too old, d was created later, e was a duplicate, f is a pre-2026-09-28 search deferral");
});

// --- Luna triage -----------------------------------------------------------------------------------

test("triage request: one GPT-6 Luna call, no tools, strict schema, recall-first rules", () => {
  const body = triggerTriageRequestBody([{ ...headline("X", "https://a"), id: "h1" }], NOW);
  assert.equal(body.model, TRIGGER_TRIAGE_MODEL);
  assert.equal(TRIGGER_TRIAGE_MODEL, "gpt-6-luna");
  assert.equal(body.tools, undefined);
  const instructions = body.instructions as string;
  assert.match(instructions, /ignore \/ watch \/ verify/);
  assert.match(instructions, /北朝鮮のミサイル、ホルムズ海峡・紅海・フーシ派/);
  assert.match(instructions, /迷ったらverify/);
  assert.match(instructions, /site:演算子、ドメイン名、媒体名/);
  assert.equal((body.text as { format: { strict: boolean } }).format.strict, true);
});

test("triage output: ignore/watch/verify parse; bad rows and unknown categories are handled", () => {
  const results = parseTriageOutput({ items: [
    { id: "h1", decision: "verify", category: "geopolitics", reason: "海峡", search_terms: "Iran Hormuz reopen" },
    { id: "h2", decision: "watch", category: "war_ceasefire", reason: "", search_terms: "" },
    { id: "h3", decision: "ignore", category: "not_a_category", reason: "スポーツ", search_terms: "" },
    { id: "h4", decision: "maybe", category: "geopolitics", reason: "", search_terms: "" },
    "junk",
  ] });
  assert.deepEqual([...results.keys()], ["h1", "h2", "h3"]);
  assert.equal(results.get("h3")?.category, "other_market_moving");
  assert.throws(() => parseTriageOutput({ decisions: [] }), /TRIGGER_TRIAGE_INVALID_OUTPUT/);
  assert.throws(() => parseTriageOutput(null), /TRIGGER_TRIAGE_INVALID_OUTPUT/);
});

test("triage runner: API failure and malformed output raise with the billed usage kept", async () => {
  const headlines = [{ ...headline("X", "https://a"), id: "h1" }];
  const failed = openAiTriageRunner("k", () => Promise.resolve(new Response("{}", { status: 500 })));
  await assert.rejects(failed(headlines, NOW), /TRIGGER_TRIAGE_HTTP_500/);
  const malformed = openAiTriageRunner("k", () => Promise.resolve(new Response(JSON.stringify({
    usage: { input_tokens: 900, output_tokens: 40 },
    output: [{ type: "message", content: [{ type: "output_text", text: "{oops" }] }],
  }), { status: 200 })));
  await assert.rejects(malformed(headlines, NOW), (error: Error & { usage?: { inputTokens: number } }) => {
    assert.equal(error.message, "TRIGGER_TRIAGE_INVALID_OUTPUT");
    assert.equal(error.usage?.inputTokens, 900);
    return true;
  });
});

// --- Verification query and hosts ------------------------------------------------------------------

test("verify query: concrete terms, no site:/domain/outlet names, capped, dated from the clock", () => {
  const query = buildVerifyQuery(
    "Iran offers US deal to reopen Strait of Hormuz in seven days",
    "site:reuters.com Reuters Iran offers US deal reopen Strait of Hormuz seven days apnews.com/article",
    NOW,
  );
  assert.equal(query, "Iran offers US deal reopen Strait of Hormuz seven days latest breaking news September 26 2026");
  assert.doesNotMatch(query, /site:|reuters|\.com/i);
  const fromTitle = buildVerifyQuery("North Korea fires ballistic missile toward Sea of Japan", "", NOW);
  assert.match(fromTitle, /^North Korea fires ballistic missile toward Sea of Japan latest breaking news September 26 2026$/);
  const long = buildVerifyQuery("t", Array.from({ length: 30 }, (_, i) => `w${i}`).join(" "), NOW);
  assert.equal(long.split(" ").length, 14 + 6, "14 terms plus the six recency words");
});

test("verify runs as an unrestricted breaking query with the headline terms and a 6h window", () => {
  const query = verifyBreakingQuery("Iran Hormuz reopen latest breaking news September 26 2026", "geopolitics");
  const body = breakingMarketRequestBody(query, NOW);
  assert.match(body.input as string, /search topic: Iran Hormuz reopen/);
  assert.deepEqual(body.tools, [{ type: "web_search", search_context_size: "low" }]);
  assert.equal(body.max_tool_calls, 1);
  assert.equal(query.maxItemAgeMs, 6 * 60 * 60 * 1000);
  assert.equal(query.defaultTopicKey, "breaking:trigger:geopolitics");
});

test("article hosts: outlet article hosts pass, help/marketing/search subdomains do not", () => {
  for (const url of [
    "https://www.reuters.com/world/middle-east/iran-2026-09-26/",
    "https://apnews.com/article/abc",
    "https://www.bloomberg.com/news/articles/2026-09-26/x",
    "https://asia.nikkei.com/Politics/x",
    "https://www3.nhk.or.jp/news/html/20260926/k1.html",
  ]) assert.ok(isNewsArticleHost(url), url);
  for (const url of [
    "https://assist.bloomberg.com/",
    "https://service.bloomberg.com/portal",
    "https://mercury.bloomberg.com/search/1",
    "https://pitch.nikkei.com/archive/report.pdf",
    "https://promotion.asia.nikkei.com/campaign",
    "https://www.bbc.co.uk/news/articles/x",
    "not a url",
  ]) assert.ok(!isNewsArticleHost(url), url);
  assert.ok(NEWS_ARTICLE_HOSTS.every((host) => BREAKING_MARKET_NEWS_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))));
});

// --- Orchestration: BBC / Al Jazeera as primary sources ---------------------------------------------

function diagnostics(overrides: Partial<BreakingMarketQueryDiagnostics> = {}): BreakingMarketQueryDiagnostics {
  return {
    queryKey: "headline_trigger_verify", query: "q", providerStatus: "succeeded", httpStatus: 200,
    responseStatus: "completed", incompleteReason: null, webSearchCallCount: 1, inputTokens: 11000,
    outputTokens: 250, estimatedCostUsd: 0.0125, model: "gpt-5.6-luna", rawCandidateCount: 1,
    validatedCandidateCount: 1, rejectionCounts: {} as never, failureCode: null, searchSourceCount: 12,
    searchSourcesSample: [{ url: "https://apnews.com/article/abc", domain: "apnews.com", title: null, publishedAt: null, urlDate: null, opened: false }],
    ...overrides,
  };
}

function candidateAt(url: string, title: string): IncomingNewsCandidate {
  return {
    sourceType: "breaking_market", sourceName: "breaking_market", sourceUrl: url, title, bodySummary: "s",
    companyName: null, companyCode: null, entityKey: "breaking:trigger:geopolitics", category: "geopolitics",
    publishedAt: "2026-09-26T03:40:00Z",
  };
}

function triageAll(decision: TriageResult["decision"], terms = "Iran Hormuz reopen", category: TriageResult["category"] = "geopolitics") {
  return (headlines: TriggerHeadline[]) => Promise.resolve({
    results: new Map(headlines.map((item) => [item.id, { decision, category, reason: "r", searchTerms: terms }])),
    inputTokens: 1200,
    outputTokens: 90,
  });
}

const neverSearched: VerifyRunner = () => Promise.reject(new Error("the forced verification search must not run"));

test("BBC news article: verify becomes a candidate straight from the feed, without any web search", async () => {
  const result = await runHeadlineTriggerLane({
    headlines: [{ ...headline("Iran offers US deal to reopen Strait of Hormuz in seven days", "https://www.bbc.co.uk/news/articles/cqgmrr9ekr7ko?at_medium=RSS&at_campaign=rss", "2026-09-26T03:14:30Z", "bbc_world"), summary: "Tehran says it will reopen the waterway within a week." }],
    feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), verify: neverSearched, now: NOW,
  });
  assert.equal(result.candidates.length, 1);
  const [candidate] = result.candidates;
  assert.equal(candidate.sourceType, "breaking_market");
  assert.equal(candidate.sourceName, "bbc_world");
  assert.equal(candidate.sourceUrl, "https://www.bbc.co.uk/news/articles/cqgmrr9ekr7ko", "feed campaign parameters dropped");
  assert.equal(candidate.publishedAt, "2026-09-26T03:14:30Z", "the RSS timestamp is the source timestamp");
  assert.equal(candidate.entityKey, "breaking:trigger:geopolitics");
  assert.match(candidate.bodySummary ?? "", /^\[単一ソース: BBC News 記事（RSS見出し・本文要約）\] Tehran says/);
  const [item] = result.diagnostics.items;
  assert.equal(item.articleType, "news");
  assert.equal(item.primarySource, "bbc_world");
  assert.equal(item.candidateCreated, true);
  assert.equal(item.dedupeResult, "unique");
  assert.equal(item.secondaryVerificationAttempted, false);
  assert.equal(result.verifyDiagnostics.length, 0, "no search, no verify usage row");
});

test("ignore and watch never create candidates and never search", async () => {
  for (const decision of ["ignore", "watch"] as const) {
    const result = await runHeadlineTriggerLane({
      headlines: [headline(`Football ${decision}`, `https://www.aljazeera.com/news/2026/9/26/${decision}`)],
      feeds: {}, history: EMPTY_HISTORY, triage: triageAll(decision), verify: neverSearched, now: NOW,
    });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.diagnostics.items[0].decision, decision);
    assert.equal(result.diagnostics.items[0].candidateCreated, false);
  }
});

test("Al Jazeera article types are recorded and labelled for judgement; every type can reach judgement", async () => {
  const cases: Array<[string, string, string]> = [
    ["https://www.aljazeera.com/news/2026/9/26/houthis-seize-islands", "news", "Al Jazeera 記事"],
    ["https://www.aljazeera.com/news/liveblog/2026/9/26/iran-war-live", "liveblog", "Al Jazeera ライブブログ（速報まとめ）"],
    ["https://www.aljazeera.com/video/newsfeed/2026/9/26/iran-pitches", "video", "Al Jazeera 動画ニュース"],
    ["https://www.aljazeera.com/features/2026/9/26/why-yemen", "feature", "Al Jazeera 特集"],
    ["https://www.aljazeera.com/opinions/2026/9/26/diplomacy", "opinion", "Al Jazeera オピニオン・解説"],
  ];
  for (const [url, type, label] of cases) {
    assert.equal(triggerArticleType("al_jazeera", url), type, url);
    const result = await runHeadlineTriggerLane({
      headlines: [headline(`Distinct event ${type}`, url)], feeds: {}, history: EMPTY_HISTORY,
      triage: triageAll("verify"), now: NOW,
    });
    assert.equal(result.candidates.length, 1, url);
    assert.ok((result.candidates[0].bodySummary ?? "").startsWith(`[単一ソース: ${label}`), url);
    assert.equal(result.diagnostics.items[0].articleType, type);
  }
  assert.equal(triggerArticleType("bbc_world", "https://www.bbc.co.uk/news/live/c123"), "liveblog");
  assert.equal(triggerArticleType("bbc_world", "https://www.bbc.co.uk/news/videos/c123"), "video");
});

test("stale, non-primary and non-https items are not candidates", async () => {
  const stale = await runHeadlineTriggerLane({
    headlines: [headline("Old", "https://www.aljazeera.com/news/2026/9/25/old", "2026-09-25T20:00:00Z")],
    feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), now: NOW,
  });
  assert.equal(stale.candidates.length, 0);
  assert.equal(stale.diagnostics.items[0].rejectionReason, "stale_or_invalid_headline");
  const foreign = await runHeadlineTriggerLane({
    headlines: [headline("Elsewhere", "https://example.com/news/x", "2026-09-26T03:30:00Z", "al_jazeera")],
    feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), now: NOW,
  });
  assert.equal(foreign.candidates.length, 0);
  assert.equal(foreign.diagnostics.items[0].rejectionReason, "not_primary_source_url");
});

test("same event from BBC and Al Jazeera in one run: one candidate, the news report wins over the liveblog", async () => {
  const result = await runHeadlineTriggerLane({
    headlines: [
      headline("Iran war live: Tehran offers US plan to reopen Hormuz within seven days", "https://www.aljazeera.com/news/liveblog/2026/9/26/iran-war-live", "2026-09-26T00:00:00Z"),
      headline("Iran offers US deal to reopen Strait of Hormuz in seven days", "https://www.bbc.co.uk/news/articles/cqgmrr9ekr7ko", "2026-09-26T03:14:30Z", "bbc_world"),
    ],
    feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), now: NOW,
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceName, "bbc_world");
  assert.equal(result.diagnostics.duplicateCount, 1);
  const liveblog = result.diagnostics.items.find((item) => item.articleType === "liveblog")!;
  assert.match(liveblog.dedupeResult ?? "", /^same_event_in_run:https:\/\/www\.bbc\.co\.uk/);
});

test("a headline similar to a candidate stored in the last 24h (e.g. from breaking search) is not created again", async () => {
  const result = await runHeadlineTriggerLane({
    headlines: [headline("Houthis declare blockade on Saudi shipping in the Red Sea", "https://www.aljazeera.com/news/2026/9/26/houthis-blockade")],
    feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), now: NOW,
    recentCandidateTitles: ["Houthis declare blockade on Saudi shipping in Bab el-Mandeb and Red Sea"],
  });
  assert.equal(result.candidates.length, 0);
  assert.match(result.diagnostics.items[0].dedupeResult ?? "", /^similar_recent_candidate:/);
  const distinct = await runHeadlineTriggerLane({
    headlines: [headline("Trump rejects Iran's seven-day roadmap", "https://www.aljazeera.com/news/2026/9/26/trump-rejects")],
    feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), now: NOW,
    recentCandidateTitles: ["Iran offers US deal to reopen Strait of Hormuz in seven days"],
  });
  assert.equal(distinct.candidates.length, 1, "a different development of the same story is a new candidate");
});

test("optional secondary search: success records evidence, failure or no article never drops the candidate", async () => {
  const ok = await runHeadlineTriggerLane({
    headlines: [headline("Strike on tanker in Hormuz", "https://www.aljazeera.com/news/2026/9/26/tanker")],
    feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), now: NOW, maxSecondary: 1,
    verify: () => Promise.resolve({ candidates: [candidateAt("https://apnews.com/article/tanker", "Tanker struck")], diagnostics: diagnostics() }),
  });
  assert.equal(ok.candidates.length, 1);
  assert.equal(ok.candidates[0].sourceName, "al_jazeera", "the candidate stays the primary source item");
  assert.equal(ok.diagnostics.items[0].secondaryVerificationFound, true);
  assert.equal(ok.diagnostics.items[0].secondaryVerificationUrl, "https://apnews.com/article/tanker");
  assert.equal(ok.verifyDiagnostics.length, 1);

  const none = await runHeadlineTriggerLane({
    headlines: [headline("Strike on tanker in Hormuz", "https://www.aljazeera.com/news/2026/9/26/tanker")],
    feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), now: NOW, maxSecondary: 1,
    verify: () => Promise.resolve({ candidates: [], diagnostics: diagnostics({ rawCandidateCount: 0 }) }),
  });
  assert.equal(none.candidates.length, 1);
  assert.equal(none.diagnostics.items[0].secondaryVerificationFound, false);

  const failed = await runHeadlineTriggerLane({
    headlines: [headline("Strike on tanker in Hormuz", "https://www.aljazeera.com/news/2026/9/26/tanker")],
    feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), now: NOW, maxSecondary: 1,
    verify: () => Promise.reject(Object.assign(new Error("BREAKING_MARKET_SEARCH_FAILED:x:429"), { diagnostics: diagnostics({ webSearchCallCount: 0, inputTokens: 0, outputTokens: 0 }) })),
  });
  assert.equal(failed.candidates.length, 1);
  assert.equal(failed.diagnostics.items[0].secondaryVerificationAttempted, true);
  assert.equal(failed.diagnostics.items[0].secondaryVerificationFound, false);
});

test("the forced verification search is off by default", () => {
  assert.equal(SECONDARY_VERIFY_MAX_PER_RUN, 0);
});

test("triage failure creates nothing and never throws", async () => {
  const result = await runHeadlineTriggerLane({
    headlines: [headline("Strike on tanker", "https://www.aljazeera.com/news/2026/9/26/t")],
    feeds: {}, history: EMPTY_HISTORY, triage: () => Promise.reject(new Error("TRIGGER_TRIAGE_HTTP_500")), now: NOW,
  });
  assert.equal(result.diagnostics.triageFailureCode, "TRIGGER_TRIAGE_HTTP_500");
  assert.equal(result.diagnostics.items[0].decision, "triage_failed");
  assert.equal(result.candidates.length, 0);
});

test("the per-run candidate budget defers extras, which are created from history next run without re-triage", async () => {
  const headlines = Array.from({ length: MAX_TRIGGER_CANDIDATES_PER_RUN + 2 }, (_, i) =>
    ({ ...headline(`Unrelated event number ${i} alpha${i} beta${i}`, `https://www.aljazeera.com/news/2026/9/26/e${i}`, `2026-09-26T03:${String(10 + i).padStart(2, "0")}:00Z`), summary: `Summary ${i}` }));
  const first = await runHeadlineTriggerLane({ headlines, feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), now: NOW });
  assert.equal(first.candidates.length, MAX_TRIGGER_CANDIDATES_PER_RUN);
  assert.equal(first.diagnostics.candidateDeferredCount, 2);
  const later = new Date(NOW.getTime() + 60 * 60 * 1000);
  const history = triggerHistoryFromRuns([{ items: first.diagnostics.items }], later);
  assert.equal(history.deferred.length, 2);
  const second = await runHeadlineTriggerLane({
    headlines, feeds: {}, history, triage: () => Promise.reject(new Error("no new headlines expected")), now: later,
  });
  assert.equal(second.candidates.length, 2);
  assert.equal(second.diagnostics.newHeadlineCount, 0);
  assert.ok(second.candidates.every((candidate) => /Summary \d+$/.test(candidate.bodySummary ?? "")), "summary kept for deferred items");
});

// --- Replay: past important events ------------------------------------------------------------------

const REPLAY: Array<{ name: string; title: string; url: string; source: string; category: TriageResult["category"] }> = [
  { name: "Hormuz reopening offer", title: "Iran offers US deal to reopen Strait of Hormuz in seven days", url: "https://www.bbc.co.uk/news/articles/cqgmrr9ekr7ko", source: "bbc_world", category: "geopolitics" },
  { name: "Iran seven-day ceasefire plan", title: "Iran pitches US a seven-day end to the war at UNGA", url: "https://www.aljazeera.com/video/newsfeed/2026/9/26/iran-pitches-us-a-seven-day-end", source: "al_jazeera", category: "war_ceasefire" },
  { name: "North Korea missile", title: "North Korea launches ballistic missile toward the sea, South Korea says", url: "https://www.aljazeera.com/news/2026/9/12/north-korea-launches-ballistic-missile", source: "al_jazeera", category: "major_security_incident" },
  { name: "Houthis", title: "Houthis seize 2 strategic Red Sea islands near Bab el-Mandeb", url: "https://www.bbc.co.uk/news/articles/houthis-islands", source: "bbc_world", category: "geopolitics" },
  { name: "US-China AI channel", title: "China, US to open AI 'communication channel' after summit, White House says", url: "https://www.aljazeera.com/news/2026/9/26/china-us-ai-channel", source: "al_jazeera", category: "semiconductor_ai" },
  { name: "Major disaster", title: "Typhoon Dujuan hits Japan with deadly floods, travel chaos near Tokyo", url: "https://www.aljazeera.com/news/2026/9/22/typhoon-dujuan-hits-japan", source: "al_jazeera", category: "disaster" },
];

for (const event of REPLAY) {
  test(`replay: ${event.name} — RSS -> Luna verify -> candidate -> accepted by the existing candidate parser`, async () => {
    const result = await runHeadlineTriggerLane({
      headlines: [headline(event.title, event.url, "2026-09-26T03:30:00Z", event.source)],
      feeds: {}, history: EMPTY_HISTORY, now: NOW, verify: neverSearched,
      triage: (headlines) => Promise.resolve({
        results: new Map([[headlines[0].id, { decision: "verify" as const, category: event.category, reason: "r", searchTerms: "" }]]),
        inputTokens: 900, outputTokens: 60,
      }),
    });
    assert.equal(result.candidates.length, 1, event.name);
    const [candidate] = result.candidates;
    assert.equal(candidate.sourceName, event.source);
    assert.equal(candidate.sourceUrl, event.url);
    assert.equal(candidate.category, event.category);
    // What index.ts SOURCE_POLICY enforces for these source names before judgement.
    const host = new URL(candidate.sourceUrl).hostname;
    assert.ok(TRIGGER_PRIMARY_SOURCES[event.source].domains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
    // And the candidate is judgement-ready: category valid, timestamp present, single-source label on the summary.
    assert.ok(isImportantNewsCategory(candidate.category));
    assert.ok(Number.isFinite(Date.parse(candidate.publishedAt)));
    assert.match(candidate.bodySummary ?? "", /^\[単一ソース: /);
  });
}

// --- Usage and diagnostics -------------------------------------------------------------------------

test("usage: one triage row per call and one verify row per billed search, against the run", () => {
  const triage = triggerTriageUsageEvents({ model: "gpt-6-luna", inputTokens: 2000, outputTokens: 150 }, "run-1");
  assert.deepEqual(triage.map((event) => [event.feature, event.model, event.relatedTable, event.relatedId]), [
    ["news_trigger_triage_luna", "gpt-6-luna", "important_news_monitor_runs", "run-1"],
  ]);
  assert.deepEqual(triggerTriageUsageEvents(null, "run-1"), []);
  const verify = triggerVerifyUsageEvents([
    { category: "geopolitics", diagnostics: diagnostics() },
    { category: "tariffs", diagnostics: diagnostics({ webSearchCallCount: 0, inputTokens: 0, outputTokens: 0 }) },
  ], "run-1");
  assert.deepEqual(verify.map((event) => [event.feature, event.webSearchCalls, event.model]), [
    ["news_trigger_verify_search|geopolitics", 1, "gpt-5.6-luna"],
  ]);
});

test("usage write failure never throws", async () => {
  const events = triggerTriageUsageEvents({ model: "gpt-6-luna", inputTokens: 10, outputTokens: 1 }, "r");
  await supabaseUsageWriter("https://p.supabase.co", "k", () => Promise.reject(new Error("down")))(events);
});

test("run diagnostics carry the lane and its cost without touching the breaking section", () => {
  const run = buildCollectionRunDiagnostics({
    marketMacroProviders: [],
    breakingMarketQueries: [],
    headlineTrigger: {
      lane: { items: [{ titleKey: "x" }] },
      triage: { inputTokens: 2000, outputTokens: 150, estimatedCostUsd: 0.000275 },
      verify: [diagnostics(), diagnostics({ webSearchCallCount: 2, estimatedCostUsd: 0.0225 })],
    },
  });
  assert.deepEqual(run.triggerLane, { items: [{ titleKey: "x" }] });
  assert.deepEqual(run.cost.breakingMarket, { queries: 0, webSearchCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
  assert.deepEqual((run.cost as { headlineTrigger?: unknown }).headlineTrigger, {
    triageCalls: 1, verifySearches: 2, webSearchCalls: 3, inputTokens: 24000, outputTokens: 650, estimatedCostUsd: 0.035275,
  });
  const without = buildCollectionRunDiagnostics({ marketMacroProviders: [], breakingMarketQueries: [] });
  assert.equal("triggerLane" in without, false);
  assert.equal("headlineTrigger" in without.cost, false);
});
