import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { groupImportantNewsCandidates } from "./important_news_grouping_logic.ts";
import {
  MAX_IMPORTANT_NEWS_LIGHTWEIGHT_CANDIDATES,
  MAX_IMPORTANT_NEWS_FETCH_GROUPS,
  MAX_IMPORTANT_NEWS_PDF_ENRICHMENTS,
  MAX_MARKET_MACRO_CANDIDATES_PER_FETCH,
  planImportantNewsCandidateBatch,
  planImportantNewsFetchGroups,
} from "./fetch_resource_limit_logic.ts";
import { prepareNewsCandidate, type IncomingNewsCandidate } from "./news_candidate_logic.ts";

const input = (sequence: number, overrides: Partial<IncomingNewsCandidate> = {}): IncomingNewsCandidate => ({
  sourceType: "tdnet",
  sourceUrl: `https://www.release.tdnet.info/inbs/${sequence}.pdf`,
  sourceName: "tdnet",
  title: `単独開示${sequence}`,
  bodySummary: null,
  companyName: `テスト${sequence}株式会社`,
  companyCode: String(1000 + sequence),
  entityKey: `company:${1000 + sequence}`,
  category: "other_corporate_ir",
  publishedAt: new Date(Date.parse("2026-08-31T06:00:00Z") + sequence * 60_000).toISOString(),
  ...overrides,
});

async function groups(values: IncomingNewsCandidate[]) {
  return groupImportantNewsCandidates(await Promise.all(values.map(prepareNewsCandidate)));
}

test("100 fetched candidates are all admitted to lightweight processing", () => {
  const candidates = Array.from({ length: 100 }, (_, index) => index + 1);
  const plan = planImportantNewsCandidateBatch(candidates);
  assert.equal(plan.fetchedCandidateCount, 100);
  assert.equal(plan.lightweightProcessedCount, MAX_IMPORTANT_NEWS_LIGHTWEIGHT_CANDIDATES);
  assert.equal(plan.deferredCandidateCount, 0);
  assert.deepEqual(plan.selectedCandidates, candidates);
});

test("101 fetched candidates process the first 100 and defer one without failure", () => {
  const candidates = Array.from({ length: 101 }, (_, index) => index + 1);
  const plan = planImportantNewsCandidateBatch(candidates);
  assert.equal(plan.lightweightProcessedCount, 100);
  assert.equal(plan.deferredCandidateCount, 1);
  assert.deepEqual(plan.selectedCandidates, candidates.slice(0, 100));
  assert.deepEqual(plan.deferredCandidates, [101]);
});

test("150 fetched candidates process the first 100 and defer 50 in existing order", () => {
  const candidates = Array.from({ length: 150 }, (_, index) => ({ id: index + 1 }));
  const plan = planImportantNewsCandidateBatch(candidates);
  assert.equal(plan.lightweightProcessedCount, 100);
  assert.equal(plan.deferredCandidateCount, 50);
  assert.deepEqual(plan.selectedCandidates, candidates.slice(0, 100));
  assert.deepEqual(plan.deferredCandidates, candidates.slice(100));
});

test("deferred candidates are untouched and remain eligible for the next fetch batch", () => {
  const candidates = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, status: "incoming" }));
  const first = planImportantNewsCandidateBatch(candidates);
  const next = planImportantNewsCandidateBatch(first.deferredCandidates);
  assert.deepEqual(first.deferredCandidates, [{ id: 101, status: "incoming" }]);
  assert.deepEqual(next.selectedCandidates, first.deferredCandidates);
  assert.equal(next.deferredCandidateCount, 0);
});

test("all groups within the fetch limits are selected", async () => {
  const plan = planImportantNewsFetchGroups(await groups([input(1), input(2)]));
  assert.equal(plan.selectedGroups.length, 2);
  assert.equal(plan.selectedCandidateCount, 2);
  assert.equal(plan.selectedPdfCount, 2);
  assert.equal(plan.deferredCandidateCount, 0);
});

test("groups beyond the PDF limit are deferred for a later fetch", async () => {
  const plan = planImportantNewsFetchGroups(await groups([input(1), input(2), input(3), input(4)]));
  assert.equal(plan.selectedGroups.length, MAX_IMPORTANT_NEWS_FETCH_GROUPS);
  assert.equal(plan.selectedPdfCount, MAX_IMPORTANT_NEWS_PDF_ENRICHMENTS);
  assert.equal(plan.deferredGroups.length, 1);
  assert.equal(plan.deferredCandidateCount, 1);
});

test("a multi-PDF event group is never split", async () => {
  const event = await groups([
    input(1, { companyCode: "1234", entityKey: "company:1234", category: "earnings", title: "決算短信" }),
    input(2, { companyCode: "1234", entityKey: "company:1234", category: "earnings_revision_up", title: "業績予想修正" }),
    input(3, { companyCode: "1234", entityKey: "company:1234", category: "dividend_increase", title: "配当予想修正" }),
  ]);
  const plan = planImportantNewsFetchGroups(event, { maxGroups: 3, maxPdfEnrichments: 2 });
  assert.equal(plan.selectedGroups.length, 1);
  assert.equal(plan.selectedGroups[0].members.length, 3);
  assert.equal(plan.selectedPdfCount, 3);
  assert.equal(plan.deferredGroups.length, 0);
});

