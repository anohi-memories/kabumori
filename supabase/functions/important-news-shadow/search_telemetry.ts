export type SearchOutputCounts = {
  webSearchOutputItemCount: number;
  webSearchActionSearchCount: number;
  webSearchActionOpenPageCount: number;
  webSearchActionFindInPageCount: number;
  webSearchActionUnknownCount: number;
};

export type TargetedSearchDiagnostics = {
  targetedSearchAttemptCount: number;
  targetedSearchSuccessCount: number;
  targetedSearchFailureCount: number;
} & SearchOutputCounts;

export type TargetedSearchResponseSummary = SearchOutputCounts & {
  inputTokens: number;
  outputTokens: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" ? Math.max(0, Math.floor(value)) : 0;
}

export function createTargetedSearchDiagnostics(): TargetedSearchDiagnostics {
  return {
    targetedSearchAttemptCount: 0,
    targetedSearchSuccessCount: 0,
    targetedSearchFailureCount: 0,
    webSearchOutputItemCount: 0,
    webSearchActionSearchCount: 0,
    webSearchActionOpenPageCount: 0,
    webSearchActionFindInPageCount: 0,
    webSearchActionUnknownCount: 0,
  };
}

/**
 * Counts Responses API output items with type "web_search_call".
 * This is the legacy web_search_calls meaning, not a request count or provider-billed unit.
 */
export function summarizeTargetedSearchResponse(
  raw: unknown,
): TargetedSearchResponseSummary {
  const root = isRecord(raw) ? raw : {};
  const usage = isRecord(root.usage) ? root.usage : {};
  const output = Array.isArray(root.output) ? root.output : [];
  const counts: SearchOutputCounts = {
    webSearchOutputItemCount: 0,
    webSearchActionSearchCount: 0,
    webSearchActionOpenPageCount: 0,
    webSearchActionFindInPageCount: 0,
    webSearchActionUnknownCount: 0,
  };

  for (const item of output) {
    if (!isRecord(item) || item.type !== "web_search_call") continue;
    counts.webSearchOutputItemCount += 1;
    const action = isRecord(item.action) ? item.action : {};
    switch (action.type) {
      case "search":
        counts.webSearchActionSearchCount += 1;
        break;
      case "open_page":
        counts.webSearchActionOpenPageCount += 1;
        break;
      case "find_in_page":
        counts.webSearchActionFindInPageCount += 1;
        break;
      default:
        counts.webSearchActionUnknownCount += 1;
    }
  }

  return {
    ...counts,
    inputTokens: nonNegativeInteger(usage.input_tokens),
    outputTokens: nonNegativeInteger(usage.output_tokens),
  };
}

export function recordTargetedSearchAttempt(
  diagnostics: TargetedSearchDiagnostics,
): void {
  diagnostics.targetedSearchAttemptCount += 1;
}

export function recordTargetedSearchFailure(
  diagnostics: TargetedSearchDiagnostics,
): void {
  diagnostics.targetedSearchFailureCount += 1;
}

export function recordTargetedSearchSuccess(
  diagnostics: TargetedSearchDiagnostics,
  summary: TargetedSearchResponseSummary,
): void {
  diagnostics.targetedSearchSuccessCount += 1;
  diagnostics.webSearchOutputItemCount += summary.webSearchOutputItemCount;
  diagnostics.webSearchActionSearchCount +=
    summary.webSearchActionSearchCount;
  diagnostics.webSearchActionOpenPageCount +=
    summary.webSearchActionOpenPageCount;
  diagnostics.webSearchActionFindInPageCount +=
    summary.webSearchActionFindInPageCount;
  diagnostics.webSearchActionUnknownCount +=
    summary.webSearchActionUnknownCount;
}

/** Preserve the existing paidSearchUsed latch: web-search items OR input tokens. */
export function hasMeaningfulSearchUsage(usage: {
  webSearchCalls: number;
  inputTokens: number;
}): boolean {
  return usage.webSearchCalls > 0 || usage.inputTokens > 0;
}

export function shouldAttemptTargetedSearch(
  paidSearchUsed: boolean,
  shouldSearch: boolean,
): boolean {
  return !paidSearchUsed && shouldSearch;
}

export function targetedSearchTelemetryColumns(
  diagnostics: TargetedSearchDiagnostics,
): Record<string, number> {
  return {
    targeted_search_attempt_count: diagnostics.targetedSearchAttemptCount,
    targeted_search_success_count: diagnostics.targetedSearchSuccessCount,
    targeted_search_failure_count: diagnostics.targetedSearchFailureCount,
    web_search_output_item_count: diagnostics.webSearchOutputItemCount,
    web_search_action_search_count:
      diagnostics.webSearchActionSearchCount,
    web_search_action_open_page_count:
      diagnostics.webSearchActionOpenPageCount,
    web_search_action_find_in_page_count:
      diagnostics.webSearchActionFindInPageCount,
    web_search_action_unknown_count:
      diagnostics.webSearchActionUnknownCount,
  };
}
