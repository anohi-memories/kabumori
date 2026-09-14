import assert from "node:assert/strict";
import test from "node:test";

const migrationPath = new URL(
  "../../../supabase/migrations/20260917120000_broad_news_phase5_all_useful_scope_and_run_diagnostics.sql",
  import.meta.url,
);
const migration = await Deno.readTextFile(migrationPath);

test("Phase 5 migration is review-only, additive for diagnostics, and preserves base RPCs privately", () => {
  assert.match(migration, /begin;[\s\S]*alter table public\.important_news_monitor_runs\s+add column if not exists diagnostics jsonb not null default '\{\}'::jsonb;/i);
  assert.match(migration, /rename to important_news_app_copy_targets_phase5_base/i);
  assert.match(migration, /rename to get_my_important_stock_news_phase5_base/i);
  assert.match(migration, /rename to enqueue_important_news_notifications_phase5_base/i);
  assert.match(migration, /revoke all on function public\.get_my_important_stock_news_phase5_base\(integer\)[\s\S]*?from public, anon, authenticated, service_role/i);
  assert.match(migration, /commit;\s*$/i);
  assert.match(migration, /C2 review only; do not apply to\s+-- production/i);
});

test("all_useful app feed/copy adds only unmatched market medium+ and keeps Japanese text Fact-gated", () => {
  assert.match(migration, /settings\.notification_preset = 'all_useful'/i);
  assert.match(migration, /candidate\.effective_severity in \('critical', 'high', 'medium'\)/i);
  assert.match(migration, /'market'::text as tracking_type/i);
  assert.match(migration, /news\.generation_fact_status = 'passed'/i);
  assert.match(migration, /news\.app_copy_fact_status = 'passed'/i);
  assert.match(migration, /candidate\.app_copy_attempts = 0/i);
  assert.match(migration, /low remains excluded|all_useful users without sector matching/i);
  const feed = migration.slice(migration.indexOf("create function public.get_my_important_stock_news("));
  const broadFeed = feed.slice(feed.indexOf("broad_feed as ("), feed.indexOf("select combined.*"));
  assert.match(broadFeed, /settings\.user_id = \(select auth\.uid\(\)\)/i);
  assert.doesNotMatch(broadFeed, /public\.tracked_stocks/i);
});

test("all_useful push scope retains push, important-news, category, freshness, Fact, event, and row dedupe gates", () => {
  const producer = migration.slice(migration.indexOf("create function public.enqueue_important_news_notifications("));
  assert.match(producer, /settings\.push_enabled = true/i);
  assert.match(producer, /settings\.important_news = true/i);
  assert.match(producer, /settings\.notification_preset = 'all_useful'/i);
  assert.match(producer, /news\.app_copy_fact_status = 'passed'/i);
  assert.match(producer, /news\.generation_fact_status = 'passed'/i);
  assert.match(producer, /make_interval\(hours => greatest\(1, least\(coalesce\(p_window_hours, 6\), 24 \* 30\)\)\)/i);
  assert.match(producer, /public\.important_news_same_event/i);
  assert.match(producer, /not exists \([\s\S]*?from public\.notifications as sent/i);
  assert.match(producer, /on conflict do nothing/i);
  assert.match(producer, /candidate\.effective_severity in \('critical', 'high', 'medium'\)/i);
  assert.doesNotMatch(producer, /settings\.market_critical_news = true/i);
  assert.match(producer, /coalesce\(settings\.emergency_alerts, false\)/i);
});
