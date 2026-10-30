-- READ-ONLY. Candidate pools for the evaluation-set gaps listed in the manifest (scripts/eval_manifest.ts).
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_gap_candidates.sql
-- Returns one row per (gap kind, candidate) from the last 30 days, at most 15 per kind, newest first. Only columns of
-- public.important_news_candidates are read; nothing is written. Bodies are NOT selected (titles and metadata only):
-- a chosen candidate is exported with export_cases.sql and sanitised by build_cases.ts.
with base as (
  select id, created_at, source_type, source_name, category, importance, status, confidence, escalated_to_sol,
         left(title, 100) as title, normalized_title, body_summary, judgement_reason
  from public.important_news_candidates
  where created_at >= now() - interval '30 days'
),
tagged as (
  select 'negatives_and_borderline' as kind, * from base where importance = 'no_post' and (confidence < 0.7 or escalated_to_sol)
  union all
  select 'jp_official_no_post', * from base where source_name = 'jp_official' and importance = 'no_post'
  union all
  select 'market_macro_policy_no_post', * from base where source_name = 'market_macro' and category in ('boj', 'frb', 'interest_rates', 'us_government_policy', 'tariffs', 'sanctions') and importance = 'no_post'
  union all
  select 'foreign_currency_amounts', * from base where source_type = 'tdnet' and importance <> 'no_post' and body_summary ~ '(米ドル|[0-9][0-9,.]*\s*(百万|億)?ドル|ユーロ|USD|EUR)'
  union all
  select 'loss_or_negative_figures', * from base where source_type = 'tdnet' and importance <> 'no_post' and body_summary ~ '(△|▲|赤字|損失|下方修正)'
  union all
  select 'withdrawn_cancelled_postponed', * from base where source_type = 'tdnet' and (title ~ '(撤回|中止|延期|取消|解消)' or body_summary ~ '(撤回|中止|延期|否決)')
  union all
  select 'subject_ambiguity', * from base where source_type = 'tdnet' and importance <> 'no_post' and body_summary ~ '(子会社|親会社|傘下)' and category in ('ma', 'tob', 'misconduct', 'business_alliance', 'capital_alliance')
  union all
  select 'large_ma_tob', * from base where category in ('tob', 'ma') and importance <> 'no_post'
  union all
  select 'financial_system_and_listing', * from base where title ~ '(上場廃止|特別注意|整理銘柄|監理銘柄|破綻|預金)' or category = 'major_shareholder' and importance = 'most_important'
  union all
  select 'domestic_disaster_infrastructure', * from base where source_name in ('jma_eqvol', 'jp_official') and category in ('disaster', 'major_security_incident')
  union all
  select 'us_policy_tariff_sanctions', * from base where category in ('us_government_policy', 'tariffs', 'sanctions') and importance <> 'no_post'
),
ranked as (
  select *, row_number() over (partition by kind order by created_at desc) as rn,
         count(*) over (partition by kind) as available
  from tagged
)
select kind, available, id, (created_at at time zone 'Asia/Tokyo')::timestamp(0) as created_jst, source_name, category, importance, status,
       confidence, escalated_to_sol, title
from ranked where rn <= 15
order by kind, created_at desc;
