import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// NOTE: this file documents 20260901044548_add_morning_greeting_schedule.sql, which was a draft "STEP 1"
// never applied to production. 20260905010000_enable_morning_greeting_auto_dispatch.sql (see
// morning_greeting_dispatch_test.ts) supersedes it in production: it uses a 06:30-07:00 JST window
// instead of 07:00-07:30, and morning_greeting IS now claimed and dispatched to X (via the new
// post_type === "morning_greeting" branch in index.ts). The assertions below remain true statements about
// this specific (unapplied, superseded) file's own static content — they are not a description of
// current production behavior.

const migrationUrl = new URL(
  "../../migrations/20260901044548_add_morning_greeting_schedule.sql",
  import.meta.url,
);
const baseSchedulerUrl = new URL(
  "../../migrations/20260828203000_create_post_scheduler.sql",
  import.meta.url,
);
const plannerUrl = new URL(
  "../../migrations/20260828234000_add_interaction_collision_avoidance.sql",
  import.meta.url,
);

const migration = readFileSync(fileURLToPath(migrationUrl), "utf8");
const baseScheduler = readFileSync(fileURLToPath(baseSchedulerUrl), "utf8");
const planner = readFileSync(fileURLToPath(plannerUrl), "utf8");
const migrationStatements = migration.replace(/^--.*$/gm, "");

function scheduledJst(date: string, secondOffset: number): number {
  return new Date(`${date}T07:00:00+09:00`).valueOf() + secondOffset * 1000;
}

test("weekday gets one active morning_greeting slot", () => {
  assert.match(migration, /'morning_greeting', 1, '07:00:00', '07:30:00', 'Asia\/Tokyo', 1, true/);
  assert.equal(new Date("2026-09-01T00:00:00+09:00").getDay(), 2);
});

test("Saturday uses the same daily slot", () => {
  assert.equal(new Date("2026-09-05T00:00:00+09:00").getDay(), 6);
  assert.doesNotMatch(migrationStatements, /is_trading_day|weekday|holiday/i);
});

test("Sunday uses the same daily slot", () => {
  assert.equal(new Date("2026-09-06T00:00:00+09:00").getDay(), 0);
  assert.doesNotMatch(migrationStatements, /is_trading_day|weekday|holiday/i);
});

test("holiday dates are not excluded", () => {
  assert.equal(new Date("2026-09-21T00:00:00+09:00").getDay(), 1);
  assert.doesNotMatch(migration, /market_calendar|jpx_calendar|is_business_day/i);
});

test("random schedule includes both 07:00:00 and 07:30:00 JST boundaries", () => {
  assert.equal(new Date(scheduledJst("2026-09-01", 0)).toISOString(), "2026-08-31T22:00:00.000Z");
  assert.equal(new Date(scheduledJst("2026-09-01", 1800)).toISOString(), "2026-08-31T22:30:00.000Z");
  assert.match(planner, /random\(\) \* \(extract\(epoch from \(window_row\.end_time - effective_start\)\) \+ 1\)/);
});

test("same-day duplicate is prevented by the existing unique key and conflict handling", () => {
  assert.match(baseScheduler, /unique \(schedule_date, post_type, slot_no\)/);
  assert.match(planner, /on conflict \(schedule_date, post_type, slot_no\) do nothing/);
});

test("the next calendar day can receive its own schedule", () => {
  const first = new Date(scheduledJst("2026-09-01", 600)).toISOString();
  const next = new Date(scheduledJst("2026-09-02", 600)).toISOString();
  assert.notEqual(first, next);
  assert.equal(Date.parse(next) - Date.parse(first), 24 * 60 * 60 * 1000);
});

test("existing post types remain active and unmodified", () => {
  assert.doesNotMatch(migration, /update public\.posting_windows/);
  assert.doesNotMatch(migration, /delete from public\.posting_windows/);
  assert.match(migration, /on conflict \(post_type, slot_no\) do update/);
});

test("morning_greeting cannot be claimed or sent to the X dispatcher in STEP 1", () => {
  assert.match(migration, /and post_type <> 'morning_greeting'/);
  assert.match(migration, /where status = 'pending'/);
  assert.doesNotMatch(migration, /postToX|X API|complete_morning_greeting/);
});
