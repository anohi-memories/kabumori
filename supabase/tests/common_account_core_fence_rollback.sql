-- Emergency rollback for 20261012130000_common_account_core_service_fence. Disposable proof and reviewed
-- operator use only; never applied automatically.
--
-- What it takes back, always: only what G5 attached or replaced --
--   * the profile root fence trigger on public.profiles;
--   * public.ensure_my_profile(), put back exactly as 20260924100000 defined it (security invoker, no
--     enrollment). That reopens the Phase 3a "re-create a profile" window by design: it returns to the
--     previous, known state.
--
-- What it takes back only when nothing else uses it: the two shared functions
--   private.account_lifecycle_service_insert_fence() and private.account_lifecycle_service_state_refusal().
-- Another service owner may have attached the insert fence to its own table (that is its purpose), and
-- PostgreSQL then refuses a plain DROP of the function (RESTRICT). A DROP ... CASCADE is never used: it
-- would silently remove that owner's trigger and open its write boundary. So, when any trigger on another
-- table uses the fence, or any other function's body names either shared function, the rollback KEEPS both
-- functions, unchanged and working, and says who depends on them (NOTICE). Their protection is untouched;
-- the owners detach their own triggers in their own reviewed step, and running this file again then removes
-- the functions. (PostgreSQL does not track calls inside function bodies, hence the source scan: it is a
-- conservative guard, not a proof; a caller it cannot see fails closed when the function is gone.)
--
-- A fence that itself misbehaves is fixed by replacing the function body (create or replace), not by
-- dropping it under other owners' triggers.
--
-- Repeatable: each run only does what is still to do. It refuses (COMMON_ACCOUNT_CORE_FENCE_ROLLBACK_NOT_
-- APPLIED) when there is nothing at all left to roll back.
begin;

do $$
begin
  if to_regprocedure('private.account_lifecycle_service_insert_fence()') is null
     and to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)') is null
     and not exists (select 1 from pg_trigger t where t.tgrelid = 'public.profiles'::regclass
                      and t.tgname = 'account_lifecycle_profile_root_fence' and not t.tgisinternal)
     and not exists (select 1 from pg_proc p where p.oid = 'public.ensure_my_profile()'::regprocedure and p.prosecdef) then
    raise exception 'COMMON_ACCOUNT_CORE_FENCE_ROLLBACK_NOT_APPLIED';
  end if;
end;
$$;

-- 1. What G5 attached or replaced: always.
drop trigger if exists account_lifecycle_profile_root_fence on public.profiles;

create or replace function public.ensure_my_profile()
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  insert into public.profiles (id)
  values (v_user_id)
  on conflict (id) do nothing;

  return v_user_id;
end
$function$;

revoke all on function public.ensure_my_profile() from public, anon, authenticated, service_role;
grant execute on function public.ensure_my_profile() to authenticated;

-- 2. The shared functions: only when no other owner's trigger or function uses them.
do $$
declare
  v_fence regprocedure := to_regprocedure('private.account_lifecycle_service_insert_fence()');
  v_state regprocedure := to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)');
  v_triggers text;
  v_callers text;
begin
  select string_agg(format('trigger %s on %s', t.tgname, t.tgrelid::regclass), '; ' order by t.tgrelid::regclass::text, t.tgname)
    into v_triggers
    from pg_trigger t
   where v_fence is not null and t.tgfoid = v_fence and not t.tgisinternal;
  select string_agg(format('function %s', p.oid::regprocedure), '; ' order by p.oid::regprocedure::text)
    into v_callers
    from pg_proc p
   where p.oid is distinct from v_fence and p.oid is distinct from v_state
     and p.prokind in ('f', 'p')
     and (p.prosrc like '%account_lifecycle_service_insert_fence%' or p.prosrc like '%account_lifecycle_service_state_refusal%');
  if v_triggers is not null or v_callers is not null then
    raise notice 'COMMON_ACCOUNT_CORE_FENCE_ROLLBACK_PARTIAL: the shared fence functions are kept because other objects use them (%). Their owners detach them in their own reviewed step; run this file again afterwards.',
      concat_ws('; ', v_triggers, v_callers);
    return;
  end if;
  -- insert_fence calls state_refusal from its body (untracked): drop the caller first.
  drop function if exists private.account_lifecycle_service_insert_fence();
  drop function if exists private.account_lifecycle_service_state_refusal(uuid, text);
end;
$$;

commit;
