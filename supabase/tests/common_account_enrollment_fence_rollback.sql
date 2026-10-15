-- Emergency rollback for 20261015090000_common_account_enrollment_session_fence. Disposable proof and reviewed
-- operator use only; never applied automatically.
--
-- Restores the five public functions EXACTLY as Phase 1 / Phase 2 / Phase 4 defined them (the migration's own
-- preflight pins their md5, and the proof runner checks the same pins after this file ran), then drops the internal
-- check. Grants are untouched (create or replace keeps them). No data is written and no CASCADE is used. After it,
-- a signed-out device's still-unexpired token can restart an ended service again (the behaviour Phase 9 found).
begin;

do $$
declare
  v_sig text;
begin
  if to_regprocedure('private.account_lifecycle_enrollment_fence(uuid,boolean)') is null then
    raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_ROLLBACK_NOT_APPLIED';
  end if;
  -- Only functions that still carry the fence are restored; anything else was changed by somebody else.
  foreach v_sig in array array[
    'public.start_kabumori_service()', 'public.start_x_autopost_service()', 'public.ensure_my_profile()',
    'public.reactivate_kabumori_service(bigint)', 'public.reactivate_x_autopost_service(bigint)'] loop
    if to_regprocedure(v_sig) is null
       or (select p.prosrc from pg_proc p where p.oid = to_regprocedure(v_sig)) !~ 'account_lifecycle_enrollment_fence' then
      raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_ROLLBACK_DRIFT:%', v_sig;
    end if;
  end loop;
end;
$$;

create or replace function public.start_kabumori_service()
returns jsonb language sql volatile security definer set search_path = ''
as $$ select private.account_lifecycle_start_service((select auth.uid()), 'kabumori') $$;

create or replace function public.start_x_autopost_service()
returns jsonb language sql volatile security definer set search_path = ''
as $$ select private.account_lifecycle_start_service((select auth.uid()), 'x_autopost') $$;

create or replace function public.reactivate_kabumori_service(p_expected_lifecycle_version bigint)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select private.account_lifecycle_reactivate_service((select auth.uid()), 'kabumori', p_expected_lifecycle_version) $$;

create or replace function public.reactivate_x_autopost_service(p_expected_lifecycle_version bigint)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select private.account_lifecycle_reactivate_service((select auth.uid()), 'x_autopost', p_expected_lifecycle_version) $$;

-- Phase 4's legacy bootstrap, as it left it.
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

drop function private.account_lifecycle_enrollment_fence(uuid, boolean);

commit;
