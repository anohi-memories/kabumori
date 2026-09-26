import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVerifyQuery,
  HEADLINE_TRIGGER_LANE_ENABLED,
  isNewsArticleHost,
  MAX_TRIGGER_VERIFY_PER_RUN,
  NEWS_ARTICLE_HOSTS,
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
  fetchBreakingMarketQueryWithDiagnostics,
  type BreakingMarketQueryDiagnostics,
} from "./breaking_market_source_fetchers.ts";
import type { IncomingNewsCandidate } from "./news_candidate_logic.ts";
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

test("history keeps every triaged URL/title and returns only unsearched fresh verifies as deferred", () => {
  const history = triggerHistoryFromRuns([
    { items: [
      { url: "https://www.aljazeera.com/news/a", titleKey: "a", decision: "verify", verifyAttempted: false, publishedAt: "2026-09-26T02:00:00Z", triagedAt: "2026-09-26T03:00:00Z", title: "A", source: "al_jazeera" },
      { url: "https://www.aljazeera.com/news/b", titleKey: "b", decision: "ignore", verifyAttempted: false, publishedAt: "2026-09-26T02:00:00Z", triagedAt: "2026-09-26T03:00:00Z" },
      { url: "https://www.aljazeera.com/news/c", titleKey: "c", decision: "verify", verifyAttempted: false, publishedAt: "2026-09-25T20:00:00Z", triagedAt: "2026-09-26T03:00:00Z" },
    ] },
    { items: [
      { url: "https://www.aljazeera.com/news/d", titleKey: "d", decision: "verify", verifyAttempted: false, publishedAt: "2026-09-26T02:00:00Z", triagedAt: "2026-09-26T02:00:00Z" },
      { url: "https://www.aljazeera.com/news/d", titleKey: "d", decision: "verify", verifyAttempted: true, publishedAt: "2026-09-26T02:00:00Z", triagedAt: "2026-09-26T03:00:00Z" },
    ] },
    { items: null },
    null,
  ], NOW);
  assert.equal(history.seenUrls.size, 4);
  assert.deepEqual([...history.seenTitles].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(history.deferred.map((item) => item.titleKey), ["a"], "c is too old, d was searched later");
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

// --- Orchestration ---------------------------------------------------------------------------------

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

function triageAll(decision: TriageResult["decision"], terms = "Iran Hormuz reopen") {
  return (headlines: TriggerHeadline[]) => Promise.resolve({
    results: new Map(headlines.map((item) => [item.id, { decision, category: "geopolitics" as const, reason: "r", searchTerms: terms }])),
    inputTokens: 1200,
    outputTokens: 90,
  });
}

test("verify decision + visited fresh article on an article host becomes a candidate", async () => {
  const seen: string[] = [];
  const verify: VerifyRunner = (query) => {
    seen.push(query.searchQuery);
    return Promise.resolve({ candidates: [candidateAt("https://apnews.com/article/abc", "Iran offers to reopen Hormuz")], diagnostics: diagnostics() });
  };
  const result = await runHeadlineTriggerLane({
    headlines: [headline("Iran offers US deal to reopen Strait of Hormuz in seven days", "https://www.bbc.co.uk/news/articles/x")],
    feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), verify, now: NOW,
  });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(seen, ["Iran Hormuz reopen latest breaking news September 26 2026"]);
  const [item] = result.diagnostics.items;
  assert.equal(item.decision, "verify");
  assert.equal(item.candidateCreated, true);
  assert.equal(item.verifySourceCount, 12);
  assert.equal(result.triageUsage?.model, "gpt-6-luna");
});

test("ignore and watch never search; nothing becomes a candidate", async () => {
  let searched = 0;
  const verify: VerifyRunner = () => { searched += 1; return Promise.reject(new Error("unexpected")); };
  for (const decision of ["ignore", "watch"] as const) {
    const result = await runHeadlineTriggerLane({
      headlines: [headline(`Football ${decision}`, `https://www.aljazeera.com/sport/${decision}`)],
      feeds: {}, history: EMPTY_HISTORY, triage: triageAll(decision), verify, now: NOW,
    });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.diagnostics.items[0].decision, decision);
    assert.equal(result.diagnostics.items[0].verifyAttempted, false);
  }
  assert.equal(searched, 0);
});

test("verification without an article: zero sources, stale-only and non-article hosts are recorded, not dropped silently", async () => {
  const cases: Array<[string, Awaited<ReturnType<VerifyRunner>>]> = [
    ["verify_no_sources", { candidates: [], diagnostics: diagnostics({ searchSourceCount: 0, rawCandidateCount: 0 }) }],
    ["verify_no_fresh_article", { candidates: [], diagnostics: diagnostics({ rawCandidateCount: 0 }) }],
    ["verify_non_article_host", { candidates: [candidateAt("https://assist.bloomberg.com/", "Help")], diagnostics: diagnostics() }],
  ];
  for (const [reason, verified] of cases) {
    const result = await runHeadlineTriggerLane({
      headlines: [headline("Houthis declare blockade on Saudi shipping", `https://www.aljazeera.com/news/${reason}`)],
      feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), verify: () => Promise.resolve(verified), now: NOW,
    });
    assert.equal(result.candidates.length, 0, reason);
    assert.equal(result.diagnostics.items[0].rejectionReason, reason);
    assert.equal(result.diagnostics.items[0].decision, "verify", "the unverified high-signal headline stays recorded");
  }
});

