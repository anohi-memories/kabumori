import assert from "node:assert/strict";
import test from "node:test";

// Static guards for the Phase 3 feed migration. The relevance mapping lives only
// in SQL; its behaviour is exercised against production data in a rolled-back
// transaction before apply. These tests pin the safety boundaries in the file.
const PHASE2 = new URL("../../migrations/20260911090000_app_severity_news_feed.sql", import.meta.url);
const PHASE3 = new URL("../../migrations/20260911120000_market_relevance_news_feed.sql", import.meta.url);

function section(sql: string, start: string, end: string): string {
  const from = sql.indexOf(start);
  const to = sql.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `section ${start} .. ${end} not found`);
  return sql.slice(from, to);
}

function normalize(value: string): string {
  return value.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

test("the per-stock feed is the Phase 2 query unchanged", async () => {
  const phase2 = await Deno.readTextFile(PHASE2);
  const phase3 = await Deno.readTextFile(PHASE3);
  const p2 = normalize(section(phase2, "from public.tracked_stocks as tracked", "where feed.severity in ('critical', 'high', 'medium')"));
  const p3 = normalize(section(phase3, "from public.tracked_stocks as tracked", "where feed.severity in ('critical', 'high', 'medium')"));
  assert.equal(p3, p2);
});

test("market items need company_code null, critical/high, a stated Japan effect and a tracked-sector match", async () => {
  const sql = await Deno.readTextFile(PHASE3);
  const candidates = section(sql, "market_candidates as (", "market_feed as (");
  assert.match(candidates, /news\.company_code is null/);
  assert.match(candidates, /news\.duplicate_of is null/);
  assert.match(candidates, /news\.japan_market_relevance in \('medium', 'high'\)/);
  assert.match(candidates, /assessed\.severity in \('critical', 'high'\)/);
  assert.doesNotMatch(candidates, /'medium'\s*\)\s*$/m, "medium severity must not be admitted for market items");
  // A rejected market item never qualifies.
  const statusList = section(candidates, "news.status in (", ")");
  assert.ok(!statusList.includes("'rejected'"));

  const feed = section(sql, "market_feed as (", "select\n    combined.news_id");
  assert.match(feed, /select distinct on \(candidate\.id\)/);
  assert.match(feed, /tracked\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(feed, /tracked\.is_active = true/);
  assert.match(feed, /stock\.sector = any\(public\.important_news_theme_sectors\(candidate\.themes\)\)/);
  assert.match(feed, /cardinality\(candidate\.themes\) > 0/);
});

test("every sector in the theme mapping is a real TSE 33-sector name", async () => {
  const sql = await Deno.readTextFile(PHASE3);
  const mapping = section(sql, "from (values\n    ('oil_energy'", ") as mapping(theme, sector)");
  const sectors = [...mapping.matchAll(/\('[a-z_]+', '([^']+)'\)/g)].map((m) => m[1]);
  const TSE33 = new Set([
    "水産・農林業", "鉱業", "建設業", "食料品", "繊維製品", "パルプ・紙", "化学", "医薬品", "石油・石炭製品",
    "ゴム製品", "ガラス・土石製品", "鉄鋼", "非鉄金属", "金属製品", "機械", "電気機器", "輸送用機器", "精密機器",
    "その他製品", "電気・ガス業", "陸運業", "海運業", "空運業", "倉庫・運輸関連業", "情報・通信業", "卸売業",
    "小売業", "銀行業", "証券、商品先物取引業", "保険業", "その他金融業", "不動産業", "サービス業",
  ]);
  assert.ok(sectors.length > 0);
  for (const sector of sectors) assert.ok(TSE33.has(sector), `not a TSE 33-sector name: ${sector}`);
});

test("the migration is one transaction, writes no rows and keeps the grant model", async () => {
  const sql = await Deno.readTextFile(PHASE3);
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.doesNotMatch(sql, /\b(update|insert|delete)\s+(into\s+|from\s+)?public\./i);
  assert.match(sql, /revoke all on function public\.important_news_market_themes/);
  assert.match(sql, /revoke all on function public\.important_news_theme_sectors/);
  assert.match(sql, /grant execute on function public\.get_my_important_stock_news\(integer\)\s+to authenticated;/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = ''/);
  // Order and limit as before.
  assert.match(sql, /order by combined\.news_time desc\s+limit greatest\(1, least\(coalesce\(p_limit, 50\), 50\)\);/);
});

test("no AI call, source or push path is introduced", async () => {
  const sql = await Deno.readTextFile(PHASE3);
  for (const forbidden of ["notifications", "net.http_post", "cron.", "auto_publish", "x_post_id"]) {
    assert.ok(!sql.includes(forbidden), `migration must not touch ${forbidden}`);
  }
});
