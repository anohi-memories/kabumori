-- Personalized portfolio morning / close reports (app only), Phase 1.
--
-- A separate lane from the public X morning_report / close_report. Those runs
-- stay untouched; this lane builds one report per user per trading day from:
--   * the user's own tracked_stocks (holding / watch, quantity, average price,
--     position type, side),
--   * prices fetched and computed deterministically by the
--     personalized-reports Edge Function (never by the LLM),
--   * news that is already Fact-passed (app copy / verified post) or a verbatim
--     primary disclosure title, via the same feed the /news tab uses.
--
-- Expand-only: one new table, one partial unique index on notifications, and
-- three new service-role functions. Nothing existing is altered or dropped.
begin;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------

create table if not exists public.personalized_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  report_type text not null,
  trading_date date not null,
  status text not null default 'generating',
  title_ja text,
  summary_ja text,
  -- LLM-written sections; only shown once fact_status = 'passed'.
  body jsonb not null default '{}'::jsonb,
  -- Deterministic numbers computed in code (prices, changes, contributions).
  portfolio_snapshot jsonb not null default '{}'::jsonb,
  -- Which news / market inputs the report was built from.
  source_basis jsonb not null default '{}'::jsonb,
  fact_status text not null default 'pending',
  fact_issues jsonb not null default '[]'::jsonb,
  model_used text,
  input_tokens integer,
  output_tokens integer,
  api_cost_usd numeric,
  error text,
  generated_at timestamptz,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint personalized_reports_type_check check (report_type in ('morning', 'close')),
  constraint personalized_reports_status_check check (status in ('generating', 'completed', 'failed')),
  constraint personalized_reports_fact_check check (fact_status in ('pending', 'passed', 'failed')),
  -- A completed report is always a Fact-passed one.
  constraint personalized_reports_completed_passed check (status <> 'completed' or fact_status = 'passed'),
  -- One report per user, type and trading day; also the generation claim.
  constraint personalized_reports_user_type_date unique (user_id, report_type, trading_date)
);

create index if not exists idx_personalized_reports_user_recent
  on public.personalized_reports (user_id, trading_date desc, report_type);

alter table public.personalized_reports enable row level security;

drop policy if exists personalized_reports_select_own on public.personalized_reports;
create policy personalized_reports_select_own
  on public.personalized_reports
  for select
  to authenticated
  using ((select auth.uid()) = user_id and status = 'completed' and fact_status = 'passed');

revoke all on table public.personalized_reports from public, anon, authenticated;
grant select on table public.personalized_reports to authenticated;
grant all on table public.personalized_reports to service_role;

comment on table public.personalized_reports is
  'App-only per-user morning/close portfolio reports. Written by the personalized-reports Edge Function (service role); readers see only their own completed, Fact-passed rows.';

-- ---------------------------------------------------------------------------
-- Push dedupe: at most one notification per user per report
-- ---------------------------------------------------------------------------
-- notifications_dedupe includes tracked_stock_id, which is NULL for a report
-- notification, so it cannot stop duplicates on its own.

create unique index if not exists notifications_personalized_report_once
  on public.notifications (user_id, source_type, source_id)
  where source_type = 'personalized_report';

-- ---------------------------------------------------------------------------
-- News inputs: the user's /news feed, restricted to Fact-passed text
-- ---------------------------------------------------------------------------
-- Reuses get_my_important_stock_news verbatim (same per-stock gate, same
-- market-wide event dedupe and sector ranking) by running it as the target
-- user for the duration of this call, then restoring the caller's claims.
-- Only three kinds of text leave this function:
--   app_copy          app_*_ja with app_copy_fact_status = 'passed'
--   verified_post     generated_text with generation_fact_status = 'passed'
--   disclosure_title  the verbatim TDnet / company IR title (a primary source)
-- A row with none of them is dropped, so raw or unverified text never reaches
-- the report generator.

