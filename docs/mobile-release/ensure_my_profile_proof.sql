-- Disposable-database proof for supabase/migrations/20260924100000_ensure_my_profile.sql.
--
-- Run against a throwaway Postgres container only. It builds the minimum of the real schema the
-- function depends on (auth.uid(), public.profiles and its RLS policies, copied from
-- 20260901061217_add_kabumori_mvp_tables.sql), applies the migration file itself with \i so the
-- exact reviewed bytes are what gets tested, and then checks behaviour as a real `authenticated`
-- caller. It never touches production.

\set ON_ERROR_STOP on

-- The Supabase Postgres image already ships the real auth schema, auth.users and auth.uid(), so the
-- proof uses them rather than a stand-in. These two statements only fill the gap if a plainer image
-- is used; on the Supabase image they are no-ops.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);

-- The real profiles table and its policies, verbatim in shape from the MVP migration.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles for select to authenticated
using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles for insert to authenticated
with check (auth.uid() = id);

grant usage on schema public to authenticated, anon;
grant select, insert on public.profiles to authenticated;

-- The migration under test, byte for byte.
\i supabase/migrations/20260924100000_ensure_my_profile.sql

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

do $$
declare
  v_count int;
  v_returned uuid;
  v_message text;
begin
  -- 1. An authenticated caller creates exactly their own profile.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  v_returned := public.ensure_my_profile();
  if v_returned <> '11111111-1111-1111-1111-111111111111'::uuid then
    raise exception 'PROOF_FAIL returned % instead of the caller id', v_returned;
  end if;

  -- 2. Calling it again is a no-op, not a duplicate-key error.
  perform public.ensure_my_profile();
  perform public.ensure_my_profile();
  reset role;
  select count(*) into v_count from public.profiles;
  if v_count <> 1 then
    raise exception 'PROOF_FAIL three calls produced % rows', v_count;
  end if;

  -- 3. A second user gets their own row and cannot affect the first.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform public.ensure_my_profile();
  reset role;
  select count(*) into v_count from public.profiles
   where id = '22222222-2222-2222-2222-222222222222';
  if v_count <> 1 then
    raise exception 'PROOF_FAIL second user row count is %', v_count;
  end if;

  -- 4. With no JWT the function refuses instead of inserting a null-owner row. The message is
  --    checked, not just the SQLSTATE: an RLS or grant denial would raise 42501 as well, and this
  --    step is specifically about the function's own guard.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.ensure_my_profile();
    reset role;
    raise exception 'PROOF_FAIL an anonymous call was allowed to proceed';
  exception when sqlstate '42501' then
    get stacked diagnostics v_message = message_text;
    reset role;
    if v_message <> 'AUTHENTICATION_REQUIRED' then
      raise exception 'PROOF_FAIL expected the function guard, got %', v_message;
    end if;
  end;

  -- 5. `anon` holds no execute privilege. This is asserted on the catalog rather than by calling
  --    the function: a call would also fail for anon because it has no insert grant on profiles,
  --    which would make the step pass for the wrong reason.
  if has_function_privilege('anon', 'public.ensure_my_profile()', 'EXECUTE') then
    raise exception 'PROOF_FAIL anon holds EXECUTE on ensure_my_profile';
  end if;
  if not has_function_privilege('authenticated', 'public.ensure_my_profile()', 'EXECUTE') then
    raise exception 'PROOF_FAIL authenticated is missing EXECUTE on ensure_my_profile';
  end if;
  if has_function_privilege('service_role', 'public.ensure_my_profile()', 'EXECUTE') then
    raise exception 'PROOF_FAIL service_role holds EXECUTE on ensure_my_profile';
  end if;

  -- 6. Total rows are still exactly the two the two callers created.
  select count(*) into v_count from public.profiles;
  if v_count <> 2 then
    raise exception 'PROOF_FAIL final row count is %', v_count;
  end if;

  raise notice 'PROOF_RESULT PASS';
exception
  when others then
    get stacked diagnostics v_message = message_text;
    raise notice 'PROOF_RESULT FAIL %', v_message;
    raise;
end
$$;
