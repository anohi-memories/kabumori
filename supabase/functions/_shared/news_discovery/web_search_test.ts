import assert from "node:assert/strict";
import test from "node:test";
import { buildAliasIndex } from "./company_alias.ts";
import { HostRateGate } from "./fetcher.ts";
import { DiscoveryRun, signalUrlKey } from "./pipeline.ts";
import { SEARCH_BUDGET_DEFAULTS, SEARCH_LANES, type SearchLane } from "./search_config.ts";
import { publisherRestriction, sourceById } from "./source_registry.ts";
import { InMemoryNewsSignalStore } from "./store.ts";
import type { NewsSignal } from "./types.ts";
import {
  budgetDay,
  executeSearchStage,
  InMemorySearchBudget,
  OpenAiWebSearchProvider,
  openAiSearchRequestBody,
  parseOpenAiSearchResponse,
  planSearches,
  type ProviderResult,
  type SearchRequest,
  type WebSearchProvider,
} from "./web_search.ts";

const NOW = new Date("2026-09-28T06:00:00Z");

function openAiResponse(items: Array<{ url: string; title: string; publisher?: string | null }>, sources: string[], cited: string[] = []) {
  return {
    status: "completed",
    output: [
      { type: "web_search_call", status: "completed", action: { type: "search", sources: sources.map((url) => ({ type: "url", url })) } },
      {
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({ items: items.map((i) => ({ publisher: null, ...i })) }),
          annotations: cited.map((url) => ({ type: "url_citation", url })),
        }],
      },
    ],
    usage: { input_tokens: 9000, output_tokens: 400 },
  };
}

class MockProvider implements WebSearchProvider {
  readonly name = "mock";
  readonly model = "mock-model";
  calls: Array<{ query: string; lane: SearchLane }> = [];
  constructor(private readonly respond: (query: string, lane: SearchLane) => ProviderResult) {}
  search(input: { query: string; lane: SearchLane }): Promise<ProviderResult> {
    this.calls.push({ query: input.query, lane: input.lane });
    return Promise.resolve(this.respond(input.query, input.lane));
  }
}

const usage = { model_calls: 1, web_search_calls: 1, input_tokens: 9000, output_tokens: 400 };
const ok = (results: Array<{ url: string; title: string; publisher?: string | null }>): ProviderResult => ({
  ok: true,
  results: results.map((r) => ({ publisher: null, ...r })),
  rejected_unverified: 0,
  usage,
});

async function startRun(store = new InMemoryNewsSignalStore(signalUrlKey)) {
  return await DiscoveryRun.start({
    sources: [],
    store,
    aliasIndex: buildAliasIndex([{ ticker_code: "7203", company_name: "トヨタ自動車" }]),
    gate: new HostRateGate(() => 0, () => Promise.resolve()),
    now: () => NOW,
  });
}

const rotation = (lane: SearchLane): SearchRequest => ({
  lane, reason: "scheduled_rotation", query: SEARCH_LANES[lane].query, search_key: `rotation:${lane}`, triggered_by: null, parent_search_id: null,
});

// ---------------------------------------------------------------------------------------- provider

test("request body: one web_search call, sources included, no_access excluded without a publisher allowlist", () => {
  const body = openAiSearchRequestBody({ query: SEARCH_LANES.ENERGY.query, lane: "ENERGY", maxResults: 8, recencyHours: 6, now: NOW });
  assert.equal(body.max_tool_calls, 1);
  assert.deepEqual(body.include, ["web_search_call.action.sources"]);
  const [tool] = body.tools as Array<{ type: string; search_context_size: string; filters: { blocked_domains: string[]; allowed_domains?: string[] } }>;
  assert.equal(tool.type, "web_search");
  assert.equal(tool.search_context_size, "low");
  assert.ok(tool.filters.blocked_domains.includes("ft.com"));
  assert.ok(tool.filters.blocked_domains.includes("aljazeera.com"));
  assert.ok(tool.filters.blocked_domains.includes("diamond.jp"));
  assert.ok(!tool.filters.blocked_domains.includes("nhk.or.jp"));
  assert.equal(tool.filters.allowed_domains, undefined);
  assert.equal(body.store, false);
  assert.match(String(body.instructions), /Do not summarize, do not invent URLs/);
});

test("only URLs the search tool returned or cited are accepted", () => {
  const raw = openAiResponse(
    [
      { url: "https://news.example/a?utm_source=x", title: "Tanker struck near Hormuz" },
      { url: "https://invented.example/b", title: "Made-up story" },
      { url: "https://cited.example/c", title: "Cited story" },
    ],
    ["https://news.example/a"],
    ["https://cited.example/c"],
  );
  const parsed = parseOpenAiSearchResponse(raw)!;
  assert.deepEqual(parsed.results.map((r) => r.url), ["https://news.example/a", "https://cited.example/c"]);
  assert.equal(parsed.rejected_unverified, 1);
  assert.deepEqual(parsed.usage, { model_calls: 1, web_search_calls: 1, input_tokens: 9000, output_tokens: 400 });
  assert.equal(parseOpenAiSearchResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "not json" }] }] }), null);
});

