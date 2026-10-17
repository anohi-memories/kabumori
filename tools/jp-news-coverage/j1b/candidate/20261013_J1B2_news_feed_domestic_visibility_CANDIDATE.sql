-- J1-b2 CANDIDATE migration — REVIEW ONLY. NOT in supabase/migrations on purpose: it must not be picked up by any
-- Preview / db push. Promote only after explicit approval and Sol (high) review.
--
-- What it changes: the public feed RPC get_my_important_stock_news(integer) (the Phase 5 wrapper) gets one additional
-- source of rows, `domestic_feed`, and four NEW feed-only helper functions. Same signature, same return columns,
-- create or replace (grants are kept). The base function, important_news_same_event, important_news_market_themes,
-- important_news_theme_sectors and every notification / push function are NOT touched: those are shared with the Push
-- producers, so any change to them would change who is pushed. The new helpers are used only by this feed.
--
-- Policy encoded (O1–O4 are product decisions; this file is one concrete, reviewable choice, see the design doc):
--   O1  A row judged no_post (status 'rejected') from the official jp_official lane is shown in the app only when its
--       Fact check passed AND (severity critical/high OR category is a regulatory / incident category). Emergency rows
--       were already visible and are not changed. Rumours / Fact-failed rows are never shown by this path.
--   O2  Audience: users whose tracked sector is reached by the item's theme, plus every all_useful user. Users with no
--       tracked sector and not all_useful get nothing new (variant `j1b2_b` shows critical/high to everyone).
--   O3  Feed-only same-event rule: same category, within 72h, and equal normalised title (follow-up markers removed).
--   O4  Three feed-only themes: financial_regulation, domestic_disaster, cyber_outage with the sector mapping below.
begin;

create or replace function public.important_news_feed_themes(
  p_category text, p_title text, p_affected_entities jsonb
)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(public.important_news_market_themes(p_category, p_title, p_affected_entities), '{}'::text[])
    || coalesce((
      select array_agg(rule.theme order by rule.ord)
      from (select coalesce(p_title, '') || ' ' || coalesce(
              case when jsonb_typeof(p_affected_entities) = 'array' then (
                select string_agg(entity, ' ') from jsonb_array_elements_text(p_affected_entities) as entity
              ) end, '') as t) as source_text,
      lateral (values
        (1, 'financial_regulation', source_text.t ~* '金融庁|行政処分|業務改善命令|課徴金|金融機関|銀行|証券会社|保険会社|金融システム'),
        (2, 'domestic_disaster',    source_text.t ~* '地震|震度|津波|噴火|台風|豪雨|停電|大規模災害'),
        (3, 'cyber_outage',         source_text.t ~* 'サイバー|システム障害|決済障害|情報漏えい|情報漏洩|不正アクセス')
      ) as rule(ord, theme, hit)
      where rule.hit
    ), '{}'::text[]);
$$;

create or replace function public.important_news_feed_theme_sectors(p_themes text[])
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(array_agg(distinct sector order by sector), '{}'::text[])
  from (
    select unnest(public.important_news_theme_sectors(p_themes)) as sector
    union
    select mapping.sector
    from (values
      ('financial_regulation', '銀行業'), ('financial_regulation', '保険業'),
      ('financial_regulation', '証券、商品先物取引業'), ('financial_regulation', 'その他金融業'),
      ('domestic_disaster', '建設業'), ('domestic_disaster', '電気・ガス業'), ('domestic_disaster', '保険業'),
      ('cyber_outage', '情報・通信業'), ('cyber_outage', '銀行業'), ('cyber_outage', 'その他金融業')
    ) as mapping(theme, sector)
    where mapping.theme = any(coalesce(p_themes, '{}'::text[]))
  ) as sectors;
$$;

