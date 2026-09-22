-- Important News app-copy V2 candidate (C1 review only; do not apply in H1).
--
-- The previous selector deliberately skipped a candidate when its X post had
-- passed Fact.  That is safe for X, but it prevents the app from using a
-- richer stored source (for example a tanker incident with injuries and
-- post-incident status).  This replace keeps all existing visibility gates,
-- adds the source-backed candidates, and leaves feed Fact gates unchanged.
-- It is intended to run after the Phase 5 wrapper migration, which preserves
-- the previous target function as *_phase5_base.

begin;

create or replace function public.important_news_app_copy_targets(p_limit integer default 5)
returns table (id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with base_targets as (
    select target.id, coalesce(news.published_at, news.created_at) as news_time
    from public.important_news_app_copy_targets_phase5_base(20) as target
    inner join public.important_news_candidates as news on news.id = target.id
  ),
  source_company as (
    select distinct news.id, coalesce(news.published_at, news.created_at) as news_time
    from public.tracked_stocks as tracked
    inner join public.stocks_master as stock on stock.id = tracked.stock_id
    inner join public.important_news_candidates as news
      on news.company_code ~ '^[0-9A-Z]{5}$'
     and left(news.company_code, 4) = stock.ticker_code
    where tracked.is_active = true
      and news.duplicate_of is null
      and news.status in (
        'rejected', 'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
      and (news.status <> 'rejected' or news.source_type in ('tdnet', 'company_ir'))
      and public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      ) in ('critical', 'high', 'medium')
      and news.title !~ '[ぁ-んァ-ヶ一-龠]'
      and coalesce(btrim(news.body_summary), '') <> ''
      and news.app_copy_fact_status is null
      and news.app_copy_attempts = 0
  ),
  source_market as (
    select distinct news.id, coalesce(news.published_at, news.created_at) as news_time
    from public.important_news_candidates as news
    inner join public.tracked_stocks as tracked on tracked.is_active = true
    inner join public.stocks_master as stock
      on stock.id = tracked.stock_id
     and stock.sector = any(public.important_news_theme_sectors(
       public.important_news_market_themes(news.category, news.title, news.affected_entities)))
    where news.company_code is null
      and news.duplicate_of is null
      and news.status in (
        'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
      and news.japan_market_relevance in ('medium', 'high')
      and public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      ) in ('critical', 'high')
      and news.title !~ '[ぁ-んァ-ヶ一-龠]'
      and coalesce(btrim(news.body_summary), '') <> ''
      and news.app_copy_fact_status is null
      and news.app_copy_attempts = 0
  ),
  broad_targets as (
    select candidate.id, coalesce(candidate.published_at, candidate.created_at) as news_time
    from public.important_news_candidates as candidate
    where candidate.company_code is null
      and candidate.duplicate_of is null
      and candidate.status in (
        'rejected', 'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
      and coalesce(candidate.coverage_severity, public.important_news_app_severity(
        candidate.importance, candidate.category, candidate.title, candidate.source_type,
        candidate.source_url, candidate.published_at, candidate.company_code,
        candidate.japan_market_relevance, candidate.fact_check_status
      )) in ('critical', 'high', 'medium')
      and coalesce(candidate.published_at, candidate.created_at) >= now() - interval '6 hours'
      and (candidate.status <> 'rejected' or candidate.source_type in ('tdnet', 'company_ir'))
      and candidate.title !~ '[ぁ-んァ-ヶ一-龠]'
      and coalesce(btrim(candidate.body_summary), '') <> ''
      and candidate.app_copy_fact_status is null
      and candidate.app_copy_attempts = 0
      and exists (
        select 1
        from public.alert_settings as settings
        where settings.notification_preset = 'all_useful'
          and (
            coalesce(cardinality(candidate.coverage_categories), 0) = 0
            or exists (
              select 1
              from unnest(candidate.coverage_categories) as category(name)
              left join public.alert_category_settings as category_setting
                on category_setting.user_id = settings.user_id
               and category_setting.category = category.name
              where coalesce(category_setting.enabled, true)
            )
          )
      )
  ),
  visible as (
    select id, news_time from base_targets
    union
    select id, news_time from source_company
    union
    select id, news_time from source_market
    union
    select id, news_time from broad_targets
  )
  select visible.id
  from visible
  order by visible.news_time desc, visible.id
  limit greatest(1, least(coalesce(p_limit, 5), 20));
$$;

revoke all on function public.important_news_app_copy_targets(integer)
  from public, anon, authenticated;
grant execute on function public.important_news_app_copy_targets(integer)
  to service_role;

commit;