test("verification failure and triage failure never throw out of the lane", async () => {
  const failingVerify: VerifyRunner = () => Promise.reject(Object.assign(new Error("BREAKING_MARKET_SEARCH_FAILED:x:429"), { diagnostics: diagnostics({ webSearchCallCount: 0, inputTokens: 0, outputTokens: 0 }) }));
  const verifyFailed = await runHeadlineTriggerLane({
    headlines: [headline("Strike on tanker", "https://www.aljazeera.com/news/t")],
    feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), verify: failingVerify, now: NOW,
  });
  assert.match(verifyFailed.diagnostics.items[0].rejectionReason ?? "", /^verify_failed:BREAKING_MARKET_SEARCH_FAILED/);
  const triageFailed = await runHeadlineTriggerLane({
    headlines: [headline("Strike on tanker", "https://www.aljazeera.com/news/t")],
    feeds: {}, history: EMPTY_HISTORY, triage: () => Promise.reject(new Error("TRIGGER_TRIAGE_HTTP_500")),
    verify: failingVerify, now: NOW,
  });
  assert.equal(triageFailed.diagnostics.triageFailureCode, "TRIGGER_TRIAGE_HTTP_500");
  assert.equal(triageFailed.diagnostics.items[0].decision, "triage_failed");
  assert.equal(triageFailed.candidates.length, 0);
});

test("the per-run verify budget defers extras, and a deferred verify is retried from history next run", async () => {
  const headlines = Array.from({ length: MAX_TRIGGER_VERIFY_PER_RUN + 2 }, (_, i) =>
    headline(`Event ${i}`, `https://www.aljazeera.com/news/e${i}`, `2026-09-26T03:${String(10 + i).padStart(2, "0")}:00Z`));
  let calls = 0;
  const verify: VerifyRunner = () => { calls += 1; return Promise.resolve({ candidates: [], diagnostics: diagnostics({ rawCandidateCount: 0 }) }); };
  const first = await runHeadlineTriggerLane({ headlines, feeds: {}, history: EMPTY_HISTORY, triage: triageAll("verify"), verify, now: NOW });
  assert.equal(calls, MAX_TRIGGER_VERIFY_PER_RUN);
  assert.equal(first.diagnostics.verifyDeferredCount, 2);
  const history = triggerHistoryFromRuns([{ items: first.diagnostics.items }], new Date(NOW.getTime() + 60 * 60 * 1000));
  assert.equal(history.deferred.length, 2);
  calls = 0;
  const second = await runHeadlineTriggerLane({
    headlines, feeds: {}, history, triage: () => Promise.reject(new Error("no new headlines expected")), verify,
    now: new Date(NOW.getTime() + 60 * 60 * 1000),
  });
  assert.equal(calls, 2, "only the deferred two are searched; nothing is re-triaged");
  assert.equal(second.diagnostics.newHeadlineCount, 0);
});

// --- Replay: past important events ------------------------------------------------------------------

