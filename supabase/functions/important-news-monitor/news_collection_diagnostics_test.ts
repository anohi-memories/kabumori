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
    drops: {},
  };
  const out = (buildCollectionRunDiagnostics({ ...BASE, jpOfficial: hostile }) as unknown as {
    jpOfficial: Record<string, unknown> & { skipped: Record<string, number> };
  }).jpOfficial;
  assert.deepEqual([out.signalsRead, out.selected, out.alreadyKnown, out.inserted, out.deferred, out.enrichedPages], [0, 0, 1, 0, 0, 3]);
  assert.deepEqual(out.skipped, { other: 5, ok_reason: 2 });
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /https?:|token|secret/iu);
});

const reasonsOf = (input: Record<string, number>) =>
  (buildCollectionRunDiagnostics({ ...BASE, jpOfficial: { ...JP, drops: input } }) as unknown as {
    jpOfficial: { drops: Record<string, number> };
  }).jpOfficial.drops;

test("J1-a: never more than 40 reason keys including 'other'; no count is lost; deterministic regardless of order", () => {
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`reason_${String(index).padStart(3, "0")}`, index + 1]));
  const out = reasonsOf(many);
  assert.equal(Object.keys(out).length, 40);
  assert.ok("other" in out);
  assert.equal(Object.values(out).reduce((a, b) => a + b, 0), 100 * 101 / 2);
  // the 39 largest are kept by name
  assert.equal(out.reason_099, 100);
  assert.equal("reason_000" in out, false);
  const reversed = Object.fromEntries(Object.entries(many).reverse());
  assert.deepEqual(reasonsOf(reversed), out);
});

test("J1-a: exactly 40 valid keys stay as they are; 41 fold the smallest into 'other'", () => {
  const forty = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`r_${index}`, 1]));
  const keepAll = reasonsOf(forty);
  assert.equal(Object.keys(keepAll).length, 40);
  assert.equal("other" in keepAll, false);
  const fortyOne = { ...forty, r_40: 1 };
  const folded = reasonsOf(fortyOne);
  assert.equal(Object.keys(folded).length, 40);
  assert.equal(folded.other, 2);
});

test("J1-a: malformed keys, a literal 'other', and 40 valid keys together still stay within 40 keys", () => {
  const forty = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`r_${index}`, 5]));
  const out = reasonsOf({ ...forty, "Bad Key": 3, other: 4, ["x".repeat(65)]: 2 });
  assert.equal(Object.keys(out).length, 40);
  assert.equal(Object.values(out).reduce((a, b) => a + b, 0), 40 * 5 + 3 + 4 + 2);
  assert.ok(out.other >= 9);
});

test("J1-a: counts saturate at 1,000,000 (documented), per key and in sums", () => {
  const out = reasonsOf({ big_a: 5_000_000, big_b: 900_000, "Bad 1": 900_000, "Bad 2": 900_000 });
  assert.equal(out.big_a, 1_000_000);
  assert.equal(out.big_b, 900_000);
  assert.equal(out.other, 1_000_000, "folded sum saturates instead of exceeding the cap");
  for (const value of Object.values(out)) assert.ok(Number.isInteger(value) && value >= 0 && value <= 1_000_000);
});

test("J1-a: fixed fields and the rest of the document are unchanged by the aggregation fix", () => {
  const diagnostics = buildCollectionRunDiagnostics({ ...BASE, jpOfficial: JP }) as unknown as { jpOfficial: unknown; version: number };
  assert.deepEqual(diagnostics.jpOfficial, JP);
  assert.equal(diagnostics.version, 1);
});

test("J1-a: the document survives JSON round trip", () => {
  const diagnostics = buildCollectionRunDiagnostics({ ...BASE, jpOfficial: JP });
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostics)), diagnostics);
});
