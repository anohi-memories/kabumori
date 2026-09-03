import assert from "node:assert/strict";
import test from "node:test";
import {
  US_MARKET_CALENDAR_SELECT_FAILED,
  getExpectedUsSessionDate,
  resolveExpectedUsSessionDate,
} from "./us_session_date_logic.ts";

// 2026 NYSE holidays actually present in market_holidays (see the migration), for realistic tests.
const NYSE_2026_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);

test("1: normal weekday after US close -> today's own session", () => {
  // 2026-09-02 (Wed) 21:00 ET = 2026-09-03 01:00 UTC
  assert.equal(resolveExpectedUsSessionDate("2026-09-03T01:00:00Z", NYSE_2026_HOLIDAYS), "2026-09-02");
});

test("2: normal weekday before US open -> previous trading day", () => {
  // 2026-09-02 (Wed) 08:00 ET = 2026-09-02 12:00 UTC
  assert.equal(resolveExpectedUsSessionDate("2026-09-02T12:00:00Z", NYSE_2026_HOLIDAYS), "2026-09-01");
});

test("3: during US regular trading hours -> previous completed session, not today", () => {
  // 2026-09-02 (Wed) 12:00 ET = 2026-09-02 16:00 UTC
  assert.equal(resolveExpectedUsSessionDate("2026-09-02T16:00:00Z", NYSE_2026_HOLIDAYS), "2026-09-01");
});

test("4: Saturday -> most recent Friday", () => {
  // 2026-09-05 (Sat) noon ET
  assert.equal(resolveExpectedUsSessionDate("2026-09-05T16:00:00Z", NYSE_2026_HOLIDAYS), "2026-09-04");
});

test("5: Sunday -> most recent Friday (walks back through Saturday too)", () => {
  // 2026-09-06 (Sun) noon ET
  assert.equal(resolveExpectedUsSessionDate("2026-09-06T16:00:00Z", NYSE_2026_HOLIDAYS), "2026-09-04");
});

test("6: Monday morning JST is Sunday evening ET -> most recent Friday", () => {
  // Monday 08:20 JST = Sunday 23:20 UTC = Sunday 19:20 ET (EDT, UTC-4) -- crosses the JST/ET date boundary.
  assert.equal(resolveExpectedUsSessionDate("2026-09-06T23:20:00Z", NYSE_2026_HOLIDAYS), "2026-09-04");
});

test("7: US holiday (Labor Day) -> walks back past the holiday to the prior Friday", () => {
  // 2026-09-07 (Mon, Labor Day) noon ET
  assert.equal(resolveExpectedUsSessionDate("2026-09-07T16:00:00Z", NYSE_2026_HOLIDAYS), "2026-09-04");
});

test("8: day after a holiday, before that day's own open -> skips the holiday and weekend", () => {
  // 2026-09-08 (Tue, day after Labor Day) 08:00 ET, before open
  assert.equal(resolveExpectedUsSessionDate("2026-09-08T12:00:00Z", NYSE_2026_HOLIDAYS), "2026-09-04");
});

test("8b: day after a holiday, after that day's own close -> that day's own session", () => {
  // 2026-09-08 (Tue) 21:00 ET, well after close
  assert.equal(resolveExpectedUsSessionDate("2026-09-09T01:00:00Z", NYSE_2026_HOLIDAYS), "2026-09-08");
});

test("9: year-end boundary (New Year's Day) is walked back correctly", () => {
  // Synthetic holiday set including a hypothetical 2027-01-01 New Year's Day, since production
  // market_holidays does not yet have 2027 NYSE dates (flagged separately in the report).
  const holidays = new Set([...NYSE_2026_HOLIDAYS, "2027-01-01"]);
  // 2027-01-04 (Mon) 08:00 ET, before open -> walk back through Sun(1/3), Sat(1/2), Fri holiday(1/1)
  // to Thursday 2026-12-31, a normal trading day.
  assert.equal(resolveExpectedUsSessionDate("2027-01-04T13:00:00Z", holidays), "2026-12-31");
});

test("resolution throws rather than looping forever if holiday data implies an implausibly long closure", () => {
  // Every day for 20 days marked a holiday -> exceeds the 14-day safety bound.
  const allClosed = new Set<string>();
  let cursor = "2026-09-02";
  for (let i = 0; i < 20; i += 1) {
    allClosed.add(cursor);
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    cursor = d.toISOString().slice(0, 10);
  }
  assert.throws(() => resolveExpectedUsSessionDate("2026-09-02T12:00:00Z", allClosed));
});

// --- getExpectedUsSessionDate (REST query + resolution) -----------------------------------------------

function fetcher(holidayRows: Array<{ holiday_date: string }>) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("market"), "eq.NYSE");
    const gte = url.searchParams.getAll("holiday_date").find((value) => value.startsWith("gte."));
    const lte = url.searchParams.getAll("holiday_date").find((value) => value.startsWith("lte."));
    assert.ok(gte && lte);
    return Response.json(holidayRows);
  };
}

test("getExpectedUsSessionDate queries market_holidays with market=NYSE and resolves the date", async () => {
  const rows = Array.from(NYSE_2026_HOLIDAYS).map((holiday_date) => ({ holiday_date }));
  const result = await getExpectedUsSessionDate(
    "https://example.supabase.co", "test-key", "2026-09-08T12:00:00Z", fetcher(rows),
  );
  assert.equal(result, "2026-09-04");
});

test("getExpectedUsSessionDate surfaces a dedicated error on a failed lookup", async () => {
  const failingFetcher = async (): Promise<Response> => new Response("error", { status: 500 });
  await assert.rejects(
    () => getExpectedUsSessionDate("https://example.supabase.co", "test-key", "2026-09-08T12:00:00Z", failingFetcher),
    new Error(US_MARKET_CALENDAR_SELECT_FAILED),
  );
});
