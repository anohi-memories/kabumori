-- READ-ONLY. Follow-up title searches used after export_eval_pool.sql to find candidates for the thin areas
-- (regulator / misconduct / TOB / official macro / US policy). Titles and metadata only; no bodies.
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_eval_pool_followup.sql
-- Run each statement on its own (the CLI takes one statement per file); they are kept together for the record.

-- (1) event-type keywords across the whole window, seeded order
select left(id::text, 8) as id8, source_name, importance, round(confidence::numeric, 2) as conf, escalated_to_sol as sol, category,
       (created_at at time zone 'Asia/Tokyo')::date as d, left(title, 100) as title
from public.important_news_candidates
where created_at >= timestamptz '2026-08-31 00:00:00+09' and created_at < timestamptz '2026-10-10 12:00:00+09' and judgement_model is not null
  and (
    title ~ '(上場廃止|特別注意|整理銘柄|監理銘柄|破綻|預金保険|金融庁|課徴金|行政処分|業務改善|公開買付|TOB|民事再生|破産|会社更生|債務超過|不適切な会計|過年度|訴訟|提訴|リコール|立入検査|強制調査|制裁|関税)'
    or (source_name = 'jp_official' and importance <> 'no_post')
    or category in ('tob', 'litigation', 'administrative_action', 'misconduct')
  )
order by md5(id::text || 'kabumori-eval-pool-b'), created_at
limit 70;

-- (2) official and market-macro items production posted
select left(id::text, 8) as id8, source_name, importance, round(confidence::numeric, 2) as conf, escalated_to_sol as sol, category,
       (created_at at time zone 'Asia/Tokyo')::date as d, left(title, 100) as title
from public.important_news_candidates
where created_at >= timestamptz '2026-08-31 00:00:00+09' and created_at < timestamptz '2026-10-10 12:00:00+09' and judgement_model is not null
  and source_name in ('market_macro', 'jp_official') and importance <> 'no_post'
order by created_at;

-- (3) US policy / central-bank / FX categories and exchange-action keywords, 2026-08-20 onward
select left(id::text, 8) as id8, source_name, importance, round(confidence::numeric, 2) as conf, escalated_to_sol as sol, category,
       (created_at at time zone 'Asia/Tokyo')::date as d, left(title, 105) as title
from public.important_news_candidates
where created_at >= timestamptz '2026-08-20 00:00:00+09' and created_at < timestamptz '2026-10-10 12:00:00+09' and judgement_model is not null
  and (
    (category in ('tariffs', 'us_government_policy', 'sanctions', 'china_policy', 'frb', 'interest_rates', 'boj', 'fx')
      and source_name <> 'tdnet' and title !~ '(Security Council|World News in Brief|UN |Ebola)')
    or (source_name = 'tdnet' and title ~ '(破産|民事再生|更生|債務超過|監理銘柄|整理銘柄|特設注意|上場維持|上場廃止の決定|上場廃止猶予|ストップ|不適切会計|不正|粉飾|行政処分|業務停止|課徴金|リコール|大規模|事故|火災|被害)')
  )
order by md5(id::text || 'kabumori-eval-pool-d')
limit 80;
