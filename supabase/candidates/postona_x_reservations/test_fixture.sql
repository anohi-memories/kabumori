-- Fake-only fixture for the POSTONA X reservations candidate (local disposable PostgreSQL only).
-- Mirrors the production column types the candidate depends on (brands.id text, social_accounts.id text,
-- brand_memberships(brand_id text, user_id uuid, role), auth.uid() from the JWT subject, the PR81 settings
-- table) and uses a WORST-CASE default ACL: every new table / function / sequence is granted to anon,
-- authenticated and service_role, so the candidate must revoke explicitly. Never production. All ids fake.
set timezone = 'UTC';

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges grant all on tables to anon, authenticated, service_role;
alter default privileges grant execute on functions to anon, authenticated, service_role;
alter default privileges grant all on sequences to anon, authenticated, service_role;

create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;

create table public.brands (
  id text primary key,
  display_name text not null default 'ws',
  is_active boolean not null default true,
  publish_mode text not null default 'disabled',
  code_profile_key text not null default 'social_mobile_user_v1'
);
create table public.brand_memberships (
  brand_id text not null references public.brands (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  primary key (brand_id, user_id)
);
create table public.social_accounts (
  id text primary key,
  brand_id text not null references public.brands (id),
  platform text not null,
  handle text not null,
  publish_enabled boolean not null default false,
  connection_status text not null default 'identity_verified'
);
create table public.social_mobile_content_settings (
  brand_id text primary key references public.brands (id) on delete cascade,
  settings jsonb not null
);
-- Kabumori-like legacy queue that the candidate must never touch.
create table public.scheduled_posts (id uuid primary key default gen_random_uuid(), brand_id text not null, post_type text not null, status text not null default 'pending');
insert into public.scheduled_posts (brand_id, post_type) values ('kabumori', 'tip');

-- Users: A owns brand_a (X + Threads) and brand_a2 (X); B owns brand_b (X); C is a member of brand_a only.
insert into auth.users values
  ('00000000-0000-4000-8000-00000000000a'), ('00000000-0000-4000-8000-00000000000b'), ('00000000-0000-4000-8000-00000000000c');
insert into public.brands (id) values ('brand_a'), ('brand_a2'), ('brand_b');
insert into public.brands (id, code_profile_key) values ('kabumori', 'kabumori_v1');
insert into public.brand_memberships values
  ('brand_a', '00000000-0000-4000-8000-00000000000a', 'owner'),
  ('brand_a2', '00000000-0000-4000-8000-00000000000a', 'owner'),
  ('brand_b', '00000000-0000-4000-8000-00000000000b', 'owner'),
  ('brand_a', '00000000-0000-4000-8000-00000000000c', 'member'),
  ('kabumori', '00000000-0000-4000-8000-00000000000a', 'owner');
insert into public.social_accounts (id, brand_id, platform, handle) values
  ('x_a', 'brand_a', 'x', 'a'), ('th_a', 'brand_a', 'threads', 'a'), ('x_a2', 'brand_a2', 'x', 'a2'),
  ('x_b', 'brand_b', 'x', 'b'), ('x_kabu', 'kabumori', 'x', 'kabu');

-- Test helper: act as a signed-in user for the rest of the transaction.
create schema t;
create function t.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(p::text, ''), false); end $$;
