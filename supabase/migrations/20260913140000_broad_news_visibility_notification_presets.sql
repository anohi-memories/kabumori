-- Phase 3: show useful broad-market news in the app and let each user choose
-- how much important-news push they receive.
--
-- Compatibility is fail-closed for existing users:
-- - existing rows keep notification_preset/emergency_alerts NULL;
-- - NULL preset reproduces the existing company threshold (standard), while
--   market_critical_news remains the dispatch-time market gate;
-- - NULL emergency_alerts is OFF, so applying this migration cannot create an
--   emergency push for an existing user;
-- - defaults apply only to alert_settings rows created after this migration.
--
-- The dispatcher and claim_pending_push_notifications are intentionally not
-- changed. market_critical_news remains a legacy-compatible dispatch gate and
-- is updated atomically when the user explicitly saves these preferences.

begin;

alter table public.alert_settings
  add column if not exists notification_preset text,
  add column if not exists emergency_alerts boolean;

alter table public.alert_settings
  alter column notification_preset set default 'standard',
  alter column emergency_alerts set default true;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.alert_settings'::regclass
      and conname = 'alert_settings_notification_preset_check'
  ) then
    alter table public.alert_settings
      add constraint alert_settings_notification_preset_check
      check (notification_preset is null or notification_preset in ('quiet', 'standard', 'many', 'all_useful'));
  end if;
end
$constraints$;

comment on column public.alert_settings.notification_preset is
  'Important-news volume. NULL is a legacy row; standard is the default for newly created rows.';
comment on column public.alert_settings.emergency_alerts is
  'Market emergency opt-in. NULL means off for a legacy row; true is the default for newly created rows.';

grant select, insert, update (notification_preset, emergency_alerts) on public.alert_settings to authenticated;

create table if not exists public.alert_category_settings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint alert_category_settings_pkey primary key (user_id, category),
  constraint alert_category_settings_category_check check (category in (
    'geopolitics', 'disaster', 'monetary_policy', 'fx', 'rates', 'oil_energy',
    'commodities', 'shipping_logistics', 'semiconductors', 'ai_tech',
    'us_market', 'japan_market', 'regulation_policy', 'corporate', 'earnings',
    'financial_system'
  ))
);

alter table public.alert_category_settings enable row level security;

drop policy if exists alert_category_settings_select_own on public.alert_category_settings;
create policy alert_category_settings_select_own
  on public.alert_category_settings for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists alert_category_settings_insert_own on public.alert_category_settings;
create policy alert_category_settings_insert_own
  on public.alert_category_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists alert_category_settings_update_own on public.alert_category_settings;
create policy alert_category_settings_update_own
  on public.alert_category_settings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists alert_category_settings_delete_own on public.alert_category_settings;
create policy alert_category_settings_delete_own
  on public.alert_category_settings for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.alert_category_settings from anon;
grant select, insert, update, delete on public.alert_category_settings to authenticated;
grant select, insert, update, delete on public.alert_category_settings to service_role;

drop trigger if exists trg_alert_category_settings_updated_at on public.alert_category_settings;
create trigger trg_alert_category_settings_updated_at
before update on public.alert_category_settings
for each row execute function public.kabumori_set_updated_at();

