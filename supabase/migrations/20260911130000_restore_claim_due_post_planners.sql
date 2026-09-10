-- Restore the planner chain that Phase 2's brand-aware claim_due_post()
-- unintentionally narrowed to plan_daily_posts() only. Report windows remain
-- inactive, so their dedicated planners are still the sole scheduling path for
-- morning_report and close_report; generic windows cannot create duplicates.
create or replace function public.claim_due_post()
returns setof public.scheduled_posts
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  -- Dedicated report planners retain their own settings, JPX-business-day,
  -- fixed-center-time, and ON CONFLICT duplicate safeguards.
  perform public.plan_morning_report();
  perform public.plan_close_report();

  -- Keep the existing generic and specialised planner sequence intact.
  perform public.plan_daily_posts();
  perform public.plan_weekly_useful_tips();
  perform public.plan_us_premarket_report();

  select id into claimed_id
  from public.scheduled_posts
  where status = 'pending'
    and scheduled_for <= now()
  order by scheduled_for
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.scheduled_posts
  set status = 'running',
      started_at = now(),
      attempt_count = attempt_count + 1
  where id = claimed_id;

  insert into public.post_execution_logs (scheduled_post_id, post_type, status, message)
  select id, post_type, 'started', 'Scheduled post claimed'
  from public.scheduled_posts
  where id = claimed_id;

  return query
  select * from public.scheduled_posts
  where id = claimed_id;
end;
$$;

-- Preserve the internal-only RPC boundary after CREATE OR REPLACE.
revoke all on function public.claim_due_post() from public, anon, authenticated;
grant execute on function public.claim_due_post() to service_role;
