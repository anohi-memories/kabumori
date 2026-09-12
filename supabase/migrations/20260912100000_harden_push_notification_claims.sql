begin;

-- A notification may be claimed by exactly one dispatcher at a time. A claim
-- that outlives the Edge Function's maximum runtime is terminally failed rather
-- than put back in the queue: Expo may already have accepted the request.
alter table public.notifications
  drop constraint if exists notifications_push_status_check;

alter table public.notifications
  add constraint notifications_push_status_check
  check (push_status in ('pending', 'processing', 'sent', 'failed', 'skipped'));

alter table public.notifications
  add column if not exists push_attempt_count integer not null default 0,
  add column if not exists push_next_attempt_at timestamptz,
  add column if not exists push_claimed_at timestamptz,
  add column if not exists push_claim_token uuid,
  add column if not exists push_last_error_code text;

do $constraint$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notifications'::regclass
      and conname = 'notifications_push_attempt_count_nonnegative'
  ) then
    alter table public.notifications
      add constraint notifications_push_attempt_count_nonnegative
      check (push_attempt_count >= 0);
  end if;
end
$constraint$;

create index if not exists notifications_pending_push_due_idx
  on public.notifications (push_next_attempt_at, created_at, id)
  where push_status = 'pending';

create index if not exists notifications_processing_push_claimed_idx
  on public.notifications (push_claimed_at)
  where push_status = 'processing';

create or replace function public.claim_pending_push_notifications(p_limit integer default 200)
returns table (
  id uuid,
  user_id uuid,
  title text,
  summary text,
  importance text,
  source_type text,
  source_id text,
  claim_token uuid,
  attempt_count integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 200);
begin
  -- The Expo request may have succeeded before the invocation was terminated.
  -- Never automatically resend an expired claim because acceptance is unknown.
  update public.notifications as n
     set push_status = 'failed',
         push_claimed_at = null,
         push_claim_token = null,
         push_next_attempt_at = null,
         push_last_error_code = 'PUSH_DELIVERY_OUTCOME_UNKNOWN'
   where n.push_status = 'processing'
     and (n.push_claimed_at is null or n.push_claimed_at < pg_catalog.clock_timestamp() - interval '15 minutes');

  -- Re-evaluate current opt-outs at claim time. Source-specific checks are only
  -- applied when the persisted source can be identified without guessing.
  update public.notifications as n
     set push_status = 'skipped',
         push_next_attempt_at = null,
         push_last_error_code = 'PUSH_DISABLED_BEFORE_DISPATCH'
   where n.push_status = 'pending'
     and not (
       coalesce((select s.push_enabled from public.alert_settings as s where s.user_id = n.user_id), true)
       and case
         when n.source_type = 'important_news' then
           coalesce((select s.important_news from public.alert_settings as s where s.user_id = n.user_id), true)
           and (
             exists (
               select 1 from public.important_news_candidates as c
                where c.id::text = n.source_id and c.company_code is not null
             )
             or (
               coalesce((select s.market_critical_news from public.alert_settings as s where s.user_id = n.user_id), false)
               and exists (
                 select 1 from public.important_news_candidates as c
                  where c.id::text = n.source_id and c.company_code is null
               )
             )
           )
         when n.source_type = 'personalized_report' then
           exists (
             select 1
               from public.personalized_reports as r
               join public.alert_settings as s on s.user_id = r.user_id
              where r.id::text = n.source_id
                and r.user_id = n.user_id
                and (
                  (r.report_type = 'morning' and s.morning_report)
                  or (r.report_type = 'close' and s.close_report)
                )
           )
         else true
       end
     );

  return query
  with candidates as materialized (
    select n.id
      from public.notifications as n
     where n.push_status = 'pending'
       and (n.push_next_attempt_at is null or n.push_next_attempt_at <= pg_catalog.clock_timestamp())
       and coalesce((select s.push_enabled from public.alert_settings as s where s.user_id = n.user_id), true)
       and case
         when n.source_type = 'important_news' then
           coalesce((select s.important_news from public.alert_settings as s where s.user_id = n.user_id), true)
           and (
             exists (
               select 1 from public.important_news_candidates as c
                where c.id::text = n.source_id and c.company_code is not null
             )
             or (
               coalesce((select s.market_critical_news from public.alert_settings as s where s.user_id = n.user_id), false)
               and exists (
                 select 1 from public.important_news_candidates as c
                  where c.id::text = n.source_id and c.company_code is null
               )
             )
           )
         when n.source_type = 'personalized_report' then
           exists (
             select 1
               from public.personalized_reports as r
               join public.alert_settings as s on s.user_id = r.user_id
              where r.id::text = n.source_id
                and r.user_id = n.user_id
                and (
                  (r.report_type = 'morning' and s.morning_report)
                  or (r.report_type = 'close' and s.close_report)
                )
           )
         else true
       end
     order by n.created_at, n.id
     limit v_limit
     for update of n skip locked
  ), claimed as (
    update public.notifications as n
       set push_status = 'processing',
           push_attempt_count = n.push_attempt_count + 1,
           push_claimed_at = pg_catalog.clock_timestamp(),
           push_claim_token = pg_catalog.gen_random_uuid(),
           push_next_attempt_at = null,
           push_last_error_code = null
      from candidates as c
     where n.id = c.id
       and n.push_status = 'pending'
    returning n.id, n.user_id, n.title, n.summary, n.importance,
              n.source_type, n.source_id, n.push_claim_token, n.push_attempt_count
  )
  select c.id, c.user_id, c.title, c.summary, c.importance,
         c.source_type, c.source_id, c.push_claim_token, c.push_attempt_count
    from claimed as c;
end
$function$;

revoke all on function public.claim_pending_push_notifications(integer)
  from public, anon, authenticated;
grant execute on function public.claim_pending_push_notifications(integer) to service_role;

comment on function public.claim_pending_push_notifications(integer) is
  'Atomically claims due push notifications, rechecks persisted opt-outs, and terminally fails expired claims without resending uncertain Expo requests.';

commit;
