-- Phase 2 / local-only multibrand foundation.
--
-- This migration deliberately expands the existing Kabumori pipeline in place.
-- Every legacy row and legacy insert defaults to `kabumori`; no production
-- project is linked from this worktree and this file is not a deployment action.

create table if not exists public.brands (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,40}$'),
  display_name text not null,
  is_active boolean not null default false,
  publish_mode text not null default 'disabled'
    check (publish_mode in ('disabled', 'dry_run', 'live')),
  code_profile_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.social_accounts (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,80}$'),
  brand_id text not null references public.brands(id),
  platform text not null check (platform in ('x')),
  handle text not null,
  platform_user_id text,
  publish_enabled boolean not null default false,
  oauth_client_ref text not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, platform)
);

create table if not exists public.brand_settings (
  brand_id text primary key references public.brands(id),
  fixed_hashtags jsonb not null default '[]'::jsonb,
  note_url text,
  image_policy jsonb not null default '{}'::jsonb,
  enabled_post_types jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.brands enable row level security;
alter table public.social_accounts enable row level security;
alter table public.brand_settings enable row level security;
revoke all on public.brands from anon, authenticated;
revoke all on public.social_accounts from anon, authenticated;
revoke all on public.brand_settings from anon, authenticated;
grant select, insert, update on public.brands to service_role;
grant select, insert, update on public.social_accounts to service_role;
grant select, insert, update on public.brand_settings to service_role;

insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key)
values
  ('kabumori', 'かぶモリ', true, 'live', 'kabumori_v1'),
  ('ai_salaryman_lab', 'AIサラリーマン研究所', false, 'disabled', 'ai_salaryman_lab_v1'),
  ('mio', 'mio', false, 'disabled', 'mio_v1')
on conflict (id) do update set
  display_name = excluded.display_name,
  is_active = excluded.is_active,
  publish_mode = excluded.publish_mode,
  code_profile_key = excluded.code_profile_key,
  updated_at = now();

-- Only the existing Kabumori identity is represented here. The two new brands
-- intentionally have no X accounts and no tokens until a separately approved
-- connection phase. The shared X App is identified by oauth_client_ref only.
insert into public.social_accounts
  (id, brand_id, platform, handle, publish_enabled, oauth_client_ref)
values ('kabumori_x', 'kabumori', 'x', 'kabumori', true, 'default')
on conflict (id) do update set
  brand_id = excluded.brand_id,
  platform = excluded.platform,
  handle = excluded.handle,
  publish_enabled = excluded.publish_enabled,
  oauth_client_ref = excluded.oauth_client_ref,
  updated_at = now();

insert into public.brand_settings
  (brand_id, fixed_hashtags, enabled_post_types)
values (
  'kabumori',
  '["#日本株", "#日経平均", "#株式投資", "#かぶモリ"]'::jsonb,
  '["tip", "useful_tip", "interaction", "morning_report", "close_report", "us_premarket_report", "morning_greeting"]'::jsonb
)
on conflict (brand_id) do update set
  fixed_hashtags = excluded.fixed_hashtags,
  enabled_post_types = excluded.enabled_post_types,
  updated_at = now();

-- Existing table contracts remain callable. These columns make the row-level
-- identity explicit while defaults preserve all legacy inserts and data.
alter table public.posting_windows
  add column if not exists brand_id text not null default 'kabumori' references public.brands(id);
alter table public.scheduled_posts
  add column if not exists brand_id text not null default 'kabumori' references public.brands(id);
alter table public.post_execution_logs
  add column if not exists brand_id text not null default 'kabumori' references public.brands(id);
alter table public.publish_claims
  add column if not exists brand_id text not null default 'kabumori' references public.brands(id);

alter table public.morning_report_runs
  add column if not exists brand_id text not null default 'kabumori' references public.brands(id);
alter table public.close_report_runs
  add column if not exists brand_id text not null default 'kabumori' references public.brands(id);
alter table public.us_premarket_report_runs
  add column if not exists brand_id text not null default 'kabumori' references public.brands(id);

-- The pre-Phase 2 constraints deliberately remain in place. The additional
-- indexes document the target key shape without broadening active scheduling
-- before a separately reviewed brand activation phase.
create unique index if not exists posting_windows_brand_post_type_slot_key
  on public.posting_windows (brand_id, post_type, slot_no);
