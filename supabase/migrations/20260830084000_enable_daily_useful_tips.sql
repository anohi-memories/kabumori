update public.useful_tip_schedule_settings
set is_active = true,
    posts_per_week = 7,
    updated_at = now()
where id = true;

create or replace function public.plan_weekly_useful_tips(
  p_week_start date default (date_trunc('week', now() at time zone 'Asia/Tokyo'))::date
) returns setof public.scheduled_posts
language plpgsql security definer set search_path=public as $$
declare
  s public.useful_tip_schedule_settings%rowtype;
  d date;
  today_jst date := (now() at time zone 'Asia/Tokyo')::date;
  candidate timestamptz;
  local_candidate timestamp;
  use_a boolean;
  attempt integer;
begin
  select * into s from public.useful_tip_schedule_settings where id=true;
  if not found or not s.is_active then return; end if;

  for d in
    select day_date from (
      select p_week_start+i as day_date,
        abs(hashtextextended((p_week_start+i)::text||':'||p_week_start::text,0)) as rank_key
      from generate_series(0,6) i
    ) ranked order by rank_key limit s.posts_per_week
  loop
    -- Enabling mid-week must never create a backlog for past dates.
    if d < today_jst then continue; end if;
    if exists(select 1 from public.scheduled_posts where schedule_date=d and post_type='useful_tip') then continue; end if;
    use_a := mod(abs(hashtextextended(d::text||':useful_tip_window',0)),2)=0;
    for attempt in 1..40 loop
      if attempt=21 then use_a := not use_a; end if;
      if use_a then
        local_candidate := d+s.window_a_start+floor(random()*(extract(epoch from (s.window_a_end-s.window_a_start))+1))*interval '1 second';
      else
        local_candidate := d+s.window_b_start+floor(random()*(extract(epoch from (s.window_b_end-s.window_b_start))+1))*interval '1 second';
      end if;
      candidate := local_candidate at time zone s.timezone;
      if candidate <= now() then continue; end if;
      if exists(
        select 1 from public.scheduled_posts p where p.schedule_date=d
        and p.status in ('pending','running','succeeded')
        and p.scheduled_for between candidate-(s.collision_minutes||' minutes')::interval
                                and candidate+(s.collision_minutes||' minutes')::interval
      ) then continue; end if;
      if exists(
        select 1 from public.posting_blackouts b where b.is_active
        and (candidate at time zone b.timezone)::time between b.start_time and b.end_time
      ) then continue; end if;
      insert into public.scheduled_posts(schedule_date,post_type,slot_no,scheduled_for)
      values(d,'useful_tip',1,candidate) on conflict do nothing;
      exit;
    end loop;
  end loop;
  return query select * from public.scheduled_posts
    where schedule_date between greatest(p_week_start,today_jst) and p_week_start+6
      and post_type='useful_tip' order by scheduled_for;
end
$$;

revoke all on function public.plan_weekly_useful_tips(date) from public;
grant execute on function public.plan_weekly_useful_tips(date) to service_role;

select public.plan_weekly_useful_tips();
