import assert from "node:assert/strict";
import test from "node:test";
import { CORPORATE_IR_SUBTYPE_RULES } from "./news_severity_logic.ts";

// The /news feed derives severity in SQL (public.important_news_app_severity and
// public.important_news_ir_subtype). These tests keep that SQL a verbatim mirror
// of news_severity_logic.ts so the two cannot drift apart silently.
const MIGRATION = new URL(
  "../../migrations/20260911090000_app_severity_news_feed.sql",
  import.meta.url,
);

async function migrationSql(): Promise<string> {
  return await Deno.readTextFile(MIGRATION);
}

test("every IR subtype pattern appears verbatim, in the same order, in the SQL mirror", async () => {
  const sql = await migrationSql();
  let cursor = 0;
  for (const rule of CORPORATE_IR_SUBTYPE_RULES) {
    const needle = `when t ~ '${rule.pattern.source}' then '${rule.subtype}'`;
    const at = sql.indexOf(needle, cursor);
    assert.ok(at >= 0, `SQL is missing or reorders: ${needle}`);
    cursor = at + needle.length;
  }
});

test("the SQL mirror uses the same holder-relevant company categories as the TS taxonomy", async () => {
  const { NEWS_CATEGORY_TAXONOMY } = await import("./news_severity_logic.ts");
  const sql = await migrationSql();
  const block = sql.slice(sql.indexOf("p_category in ("), sql.indexOf(") as holder_category"));
  const sqlCategories = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const tsCategories = Object.entries(NEWS_CATEGORY_TAXONOMY)
    .filter(([, entry]) => entry.holderRelevant)
    .map(([category]) => category)
    .sort();
  assert.deepEqual(sqlCategories, tsCategories);
});

test("the SQL mirror shows exactly the TS holder-visible IR subtypes", async () => {
  const sql = await migrationSql();
  const block = sql.slice(sql.indexOf("when ir_subtype in ("), sql.indexOf(") then 'medium'", sql.indexOf("when ir_subtype in (")));
  const sqlSubtypes = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const visible = CORPORATE_IR_SUBTYPE_RULES.map((rule) => rule.subtype)
    .filter((subtype) => subtype !== "debt_financing")
    .sort();
  assert.deepEqual(sqlSubtypes, visible);
});

test("the feed keeps its safety boundaries", async () => {
  const sql = await migrationSql();
  // Only the user's own active tracked stocks, never duplicates.
  assert.match(sql, /tracked\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(sql, /tracked\.is_active = true/);
  assert.match(sql, /news\.duplicate_of is null/);
  // Joined to tracked stocks by ticker, so company_code-less market news cannot appear.
  assert.match(sql, /left\(news\.company_code, 4\) = stock\.ticker_code/);
  // A rejected row only from an official disclosure source.
  assert.match(sql, /news\.status <> 'rejected' or news\.source_type in \('tdnet', 'company_ir'\)/);
  // Low is never shown.
  assert.match(sql, /feed\.severity in \('critical', 'high', 'medium'\)/);
  // Same grant model as before: authenticated only, helpers not callable directly.
  assert.match(sql, /grant execute on function public\.get_my_important_stock_news\(integer\)\s+to authenticated;/);
  assert.match(sql, /revoke all on function public\.important_news_app_severity/);
  assert.match(sql, /revoke all on function public\.important_news_ir_subtype/);
  // The whole change is one transaction and touches no rows.
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.doesNotMatch(sql, /\b(update|insert|delete)\s+(into\s+|from\s+)?public\.important_news_candidates/i);
});
