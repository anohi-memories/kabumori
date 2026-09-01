create table if not exists public.posting_blackouts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  start_time time not null,
  end_time time not null,
  timezone text not null default 'Asia/Tokyo',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);

alter table public.posting_blackouts enable row level security;
grant select on public.posting_blackouts to service_role;

insert into public.posting_blackouts (name, start_time, end_time, timezone)
values
  ('大引けまとめ保護枠', '15:40', '16:20', 'Asia/Tokyo'),
  ('米国市場前チェック保護枠', '21:00', '21:40', 'Asia/Tokyo')
on conflict (name) do update
set start_time = excluded.start_time,
    end_time = excluded.end_time,
    timezone = excluded.timezone,
    is_active = true;

create or replace function public.plan_daily_posts(
  p_date date default ((now() at time zone 'Asia/Tokyo')::date)
)
returns setof public.scheduled_posts
language plpgsql
security definer
set search_path = public
as $$
declare
  window_row public.posting_windows%rowtype;
  random_seconds integer;
  local_now timestamp;
  effective_start time;
  probability_bucket integer;
  candidate_local timestamp;
  candidate_time timestamptz;
  candidate_found boolean;
  selection_attempt integer;
begin
  -- Important and regular posts are planned first. Interaction posts are placed last.
  for window_row in
    select * from public.posting_windows
    where is_active
    order by (post_type = 'interaction'), post_type, slot_no
  loop
    probability_bucket := mod(
      abs(hashtextextended(p_date::text || ':' || window_row.post_type || ':' || window_row.slot_no, 0)),
      10000
    )::integer;
    if probability_bucket >= floor(window_row.daily_probability * 10000)::integer then
      continue;
    end if;

    if exists (
      select 1 from public.scheduled_posts
      where schedule_date = p_date
        and post_type = window_row.post_type
        and slot_no = window_row.slot_no
    ) then
      continue;
    end if;

    local_now := now() at time zone window_row.timezone;
    effective_start := window_row.start_time;
    if p_date = local_now::date then
      if local_now::time >= window_row.end_time then continue; end if;
      if local_now::time > window_row.start_time then
        effective_start := (local_now + interval '1 minute')::time;
      end if;
    end if;

    candidate_found := false;
    for selection_attempt in 1..40 loop
      random_seconds := floor(
        random() * (extract(epoch from (window_row.end_time - effective_start)) + 1)
      )::integer;
      candidate_local := p_date + effective_start + random_seconds * interval '1 second';
      candidate_time := candidate_local at time zone window_row.timezone;

      if window_row.post_type = 'interaction' then
        -- Keep at least 20 minutes away from every other scheduled post.
        if exists (
          select 1 from public.scheduled_posts other_post
          where other_post.schedule_date = p_date
            and other_post.post_type <> 'interaction'
            and other_post.status in ('pending', 'running', 'succeeded')
            and other_post.scheduled_for between
              candidate_time - interval '20 minutes'
              and candidate_time + interval '20 minutes'
        ) then
          continue;
        end if;

        -- Also reserve important recurring periods before their post types are implemented.
        if exists (
          select 1 from public.posting_blackouts blackout
          where blackout.is_active
            and (candidate_time at time zone blackout.timezone)::time
              between blackout.start_time and blackout.end_time
        ) then
          continue;
        end if;
      end if;

      candidate_found := true;
      exit;
    end loop;

    -- No safe time was found: skip this interaction slot for the day.
    if not candidate_found then continue; end if;

    insert into public.scheduled_posts
      (schedule_date, post_type, slot_no, scheduled_for)
    values (p_date, window_row.post_type, window_row.slot_no, candidate_time)
    on conflict (schedule_date, post_type, slot_no) do nothing;
  end loop;

  return query
  select * from public.scheduled_posts
  where schedule_date = p_date
  order by scheduled_for;
end;
$$;

-- Keep interaction publication disabled until the explicit activation step.
update public.posting_windows
set is_active = false
where post_type = 'interaction';
