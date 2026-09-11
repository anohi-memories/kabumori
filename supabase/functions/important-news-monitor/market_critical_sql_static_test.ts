import assert from "node:assert/strict";
import test from "node:test";

const PREVIOUS = new URL("../../migrations/20260911170000_news_app_copy_ja.sql", import.meta.url);
const PHASE4 = new URL("../../migrations/20260911200000_market_critical_alerts_dedupe.sql", import.meta.url);
const INDEX = new URL("./index.ts", import.meta.url);

function section(sql: string, start: string, end: string, from = 0): string {
  const at = sql.indexOf(start, from);
  const to = sql.indexOf(end, at + start.length);
  assert.ok(at >= 0 && to > at, `section ${start} .. ${end} not found`);
  return sql.slice(at, to);
}

function normalize(value: string): string {
  return value.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

function rpcOf(sql: string): string {
  return sql.slice(sql.indexOf("create function public.get_my_important_stock_news"));
}

test("the market alert setting is opt-in: default false, user-editable column only", async () => {
  const sql = await Deno.readTextFile(PHASE4);
  assert.match(sql, /add column if not exists market_critical_news boolean not null default false;/);
  assert.match(sql, /grant select, insert, update \(market_critical_news\) on public\.alert_settings to authenticated;/);
  assert.doesNotMatch(sql, /\b(drop|alter) column\b/i);
});

test("the producer targets only opted-in, fully enabled users and only fresh Critical market items", async () => {
  const sql = await Deno.readTextFile(PHASE4);
  const fn = section(sql, "create or replace function public.enqueue_market_critical_notifications", "$$;");
  assert.match(fn, /settings\.market_critical_news = true/);
  assert.match(fn, /settings\.push_enabled = true/);
  assert.match(fn, /settings\.important_news = true/);
  assert.match(fn, /news\.company_code is null/);
  assert.match(fn, /news\.duplicate_of is null/);
  assert.match(fn, /\) = 'critical'/);
  // high/medium market items are never pushed: severity is compared to 'critical' only.
  assert.doesNotMatch(fn, /\) in \('critical', 'high'/);
  assert.equal([...fn.matchAll(/important_news_app_severity\(/g)].length, 1);
  assert.match(fn, /news\.japan_market_relevance in \('medium', 'high'\)/);
  assert.match(fn, /news\.published_at >= now\(\) - make_interval\(hours =>/);
  assert.match(fn, /p_window_hours integer default 6/);
  // Related Critical only: the recipient must track a sector the item reaches.
  assert.match(fn, /stock\.sector = any\(public\.important_news_theme_sectors\(t\.themes\)\)/);
  assert.match(fn, /cardinality\(e\.themes\) > 0/);
  // Fact-gated Japanese text only.
  assert.match(fn, /case when news\.app_copy_fact_status = 'passed' then nullif\(btrim\(news\.app_title_ja\), ''\) end/);
  assert.match(fn, /case when news\.app_copy_fact_status = 'passed' then nullif\(btrim\(news\.app_summary_ja\), ''\) end/);
  assert.match(fn, /case when news\.generation_fact_status = 'passed' then nullif\(btrim\(/);
  assert.equal([...fn.matchAll(/news\.app_(title|summary|detail)_ja/g)].length, 2, "no unguarded app copy");
  // Never twice: same news id, or the same event from another source.
  assert.match(fn, /sent\.source_id = t\.id::text/);
  assert.match(fn, /public\.important_news_same_event\(prior\.category/);
  assert.match(fn, /on conflict \(user_id, tracked_stock_id, source_type, source_id\) do nothing/);
  assert.match(fn, /'important_news',/);
  // Service role only.
  assert.match(sql, /revoke all on function public\.enqueue_market_critical_notifications\(integer\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.enqueue_market_critical_notifications\(integer\) to service_role;/);
});

test("the per-stock feed and the market eligibility are the previous query unchanged", async () => {
  const [before, after] = await Promise.all([Deno.readTextFile(PREVIOUS), Deno.readTextFile(PHASE4)]);
  const beforeRpc = rpcOf(before);
  const afterRpc = rpcOf(after);
  for (const bounds of [
    ["from public.tracked_stocks as tracked", "where feed.severity in ('critical', 'high', 'medium')"],
    ["from public.important_news_candidates as news\n    cross join lateral", "),\n  market_"],
  ] as Array<[string, string]>) {
    assert.equal(normalize(section(afterRpc, ...bounds)), normalize(section(beforeRpc, ...bounds)), bounds[0]);
  }
  assert.match(afterRpc, /order by combined\.news_time desc\s+limit greatest\(1, least\(coalesce\(p_limit, 50\), 50\)\);/);
});

test("market items are deduped by event and sectors are ranked by tracked-stock count", async () => {
  const sql = await Deno.readTextFile(PHASE4);
  const rpc = rpcOf(sql);
  assert.match(rpc, /public\.important_news_same_event\(other\.category, other\.title, other\.news_time,/);
  assert.match(rpc, /array_agg\(matches\.sector order by matches\.stock_count desc, matches\.has_holding desc, matches\.sector\)/);
  assert.match(rpc, /ranked\.sectors\[1:3\] as matched_sectors/);
  const signature = section(sql, "create or replace function public.important_news_number_signature", "$$;");
  assert.match(signature, /count\(\*\) >= 2/, "a single number never identifies an event");
  assert.match(signature, /\^\(19\|20\)\[0-9\]\{2\}\$/, "years are ignored");
  const same = section(sql, "create or replace function public.important_news_same_event", "$$;");
  assert.match(same, /p_category_a = p_category_b/);
  assert.match(same, /<= 72 \* 3600/);
});

test("fact gates, grants and no writes to candidates", async () => {
  const sql = await Deno.readTextFile(PHASE4);
  const rpc = rpcOf(sql);
  for (const column of ["app_title_ja", "app_summary_ja", "app_detail_ja", "app_key_points_ja"]) {
    const raw = [...rpc.matchAll(new RegExp(`news\\.${column}\\b`, "g"))].length;
    const guarded = [...rpc.matchAll(new RegExp(
      `case when news\\.app_copy_fact_status = 'passed' then news\\.${column} end`, "g"))].length;
    assert.equal(raw, guarded, column);
  }
  assert.match(sql, /grant execute on function public\.get_my_important_stock_news\(integer\)\s+to authenticated;/);
  assert.doesNotMatch(sql, /\b(update|delete)\s+(from\s+)?public\.important_news_candidates/i);
  assert.doesNotMatch(sql, /insert into public\.important_news_candidates/i);
  for (const forbidden of ["net.http_post", "cron.", "auto_publish", "x_post_id"]) {
    assert.ok(!sql.includes(forbidden), forbidden);
  }
});

test("important-news-monitor calls the producer only on real runs, after publish or app copy", async () => {
  const index = await Deno.readTextFile(INDEX);
  const calls = [...index.matchAll(/await enqueueMarketCriticalNotifications\(/g)].length;
  assert.equal(calls, 3, "generate_ready (two exits) and publish_ready");
  assert.match(index, /const marketCritical = dryRun \? undefined : await enqueueMarketCriticalNotifications/);
  assert.match(index, /const marketCritical = result\.published\s+\? await enqueueMarketCriticalNotifications/);
  // The dry-run and notification preview modes never enqueue.
  const dryRunMode = section(index, 'if (body.mode === "app_copy_dry_run")', 'if (body.mode === "notification_enqueue_dry_run")');
  assert.ok(!dryRunMode.includes("enqueueMarketCriticalNotifications"));
});
