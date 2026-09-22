import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../../../migrations/20260922045046_social_mobile_content_settings_candidate.sql", import.meta.url);

test("Phase 14 migration keeps general-user settings separate from admin operational settings", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /create table if not exists public\.social_mobile_content_settings/iu);
  assert.doesNotMatch(sql, /alter table public\.posting_windows/iu);
  assert.doesNotMatch(sql, /publish_enabled\s+(?:boolean|=)/iu);
  assert.match(sql, /brand_memberships bm[\s\S]*bm\.role = 'owner'/iu);
  assert.match(sql, /alter table public\.social_mobile_content_settings enable row level security/iu);
  assert.match(sql, /grant select, insert, update on table public\.social_mobile_content_settings to authenticated/iu);
  assert.match(sql, /revoke delete on table public\.social_mobile_content_settings from authenticated/iu);
  assert.match(sql, /set search_path = public/iu);
});

test("Phase 14 migration bounds settings and blocks secrets/raw post history", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /frequencyTargetPerWeek.*between 0 and 14/iu);
  assert.match(sql, /jsonb_array_length\(settings->'optionalNgWords'\) between 0 and 20/iu);
  assert.match(sql, /livePublishingEnabled.*publish_enabled.*publishEnabled/iu);
  assert.match(sql, /access_token.*refresh_token.*publish_enabled.*posts/iu);
});

test("Phase 14 SQL defaults accept an end-of-day 24:00 only for endLocal", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /'startLocal', '09:00'/u);
  assert.match(sql, /'endLocal', '24:00'/u);
  assert.match(sql, /'defaultGenerationLocal', '17:00'/u);
  assert.match(
    sql,
    /settings->'generationWindow'->>'endLocal'\)\s*~\s*'\^\(\(\[01\]\[0-9\]\|2\[0-3\]\):\[0-5\]\[0-9\]\|24:00\)\$'/u,
  );

  const endTime = /^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/u;
  const regularTime = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u;
  assert.equal(endTime.test("09:00"), true);
  assert.equal(endTime.test("24:00"), true);
  assert.equal(regularTime.test("24:00"), false);
  assert.equal(regularTime.test("23:59"), true);
  assert.match(sql, /startLocal'\)\s*~\s*'\^\(\[01\]\[0-9\]\|2\[0-3\]\):\[0-5\]\[0-9\]\$'/u);
  assert.match(sql, /defaultGenerationLocal'\)\s*~\s*'\^\(\[01\]\[0-9\]\|2\[0-3\]\):\[0-5\]\[0-9\]\$'/u);
});
