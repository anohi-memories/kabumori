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
};

/** Bounded, secret-free per-run diagnostics; zeroes remain queryable across runs to derive consecutive streaks. */
export function buildCollectionRunDiagnostics(input: {
  marketMacroProviders: MarketMacroProviderRunDiagnostic[];
  breakingMarketQueries: BreakingMarketQueryRunDiagnostic[];
}) {
  const marketMacroProviders = input.marketMacroProviders.map((item) => ({ ...item }));
  const breakingMarketQueries = input.breakingMarketQueries.map((item) => ({
    ...item,
    rejectionCounts: { ...item.rejectionCounts },
  }));
  return {
    version: 1,
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
