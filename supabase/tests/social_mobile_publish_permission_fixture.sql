-- Fake-only baseline for the publish-permission boundary proof
-- (20261003090000). Production-shaped tables as inspected read-only for the
-- account-deletion candidate (2026-09-28): text brand ids, brand_memberships,
-- social_accounts with UNIQUE (brand_id, platform) and platform = 'x' only,
-- scheduled_posts without social_account_id, Supabase auth/vault as minimal
-- stubs. The runner then applies the REAL, unmodified migrations on top:
-- X OAuth onboarding/reconnect, refresh core, refresh rollout, account
-- deletion, and finally the candidate. Apply to a disposable local database
-- as a NON-superuser owner, never to production. All ids and tokens are fake.
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
-- Production today: service_role may read decrypted secrets and call update_secret.
grant usage on schema vault to service_role;
grant select on vault.decrypted_secrets to service_role;
grant execute on function vault.update_secret(uuid, text, text, text, uuid) to service_role;

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
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
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
  publish_enabled boolean not null default false,
  oauth_client_ref text not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  vault_access_token_secret_id uuid,
  vault_refresh_token_secret_id uuid,
  connection_status text not null default 'unconnected'
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
  created_at timestamptz not null default now()
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

-- Fixture helpers ---------------------------------------------------------------

-- A brand with one fully eligible X account (verified, own Vault refs,
-- publishing OFF) and `p_owner` as its owner. `p_brand` null = the derived
-- social-mobile workspace id of that user.
create function public.fixture_brand(p_owner uuid, p_tag text, p_brand text default null) returns text language plpgsql as $$
declare
  v_brand text := coalesce(p_brand, 'u_' || substr(md5(p_owner::text), 1, 24));
  v_account text := 'sa_' || p_tag;
  v_access uuid;
  v_refresh uuid;
begin
  insert into auth.users values (p_owner) on conflict do nothing;
  insert into public.brands (id) values (v_brand);
  insert into public.brand_settings (brand_id) values (v_brand);
  insert into public.brand_memberships (brand_id, user_id, role) values (v_brand, p_owner, 'owner');
  insert into vault.secrets (secret) values ('fake_' || p_tag || '_ACCESS') returning id into v_access;
  insert into vault.secrets (secret) values ('fake_' || p_tag || '_REFRESH') returning id into v_refresh;
  insert into public.social_accounts
    (id, brand_id, handle, platform_user_id, publish_enabled, connection_status, verified_at,
     vault_access_token_secret_id, vault_refresh_token_secret_id)
  values (v_account, v_brand, p_tag, 'x_' || p_tag, false, 'identity_verified', now(), v_access, v_refresh);
  return v_brand;
end;
$$;

create function public.fixture_member(p_brand text, p_user uuid, p_role text) returns void language plpgsql as $$
begin
  insert into auth.users values (p_user) on conflict do nothing;
  insert into public.brand_memberships (brand_id, user_id, role) values (p_brand, p_user, p_role)
  on conflict (brand_id, user_id) do update set role = excluded.role;
end;
$$;

-- The switch exactly as the Data API runs it: the caller's JWT subject and
-- role `authenticated`, nothing else. SECURITY INVOKER.
create function public.fixture_toggle(p_user uuid, p_account text, p_desired boolean, p_expected boolean)
returns jsonb language plpgsql as $$
declare v_out jsonb;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  set local role authenticated;
  v_out := public.set_social_account_publish_enabled(p_account, p_desired, p_expected);
  reset role;
  return v_out;
end;
$$;

-- The pre-send permission check exactly as the publishing service runs it.
-- Returns 'authorized' or the fixed refusal code.
create function public.fixture_permission(p_post uuid, p_account text, p_brand text)
returns text language plpgsql as $$
declare v_out text;
begin
  set local role service_role;
  begin
    v_out := public.assert_x_publish_permission_for_legacy_post(p_post, p_account, p_brand);
  exception when sqlstate 'P0001' then
    v_out := sqlerrm;
  end;
  reset role;
  return v_out;
end;
$$;

create function public.fixture_running_post(p_brand text) returns uuid language sql as $$
  insert into public.scheduled_posts (brand_id, status, attempt_count, started_at)
  values (p_brand, 'running', 1, now()) returning id
$$;

-- Everything the switch must NOT change, as one comparable value.
create function public.fixture_untouched() returns text language plpgsql stable as $$
begin
  return (select md5(concat_ws('|',
    (select md5(coalesce(string_agg((to_jsonb(a) - 'publish_enabled')::text, ',' order by a.id), '')) from public.social_accounts a),
    (select md5(coalesce(string_agg(to_jsonb(b)::text, ',' order by b.id), '')) from public.brands b),
    (select md5(coalesce(string_agg(to_jsonb(m)::text, ',' order by m.brand_id, m.user_id), '')) from public.brand_memberships m),
    (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by s.id), '')) from vault.secrets s),
    (select md5(coalesce(string_agg(to_jsonb(p)::text, ',' order by p.id), '')) from public.scheduled_posts p),
    (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by l.id), '')) from public.post_execution_logs l),
    (select md5(coalesce(string_agg(to_jsonb(o)::text, ',' order by o.id), '')) from public.social_account_oauth_states o),
    (select md5(coalesce(string_agg(to_jsonb(f)::text, ',' order by f.id), '')) from public.published_content_fingerprints f),
    (select md5(coalesce(string_agg(to_jsonb(r)::text, ',' order by r.social_account_id), '')) from public.x_account_refresh_state_v2 r),
    (select md5(coalesce(string_agg(to_jsonb(r)::text, ',' order by r.social_account_id), '')) from public.x_account_refresh_rollout r),
    (select md5(coalesce(string_agg(to_jsonb(d)::text, ',' order by d.user_id), '')) from public.social_mobile_account_deletions d),
    (select md5(coalesce(string_agg(to_jsonb(u)::text, ',' order by u.id), '')) from auth.users u))));
end;
$$;

create function public.fixture_check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL %', p_label; end if;
end;
$$;
