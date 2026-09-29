-- Fake-only baseline for the social-mobile account deletion candidate.
-- Mirrors the production shape relevant to deletion (read-only catalog
-- inspection 2026-09-28): tables, CHECKs and every FK with its ON DELETE
-- action (NO ACTION unless noted). Supabase auth/vault are minimal stubs.
-- Apply to a disposable local database as a NON-superuser owner, never to
-- production. All ids and tokens are fake.
set timezone = 'UTC';

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;
create table auth.users (id uuid primary key);
-- Minimal auth.uid(): the caller's JWT subject, as PostgREST exposes it.
create function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text not null);
create view vault.decrypted_secrets as select s.id, s.secret as decrypted_secret from vault.secrets s;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into vault.secrets (secret) values (new_secret) returning id into v_id;
  return v_id;
end;
$$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id;
end;
$$;
revoke all on schema vault from public;
revoke all on all tables in schema vault from public, anon, authenticated, service_role;
revoke all on all functions in schema vault from public, anon, authenticated;

-- Kabumori main-app data keyed to the shared login.
create table public.profiles (id uuid primary key references auth.users (id) on delete cascade, display_name text);

create table public.admin_users (user_id uuid primary key references auth.users (id) on delete cascade);

create table public.brands (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,40}$'),
  display_name text not null default 'My Workspace',
  is_active boolean not null default true,
  publish_mode text not null default 'live' check (publish_mode in ('disabled', 'dry_run', 'live')),
  code_profile_key text not null default 'social_mobile_user_v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.brand_memberships (
  brand_id text not null references public.brands (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  primary key (brand_id, user_id)
);
create table public.brand_settings (brand_id text primary key references public.brands (id), fixed_hashtags jsonb not null default '[]');
create table public.daily_content_plans (id uuid primary key default gen_random_uuid(), brand_id text not null references public.brands (id) on delete cascade);
create table public.social_accounts (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,80}$'),
  brand_id text not null references public.brands (id),
  platform text not null default 'x' check (platform = 'x'),
  handle text not null default 'pending',
  platform_user_id text,
  publish_enabled boolean not null default true,
  oauth_client_ref text not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  vault_access_token_secret_id uuid,
  vault_refresh_token_secret_id uuid,
  connection_status text not null default 'identity_verified'
    check (connection_status in ('unconnected', 'authorization_pending', 'connected', 'identity_verified', 'failed')),
  verified_at timestamptz,
  last_connection_error_code text,
  unique (brand_id, platform)
);
create table public.social_account_oauth_states (
  id uuid primary key default gen_random_uuid(),
  social_account_id text not null references public.social_accounts (id),
  brand_id text not null references public.brands (id),
  state_hash text not null unique,
  code_verifier_vault_secret_id uuid,
  redirect_uri text not null default 'kabumori-social://oauth-callback',
  expires_at timestamptz not null default now() + interval '10 minutes',
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  initiated_by_user_id uuid references auth.users (id) on delete cascade
);
create table public.scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  schedule_date date not null default current_date,
  post_type text not null default 'brand_post',
  slot_no smallint not null default 1,
  scheduled_for timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  attempt_count integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  brand_id text not null references public.brands (id)
);
create table public.post_execution_logs (
  id bigint generated always as identity primary key,
  scheduled_post_id uuid references public.scheduled_posts (id),
  post_type text not null default 'brand_post',
  status text not null check (status in ('started', 'succeeded', 'failed')),
  x_post_id text,
  created_at timestamptz not null default now(),
  brand_id text not null references public.brands (id)
);
create table public.posting_windows (
  id uuid primary key default gen_random_uuid(),
  post_type text not null default 'brand_post',
  slot_no smallint not null default 1,
  start_time time not null default '09:00',
  end_time time not null default '10:00',
  timezone text not null default 'Asia/Tokyo',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  daily_probability numeric not null default 1,
  brand_id text not null references public.brands (id)
);
create table public.publish_claims (
  id uuid primary key default gen_random_uuid(),
  post_type text not null default 'brand_post',
  date_jst date not null default current_date,
  status text not null check (status in ('publishing', 'published', 'failed')),
  execution_id text not null default 'exec',
  started_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  brand_id text not null references public.brands (id)
);
create table public.published_content_fingerprints (
  id bigint generated always as identity primary key,
  brand_id text not null references public.brands (id),
  social_account_id text not null references public.social_accounts (id),
  post_type text not null default 'brand_post',
  normalized_text_sha256 text not null check (normalized_text_sha256 ~ '^[0-9a-f]{64}$'),
  published_at timestamptz not null default now()
);
create table public.interaction_post_metrics (id uuid primary key default gen_random_uuid(), scheduled_post_id uuid references public.scheduled_posts (id));
create table public.x_account_refresh_state_v2 (
  social_account_id text primary key references public.social_accounts (id),
  status text not null default 'idle' check (status in ('idle', 'refreshing', 'uncertain', 'reauth_required')),
  generation bigint not null default 0,
  lease_post_id uuid references public.scheduled_posts (id),
  leased_access_secret_id uuid,
  leased_refresh_secret_id uuid
);
create table public.x_account_refresh_rollout (
  social_account_id text primary key references public.social_accounts (id),
  mode text not null check (mode in ('off', 'pilot', 'enabled')),
  pilot_expires_at timestamptz,
  pilot_max_generation bigint,
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]{1,99}$'),
  updated_at timestamptz not null default now(),
  check ((mode = 'pilot') = (pilot_expires_at is not null and pilot_max_generation is not null))
);

