drop table if exists public.us_premarkarket_report_settings;

create table if not exists public.us_premarket_report_settings (
  id boolean primary key default true check (id),
  is_active boolean not null default false,
  summer_window_start time not null default '21:50',
  summer_window_end time not null default '22:10',
  winter_window_start time not null default '22:50',
  winter_window_end time not null default '23:10',
  timezone text not null default 'Asia/Tokyo',
  collision_minutes integer not null default 20 check (collision_minutes between 0 and 120),
  max_resamples integer not null default 40 check (max_resamples between 1 and 100),
  updated_at timestamptz not null default now()
);

create table if not exists public.us_premarket_report_runs (
  id uuid primary key default gen_random_uuid(),
  scheduled_post_id uuid references public.scheduled_posts(id),
  scheduled_at timestamptz not null,
  generated_at timestamptz,
  post_type text not null default 'us_premarket_report',
  source_urls jsonb not null default '[]'::jsonb,
  market_data_timestamp timestamptz,
  market_data jsonb not null default '{}'::jsonb,
  model_used text not null,
  input_tokens integer,
  output_tokens integer,
  web_search_calls integer,
  api_cost_usd numeric(12,6),
  fact_check_status text check (fact_check_status in ('passed', 'failed')),
  fact_check_notes jsonb not null default '[]'::jsonb,
  voice_evaluation jsonb not null default '{}'::jsonb,
  x_post_id text,
  status text not null check (status in (
    'generating', 'dry_run_succeeded', 'succeeded', 'failed', 'skipped_holiday'
  )),
  error text,
  generated_text text,
  character_count integer,
  created_at timestamptz not null default now()
);

create index if not exists us_premarket_report_runs_scheduled_at_idx
  on public.us_premarket_report_runs (scheduled_at desc);

alter table public.us_premarket_report_settings enable row level security;
alter table public.us_premarket_report_runs enable row level security;
grant select on public.us_premarket_report_settings to service_role;
grant select, insert, update on public.us_premarket_report_runs to service_role;

insert into public.us_premarket_report_settings (id, is_active)
values (true, false)
on conflict (id) do update set
  summer_window_start = '21:50', summer_window_end = '22:10',
  winter_window_start = '22:50', winter_window_end = '23:10',
  timezone = 'Asia/Tokyo', collision_minutes = 20, max_resamples = 40,
  is_active = false, updated_at = now();

insert into public.posting_windows
  (post_type, slot_no, start_time, end_time, timezone, daily_probability, is_active)
values ('us_premarket_report', 1, '21:50', '23:10', 'Asia/Tokyo', 1, false)
on conflict (post_type, slot_no) do update set
  start_time = excluded.start_time, end_time = excluded.end_time,
  timezone = excluded.timezone, daily_probability = 1, is_active = false;

insert into public.market_holidays (market, holiday_date, name, source_url) values
  ('NYSE', '2026-01-01', 'New Year''s Day', 'https://www.nyse.com/markets/hours-calendars'),
  ('NYSE', '2026-01-19', 'Martin Luther King Jr. Day', 'https://www.nyse.com/markets/hours-calendars'),
  ('NYSE', '2026-02-16', 'Washington''s Birthday', 'https://www.nyse.com/markets/hours-calendars'),
  ('NYSE', '2026-04-03', 'Good Friday', 'https://www.nyse.com/markets/hours-calendars'),
  ('NYSE', '2026-05-25', 'Memorial Day', 'https://www.nyse.com/markets/hours-calendars'),
  ('NYSE', '2026-06-19', 'Juneteenth National Independence Day', 'https://www.nyse.com/markets/hours-calendars'),
  ('NYSE', '2026-07-03', 'Independence Day (observed)', 'https://www.nyse.com/markets/hours-calendars'),
  ('NYSE', '2026-09-07', 'Labor Day', 'https://www.nyse.com/markets/hours-calendars'),
  ('NYSE', '2026-11-26', 'Thanksgiving Day', 'https://www.nyse.com/markets/hours-calendars'),
  ('NYSE', '2026-12-25', 'Christmas Day', 'https://www.nyse.com/markets/hours-calendars')
on conflict (market, holiday_date) do update set
  name = excluded.name, source_url = excluded.source_url;

