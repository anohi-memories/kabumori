-- Fake-only baseline for the Phase1D proof. Apply to a disposable local
-- PostgreSQL database as a NON-superuser owner, never to production.
-- Mirrors the production-shaped objects the Phase1B/Phase1D candidates touch,
-- including Supabase's default EXECUTE grants to API roles and the live legacy
-- claim/retry/fail/complete bodies (service_role-only EXECUTE).
set timezone = 'UTC';

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table public.brands (id text primary key);
create table public.social_accounts (
  id text primary key,
  brand_id text not null references public.brands(id),
  platform text not null,
  platform_user_id text,
  connection_status text not null,
  publish_enabled boolean not null default false,
  unique (brand_id, platform)
);
create table public.posting_windows (
  brand_id text not null references public.brands(id),
  post_type text not null,
  slot_no smallint not null,
  start_time time not null,
  end_time time not null,
  timezone text not null default 'UTC',
  is_active boolean not null default true,
  primary key (brand_id, post_type, slot_no)
);
create table public.scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  brand_id text not null default 'kabumori' references public.brands(id),
  schedule_date date not null,
  post_type text not null,
  slot_no smallint not null,
  scheduled_for timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed')),
  attempt_count integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index scheduled_posts_brand_schedule_slot_key
  on public.scheduled_posts (brand_id, schedule_date, post_type, slot_no);
alter table public.scheduled_posts enable row level security;
create table public.post_execution_logs (
  id bigint generated always as identity primary key,
  scheduled_post_id uuid references public.scheduled_posts(id),
  post_type text not null,
  status text not null check (status in ('started', 'succeeded', 'failed')),
  x_post_id text,
  message text,
  created_at timestamptz not null default now()
);

-- Fake legacy planners. plan_daily_posts writes unbound rows from windows,
-- exactly like the live planners (no account input exists).
create function public.plan_daily_posts(p_date date default current_date)
returns setof public.scheduled_posts language plpgsql security definer set search_path = public as $$
begin
  insert into public.scheduled_posts (brand_id, schedule_date, post_type, slot_no, scheduled_for)
  select w.brand_id, p_date, w.post_type, w.slot_no, p_date + w.start_time
  from public.posting_windows w where w.is_active
  on conflict (brand_id, schedule_date, post_type, slot_no) do nothing;
  return query select * from public.scheduled_posts where schedule_date = p_date;
end;
$$;
create function public.plan_morning_report(p_date date default current_date)
returns setof public.scheduled_posts language sql as $$ select null::public.scheduled_posts where false $$;
create function public.plan_close_report(p_date date default current_date)
returns setof public.scheduled_posts language sql as $$ select null::public.scheduled_posts where false $$;
create function public.plan_weekly_useful_tips(p_date date default current_date)
returns setof public.scheduled_posts language sql as $$ select null::public.scheduled_posts where false $$;
create function public.plan_us_premarket_report(p_date date default current_date)
returns setof public.scheduled_posts language sql as $$ select null::public.scheduled_posts where false $$;

-- Live legacy claim (20260830093000 body; five planners, global oldest row).
create function public.claim_due_post()
returns setof public.scheduled_posts language plpgsql security definer set search_path = public as $$
declare claimed_id uuid;
begin
  perform public.plan_morning_report();
  perform public.plan_close_report();
  perform public.plan_daily_posts();
  perform public.plan_weekly_useful_tips();
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

create function public.retry_scheduled_post(p_scheduled_post_id uuid, p_retry_at timestamptz, p_message text)
returns void language plpgsql security definer set search_path = public as $$
declare selected_type text;
begin
  update public.scheduled_posts
  set status = 'pending', scheduled_for = p_retry_at, started_at = null, finished_at = null
  where id = p_scheduled_post_id and status = 'running'
  returning post_type into selected_type;
  if selected_type is not null then
    insert into public.post_execution_logs (scheduled_post_id, post_type, status, message)
    values (p_scheduled_post_id, selected_type, 'failed', left(p_message, 300));
  end if;
end;
$$;

create function public.fail_scheduled_post(p_scheduled_post_id uuid, p_message text)
returns void language plpgsql security definer set search_path = public as $$
declare selected_type text;
begin
  update public.scheduled_posts
  set status = 'failed', finished_at = now()
  where id = p_scheduled_post_id and status = 'running'
  returning post_type into selected_type;
  if selected_type is not null then
    insert into public.post_execution_logs (scheduled_post_id, post_type, status, message)
    values (p_scheduled_post_id, selected_type, 'failed', left(p_message, 300));
  end if;
end;
$$;

-- Representative legacy completion (status half of live complete_tip_post).
create function public.complete_tip_post(p_scheduled_post_id uuid, p_tip_id uuid, p_x_post_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.scheduled_posts set status = 'succeeded', finished_at = now()
  where id = p_scheduled_post_id and status = 'running';
  insert into public.post_execution_logs (scheduled_post_id, post_type, status, x_post_id, message)
  values (p_scheduled_post_id, 'tip', 'succeeded', p_x_post_id, 'X post created');
end;
$$;

-- Live ACL: legacy RPCs are service_role-only.
revoke all on function public.claim_due_post(), public.retry_scheduled_post(uuid,timestamptz,text),
  public.fail_scheduled_post(uuid,text), public.complete_tip_post(uuid,uuid,text),
  public.plan_daily_posts(date), public.plan_morning_report(date), public.plan_close_report(date),
  public.plan_weekly_useful_tips(date), public.plan_us_premarket_report(date)
from public, anon, authenticated;

insert into public.brands values ('kabumori'), ('brand_a'), ('brand_b');
insert into public.social_accounts
  (id, brand_id, platform, platform_user_id, connection_status, publish_enabled)
values
  ('acct_a', 'brand_a', 'x', 'x_a', 'identity_verified', true),
  ('acct_b', 'brand_b', 'x', 'x_b', 'identity_verified', true),
  ('acct_other', 'brand_a', 'other', 'o_a', 'identity_verified', true);
