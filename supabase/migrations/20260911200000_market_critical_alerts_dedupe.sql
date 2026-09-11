-- Phase 4: opt-in pushes for market-wide Critical news, cross-source event
-- dedupe in /news, and a better "why is this shown" sector.
--
-- 1. alert_settings.market_critical_news (default OFF). A user without a row, or
--    with the flag off, never gets a market-wide push. push_enabled and
--    important_news must also be on.
-- 2. public.enqueue_market_critical_notifications(): service-role only, called by
--    important-news-monitor at the end of publish_ready / generate_ready (no Cron
--    change). Inserts pending notifications for market-wide items that are
--    severity critical (a verified X-tier judgement), whose transmission themes
--    reach a sector of one of the user's active tracked stocks, that were
--    published within the window (no backlog burst when a user opts in), and
--    that have Fact-passed Japanese text (verified post or app copy). Never the
--    same news - or the same event from another source - twice to one user.
--    high/medium market items are never pushed.
-- 3. Cross-source dedupe (market-wide only, deterministic): same category, the
--    same set of >= 2 significant numbers in the title, published within 72h.
--    The feed keeps one item per event (Japanese text available, then severity,
--    then earliest). Titles without two such numbers are never merged.
-- 4. The feed returns the matched sectors ordered by how many active tracked
--    stocks the user has in each (then holding before watch), up to three.
--
-- Expand-only; no candidate row is updated. X publishing is untouched.

begin;

alter table public.alert_settings
  add column if not exists market_critical_news boolean not null default false;

comment on column public.alert_settings.market_critical_news is
  'Opt-in (default off) for pushes about market-wide Critical news that relates to a sector the user tracks.';

grant select, insert, update (market_critical_news) on public.alert_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Event identity helpers
-- ---------------------------------------------------------------------------

-- Sorted set of "significant" numbers in a title: >= 3 digits, or with a decimal
-- point or percent sign; four-digit years are ignored. Null unless there are at
-- least two, so a title with one incidental number is never used to merge.
create or replace function public.important_news_number_signature(p_title text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when count(*) >= 2 then string_agg(n, '|' order by n) end
  from (
    select distinct regexp_replace(m[1], ',', '', 'g') || m[2] as n
    from regexp_matches(coalesce(p_title, ''), '([0-9][0-9,]*(?:\.[0-9]+)?)(%?)', 'g') as m
  ) as numbers
  where n !~ '^(19|20)[0-9]{2}$'
    and (length(regexp_replace(n, '[^0-9]', '', 'g')) >= 3 or n ~ '[.%]');
$$;

create or replace function public.important_news_same_event(
  p_category_a text, p_title_a text, p_time_a timestamptz,
  p_category_b text, p_title_b text, p_time_b timestamptz
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    p_category_a = p_category_b
    and public.important_news_number_signature(p_title_a) is not null
    and public.important_news_number_signature(p_title_a) = public.important_news_number_signature(p_title_b)
    and abs(extract(epoch from (p_time_a - p_time_b))) <= 72 * 3600,
    false);
$$;

revoke all on function public.important_news_number_signature(text) from public, anon, authenticated, service_role;
revoke all on function public.important_news_same_event(text, text, timestamptz, text, text, timestamptz)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Market Critical push producer
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_market_critical_notifications(p_window_hours integer default 6)
returns table (notification_id uuid, user_id uuid, candidate_id text)
language sql
volatile
security definer
set search_path = ''
as $$
  with eligible as (
    select
      news.id, news.title, news.category,
      coalesce(news.published_at, news.created_at) as news_time,
      public.important_news_market_themes(news.category, news.title, news.affected_entities) as themes,
      case when news.app_copy_fact_status = 'passed' then nullif(btrim(news.app_title_ja), '') end as app_title,
      case when news.app_copy_fact_status = 'passed' then nullif(btrim(news.app_summary_ja), '') end as app_summary,
      case when news.generation_fact_status = 'passed' then nullif(btrim(
        regexp_replace(
          regexp_replace(
            regexp_replace(news.generated_text, '\s*出典\s*[:：]\s*\S+\s*$', ''),
            '^\s*(【(重大)?速報】\s*)+', ''),
          '\s+', ' ', 'g')), '') end as verified_body
    from public.important_news_candidates as news
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
      ) = 'critical'
      and news.published_at >= now() - make_interval(hours => greatest(1, least(coalesce(p_window_hours, 6), 24 * 30)))
  ),
  texted as (
    -- Push copy only from Fact-passed Japanese text: app copy first, else the verified post.
    select
      e.id, e.category, e.title, e.news_time, e.themes,
      coalesce(e.app_title, split_part(e.verified_body, '。', 1)) as headline,
      coalesce(e.app_summary, e.verified_body) as body
    from eligible as e
    where cardinality(e.themes) > 0
      and ((e.app_title is not null and e.app_summary is not null) or e.verified_body is not null)
  ),
  unique_events as (
    select t.*
    from texted as t
    where not exists (
      select 1 from texted as other
      where other.id <> t.id
        and public.important_news_same_event(other.category, other.title, other.news_time,
                                             t.category, t.title, t.news_time)
        and (other.news_time, other.id) < (t.news_time, t.id)
    )
  ),
  recipients as (
    select distinct on (t.id, settings.user_id)
      t.id, t.headline, t.body, settings.user_id, tracked.id as tracked_stock_id
    from unique_events as t
    inner join public.alert_settings as settings
      on settings.market_critical_news = true
     and settings.push_enabled = true
     and settings.important_news = true
    inner join public.tracked_stocks as tracked
      on tracked.user_id = settings.user_id
     and tracked.is_active = true
    inner join public.stocks_master as stock
      on stock.id = tracked.stock_id
     and stock.sector = any(public.important_news_theme_sectors(t.themes))
    where not exists (
        select 1 from public.notifications as sent
        where sent.user_id = settings.user_id
          and sent.source_type = 'important_news'
          and sent.source_id = t.id::text)
      and not exists (
        -- The same event from another source was already sent to this user.
        select 1
        from public.notifications as sent
        inner join public.important_news_candidates as prior
          on prior.id::text = sent.source_id
        where sent.user_id = settings.user_id
          and sent.source_type = 'important_news'
          and prior.company_code is null
          and prior.id <> t.id
          and public.important_news_same_event(prior.category, prior.title,
                coalesce(prior.published_at, prior.created_at), t.category, t.title, t.news_time))
    order by t.id, settings.user_id, tracked.id
  )
  insert into public.notifications as target
    (user_id, tracked_stock_id, source_type, source_id, title, summary, importance, push_status)
  select
    r.user_id,
    r.tracked_stock_id,
    'important_news',
    r.id::text,
    left('【市場】' || r.headline, 60),
    case when char_length(r.body) > 140 then left(r.body, 139) || '…' else r.body end,
    'most_important',
    'pending'
  from recipients as r
  on conflict (user_id, tracked_stock_id, source_type, source_id) do nothing
  returning target.id, target.user_id, target.source_id;