test("provider failures are classified; no key means no request", async () => {
  let calls = 0;
  const fetchWith = (response: Response | Error) => () => {
    calls += 1;
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  };
  assert.equal((await new OpenAiWebSearchProvider(undefined, undefined, fetchWith(new Response("{}"))).search({ query: "q", lane: "WORLD", maxResults: 3, recencyHours: 6, now: NOW })).ok, false);
  assert.equal(calls, 0, "PROVIDER_NOT_CONFIGURED sends nothing");
  const run = (r: Response | Error) => new OpenAiWebSearchProvider("k", undefined, fetchWith(r)).search({ query: "q", lane: "WORLD", maxResults: 3, recencyHours: 6, now: NOW });
  const limited = await run(new Response("slow", { status: 429 }));
  assert.equal(!limited.ok && limited.code, "PROVIDER_RATE_LIMITED");
  const http = await run(new Response("x", { status: 500 }));
  assert.equal(!http.ok && http.code, "PROVIDER_HTTP_ERROR");
  const bad = await run(new Response("{\"output\":1}"));
  assert.equal(!bad.ok && bad.code, "PROVIDER_BAD_RESPONSE");
  const timeout = await run(new DOMException("t", "TimeoutError"));
  assert.equal(!timeout.ok && timeout.code, "PROVIDER_TIMEOUT");
  assert.equal(timeout.usage.model_calls, 1, "a timed-out call may have been billed: counted");
  const good = await run(new Response(JSON.stringify(openAiResponse([{ url: "https://n.example/a", title: "t" }], ["https://n.example/a"]))));
  assert.equal(good.ok && good.results.length, 1);
});

// ---------------------------------------------------------------------------------------- budget

test("budget: hard cap stops every reason; soft budget stops rotation only", async () => {
  const config = { ...SEARCH_BUDGET_DEFAULTS, daily_soft_budget: 2, daily_hard_limit: 3 };
  let clock = NOW.getTime();
  const budget = new InMemorySearchBudget(config, () => new Date(clock));
  const reserve = (r: SearchRequest) => budget.reserve({ ...r, run_id: "run", provider: "mock", model: "m" });
  assert.equal((await reserve(rotation("WORLD"))).allowed, true);
  assert.equal((await reserve(rotation("MARKET"))).allowed, true);
  const soft = await reserve(rotation("ENERGY"));
  assert.deepEqual(soft.allowed ? null : soft.reason, "soft_budget");
  const trigger: SearchRequest = { lane: "ENERGY", reason: "trigger_market_anomaly", query: "q", search_key: "anomaly:WTI", triggered_by: "anomaly:WTI", parent_search_id: null };
  assert.equal((await reserve(trigger)).allowed, true, "triggers may pass the soft budget");
  const hard = await reserve({ ...trigger, search_key: "anomaly:VIX" });
  assert.deepEqual(hard.allowed ? null : hard.reason, "hard_cap");
  // Next JST day resets the count.
  clock = Date.parse("2026-09-28T15:30:00Z"); // 00:30 JST on 09-29
  assert.equal(budgetDay(new Date(clock)), "2026-09-29");
  assert.equal((await reserve({ ...trigger, search_key: "anomaly:GOLD" })).allowed, true);
});

test("budget: the same theme is not searched again within its cooldown; escalation once per key", async () => {
  let clock = NOW.getTime();
  const budget = new InMemorySearchBudget(SEARCH_BUDGET_DEFAULTS, () => new Date(clock));
  const reserve = (r: SearchRequest) => budget.reserve({ ...r, run_id: "run", provider: "mock", model: "m" });
  const first = await reserve(rotation("WORLD"));
  assert.equal(first.allowed, true);
  clock += 60 * 60_000;
  const again = await reserve(rotation("WORLD"));
  assert.deepEqual(again.allowed ? null : again.reason, "duplicate_search_key");
  clock += 6 * 60 * 60_000;
  assert.equal((await reserve(rotation("WORLD"))).allowed, true, "after the rotation interval");

  const trigger: SearchRequest = { lane: "WORLD", reason: "trigger_discovery_signal", query: "q", search_key: "signal:war:Iran", triggered_by: "x", parent_search_id: null };
  const t = await reserve(trigger);
  assert.ok(t.allowed);
  const escalation = { ...trigger, reason: "escalation" as const, parent_search_id: t.allowed ? t.search_id : null };
  assert.equal((await reserve(escalation)).allowed, true);
  const second = await reserve(escalation);
  assert.deepEqual(second.allowed ? null : second.reason, "escalation_limit");
  const orphan = await reserve({ ...escalation, search_key: "signal:war:Other" });
  assert.deepEqual(orphan.allowed ? null : orphan.reason, "bad_parent");
});