-- One authenticated transaction saves all important-news preferences and keeps
-- the legacy market gate aligned with the dispatcher that rechecks it.
create or replace function public.set_my_important_news_alert_preferences(
  p_important_news boolean,
  p_notification_preset text,
  p_emergency_alerts boolean,
  p_category_settings jsonb default '{}'::jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_notification_preset is null
     or p_notification_preset not in ('quiet', 'standard', 'many', 'all_useful') then
    raise exception 'INVALID_NOTIFICATION_PRESET' using errcode = '22023';
  end if;
  if p_important_news is null or p_emergency_alerts is null
     or p_category_settings is null or jsonb_typeof(p_category_settings) <> 'object' then
    raise exception 'INVALID_ALERT_PREFERENCES' using errcode = '22023';
  end if;

  insert into public.alert_settings as settings (
    user_id, important_news, notification_preset, emergency_alerts, market_critical_news
  ) values (
    v_user_id,
    p_important_news,
    p_notification_preset,
    p_emergency_alerts,
    p_notification_preset <> 'quiet' or p_emergency_alerts
  )
  on conflict (user_id) do update set
    important_news = excluded.important_news,
    notification_preset = excluded.notification_preset,
    emergency_alerts = excluded.emergency_alerts,
    market_critical_news = excluded.market_critical_news;

  insert into public.alert_category_settings as target (user_id, category, enabled)
  select v_user_id, item.key, (item.value #>> '{}')::boolean
  from jsonb_each(p_category_settings) as item
  where item.key in (
    'geopolitics', 'disaster', 'monetary_policy', 'fx', 'rates', 'oil_energy',
    'commodities', 'shipping_logistics', 'semiconductors', 'ai_tech',
    'us_market', 'japan_market', 'regulation_policy', 'corporate', 'earnings',
    'financial_system'
  )
    and jsonb_typeof(item.value) = 'boolean'
  on conflict (user_id, category) do update set enabled = excluded.enabled;
end
$function$;

revoke all on function public.set_my_important_news_alert_preferences(boolean, text, boolean, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_my_important_news_alert_preferences(boolean, text, boolean, jsonb)
  to authenticated;

-- No-tracked-stock emergency recipients need a NULL tracked_stock_id. This
-- partial unique index preserves exact-once enqueue semantics for that shape.
create unique index if not exists notifications_market_news_without_stock_once
  on public.notifications (user_id, source_type, source_id)
  where source_type = 'important_news' and tracked_stock_id is null;

-- ---------------------------------------------------------------------------
-- Japanese app-copy targets: market medium+ is visible; low stays excluded.
-- A market emergency does not require any tracked stock or sector.
-- ---------------------------------------------------------------------------

create or replace function public.important_news_app_copy_targets(p_limit integer default 5)
returns table (id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with candidates as (
    select
      news.*,
      coalesce(news.coverage_severity, public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      )) as effective_severity
    from public.important_news_candidates as news
    where news.duplicate_of is null
      and news.status in (
        'rejected', 'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
  ),
  visible_company as (
    select distinct news.id, coalesce(news.published_at, news.created_at) as news_time
    from candidates as news
    inner join public.stocks_master as stock
      on news.company_code ~ '^[0-9A-Z]{5}$'
     and left(news.company_code, 4) = stock.ticker_code
    inner join public.tracked_stocks as tracked
      on tracked.stock_id = stock.id and tracked.is_active = true
    where news.effective_severity in ('emergency', 'critical', 'high', 'medium')
      and (news.status <> 'rejected' or news.source_type in ('tdnet', 'company_ir'))
  ),
  visible_market as (
    select news.id, coalesce(news.published_at, news.created_at) as news_time
    from candidates as news
    where news.company_code is null
      and news.effective_severity in ('emergency', 'critical', 'high', 'medium')
      and (
        news.effective_severity = 'emergency'
        or exists (
          select 1
          from public.tracked_stocks as tracked
          inner join public.stocks_master as stock on stock.id = tracked.stock_id
          where tracked.is_active = true
            and stock.sector = any(public.important_news_theme_sectors(
              public.important_news_market_themes(news.category, news.title, news.affected_entities)))
        )
      )
  ),
  visible as (
    select id, news_time from visible_company
    union
    select id, news_time from visible_market
  )
  select visible.id
  from visible
  inner join public.important_news_candidates as news on news.id = visible.id
  where (news.title !~ '[ぁ-んァ-ヶ一-龠]'
         or (news.company_code is null and news.coverage_severity = 'emergency'))
    and not (news.generation_fact_status = 'passed' and coalesce(btrim(news.generated_text), '') <> '')
    and news.app_copy_fact_status is null
    and news.app_copy_attempts = 0
  order by visible.news_time desc
  limit greatest(1, least(coalesce(p_limit, 5), 20));
$$;

revoke all on function public.important_news_app_copy_targets(integer) from public, anon, authenticated;
grant execute on function public.important_news_app_copy_targets(integer) to service_role;

-- ---------------------------------------------------------------------------
-- App feed: company behavior is retained; market medium+ is added. Coverage
-- classification wins when present, with the legacy severity as a safe fallback.
-- ---------------------------------------------------------------------------

drop function if exists public.get_my_important_stock_news(integer);

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
  with candidates as (
    select
      news.*,
      coalesce(news.coverage_severity, public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      )) as effective_severity
    from public.important_news_candidates as news
    where news.duplicate_of is null
      and news.status in (
        'rejected', 'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
  ),
  company_feed as (
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
      news.effective_severity as severity,
      null::text as matched_sector,
      null::text as relevance_reason,
      news.source_type,
      case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text,
      case when news.app_copy_fact_status = 'passed' then news.app_title_ja end as app_title_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_summary_ja end as app_summary_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_detail_ja end as app_detail_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_key_points_ja end as app_key_points_ja,
      null::text[] as matched_sectors,
      news.coverage_categories
    from public.tracked_stocks as tracked
    inner join public.stocks_master as stock on stock.id = tracked.stock_id
    inner join candidates as news
      on news.company_code ~ '^[0-9A-Z]{5}$'
     and left(news.company_code, 4) = stock.ticker_code
    where (select auth.uid()) is not null
      and tracked.user_id = (select auth.uid())
      and tracked.is_active = true
      and news.effective_severity in ('emergency', 'critical', 'high', 'medium')
      and (news.status <> 'rejected' or news.source_type in ('tdnet', 'company_ir'))
  ),
  market_candidates as (
    select
      news.*,
      public.important_news_market_themes(news.category, news.title, news.affected_entities) as themes,
      case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text,
      case when news.app_copy_fact_status = 'passed' then news.app_title_ja end as visible_app_title_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_summary_ja end as visible_app_summary_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_detail_ja end as visible_app_detail_ja,
      case when news.app_copy_fact_status = 'passed' then news.app_key_points_ja end as visible_app_key_points_ja
    from candidates as news
    where (select auth.uid()) is not null
      and news.company_code is null
      and news.effective_severity in ('emergency', 'critical', 'high', 'medium')
  ),
  market_unique as (
    select candidate.*
    from market_candidates as candidate
    where not exists (
      select 1 from market_candidates as other
      where other.id <> candidate.id
        and public.important_news_same_event(other.category, other.title,
              coalesce(other.published_at, other.created_at), candidate.category, candidate.title,
              coalesce(candidate.published_at, candidate.created_at))
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
  market_matches as (
    select
      candidate.id,
      stock.sector,
      count(*) as stock_count,
      bool_or(tracked.tracking_type = 'holding') as has_holding
    from market_unique as candidate
    inner join public.tracked_stocks as tracked
      on tracked.user_id = (select auth.uid()) and tracked.is_active = true
    inner join public.stocks_master as stock
      on stock.id = tracked.stock_id
     and stock.sector = any(public.important_news_theme_sectors(candidate.themes))
    where candidate.effective_severity <> 'emergency'
      and cardinality(candidate.themes) > 0
    group by candidate.id, stock.sector
  ),
  market_ranked as (
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
      case when coalesce(ranked.any_holding, false) then 'holding' else 'watch' end as tracking_type,
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
    from market_unique as candidate
    left join market_ranked as ranked on ranked.id = candidate.id
    where candidate.effective_severity = 'emergency' or ranked.id is not null
  )
  select combined.*
  from (
    select * from company_feed
    union all
    select * from market_feed
  ) as combined
  order by combined.news_time desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Authenticated feed: own company news plus related market medium+; emergency market news needs no tracked sector. Fact-gated app copy only.';

revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_important_stock_news(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Preset-aware producer. It only enqueues fresh, deduped, Fact-passed Japanese
-- copy. The existing dispatcher remains responsible for delivery/retry/CAS.
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_important_news_notifications(p_window_hours integer default 6)
returns table (notification_id uuid, user_id uuid, candidate_id text)
language sql
volatile
security definer
set search_path = ''
as $$
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
    where news.duplicate_of is null
      and news.status in (
        'rejected', 'ready_for_generation', 'generating', 'ready_for_publish',
        'generation_failed', 'publishing', 'publish_failed', 'published'
      )
      and coalesce(news.published_at, news.created_at) >= now()
        - make_interval(hours => greatest(1, least(coalesce(p_window_hours, 6), 24 * 30)))
  ),
  pushable as (
    select candidate.*,
      case candidate.effective_severity
        when 'emergency' then 4 when 'critical' then 3 when 'high' then 2 when 'medium' then 1 else 0
      end as severity_rank
    from candidate_base as candidate
    where candidate.effective_severity in ('emergency', 'critical', 'high', 'medium')
      and candidate.headline is not null
      and candidate.push_body is not null
      and (candidate.status <> 'rejected' or candidate.company_code is null
           or candidate.source_type in ('tdnet', 'company_ir'))
  ),
  unique_events as (
    select candidate.*
    from pushable as candidate
    where candidate.company_code is not null
       or not exists (
         select 1 from pushable as other
         where other.company_code is null
           and other.id <> candidate.id
           and public.important_news_same_event(other.category, other.title,
                 coalesce(other.published_at, other.created_at), candidate.category, candidate.title,
                 coalesce(candidate.published_at, candidate.created_at))
           and (coalesce(other.published_at, other.created_at), other.id)
             < (coalesce(candidate.published_at, candidate.created_at), candidate.id)
       )
  ),
  company_recipients as (
    select distinct on (candidate.id, tracked.user_id)
      candidate.*,
      tracked.user_id as recipient_user_id,
      tracked.id as recipient_tracked_stock_id,
      stock.company_name as recipient_company_name
    from unique_events as candidate
    inner join public.stocks_master as stock
      on candidate.company_code ~ '^[0-9A-Z]{5}$'
     and stock.ticker_code = left(candidate.company_code, 4)
    inner join public.tracked_stocks as tracked
      on tracked.stock_id = stock.id and tracked.is_active = true
    left join public.alert_settings as settings on settings.user_id = tracked.user_id
    where coalesce(settings.push_enabled, true)
      and coalesce(settings.important_news, true)
      and candidate.severity_rank >= case coalesce(settings.notification_preset, 'standard')
        when 'quiet' then 3 when 'standard' then 2 else 1 end
      and (
        coalesce(cardinality(candidate.coverage_categories), 0) = 0
        or exists (
          select 1 from unnest(candidate.coverage_categories) as category(name)
          left join public.alert_category_settings as category_setting
            on category_setting.user_id = tracked.user_id and category_setting.category = category.name
          where coalesce(category_setting.enabled, true)
        )
      )
    order by candidate.id, tracked.user_id, tracked.id
  ),
  market_recipients as (
    select distinct on (candidate.id, settings.user_id)
      candidate.*,
      settings.user_id as recipient_user_id,
      case when candidate.effective_severity = 'emergency' then null::uuid else tracked.id end
        as recipient_tracked_stock_id,
      null::text as recipient_company_name
    from unique_events as candidate
    inner join public.alert_settings as settings
      on settings.push_enabled = true
     and settings.important_news = true
     and settings.market_critical_news = true
    left join public.tracked_stocks as tracked
      on tracked.user_id = settings.user_id
     and tracked.is_active = true
    left join public.stocks_master as stock on stock.id = tracked.stock_id
    where candidate.company_code is null
      and (
        (candidate.effective_severity = 'emergency' and coalesce(settings.emergency_alerts, false))
        or (
          candidate.effective_severity <> 'emergency'
          and stock.sector = any(public.important_news_theme_sectors(candidate.themes))
          and candidate.severity_rank >= case coalesce(settings.notification_preset, 'standard')
            when 'quiet' then 4 when 'standard' then 3 when 'many' then 2 else 1 end
        )
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
    order by candidate.id, settings.user_id, tracked.id nulls last
  ),
  recipients as (
    select * from company_recipients
    union all
    select * from market_recipients
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
      and (
        recipient.company_code is not null
        or not exists (
          select 1
          from public.notifications as sent
          inner join public.important_news_candidates as prior on prior.id::text = sent.source_id
          where sent.user_id = recipient.recipient_user_id
            and sent.source_type = 'important_news'
            and prior.company_code is null
            and prior.id <> recipient.id
            and public.important_news_same_event(prior.category, prior.title,
                  coalesce(prior.published_at, prior.created_at), recipient.category, recipient.title,
                  coalesce(recipient.published_at, recipient.created_at))
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
    left(case when recipient.company_code is null then '【市場】'
              else '【' || recipient.recipient_company_name || '】' end || recipient.headline, 60),
    case when char_length(recipient.push_body) > 140
      then left(recipient.push_body, 139) || '…' else recipient.push_body end,
    case when recipient.effective_severity in ('emergency', 'critical') then 'most_important'
         when recipient.effective_severity = 'high' then 'important' else 'normal' end,
    'pending'
  from deduped as recipient
  on conflict do nothing
  returning target.id, target.user_id, target.source_id;
$$;

comment on function public.enqueue_important_news_notifications(integer) is
  'Service-role producer for fresh preset/category/emergency-aware important-news notifications. Fact-passed Japanese text and dedupe required.';

revoke all on function public.enqueue_important_news_notifications(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_important_news_notifications(integer) to service_role;

commit;
