-- SOURCE CANDIDATE ONLY. NOT applied to production. Independent review is mandatory before any apply;
-- apply as a single reviewed file (never db push), after the Phase 3b writer guard (20261010051938),
-- which itself follows Phase 1 (20261001150000), Phase 2 (20261006230000) and Phase 3a (20261009120000).
--
-- Common account Phase 4 (G5): the service row fence, and the Kabumori profile root closed.
--
-- Phase 3a (docs/common-account/phase3a-deletion-orchestrator.md section 6) listed one write a still-valid
-- token could always make while a deletion was open: creating the Kabumori profile again, either through
-- the legacy public.ensure_my_profile() (still called by old builds on every accepted session) or by a
-- direct insert the profiles_insert_own policy allows. Nothing refused it; only the later readiness
-- check noticed the new footprint. This file closes that, and gives every other service owner the same
-- one-line fence for rows they create:
--
--   1. private.account_lifecycle_service_state_refusal(user, service) -> text
--        The ONE state decision for a write that is not made by the person's own reviewed writer: null when
--        a write may proceed, otherwise a fixed code. It takes the lifecycle locks in the I1 order (login
--        KEY SHARE -> common account FOR UPDATE -> service entitlement FOR UPDATE) and keeps them until
--        the caller's transaction ends, so a freeze (begin_*_deletion takes the same locks) and a write
--        are totally ordered: a write that got the locks first completes before the freeze sees the row;
--        a freeze that got them first makes the write wait, then refuses it. A lock wait is bounded
--        (3 s) and ends as ACCOUNT_LIFECYCLE_BUSY, which is retryable and writes nothing. It never creates
--        an account or an entitlement. Anything unknown fails closed.
--   2. private.account_lifecycle_service_insert_fence() -> trigger
--        BEFORE INSERT ... FOR EACH ROW, arguments (user_column, service_key). A service owner attaches it
--        to a table whose rows belong to a person:
--          create trigger ..._fence before insert on <table> for each row
--            execute function private.account_lifecycle_service_insert_fence('user_id', 'x_autopost');
--        INSERT only, by design: an UPDATE trigger would fire after the row is locked and invert the I1
--        order against a deletion cascade (deadlock-prone); an owner who must also fence updates calls the
--        Phase 3b writer guard first in its own reviewed writer instead. When a person's JWT is present
--        and its subject is not the row's person, the insert is refused BEFORE any lock is taken, so
--        nobody can queue on another person's account row by naming it.
--   3. account_lifecycle_profile_root_fence (a trigger on public.profiles, service kabumori)
--        Whoever creates a profile -- the lifecycle's own start/restart, ensure_my_profile(), a direct
--        insert, a service-role job -- is subject to the fence: no profile while the account or the
--        Kabumori entitlement is not active or a deletion is open.
--   4. public.ensure_my_profile() keeps its name, grant and return type for old builds, but is now a
--      SECURITY DEFINER wrapper of the Phase 2 automatic start: it enrolls (account, active entitlement,
--      profile) in one transaction, exactly like start_kabumori_service(), and refuses with a fixed code
--      when Kabumori was ended (SERVICE_REENROLL_REQUIRED: only an explicit restart reopens it) or a
--      deletion is open. It takes no argument; the person is auth.uid() only.
--
-- Not done here, deliberately: it does not fence Supabase Auth (identity links, sign-ins, token
-- refresh happen in GoTrue), does not touch Storage, Vault or any other owner's table, and changes no
-- grant of an existing table or policy. The managed Auth delete stays behind the Phase 3a release gate
-- (state 'blocked'). No writer outside this file is changed.
--
-- Codes (message text, SQLSTATE 42501 unless noted): ACCOUNT_LIFECYCLE_AUTH_REQUIRED,
-- ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND, ACCOUNT_DELETION_IN_PROGRESS, ACCOUNT_LOCKED,
-- SERVICE_NOT_REGISTERED, SERVICE_DELETION_IN_PROGRESS, SERVICE_NOT_ACTIVE, SERVICE_REENROLL_REQUIRED,
-- ACCOUNT_LIFECYCLE_SERVICE_INVALID, ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE,
-- ACCOUNT_LIFECYCLE_FENCE_MISCONFIGURED, ACCOUNT_LIFECYCLE_BUSY (retryable).

begin;

