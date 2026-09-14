-- Phase 5: widen collection diagnostics and all_useful market-wide scope.
-- This is an expand/replace candidate for C2 review only; do not apply to
-- production before explicit C2 approval.

begin;

alter table public.important_news_monitor_runs
  add column if not exists diagnostics jsonb not null default '{}'::jsonb;

-- Keep the existing implementations as private compatibility bases. The new
-- wrappers preserve their behavior and add only the all_useful market-wide
-- audience. No notification dispatcher/claim function is changed.
alter function public.important_news_app_copy_targets(integer)
  rename to important_news_app_copy_targets_phase5_base;
revoke all on function public.important_news_app_copy_targets_phase5_base(integer)
  from public, anon, authenticated, service_role;

create function public.important_news_app_copy_targets(p_limit integer default 5)
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
  market_candidates as (
    select
      news.*,
      coalesce(news.coverage_severity, public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      )) as effective_severity,
      public.important_news_market_themes(news.category, news.title, news.affected_entities) as themes
    from public.important_news_candidates as news
    where news.company_code is null
      and news.duplicate_of is null
      and news.status in (
        'rejected', 'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
  ),
  broad_targets as (
    select candidate.id, coalesce(candidate.published_at, candidate.created_at) as news_time
    from market_candidates as candidate
    where candidate.effective_severity in ('critical', 'high', 'medium')
      and coalesce(candidate.published_at, candidate.created_at) >= now() - interval '6 hours'
      and (candidate.status <> 'rejected' or candidate.source_type in ('tdnet', 'company_ir'))
      and (candidate.title !~ '[ぁ-んァ-ヶ一-龠]')
      and not (candidate.generation_fact_status = 'passed' and coalesce(btrim(candidate.generated_text), '') <> '')
      and candidate.app_copy_fact_status is null
      and candidate.app_copy_attempts = 0
      and (
        exists (
          select 1 from public.alert_settings as settings
          where settings.notification_preset = 'all_useful'
            and (
              coalesce(cardinality(candidate.coverage_categories), 0) = 0
              or exists (
                select 1 from unnest(candidate.coverage_categories) as category(name)
                left join public.alert_category_settings as category_setting
                  on category_setting.user_id = settings.user_id
                 and category_setting.category = category.name
                where coalesce(category_setting.enabled, true)
              )
            )
        )
      )
      and not exists (
        select 1 from market_candidates as other
        where other.id <> candidate.id
          and public.important_news_same_event(
            other.category, other.title, coalesce(other.published_at, other.created_at),
            candidate.category, candidate.title, coalesce(candidate.published_at, candidate.created_at)
          )
          and (
            case when (other.generation_fact_status = 'passed' and coalesce(btrim(other.generated_text), '') <> '')
                       or other.app_copy_fact_status = 'passed'
                       or other.title ~ '[ぁ-んァ-ヶ一-龠]' then 0 else 1 end,
            case other.effective_severity when 'emergency' then 0 when 'critical' then 1 when 'high' then 2 else 3 end,
            coalesce(other.published_at, other.created_at), other.id
          ) < (
            case when (candidate.generation_fact_status = 'passed' and coalesce(btrim(candidate.generated_text), '') <> '')
                       or candidate.app_copy_fact_status = 'passed'
                       or candidate.title ~ '[ぁ-んァ-ヶ一-龠]' then 0 else 1 end,
            case candidate.effective_severity when 'emergency' then 0 when 'critical' then 1 when 'high' then 2 else 3 end,
            coalesce(candidate.published_at, candidate.created_at), candidate.id
          )
      )
  ),
  visible as (
    select id, news_time from base_targets
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
grant execute on function public.important_news_app_copy_targets(integer) to service_role;

alter function public.get_my_important_stock_news(integer)
  rename to get_my_important_stock_news_phase5_base;
revoke all on function public.get_my_important_stock_news_phase5_base(integer)
  from public, anon, authenticated, service_role;

create function public.get_my_important_stock_news(p_limit integer default 50)
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
  )
  select combined.*
  from (
    select * from base_feed
    union all
    select * from broad_feed
  ) as combined
  order by combined.news_time desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Authenticated feed: preserves the prior feed and adds market medium+ to all_useful users without sector matching; Japanese copy remains Fact-gated.';
revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_important_stock_news(integer) to authenticated;

alter function public.enqueue_important_news_notifications(integer)
  rename to enqueue_important_news_notifications_phase5_base;
revoke all on function public.enqueue_important_news_notifications_phase5_base(integer)
  from public, anon, authenticated, service_role;