create or replace function public.personalized_report_news_inputs(
  p_user_id uuid,
  p_since timestamptz
)
returns table (
  news_id uuid,
  ticker_code text,
  company_name text,
  tracking_type text,
  severity text,
  matched_sectors text[],
  news_time timestamptz,
  source_url text,
  source_type text,
  text_origin text,
  headline_ja text,
  summary_ja text,
  key_points_ja jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  previous_claims text := current_setting('request.jwt.claims', true);
  previous_sub text := current_setting('request.jwt.claim.sub', true);
begin
  if p_user_id is null then
    return;
  end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);

  return query
  with feed as (
    select f.*
    from public.get_my_important_stock_news(50) as f
    where f.news_time >= coalesce(p_since, now() - interval '24 hours')
  ),
  texted as (
    select
      feed.*,
      nullif(btrim(regexp_replace(
        regexp_replace(
          regexp_replace(feed.verified_text, '\s*出典\s*[:：]\s*\S+\s*$', ''),
          '^\s*(【(重大)?速報】\s*)+', ''),
        '\s+', ' ', 'g')), '') as verified_body
    from feed
  )
  select
    t.news_id,
    t.ticker_code,
    t.company_name,
    t.tracking_type,
    t.severity,
    t.matched_sectors,
    t.news_time,
    t.source_url,
    t.source_type,
    case
      when nullif(btrim(t.app_title_ja), '') is not null and nullif(btrim(t.app_summary_ja), '') is not null then 'app_copy'
      when t.verified_body is not null then 'verified_post'
      else 'disclosure_title'
    end,
    case
      when nullif(btrim(t.app_title_ja), '') is not null and nullif(btrim(t.app_summary_ja), '') is not null then btrim(t.app_title_ja)
      when t.verified_body is not null then split_part(t.verified_body, '。', 1)
      else btrim(t.title)
    end,
    case
      when nullif(btrim(t.app_title_ja), '') is not null and nullif(btrim(t.app_summary_ja), '') is not null then btrim(t.app_summary_ja)
      when t.verified_body is not null then t.verified_body
      else null
    end,
    case
      when nullif(btrim(t.app_title_ja), '') is not null and nullif(btrim(t.app_summary_ja), '') is not null
        then coalesce(t.app_key_points_ja, '[]'::jsonb)
      else '[]'::jsonb
    end
  from texted as t
  where (nullif(btrim(t.app_title_ja), '') is not null and nullif(btrim(t.app_summary_ja), '') is not null)
     or t.verified_body is not null
     or (t.ticker_code is not null
         and t.source_type in ('tdnet', 'company_ir')
         and nullif(btrim(t.title), '') is not null)
  order by t.news_time desc;

  perform set_config('request.jwt.claims', coalesce(previous_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
end;
$$;

comment on function public.personalized_report_news_inputs(uuid, timestamptz) is
  'Service-role only: a user''s /news feed since p_since, reduced to Fact-passed Japanese text or verbatim disclosure titles, as input for personalized reports.';

revoke all on function public.personalized_report_news_inputs(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.personalized_report_news_inputs(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Completion push: only after a completed, Fact-passed report, once
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_personalized_report_notification(p_report_id uuid)
returns table (notification_id uuid, user_id uuid, report_id uuid)
language sql
volatile
security definer
set search_path = ''
as $$
  with report as (
    select r.id, r.user_id, r.report_type, r.title_ja
    from public.personalized_reports as r
    inner join public.alert_settings as settings
      on settings.user_id = r.user_id
     and settings.push_enabled = true
     and (
       (r.report_type = 'morning' and settings.morning_report = true)
       or (r.report_type = 'close' and settings.close_report = true)
     )
    where r.id = p_report_id
      and r.status = 'completed'
      and r.fact_status = 'passed'
      and nullif(btrim(r.title_ja), '') is not null
  ),
  inserted as (
    insert into public.notifications as target
      (user_id, tracked_stock_id, source_type, source_id, title, summary, importance, push_status)
    select
      report.user_id,
      null,
      'personalized_report',
      report.id::text,
      case report.report_type
        when 'morning' then '今日のあなたのポート見通しができました'
        else '今日のポート振り返りができました'
      end,
      case when char_length(report.title_ja) > 140 then left(report.title_ja, 139) || '…' else report.title_ja end,
      'normal',
      'pending'
    from report
    on conflict (user_id, source_type, source_id) where source_type = 'personalized_report' do nothing
    returning target.id, target.user_id, target.source_id
  ),
  marked as (
    update public.personalized_reports as r
       set notified_at = now(), updated_at = now()
      from inserted
     where r.id = inserted.source_id::uuid
    returning r.id
  )
  select inserted.id, inserted.user_id, inserted.source_id::uuid
  from inserted;
$$;

comment on function public.enqueue_personalized_report_notification(uuid) is
  'Service-role only: queue one completion push for a completed, Fact-passed personalized report when the owner has push_enabled and the matching morning_report / close_report setting on.';

revoke all on function public.enqueue_personalized_report_notification(uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_personalized_report_notification(uuid) to service_role;

commit;
