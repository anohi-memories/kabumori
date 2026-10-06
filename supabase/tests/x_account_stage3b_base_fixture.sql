-- Fake-only Stage 3B base: production-shaped pieces on top of x_account_refresh_core_fixture.sql
-- (counted Vault reads, fingerprint/log tables, the live claim step, brand admin columns, brand_settings,
-- the pilot accounts) plus the auth/membership pieces and code profiles the PR81 settings store needs.
-- Shared by x_account_refresh_pilot_run.sh and x_account_stage3b_acl_adverse_run.sh. Never production.
\set ON_ERROR_STOP on
-- Vault reads counted by a non-transactional sequence.
create sequence vault.fixture_read_seq;
create function vault.fixture_count_read(p_secret text) returns text language plpgsql volatile as $$
begin perform nextval('vault.fixture_read_seq'); return p_secret; end;
$$;
create or replace view vault.decrypted_secrets as
select s.id, vault.fixture_count_read(s.secret) as decrypted_secret from vault.secrets s;
-- Production-shaped completion targets (read-only inspection 2026-09-27).
create table public.published_content_fingerprints (
  id bigint generated always as identity primary key,
  brand_id text not null references public.brands (id),
  social_account_id text not null references public.social_accounts (id),
  post_type text not null,
  normalized_text_sha256 text not null check (normalized_text_sha256 ~ '^[0-9a-f]{64}$'),
  x_post_id text,
  published_at timestamptz not null default now()
);
create unique index published_content_fingerprints_account_x_post_uidx
  on public.published_content_fingerprints (social_account_id, x_post_id) where x_post_id is not null;
create table public.post_execution_logs (
  id bigint generated always as identity primary key,
  scheduled_post_id uuid references public.scheduled_posts (id),
  post_type text not null,
  status text not null check (status in ('started', 'succeeded', 'failed')),
  x_post_id text,
  message text,
  created_at timestamptz not null default now(),
  brand_id text not null default 'kabumori' references public.brands (id)
);
-- The claim step of the live public.claim_due_post() (planners omitted).
create function public.claim_due_post() returns setof public.scheduled_posts
language plpgsql security definer set search_path = public as $$
declare claimed_id uuid;
begin
  select id into claimed_id from public.scheduled_posts
  where status = 'pending' and scheduled_for <= now() order by scheduled_for for update skip locked limit 1;
  if claimed_id is null then return; end if;
  update public.scheduled_posts set status = 'running', started_at = now(), attempt_count = attempt_count + 1 where id = claimed_id;
  insert into public.post_execution_logs (scheduled_post_id, post_type, status, message, brand_id)
  select id, post_type, 'started', 'Scheduled post claimed', brand_id from public.scheduled_posts where id = claimed_id;
  return query select * from public.scheduled_posts where id = claimed_id;
end;
$$;
revoke all on function public.claim_due_post() from public, anon, authenticated;
grant execute on function public.claim_due_post() to service_role;
-- Production brand/admin columns the publish predicate reads.
alter table public.brands add column is_active boolean not null default false,
  add column publish_mode text not null default 'disabled' check (publish_mode in ('disabled', 'dry_run', 'live'));
create table public.brand_settings (
  brand_id text primary key references public.brands (id),
  fixed_hashtags jsonb not null default '[]'::jsonb,
  note_url text,
  image_policy jsonb not null default '{}'::jsonb,
  enabled_post_types jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The second (pilot) Vault-backed account and an account without refs.
insert into public.brands values ('u_pilot'), ('u_norefs');
insert into vault.secrets (id, secret) values
  ('00000000-0000-4000-8000-00000000e1e1', 'fake_PILOT_access_1'),
  ('00000000-0000-4000-8000-00000000e1e2', 'fake_PILOT_REFRESH_1');
insert into public.social_accounts
  (id, brand_id, platform, handle, platform_user_id, connection_status, publish_enabled, oauth_client_ref,
   vault_access_token_secret_id, vault_refresh_token_secret_id)
values
  ('sa_pilot', 'u_pilot', 'x', 'pilot', 'x_pilot', 'identity_verified', true, 'default',
   '00000000-0000-4000-8000-00000000e1e1', '00000000-0000-4000-8000-00000000e1e2'),
  ('sa_norefs', 'u_norefs', 'x', 'norefs', 'x_norefs', 'identity_verified', true, 'default', null, null);

-- PR81 settings store, exactly as main ships it (candidate + hardening), on the production-shaped
-- auth/membership pieces it depends on; brands carry their code profile (production column).
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
alter table public.brands add column code_profile_key text not null default 'kabumori_v1';
update public.brands set code_profile_key = 'ai_salaryman_lab_v1' where id = 'ai_salaryman_lab';
update public.brands set code_profile_key = 'social_mobile_user_v1' where id in ('u_pilot', 'u_norefs');
-- A second user workspace (cross-brand isolation) and a workspace on another, internal profile.
insert into public.brands (id, code_profile_key) values ('u_other', 'social_mobile_user_v1'), ('u_internal', 'internal_ops_v1');
create table public.brand_memberships (
  brand_id text not null references public.brands (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  primary key (brand_id, user_id)
);
alter table public.brand_memberships enable row level security;
create policy brand_memberships_self_select on public.brand_memberships
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on table public.brand_memberships from anon, authenticated, service_role;
grant select on table public.brand_memberships to authenticated;
