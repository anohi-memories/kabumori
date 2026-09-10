-- Phase 2 of "collect broadly, deliver narrowly": drive the /news feed by an
-- app-facing severity instead of the X-oriented importance.
--
-- Until now the feed only showed importance important/most_important, the same
-- two tiers that are auto-posted to X. A disclosure a holder cares about but that
-- is not X-worthy (monthly sales, dilution, an FDA complete response letter, a
-- service suspension, most earnings releases) was judged no_post, stored as
-- rejected and never shown.
--
-- The severity is DERIVED here from columns the judgement already stores, so:
--   * no existing row is updated or backfilled;
--   * important-news-monitor (judgement, X publish gate, push producer) is not
--     touched and needs no deploy; importance keeps meaning exactly what it did.
-- The rules mirror supabase/functions/important-news-monitor/news_severity_logic.ts
-- (deriveNewsSeverity / detectCorporateIrSubtype) verbatim; a test pins that the
-- regular expressions stay identical, and production rows were checked for parity.
--
-- Market-wide news (no company_code) never reaches this feed: it is joined to the
-- user's tracked stocks by ticker. Showing it needs a relevance model
-- (affected sectors/assets or a market-alert preference) that does not exist yet.

begin;

-- Holder-relevant IR hidden inside other_corporate_ir. First match wins.
create or replace function public.important_news_ir_subtype(p_title text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when t ~ '上場廃止|整理銘柄|監理銘柄|特別注意銘柄|市場区分の変更|上場市場の変更' then 'delisting_or_listing_change'
    when t ~ '承認(?:取得|申請)|審査完了報告|CRL|製造販売|薬事|治験|許認可|認可取得' then 'regulatory_approval'
    when t ~ '停止|休止|操業|火災|事故|障害|不正アクセス|サイバー|リコール|延期|中止' then 'business_disruption'
    when t ~ '新株予約権.*(?:大量行使|行使)|第三者割当|公募増資|募集株式|転換社債|CB|ライツ' then 'dilution'
    when t ~ '株式分割|株式併合' then 'stock_split'
    when t ~ '株主優待' then 'shareholder_benefit'
    when t ~ '代表取締役.*(?:異動|交代|就任|辞任)|社長.*(?:交代|就任|辞任)|CEO' then 'management_change'
    when t ~ '月次|(?:\d|[０-９])+\s*月度|売上高?速報|営業レポート' then 'monthly_sales'
    when t ~ '社債|借入|資金調達|コミットメントライン' then 'debt_financing'
    when t ~ '新製品|新サービス|提供開始|発売' then 'product_launch_or_delay'
    else 'routine'
  end
  from (select normalize(coalesce(p_title, ''), NFKC) as t) normalized;
$$;

-- critical / high = the current X tiers, only with a passed Fact check.
-- medium       = worth showing in the app, never X-eligible.
-- low          = not shown. Always low without an https source and a publish time.
create or replace function public.important_news_app_severity(
  p_importance text,
  p_category text,
  p_title text,
  p_source_type text,
  p_source_url text,
  p_published_at timestamptz,
  p_company_code text,
  p_japan_market_relevance text,
  p_fact_check_status text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  with facts as (
    select
      coalesce(length(btrim(p_company_code)) > 0, false) as has_code,
      p_category in (
        'earnings_revision_up', 'earnings_revision_down', 'earnings', 'share_buyback',
        'dividend_increase', 'dividend_decrease', 'no_dividend', 'ma', 'tob',
        'business_alliance', 'capital_alliance', 'large_order', 'misconduct',
        'administrative_action', 'litigation', 'major_shareholder', 'large_shareholding'
      ) as holder_category,
      p_category = 'other_corporate_ir' as other_ir,
      coalesce(p_fact_check_status = 'passed', false) as fact_passed,
      coalesce(p_importance in ('important', 'most_important'), false) as x_tier,
      case p_japan_market_relevance when 'low' then 1 when 'medium' then 2 when 'high' then 3 else 0 end as relevance,
      (p_published_at is not null and coalesce(p_source_url ~* '^https://', false)) as fact_basis
  ), scoped as (
    select facts.*,
      case when has_code or holder_category or other_ir then 'company' else 'market' end as scope,
      case when other_ir then public.important_news_ir_subtype(p_title) end as ir_subtype
    from facts
  )
  select case
    when not fact_basis then 'low'
    when p_importance = 'most_important' and fact_passed then 'critical'
    when p_importance = 'important' and fact_passed then 'high'
    when scope = 'company' then case
      when not has_code then 'low'
      when x_tier then 'medium'
      when holder_category then 'medium'
      when ir_subtype in (
        'monthly_sales', 'shareholder_benefit', 'stock_split', 'dilution', 'management_change',
        'regulatory_approval', 'business_disruption', 'delisting_or_listing_change', 'product_launch_or_delay'
      ) then 'medium'
      else 'low'
    end
    when relevance >= case when fact_passed then 2 else 3 end then 'medium'
    else 'low'
  end
  from scoped;
$$;

comment on function public.important_news_app_severity(text, text, text, text, text, timestamptz, text, text, text) is
  'App-facing severity (critical/high/medium/low) derived from stored judgement; mirrors news_severity_logic.ts deriveNewsSeverity.';
comment on function public.important_news_ir_subtype(text) is
  'Holder-relevant IR subtype of an other_corporate_ir headline; mirrors news_severity_logic.ts detectCorporateIrSubtype.';

-- Only the SECURITY DEFINER feed below calls these.
revoke all on function public.important_news_ir_subtype(text) from public, anon, authenticated, service_role;
revoke all on function public.important_news_app_severity(text, text, text, text, text, timestamptz, text, text, text)
  from public, anon, authenticated, service_role;

-- The return type gains a trailing `severity` column, which CREATE OR REPLACE
-- cannot do, so the function is recreated inside this transaction. Existing
-- clients ignore the extra column.
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
  severity text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    feed.news_id, feed.ticker_code, feed.company_name, feed.tracking_type, feed.title,
    feed.summary, feed.importance, feed.news_time, feed.source_url, feed.severity
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
      -- Judged states only: nothing still waiting for (or failed in) judgement.
      and news.status in (
        'rejected', 'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
      -- A rejected item is shown only when it is an official disclosure itself.
      and (news.status <> 'rejected' or news.source_type in ('tdnet', 'company_ir'))
  ) as feed
  where feed.severity in ('critical', 'high', 'medium')
  order by feed.news_time desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Returns the important-news feed (severity critical/high/medium) for the authenticated user active tracked stocks.';

revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_important_stock_news(integer)
  to authenticated;

commit;
