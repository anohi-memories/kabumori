import assert from "node:assert/strict";
import test from "node:test";

const sql = await Deno.readTextFile(new URL("../../migrations/20260924023133_x_autopost_phase1b_account_bound_queue.sql", import.meta.url));

test("legacy claim/retry/fail RPC definitions remain untouched", () => {
  assert.doesNotMatch(sql, /create\s+(?:or\s+replace\s+)?function\s+public\.(?:claim_due_post|retry_scheduled_post|fail_scheduled_post)\s*\(/iu);
  assert.match(sql, /create function public\.claim_due_post_v2\(/u);
});

test("account binding is explicit, nullable for legacy rows, and enforced by a composite X FK", () => {
  assert.match(sql, /add column social_account_id text/u);
  assert.doesNotMatch(sql, /add column social_account_id text[^,;]*default/iu);
  assert.match(sql, /foreign key \(social_account_id, brand_id, target_platform\)/u);
  assert.match(sql, /generated always as \('x'::text\)/u);
  assert.match(sql, /p_social_account_id is null/u);
  assert.match(sql, /create function public\.plan_daily_posts_v2\(/u);
  assert.match(sql, /perform public\.schedule_account_bound_post_v2\(/u);
  assert.doesNotMatch(sql, /limit\s+1\s*;?\s*--\s*account/iu);
});

test("ledger records attempt identity, provider phase, canonical outcomes and X post ID", () => {
  for (const token of ["claim_token", "scheduled_post_id", "social_account_id", "provider_started_at", "x_post_id", "pre_x_retryable", "pre_x_terminal", "x_outcome_uncertain", "x_confirmed_db_incomplete", "completed"]) {
    assert.ok(sql.includes(token), token);
  }
  assert.match(sql, /unique \(scheduled_post_id, attempt_no\)/u);
  assert.match(sql, /post_queue_one_open_attempt_v2_idx/u);
  assert.doesNotMatch(sql, /access_token|refresh_token|oauth_secret|provider_raw_body/iu);
});

test("fair claim is account-scoped, locks rows, and excludes unbound work", () => {
  assert.match(sql, /order by t\.last_claim_order, t\.brand_id, t\.social_account_id/u);
  assert.match(sql, /for update of t skip locked/iu);
  assert.match(sql, /for update of s skip locked limit 1/iu);
  assert.match(sql, /s\.social_account_id is not null/u);
});

test("provider start is durable and stale reconciliation is pre-X only", () => {
  assert.match(sql, /create function public\.mark_post_provider_started_v2/u);
  assert.match(sql, /a\.phase = 'pre_x' and a\.claimed_at <= now\(\) - p_age/u);
  assert.match(sql, /if p_age is null or p_age < interval '15 minutes'/u);
  assert.match(sql, /v_attempt\.phase <> 'provider_started'/u);
});

test("privileged v2 RPCs use fixed search_path and service_role-only EXECUTE", () => {
  const definitions = sql.match(/create function public\.[\s\S]*?\$\$;/gu) ?? [];
  assert.equal(definitions.length, 9);
  for (const definition of definitions) {
    assert.match(definition, /security definer set search_path = ''/u);
  }
  assert.match(sql, /from public, anon, authenticated/u);
  assert.match(sql, /to service_role;/u);
});
