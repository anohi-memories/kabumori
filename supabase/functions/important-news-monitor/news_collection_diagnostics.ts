export type MarketMacroProviderRunDiagnostic = {
  sourceKey: string;
  providerStatus: "succeeded" | "failed";
  candidateCount: number;
  failureCode: string | null;
};

export type BreakingMarketQueryRunDiagnostic = {
  queryKey: string;
  providerStatus: "succeeded" | "failed";
  rawCandidateCount: number;
  validatedCandidateCount: number;
  rejectionCounts: Record<string, number>;
  failureCode: string | null;
  webSearchCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
};

const n = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Bounded, secret-free per-run diagnostics; zeroes remain queryable across runs to derive consecutive streaks. */
export type HeadlineTriggerRunDiagnostic = {
  /** The lane's own record (feeds, counts, triaged items); also the next runs' dedupe history. */
  lane: unknown;
  triage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null;
  verify: Array<{ webSearchCallCount?: number; inputTokens?: number; outputTokens?: number; estimatedCostUsd?: number }>;
};

export function buildCollectionRunDiagnostics(input: {
  marketMacroProviders: MarketMacroProviderRunDiagnostic[];
  breakingMarketQueries: BreakingMarketQueryRunDiagnostic[];
  headlineTrigger?: HeadlineTriggerRunDiagnostic;
}) {
  const marketMacroProviders = input.marketMacroProviders.map((item) => ({ ...item }));
  const breakingMarketQueries = input.breakingMarketQueries.map((item) => ({
    ...item,
    rejectionCounts: { ...item.rejectionCounts },
  }));
  const cost = {
    breakingMarket: {
      queries: breakingMarketQueries.length,
      webSearchCalls: breakingMarketQueries.reduce((sum, item) => sum + n(item.webSearchCallCount), 0),
      inputTokens: breakingMarketQueries.reduce((sum, item) => sum + n(item.inputTokens), 0),
      outputTokens: breakingMarketQueries.reduce((sum, item) => sum + n(item.outputTokens), 0),
      estimatedCostUsd: Number(
        breakingMarketQueries.reduce((sum, item) => sum + n(item.estimatedCostUsd), 0).toFixed(6),
      ),
    },
  };
  const trigger = input.headlineTrigger;
  const headlineTriggerCost = trigger
    ? {
      triageCalls: trigger.triage ? 1 : 0,
      verifySearches: trigger.verify.length,
      webSearchCalls: trigger.verify.reduce((sum, item) => sum + n(item.webSearchCallCount), 0),
      inputTokens: n(trigger.triage?.inputTokens) + trigger.verify.reduce((sum, item) => sum + n(item.inputTokens), 0),
      outputTokens: n(trigger.triage?.outputTokens) + trigger.verify.reduce((sum, item) => sum + n(item.outputTokens), 0),
      estimatedCostUsd: Number((n(trigger.triage?.estimatedCostUsd) +
        trigger.verify.reduce((sum, item) => sum + n(item.estimatedCostUsd), 0)).toFixed(6)),
    }
    : null;
  return {
    version: 1,
    // Additive (cost optimisation Phase 0); readers of version 1 keep working.
    cost: headlineTriggerCost ? { ...cost, headlineTrigger: headlineTriggerCost } : cost,
    ...(trigger ? { triggerLane: trigger.lane } : {}),
    marketMacro: {
      providers: marketMacroProviders,
      zeroResultCount: marketMacroProviders.filter((item) =>
        item.providerStatus === "succeeded" && item.candidateCount === 0
      ).length,
    },
    breakingMarket: {
      queries: breakingMarketQueries,
      zeroResultCount: breakingMarketQueries.filter((item) =>
        item.providerStatus === "succeeded" && item.rawCandidateCount === 0
      ).length,
    },
  };
}
