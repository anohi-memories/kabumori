import assert from "node:assert/strict";
import test from "node:test";

const MIGRATION = new URL(
  "../../migrations/20260913140000_broad_news_visibility_notification_presets.sql",
  import.meta.url,
);

function section(sql: string, start: string, end: string): string {
  const at = sql.indexOf(start);
  const to = sql.indexOf(end, at + start.length);
  assert.ok(at >= 0 && to > at, `section ${start} .. ${end} not found`);
  return sql.slice(at, to);
}

test("legacy rows are not backfilled and the dispatcher contract is preserved", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert.match(sql, /add column if not exists notification_preset text,/);
  assert.match(sql, /add column if not exists emergency_alerts boolean;/);
  assert.doesNotMatch(sql, /update public\.alert_settings/i);
  assert.doesNotMatch(sql, /claim_pending_push_notifications\s*\(/);
  assert.doesNotMatch(sql, /send-push-notifications/);
  const save = section(sql, "create or replace function public.set_my_important_news_alert_preferences", "$function$;");
  assert.match(save, /market_critical_news = excluded\.market_critical_news/);
  assert.match(save, /p_notification_preset <> 'quiet' or p_emergency_alerts/);
});

test("category settings use owner-only RLS and missing rows remain enabled", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assert.match(sql, /create table if not exists public\.alert_category_settings/);
  assert.match(sql, /alter table public\.alert_category_settings enable row level security/);
  assert.ok([...sql.matchAll(/\(select auth\.uid\(\)\) = user_id/g)].length >= 4);
  assert.match(sql, /revoke all on public\.alert_category_settings from anon/);
  assert.match(sql, /grant select, insert, update, delete on public\.alert_category_settings to authenticated/);
  const producer = section(sql, "create or replace function public.enqueue_important_news_notifications", "$$;");
  assert.match(producer, /coalesce\(category_setting\.enabled, true\)/);
  assert.match(producer, /coalesce\(cardinality\(candidate\.coverage_categories\), 0\) = 0/);
});

test("feed shows market medium+ but never low, with emergency sector bypass", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  const feed = section(sql, "create function public.get_my_important_stock_news", "$$;");
  assert.match(feed, /effective_severity in \('emergency', 'critical', 'high', 'medium'\)/);
  assert.doesNotMatch(feed, /effective_severity in \([^\n]*'low'/);
  assert.match(feed, /candidate\.effective_severity = 'emergency' or ranked\.id is not null/);
  assert.match(feed, /case when news\.app_copy_fact_status = 'passed' then news\.app_detail_ja end/);
  assert.match(feed, /news\.coverage_categories/);
});

test("producer has hard gates, preset thresholds, emergency bypass and dedupe", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  const producer = section(sql, "create or replace function public.enqueue_important_news_notifications", "$$;");
  assert.match(producer, /settings\.push_enabled = true/);
  assert.match(producer, /settings\.important_news = true/);
  assert.match(producer, /settings\.market_critical_news = true/);
  assert.match(producer, /coalesce\(settings\.emergency_alerts, false\)/);
  assert.match(producer, /case when candidate\.effective_severity = 'emergency' then null::uuid else tracked\.id end/);
  assert.match(producer, /when 'quiet' then 3 when 'standard' then 2 else 1 end/);
  assert.match(producer, /when 'quiet' then 4 when 'standard' then 3 when 'many' then 2 else 1 end/);
  assert.match(producer, /effective_severity in \('emergency', 'critical', 'high', 'medium'\)/);
  assert.match(producer, /app_copy_fact_status = 'passed'/);
  assert.match(producer, /generation_fact_status = 'passed'/);
  assert.match(producer, /public\.important_news_same_event/);
  assert.match(producer, /on conflict do nothing/);
  assert.match(sql, /grant execute on function public\.enqueue_important_news_notifications\(integer\) to service_role/);
  assert.match(sql, /revoke all on function public\.enqueue_important_news_notifications\(integer\)\s+from public, anon, authenticated, service_role/);
});