-- Normalised event key: follow-up / update / correction markers, brackets, spaces and punctuation removed.
create or replace function public.important_news_feed_event_key(p_title text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(
    regexp_replace(coalesce(p_title, ''), '続報|第[0-9０-９一二三四五六七八九十]+報|更新|訂正|速報|【[^】]*】|\[[^\]]*\]', '', 'g'),
    '[\s　（）()「」『』、。,.:：;；!！?？・\-－―]+', '', 'g');
$$;

create or replace function public.important_news_feed_same_event(
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
    and abs(extract(epoch from (p_time_a - p_time_b))) <= 72 * 3600
    and char_length(public.important_news_feed_event_key(p_title_a)) >= 8
    and public.important_news_feed_event_key(p_title_a) = public.important_news_feed_event_key(p_title_b),
    false);
$$;

revoke all on function public.important_news_feed_themes(text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.important_news_feed_theme_sectors(text[]) from public, anon, authenticated, service_role;
revoke all on function public.important_news_feed_event_key(text) from public, anon, authenticated, service_role;
revoke all on function public.important_news_feed_same_event(text, text, timestamptz, text, text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.get_my_important_stock_news(p_limit integer default 50)
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
  matched_sectors text[],
  coverage_categories text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with base_feed as (
    select * from public.get_my_important_stock_news_phase5_base(50)
  ),
  market_candidates as (
    select
      news.*,
      coalesce(news.coverage_severity, public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      )) as effective_severity,
      case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text,
      case when news.app_copy_fact_status = 'passed' then news.app_title_ja end as visible_app_title_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_summary_ja end as visible_app_summary_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_detail_ja end as visible_app_detail_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_key_points_ja end as visible_app_key_points_ja
    from public.important_news_candidates as news
    where news.company_code is null
      and news.duplicate_of is null
      and news.status in (
        'rejected', 'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
      and coalesce(news.coverage_severity, public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      )) in ('emergency', 'critical', 'high', 'medium')
      and (news.status <> 'rejected' or news.source_type in ('tdnet', 'company_ir'))
  ),
  market_unique as (
    select candidate.*
    from market_candidates as candidate
    where not exists (
      select 1 from market_candidates as other
      where other.id <> candidate.id
        and public.important_news_same_event(
          other.category, other.title, coalesce(other.published_at, other.created_at),
          candidate.category, candidate.title, coalesce(candidate.published_at, candidate.created_at)
        )
        and (
          case when other.verified_text is not null or other.visible_app_title_ja is not null
                    or other.title ~ '[ぁ-んァ-ヶ一-龠]' then 0 else 1 end,
          case other.effective_severity when 'emergency' then 0 when 'critical' then 1 when 'high' then 2 else 3 end,
          coalesce(other.published_at, other.created_at), other.id
        ) < (
          case when candidate.verified_text is not null or candidate.visible_app_title_ja is not null
                    or candidate.title ~ '[ぁ-んァ-ヶ一-龠]' then 0 else 1 end,
          case candidate.effective_severity when 'emergency' then 0 when 'critical' then 1 when 'high' then 2 else 3 end,
          coalesce(candidate.published_at, candidate.created_at), candidate.id
        )
    )
  ),
  broad_feed as (
    select
      candidate.id as news_id,
      null::text as ticker_code,
      '市場全体'::text as company_name,
      'market'::text as tracking_type,
      candidate.title,
      candidate.body_summary as summary,
      candidate.importance,
      coalesce(candidate.published_at, candidate.created_at) as news_time,
      candidate.source_url,
      candidate.effective_severity as severity,
      null::text as matched_sector,
      null::text as relevance_reason,
      candidate.source_type,
      candidate.verified_text,
      candidate.visible_app_title_ja as app_title_ja,
      candidate.visible_app_summary_ja as app_summary_ja,
      candidate.visible_app_detail_ja as app_detail_ja,
      candidate.visible_app_key_points_ja as app_key_points_ja,
      null::text[] as matched_sectors,
      candidate.coverage_categories
    from market_unique as candidate
    where candidate.effective_severity in ('critical', 'high', 'medium')
      and exists (
        select 1 from public.alert_settings as settings
        where settings.user_id = (select auth.uid())
          and settings.notification_preset = 'all_useful'
      )
      and not exists (
        select 1 from base_feed as existing where existing.news_id = candidate.id
      )
  ),
  market_candidates_all as (
    select
      news.*,
      coalesce(news.coverage_severity, public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      )) as effective_severity,
      case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text,
      case when news.app_copy_fact_status = 'passed' then news.app_title_ja end as visible_app_title_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_summary_ja end as visible_app_summary_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_detail_ja end as visible_app_detail_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_key_points_ja end as visible_app_key_points_ja
    from public.important_news_candidates as news
    where news.company_code is null
      and news.duplicate_of is null
      and news.fact_check_status = 'passed'
      and news.status in (
        'rejected', 'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
      and coalesce(news.coverage_severity, public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      )) in ('critical', 'high', 'medium')
      and (
        news.status <> 'rejected'
        or news.source_type in ('tdnet', 'company_ir')
        or (
          news.source_name = 'jp_official'
          and (
            coalesce(news.coverage_severity, public.important_news_app_severity(
              news.importance, news.category, news.title, news.source_type, news.source_url,
              news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
            )) in ('critical', 'high')
            or news.category in ('administrative_action', 'misconduct', 'litigation', 'major_security_incident')
          )
        )
      )
  ),
  -- J1-b2: official-lane items that the X judgement did not post (rejected) or that carry no existing theme.
  domestic_candidates as (
    select
      candidate.*,
      public.important_news_feed_themes(candidate.category, candidate.title, candidate.affected_entities) as themes
    from market_candidates_all as candidate
  ),
  domestic_unique as (
    select candidate.*
    from domestic_candidates as candidate
    where not exists (
      select 1 from domestic_candidates as other
      where other.id <> candidate.id
        and public.important_news_feed_same_event(
          other.category, other.title, coalesce(other.published_at, other.created_at),
          candidate.category, candidate.title, coalesce(candidate.published_at, candidate.created_at)
        )
        and (coalesce(other.published_at, other.created_at), other.id)
          < (coalesce(candidate.published_at, candidate.created_at), candidate.id)
    )
    and not exists (
      select 1 from base_feed as existing
      where existing.news_id <> candidate.id
        and public.important_news_feed_event_key(existing.title) = public.important_news_feed_event_key(candidate.title)
        and char_length(public.important_news_feed_event_key(candidate.title)) >= 8
    )
  ),
  domestic_matches as (
    select candidate.id, stock.sector, count(*) as stock_count, bool_or(tracked.tracking_type = 'holding') as has_holding
    from domestic_unique as candidate
    inner join public.tracked_stocks as tracked
      on tracked.user_id = (select auth.uid()) and tracked.is_active = true
    inner join public.stocks_master as stock
      on stock.id = tracked.stock_id
     and stock.sector = any(public.important_news_feed_theme_sectors(candidate.themes))
    where cardinality(candidate.themes) > 0
    group by candidate.id, stock.sector
  ),
  domestic_ranked as (
    select
      matches.id,
      array_agg(matches.sector order by matches.stock_count desc, matches.has_holding desc, matches.sector) as sectors,
      bool_or(matches.has_holding) as any_holding
    from domestic_matches as matches
    group by matches.id
  ),
  domestic_feed as (
    select
      candidate.id as news_id,
      null::text as ticker_code,
      '市場全体'::text as company_name,
      case
        when ranked.id is null then 'market'
        when ranked.any_holding then 'holding'
        else 'watch'
      end as tracking_type,
      candidate.title,
      candidate.body_summary as summary,
      candidate.importance,
      coalesce(candidate.published_at, candidate.created_at) as news_time,
      candidate.source_url,
      candidate.effective_severity as severity,
      ranked.sectors[1] as matched_sector,
      array_to_string(candidate.themes, ',') as relevance_reason,
      candidate.source_type,
      candidate.verified_text,
      candidate.visible_app_title_ja as app_title_ja,
      candidate.visible_app_summary_ja as app_summary_ja,
      candidate.visible_app_detail_ja as app_detail_ja,
      candidate.visible_app_key_points_ja as app_key_points_ja,
      ranked.sectors[1:3] as matched_sectors,
      candidate.coverage_categories
    from domestic_unique as candidate
    left join domestic_ranked as ranked on ranked.id = candidate.id
    where (
        ranked.id is not null
        or exists (
          select 1 from public.alert_settings as settings
          where settings.user_id = (select auth.uid())
            and settings.notification_preset = 'all_useful'
        )
      )
      and not exists (select 1 from base_feed as existing where existing.news_id = candidate.id)
      and not exists (select 1 from broad_feed as existing where existing.news_id = candidate.id)
  )
  select combined.*
  from (
    select * from base_feed
    union all
    select * from broad_feed
    union all
    select * from domestic_feed
  ) as combined
  order by combined.news_time desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Authenticated feed: prior feed + all_useful market medium+ + J1-b2 domestic official items (Fact-passed; rejected only from jp_official with critical/high or regulatory/incident category); Japanese copy remains Fact-gated.';
revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_important_stock_news(integer) to authenticated;

commit;
