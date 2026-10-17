-- POSTONA X OAuth onboarding — T13 service-write guard for the LIVE v1 RPCs (F3 SOURCE CANDIDATE, 2026-10-17).
-- NOT in supabase/migrations/. Never apply until G5/F5's common-account foundation + Phase 3b service-write guard
-- (private.account_lifecycle_assert_active_service_write, F5 Draft stack) are approved and applied, one Sol（高）
-- review of the Auth boundary, and the user's explicit approval.
--
-- Gap (F5 Phase 8 finding I15 / G3-1): the live X onboarding RPCs (20260919120000 + 20260922003101) let a person
-- begin, consume and complete an X connection while their POSTONA x_autopost service is not active, is being
-- ended or the whole common account is being deleted or is locked -- the connection writes (workspace, X row,
-- OAuth state, Vault tokens) happen outside the common-account writer fence (T13).
--
-- What this file does (and nothing else):
--   * renames each live function to <name>_unguarded_v1 and revokes every API role from it -- its body, codes,
--     identity handling and write order are NOT changed (no copy, no edit);
--   * creates, under the SAME name and signature, a SECURITY DEFINER wrapper (empty search_path, lock_timeout 3 s)
--     that refuses a missing caller with the live code, calls G5's T13 guard
--     private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost') FIRST in the caller's
--     READ COMMITTED transaction (person = live authenticated session; login KEY SHARE -> common account FOR
--     UPDATE -> x_autopost entitlement FOR UPDATE, held to COMMIT; account active, no account / service deletion
--     in progress, entitlement active), and only then calls the unchanged function. The guard therefore runs
--     before the workspace / X row / OAuth state / Vault writes of begin and complete, and before the X code
--     exchange (consume runs first in the callback);
--   * re-grants EXECUTE to authenticated only, exactly as today.
-- Refusals keep the guard's fixed codes (SQLSTATE 42501: ACCOUNT_LIFECYCLE_AUTH_REQUIRED, ACCOUNT_DELETION_IN_PROGRESS,
-- ACCOUNT_LOCKED, SERVICE_NOT_REGISTERED, SERVICE_DELETION_IN_PROGRESS, SERVICE_NOT_ACTIVE, ...). A lifecycle lock
-- held longer than 3 s answers SOCIAL_MOBILE_OAUTH_SERVICE_BUSY (retryable; nothing written).
--
-- What it does NOT do: it does not verify the X identity (G4, Issue #131 / Draft PR #126 adds attested _v2 RPCs, T9
-- and T13 there), does not touch Vault, tokens, the Edge Function, refresh, publish_enabled or any other RPC, and
-- does not create an entitlement (a person must have started POSTONA x_autopost first). When G4's _v2 rollout
-- revokes these three names, this guard goes with them.
-- Rollback: 001_x_oauth_t13_guard_rollback.sql (drops the wrappers, restores the names and today's grants).
begin;

set local lock_timeout = '5s';

do $$
declare v_guard regprocedure; v_p record; v_fn text;
begin
  if to_regprocedure('public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)') is null
     or to_regprocedure('public.consume_social_mobile_x_oauth_state(text)') is null
     or to_regprocedure('public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)') is null then
    raise exception 'POSTONA_X_OAUTH_T13_PRECONDITION_V1_MISSING';
  end if;
  if to_regprocedure('public.begin_social_mobile_x_oauth_connection_unguarded_v1(text,text,timestamptz)') is not null
     or to_regprocedure('public.consume_social_mobile_x_oauth_state_unguarded_v1(text)') is not null
     or to_regprocedure('public.complete_social_mobile_x_oauth_connection_unguarded_v1(uuid,text,text,text,text)') is not null then
    raise exception 'POSTONA_X_OAUTH_T13_ALREADY_APPLIED';
  end if;
  -- G5's T13 guard, exactly the reviewed shape: (uuid, text) -> void, volatile, definer, empty search_path,
  -- owned by this owner and executable by no API role.
  v_guard := to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)');
  if v_guard is null then
    raise exception 'POSTONA_X_OAUTH_T13_PRECONDITION_GUARD_MISSING';
  end if;
  select p.prorettype::regtype::text as ret, p.provolatile, p.prosecdef, p.proconfig, p.proowner into v_p from pg_catalog.pg_proc p where p.oid = v_guard;
  if v_p.ret <> 'void' or v_p.provolatile <> 'v' or not v_p.prosecdef or v_p.proconfig is distinct from array['search_path=""']
     or v_p.proowner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
                and pg_catalog.has_function_privilege(r.oid, v_guard, 'EXECUTE')) then
    raise exception 'POSTONA_X_OAUTH_T13_PRECONDITION_GUARD_CONTRACT';
  end if;
  -- One non-superuser owner of the live functions; today's grants (authenticated only).
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'POSTONA_X_OAUTH_T13_PRECONDITION_OWNER';
  end if;
  foreach v_fn in array array['public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)',
                              'public.consume_social_mobile_x_oauth_state(text)',
                              'public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'] loop
    if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure)
         is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
      raise exception 'POSTONA_X_OAUTH_T13_PRECONDITION_OWNER';
    end if;
    if not pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'POSTONA_X_OAUTH_T13_PRECONDITION_LIVE_GRANTS %', v_fn;
    end if;
  end loop;
