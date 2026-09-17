import assert from "node:assert/strict";
import test from "node:test";
import {
  decideRunWindow,
  expectedJpxSessionDate,
  expectedUsSessionDate,
  localParts,
  newsWindowStart,
  zonedInstant,
} from "./session_logic.ts";
import { JPX_HOLIDAYS, NYSE_HOLIDAYS } from "./test_fixtures.ts";

test("close uses the trading date; morning uses the previous JPX session", () => {
  assert.deepEqual(expectedJpxSessionDate("close", "2026-09-16", JPX_HOLIDAYS), "2026-09-16");
  assert.deepEqual(expectedJpxSessionDate("morning", "2026-09-17", JPX_HOLIDAYS), "2026-09-16");
  // Monday morning → Friday; after the 9/21–9/23 holidays → Friday 9/18.
  assert.deepEqual(expectedJpxSessionDate("morning", "2026-09-14", JPX_HOLIDAYS), "2026-09-11");
  assert.deepEqual(expectedJpxSessionDate("morning", "2026-09-24", JPX_HOLIDAYS), "2026-09-18");
});

test("expected US session is the latest NYSE session closed at as_of", () => {
  // 07:50 JST 9/17 = 18:50 EDT 9/16 → 9/16 session.
  assert.deepEqual(expectedUsSessionDate(new Date("2026-09-16T22:50:00Z"), NYSE_HOLIDAYS), "2026-09-16");
  // 16:15 JST 9/16 = 03:15 EDT 9/16 → 9/15 session.
  assert.deepEqual(expectedUsSessionDate(new Date("2026-09-16T07:15:00Z"), NYSE_HOLIDAYS), "2026-09-15");
  // 07:50 JST 9/8 = 18:50 EDT 9/7 (Labor Day) → Friday 9/4.
  assert.deepEqual(expectedUsSessionDate(new Date("2026-09-07T22:50:00Z"), NYSE_HOLIDAYS), "2026-09-04");
  // Just before the 16:00 close on 9/16 EDT → 9/15.
  assert.deepEqual(expectedUsSessionDate(new Date("2026-09-16T19:59:00Z"), NYSE_HOLIDAYS), "2026-09-15");
});

test("zonedInstant handles both EDT and EST", () => {
  assert.deepEqual(zonedInstant("2026-09-16", 16 * 60, "America/New_York").toISOString(), "2026-09-16T20:00:00.000Z");
  assert.deepEqual(zonedInstant("2026-12-16", 16 * 60, "America/New_York").toISOString(), "2026-12-16T21:00:00.000Z");
  assert.deepEqual(zonedInstant("2026-09-16", 15 * 60 + 30, "Asia/Tokyo").toISOString(), "2026-09-16T06:30:00.000Z");
  assert.deepEqual(localParts(new Date("2026-09-16T06:30:00Z"), "Asia/Tokyo"), { date: "2026-09-16", minutes: 930, weekday: 3 });
});

test("run window: holidays, close before 15:30 and morning after 09:00 are skipped", () => {
  assert.deepEqual(decideRunWindow("close", new Date("2026-09-21T07:15:00Z"), JPX_HOLIDAYS), {
    run: false, tradingDate: "2026-09-21", reason: "NOT_TRADING_DAY",
  });
  assert.deepEqual(decideRunWindow("close", new Date("2026-09-16T06:29:00Z"), JPX_HOLIDAYS), {
    run: false, tradingDate: "2026-09-16", reason: "CLOSE_TOO_EARLY",
  });
  assert.deepEqual(decideRunWindow("close", new Date("2026-09-16T07:15:00Z"), JPX_HOLIDAYS), { run: true, tradingDate: "2026-09-16" });
  assert.deepEqual(decideRunWindow("morning", new Date("2026-09-16T22:50:00Z"), JPX_HOLIDAYS), { run: true, tradingDate: "2026-09-17" });
  assert.deepEqual(decideRunWindow("morning", new Date("2026-09-17T00:00:00Z"), JPX_HOLIDAYS), {
    run: false, tradingDate: "2026-09-17", reason: "MORNING_TOO_LATE",
  });
});

test("news window starts at the previous JPX close", () => {
  assert.deepEqual(newsWindowStart("2026-09-17", JPX_HOLIDAYS).toISOString(), "2026-09-16T06:30:00.000Z");
  assert.deepEqual(newsWindowStart("2026-09-14", JPX_HOLIDAYS).toISOString(), "2026-09-11T06:30:00.000Z");
});
