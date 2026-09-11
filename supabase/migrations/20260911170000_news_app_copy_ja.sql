-- Japanese app copy for important news shown in /news that has no Japanese text.
--
-- Some items reach users' feeds with an English title and only an unusable
-- Japanese post (its Fact check failed), so the app can show just the original
-- title. important-news-monitor now generates a Japanese title/summary/detail/
-- key points for exactly those items (one generation + one Fact check, inside the
-- existing generate_ready run) and stores them here. The feed returns them ONLY
-- when their own Fact check passed.
--
-- Expand-only: new nullable columns (plus an attempts counter with a default),
-- one service-role helper, and the feed RPC recreated with four more trailing
-- columns. Which items appear, their order and limit are unchanged.

begin;

alter table public.important_news_candidates
  add column if not exists app_title_ja text,
  add column if not exists app_summary_ja text,
  add column if not exists app_detail_ja text,
  add column if not exists app_key_points_ja jsonb,
  add column if not exists app_copy_fact_status text
    constraint important_news_candidates_app_copy_fact_status_check
    check (app_copy_fact_status is null or app_copy_fact_status in ('generating', 'passed', 'failed')),
  add column if not exists app_copy_fact_issues jsonb,
  add column if not exists app_copy_model text,
  add column if not exists app_copy_generated_at timestamptz,
  add column if not exists app_copy_attempts smallint not null default 0,
  add column if not exists app_copy_error text;

comment on column public.important_news_candidates.app_title_ja is
  'Japanese app title generated from the stored source only; shown only when app_copy_fact_status = passed.';
comment on column public.important_news_candidates.app_copy_fact_status is
  'generating (claimed) / passed / failed. Only passed copy is ever returned to the app.';

