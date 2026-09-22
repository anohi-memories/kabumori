import assert from "node:assert/strict";
import test from "node:test";
import { estimateCostUsd } from "./shadow_logic.ts";
import {
  aggregateTargetedSearchUsage,
  createTargetedSearchDiagnostics,
  hasMeaningfulSearchUsage,
  recordTargetedSearchAttempt,
  recordTargetedSearchFailure,
  recordTargetedSearchSuccess,
  shouldAttemptTargetedSearch,
  summarizeTargetedSearchResponse,
  targetedSearchTelemetryColumns,
} from "./search_telemetry.ts";

test("classifies zero, one, and two web_search_call output items", () => {
  assert.equal(summarizeTargetedSearchResponse({ output: [] }).webSearchOutputItemCount, 0);
  assert.equal(
    summarizeTargetedSearchResponse({
      output: [{ type: "web_search_call", action: { type: "search" } }],
    }).webSearchOutputItemCount,
    1,
  );
  assert.equal(
    summarizeTargetedSearchResponse({
      output: [
        { type: "web_search_call", action: { type: "search" } },
        { type: "web_search_call", action: { type: "open_page" } },
      ],
    }).webSearchOutputItemCount,
    2,
  );
});

test("classifies all supported action types and unknown without retaining response content", () => {
  const raw = {
    id: "not-persisted",
    usage: { input_tokens: 13, output_tokens: 5 },
    output: [
      { type: "web_search_call", action: { type: "search", query: "private query" } },
      { type: "web_search_call", action: { type: "open_page", url: "https://example.test/private" } },
      { type: "web_search_call", action: { type: "find_in_page", pattern: "private headline" } },
      { type: "web_search_call", action: { type: "future_action" } },
      { type: "web_search_call" },
      { type: "message", content: "private raw response" },
    ],
  };
  const summary = summarizeTargetedSearchResponse(raw);
  assert.deepEqual(summary, {
    webSearchOutputItemCount: 5,
    webSearchActionSearchCount: 1,
    webSearchActionOpenPageCount: 1,
    webSearchActionFindInPageCount: 1,
    webSearchActionUnknownCount: 2,
    inputTokens: 13,
    outputTokens: 5,
  });
  const serialized = JSON.stringify({
    summary,
    columns: targetedSearchTelemetryColumns(createTargetedSearchDiagnostics()),
  });
  assert.equal(serialized.includes("private query"), false);
  assert.equal(serialized.includes("private headline"), false);
  assert.equal(serialized.includes("private raw response"), false);
  assert.equal(serialized.includes("example.test"), false);
});

test("a successful eligible search with meaningful usage prevents a second request", () => {
  const diagnostics = createTargetedSearchDiagnostics();
  let paidSearchUsed = false;
  assert.equal(shouldAttemptTargetedSearch(paidSearchUsed, true), true);
  recordTargetedSearchAttempt(diagnostics);
  const summary = summarizeTargetedSearchResponse({
    usage: { input_tokens: 12, output_tokens: 2 },
    output: [{ type: "web_search_call", action: { type: "search" } }],
  });
  recordTargetedSearchSuccess(diagnostics, summary);
  paidSearchUsed = hasMeaningfulSearchUsage({
    inputTokens: summary.inputTokens,
    webSearchCalls: summary.webSearchOutputItemCount,
  });
  assert.equal(shouldAttemptTargetedSearch(paidSearchUsed, true), false);
  assert.deepEqual(
    targetedSearchTelemetryColumns(diagnostics),
    {
      targeted_search_attempt_count: 1,
      targeted_search_success_count: 1,
      targeted_search_failure_count: 0,
      web_search_output_item_count: 1,
      web_search_action_search_count: 1,
      web_search_action_open_page_count: 0,
      web_search_action_find_in_page_count: 0,
      web_search_action_unknown_count: 0,
    },
  );
});

