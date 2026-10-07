-- SOURCE CANDIDATE ONLY. NOT applied to production. Apply as a single reviewed file (never db push),
-- after the Phase 1 foundation (20261001150000) and BEFORE any app build that uses the Phase 2
-- enrollment client ships.
--
-- Common account Phase 2, H1/C1 R1: an automatic service start never restarts an ended service.
--
-- Phase 1's private.account_lifecycle_start_service() restarted an `ended` entitlement. The apps call
-- the start RPCs automatically on every accepted session, so a service the person (or a backend
-- deletion) ended after the app last looked could be restarted without any new user action. This file
-- moves that decision into the lifecycle transaction itself:
--
--   * automatic start (public.start_kabumori_service(), public.start_x_autopost_service(), unchanged
--     names and grants): creates a missing entitlement, is idempotent for an active one, fails closed
--     for every other state, and for an `ended` one changes nothing and answers
--     {status:'reenroll_required', service, lifecycle_version}. Old callers therefore become safer, not
--     different in any other way.
--   * explicit restart (public.reactivate_kabumori_service(bigint), public.reactivate_x_autopost_service
--     (bigint), new, authenticated only): restarts ONLY a currently `ended` entitlement, and only while
--     the account's lifecycle_version still equals the version the person confirmed on the restart
--     screen (any change in between answers lifecycle_changed and changes nothing). A version is used
--     once: the restart itself moves it.
--
-- Active answers now also say whether another service is active on the same common account
-- (`shared_account`), so the apps need no separate read before the start.
--
-- Lock order is unchanged (auth.users row -> common_accounts row -> entitlement -> service rows), the
-- person is always auth.uid(), every function is SECURITY DEFINER with an empty search_path, and nothing
-- here writes to auth, Storage or Vault.

begin;

do $$
begin
  if to_regprocedure('private.account_lifecycle_start_service(uuid,text)') is null
     or to_regprocedure('private.account_lifecycle_lock(uuid,boolean,boolean)') is null
     or to_regprocedure('public.start_kabumori_service()') is null
     or to_regprocedure('public.start_x_autopost_service()') is null
     or to_regclass('public.common_accounts') is null
     or to_regclass('public.service_entitlements') is null
     or to_regclass('private.account_lifecycle_settings') is null then
    raise exception 'COMMON_ACCOUNT_START_INTENT_PREFLIGHT_FOUNDATION_MISSING';
  end if;
  -- A separate statement: it is planned only once the table is known to exist.
  if not exists (select 1 from private.account_lifecycle_settings where auth_delete_guard = 'shadow') then
    raise exception 'COMMON_ACCOUNT_START_INTENT_PREFLIGHT_FOUNDATION_MISSING';
  end if;
  if to_regprocedure('private.account_lifecycle_reactivate_service(uuid,text,bigint)') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname in ('public', 'private')
                   and p.proname in ('reactivate_kabumori_service', 'reactivate_x_autopost_service',
                                     'account_lifecycle_reactivate_service')) then
    raise exception 'COMMON_ACCOUNT_START_INTENT_ALREADY_APPLIED';
  end if;
end;
$$;

-- Shared: the refusal for an entitlement that is neither active nor ended.
create function private.account_lifecycle_service_refusal(p_status text)
returns jsonb language sql immutable security definer set search_path = ''
as $$
  select jsonb_build_object('status', 'blocked', 'reason', case p_status
    when 'deleting' then 'SERVICE_DELETION_IN_PROGRESS'
    when 'suspended' then 'SERVICE_SUSPENDED'
    else 'SERVICE_NOT_READY' end)
$$;

-- Shared: the active answer. shared_account: another service is active on the same account.
create function private.account_lifecycle_active_answer(p_user_id uuid, p_service_key text, p_started boolean)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'status', 'active',
    'service', p_service_key,
    'started', p_started,
    'shared_account', exists (
      select 1 from public.service_entitlements e
       where e.user_id = p_user_id and e.service_key <> p_service_key and e.status = 'active'))
$$;

-- Automatic start (the apps call it on every accepted session). Never restarts an ended service.
create or replace function private.account_lifecycle_start_service(p_user_id uuid, p_service_key text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_entitlement public.service_entitlements;
  v_started boolean := false;
begin
  if p_user_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, true);
  if v_account.status = 'deleting' then
    return jsonb_build_object('status', 'blocked', 'reason', 'ACCOUNT_DELETION_IN_PROGRESS');
  end if;
  if v_account.status <> 'active' then
    return jsonb_build_object('status', 'blocked', 'reason', 'ACCOUNT_LOCKED');
  end if;
  select * into v_entitlement from public.service_entitlements
   where user_id = p_user_id and service_key = p_service_key for update;
  if not found then
    insert into public.service_entitlements (user_id, service_key, status, source, activated_at)
    values (p_user_id, p_service_key, 'active', 'self_service', now());
    v_started := true;
  elsif v_entitlement.status = 'ended' then
    -- Decided under the locks: the person ended this service; only their explicit restart reopens it.
    return jsonb_build_object('status', 'reenroll_required', 'service', p_service_key,
                              'lifecycle_version', v_account.lifecycle_version);
  elsif v_entitlement.status <> 'active' then
    return private.account_lifecycle_service_refusal(v_entitlement.status);
  end if;
  -- The Kabumori service root is created with its entitlement, atomically.
  if p_service_key = 'kabumori' then
    insert into public.profiles (id) values (p_user_id) on conflict (id) do nothing;
  end if;
  return private.account_lifecycle_active_answer(p_user_id, p_service_key, v_started);
