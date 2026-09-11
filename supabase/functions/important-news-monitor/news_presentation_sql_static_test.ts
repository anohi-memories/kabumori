import assert from "node:assert/strict";
import test from "node:test";

// The presentation migration may only ADD the two display columns. Which items
// appear (per-stock and market-wide conditions), their order and limit must be
// exactly the Phase 3 query.
const PHASE3 = new URL("../../migrations/20260911120000_market_relevance_news_feed.sql", import.meta.url);
const PHASE4 = new URL("../../migrations/20260911150000_news_feed_presentation_fields.sql", import.meta.url);

function section(sql: string, start: string, end: string): string {
  const from = sql.indexOf(start);
  const to = sql.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `section ${start} .. ${end} not found`);
  return sql.slice(from, to);
}

function normalize(value: string): string {
  return value.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

test("per-stock selection is the Phase 3 query unchanged", async () => {
  const [p3, p4] = await Promise.all([Deno.readTextFile(PHASE3), Deno.readTextFile(PHASE4)]);
  const bounds: [string, string] = ["from public.tracked_stocks as tracked", "where feed.severity in ('critical', 'high', 'medium')"];
  assert.equal(normalize(section(p4, ...bounds)), normalize(section(p3, ...bounds)));
});

test("market-wide selection is the Phase 3 query unchanged", async () => {
  const [p3, p4] = await Promise.all([Deno.readTextFile(PHASE3), Deno.readTextFile(PHASE4)]);
  for (const bounds of [
    ["from public.important_news_candidates as news\n    cross join lateral", "market_feed as ("],
    ["from market_candidates as candidate", "select\n    combined.news_id"],
    ["from (\n    select * from company_feed", "$$;"],
  ] as Array<[string, string]>) {
    assert.equal(normalize(section(p4, ...bounds)), normalize(section(p3, ...bounds)), bounds[0]);
  }
});

test("generated text is exposed only when its Fact check passed", async () => {
  const sql = await Deno.readTextFile(PHASE4);
  const uses = [...sql.matchAll(/generated_text/g)].length;
  const guarded = [...sql.matchAll(/case when news\.generation_fact_status = 'passed' then news\.generated_text end as verified_text/g)].length;
  assert.equal(guarded, 2, "both CTEs must guard generated_text");
  assert.equal(uses, guarded, "generated_text must not appear anywhere unguarded");
});

test("one transaction, no row writes, same grant model", async () => {
  const sql = await Deno.readTextFile(PHASE4);
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.doesNotMatch(sql, /\b(update|insert|delete)\s+(into\s+|from\s+)?public\./i);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = ''/);
  assert.match(sql, /grant execute on function public\.get_my_important_stock_news\(integer\)\s+to authenticated;/);
  for (const forbidden of ["notifications", "net.http_post", "cron.", "auto_publish", "x_post_id"]) {
    assert.ok(!sql.includes(forbidden), forbidden);
  }
});
