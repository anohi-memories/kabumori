import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateCostUsd,
  summarizeUsage,
  supabaseUsageWriter,
  usageEvent,
  usageFromResponse,
  WEB_SEARCH_CALL_USD,
} from "./usage_ledger.ts";
import {
  breakingSearchUsageEvents,
  judgementUsageEvents,
  meteredAppCopyRequester,
  meteredGenerationRunner,
} from "./usage_metering.ts";
import {
  type BreakingMarketQuery,
  type BreakingMarketQueryDiagnostics,
  fetchBreakingMarketQueryWithDiagnostics,
} from "./breaking_market_source_fetchers.ts";
import { buildCollectionRunDiagnostics } from "./news_collection_diagnostics.ts";
import type { FinalJudgement, ModelJudgement } from "./importance_judgement_logic.ts";
import type { GenerationCandidate } from "./post_generation_logic.ts";

test("cost estimate: Luna, Sol and web_search tool calls", () => {
  assert.equal(estimateCostUsd("gpt-5.6-luna", 1_000_000, 1_000_000), 1.4);
  assert.equal(estimateCostUsd("gpt-5.6-sol", 1_000_000, 1_000_000), 24);
  assert.equal(WEB_SEARCH_CALL_USD, 0.01);
  // A typical breaking_market call: ~12k input, ~700 output, 1 search.
  assert.equal(estimateCostUsd("gpt-5.6-luna", 12_000, 700, 1), 0.01324);
  assert.equal(estimateCostUsd("gpt-5.6-luna", -5, Number.NaN, -1), 0);
});

test("usage is read from a raw Responses payload", () => {
  assert.deepEqual(usageFromResponse({ usage: { input_tokens: 12034, output_tokens: 655 } }), { inputTokens: 12034, outputTokens: 655 });
  assert.deepEqual(usageFromResponse({}), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(usageFromResponse(null), { inputTokens: 0, outputTokens: 0 });
});

test("usage events carry an optional detail and a summary adds them up", () => {
  const a = usageEvent({ feature: "news_judgement_sol", detail: "LOW_CONFIDENCE", model: "gpt-5.6-sol", inputTokens: 5000, outputTokens: 500, relatedTable: "important_news_candidates", relatedId: "c1" });
  const b = usageEvent({ feature: "news_breaking_search", detail: "critical_market_events", model: "gpt-5.6-luna", inputTokens: 12000, outputTokens: 700, webSearchCalls: 1 });
  assert.equal(a.feature, "news_judgement_sol|LOW_CONFIDENCE");
  assert.equal(a.costUsd, 0.03);
  assert.deepEqual(summarizeUsage([a, b]), { calls: 2, inputTokens: 17000, outputTokens: 1200, webSearchCalls: 1, estimatedCostUsd: 0.04324 });
});

test("the writer posts one ai_usage_events row per event and never throws", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const ok: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 201 });
  };
  const event = usageEvent({ feature: "news_generation_draft", model: "gpt-5.6-luna", inputTokens: 8000, outputTokens: 700, relatedTable: "important_news_candidates", relatedId: "c1" });
  await supabaseUsageWriter("https://p.supabase.co", "service-key", ok)([event]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://p.supabase.co/rest/v1/ai_usage_events");
  assert.deepEqual(calls[0].body, [{
    feature: "news_generation_draft", model: "gpt-5.6-luna", input_tokens: 8000, output_tokens: 700,
    web_search_calls: 0, cost_usd: 0.00244, related_table: "important_news_candidates", related_id: "c1",
  }]);

  await supabaseUsageWriter("https://p.supabase.co", "k", ok)([]);
  assert.equal(calls.length, 1, "no request for an empty batch");

  const failing: typeof fetch = async () => { throw new Error("network"); };
  await supabaseUsageWriter("https://p.supabase.co", "k", failing)([event]);
  const rejected: typeof fetch = async () => new Response("{}", { status: 500 });
  await supabaseUsageWriter("https://p.supabase.co", "k", rejected)([event]);
});

const candidate = { id: "cand-1" } as GenerationCandidate;

test("each generation step is recorded against its candidate; the result is unchanged", async () => {
  const written: string[] = [];
  const runner = meteredGenerationRunner(
    async (step) => ({ payload: { step }, model: "gpt-5.6-luna", inputTokens: 100, outputTokens: 10, estimatedCost: 0 }),
    async (events) => { for (const event of events) written.push(`${event.feature}:${event.relatedId}`); },
  );
  for (const step of ["draft", "fact", "fact_retry", "voice", "voice_retry"] as const) {
    const result = await runner(step, candidate);
    assert.deepEqual(result.payload, { step });
  }
  assert.deepEqual(written, [
    "news_generation_draft:cand-1", "news_generation_fact:cand-1", "news_generation_fact_retry:cand-1",
    "news_generation_voice:cand-1", "news_generation_voice_retry:cand-1",
  ]);
});

