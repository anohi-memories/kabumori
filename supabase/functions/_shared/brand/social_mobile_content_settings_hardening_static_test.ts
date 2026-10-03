import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source invariants for the hardening migration. The behaviour itself is proven against a real
// disposable PostgreSQL by supabase/tests/social_mobile_content_settings_run.sh; these checks keep
// the security-relevant shape of the file from silently changing.
const root = new URL("../../../..", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const hardeningPath = "supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql";
const candidatePath = "supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql";

test("the historical candidate is kept and the hardening runs after it", async () => {
  const candidate = await read(candidatePath);
  assert.match(candidate, /create table if not exists public\.social_mobile_content_settings/iu);
  assert.ok("20261003120000" > "20260922045046");
});

test("drift guard runs before any change and refuses unknown objects", async () => {
  const sql = await read(hardeningPath);
  const guard = sql.indexOf("SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_DRIFT");
  const firstChange = sql.search(/^(create or replace function|alter table|drop |grant |revoke )/imu);
  assert.ok(guard > 0 && firstChange > guard, "guard precedes the first DDL");
  for (const part of ["unexpected columns", "brand foreign key", "unknown constraints", "unexpected index", "unexpected trigger", "unexpected policy", "unexpected grantee", "unexpected column grantee", "inheritance"]) {
    assert.ok(sql.includes(part), part);
  }
  assert.match(sql, /v_fk\.confdeltype <> 'c'/u);
  assert.match(sql, /SOCIAL_MOBILE_CONTENT_SETTINGS_HARDENING_EXISTING_ROWS_INVALID/u);
});

test("contracts are allowlists evaluated null-safely", async () => {
  const sql = await read(hardeningPath);
  assert.match(sql, /check \(public\.social_mobile_content_settings_valid_settings\(settings\) is true\)/u);
  assert.match(sql, /check \(public\.social_mobile_content_settings_valid_persona\(persona_profile\) is true\)/u);
  assert.match(sql, /jsonb_object_keys\(p_settings\)\) <> 9/u);
  assert.match(sql, /'"ja-JP"'::jsonb/u);
  assert.match(sql, /'"Asia\/Tokyo"'::jsonb/u);
  assert.match(sql, /\(v_window ->> 'endLocal'\) <> '24:00'/u);
  assert.match(sql, /else false/u);
});

test("privileges: only this table/functions, nothing for anon/service_role, no default-privilege change", async () => {
  const sql = await read(hardeningPath);
  assert.match(sql, /revoke all on table public\.social_mobile_content_settings from public, anon, authenticated, service_role;/u);
  assert.match(sql, /grant select, insert, update on table public\.social_mobile_content_settings to authenticated;/u);
  assert.doesNotMatch(sql, /alter default privileges/iu);
  assert.doesNotMatch(sql, /grant [^;]* to (anon|service_role)/iu);
  assert.doesNotMatch(sql, /security definer/iu);
  assert.doesNotMatch(sql, /\bexecute format\b|\bexecute '/iu);
  assert.match(sql, /authenticated=INSERT,authenticated=SELECT,authenticated=UPDATE/u);
});

test("version is server-owned and strictly increasing", async () => {
  const sql = await read(hardeningPath);
  assert.match(sql, /new\.updated_at := greatest\(clock_timestamp\(\), old\.updated_at \+ interval '1 microsecond'\)/u);
  assert.match(sql, /before insert or update on public\.social_mobile_content_settings/u);
  assert.match(sql, /drop function if exists public\.social_mobile_content_settings_touch_updated_at\(\)/u);
  assert.doesNotMatch(sql.slice(sql.indexOf("social_mobile_content_settings_version()")), /:= now\(\)/u);
});
