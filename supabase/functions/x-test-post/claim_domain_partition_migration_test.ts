import assert from "node:assert/strict";
import test from "node:test";

const sql = await Deno.readTextFile(new URL("../../migrations/20260924160000_x_autopost_phase1d_claim_domain_partition.sql", import.meta.url));
const phase1b = await Deno.readTextFile(new URL("../../migrations/20260924023133_x_autopost_phase1b_account_bound_queue.sql", import.meta.url));
const dispatcher = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

const V2_RPCS = [
  "schedule_account_bound_post_v2", "plan_daily_posts_v2", "claim_due_post_v2",
  "mark_post_provider_started_v2", "settle_post_pre_x_v2", "record_post_x_uncertain_v2",
  "record_post_x_confirmed_incomplete_v2", "complete_post_x_confirmed_v2", "reconcile_stale_pre_x_v2",
];

function definition(name: string): string {
  const match = sql.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "u"));
  assert.ok(match, `missing definition ${name}`);
  return match[0];
}

test("live legacy RPCs are not replaced and Phase1B bodies are not redefined", () => {
  assert.doesNotMatch(sql, /create\s+(?:or\s+replace\s+)?function\s+public\.(?:claim_due_post|retry_scheduled_post|fail_scheduled_post|complete_\w+_post)\s*\(/iu);
  assert.doesNotMatch(sql, /create\s+or\s+replace/iu);
  assert.doesNotMatch(sql, /\bdrop\s+(?:function|table|trigger|index)/iu);
  for (const name of V2_RPCS) {
    assert.match(sql, new RegExp(`alter function public\\.${name}\\([^)]*\\)\\s+rename to ${name}_core;`, "u"), name);
    assert.match(phase1b, new RegExp(`create function public\\.${name}\\(`, "u"), name);
  }
});

test("versioned legacy claim is fenced to unbound rows at select and update time", () => {
  const legacy = definition("claim_due_post_legacy_unbound_v2");
  assert.match(legacy, /where s\.social_account_id is null\s+and s\.status = 'pending' and s\.scheduled_for <= now\(\)/u);
  assert.match(legacy, /for update of s skip locked limit 1/u);
  assert.match(legacy, /where s\.id = v_claimed_id and s\.social_account_id is null and s\.status = 'pending'/u);
  assert.doesNotMatch(legacy, /social_account_id\s*=/u);
  assert.doesNotMatch(legacy, /social_accounts/u);
  for (const planner of ["plan_morning_report", "plan_close_report", "plan_daily_posts", "plan_weekly_useful_tips", "plan_us_premarket_report"]) {
    assert.match(legacy, new RegExp(`perform public\\.${planner}\\(\\);`, "u"), planner);
  }
  assert.ok(legacy.indexOf("plan_us_premarket_report") > legacy.indexOf("plan_weekly_useful_tips"));
});

test("trigger makes bindings immutable and bound lifecycle v2-only", () => {
  const guard = definition("scheduled_posts_claim_domain_guard");
  assert.match(guard, /raise exception 'CLAIM_DOMAIN_IMMUTABLE'/u);
  assert.match(guard, /raise exception 'BOUND_ROW_REQUIRES_V2_PATH'/u);
  assert.match(guard, /if not v_in_v2 then raise exception 'BOUND_ROW_REQUIRES_V2_PATH'; end if;/u);
  assert.match(guard, /raise exception 'BOUND_ROW_INVALID_INITIAL_STATE'/u);
  assert.match(guard, /raise exception 'BOUND_ROW_ROUTING_IMMUTABLE'/u);
  assert.match(guard, /raise exception 'UNBOUND_ROW_IN_V2_DOMAIN'/u);
  assert.match(guard, /raise exception 'LEGACY_UNPARTITIONED_CLAIM_ACTIVE'/u);
  assert.match(sql, /before insert or update on public\.scheduled_posts\s+for each row execute function public\.scheduled_posts_claim_domain_guard\(\);/u);
});

test("bound writes and v2 claims require the unpartitioned legacy claim to be retired", () => {
  const retired = definition("x_queue_legacy_claim_retired_v2");
  assert.match(retired, /to_regprocedure\('public\.claim_due_post\(\)'\)/u);
  assert.match(retired, /array\['anon', 'authenticated', 'service_role'\]/u);
  assert.match(retired, /has_function_privilege\(v_role, v_fn, 'EXECUTE'\)/u);
});

test("each public v2 name is a wrapper that enters and restores the v2 domain", () => {
  for (const name of V2_RPCS) {
    const wrapper = definition(name);
    assert.match(wrapper, /set_config\('kabumori\.x_queue_domain', 'v2', true\)/u, name);
    assert.match(wrapper, /set_config\('kabumori\.x_queue_domain', coalesce\(v_prev, ''\), true\)/u, name);
    assert.match(wrapper, new RegExp(`public\\.${name}_core\\(`, "u"), name);
  }
});

test("privileged functions use fixed search_path and API-closed EXECUTE", () => {
  const definitions = sql.match(/create function public\.[\s\S]*?\n\$\$;/gu) ?? [];
  assert.equal(definitions.length, 12);
  for (const def of definitions) assert.match(def, /security definer set search_path = ''/u);
  assert.match(sql, /from public, anon, authenticated, service_role;/u);
  assert.match(sql, /from public, anon, authenticated;/u);
  assert.doesNotMatch(sql, /grant execute on function[^;]*scheduled_posts_claim_domain_guard/u);
  assert.doesNotMatch(sql, /access_token|refresh_token|oauth_secret|vault/iu);
});

test("dispatcher is intentionally unchanged until the activation step", () => {
  assert.match(dispatcher, /"claim_due_post",/u);
  assert.doesNotMatch(dispatcher, /claim_due_post_legacy_unbound_v2|claim_due_post_v2/u);
});