const REPLAY: Array<{ name: string; title: string; terms: string; article: string; category: TriageResult["category"] }> = [
  { name: "North Korea missile", title: "North Korea launches unidentified projectile toward the sea", terms: "North Korea launches projectile sea Japan", article: "https://apnews.com/article/ad020d996b61dedd358cc689db614fdb", category: "major_security_incident" },
  { name: "Houthi Red Sea blockade", title: "Houthis declare blockade on Saudi shipping in Bab el-Mandeb and Red Sea", terms: "Houthis blockade Saudi shipping Bab el-Mandeb Red Sea", article: "https://apnews.com/article/93dfe17125c63897b232f6461d81d85c", category: "geopolitics" },
  { name: "Hormuz tanker strike", title: "Projectile strikes tanker entering Strait of Hormuz, injuring two crew", terms: "projectile strikes tanker Strait of Hormuz crew injured", article: "https://apnews.com/article/82714681bde58c6525c2d7a1bc587b25", category: "major_security_incident" },
  { name: "Hormuz reopening offer", title: "Iran offers US deal to reopen Strait of Hormuz in seven days", terms: "Iran offers US deal reopen Strait of Hormuz seven days", article: "https://www.reuters.com/world/middle-east/iran-offers-reopen-hormuz-2026-09-26/", category: "geopolitics" },
  { name: "US-China trade truce", title: "Trump welcomes Xi to Washington as US, China agree to extend trade truce", terms: "US China extend trade truce Trump Xi Washington", article: "https://www.bloomberg.com/news/articles/2026-09-24/us-china-extend-trade-truce", category: "tariffs" },
  { name: "Major disaster", title: "Typhoon Dujuan hits Japan with deadly floods, travel chaos near Tokyo", terms: "Typhoon Dujuan Japan deadly floods Tokyo", article: "https://www3.nhk.or.jp/news/html/20260922/k10014900000000.html", category: "disaster" },
  { name: "Tariffs", title: "Canada strikes back with tariffs on about $20 billion worth of US goods", terms: "Canada retaliatory tariffs 20 billion US goods", article: "https://apnews.com/article/461f9e97f78983653c59408c0b55757a", category: "tariffs" },
  { name: "BOJ decision", title: "Bank of Japan raises benchmark interest rate to 1.25%", terms: "Bank of Japan raises interest rate 1.25%", article: "https://apnews.com/article/67e71246d3af41bcfc61aa788f9959c7", category: "boj" },
];

for (const event of REPLAY) {
  test(`replay: ${event.name} — headline -> verify -> specific search -> candidate`, async () => {
    const triage = (headlines: TriggerHeadline[]) => Promise.resolve({
      results: new Map([[headlines[0].id, { decision: "verify" as const, category: event.category, reason: "r", searchTerms: event.terms }]]),
      inputTokens: 900, outputTokens: 60,
    });
    // The verify step goes through the real breaking fetcher (request, visited-URL, host, freshness gates).
    const verify: VerifyRunner = (query, now) => fetchBreakingMarketQueryWithDiagnostics("k", query, now, (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.match(body.input, new RegExp(`search topic: ${event.terms.split(" ")[0]}`));
      assert.doesNotMatch(body.input, /site:/);
      return Promise.resolve(new Response(JSON.stringify({
        status: "completed",
        usage: { input_tokens: 11000, output_tokens: 260 },
        output: [
          { type: "web_search_call", action: { type: "search", query: body.input, sources: [{ url: event.article }] } },
          { type: "message", content: [{ type: "output_text", text: JSON.stringify({ candidates: [{
            title: event.title, summary: "s", source_url: event.article,
            published_at: "2026-09-26T03:20:00Z", event_at: null, category: event.category,
          }] }) }] },
        ],
      }), { status: 200 }));
    });
    const result = await runHeadlineTriggerLane({
      headlines: [headline(event.title, `https://www.aljazeera.com/news/${encodeURIComponent(event.name)}`)],
      feeds: {}, history: EMPTY_HISTORY, triage, verify, now: NOW,
    });
    assert.equal(result.candidates.length, 1, event.name);
    assert.equal(result.candidates[0].sourceType, "breaking_market");
    assert.equal(result.candidates[0].sourceUrl, event.article);
    assert.equal(result.diagnostics.items[0].candidateCreated, true);
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
