-- G4-39 (Issue #319) TEST WORLD ONLY -- a disposable local PostgreSQL 17, never production, never a managed Supabase.
-- The smallest schema that the two product X OAuth migrations (20260919120000, 20260922003101) need, plus
--   * a FAKE auth.uid() (request.jwt.claim.sub) and FAKE Vault (vault.create_secret / update_secret; a test switch fails them),
--   * FAKE G5 authority functions under their G5 names, so that the G4 candidate receives an external verdict:
--       private.postona_personal_session()                 -> text   (G5 PR #510 S2-2; here: a test value, default 'active')
--       private.postona_personal_workspace_eligibility(uuid) -> text (G5 PR #506 S2-3; here: G5's body copied by the runner,
--                                                                     unless a test override is set)
--       private.account_lifecycle_brand_owner_epoch(text)  -> bigint (G5 owner epoch; here: bumped on every owner change)
-- Fake token values only (fakeX...). Nothing here is a product file.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text, name text, description text);
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid language plpgsql as $$
declare v uuid;
begin
  if current_setting('g4x.vault_fail', true) = 'on' then raise exception 'FAKE_VAULT_UNAVAILABLE'; end if;
  insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id into v;
  return v;
end $$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null)
returns void language plpgsql as $$
begin
  if current_setting('g4x.vault_fail', true) = 'on' then raise exception 'FAKE_VAULT_UNAVAILABLE'; end if;
  update vault.secrets set secret = new_secret where id = secret_id;
end $$;

create table public.brands (
  id text primary key, display_name text, is_active boolean, publish_mode text, code_profile_key text);
create table public.brand_memberships (
  brand_id text not null references public.brands(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  constraint brand_memberships_pkey primary key (brand_id, user_id));
create table public.social_accounts (
  id text primary key, brand_id text not null references public.brands(id), platform text not null, handle text,
  publish_enabled boolean not null default false, oauth_client_ref text, connection_status text, platform_user_id text,
  vault_access_token_secret_id uuid, vault_refresh_token_secret_id uuid, verified_at timestamptz,
  last_connection_error_code text, updated_at timestamptz not null default now());
create table public.social_account_oauth_states (
  id uuid primary key default gen_random_uuid(),
  social_account_id text references public.social_accounts(id) on delete cascade,
  brand_id text references public.brands(id) on delete cascade,
  state_hash text not null unique, code_verifier_vault_secret_id uuid, redirect_uri text,
  expires_at timestamptz not null, consumed_at timestamptz, created_at timestamptz not null default now());

create schema private;
create table private.g4x_fake (k text primary key, v text);
create function private.postona_personal_session() returns text language sql stable
  as $$ select coalesce((select v from private.g4x_fake where k = 'session'), 'active') $$;
-- the workspace verdict: G5's PR #506 body (copied by the runner as private.g5_s23_predicate_copy) unless a test value is set;
-- 'null' answers NULL, 'absent_once' answers 'absent' once (a race: the derived row appears after the verdict)
create function private.postona_personal_workspace_eligibility(p_user uuid) returns text language plpgsql volatile as $$
declare v_set boolean := exists (select 1 from private.g4x_fake f where f.k = 'workspace');
        v text := (select f.v from private.g4x_fake f where f.k = 'workspace');
begin
  if not v_set then
    return private.g5_s23_predicate_copy(p_user);
  end if;
  if v = 'absent_once' then
    delete from private.g4x_fake where k = 'workspace';
    return 'absent';
  end if;
  return nullif(v, 'null');
end $$;
-- the owner epoch: moves forward on every owner change (G5's rule); NULL when the brand has none
create table private.g4x_owner_epochs (brand_id text primary key, epoch bigint not null);
create function private.g4x_bump_owner_epoch() returns trigger language plpgsql as $$
declare v_brand text := coalesce(new.brand_id, old.brand_id);
begin
  if (tg_op <> 'INSERT' and old.role = 'owner') or (tg_op <> 'DELETE' and new.role = 'owner') then
    insert into private.g4x_owner_epochs as e (brand_id, epoch) values (v_brand, 1)
    on conflict (brand_id) do update set epoch = e.epoch + 1;
  end if;
  return null;
end $$;
create trigger g4x_owner_epoch after insert or update or delete on public.brand_memberships
  for each row execute function private.g4x_bump_owner_epoch();
create function private.account_lifecycle_brand_owner_epoch(p_brand_id text) returns bigint language sql stable
  as $$ select case when (select v from private.g4x_fake where k = 'owner_epoch') = 'null' then null
                    else (select e.epoch from private.g4x_owner_epochs e where e.brand_id = p_brand_id) end $$;
