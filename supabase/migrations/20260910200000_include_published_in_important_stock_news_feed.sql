-- Include published important news in the per-user /news feed.
--
-- get_my_important_stock_news was written before important news could be
-- auto-published to X, when ready_for_publish / generation_failed were the
-- terminal states. Publishing now moves a candidate on to 'published', which
-- the status filter dropped, so a news item vanished from /news at exactly the
-- moment the push producer (important-news-monitor) notified the user about it:
-- tapping that push opened /news without the item.
--
-- Only the status filter changes. Ticker matching, the active-tracked-stock
-- scope, duplicate exclusion, ordering, the limit, the return shape, SECURITY
-- DEFINER with an empty search_path, and the authenticated-only grant are kept
-- exactly as in 20260905140638_get_my_important_stock_news.sql.
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
    and news.status in ('ready_for_publish', 'generation_failed', 'published')
    and news.duplicate_of is null
  order by coalesce(news.published_at, news.created_at) desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Returns a minimal important-news feed for the authenticated user active tracked stocks.';

revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_important_stock_news(integer)
  to authenticated;