$$;

comment on function public.enqueue_market_critical_notifications(integer) is
  'Service-role only: queue pushes for fresh market-wide Critical news to opted-in users whose tracked sectors it reaches.';

revoke all on function public.enqueue_market_critical_notifications(integer) from public, anon, authenticated;
grant execute on function public.enqueue_market_critical_notifications(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Feed: same per-stock query; market items deduped by event, with ranked sectors
-- ---------------------------------------------------------------------------

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
  app_key_points_ja jsonb,
  matched_sectors text[]
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
      feed.app_title_ja, feed.app_summary_ja, feed.app_detail_ja, feed.app_key_points_ja,
      null::text[] as matched_sectors
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
      news.id, news.title, news.body_summary, news.importance, news.source_url, news.category,
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
  market_unique as (
    -- One item per cross-source event: Japanese text first, then severity, then earliest.
    select candidate.*
    from market_candidates as candidate
    where not exists (
      select 1 from market_candidates as other
      where other.id <> candidate.id
        and public.important_news_same_event(other.category, other.title, other.news_time,
                                             candidate.category, candidate.title, candidate.news_time)
        and (
          case when other.verified_text is not null or other.app_title_ja is not null
               or other.title ~ '[ぁ-んァ-ヶ一-龠]' then 0 else 1 end,
          case other.severity when 'critical' then 0 else 1 end,
          other.news_time, other.id
        ) < (
          case when candidate.verified_text is not null or candidate.app_title_ja is not null
               or candidate.title ~ '[ぁ-んァ-ヶ一-龠]' then 0 else 1 end,
          case candidate.severity when 'critical' then 0 else 1 end,
          candidate.news_time, candidate.id
        )
    )
  ),
  market_matches as (
    select
      candidate.id,
      stock.sector,
      count(*) as stock_count,
      bool_or(tracked.tracking_type = 'holding') as has_holding
    from market_unique as candidate
    inner join public.tracked_stocks as tracked
      on tracked.user_id = (select auth.uid())
     and tracked.is_active = true
    inner join public.stocks_master as stock
      on stock.id = tracked.stock_id
     and stock.sector = any(public.important_news_theme_sectors(candidate.themes))
    where (select auth.uid()) is not null
      and cardinality(candidate.themes) > 0
    group by candidate.id, stock.sector
  ),
  market_ranked as (
    -- Most tracked stocks first, then holding before watch, then name.
    select
      matches.id,
      array_agg(matches.sector order by matches.stock_count desc, matches.has_holding desc, matches.sector) as sectors,
      bool_or(matches.has_holding) as any_holding
    from market_matches as matches
    group by matches.id
  ),
  market_feed as (
    select
      candidate.id as news_id,
      null::text as ticker_code,
      '市場全体'::text as company_name,
      case when ranked.any_holding then 'holding' else 'watch' end as tracking_type,
      candidate.title,
      candidate.body_summary as summary,
      candidate.importance,
      candidate.news_time,
      candidate.source_url,
      candidate.severity,
      ranked.sectors[1] as matched_sector,
      array_to_string(candidate.themes, ',') as relevance_reason,
      candidate.source_type,
      candidate.verified_text,
      candidate.app_title_ja,
      candidate.app_summary_ja,
      candidate.app_detail_ja,
      candidate.app_key_points_ja,
      ranked.sectors[1:3] as matched_sectors
    from market_unique as candidate
    inner join market_ranked as ranked on ranked.id = candidate.id
  )
  select
    combined.news_id, combined.ticker_code, combined.company_name, combined.tracking_type,
    combined.title, combined.summary, combined.importance, combined.news_time,
    combined.source_url, combined.severity, combined.matched_sector, combined.relevance_reason,
    combined.source_type, combined.verified_text,
    combined.app_title_ja, combined.app_summary_ja, combined.app_detail_ja, combined.app_key_points_ja,
    combined.matched_sectors
  from (
    select * from company_feed
    union all
    select * from market_feed
  ) as combined
  order by combined.news_time desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Important-news feed for the authenticated user: per-stock items plus market-wide critical/high items (one per cross-source event) that reach a tracked sector. Fact-gated text only.';

revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_important_stock_news(integer)
  to authenticated;

commit;