// ---------------------------------------------------------------------------------------- planning

function gdeltSignal(overrides: Partial<NewsSignal>): NewsSignal {
  return {
    id: "e".repeat(64), source_id: "gdelt_doc", source_type: "gdelt_doc_json", policy: "DISCOVERY_ONLY",
    source_url: "https://news.example/x", canonical_url: "https://news.example/x", external_id: null,
    title: "Missile strike reported near Iranian oil terminal", title_display_allowed: false, summary_hint: null,
    published_at: null, published_at_precision: null, updated_at: null, detected_at: NOW.toISOString(), fetched_at: NOW.toISOString(),
    language: "English", country: "INT", publisher: "news.example", topics: ["war", "geopolitics"],
    entities: [{ kind: "country_or_region", value: "Iran" }], ticker_candidates: [], image_url: null, image_source: null,
    image_usage_allowed: false, discovery_only: true, restricted_publisher: false, search_id: null, discovered_via: "gdelt:x",
    raw_reference: { feed_url: "x", item_index: 0 }, fingerprint: "e".repeat(64), title_fingerprint: "f".repeat(32),
    same_event_group: null, needs_verification: ["no_published_at", "discovery_only_needs_primary"], ...overrides,
  };
}

test("plan: triggers first (anomaly, discovery signal), then one lane rotation; lane queries only", () => {
  const plan = planSearches({
    now: NOW,
    anomalies: [{ instrument: "wti", change_pct: 6.2 }, { instrument: "SPX_WEEKLY" }],
    fresh: [gdeltSignal({})],
    context: [],
  });
  assert.deepEqual(plan.requests.map((r) => [r.reason, r.search_key]), [
    ["trigger_market_anomaly", "anomaly:WTI"],
    ["trigger_discovery_signal", "signal:war:Iran"],
    ["scheduled_rotation", plan.requests[2].search_key],
  ]);
  assert.match(plan.requests[2].search_key, /^rotation:(WORLD|MARKET|ENERGY|JAPAN|TECH)$/);
  assert.deepEqual(plan.skipped, [{ search_key: "anomaly:SPX_WEEKLY", reason: "unknown_instrument" }]);
  // Never "one company per search": no query is just a company name + "news".
  assert.ok(plan.requests.every((r) => !/^\S+ news$/i.test(r.query)));
});

test("plan: an anomaly already explained by a fresh official signal is not searched", () => {
  const plan = planSearches({
    now: NOW,
    anomalies: [{ instrument: "WTI" }],
    fresh: [],
    context: [{ id: "a", source_id: "us_eia_today_in_energy", title: "OPEC cut", fetched_at: NOW.toISOString(), topics: ["oil", "energy"], same_event_group: null, ticker_candidates: [] }],
    scheduled: false,
  });
  assert.deepEqual(plan.requests, []);
  assert.deepEqual(plan.skipped, [{ search_key: "anomaly:WTI", reason: "explained_by_pool" }]);
});

test("plan: per-run trigger limit is respected", () => {
  const plan = planSearches({
    now: NOW,
    anomalies: [{ instrument: "WTI" }, { instrument: "VIX" }, { instrument: "SOX" }],
    fresh: [],
    context: [],
    scheduled: false,
  });
  assert.equal(plan.requests.length, SEARCH_BUDGET_DEFAULTS.max_trigger_searches_per_run);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["per_run_limit"]);
});

// ---------------------------------------------------------------------------------------- execution

test("restricted publishers: no_access results dropped; no_direct_fetch kept as flagged leads", () => {
  assert.deepEqual(publisherRestriction("https://www.aljazeera.com/news/x"), { source_id: "al_jazeera", scope: "no_access" });
  assert.deepEqual(publisherRestriction("https://www3.nhk.or.jp/news/html/x.html"), { source_id: "nhk_news", scope: "no_direct_fetch" });
  assert.equal(publisherRestriction("https://www.federalreserve.gov/x"), null);
});