create or replace function public.is_us_daylight_saving(p_date date)
returns boolean
language plpgsql
immutable
as $$
declare
  march_first date := make_date(extract(year from p_date)::integer, 3, 1);
  november_first date := make_date(extract(year from p_date)::integer, 11, 1);
  dst_start date;
  dst_end date;
begin
  dst_start := march_first + (((7 - extract(dow from march_first)::integer) % 7) + 7);
  dst_end := november_first + ((7 - extract(dow from november_first)::integer) % 7);
  return p_date >= dst_start and p_date < dst_end;
end;
$$;

create or replace function public.plan_us_premarket_report(
  p_date date default ((now() at time zone 'Asia/Tokyo')::date)
)
returns setof public.scheduled_posts
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.us_premarket_report_settings%rowtype;
  selected_start time;
  selected_end time;
  span_seconds integer;
  candidate timestamptz;
  attempt integer;
begin
  select * into settings from public.us_premarket_report_settings where id = true;
  if not found or not settings.is_active then return; end if;
  if extract(isodow from p_date) in (6, 7) then return; end if;
  if exists (
    select 1 from public.market_holidays
    where market = 'NYSE' and holiday_date = p_date
  ) then return; end if;
  if exists (
    select 1 from public.scheduled_posts
    where schedule_date = p_date and post_type = 'us_premarket_report'
  ) then
    return query select * from public.scheduled_posts
      where schedule_date = p_date and post_type = 'us_premarket_report';
    return;
  end if;

  if public.is_us_daylight_saving(p_date) then
    selected_start := settings.summer_window_start;
    selected_end := settings.summer_window_end;
  else
    selected_start := settings.winter_window_start;
    selected_end := settings.winter_window_end;
  end if;
  span_seconds := extract(epoch from (selected_end - selected_start))::integer;

  for attempt in 1..settings.max_resamples loop
    candidate := (
      p_date + selected_start + floor(random() * (span_seconds + 1)) * interval '1 second'
    ) at time zone settings.timezone;
    exit when not exists (
      select 1 from public.scheduled_posts existing
      where existing.status in ('pending', 'running', 'succeeded')
        and abs(extract(epoch from (existing.scheduled_for - candidate))) <= settings.collision_minutes * 60
    );
    candidate := null;
  end loop;
  if candidate is null then return; end if;

  insert into public.scheduled_posts (schedule_date, post_type, slot_no, scheduled_for)
  values (p_date, 'us_premarket_report', 1, candidate)
  on conflict (schedule_date, post_type, slot_no) do nothing;

  return query select * from public.scheduled_posts
    where schedule_date = p_date and post_type = 'us_premarket_report';
end;
$$;

create or replace function public.complete_us_premarket_report_post(
  p_scheduled_post_id uuid,
  p_run_id uuid,
  p_x_post_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare selected_run public.us_premarket_report_runs%rowtype;
begin
  update public.us_premarket_report_runs
  set status = 'succeeded', x_post_id = p_x_post_id, error = null
  where id = p_run_id returning * into selected_run;
  if selected_run.id is null then raise exception 'US_PREMARKET_REPORT_RUN_NOT_FOUND'; end if;

  update public.scheduled_posts set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';

  insert into public.post_execution_logs (
    scheduled_post_id, post_type, status, x_post_id, message,
    source_urls, verified_at, model_used, input_tokens, output_tokens, api_cost_usd
  ) values (
    p_scheduled_post_id, 'us_premarket_report', 'succeeded', p_x_post_id,
    'US premarket report posted', selected_run.source_urls, selected_run.generated_at,
    selected_run.model_used, selected_run.input_tokens, selected_run.output_tokens,
    selected_run.api_cost_usd
  );
end;
$$;

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
  where status = 'pending' and scheduled_for <= now()
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

revoke all on function public.is_us_daylight_saving(date) from public;
revoke all on function public.plan_us_premarket_report(date) from public;
revoke all on function public.complete_us_premarket_report_post(uuid, uuid, text) from public;
grant execute on function public.is_us_daylight_saving(date) to service_role;
grant execute on function public.plan_us_premarket_report(date) to service_role;
grant execute on function public.complete_us_premarket_report_post(uuid, uuid, text) to service_role;

update public.us_premarket_report_settings set is_active = false, updated_at = now() where id = true;
update public.posting_windows set is_active = false where post_type = 'us_premarket_report';
