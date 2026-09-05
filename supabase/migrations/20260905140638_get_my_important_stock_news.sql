create or replace function public.get_my_important_stock_news(
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
  source_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    news.id as news_id,
    stock.ticker_code,
    stock.company_name,
    tracked.tracking_type,
    news.title,
    news.body_summary as summary,
    news.importance,
    coalesce(news.published_at, news.created_at) as news_time,
    news.source_url
  from public.tracked_stocks as tracked
  inner join public.stocks_master as stock
    on stock.id = tracked.stock_id
  inner join public.important_news_candidates as news
    on news.company_code ~ '^[0-9A-Z]{5}$'
   and left(news.company_code, 4) = stock.ticker_code
  where (select auth.uid()) is not null
    and tracked.user_id = (select auth.uid())
    and tracked.is_active = true
    and news.importance in ('important', 'most_important')
    and news.status in ('ready_for_publish', 'generation_failed')
    and news.duplicate_of is null
  order by coalesce(news.published_at, news.created_at) desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Returns a minimal important-news feed for the authenticated user active tracked stocks.';

-- Remove the helper if an earlier local draft of this migration was applied.
drop function if exists private.get_my_important_stock_news(integer);

revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_important_stock_news(integer)
  to authenticated;
