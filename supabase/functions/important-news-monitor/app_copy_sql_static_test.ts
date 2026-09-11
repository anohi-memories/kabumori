import assert from "node:assert/strict";
import test from "node:test";

const PHASE4 = new URL("../../migrations/20260911150000_news_feed_presentation_fields.sql", import.meta.url);
const APP_COPY = new URL("../../migrations/20260911170000_news_app_copy_ja.sql", import.meta.url);

function section(sql: string, start: string, end: string, from = 0): string {
  const at = sql.indexOf(start, from);
  const to = sql.indexOf(end, at + start.length);
  assert.ok(at >= 0 && to > at, `section ${start} .. ${end} not found`);
  return sql.slice(at, to);
}

function normalize(value: string): string {
  return value.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

test("app copy columns leave the feed only when their own Fact check passed", async () => {
  const sql = await Deno.readTextFile(APP_COPY);
  const rpc = sql.slice(sql.indexOf("create function public.get_my_important_stock_news"));
  for (const column of ["app_title_ja", "app_summary_ja", "app_detail_ja", "app_key_points_ja"]) {
    const guarded = [...rpc.matchAll(new RegExp(
      `case when news\\.app_copy_fact_status = 'passed' then news\\.${column} end as ${column}`, "g"))].length;
    const raw = [...rpc.matchAll(new RegExp(`news\\.${column}\\b`, "g"))].length;
    assert.equal(guarded, 2, `${column} must be guarded in both CTEs`);
    assert.equal(raw, guarded, `${column} must never be read unguarded`);
  }
  // Generated X text stays guarded by its own Fact status as before.
  assert.equal([...rpc.matchAll(/news\.generated_text/g)].length, 2);
  assert.equal([...rpc.matchAll(/case when news\.generation_fact_status = 'passed' then news\.generated_text end/g)].length, 2);
});

test("which items appear, their order and limit are the previous query unchanged", async () => {
  const [before, after] = await Promise.all([Deno.readTextFile(PHASE4), Deno.readTextFile(APP_COPY)]);
  const afterRpc = after.slice(after.indexOf("create function public.get_my_important_stock_news"));
  for (const bounds of [
    ["from public.tracked_stocks as tracked", "where feed.severity in ('critical', 'high', 'medium')"],
    ["from public.important_news_candidates as news\n    cross join lateral", "market_feed as ("],
    ["from market_candidates as candidate", "select\n    combined.news_id"],
    ["from (\n    select * from company_feed", "$$;"],
  ] as Array<[string, string]>) {
    assert.equal(normalize(section(afterRpc, ...bounds)), normalize(section(before, ...bounds)), bounds[0]);
  }
});

test("the schema change is expand-only and writes no rows", async () => {
  const sql = await Deno.readTextFile(APP_COPY);
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  const alter = section(sql, "alter table public.important_news_candidates", ";");
  for (const clause of alter.split(/,\n/)) {
    assert.match(clause.trim(), /^(alter table public\.important_news_candidates\s+)?add column if not exists /, clause);
  }
  assert.doesNotMatch(sql, /\bdrop column\b|\balter column\b|\brename\b/i);
  assert.doesNotMatch(sql, /\b(update|insert|delete)\s+(into\s+|from\s+)?public\./i);
  for (const forbidden of ["notifications", "net.http_post", "cron.", "auto_publish", "x_post_id"]) {
    assert.ok(!sql.includes(forbidden), forbidden);
  }
});

test("the target selector is service-role only and picks only items without usable Japanese", async () => {
  const sql = await Deno.readTextFile(APP_COPY);
  assert.match(sql, /revoke all on function public\.important_news_app_copy_targets\(integer\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.important_news_app_copy_targets\(integer\) to service_role;/);
  const fn = section(sql, "create or replace function public.important_news_app_copy_targets", "$$;");
  assert.match(fn, /news\.title !~ '\[ぁ-んァ-ヶ一-龠\]'/);
  assert.match(fn, /not \(news\.generation_fact_status = 'passed' and coalesce\(btrim\(news\.generated_text\), ''\) <> ''\)/);
  assert.match(fn, /news\.app_copy_fact_status is null/);
  assert.match(fn, /news\.app_copy_attempts = 0/);
  // Same visibility gates as the feed.
  assert.match(fn, /tracked\.is_active = true/);
  assert.match(fn, /news\.japan_market_relevance in \('medium', 'high'\)/);
  assert.match(fn, /\) in \('critical', 'high'\)/);
  assert.match(fn, /least\(coalesce\(p_limit, 5\), 20\)/);
});

test("the feed grant model is unchanged", async () => {
  const sql = await Deno.readTextFile(APP_COPY);
  assert.match(sql, /grant execute on function public\.get_my_important_stock_news\(integer\)\s+to authenticated;/);
  assert.match(sql, /revoke all on function public\.get_my_important_stock_news\(integer\)\s+from public, anon, authenticated, service_role;/);
});