end;
$$;

-- Explicit restart of an ended service, bound to the lifecycle version the person confirmed.
create function private.account_lifecycle_reactivate_service(
  p_user_id uuid, p_service_key text, p_expected_lifecycle_version bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_entitlement public.service_entitlements;
begin
  if p_user_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  if p_expected_lifecycle_version is null or p_expected_lifecycle_version < 1 then
    raise exception 'ACCOUNT_LIFECYCLE_VERSION_REQUIRED';
  end if;
  -- p_create => false: a restart never creates an account.
  v_account := private.account_lifecycle_lock(p_user_id, false);
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND' using errcode = '42501';
  end if;
  if v_account.user_id is null then
    return jsonb_build_object('status', 'not_registered', 'service', p_service_key);
  end if;
  if v_account.status = 'deleting' then
    return jsonb_build_object('status', 'blocked', 'reason', 'ACCOUNT_DELETION_IN_PROGRESS');
  end if;
  if v_account.status <> 'active' then
    return jsonb_build_object('status', 'blocked', 'reason', 'ACCOUNT_LOCKED');
  end if;
  if v_account.lifecycle_version <> p_expected_lifecycle_version then
    return jsonb_build_object('status', 'lifecycle_changed', 'service', p_service_key,
                              'lifecycle_version', v_account.lifecycle_version);
  end if;
  select * into v_entitlement from public.service_entitlements
   where user_id = p_user_id and service_key = p_service_key for update;
  if not found then
    return jsonb_build_object('status', 'not_registered', 'service', p_service_key);
  end if;
  if v_entitlement.status = 'active' then
    return private.account_lifecycle_active_answer(p_user_id, p_service_key, false);
  end if;
  if v_entitlement.status <> 'ended' then
    return private.account_lifecycle_service_refusal(v_entitlement.status);
  end if;
  update public.service_entitlements
     set status = 'active', source = 'self_service', legacy_evidence = null,
         activated_at = now(), ended_at = null, updated_at = now()
   where user_id = p_user_id and service_key = p_service_key;
  if p_service_key = 'kabumori' then
    insert into public.profiles (id) values (p_user_id) on conflict (id) do nothing;
  end if;
  return private.account_lifecycle_active_answer(p_user_id, p_service_key, true);
end;
$$;

create function public.reactivate_kabumori_service(p_expected_lifecycle_version bigint)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select private.account_lifecycle_reactivate_service((select auth.uid()), 'kabumori', p_expected_lifecycle_version) $$;

create function public.reactivate_x_autopost_service(p_expected_lifecycle_version bigint)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select private.account_lifecycle_reactivate_service((select auth.uid()), 'x_autopost', p_expected_lifecycle_version) $$;

revoke all on function private.account_lifecycle_service_refusal(text) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_active_answer(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_start_service(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_reactivate_service(uuid, text, bigint) from public, anon, authenticated, service_role;
revoke all on function public.reactivate_kabumori_service(bigint) from public, anon, authenticated, service_role;
revoke all on function public.reactivate_x_autopost_service(bigint) from public, anon, authenticated, service_role;
grant execute on function public.reactivate_kabumori_service(bigint) to authenticated;
grant execute on function public.reactivate_x_autopost_service(bigint) to authenticated;

-- Postflight: exact effective EXECUTE for the API roles, definer + empty search_path everywhere.
do $$
declare
  v_sig text;
  v_role text;
begin
  foreach v_sig in array array[
    'private.account_lifecycle_service_refusal(text)', 'private.account_lifecycle_active_answer(uuid,text,boolean)',
    'private.account_lifecycle_start_service(uuid,text)', 'private.account_lifecycle_reactivate_service(uuid,text,bigint)',
    'public.reactivate_kabumori_service(bigint)', 'public.reactivate_x_autopost_service(bigint)',
    'public.start_kabumori_service()', 'public.start_x_autopost_service()'] loop
    if not (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p where p.oid = to_regprocedure(v_sig)) then
      raise exception 'COMMON_ACCOUNT_START_INTENT_POSTFLIGHT_DEFINER:%', v_sig;
    end if;
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_role, to_regprocedure(v_sig), 'EXECUTE')
         <> (v_role = 'authenticated' and v_sig like 'public.%') then
        raise exception 'COMMON_ACCOUNT_START_INTENT_POSTFLIGHT_EXECUTE:%:%', v_role, v_sig;
      end if;
    end loop;
  end loop;
end;
$$;

commit;
