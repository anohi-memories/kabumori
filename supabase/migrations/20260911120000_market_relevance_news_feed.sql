-- Phase 3: show market-wide news (no company_code) in /news, but only to users
-- whose active tracked stocks sit in a sector the news actually reaches.
--
-- Relevance is derived deterministically from what the judgement already stored
-- (category, title, affected_entities). No AI call, no new source, no row update.
--   1. important_news_market_themes: which transmission path the item names
--      (oil/energy, shipping, semiconductors, autos, trade, fx, rates). A theme
--      needs either its category or an explicit keyword in the title/entities.
--      A war or political headline that names no such path gets no theme and
--      therefore reaches nobody.
--   2. important_news_theme_sectors: theme -> TSE 33-sector names exactly as they
--      appear in stocks_master.sector. The mapping only decides WHO may see an
--      item; it carries no direction (no buy/sell implication).
--
-- A market item enters a user's feed only when ALL hold:
--   * severity critical/high (a verified X-tier judgement; never medium),
--   * japan_market_relevance medium/high (the judge stated an effect on Japan),
--   * a derived theme maps to the sector of one of the user's active tracked stocks.
-- It is emitted once per news item however many stocks match (DISTINCT ON), with
-- the matched sector and the themes as the reason.
--
-- The per-stock feed is byte-for-byte the Phase 2 query. The X publish gate, the
-- push producer and the dispatcher read none of this.

begin;

create or replace function public.important_news_market_themes(
  p_category text,
  p_title text,
  p_affected_entities jsonb
)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  with source_text as (
    select coalesce(p_title, '') || ' ' || coalesce(
      case when jsonb_typeof(p_affected_entities) = 'array' then (
        select string_agg(entity, ' ') from jsonb_array_elements_text(p_affected_entities) as entity
      ) end, '') as t
  )
  select coalesce(array_agg(theme order by ord), '{}'::text[])
  from source_text, lateral (values
    (1, 'oil_energy',
      t ~* '原油|石油|ブレント|WTI|OPEC|LNG|天然ガス|エネルギー|ホルムズ|タンカー|\y(oil|crude|brent|opec|lng|energy|hormuz|tankers?)\y'),
    (2, 'shipping',
      t ~* '海運|航路|海峡|紅海|港湾|船舶|商船|\y(shipping|strait|red sea|vessels?|ships?|maritime|ports?)\y'),
    (3, 'semiconductors',
      p_category = 'semiconductor_ai'
      or t ~* '半導体|チップ|輸出規制|台湾|\y(semiconductors?|chips?|chipmakers?|chipmaking|export controls?|taiwan|sox|ai)\y'),
    (4, 'autos',
      t ~* '自動車|\y(autos?|automakers?|vehicles?|cars?)\y'),
    (5, 'trade',
      p_category = 'tariffs' or t ~* '関税|通商|\y(tariffs?|duties|trade war)\y'),
    (6, 'fx',
      p_category = 'fx' or t ~* '円高|円安|ドル円|為替|介入|\y(yen|usd/jpy|usdjpy|currency|intervention)\y'),
    (7, 'rates',
      p_category in ('boj', 'frb', 'interest_rates')
      or t ~* '日銀|金利|利上げ|利下げ|国債|FRB|FOMC|雇用統計|\y(fed|fomc|rate hikes?|rate cuts?|interest rates?|yields?|treasur(y|ies)|payrolls|cpi|inflation|boj)\y')
  ) as rule(ord, theme, hit)
  where rule.hit;
$$;

create or replace function public.important_news_theme_sectors(p_themes text[])
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(array_agg(distinct mapping.sector order by mapping.sector), '{}'::text[])
  from (values
    ('oil_energy', '鉱業'), ('oil_energy', '石油・石炭製品'), ('oil_energy', '電気・ガス業'),
    ('oil_energy', '海運業'), ('oil_energy', '空運業'), ('oil_energy', '卸売業'),
    ('shipping', '海運業'), ('shipping', '倉庫・運輸関連業'),
    ('semiconductors', '電気機器'), ('semiconductors', '機械'), ('semiconductors', '化学'),
    ('semiconductors', '精密機器'),
    ('autos', '輸送用機器'), ('autos', 'ゴム製品'),
    ('trade', '輸送用機器'), ('trade', '電気機器'), ('trade', '機械'), ('trade', '精密機器'),
    ('fx', '輸送用機器'), ('fx', '電気機器'), ('fx', '機械'), ('fx', '精密機器'),
    ('rates', '銀行業'), ('rates', '保険業'), ('rates', '証券、商品先物取引業'),
    ('rates', 'その他金融業'), ('rates', '不動産業')
  ) as mapping(theme, sector)
  where mapping.theme = any(coalesce(p_themes, '{}'::text[]));
$$;

comment on function public.important_news_market_themes(text, text, jsonb) is
  'Transmission-path themes named by a market-wide news item (category or explicit keyword); empty when none.';
comment on function public.important_news_theme_sectors(text[]) is
  'TSE 33-sector names (as in stocks_master.sector) reached by the given themes. Relevance only, no direction.';

revoke all on function public.important_news_market_themes(text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.important_news_theme_sectors(text[]) from public, anon, authenticated, service_role;

-- Two trailing columns are added to the return type, so the function is
-- recreated inside this transaction. Existing clients ignore extra columns.
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
  relevance_reason text
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
      null::text as matched_sector, null::text as relevance_reason
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
        ) as severity
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
      public.important_news_market_themes(news.category, news.title, news.affected_entities) as themes
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
      array_to_string(candidate.themes, ',') as relevance_reason
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
    combined.source_url, combined.severity, combined.matched_sector, combined.relevance_reason
  from (
    select * from company_feed
    union all
    select * from market_feed
  ) as combined
  order by combined.news_time desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Important-news feed for the authenticated user: per-stock items (severity critical/high/medium) plus market-wide items (critical/high) that reach a sector of an active tracked stock.';

revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_important_stock_news(integer)
  to authenticated;

commit;
