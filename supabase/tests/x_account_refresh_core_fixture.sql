-- Fake-only baseline for the universal refresh core proof. Mirrors the
-- CURRENT production shape (read-only inspection 2026-09-25): no Phase1B..1I,
-- scheduled_posts without social_account_id, social_accounts with
-- UNIQUE (brand_id, platform), platform = 'x' only, the connection_status
-- CHECK set, and Supabase Vault where service_role can read and write Vault
-- directly (as in production). Apply to a disposable local database as a
-- NON-superuser owner, never to production. All tokens are fake strings.
set timezone = 'UTC';

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table public.brands (id text primary key);
create table public.social_accounts (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,80}$'),
  brand_id text not null references public.brands (id),
  platform text not null check (platform = 'x'),
  handle text,
  platform_user_id text,
  connection_status text not null default 'unconnected'
    check (connection_status in ('unconnected', 'authorization_pending', 'connected', 'identity_verified', 'failed')),
  publish_enabled boolean not null default false,
  oauth_client_ref text default 'default',
  vault_access_token_secret_id uuid,
  vault_refresh_token_secret_id uuid,
  last_connection_error_code text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, platform)
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
  target_difficulty text,
  target_question_format text,
  brand_id text not null default 'kabumori' references public.brands (id)
);

create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text not null);
create view vault.decrypted_secrets as select s.id, s.secret as decrypted_secret from vault.secrets s;
create function vault.update_secret(
  secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id;
  if not found then raise exception 'fixture vault secret not found'; end if;
end;
$$;
revoke all on schema vault from public;
revoke all on all tables in schema vault from public, anon, authenticated, service_role;
revoke all on function vault.update_secret(uuid, text, text, text, uuid) from public, anon, authenticated;
-- Production today: service_role may read decrypted secrets and call update_secret.
grant usage on schema vault to service_role;
grant select on vault.decrypted_secrets to service_role;
grant execute on function vault.update_secret(uuid, text, text, text, uuid) to service_role;

-- Test-only fault injection for "writer failure".
create function vault.fixture_fail_write() returns trigger language plpgsql as $$
begin
  if new.secret = 'fake_FORCE_WRITE_FAIL' then raise exception 'FIXTURE_VAULT_WRITE_FAILURE'; end if;
  return new;
end;
$$;
create trigger fixture_fail_write before update on vault.secrets
for each row execute function vault.fixture_fail_write();

insert into public.brands values
  ('kabumori'), ('ai_salaryman_lab'), ('u_disabled'), ('brand_d'), ('brand_e'), ('brand_f'),
  ('brand_g'), ('brand_h'), ('brand_i');
insert into vault.secrets (id, secret) values
  ('00000000-0000-4000-8000-00000000a1a1', 'fake_AI_access_1'),
  ('00000000-0000-4000-8000-00000000a1a2', 'fake_AI_REFRESH_1'),
  ('00000000-0000-4000-8000-00000000d0d1', 'fake_D_access_1'),
  ('00000000-0000-4000-8000-00000000d0d2', 'fake_D_REFRESH_1'),
  ('00000000-0000-4000-8000-00000000e0e1', 'fake_E_access_1'),
  ('00000000-0000-4000-8000-00000000e0e2', 'fake_E_REFRESH_1'),
  ('00000000-0000-4000-8000-00000000f0f2', 'fake_F_REFRESH_1'),
  ('00000000-0000-4000-8000-00000000c0c1', 'fake_G_same_1'),
  ('00000000-0000-4000-8000-00000000b0b1', 'fake_H_access_1'),
  ('00000000-0000-4000-8000-00000000b0b2', 'fake_H_REFRESH_1'),
  ('00000000-0000-4000-8000-00000000a0a1', 'fake_I_access_1'),
  ('00000000-0000-4000-8000-00000000a0a2', 'fake_I_REFRESH_1'),
  ('00000000-0000-4000-8000-000000009991', 'fake_U_access_1'),
  ('00000000-0000-4000-8000-000000009992', 'fake_U_REFRESH_1');
insert into public.social_accounts
  (id, brand_id, platform, handle, platform_user_id, connection_status, publish_enabled, oauth_client_ref,
   vault_access_token_secret_id, vault_refresh_token_secret_id)
values
  -- Kabumori legacy: token lives outside Vault (oauth_token_store/env), no refs.
  ('kabumori_x', 'kabumori', 'x', 'kabumori', 'x_kabumori', 'identity_verified', true, 'default', null, null),
  ('ai_salaryman_lab_x', 'ai_salaryman_lab', 'x', 'kaishain_ai_lab', 'x_ai_lab', 'identity_verified', true, 'default',
   '00000000-0000-4000-8000-00000000a1a1', '00000000-0000-4000-8000-00000000a1a2'),
  ('sa_disabled', 'u_disabled', 'x', 'u', 'x_u', 'identity_verified', false, 'default',
   '00000000-0000-4000-8000-000000009991', '00000000-0000-4000-8000-000000009992'),
  ('acct_d', 'brand_d', 'x', 'd', 'x_d', 'identity_verified', true, 'default',
   '00000000-0000-4000-8000-00000000d0d1', '00000000-0000-4000-8000-00000000d0d2'),
  -- acct_f wrongly uses acct_e's access secret as its access destination.
  ('acct_e', 'brand_e', 'x', 'e', 'x_e', 'identity_verified', true, 'default',
   '00000000-0000-4000-8000-00000000e0e1', '00000000-0000-4000-8000-00000000e0e2'),
  ('acct_f', 'brand_f', 'x', 'f', 'x_f', 'identity_verified', true, 'default',
   '00000000-0000-4000-8000-00000000e0e1', '00000000-0000-4000-8000-00000000f0f2'),
  ('acct_g', 'brand_g', 'x', 'g', 'x_g', 'identity_verified', true, 'default',
   '00000000-0000-4000-8000-00000000c0c1', '00000000-0000-4000-8000-00000000c0c1'),
  ('acct_h', 'brand_h', 'x', 'h', 'x_h', 'identity_verified', true, ' ',
   '00000000-0000-4000-8000-00000000b0b1', '00000000-0000-4000-8000-00000000b0b2'),
  ('acct_i', 'brand_i', 'x', 'i', 'x_i', 'identity_verified', true, 'secondary',
   '00000000-0000-4000-8000-00000000a0a1', '00000000-0000-4000-8000-00000000a0a2');