test("stage: search results become discovery-only signals; restricted handling; dedupe with official; stats", async () => {
  const store = new InMemoryNewsSignalStore(signalUrlKey);
  const run = await startRun(store);
  // An official signal already in this run with the same URL as one search result.
  const fed = sourceById("us_fed_press")!;
  await run.ingest(fed, [{
    title: "Federal Reserve issues statement on market functioning today", link: "https://www.federalreserve.gov/a.htm", external_id: null,
    summary: null, published_raw: "Sun, 28 Sep 2026 05:00:00 GMT", updated_raw: null, seen_raw: null, structured_ticker: null,
    image_url: null, publisher: null, language: null, country: null,
  }], { via: "feed:us_fed_press", feedUrl: fed.endpoint, fetchedAt: NOW.toISOString() });

  const provider = new MockProvider(() => ok([
    { url: "https://www.federalreserve.gov/a.htm", title: "Fed statement on markets" }, // duplicate of the official item
    { url: "https://www.aljazeera.com/news/1", title: "Strike on tanker in Red Sea" }, // no_access: dropped
    { url: "https://www3.nhk.or.jp/news/html/2.html", title: "トヨタ自動車 工場で火災 生産停止" }, // no_direct_fetch: flagged lead
    { url: "https://open.example/3", title: "Oil jumps after pipeline outage" },
  ]));
  const budget = new InMemorySearchBudget(SEARCH_BUDGET_DEFAULTS, () => NOW);
  const stats = await executeSearchStage({ run, runId: "run", plan: { requests: [rotation("ENERGY")], skipped: [] }, provider, budget });

  assert.equal(stats.executed, 1);
  assert.equal(stats.result_count, 4);
  assert.equal(stats.policy_blocked_count, 1);
  assert.equal(stats.restricted_count, 1);
  assert.equal(stats.duplicate_count, 1);
  assert.equal(stats.new_signal_count, 2);
  assert.equal(stats.useful_signal_count, 2);
  const searchSignals = run.kept.filter((s) => s.source_id === "web_search");
  assert.equal(searchSignals.length, 2);
  for (const signal of searchSignals) {
    assert.equal(signal.policy, "SEARCH_DISCOVERY");
    assert.equal(signal.discovery_only, true);
    assert.equal(signal.summary_hint, null);
    assert.equal(signal.image_url, null);
    assert.equal(signal.title_display_allowed, false);
    assert.equal(signal.published_at, null, "model-reported times are never stored as published_at");
    assert.equal(signal.detected_at, NOW.toISOString());
    assert.ok(signal.search_id);
    assert.match(signal.discovered_via, /^search:ENERGY:scheduled_rotation$/);
  }
  const nhk = searchSignals.find((s) => s.canonical_url.includes("nhk"))!;
  assert.equal(nhk.restricted_publisher, true);
  assert.ok(nhk.needs_verification.includes("restricted_publisher_needs_primary"));
  assert.deepEqual(nhk.ticker_candidates.map((c) => [c.ticker, c.status]), [["7203", "confirmed"]]);
  assert.ok(nhk.topics.includes("supply_chain"));
  const result = await run.finish();
  assert.equal(result.ai_calls, 1);
  assert.equal(result.web_search_calls, 1);
  assert.equal(budget.completions[0].useful_signal_count, 2);
});

test("stage: a trigger with nothing useful escalates exactly once; rotation never escalates", async () => {
  const run = await startRun();
  const provider = new MockProvider(() => ok([]));
  const budget = new InMemorySearchBudget(SEARCH_BUDGET_DEFAULTS, () => NOW);
  const trigger: SearchRequest = { lane: "ENERGY", reason: "trigger_market_anomaly", query: "why WTI", search_key: "anomaly:WTI", triggered_by: "anomaly:WTI", parent_search_id: null };
  const stats = await executeSearchStage({ run, runId: "run", plan: { requests: [trigger, rotation("TECH")], skipped: [] }, provider, budget });
  assert.deepEqual(provider.calls.map((c) => c.query), ["why WTI", SEARCH_LANES.TECH.query, SEARCH_LANES.ENERGY.fallback_query]);
  assert.equal(stats.escalations, 1);
  assert.equal(stats.executed, 3);
});

test("stage: denied searches make no provider call; provider failures are recorded", async () => {
  const run = await startRun();
  const provider = new MockProvider(() => ({ ok: false, code: "PROVIDER_RATE_LIMITED", status: 429, usage: { model_calls: 0, web_search_calls: 0, input_tokens: 0, output_tokens: 0 } }));
  const budget = new InMemorySearchBudget({ ...SEARCH_BUDGET_DEFAULTS, daily_soft_budget: 0, daily_hard_limit: 1 }, () => NOW);
  const trigger: SearchRequest = { lane: "WORLD", reason: "trigger_discovery_signal", query: "q", search_key: "signal:war:x", triggered_by: "x", parent_search_id: null };
  const stats = await executeSearchStage({ run, runId: "run", plan: { requests: [rotation("WORLD"), trigger, { ...trigger, search_key: "signal:war:y" }], skipped: [] }, provider, budget });
  assert.deepEqual(stats.denied.map((d) => d.reason), ["soft_budget", "hard_cap"]);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(stats.failed, [{ search_key: "signal:war:x", code: "PROVIDER_RATE_LIMITED" }]);
  assert.equal(budget.completions[0].status, "failed");
});
