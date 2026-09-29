import assert from "node:assert/strict";
import test from "node:test";

import { formatTopicDate, pastJstDates } from "../../src/lib/topic-history.ts";
import { MENU_ENTRIES } from "../../src/lib/menu-entries.ts";

test("pastJstDates goes backwards from today inclusive, newest first", () => {
  assert.deepEqual(pastJstDates("2026-09-29", 3), ["2026-09-29", "2026-09-28", "2026-09-27"]);
});

test("pastJstDates crosses month and year boundaries and honors offset", () => {
  assert.deepEqual(pastJstDates("2026-01-02", 3), ["2026-01-02", "2026-01-01", "2025-12-31"]);
  assert.deepEqual(pastJstDates("2026-09-29", 2, 14), ["2026-09-15", "2026-09-14"]);
});

test("pastJstDates returns nothing for a malformed date or non-positive count", () => {
  assert.deepEqual(pastJstDates("nonsense", 3), []);
  assert.deepEqual(pastJstDates("2026-09-29", 0), []);
});

test("formatTopicDate renders month/day/weekday, and leaves malformed input alone", () => {
  assert.equal(formatTopicDate("2026-09-29"), "9月29日（火）");
  assert.equal(formatTopicDate("bad"), "bad");
});

test("the メニュー tab lists topics, AI, portfolio and settings exactly once each", () => {
  assert.deepEqual(MENU_ENTRIES.map((e) => e.id), ["topics", "ai", "portfolio", "settings"]);
  assert.equal(new Set(MENU_ENTRIES.map((e) => e.href)).size, MENU_ENTRIES.length);
});