do $$
declare
  v_lock regprocedure := to_regprocedure('private.account_lifecycle_lock(uuid,boolean,boolean)');
begin
  if v_lock is null
     or to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)') is null
     or to_regprocedure('private.account_lifecycle_start_service(uuid,text)') is null
     or to_regclass('public.common_accounts') is null
     or to_regclass('public.service_entitlements') is null
     or to_regclass('private.account_lifecycle_operations') is null
     or to_regclass('public.profiles') is null
     or to_regprocedure('auth.uid()') is null then
    raise exception 'COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_FOUNDATION_MISSING';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'private'
                and p.proname in ('account_lifecycle_service_state_refusal', 'account_lifecycle_service_insert_fence'))
     or exists (select 1 from pg_trigger t where t.tgrelid = 'public.profiles'::regclass
                 and t.tgname = 'account_lifecycle_profile_root_fence' and not t.tgisinternal) then
    raise exception 'COMMON_ACCOUNT_CORE_FENCE_ALREADY_APPLIED';
  end if;
  -- ensure_my_profile() must still be the original: no argument, returns uuid, invoker rights.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'ensure_my_profile'
                    and p.pronargs = 0 and p.prorettype = 'uuid'::regtype and not p.prosecdef) then
    raise exception 'COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_ENSURE_MY_PROFILE_SHAPE';
  end if;
  if (select count(*) from pg_attribute a
       where a.attrelid = 'public.profiles'::regclass and a.attname = 'id' and a.atttypid = 'uuid'::regtype
         and not a.attisdropped) <> 1 then
    raise exception 'COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_PROFILES_SHAPE';
  end if;
  -- The lifecycle lock is still reachable by this owner and by no API role (Phase 1 ACL).
  if not has_function_privilege(current_user, v_lock, 'EXECUTE')
     or exists (select 1 from pg_roles r
                 where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                   and has_function_privilege(r.oid, v_lock, 'EXECUTE')) then
    raise exception 'COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_LOCK_ACL_CHANGED';
  end if;
end;
$$;