create unique index if not exists scheduled_posts_brand_schedule_slot_key
  on public.scheduled_posts (brand_id, schedule_date, post_type, slot_no);
create unique index if not exists publish_claims_brand_post_type_date_key
  on public.publish_claims (brand_id, post_type, date_jst);
create index if not exists post_execution_logs_brand_created_at_idx
  on public.post_execution_logs (brand_id, created_at desc);

-- Report settings were former boolean-singleton tables. Keep `id = true` for
-- legacy readers, but make brand_id the actual row identity so the tables can
-- safely hold one row per brand in later phases.
alter table public.morning_report_settings
  add column if not exists brand_id text references public.brands(id);
update public.morning_report_settings set brand_id = 'kabumori' where brand_id is null;
alter table public.morning_report_settings alter column brand_id set not null;
alter table public.morning_report_settings drop constraint if exists morning_report_settings_pkey;
alter table public.morning_report_settings add primary key (brand_id);

alter table public.close_report_settings
  add column if not exists brand_id text references public.brands(id);
update public.close_report_settings set brand_id = 'kabumori' where brand_id is null;
alter table public.close_report_settings alter column brand_id set not null;
alter table public.close_report_settings drop constraint if exists close_report_settings_pkey;
alter table public.close_report_settings add primary key (brand_id);

alter table public.us_premarket_report_settings
  add column if not exists brand_id text references public.brands(id);
update public.us_premarket_report_settings set brand_id = 'kabumori' where brand_id is null;
alter table public.us_premarket_report_settings alter column brand_id set not null;
alter table public.us_premarket_report_settings drop constraint if exists us_premarket_report_settings_pkey;
alter table public.us_premarket_report_settings add primary key (brand_id);

-- All existing completion/failure functions write the historical columns. A
-- single trigger derives the log brand from the scheduled row so those paths
-- cannot accidentally label a future row as Kabumori.
create or replace function public.set_post_execution_log_brand_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.scheduled_post_id is not null then
    select brand_id into new.brand_id
    from public.scheduled_posts
    where id = new.scheduled_post_id;
  end if;
  new.brand_id := coalesce(new.brand_id, 'kabumori');
  return new;
end;
$$;

drop trigger if exists set_post_execution_log_brand_id on public.post_execution_logs;
create trigger set_post_execution_log_brand_id
before insert or update of scheduled_post_id on public.post_execution_logs
for each row execute function public.set_post_execution_log_brand_id();

-- Preserve the public no-argument RPC contract while carrying the selected
-- brand into newly planned and claimed rows. Disabled brands never enter this
-- planner; dry-run brands may be scheduled but are blocked before any X call by
-- the Edge Function BrandContext guard.
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
  for window_row in
    select w.*
    from public.posting_windows w
    join public.brands b on b.id = w.brand_id
    where w.is_active
      and b.is_active
      and b.publish_mode in ('dry_run', 'live')
    order by (w.post_type = 'interaction'), w.brand_id, w.post_type, w.slot_no
  loop
    probability_bucket := mod(
      abs(hashtextextended(
        p_date::text || ':' || window_row.brand_id || ':' || window_row.post_type || ':' || window_row.slot_no,
        0
      )),
      10000
    )::integer;
    if probability_bucket >= floor(window_row.daily_probability * 10000)::integer then
      continue;
    end if;

    if exists (
      select 1 from public.scheduled_posts
      where brand_id = window_row.brand_id
        and schedule_date = p_date
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
        if exists (
          select 1 from public.scheduled_posts other_post
          where other_post.brand_id = window_row.brand_id
            and other_post.schedule_date = p_date
            and other_post.post_type <> 'interaction'
            and other_post.status in ('pending', 'running', 'succeeded')
            and other_post.scheduled_for between
              candidate_time - interval '20 minutes'
              and candidate_time + interval '20 minutes'
        ) then
          continue;
        end if;

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
    if not candidate_found then continue; end if;

    insert into public.scheduled_posts
      (brand_id, schedule_date, post_type, slot_no, scheduled_for)
    values (window_row.brand_id, p_date, window_row.post_type, window_row.slot_no, candidate_time)
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

revoke all on function public.plan_daily_posts(date) from public;
revoke all on function public.claim_due_post() from public;
grant execute on function public.plan_daily_posts(date) to service_role;
grant execute on function public.claim_due_post() to service_role;
