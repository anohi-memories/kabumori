-- READ-ONLY. Phase 5: how often an official source arrives with no usable body, per host.
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_ingestion_gaps.sql
-- A body is "empty" at 0 characters (nothing extracted) and "title only" at 1..60 characters. Only counts are returned.
select source_name,
       coalesce(substring(source_url from '^https?://([^/]+)'), '(no url)') as host,
       count(*) as candidates,
       count(*) filter (where coalesce(length(body_summary), 0) = 0) as empty_body,
       count(*) filter (where length(body_summary) between 1 and 60) as title_only,
       count(*) filter (where importance <> 'no_post') as important_plus,
       count(*) filter (where judgement_reason like '%保存済み情報だけでは安全に確定できないため投稿対象外%') as gate_suppressed
from public.important_news_candidates
where created_at >= timestamptz '2026-09-10 00:00:00+09' and created_at < timestamptz '2026-10-10 00:00:00+09'
  and judgement_model is not null
group by 1, 2
having count(*) >= 5
order by candidates desc;
