-- Emergency rollback for 20261012130000_common_account_core_service_fence. Disposable proof and reviewed
-- operator use only; never applied automatically.
--
-- Removes the profile root fence trigger and the two fence functions, and puts the legacy
-- public.ensure_my_profile() back exactly as 20260924100000 defined it (security invoker, no enrollment).
-- That reopens the Phase 3a "re-create a profile" window by design: it returns to the previous, known
-- state. Any other owner's trigger that already calls the insert fence then FAILS CLOSED (the trigger
-- function no longer exists, so the insert raises and writes nothing).
begin;

do $$
begin
  if to_regprocedure('private.account_lifecycle_service_insert_fence()') is null
     or to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)') is null then
    raise exception 'COMMON_ACCOUNT_CORE_FENCE_ROLLBACK_NOT_APPLIED';
  end if;
end;
$$;

drop trigger account_lifecycle_profile_root_fence on public.profiles;
drop function private.account_lifecycle_service_insert_fence();
drop function private.account_lifecycle_service_state_refusal(uuid, text);

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

commit;
