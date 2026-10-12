-- Phase J0 (G8): production read-only AGGREGATE SELECT only. No ids, urls, titles, bodies, users or tokens are returned.
-- Window: the last 7 days by candidate created_at / signal fetched_at. Result: one json document.
with win as (select now() - interval '7 days' as since),
cand as (
  select c.* from public.important_news_candidates c, win where c.created_at >= win.since
),
sig as (
  select s.* from public.news_discovery_signals s, win where s.fetched_at >= win.since and s.source_id like 'jp\_%'
),
sig_match as (
  select s.source_id,
         exists (select 1 from public.important_news_candidates c
                 where c.source_url = s.canonical_url or c.source_url = s.source_url) as url_matched
  from sig s
)
select jsonb_build_object(
  'window_since', (select since from win),
  'candidates_by_source_status_importance', (
    select coalesce(jsonb_agg(r order by r.n desc), '[]'::jsonb) from (
      select source_name, status, importance, count(*) n from cand group by 1,2,3) r),
  'candidates_by_day_jst', (
    select coalesce(jsonb_agg(r order by r.d), '[]'::jsonb) from (
      select (created_at at time zone 'Asia/Tokyo')::date d, count(*) n,
             count(*) filter (where status = 'published') published
      from cand group by 1) r),
  'jp_signals_by_source', (
    select coalesce(jsonb_agg(r order by r.n desc), '[]'::jsonb) from (
      select source_id, policy, discovery_only, count(*) n,
             count(*) filter (where title_display_allowed) title_display_allowed
      from sig group by 1,2,3) r),
  'jp_signals_url_matched_to_candidate', (
    select coalesce(jsonb_agg(r order by r.signals desc), '[]'::jsonb) from (
      select source_id, count(*) signals, count(*) filter (where url_matched) url_matched
      from sig_match group by 1) r),
  'jp_official_candidates', (
    select coalesce(jsonb_agg(r order by r.n desc), '[]'::jsonb) from (
      select status, importance, coverage_severity,
             (app_copy_fact_status = 'passed') app_copy_passed,
             (generation_fact_status = 'passed') post_text_passed, count(*) n
      from cand where source_name = 'jp_official' group by 1,2,3,4,5) r),
  'app_market_feed_eligibility_proxy', (
    -- mirrors the market_candidates filter of get_my_important_stock_news (company_code null, not duplicate, visible status,
    -- severity in emergency/critical/high/medium, rejected only for tdnet/company_ir). coverage_severity null is counted apart.
    select coalesce(jsonb_agg(r order by r.n desc), '[]'::jsonb) from (
      select source_name,
             coalesce(coverage_severity, 'NULL') coverage_severity,
             (status <> 'rejected' or source_type in ('tdnet','company_ir')) status_visible,
             (company_code is null) market_wide,
             count(*) n
      from cand
      where duplicate_of is null
        and status in ('rejected','ready_for_generation','generating','ready_for_publish','generation_failed','publishing','publish_failed','published')
      group by 1,2,3,4) r),
  'latency_seconds', (
    select coalesce(jsonb_agg(r), '[]'::jsonb) from (
      select source_name,
             count(*) n,
             percentile_cont(0.5) within group (order by extract(epoch from (fetched_at - published_at))) fetched_after_published_p50,
             percentile_cont(0.9) within group (order by extract(epoch from (fetched_at - published_at))) fetched_after_published_p90,
             percentile_cont(0.5) within group (order by extract(epoch from (judged_at - fetched_at))) judged_after_fetched_p50,
             percentile_cont(0.9) within group (order by extract(epoch from (judged_at - fetched_at))) judged_after_fetched_p90
      from cand where judged_at is not null and published_at is not null group by 1) r),
  'push_sent_7d', (select count(*) from public.notifications n, win
                   where n.created_at >= win.since and n.source_type = 'important_news' and n.push_status = 'sent')
) as j0;
