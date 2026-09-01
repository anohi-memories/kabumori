create table if not exists public.market_holidays (
  market text not null default 'JPX',
  holiday_date date not null,
  name text not null,
  source_url text not null,
  created_at timestamptz not null default now(),
  primary key (market, holiday_date)
);

create table if not exists public.morning_report_settings (
  id boolean primary key default true check (id),
  is_active boolean not null default false,
  window_start time not null default '08:18',
  center_time time not null default '08:20',
  window_end time not null default '08:22',
  timezone text not null default 'Asia/Tokyo',
  holiday_edition_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  check (window_start <= center_time and center_time <= window_end)
);

create table if not exists public.morning_report_runs (
  id uuid primary key default gen_random_uuid(),
  scheduled_post_id uuid references public.scheduled_posts(id),
  scheduled_at timestamptz not null,
  generated_at timestamptz,
  source_urls jsonb not null default '[]'::jsonb,
  market_data_timestamp timestamptz,
  model_used text not null,
  input_tokens integer,
  output_tokens integer,
  web_search_calls integer,
  api_cost_usd numeric(12,6),
  x_post_id text,
  status text not null check (status in (
    'generating', 'dry_run_succeeded', 'succeeded', 'failed', 'skipped_holiday'
  )),
  error text,
  generated_text text,
  character_count integer,
  fact_check_status text check (fact_check_status in ('passed', 'failed')),
  fact_check_notes jsonb not null default '[]'::jsonb,
  market_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists morning_report_runs_scheduled_at_idx
  on public.morning_report_runs (scheduled_at desc);

alter table public.market_holidays enable row level security;
alter table public.morning_report_settings enable row level security;
alter table public.morning_report_runs enable row level security;

grant select on public.market_holidays to service_role;
grant select on public.morning_report_settings to service_role;
grant select, insert, update on public.morning_report_runs to service_role;

insert into public.morning_report_settings (id, is_active)
values (true, false)
on conflict (id) do update set
  window_start = '08:18',
  center_time = '08:20',
  window_end = '08:22',
  timezone = 'Asia/Tokyo',
  holiday_edition_enabled = false,
  is_active = false,
  updated_at = now();

insert into public.market_holidays (market, holiday_date, name, source_url) values
  ('JPX','2026-01-01','元日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-01-02','市場休業日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-01-03','市場休業日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-01-12','成人の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-02-11','建国記念の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-02-23','天皇誕生日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-03-20','春分の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-04-29','昭和の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-05-03','憲法記念日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-05-04','みどりの日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-05-05','こどもの日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-05-06','振替休日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-07-20','海の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-08-11','山の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-09-21','敬老の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-09-22','国民の休日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-09-23','秋分の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-10-12','スポーツの日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-11-03','文化の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-11-23','勤労感謝の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2026-12-31','市場休業日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-01-01','元日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-01-02','市場休業日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-01-03','市場休業日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-01-11','成人の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-02-11','建国記念の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-02-23','天皇誕生日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-03-21','春分の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-03-22','振替休日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-04-29','昭和の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-05-03','憲法記念日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-05-04','みどりの日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-05-05','こどもの日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-07-19','海の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-08-11','山の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-09-20','敬老の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-09-23','秋分の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-10-11','スポーツの日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-11-03','文化の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-11-23','勤労感謝の日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html'),
  ('JPX','2027-12-31','市場休業日','https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html')
on conflict (market, holiday_date) do update set
  name = excluded.name,
  source_url = excluded.source_url;

insert into public.posting_windows
  (post_type, slot_no, start_time, end_time, timezone, daily_probability, is_active)
values
  ('morning_report', 1, '08:18', '08:22', 'Asia/Tokyo', 1, false)
on conflict (post_type, slot_no) do update set
  start_time = excluded.start_time,
  end_time = excluded.end_time,
  timezone = excluded.timezone,
  daily_probability = 1,
  is_active = false;

create or replace function public.plan_morning_report(
  p_date date default ((now() at time zone 'Asia/Tokyo')::date)
)
returns setof public.scheduled_posts
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.morning_report_settings%rowtype;
  candidate timestamptz;
begin
  select * into settings from public.morning_report_settings where id = true;
  if not found or not settings.is_active then return; end if;

  if extract(isodow from p_date) in (6, 7) then return; end if;
  if exists (
    select 1 from public.market_holidays
    where market = 'JPX' and holiday_date = p_date
  ) then return; end if;

  candidate := (p_date + settings.center_time) at time zone settings.timezone;
  insert into public.scheduled_posts
    (schedule_date, post_type, slot_no, scheduled_for)
  values (p_date, 'morning_report', 1, candidate)
  on conflict (schedule_date, post_type, slot_no) do nothing;

  return query
  select * from public.scheduled_posts
  where schedule_date = p_date and post_type = 'morning_report'
  order by scheduled_for;
end;
$$;

create or replace function public.complete_morning_report_post(
  p_scheduled_post_id uuid,
  p_morning_report_run_id uuid,
  p_x_post_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_run public.morning_report_runs%rowtype;
begin
  update public.morning_report_runs
  set status = 'succeeded', x_post_id = p_x_post_id, error = null
  where id = p_morning_report_run_id
  returning * into selected_run;

  if selected_run.id is null then
    raise exception 'MORNING_REPORT_RUN_NOT_FOUND';
  end if;

  update public.scheduled_posts
  set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';

  insert into public.post_execution_logs (
    scheduled_post_id, post_type, status, x_post_id, message,
    source_urls, verified_at, model_used, input_tokens, output_tokens, api_cost_usd
  ) values (
    p_scheduled_post_id, 'morning_report', 'succeeded', p_x_post_id,
    'Morning report posted', selected_run.source_urls, selected_run.generated_at,
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
  perform public.plan_daily_posts();
  perform public.plan_weekly_useful_tips();

  select id into claimed_id from public.scheduled_posts
  where status = 'pending' and scheduled_for <= now()
  order by scheduled_for
  for update skip locked limit 1;

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

revoke all on function public.plan_morning_report(date) from public;
revoke all on function public.complete_morning_report_post(uuid, uuid, text) from public;
revoke all on function public.claim_due_post() from public;

grant execute on function public.plan_morning_report(date) to service_role;
grant execute on function public.complete_morning_report_post(uuid, uuid, text) to service_role;
grant execute on function public.claim_due_post() to service_role;

-- Formal configuration is installed but publication remains disabled until approval.
update public.morning_report_settings set is_active = false, updated_at = now() where id = true;
update public.posting_windows set is_active = false where post_type = 'morning_report';
