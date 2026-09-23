import assert from "node:assert/strict";
import test from "node:test";

const migrationPath = new URL(
  "../../migrations/20260922110000_important_news_app_copy_v2_source_backed_candidates.sql",
  import.meta.url,
);
const migration = await Deno.readTextFile(migrationPath);

test("V2 selector is review-only and keeps service-role/feed boundaries", () => {
  assert.match(migration, /C1 review only; do not apply in H1/i);
  assert.match(migration, /create or replace function public\.important_news_app_copy_targets\(p_limit integer default 5\)/i);
  assert.match(migration, /public\.important_news_app_copy_targets_phase5_base\(20\)/i);
  assert.match(migration, /news\.app_copy_fact_status is null/i);
  assert.match(migration, /news\.app_copy_attempts = 0/i);
  assert.match(migration, /news\.title !~ '\[ぁ-んァ-ヶ一-龠\]'/i);
  assert.match(migration, /coalesce\(btrim\(news\.body_summary\), ''\) <> ''/i);
  assert.match(migration, /grant execute on function public\.important_news_app_copy_targets\(integer\)\s+to service_role;/i);
  assert.doesNotMatch(migration, /\b(update|insert|delete)\s+(into\s+|from\s+)?public\./i);
  assert.doesNotMatch(migration, /notifications|net\.http_post|cron\.|x_post_id/i);
});

test("V2 deliberately does not exclude a Fact-passed generated post", () => {
  const selector = migration.slice(migration.indexOf("with base_targets as ("));
  assert.doesNotMatch(selector, /not \(.*generation_fact_status = 'passed'/s);
  assert.match(selector, /source_company as \(/i);
  assert.match(selector, /source_market as \(/i);
  assert.match(selector, /broad_targets as \(/i);
});
