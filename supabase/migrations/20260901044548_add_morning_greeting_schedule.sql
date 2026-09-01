-- Plan one morning greeting every calendar day, including weekends and holidays.
-- The generic daily planner stores the selected Asia/Tokyo wall-clock time as
-- timestamptz and the scheduled_posts uniqueness constraint prevents duplicates.
insert into public.posting_windows
  (post_type, slot_no, start_time, end_time, timezone, daily_probability, is_active)
values
  ('morning_greeting', 1, '07:00:00', '07:30:00', 'Asia/Tokyo', 1, true)
on conflict (post_type, slot_no) do update
set start_time = excluded.start_time,
    end_time = excluded.end_time,
    timezone = excluded.timezone,
    daily_probability = excluded.daily_probability,
    is_active = true;

-- Generation and publication for morning_greeting are intentionally not part of
-- STEP 1. Keep its pending rows out of the dispatcher until that path is added.
create or replace function public.claim_due_post()
returns setof public.scheduled_posts
language plpgsql
security definer
set search_path = public
as $$
declare claimed_id uuid;
begin
  perform public.plan_morning_report();
  perform public.plan_close_report();
  perform public.plan_daily_posts();
  perform public.plan_weekly_useful_tips();
  -- Plan last so its ±20 minute collision check sees all other scheduled content.
  perform public.plan_us_premarket_report();

  select id into claimed_id from public.scheduled_posts
  where status = 'pending'
    and scheduled_for <= now()
    and post_type <> 'morning_greeting'
  order by scheduled_for for update skip locked limit 1;
  if claimed_id is null then return; end if;

  update public.scheduled_posts
  set status = 'running', started_at = now(), attempt_count = attempt_count + 1
  where id = claimed_id;
  insert into public.post_execution_logs (scheduled_post_id, post_type, status, message)
  select id, post_type, 'started', 'Scheduled post claimed'
  from public.scheduled_posts where id = claimed_id;
  return query select * from public.scheduled_posts where id = claimed_id;
end;
$$;
