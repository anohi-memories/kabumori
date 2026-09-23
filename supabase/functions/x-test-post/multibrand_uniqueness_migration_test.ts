import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../../migrations/20260923102327_x_autopost_phase0_brand_scoped_uniqueness.sql", import.meta.url),
  "utf8",
);
const publishClaim = await readFile(new URL("./publish_claim_logic.ts", import.meta.url), "utf8");
const morningPublish = await readFile(new URL("./morning_greeting_publish_logic.ts", import.meta.url), "utf8");
const index = await readFile(new URL("./index.ts", import.meta.url), "utf8");

test("Phase 0 removes only the exact three legacy global constraints", () => {
  assert.match(migration, /DROP CONSTRAINT posting_windows_post_type_slot_no_key/);
  assert.match(migration, /DROP CONSTRAINT scheduled_posts_schedule_date_post_type_slot_no_key/);
  assert.match(migration, /DROP CONSTRAINT publish_claims_post_type_date_jst_key/);
  assert.equal((migration.match(/DROP CONSTRAINT/gu) ?? []).length, 3);
  assert.doesNotMatch(migration, /DROP INDEX|DROP TABLE|DELETE FROM|UPDATE public\./i);
});

test("Phase 0 fails closed unless all exact brand-scoped unique indexes remain valid", () => {
  for (const name of [
    "posting_windows_brand_post_type_slot_key",
    "scheduled_posts_brand_schedule_slot_key",
    "publish_claims_brand_post_type_date_key",
  ]) assert.ok(migration.includes(name));
  assert.match(migration, /indisunique AND i\.indisvalid AND i\.indisready/);
  assert.match(migration, /PHASE0_UNIQUENESS_PREFLIGHT_SCOPED_DUPLICATE/);
});

test("planner RPCs retain their body and switch only the exact scheduled-post conflict target", () => {
  for (const fn of [
    "public.plan_daily_posts(date)",
    "public.plan_morning_report(date)",
    "public.plan_close_report(date)",
    "public.plan_us_premarket_report(date)",
  ]) assert.ok(migration.includes(`to_regprocedure('${fn}')`));
  assert.match(migration, /v_old_target text := 'on conflict \(schedule_date, post_type, slot_no\) do nothing'/);
  assert.match(migration, /v_new_target text := 'on conflict \(brand_id, schedule_date, post_type, slot_no\) do nothing'/);
  assert.match(migration, /PHASE0_UNIQUENESS_PREFLIGHT_PLANNER_SECURITY_MISMATCH/);
  assert.match(migration, /PHASE0_UNIQUENESS_PREFLIGHT_PLANNER_CONFLICT_TARGET_MISMATCH/);
});

test("publish claim client uses the brand-scoped conflict key and scopes completion/failure updates", () => {
  assert.match(publishClaim, /on_conflict=brand_id,post_type,date_jst/);
  assert.match(publishClaim, /brand_id: args\.brandId/);
  assert.equal((publishClaim.match(/brand_id: `eq\.\$\{args\.brandId\}`/gu) ?? []).length, 2);
  assert.match(morningPublish, /brandId: args\.brandId/);
  assert.match(index, /brandId: brandContext\.brand\.id/);
  assert.match(index, /brandId: "kabumori",\s*\}\);\s*assertBrandPublishAllowed\(brandContext\)/u);
  assert.match(index, /brandId: brandIdFromScheduledRow\(scheduledPost\.brand_id\)/u);
  assert.equal((index.match(/brandId: brandContext\.brand\.id/gu) ?? []).length, 2);
});

test("candidate contains no production apply path or db push", () => {
  assert.doesNotMatch(migration, /supabase\s+db\s+push|apply_migration|wsmznyzcvmuitkglfeuj/i);
});