end $$;

alter function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz) rename to begin_social_mobile_x_oauth_connection_unguarded_v1;
alter function public.consume_social_mobile_x_oauth_state(text) rename to consume_social_mobile_x_oauth_state_unguarded_v1;
alter function public.complete_social_mobile_x_oauth_connection(uuid, text, text, text, text) rename to complete_social_mobile_x_oauth_connection_unguarded_v1;
revoke all on function public.begin_social_mobile_x_oauth_connection_unguarded_v1(text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.consume_social_mobile_x_oauth_state_unguarded_v1(text) from public, anon, authenticated, service_role;
revoke all on function public.complete_social_mobile_x_oauth_connection_unguarded_v1(uuid, text, text, text, text) from public, anon, authenticated, service_role;

create function public.begin_social_mobile_x_oauth_connection(p_state_hash text, p_redirect_uri text, p_expires_at timestamptz)
returns table (brand_id text, social_account_id text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
-- X_OAUTH_T13_GUARD_V1 (F3 2026-10-17): G5's T13 first, then the unchanged live function.
begin
  if auth.uid() is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  begin
    perform private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost');
  exception when lock_not_available then
    raise exception 'SOCIAL_MOBILE_OAUTH_SERVICE_BUSY' using errcode = '55P03';
  end;
  return query select * from public.begin_social_mobile_x_oauth_connection_unguarded_v1(p_state_hash, p_redirect_uri, p_expires_at);
end $$;

create function public.consume_social_mobile_x_oauth_state(p_state_hash text)
returns table (oauth_state_id uuid, redirect_uri text, brand_id text, social_account_id text)
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
-- X_OAUTH_T13_GUARD_V1 (F3 2026-10-17): runs before the X code exchange; nothing is fetched from X when it refuses.
begin
  if auth.uid() is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  begin
    perform private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost');
  exception when lock_not_available then
    raise exception 'SOCIAL_MOBILE_OAUTH_SERVICE_BUSY' using errcode = '55P03';
  end;
  return query select * from public.consume_social_mobile_x_oauth_state_unguarded_v1(p_state_hash);
end $$;

create function public.complete_social_mobile_x_oauth_connection(
  p_oauth_state_id uuid, p_platform_user_id text, p_handle text, p_access_token text, p_refresh_token text)
returns void
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
-- X_OAUTH_T13_GUARD_V1 (F3 2026-10-17): the service is re-checked (and fenced) in the transaction that writes the
-- identity and the Vault tokens; a service that ended during the X code exchange refuses with nothing written.
begin
  if auth.uid() is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  begin
    perform private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost');
  exception when lock_not_available then
    raise exception 'SOCIAL_MOBILE_OAUTH_SERVICE_BUSY' using errcode = '55P03';
  end;
  perform public.complete_social_mobile_x_oauth_connection_unguarded_v1(p_oauth_state_id, p_platform_user_id, p_handle, p_access_token, p_refresh_token);
end $$;

revoke all on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz) from public, anon, service_role;
revoke all on function public.consume_social_mobile_x_oauth_state(text) from public, anon, service_role;
revoke all on function public.complete_social_mobile_x_oauth_connection(uuid, text, text, text, text) from public, anon, service_role;
grant execute on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz) to authenticated;
grant execute on function public.consume_social_mobile_x_oauth_state(text) to authenticated;
grant execute on function public.complete_social_mobile_x_oauth_connection(uuid, text, text, text, text) to authenticated;

-- Postconditions: the three wrappers are definer / empty path / authenticated-only and call the guard; the three
-- unguarded functions and the guard are reachable by no API role.
do $$
declare v_fn text; v_role text;
begin
  foreach v_fn in array array['public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)',
                              'public.consume_social_mobile_x_oauth_state(text)',
                              'public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'] loop
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn::regprocedure and p.prosecdef and p.provolatile = 'v'
                   and p.proconfig @> array['search_path=""'] and p.prosrc ~ 'X_OAUTH_T13_GUARD_V1'
                   and p.prosrc ~ 'account_lifecycle_assert_active_service_write\(auth\.uid\(\), ''x_autopost''\)')
       or not pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'POSTONA_X_OAUTH_T13_POSTCONDITION %', v_fn;
    end if;
  end loop;
  foreach v_fn in array array['public.begin_social_mobile_x_oauth_connection_unguarded_v1(text,text,timestamptz)',
                              'public.consume_social_mobile_x_oauth_state_unguarded_v1(text)',
                              'public.complete_social_mobile_x_oauth_connection_unguarded_v1(uuid,text,text,text,text)',
                              'private.account_lifecycle_assert_active_service_write(uuid,text)'] loop
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      if pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') then
        raise exception 'POSTONA_X_OAUTH_T13_POSTCONDITION % reaches %', v_role, v_fn;
      end if;
    end loop;
  end loop;
end $$;

commit;
