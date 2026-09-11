-- In-app Japanese news detail: expose the two stored fields the app needs to
-- present an item in Japanese without any AI call.
--
--   * source_type   - lets the app treat a TDnet disclosure differently from a
--                     wire item;
--   * verified_text - the Japanese post text generated at publish time, but ONLY
--                     when its Fact check passed (generation_fact_status =
--                     'passed'). Text that failed the Fact check never leaves the
--                     database through this feed.
--
-- Which items appear, their order, limit, severity and market relevance are the
-- Phase 3 query unchanged (a test pins the condition blocks). No row is updated.

begin;

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
  verified_text text
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
      feed.source_type, feed.verified_text
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
        case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text
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
      case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text
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
      candidate.verified_text
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
    combined.source_type, combined.verified_text
  from (
    select * from company_feed
    union all
    select * from market_feed
  ) as combined
  order by combined.news_time desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Important-news feed for the authenticated user: per-stock items (severity critical/high/medium) plus market-wide items (critical/high) that reach a sector of an active tracked stock. verified_text is the generated Japanese text only when its Fact check passed.';

revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_important_stock_news(integer)
  to authenticated;

commit;
