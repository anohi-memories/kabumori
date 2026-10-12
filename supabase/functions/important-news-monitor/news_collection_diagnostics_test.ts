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

// ---- J1-a: jp_official diagnostics are persisted additively -------------------------------------------------------

const BASE = { marketMacroProviders: [], breakingMarketQueries: [] };
const JP = {
  enabled: true, signalsRead: 120, selected: 9, alreadyKnown: 2, inserted: 6, deferred: 1, enrichedPages: 7,
  skipped: { no_body: 1, enrich_temporary_http_error: 2 },
  drops: { no_matching_theme: 80, routine: 20, stale: 11 },
};

test("J1-a: jpOfficial counters are stored under their own key and nothing else in the document changes", () => {
  const without = buildCollectionRunDiagnostics(BASE);
  const withJp = buildCollectionRunDiagnostics({ ...BASE, jpOfficial: JP });
  assert.equal("jpOfficial" in without, false, "absent input -> absent key (readers of version 1 are unaffected)");
  const { jpOfficial, ...rest } = withJp as typeof withJp & { jpOfficial: unknown };
  assert.deepEqual(rest, without);
  assert.deepEqual(jpOfficial, JP);
  assert.equal(withJp.version, 1);
});

test("J1-a: disabled / unset lane is recorded as enabled=false with zero counters", () => {
  const diagnostics = buildCollectionRunDiagnostics({
    ...BASE,
    jpOfficial: { enabled: false, signalsRead: 0, selected: 0, alreadyKnown: 0, inserted: 0, deferred: 0, enrichedPages: 0, skipped: {}, drops: {} },
  }) as { jpOfficial: { enabled: boolean; signalsRead: number; skipped: Record<string, number> } };
  assert.equal(diagnostics.jpOfficial.enabled, false);
  assert.equal(diagnostics.jpOfficial.signalsRead, 0);
  assert.deepEqual(diagnostics.jpOfficial.skipped, {});
});

test("J1-a: only counters are kept — hostile keys / values cannot leak text or grow the JSON", () => {
  const hostile = {
    enabled: true, signalsRead: Number.NaN, selected: -5, alreadyKnown: 1.9, inserted: Infinity, deferred: "7" as unknown as number,
    enrichedPages: 3,
    skipped: { "https://example.test/secret?token=abc": 4, ok_reason: 2, "Bad Key With Spaces": 1 },
    drops: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`reason_${index}`, 1])),
  };
  const out = (buildCollectionRunDiagnostics({ ...BASE, jpOfficial: hostile }) as unknown as {
    jpOfficial: Record<string, unknown> & { skipped: Record<string, number>; drops: Record<string, number> };
  }).jpOfficial;
  assert.deepEqual([out.signalsRead, out.selected, out.alreadyKnown, out.inserted, out.deferred, out.enrichedPages], [0, 0, 1, 0, 0, 3]);
  assert.deepEqual(out.skipped, { other: 5, ok_reason: 2 });
  assert.ok(Object.keys(out.drops).length <= 41);
  assert.equal(Object.values(out.drops).reduce((a, b) => a + b, 0), 100, "no count is lost, only folded into other");
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /https?:|token|secret/iu);
  assert.ok(json.length < 2_000);
});

test("J1-a: the document survives JSON round trip", () => {
  const diagnostics = buildCollectionRunDiagnostics({ ...BASE, jpOfficial: JP });
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostics)), diagnostics);
});