-- 1. The state decision. Returns null (a write may proceed) or a fixed code; keeps its locks.
create function private.account_lifecycle_service_state_refusal(p_user_id uuid, p_service_key text)
returns text language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s'
as $$
declare
  v_account public.common_accounts;
  v_status text;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    return 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE';
  end if;
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    return 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  if p_user_id is null then
    return 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND';
  end if;

  begin
    -- I1: login KEY SHARE -> account FOR UPDATE (nothing is created), then the entitlement FOR UPDATE.
    v_account := private.account_lifecycle_lock(p_user_id, false);
    if v_account.user_id is null then
      return 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND';
    end if;
    if v_account.status = 'deleting'
       or exists (select 1 from private.account_lifecycle_operations o
                   where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress') then
      return 'ACCOUNT_DELETION_IN_PROGRESS';
    end if;
    if v_account.status <> 'active' then
      return 'ACCOUNT_LOCKED';
    end if;
    select e.status into v_status from public.service_entitlements e
     where e.user_id = p_user_id and e.service_key = p_service_key
     for update;
    if not found then
      return 'SERVICE_NOT_REGISTERED';
    end if;
    if v_status = 'deleting'
       or exists (select 1 from private.account_lifecycle_operations o
                   where o.user_id = p_user_id and o.operation_type = 'service_deletion'
                     and o.service_key = p_service_key and o.status = 'in_progress') then
      return 'SERVICE_DELETION_IN_PROGRESS';
    end if;
    if v_status <> 'active' then
      return 'SERVICE_NOT_ACTIVE';
    end if;
  exception when lock_not_available then
    -- A freeze (or another long lifecycle step) holds the locks: retryable, nothing was written.
    return 'ACCOUNT_LIFECYCLE_BUSY';
  end;
  return null;
end;
$$;

-- 2. The generic insert fence.
create function private.account_lifecycle_service_insert_fence()
returns trigger language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_row jsonb;
  v_column text;
  v_service text;
  v_user uuid;
  v_actor uuid;
  v_refusal text;
begin
  if tg_when <> 'BEFORE' or tg_level <> 'ROW' or tg_op <> 'INSERT' or tg_nargs <> 2 then
    raise exception 'ACCOUNT_LIFECYCLE_FENCE_MISCONFIGURED' using errcode = '42501';
  end if;
  v_column := tg_argv[0];
  v_service := tg_argv[1];
  v_row := to_jsonb(new);
  if v_column is null or v_service is null or jsonb_typeof(v_row) <> 'object' or not (v_row ? v_column) then
    raise exception 'ACCOUNT_LIFECYCLE_FENCE_MISCONFIGURED' using errcode = '42501';
  end if;
  begin
    v_user := (v_row ->> v_column)::uuid;
  exception when others then
    v_user := null;
  end;
  if v_user is null then
    raise exception 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND' using errcode = '42501';
  end if;

  -- A person's own JWT may only create its own rows. Refused before any lock: naming someone else's id
  -- must never queue on their account row (and RLS would refuse the row anyway, after this trigger).
  v_actor := (select auth.uid());
  if v_actor is not null and v_actor <> v_user then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;

  v_refusal := private.account_lifecycle_service_state_refusal(v_user, v_service);
  if v_refusal is not null then
    raise exception '%', v_refusal using errcode = '42501';
  end if;
  return new;
end;
$$;

-- 3. The Kabumori profile root.
create trigger account_lifecycle_profile_root_fence
  before insert on public.profiles
  for each row execute function private.account_lifecycle_service_insert_fence('id', 'kabumori');

-- 4. The legacy bootstrap, now a wrapper of the Phase 2 automatic start (same transaction, same locks).
create or replace function public.ensure_my_profile()
returns uuid language plpgsql volatile security definer set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_answer jsonb;
begin
  if v_user_id is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  v_answer := private.account_lifecycle_start_service(v_user_id, 'kabumori');
  if v_answer ->> 'status' = 'active' then
    return v_user_id;
  end if;
  if v_answer ->> 'status' = 'reenroll_required' then
    raise exception 'SERVICE_REENROLL_REQUIRED' using errcode = '42501';
  end if;
  raise exception '%', case coalesce(v_answer ->> 'reason', '')
    when 'ACCOUNT_DELETION_IN_PROGRESS' then 'ACCOUNT_DELETION_IN_PROGRESS'
    when 'ACCOUNT_LOCKED' then 'ACCOUNT_LOCKED'
    when 'SERVICE_DELETION_IN_PROGRESS' then 'SERVICE_DELETION_IN_PROGRESS'
    else 'SERVICE_NOT_ACTIVE' end using errcode = '42501';
end
$function$;

revoke all on function private.account_lifecycle_service_state_refusal(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_service_insert_fence() from public, anon, authenticated, service_role;
revoke all on function public.ensure_my_profile() from public, anon, authenticated, service_role;
grant execute on function public.ensure_my_profile() to authenticated;

-- Postcondition: the new internal functions are owner-only and no API role reaches them through a
-- membership; ensure_my_profile() is executable by `authenticated` and nobody else; both new internal
-- functions are definer with an empty search_path.
do $$
declare
  v_internal regprocedure[] := array[
    'private.account_lifecycle_service_state_refusal(uuid,text)'::regprocedure,
    'private.account_lifecycle_service_insert_fence()'::regprocedure];
  v_fn regprocedure;
  v_public regprocedure := 'public.ensure_my_profile()'::regprocedure;
begin
  foreach v_fn in array v_internal loop
    if (select array_to_string(p.proacl::text[], ',') from pg_proc p where p.oid = v_fn)
         is distinct from format('%s=X/%s', quote_ident(current_user), quote_ident(current_user))
       or exists (select 1 from pg_roles r
                   where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                     and (has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_has_role(r.oid, current_user, 'USAGE')))
       or not exists (select 1 from pg_proc p where p.oid = v_fn and p.prosecdef and p.proconfig @> array['search_path=""']) then
      raise exception 'COMMON_ACCOUNT_CORE_FENCE_POSTCONDITION_ACL';
    end if;
  end loop;
  if exists (select 1 from pg_roles r
              where r.rolname in ('anon', 'service_role', 'authenticator') and has_function_privilege(r.oid, v_public, 'EXECUTE'))
     or not has_function_privilege('authenticated', v_public, 'EXECUTE')
     or has_function_privilege('public', v_public, 'EXECUTE')
     or not exists (select 1 from pg_proc p where p.oid = v_public and p.prosecdef and p.proconfig @> array['search_path=""']) then
    raise exception 'COMMON_ACCOUNT_CORE_FENCE_POSTCONDITION_ENSURE_MY_PROFILE';
  end if;
end;
$$;

commit;
