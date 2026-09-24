-- Fake-only baseline. Apply inside a disposable postgres:16 database, never production.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end $$;
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
  brand_id text not null references public.brands(id),
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
  unique (brand_id, schedule_date, post_type, slot_no)
);
alter table public.scheduled_posts enable row level security;
insert into public.brands values ('brand_a'), ('brand_b');
insert into public.social_accounts
  (id,brand_id,platform,platform_user_id,connection_status,publish_enabled)
values
  ('acct_a','brand_a','x','x_a','identity_verified',true),
  ('acct_b','brand_b','x','x_b','identity_verified',true),
  ('acct_other','brand_a','other','o_a','identity_verified',true);
