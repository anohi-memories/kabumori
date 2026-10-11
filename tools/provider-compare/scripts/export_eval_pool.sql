-- READ-ONLY. Stage 1 of the Phase 3 evaluation-set expansion: titles and metadata only, no bodies.
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_eval_pool.sql
-- Population: AI-judged rows (judgement_model is not null) created in the 2026-08-31 .. 2026-10-10 JST window, excluding
-- the 22 existing fixtures. Within each pool the order is a seeded md5 hash, so the pick is reproducible and is not biased
-- toward recent or high-confidence rows. A chosen id is exported in full by export_eval_rows.sql (stage 2).
with base as (
  select id, created_at, source_type, source_name, category, importance, status, confidence, escalated_to_sol,
         judgement_model, left(title, 90) as title
  from public.important_news_candidates
  where created_at >= timestamptz '2026-08-31 00:00:00+09'
    and created_at <  timestamptz '2026-10-10 12:00:00+09'
    and judgement_model is not null
    and left(id::text, 8) not in ('25c28b26','a989d1f3','cafc0f82','090e8d18','84832da2','26648baf','e956ae92','f4a8a7cc',
      'a3dac612','1533a3fd','4887f2b0','0b73ef94','3a1fe802','d09c88ce','60d9954a','7207a56d','91569af5','8792253b',
      '44df218f','2f881cde','201cf3c7','b5a10bac')
),
tagged as (
  select 'tdnet_nopost_signal' as pool, * from base
   where source_name = 'tdnet' and importance = 'no_post'
     and title ~ '(公開買付|上場廃止|民事再生|破産|会社更生|特別損失|業績予想|配当予想|自己株式|第三者割当|合併|株式交換|株式移転|経営統合|行政処分|課徴金|不正|不祥事|調査委員会|訴訟|リコール|事故|増資|減資|債務超過|監理|整理|臨時株主総会|代表取締役の異動|提携|買収|子会社化|譲渡)'
  union all
  select 'macro_nopost', * from base where source_name in ('market_macro', 'jp_official') and importance = 'no_post'
  union all
  select 'tdnet_posted', * from base where source_name = 'tdnet' and importance in ('important', 'most_important')
  union all
  select 'intl_posted', * from base where source_name in ('bbc_world', 'al_jazeera', 'breaking_market') and importance in ('important', 'most_important')
  union all
  select 'intl_nopost_borderline', * from base where source_name in ('bbc_world', 'al_jazeera', 'breaking_market') and importance = 'no_post' and (confidence < 0.8 or escalated_to_sol)
  union all
  select 'tdnet_nopost_borderline', * from base where source_name = 'tdnet' and importance = 'no_post' and (confidence < 0.7 or escalated_to_sol)
),
ranked as (
  select *, row_number() over (partition by pool order by md5(id::text || 'kabumori-eval-pool-v3')) as rn,
         count(*) over (partition by pool) as pool_size
  from tagged
)
select pool, pool_size, left(id::text, 8) as id8, (created_at at time zone 'Asia/Tokyo')::timestamp(0) as created_jst,
       source_name, category, importance, confidence, escalated_to_sol, judgement_model, title
from ranked
where rn <= case pool when 'macro_nopost' then 70 when 'tdnet_nopost_signal' then 55 else 45 end
order by pool, rn;
