create table if not exists public.posting_windows (
  id uuid primary key default gen_random_uuid(),
  post_type text not null,
  slot_no smallint not null,
  start_time time not null,
  end_time time not null,
  timezone text not null default 'Asia/Tokyo',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (post_type, slot_no),
  check (end_time > start_time)
);

create table if not exists public.scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  schedule_date date not null,
  post_type text not null,
  slot_no smallint not null,
  scheduled_for timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed')),
  attempt_count integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (schedule_date, post_type, slot_no)
);

create index if not exists scheduled_posts_due_idx
  on public.scheduled_posts (status, scheduled_for);

create table if not exists public.post_execution_logs (
  id bigint generated always as identity primary key,
  scheduled_post_id uuid references public.scheduled_posts(id),
  post_type text not null,
  status text not null check (status in ('started', 'succeeded', 'failed')),
  tip_id uuid references public.tips(id),
  x_post_id text,
  message text,
  created_at timestamptz not null default now()
);

alter table public.posting_windows enable row level security;
alter table public.scheduled_posts enable row level security;
alter table public.post_execution_logs enable row level security;

grant select on public.posting_windows to service_role;
grant select on public.scheduled_posts to service_role;
grant select on public.post_execution_logs to service_role;

insert into public.posting_windows
  (post_type, slot_no, start_time, end_time, timezone)
values
  ('tip', 1, '10:30', '11:45', 'Asia/Tokyo'),
  ('tip', 2, '12:15', '13:30', 'Asia/Tokyo'),
  ('tip', 3, '17:00', '19:00', 'Asia/Tokyo')
on conflict (post_type, slot_no) do update
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
begin
  for window_row in
    select * from public.posting_windows where is_active order by post_type, slot_no
  loop
    local_now := now() at time zone window_row.timezone;
    effective_start := window_row.start_time;

    if p_date = local_now::date then
      if local_now::time >= window_row.end_time then
        continue;
      end if;
      if local_now::time > window_row.start_time then
        effective_start := (local_now + interval '1 minute')::time;
      end if;
    end if;

    random_seconds := floor(
      random() * (extract(epoch from (window_row.end_time - effective_start)) + 1)
    )::integer;

    insert into public.scheduled_posts (
      schedule_date, post_type, slot_no, scheduled_for
    ) values (
      p_date,
      window_row.post_type,
      window_row.slot_no,
      ((p_date + effective_start + random_seconds * interval '1 second')
        at time zone window_row.timezone)
    )
    on conflict (schedule_date, post_type, slot_no) do nothing;
  end loop;

  return query
  select * from public.scheduled_posts
  where schedule_date = p_date
  order by scheduled_for;
end;
$$;

create or replace function public.claim_due_post()
returns setof public.scheduled_posts
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  perform public.plan_daily_posts();

  select id into claimed_id
  from public.scheduled_posts
  where status = 'pending' and scheduled_for <= now()
  order by scheduled_for
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.scheduled_posts
  set status = 'running', started_at = now(), attempt_count = attempt_count + 1
  where id = claimed_id;

  insert into public.post_execution_logs (scheduled_post_id, post_type, status, message)
  select id, post_type, 'started', 'Scheduled post claimed'
  from public.scheduled_posts where id = claimed_id;

  return query select * from public.scheduled_posts where id = claimed_id;
end;
$$;

create or replace function public.complete_tip_post(
  p_scheduled_post_id uuid,
  p_tip_id uuid,
  p_x_post_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tips
  set last_used_at = now(), use_count = use_count + 1
  where id = p_tip_id;

  update public.scheduled_posts
  set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';

  insert into public.post_execution_logs
    (scheduled_post_id, post_type, status, tip_id, x_post_id, message)
  values
    (p_scheduled_post_id, 'tip', 'succeeded', p_tip_id, p_x_post_id, 'X post created');
end;
$$;

create or replace function public.fail_scheduled_post(
  p_scheduled_post_id uuid,
  p_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_type text;
begin
  update public.scheduled_posts
  set status = 'failed', finished_at = now()
  where id = p_scheduled_post_id and status = 'running'
  returning post_type into selected_type;

  if selected_type is not null then
    insert into public.post_execution_logs
      (scheduled_post_id, post_type, status, message)
    values
      (p_scheduled_post_id, selected_type, 'failed', left(p_message, 300));
  end if;
end;
$$;

revoke all on function public.plan_daily_posts(date) from public;
revoke all on function public.claim_due_post() from public;
revoke all on function public.complete_tip_post(uuid, uuid, text) from public;
revoke all on function public.fail_scheduled_post(uuid, text) from public;

grant execute on function public.plan_daily_posts(date) to service_role;
grant execute on function public.claim_due_post() to service_role;
grant execute on function public.complete_tip_post(uuid, uuid, text) to service_role;
grant execute on function public.fail_scheduled_post(uuid, text) to service_role;