-- Items that at least one user would see in /news today (the same per-stock and
-- market-wide conditions as get_my_important_stock_news, across all users), whose
-- title has no Japanese, that have no Fact-passed generated Japanese text, and that
-- have not been attempted yet. Service role only.
create or replace function public.important_news_app_copy_targets(p_limit integer default 5)
returns table (id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with visible_company as (
    select distinct news.id, coalesce(news.published_at, news.created_at) as news_time
    from public.tracked_stocks as tracked
    inner join public.stocks_master as stock
      on stock.id = tracked.stock_id
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
  ),
  visible_market as (
    select distinct news.id, coalesce(news.published_at, news.created_at) as news_time
    from public.important_news_candidates as news
    inner join public.tracked_stocks as tracked
      on tracked.is_active = true
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
  ),
  visible as (
    select id, news_time from visible_company
    union
    select id, news_time from visible_market
  )
  select visible.id
  from visible
  inner join public.important_news_candidates as news on news.id = visible.id
  where news.title !~ '[ぁ-んァ-ヶ一-龠]'
    and not (news.generation_fact_status = 'passed' and coalesce(btrim(news.generated_text), '') <> '')
    and news.app_copy_fact_status is null
    and news.app_copy_attempts = 0
  order by visible.news_time desc
  limit greatest(1, least(coalesce(p_limit, 5), 20));
$$;

comment on function public.important_news_app_copy_targets(integer) is
  'Service-role only: visible /news items that still need Japanese app copy (no Japanese title, no Fact-passed generated text, never attempted).';

revoke all on function public.important_news_app_copy_targets(integer) from public, anon, authenticated;
grant execute on function public.important_news_app_copy_targets(integer) to service_role;

drop function if exists public.get_my_important_stock_news(integer);

create function public.get_my_important_stock_news(
  p_limit integer default 50
)
returns table (
  news_id uuid,
  ticker_code text,
  company_name text,
  tracking_type text,
  title text,
  summary text,
  importance text,
  news_time timestamptz,
  source_url text,
  severity text,
  matched_sector text,
  relevance_reason text,
  source_type text,
  verified_text text,
  app_title_ja text,
  app_summary_ja text,
  app_detail_ja text,
  app_key_points_ja jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with company_feed as (
    -- Phase 2 per-stock feed, unchanged.
    select
      feed.news_id, feed.ticker_code, feed.company_name, feed.tracking_type, feed.title,
      feed.summary, feed.importance, feed.news_time, feed.source_url, feed.severity,
      null::text as matched_sector, null::text as relevance_reason,
      feed.source_type, feed.verified_text,
      feed.app_title_ja, feed.app_summary_ja, feed.app_detail_ja, feed.app_key_points_ja
    from (
      select
        news.id as news_id,
        stock.ticker_code,
        stock.company_name,
        tracked.tracking_type,
        news.title,
        news.body_summary as summary,
        news.importance,
        coalesce(news.published_at, news.created_at) as news_time,
        news.source_url,
        public.important_news_app_severity(
          news.importance, news.category, news.title, news.source_type, news.source_url,
          news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
        ) as severity,
        news.source_type,
        case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text,
        case when news.app_copy_fact_status = 'passed' then news.app_title_ja end as app_title_ja,
        case when news.app_copy_fact_status = 'passed' then news.app_summary_ja end as app_summary_ja,
        case when news.app_copy_fact_status = 'passed' then news.app_detail_ja end as app_detail_ja,
        case when news.app_copy_fact_status = 'passed' then news.app_key_points_ja end as app_key_points_ja
      from public.tracked_stocks as tracked
      inner join public.stocks_master as stock
        on stock.id = tracked.stock_id
      inner join public.important_news_candidates as news
        on news.company_code ~ '^[0-9A-Z]{5}$'
       and left(news.company_code, 4) = stock.ticker_code
      where (select auth.uid()) is not null
        and tracked.user_id = (select auth.uid())
        and tracked.is_active = true
        and news.duplicate_of is null
        and news.status in (
          'rejected', 'ready_for_generation', 'generating', 'ready_for_publish',
          'generation_failed', 'publishing', 'publish_failed', 'published'
        )
        and (news.status <> 'rejected' or news.source_type in ('tdnet', 'company_ir'))
    ) as feed
    where feed.severity in ('critical', 'high', 'medium')
  ),
  market_candidates as (
    select
      news.id, news.title, news.body_summary, news.importance, news.source_url,
      coalesce(news.published_at, news.created_at) as news_time,
      assessed.severity,
      public.important_news_market_themes(news.category, news.title, news.affected_entities) as themes,
      news.source_type,
      case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text,
      case when news.app_copy_fact_status = 'passed' then news.app_title_ja end as app_title_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_summary_ja end as app_summary_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_detail_ja end as app_detail_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_key_points_ja end as app_key_points_ja
    from public.important_news_candidates as news
    cross join lateral (
      select public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      ) as severity
    ) as assessed
    where news.company_code is null
      and news.duplicate_of is null
      -- Judged X-tier states only; a rejected market item never qualifies.
      and news.status in (
        'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
      and news.japan_market_relevance in ('medium', 'high')
      and assessed.severity in ('critical', 'high')
  ),
  market_feed as (
    select distinct on (candidate.id)
      candidate.id as news_id,
      null::text as ticker_code,
      '市場全体'::text as company_name,
      tracked.tracking_type,
      candidate.title,
      candidate.body_summary as summary,
      candidate.importance,
      candidate.news_time,
      candidate.source_url,
      candidate.severity,
      stock.sector as matched_sector,
      array_to_string(candidate.themes, ',') as relevance_reason,
      candidate.source_type,
      candidate.verified_text,
      candidate.app_title_ja,
      candidate.app_summary_ja,
      candidate.app_detail_ja,
      candidate.app_key_points_ja
    from market_candidates as candidate
    inner join public.tracked_stocks as tracked
      on tracked.user_id = (select auth.uid())
     and tracked.is_active = true
    inner join public.stocks_master as stock
      on stock.id = tracked.stock_id
     and stock.sector = any(public.important_news_theme_sectors(candidate.themes))
    where (select auth.uid()) is not null
      and cardinality(candidate.themes) > 0
    -- One row per news item: prefer a holding over a watch, then a stable order.
    order by candidate.id, (tracked.tracking_type = 'holding') desc, stock.sector, stock.ticker_code
  )
  select
    combined.news_id, combined.ticker_code, combined.company_name, combined.tracking_type,
    combined.title, combined.summary, combined.importance, combined.news_time,
    combined.source_url, combined.severity, combined.matched_sector, combined.relevance_reason,
    combined.source_type, combined.verified_text,
    combined.app_title_ja, combined.app_summary_ja, combined.app_detail_ja, combined.app_key_points_ja
  from (
    select * from company_feed
    union all
    select * from market_feed
  ) as combined
  order by combined.news_time desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Important-news feed for the authenticated user. verified_text and app_*_ja are returned only when their own Fact check passed.';

revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_important_stock_news(integer)
  to authenticated;

commit;
