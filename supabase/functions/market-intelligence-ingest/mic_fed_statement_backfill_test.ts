import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHistoricalFedRangeConsistency,
  buildFedHistoricalBackfillCandidate,
  FED_BACKFILL_RECOMMENDED_LIMIT,
  FED_BACKFILL_RECOMMENDED_SCOPE,
  selectFedHistoricalStatementUrls,
  selectHistoricalFedRange,
  type HistoricalFedRangeFact,
} from "./mic_fed_statement_backfill.ts";

const JULY_URL = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm";
const calendar = `
  <a href="/newsevents/pressreleases/monetary20260128a.htm">Statement</a>
  <a href="/newsevents/pressreleases/monetary20260318a.htm">Statement</a>
  <a href="/newsevents/pressreleases/monetary20260429a.htm">Statement</a>
  <a href="/newsevents/pressreleases/monetary20260617a.htm">Statement</a>
  <a href="/newsevents/pressreleases/monetary20260729a1.htm">Implementation Note</a>
  <a href="/newsevents/pressreleases/monetary20260729a.htm">Statement</a>
  <a href="/newsevents/pressreleases/monetary20260916a.htm">Statement</a>`;

const julyHtml = `
  <html><body>
  <p>July 29, 2026</p>
  <p>For release at 2:00 p.m. EDT</p>
  <p>The Committee decided to maintain the target range for the federal funds rate at 3-1/2 to 3-3/4 percent.</p>
  <p>Economic activity is expanding at a solid pace. Inflation remains elevated.</p>
  </body></html>`;

const septemberHtml = `
  <html><body>
  <p>September 16, 2026</p>
  <p>For release at 2:00 p.m. EDT</p>
  <p>The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent.</p>
  <p>Economic activity is expanding at a solid pace. Inflation remains elevated.</p>
  </body></html>`;

const fred = (observedDate: string, lower: number, upper: number): HistoricalFedRangeFact => ({
  observedDate,
  lower,
  upper,
  sourceKey: "fred",
  lowerSeriesId: "DFEDTARL",
  upperSeriesId: "DFEDTARU",
});

test("recommended historical backfill is the latest four official statements", () => {
  assert.equal(FED_BACKFILL_RECOMMENDED_SCOPE, "recent_four");
  assert.equal(FED_BACKFILL_RECOMMENDED_LIMIT, 4);
  assert.deepEqual(selectFedHistoricalStatementUrls(calendar, "2026-09-16"), [
    JULY_URL,
    "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260617a.htm",
    "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260429a.htm",
    "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260318a.htm",
  ]);
  assert.deepEqual(selectFedHistoricalStatementUrls(calendar, "2026-09-16", "previous_one"), [JULY_URL]);
  assert.equal(selectFedHistoricalStatementUrls(calendar, "2026-09-16", "calendar_year").length, 5);
});

test("historical FRED range selection never reuses a future/current value", () => {
  const facts = [fred("2026-09-16", 3.75, 4), fred("2026-07-29", 3.5, 3.75), fred("2026-06-17", 3.5, 3.75)];
  assert.deepEqual(selectHistoricalFedRange(facts, "2026-07-29"), facts[1]);
  assert.equal(selectHistoricalFedRange(facts, "2025-12-31"), null);
});

test("historical event uses the production adapter contract and official range", async () => {
  const candidate = await buildFedHistoricalBackfillCandidate({
    statementUrl: JULY_URL,
    statementHtml: julyHtml,
    previousRange: fred("2026-07-28", 3.5, 3.75),
    effectiveRange: fred("2026-07-29", 3.5, 3.75),
  });
  assert.equal(candidate.outcome, "candidate");
  assert.equal(candidate.event?.eventType, "central_bank_decision");
  assert.equal(candidate.event?.sourceKey, "fed");
  assert.equal(candidate.event?.sourceName, "Federal Reserve");
  assert.equal(candidate.event?.rawPayload?.meeting_date, "2026-07-29");
  assert.equal(candidate.event?.rawPayload?.decision, "hold");
  assert.deepEqual(candidate.event?.rawPayload?.rates, {
    FED_FUNDS_TARGET_LOWER: { old_rate: 3.5, new_rate: 3.5, change_bps: 0 },
    FED_FUNDS_TARGET_UPPER: { old_rate: 3.75, new_rate: 3.75, change_bps: 0 },
  });
});

test("historical backfill is idempotent for the same meeting and document hash", async () => {
  const first = await buildFedHistoricalBackfillCandidate({
    statementUrl: JULY_URL,
    statementHtml: julyHtml,
    previousRange: fred("2026-07-28", 3.5, 3.75),
    effectiveRange: fred("2026-07-29", 3.5, 3.75),
  });
  const duplicate = await buildFedHistoricalBackfillCandidate({
    statementUrl: JULY_URL,
    statementHtml: julyHtml,
    previousRange: fred("2026-07-28", 3.5, 3.75),
    effectiveRange: fred("2026-07-29", 3.5, 3.75),
    existingIdentities: [first.identity],
  });
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(duplicate.event, null);
});

test("current decision classification uses the historical previous range, not the current FRED value", async () => {
  const candidate = await buildFedHistoricalBackfillCandidate({
    statementUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm",
    statementHtml: septemberHtml,
    previousRange: fred("2026-09-15", 3.5, 3.75),
    effectiveRange: fred("2026-09-16", 3.75, 4),
  });
  assert.equal(candidate.event?.rawPayload?.decision, "hike");
  assert.deepEqual(candidate.event?.rawPayload?.rates, {
    FED_FUNDS_TARGET_LOWER: { old_rate: 3.5, new_rate: 3.75, change_bps: 25 },
    FED_FUNDS_TARGET_UPPER: { old_rate: 3.75, new_rate: 4, change_bps: 25 },
  });
});

test("statement/FRED historical range mismatch fails closed", async () => {
  assert.throws(() => assertHistoricalFedRangeConsistency({ lower: 3.5, upper: 3.75 }, fred("2026-07-29", 3.75, 4)), /FED_BACKFILL_RANGE_MISMATCH/);
  await assert.rejects(
    () => buildFedHistoricalBackfillCandidate({
      statementUrl: JULY_URL,
      statementHtml: julyHtml,
      previousRange: fred("2026-07-28", 3.5, 3.75),
      effectiveRange: fred("2026-07-29", 3.75, 4),
    }),
    /FED_BACKFILL_RANGE_MISMATCH/,
  );
});
