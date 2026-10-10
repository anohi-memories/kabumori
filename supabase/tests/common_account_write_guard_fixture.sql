-- Fake-only additions for the Phase 3b service-write guard candidate (20261010051938). Applied after
-- the lifecycle fixtures, Phase 1, Phase 2 and Phase 3a (see the runner), BEFORE the candidate.
-- Disposable local database only; every id is fake.
--
-- * auth.sessions shaped as GoTrue creates it (the columns the guard reads; user_id cascades from the
--   login, as identities_user_id_fkey / sessions_user_id_fkey do in supabase/auth migrations).
-- * Writers shaped like the future callers (T13): a reviewed SECURITY DEFINER writer owned by the
--   lifecycle owner that calls the guard first and then writes a service footprint; the same writer
--   with SECURITY INVOKER; and one owned by another role (set by the runner). The footprint table has
--   no foreign key on purpose: it stands for data a login removal does not cascade (Vault secrets,
--   Storage objects, provider grants).
set timezone = 'UTC';

-- auth.uid() exactly as GoTrue defines it (supabase/auth migrations/20220224000811_update_auth_functions):
-- the per-claim setting of an older PostgREST first, else the JSON claims. The shared fixture's stub
-- reads only the former; the guard must agree with the real one.
create or replace function auth.uid() returns uuid language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create table auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  not_after timestamptz
);

create table public.fixture_service_footprint (
  id bigserial primary key,
  user_id uuid not null,
  service_key text not null,
  written_at timestamptz not null default clock_timestamp()
);
revoke all on table public.fixture_service_footprint from public, anon, authenticated, service_role;
revoke all on sequence public.fixture_service_footprint_id_seq from public, anon, authenticated, service_role;

-- The reviewed shape: definer rights, empty search_path, the guard first, then the write.
create function public.fixture_guarded_service_write(p_service_key text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform private.account_lifecycle_assert_active_service_write((select auth.uid()), p_service_key);
  insert into public.fixture_service_footprint (user_id, service_key)
  values ((select auth.uid()), p_service_key) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.fixture_guarded_service_write(text) from public, anon, authenticated, service_role;
grant execute on function public.fixture_guarded_service_write(text) to authenticated;

-- A writer that hands the guard someone else's id (a service-role style caller trusting its input).
create function public.fixture_guarded_write_for(p_user_id uuid, p_service_key text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform private.account_lifecycle_assert_active_service_write(p_user_id, p_service_key);
  insert into public.fixture_service_footprint (user_id, service_key)
  values (p_user_id, p_service_key) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.fixture_guarded_write_for(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.fixture_guarded_write_for(uuid, text) to authenticated, service_role;

-- Not the reviewed shape: invoker rights (runs as the API role, which may not call the guard).
create function public.fixture_invoker_service_write(p_service_key text)
returns bigint language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform private.account_lifecycle_assert_active_service_write((select auth.uid()), p_service_key);
  insert into public.fixture_service_footprint (user_id, service_key)
  values ((select auth.uid()), p_service_key) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.fixture_invoker_service_write(text) from public, anon, authenticated, service_role;
grant execute on function public.fixture_invoker_service_write(text) to authenticated;

-- Not the reviewed shape: definer rights, but owned by a role outside the lifecycle (the runner moves
-- its owner to a role that inherits service_role).
create function public.fixture_foreign_owner_service_write(p_service_key text)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.account_lifecycle_assert_active_service_write((select auth.uid()), p_service_key);
  return 0;
end;
$$;
revoke all on function public.fixture_foreign_owner_service_write(text) from public, anon, authenticated, service_role;
grant execute on function public.fixture_foreign_owner_service_write(text) to authenticated;
