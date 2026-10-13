-- READ-ONLY. Phase 5: every status a candidate of the window can be in, including those that never reach judgement.
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_status_overview.sql
-- A status other than the judged ones is another way a news item can fail to reach anyone (stuck or never judged).
select status,
       (judgement_model is not null) as judged,
       (duplicate_of is not null) as is_duplicate,
       count(*) as n,
       min((created_at at time zone 'Asia/Tokyo')::date) as first_day,
       max((created_at at time zone 'Asia/Tokyo')::date) as last_day
from public.important_news_candidates
where created_at >= timestamptz '2026-09-10 00:00:00+09' and created_at < timestamptz '2026-10-10 00:00:00+09'
group by 1, 2, 3
order by n desc;