-- Fixture helper: a user with a derived social-mobile workspace, one X account,
-- Vault tokens and some posting history. Returns the workspace id.
create function public.fixture_user_with_workspace(p_user uuid, p_prefix text) returns text language plpgsql as $$
declare
  v_brand text := 'u_' || substr(md5(p_user::text), 1, 24);
  v_account text := 'sa_' || substr(md5(v_brand || ':x'), 1, 24);
  v_access uuid;
  v_refresh uuid;
  v_verifier uuid;
  v_done uuid;
begin
  insert into auth.users values (p_user) on conflict do nothing;
  insert into public.brands (id) values (v_brand);
  insert into public.brand_memberships values (v_brand, p_user, 'owner');
  insert into vault.secrets (secret) values ('fake_' || p_prefix || '_ACCESS') returning id into v_access;
  insert into vault.secrets (secret) values ('fake_' || p_prefix || '_REFRESH') returning id into v_refresh;
  insert into vault.secrets (secret) values ('fake_' || p_prefix || '_VERIFIER') returning id into v_verifier;
  insert into public.social_accounts (id, brand_id, platform_user_id, vault_access_token_secret_id, vault_refresh_token_secret_id)
  values (v_account, v_brand, 'x_' || p_prefix, v_access, v_refresh);
  insert into public.social_account_oauth_states (social_account_id, brand_id, state_hash, code_verifier_vault_secret_id, initiated_by_user_id)
  values (v_account, v_brand, 'hash_' || p_prefix, v_verifier, p_user);
  insert into public.scheduled_posts (brand_id, status) values (v_brand, 'pending');
  insert into public.scheduled_posts (brand_id, status) values (v_brand, 'succeeded') returning id into v_done;
  insert into public.post_execution_logs (scheduled_post_id, status, x_post_id, brand_id) values (v_done, 'succeeded', 'x_post_' || p_prefix, v_brand);
  insert into public.posting_windows (brand_id) values (v_brand);
  insert into public.publish_claims (status, brand_id) values ('published', v_brand);
  insert into public.published_content_fingerprints (brand_id, social_account_id, normalized_text_sha256) values (v_brand, v_account, repeat('a', 64));
  insert into public.daily_content_plans (brand_id) values (v_brand);
  insert into public.x_account_refresh_state_v2 (social_account_id) values (v_account);
  insert into public.x_account_refresh_rollout (social_account_id, mode, pilot_expires_at, pilot_max_generation, reason_code)
  values (v_account, 'pilot', now() + interval '1 day', 3, 'PILOT');
  return v_brand;
end;
$$;
