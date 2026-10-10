-- READ-ONLY. Phase 5: every candidate judged important or above in the window, with how generation ended.
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_generation_outcomes.sql
-- Population definition (kept explicit so that two analyses can be compared rule by rule):
--   window     created_at 2026-09-10 00:00 .. 2026-10-10 00:00 JST
--   judged     judgement_model is not null, importance <> 'no_post'
--   duplicates duplicate_of is not null rows are listed but flagged, never silently dropped
-- One row per candidate; issue texts are production's own Fact/Voice messages (not article text).
select left(id::text, 8) as id8, source_name, source_type, importance, status, (duplicate_of is not null) as is_duplicate,
       (created_at at time zone 'Asia/Tokyo')::timestamp(0) as created_jst,
       (published_at at time zone 'Asia/Tokyo')::timestamp(0) as published_jst,
       (generated_at at time zone 'Asia/Tokyo')::timestamp(0) as generated_jst,
       generation_model, generation_fact_status, generation_voice_status,
       coalesce(generation_error, '') as generation_error,
       coalesce(generation_fact_issues::text, '') as fact_issues,
       coalesce(generation_voice_issues::text, '') as voice_issues,
       coalesce(generation_voice_retry::text, '') as voice_retry,
       (x_post_id is not null) as x_posted, (x_published_at is not null) as x_published,
       coalesce(publish_attempts, 0) as publish_attempts, coalesce(publish_error, '') as publish_error,
       (app_title_ja is not null) as has_app_copy, coalesce(app_copy_fact_status, '') as app_copy_status,
       coalesce(coverage_severity, '') as coverage_severity, left(category, 24) as category
from public.important_news_candidates
where created_at >= timestamptz '2026-09-10 00:00:00+09' and created_at < timestamptz '2026-10-10 00:00:00+09'
  and judgement_model is not null and importance <> 'no_post'
order by created_at;
