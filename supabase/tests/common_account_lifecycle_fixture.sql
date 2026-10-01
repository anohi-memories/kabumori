-- Fake-only additions for the common account lifecycle candidate. Applied on
-- top of social_mobile_account_deletion_fixture.sql, the real onboarding RPC
-- migrations and the social-mobile deletion candidate (see the runner).
-- Mirrors the production shape the candidate's preflight requires
-- (read-only catalog inventory 2026-10-01). Disposable local database only.
set timezone = 'UTC';

-- Worst case for the candidate's grants: every new object in either schema
-- starts out fully granted to the client roles, as Supabase defaults do.
create schema private;
grant usage on schema private to anon, authenticated, service_role;
alter default privileges in schema private grant all on tables to anon, authenticated, service_role;
alter default privileges in schema private grant execute on functions to anon, authenticated, service_role;

alter table auth.users add column email text;
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  unique (user_id, provider)
);

alter table public.profiles add column created_at timestamptz not null default now();
alter table public.brand_memberships add column created_at timestamptz not null default now();

-- Kabumori user tables: all hang off profiles with ON DELETE CASCADE.
create table public.tracked_stocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  is_active boolean not null default true
);
create table public.alert_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  push_enabled boolean not null default true
);
create table public.alert_category_settings (
  user_id uuid not null references public.profiles (id) on delete cascade,
  category text not null,
  primary key (user_id, category)
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  tracked_stock_id uuid references public.tracked_stocks (id) on delete set null
);
create table public.device_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  expo_push_token text not null unique
);
create table public.personalized_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade
);

-- The existing Kabumori profile bootstrap (20260924100000), unchanged: the
-- legacy creator the lifecycle must stay safe against.
create function public.ensure_my_profile()
returns uuid language plpgsql volatile security invoker set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  insert into public.profiles (id) values (v_user_id) on conflict (id) do nothing;
  return v_user_id;
end
$function$;
revoke all on function public.ensure_my_profile() from public, anon, authenticated, service_role;
grant execute on function public.ensure_my_profile() to authenticated;
grant select, insert, update on public.profiles to authenticated;

-- Internal (operator-run) workspaces, as in production.
insert into public.brands (id, code_profile_key) values
  ('kabumori', 'kabumori_v1'), ('ai_salaryman_lab', 'ai_salaryman_lab_v1');

-- Fixture helper: a login, optionally with a Kabumori profile and activity.
create function public.fixture_login(p_user uuid, p_profile boolean default false, p_activity boolean default false)
returns void language plpgsql as $$
begin
  insert into auth.users (id) values (p_user) on conflict do nothing;
  insert into auth.identities (user_id, provider) values (p_user, 'email') on conflict do nothing;
  if p_profile then
    insert into public.profiles (id) values (p_user) on conflict do nothing;
  end if;
  if p_activity then
    insert into public.tracked_stocks (user_id) values (p_user);
    insert into public.device_push_tokens (user_id, expo_push_token) values (p_user, 'fake_push_' || p_user::text);
  end if;
end;
$$;
