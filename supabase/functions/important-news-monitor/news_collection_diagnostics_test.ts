import assert from "node:assert/strict";
import test from "node:test";
import { buildCollectionRunDiagnostics } from "./news_collection_diagnostics.ts";

test("per-run diagnostics identify successful zero-result sources and keep failed sources distinct", () => {
  const diagnostics = buildCollectionRunDiagnostics({
    marketMacroProviders: [
      { sourceKey: "eia", providerStatus: "succeeded", candidateCount: 0, failureCode: null },
      { sourceKey: "fed", providerStatus: "failed", candidateCount: 0, failureCode: "FETCH_FAILED" },
    ],
    breakingMarketQueries: [
      { queryKey: "followups", providerStatus: "succeeded", rawCandidateCount: 0, validatedCandidateCount: 0, rejectionCounts: {}, failureCode: null },
      { queryKey: "critical", providerStatus: "succeeded", rawCandidateCount: 2, validatedCandidateCount: 1, rejectionCounts: { stale_published_at: 1 }, failureCode: null },
      { queryKey: "failed", providerStatus: "failed", rawCandidateCount: 0, validatedCandidateCount: 0, rejectionCounts: {}, failureCode: "SEARCH_FAILED" },
    ],
  });

  assert.equal(diagnostics.version, 1);
  assert.equal(diagnostics.marketMacro.zeroResultCount, 1);
  assert.equal(diagnostics.breakingMarket.zeroResultCount, 1);
  assert.equal(diagnostics.breakingMarket.queries[0].queryKey, "followups");
  assert.equal(diagnostics.breakingMarket.queries[2].failureCode, "SEARCH_FAILED");
});
