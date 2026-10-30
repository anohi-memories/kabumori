-- READ-ONLY. Source rows for tools/provider-compare/fixtures/cases.json.
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_cases.sql
-- then reshape with scripts/build_cases.ts. Only the candidate columns below are read; nothing is written.
-- The id prefixes and titles are the 22 cases chosen on 2026-10-09 (see CASE_META in build_cases.ts).
with picks as (
  select c.* from public.important_news_candidates c
  where left(c.id::text, 8) in ('91569af5','7207a56d','d09c88ce','60d9954a','0b73ef94','44df218f','4887f2b0','84832da2','2f881cde','26648baf','b5a10bac','3a1fe802','f4a8a7cc','e956ae92','8792253b','1533a3fd')
  union
  select c.* from public.important_news_candidates c
  where c.title in ('Bank of Japan raises benchmark interest rate to 1.25%', 'North Korea launches unidentified projectile toward the sea')
     or c.title like 'Japan finance minister says no formal U.S. request%'
     or (c.source_name = 'market_macro' and c.title = '金融市場調節方針の変更について' and c.created_at >= timestamptz '2026-09-18 00:00:00+09' and c.created_at < timestamptz '2026-09-19 00:00:00+09')
  union
  (select c.* from public.important_news_candidates c where c.source_type = 'tdnet' and c.importance = 'no_post' and c.title like '%に関する日々の開示事項%' and c.body_summary is not null order by c.created_at desc limit 1)
  union
  (select c.* from public.important_news_candidates c where c.source_name = 'market_macro' and c.category = 'boj' and c.importance = 'no_post' and c.title like '%【挨拶】%' order by c.created_at desc limit 1)
)
select id, source_type, source_name, source_url, title, body_summary, company_name, company_code, entity_key, category, published_at,
  importance, status, japan_market_relevance, judgement_model, escalated_to_sol, confidence, judgement_reason, fact_check_status, affected_entities,
  generated_text, generation_model, generation_fact_status, generation_voice_status, generation_error, generation_fact_issues, generation_voice_issues
from picks order by published_at;