create function public.enqueue_important_news_notifications(p_window_hours integer default 6)
returns table (notification_id uuid, user_id uuid, candidate_id text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return query
    select base.notification_id, base.user_id, base.candidate_id
    from public.enqueue_important_news_notifications_phase5_base(p_window_hours) as base;

  return query
  with candidate_base as (
    select
      news.*,
      coalesce(news.coverage_severity, public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      )) as effective_severity,
      public.important_news_market_themes(news.category, news.title, news.affected_entities) as themes,
      case
        when news.app_copy_fact_status = 'passed'
          and nullif(btrim(news.app_title_ja), '') is not null
          and nullif(btrim(news.app_summary_ja), '') is not null
          and (news.app_title_ja || news.app_summary_ja) ~ '[ぁ-んァ-ヶ一-龠]'
          then news.app_title_ja
        when news.generation_fact_status = 'passed'
          and nullif(btrim(news.generated_text), '') is not null
          and news.generated_text ~ '[ぁ-んァ-ヶ一-龠]'
          then split_part(nullif(btrim(regexp_replace(news.generated_text, '^\s*(【(重大)?速報】\s*)+', '')), ''), '。', 1)
      end as headline,
      case
        when news.app_copy_fact_status = 'passed'
          and nullif(btrim(news.app_summary_ja), '') is not null
          and news.app_summary_ja ~ '[ぁ-んァ-ヶ一-龠]'
          then news.app_summary_ja
        when news.generation_fact_status = 'passed'
          and nullif(btrim(news.generated_text), '') is not null
          and news.generated_text ~ '[ぁ-んァ-ヶ一-龠]'
          then nullif(btrim(regexp_replace(news.generated_text, '\s*出典\s*[:：]\s*\S+\s*$', '')), '')
      end as push_body
    from public.important_news_candidates as news
    where news.company_code is null
      and news.duplicate_of is null
      and news.status in (
        'rejected', 'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
      and coalesce(news.published_at, news.created_at) >= now()
        - make_interval(hours => greatest(1, least(coalesce(p_window_hours, 6), 24 * 30)))
  ),
  pushable as (
    select candidate.*
    from candidate_base as candidate
    where candidate.effective_severity in ('critical', 'high', 'medium')
      and candidate.headline is not null
      and candidate.push_body is not null
      and (candidate.status <> 'rejected' or candidate.source_type in ('tdnet', 'company_ir'))
  ),
  unique_events as (
    select candidate.*
    from pushable as candidate
    where not exists (
      select 1 from pushable as other
      where other.id <> candidate.id
        and public.important_news_same_event(
          other.category, other.title, coalesce(other.published_at, other.created_at),
          candidate.category, candidate.title, coalesce(candidate.published_at, candidate.created_at)
        )
        and (coalesce(other.published_at, other.created_at), other.id)
          < (coalesce(candidate.published_at, candidate.created_at), candidate.id)
    )
  ),
  recipients as (
    select distinct on (candidate.id, settings.user_id)
      candidate.*,
      settings.user_id as recipient_user_id,
      matched.tracked_stock_id as recipient_tracked_stock_id
    from unique_events as candidate
    inner join public.alert_settings as settings
      on settings.notification_preset = 'all_useful'
     and settings.push_enabled = true
     and settings.important_news = true
    left join lateral (
      select tracked.id as tracked_stock_id
      from public.tracked_stocks as tracked
      inner join public.stocks_master as stock on stock.id = tracked.stock_id
      where tracked.user_id = settings.user_id
        and tracked.is_active = true
        and stock.sector = any(public.important_news_theme_sectors(candidate.themes))
      order by case tracked.tracking_type when 'holding' then 0 else 1 end, tracked.id
      limit 1
    ) as matched on true
    where (
        candidate.effective_severity <> 'emergency'
        or coalesce(settings.emergency_alerts, false)
      )
      and (
        coalesce(cardinality(candidate.coverage_categories), 0) = 0
        or exists (
          select 1 from unnest(candidate.coverage_categories) as category(name)
          left join public.alert_category_settings as category_setting
            on category_setting.user_id = settings.user_id and category_setting.category = category.name
          where coalesce(category_setting.enabled, true)
        )
      )
    order by candidate.id, settings.user_id, matched.tracked_stock_id nulls last
  ),
  deduped as (
    select recipient.*
    from recipients as recipient
    where not exists (
      select 1 from public.notifications as sent
      where sent.user_id = recipient.recipient_user_id
        and sent.source_type = 'important_news'
        and sent.source_id = recipient.id::text
    )
      and not exists (
        select 1
        from public.notifications as sent
        inner join public.important_news_candidates as prior on prior.id::text = sent.source_id
        where sent.user_id = recipient.recipient_user_id
          and sent.source_type = 'important_news'
          and prior.company_code is null
          and prior.id <> recipient.id
          and public.important_news_same_event(
            prior.category, prior.title, coalesce(prior.published_at, prior.created_at),
            recipient.category, recipient.title, coalesce(recipient.published_at, recipient.created_at)
          )
      )
  )
  insert into public.notifications as target (
    user_id, tracked_stock_id, source_type, source_id, title, summary, importance, push_status
  )
  select
    recipient.recipient_user_id,
    recipient.recipient_tracked_stock_id,
    'important_news',
    recipient.id::text,
    left('【市場】' || recipient.headline, 60),
    case when char_length(recipient.push_body) > 140
      then left(recipient.push_body, 139) || '…' else recipient.push_body end,
    case when recipient.effective_severity = 'critical' then 'most_important'
         when recipient.effective_severity = 'high' then 'important' else 'normal' end,
    'pending'
  from deduped as recipient
  on conflict do nothing
  returning target.id, target.user_id, target.source_id;
end
$function$;

comment on function public.enqueue_important_news_notifications(integer) is
  'Service-role producer preserves the prior producer and adds Fact-gated fresh medium+ market news for all_useful users; emergency still requires its dedicated opt-in.';
revoke all on function public.enqueue_important_news_notifications(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_important_news_notifications(integer) to service_role;

commit;