test("a failed first request leaves retry behavior intact and counts both attempts", () => {
  const diagnostics = createTargetedSearchDiagnostics();
  let paidSearchUsed = false;
  assert.equal(shouldAttemptTargetedSearch(paidSearchUsed, true), true);
  recordTargetedSearchAttempt(diagnostics);
  recordTargetedSearchFailure(diagnostics);
  assert.equal(shouldAttemptTargetedSearch(paidSearchUsed, true), true);

  recordTargetedSearchAttempt(diagnostics);
  const summary = summarizeTargetedSearchResponse({
    usage: { input_tokens: 19, output_tokens: 3 },
    output: [{ type: "web_search_call", action: { type: "find_in_page" } }],
  });
  recordTargetedSearchSuccess(diagnostics, summary);
  paidSearchUsed = hasMeaningfulSearchUsage({
    inputTokens: summary.inputTokens,
    webSearchCalls: summary.webSearchOutputItemCount,
  });

  assert.equal(shouldAttemptTargetedSearch(paidSearchUsed, true), false);
  assert.deepEqual(
    targetedSearchTelemetryColumns(diagnostics),
    {
      targeted_search_attempt_count: 2,
      targeted_search_success_count: 1,
      targeted_search_failure_count: 1,
      web_search_output_item_count: 1,
      web_search_action_search_count: 0,
      web_search_action_open_page_count: 0,
      web_search_action_find_in_page_count: 1,
      web_search_action_unknown_count: 0,
    },
  );
});

test("aggregates tokens, calls, cost, and diagnostics across two successful responses when the first leaves the latch open", () => {
  const diagnostics = createTargetedSearchDiagnostics();
  let usage = { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, costUsd: 0 };
  let paidSearchUsed = false;
  let requestCount = 0;

  const firstRaw = {
    usage: { input_tokens: 0, output_tokens: 80 },
    output: [{ type: "message", content: "not retained" }],
  };
  if (shouldAttemptTargetedSearch(paidSearchUsed, true)) {
    requestCount += 1;
    recordTargetedSearchAttempt(diagnostics);
    const summary = summarizeTargetedSearchResponse(firstRaw);
    recordTargetedSearchSuccess(diagnostics, summary);
    const responseUsage = {
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      webSearchCalls: summary.webSearchOutputItemCount,
      costUsd: estimateCostUsd(
        summary.inputTokens,
        summary.outputTokens,
        summary.webSearchOutputItemCount,
      ),
    };
    usage = aggregateTargetedSearchUsage(usage, responseUsage);
    paidSearchUsed = hasMeaningfulSearchUsage(responseUsage);
  }

  assert.equal(paidSearchUsed, false);
  assert.equal(shouldAttemptTargetedSearch(paidSearchUsed, true), true);

  const secondRaw = {
    usage: { input_tokens: 20, output_tokens: 35 },
    output: [
      { type: "web_search_call", action: { type: "search" } },
      { type: "web_search_call", action: { type: "open_page" } },
    ],
  };
  if (shouldAttemptTargetedSearch(paidSearchUsed, true)) {
    requestCount += 1;
    recordTargetedSearchAttempt(diagnostics);
    const summary = summarizeTargetedSearchResponse(secondRaw);
    recordTargetedSearchSuccess(diagnostics, summary);
    const responseUsage = {
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      webSearchCalls: summary.webSearchOutputItemCount,
      costUsd: estimateCostUsd(
        summary.inputTokens,
        summary.outputTokens,
        summary.webSearchOutputItemCount,
      ),
    };
    usage = aggregateTargetedSearchUsage(usage, responseUsage);
    paidSearchUsed = hasMeaningfulSearchUsage(responseUsage);
  }

  assert.equal(requestCount, 2);
  assert.deepEqual(usage, {
    inputTokens: 20,
    outputTokens: 115,
    webSearchCalls: 2,
    costUsd: Number((
      estimateCostUsd(0, 80, 0) + estimateCostUsd(20, 35, 2)
    ).toFixed(8)),
  });
  assert.equal(diagnostics.targetedSearchSuccessCount, 2);
  assert.equal(diagnostics.targetedSearchAttemptCount, 2);
  assert.equal(diagnostics.targetedSearchFailureCount, 0);
  assert.equal(diagnostics.webSearchOutputItemCount, 2);
  assert.equal(diagnostics.webSearchActionSearchCount, 1);
  assert.equal(diagnostics.webSearchActionOpenPageCount, 1);
  assert.equal(diagnostics.webSearchActionFindInPageCount, 0);
  assert.equal(diagnostics.webSearchActionUnknownCount, 0);
});

test("legacy paid-search latch still depends only on search items or input tokens", () => {
  assert.equal(hasMeaningfulSearchUsage({ webSearchCalls: 0, inputTokens: 0 }), false);
  assert.equal(hasMeaningfulSearchUsage({ webSearchCalls: 0, inputTokens: 1 }), true);
  assert.equal(hasMeaningfulSearchUsage({ webSearchCalls: 1, inputTokens: 0 }), true);
});