test("a group crossing the remaining boundary is deferred whole", async () => {
  const candidates = [
    input(1),
    input(2, { companyCode: "2222", entityKey: "company:2222", category: "earnings", title: "決算短信" }),
    input(3, { companyCode: "2222", entityKey: "company:2222", category: "dividend_increase", title: "配当予想修正" }),
  ];
  const plan = planImportantNewsFetchGroups(await groups(candidates), {
    maxGroups: 3,
    maxPdfEnrichments: 2,
  });
  assert.equal(plan.selectedGroups.length, 1);
  assert.equal(plan.selectedCandidateCount, 1);
  assert.equal(plan.deferredGroups.length, 1);
  assert.equal(plan.deferredGroups[0].members.length, 2);
});

test("deferred groups remain eligible on the next fetch", async () => {
  const first = planImportantNewsFetchGroups(await groups([input(1), input(2), input(3), input(4)]));
  const next = planImportantNewsFetchGroups(first.deferredGroups);
  assert.equal(first.deferredCandidateCount, 1);
  assert.equal(next.selectedCandidateCount, 1);
  assert.equal(next.deferredCandidateCount, 0);
});

test("already enriched candidates do not consume the PDF budget", async () => {
  const plan = planImportantNewsFetchGroups(await groups([
    input(1, { bodySummary: "取得済み本文" }),
    input(2, { bodySummary: "取得済み本文" }),
    input(3, { bodySummary: "取得済み本文" }),
  ]), { maxGroups: 3, maxPdfEnrichments: 1 });
  assert.equal(plan.selectedGroups.length, 3);
  assert.equal(plan.selectedPdfCount, 0);
});

// market_macro P0: the lane must have its own quota, entirely independent of the corporate
// (TDnet/company_ir) lane's MAX_IMPORTANT_NEWS_LIGHTWEIGHT_CANDIDATES=100 budget — a busy corporate
// disclosure day must never starve macro candidates out. Both lanes call planImportantNewsCandidateBatch
// separately (see index.ts), so this is true by construction; these tests pin that down as a regression
// guard against a future change that folds the two into one shared array/cap.
test("2: market_macro has its own quota, distinct from the corporate lane's 100-candidate cap", () => {
  assert.notEqual(MAX_MARKET_MACRO_CANDIDATES_PER_FETCH, MAX_IMPORTANT_NEWS_LIGHTWEIGHT_CANDIDATES);
  assert.ok(MAX_MARKET_MACRO_CANDIDATES_PER_FETCH > 0);
});

test("3: a full (150-candidate) corporate lane does not reduce the market_macro batch size", () => {
  const corporateCandidates = Array.from({ length: 150 }, (_, index) => ({ id: `corp-${index}` }));
  const macroCandidates = Array.from(
    { length: MAX_MARKET_MACRO_CANDIDATES_PER_FETCH + 20 },
    (_, index) => ({ id: `macro-${index}` }),
  );
  const corporateBatch = planImportantNewsCandidateBatch(corporateCandidates, MAX_IMPORTANT_NEWS_LIGHTWEIGHT_CANDIDATES);
  const macroBatch = planImportantNewsCandidateBatch(macroCandidates, MAX_MARKET_MACRO_CANDIDATES_PER_FETCH);
  assert.equal(corporateBatch.selectedCandidates.length, MAX_IMPORTANT_NEWS_LIGHTWEIGHT_CANDIDATES);
  assert.equal(macroBatch.selectedCandidates.length, MAX_MARKET_MACRO_CANDIDATES_PER_FETCH);
  assert.equal(macroBatch.deferredCandidateCount, 20);
});

test("invalid fetch limits fail safely", async () => {
  const eventGroups = await groups([input(1)]);
  assert.throws(
    () => planImportantNewsFetchGroups(eventGroups, { maxGroups: 0 }),
    /IMPORTANT_NEWS_FETCH_LIMIT_INVALID/,
  );
});

test("index.ts wires market_macro through its own batch call, never through acquiredCandidates/MAX_CANDIDATES_PER_REQUEST", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  // The market_macro fetch+batch block must be fully assembled (collectedMacro -> marketMacroBatch)
  // before allCandidates is built from suppliedCandidates/acquiredCandidates, and must never push into
  // acquiredCandidates itself — that is what keeps it out of the corporate lane's 100-candidate cap.
  const macroBatchIndex = source.indexOf("planImportantNewsCandidateBatch(\n        collectedMacro.candidates,\n        MAX_MARKET_MACRO_CANDIDATES_PER_FETCH,");
  const allCandidatesIndex = source.indexOf("const allCandidates: unknown[] = [...suppliedCandidates, ...acquiredCandidates];");
  assert.ok(macroBatchIndex >= 0, "expected the market_macro batch call to exist verbatim in index.ts");
  assert.ok(allCandidatesIndex > macroBatchIndex);
  assert.ok(!/acquiredCandidates\.push\(\.\.\.collectedMacro/.test(source));
  assert.ok(!source.includes("collectedMacro.candidates, MAX_CANDIDATES_PER_REQUEST"));
});
