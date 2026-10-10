-- READ-ONLY. Phase 5: where each judged candidate of the window could reach a user, per channel.
--   supabase db query --linked -o json -f tools/provider-compare/scripts/export_delivery_channels.sql
-- Channels (all derived from stored columns; no per-user data is read, notifications are only counted per candidate):
--   x            status = 'published' / x_post_id is not null
--   app_text     Japanese text that passed Fact exists for the app (app copy passed, or the X text passed Fact)
--   app_listed   the candidate is a row the /news feed function can return for SOME user: not a duplicate, a status the feed
--                accepts, effective severity emergency..medium, and (status <> 'rejected' or tdnet / company_ir).
--                Whether one particular user sees it also depends on that user's tracked stocks and sectors.
--   pushable     the enqueue function would build a notification: severity >= medium and a Japanese headline and body exist
--   notified     notification rows that were actually created for this candidate (count only), and how many were sent
-- effective severity = coverage_severity; rows without it fall back to the SQL function important_news_app_severity in
-- production, which is not recomputed here, so they are reported as 'unknown'.
select left(c.id::text, 8) as id8, c.source_name, c.source_type, c.importance, c.status,
       left(c.title, 120) as title,
       (coalesce(c.published_at, c.created_at) at time zone 'Asia/Tokyo')::timestamp(0) as news_jst,
       (c.duplicate_of is not null) as is_duplicate,
       (c.created_at at time zone 'Asia/Tokyo')::date as created_day,
       coalesce(c.company_code, '') as company_code,
       left(c.category, 24) as category,
       coalesce(c.coverage_severity, 'unknown') as severity,
       (c.x_post_id is not null) as x_posted,
       (c.generation_fact_status = 'passed' and coalesce(btrim(c.generated_text), '') <> '' and c.generated_text ~ '[ぁ-んァ-ヶ一-龠]') as x_text_passed,
       (c.app_copy_fact_status = 'passed' and coalesce(btrim(c.app_title_ja), '') <> '' and coalesce(btrim(c.app_summary_ja), '') <> ''
          and (c.app_title_ja || c.app_summary_ja) ~ '[ぁ-んァ-ヶ一-龠]') as app_copy_passed,
       coalesce(c.app_copy_fact_status, '') as app_copy_status,
       (c.title ~ '[ぁ-んァ-ヶ一-龠]') as japanese_title,
       c.status in ('rejected', 'ready_for_generation', 'generating', 'ready_for_publish', 'generation_failed', 'publishing', 'publish_failed', 'published') as feed_status,
       coalesce(n.notifications, 0) as notifications, coalesce(n.sent, 0) as notifications_sent
from public.important_news_candidates as c
left join (
  select source_id, count(*) as notifications, count(*) filter (where push_status = 'sent') as sent
  from public.notifications
  where source_type = 'important_news' and created_at >= timestamptz '2026-09-09 00:00:00+09'
  group by source_id
) as n on n.source_id = c.id::text
where c.created_at >= timestamptz '2026-09-10 00:00:00+09' and c.created_at < timestamptz '2026-10-10 00:00:00+09'
  and c.judgement_model is not null
order by c.created_at;