test("app-copy draft and Fact calls are recorded", async () => {
  const written: string[] = [];
  const requester = meteredAppCopyRequester(
    async () => ({ payload: {}, inputTokens: 3000, outputTokens: 400 }),
    async (events) => { for (const event of events) written.push(`${event.feature}:${event.relatedId}:${event.costUsd}`); },
    "cand-2",
  );
  await requester("draft", {});
  await requester("fact", {});
  assert.deepEqual(written, ["news_app_copy_draft:cand-2:0.00108", "news_app_copy_fact:cand-2:0.00108"]);
});

function modelJudgement(model: "gpt-5.6-luna" | "gpt-5.6-sol", input: number, output: number): ModelJudgement {
  return {
    importance: "important", category: "earnings_revision_up", affectedEntities: [], japanMarketRelevance: "high",
    reason: "r", confidence: 0.9, needsSol: false, factCheckStatus: "passed", model,
    inputTokens: input, outputTokens: output, estimatedCost: 0,
  } as ModelJudgement;
}

test("judgement: one Luna row, plus a Sol row carrying the escalation reasons", () => {
  const lunaOnly = judgementUsageEvents({
    luna: modelJudgement("gpt-5.6-luna", 2300, 180), sol: null, escalationReasons: [],
  } as unknown as FinalJudgement, "c3");
  assert.deepEqual(lunaOnly.map((event) => event.feature), ["news_judgement_luna"]);

  const withSol = judgementUsageEvents({
    luna: modelJudgement("gpt-5.6-luna", 2300, 180),
    sol: modelJudgement("gpt-5.6-sol", 3400, 380),
    escalationReasons: ["LOW_CONFIDENCE", "FACT_NEEDS_REVIEW"],
  } as unknown as FinalJudgement, "c3");
  assert.deepEqual(withSol.map((event) => event.feature), ["news_judgement_luna", "news_judgement_sol|LOW_CONFIDENCE+FACT_NEEDS_REVIEW"]);
  assert.equal(withSol[1].costUsd, 0.0212);
  assert.equal(withSol[1].model, "gpt-5.6-sol");
});

function queryDiagnostic(overrides: Partial<BreakingMarketQueryDiagnostics>): BreakingMarketQueryDiagnostics {
  return {
    queryKey: "critical_market_events", query: "q", providerStatus: "succeeded", httpStatus: 200, responseStatus: "completed",
    incompleteReason: null, webSearchCallCount: 1, inputTokens: 12000, outputTokens: 700, estimatedCostUsd: 0.01324,
    model: "gpt-5.6-luna", rawCandidateCount: 0, validatedCandidateCount: 0, rejectionCounts: {} as never, failureCode: null,
    ...overrides,
  };
}

test("breaking search rows: one per billed query, none for a 429 that never reached the model", () => {
  const events = breakingSearchUsageEvents([
    queryDiagnostic({}),
    queryDiagnostic({ queryKey: "japan_security_emergency", webSearchCallCount: 2, inputTokens: 20000 }),
    queryDiagnostic({ queryKey: "disaster_infrastructure", providerStatus: "failed", httpStatus: 429, webSearchCallCount: 0, inputTokens: 0, outputTokens: 0 }),
  ], "run-1");
  assert.deepEqual(events.map((event) => [event.feature, event.webSearchCalls, event.relatedTable, event.relatedId]), [
    ["news_breaking_search|critical_market_events", 1, "important_news_monitor_runs", "run-1"],
    ["news_breaking_search|japan_security_emergency", 2, "important_news_monitor_runs", "run-1"],
  ]);
});

test("the breaking fetcher records billed tokens and cost from the response", async () => {
  const query = { key: "critical_market_events", searchQuery: "q", defaultCategory: "rates", defaultTopicKey: "breaking:x" } as BreakingMarketQuery;
  const raw = {
    status: "completed",
    usage: { input_tokens: 11800, output_tokens: 640 },
    output: [
      { type: "web_search_call", action: { sources: [] } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ candidates: [] }) }] },
    ],
  };
  const result = await fetchBreakingMarketQueryWithDiagnostics(
    "test-key", query, new Date("2026-09-19T01:00:00Z"),
    () => Promise.resolve(new Response(JSON.stringify(raw), { status: 200 })),
  );
  assert.equal(result.diagnostics.webSearchCallCount, 1);
  assert.equal(result.diagnostics.inputTokens, 11800);
  assert.equal(result.diagnostics.outputTokens, 640);
  assert.equal(result.diagnostics.estimatedCostUsd, 0.013128);
  assert.equal(result.diagnostics.model, "gpt-5.6-luna");
});

test("the run diagnostics carry a per-cycle breaking cost summary", () => {
  const diagnostics = buildCollectionRunDiagnostics({
    marketMacroProviders: [],
    breakingMarketQueries: [
      queryDiagnostic({}),
      queryDiagnostic({ queryKey: "b", webSearchCallCount: 1, inputTokens: 10000, outputTokens: 500, estimatedCostUsd: 0.0126 }),
      queryDiagnostic({ queryKey: "c", providerStatus: "failed", webSearchCallCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }),
    ],
  });
  assert.equal(diagnostics.version, 1);
  assert.deepEqual(diagnostics.cost.breakingMarket, {
    queries: 3, webSearchCalls: 2, inputTokens: 22000, outputTokens: 1200, estimatedCostUsd: 0.02584,
  });
});
