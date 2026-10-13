-- F5 Phase 8: the privilege boundary of the ASSEMBLED world (Phase 1..8 + F3 saga/reservations/entitlement guard +
-- F4 Threads cleanup/disconnect/publish/guards), read-only. Run by common_account_phase8_integrated_run.sh against the
-- GRANTED world (F5's reviewed EXECUTE grant candidate applied) and the NOT-GRANTED world (the shipped state):
--   psql -v variant=granted|nogrant -f common_account_phase8_integrated_acl.sql
-- Every check raises on a mismatch; the markers are ACL_<n>_<name>_PASS. Fixture stand-ins (public.fixture_*, schema t13,
-- schemas postona_mock/postona_proof) are excluded by name and are never part of a candidate.
\set ON_ERROR_STOP on
-- regprocedure prints the schema only when it is not on the search path: pin an empty one for stable names
set search_path = '';
\pset tuples_only on
\pset format unaligned
select :'variant' in ('granted', 'nogrant') as variant_ok \gset
\if :variant_ok
\else
  do $$ begin raise exception 'ACL_VARIANT_REQUIRED'; end $$;
\endif
-- psql variables are not interpolated inside a dollar-quoted block: carry the variant as a setting
select set_config('p8.variant', :'variant', false) \gset

-- A1. Every SECURITY DEFINER function of the three schemas pins its search_path. The three X onboarding RPCs of the
--     shipped migration 20260919120000 pin `public` (or `public, vault`), not the empty path: pre-existing, listed.
do $$
declare v text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname in ('public', 'private', 'postona_x_resv') and p.proname !~ '^fixture_'
     and not (coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""'])
     and p.proname not in ('begin_social_mobile_x_oauth_connection', 'complete_social_mobile_x_oauth_connection', 'consume_social_mobile_x_oauth_state');
  if v is not null then raise exception 'ACL_A1 a definer function without the empty search_path: %', v; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname = 'public'
     and p.proname in ('begin_social_mobile_x_oauth_connection', 'complete_social_mobile_x_oauth_connection', 'consume_social_mobile_x_oauth_state')
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%');
  if v is not null then raise exception 'ACL_A1 a pre-existing onboarding RPC with no pinned search_path at all: %', v; end if;
end $$;
\echo ACL_1_DEFINER_SEARCH_PATH_PASS

-- A2. One non-superuser owner for every non-fixture definer function and no BYPASSRLS/superuser among the owners.
do $$
declare v int;
begin
  select count(distinct p.proowner) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname in ('public', 'private', 'postona_x_resv') and p.proname !~ '^fixture_';
  if v <> 1 then raise exception 'ACL_A2 % owners', v; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
              where p.prosecdef and n.nspname in ('public', 'private', 'postona_x_resv') and p.proname !~ '^fixture_'
                and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'ACL_A2 a definer function is owned by a superuser / BYPASSRLS role';
  end if;
end $$;
\echo ACL_2_OWNER_PASS

-- A3. EXACTLY these definer functions are executable by `authenticated`; none by `anon`, none by PUBLIC; nothing of
--     private / postona_x_resv is executable by any API role.
do $$
declare v_have text[]; v_want text[] := array[
  'public.begin_social_mobile_x_oauth_connection(text,text,timestamp with time zone)',
  'public.begin_threads_manual_publish(text,uuid,text)',
  'public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)',
  'public.consume_social_mobile_x_oauth_state(text)',
  'public.disconnect_threads_account(text,text)',
  'public.ensure_my_profile()',
  'public.get_threads_manual_publish_attempt(uuid)',
  'public.get_threads_manual_publish_state(text)',
  'public.reactivate_kabumori_service(bigint)',
  'public.reactivate_x_autopost_service(bigint)',
  'public.record_threads_manual_publish_result(uuid,text,text,text,text,text,text,text,bigint,text,text)',
  'public.release_threads_manual_publish_step(uuid,text,bigint,text,text)',
  'public.set_threads_manual_publish_permission(text,boolean,boolean)',
  'public.start_kabumori_service()',
  'public.start_x_autopost_service()'];
begin
  select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), '{}') into v_have
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname in ('public', 'private', 'postona_x_resv') and p.proname !~ '^fixture_'
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_have is distinct from (select array_agg(x order by x) from unnest(v_want) x) then
    raise exception 'ACL_A3 authenticated-executable definer set differs: have % want %', v_have, v_want;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public', 'private', 'postona_x_resv') and p.proname !~ '^fixture_' and p.prokind = 'f'
                and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('public', p.oid, 'EXECUTE'))
                and p.prosecdef) then
    raise exception 'ACL_A3 a definer function is executable by anon or PUBLIC';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('private', 'postona_x_resv')
                and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     or has_function_privilege('public', p.oid, 'EXECUTE'))) then
    raise exception 'ACL_A3 a private / postona_x_resv function is reachable by an API role';
  end if;
end $$;
\echo ACL_3_AUTHENTICATED_SURFACE_PASS

-- A4. The person is never an argument: no authenticated-executable definer function takes a user id (strict owner
--     inference: the caller is auth.uid(), read inside).
do $$
declare v text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname = 'public' and p.proname !~ '^fixture_' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and p.proargnames && array['p_user_id', 'p_user', 'user_id', 'p_owner_id'];
  if v is not null then raise exception 'ACL_A4 a user-facing function takes a user id: %', v; end if;
end $$;
\echo ACL_4_NO_USER_ID_ARGUMENT_PASS

-- A5. The service-role surface of the three stacks, function by function. G5/F5 and F3 are service-only; F4's
--     cleanup pair is service_role ONLY once F5's reviewed grant candidate is applied (the variant), never otherwise.
do $$
declare
  v_granted boolean := current_setting('p8.variant') = 'granted';
  v_service_only text[] := array[
    -- F5 (common account lifecycle, Phases 1-8)
    'public.begin_common_account_deletion(uuid,bigint)', 'public.claim_common_account_deletion(uuid,uuid,integer)',
    'public.complete_common_account_deletion(uuid,uuid)', 'public.begin_service_deletion(uuid,text)',
    'public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)', 'public.finish_owned_service_deletion(uuid,text,uuid,uuid)',
    'public.record_owned_service_deletion_provider_result(uuid,text,uuid,uuid,text,text)',
    'public.record_owned_service_deletion_reconciliation(uuid,text,uuid,uuid,text,integer)',
    'public.acknowledge_owned_remote_unverified(uuid,text,uuid,uuid,text[])',
    'public.common_account_service_end_result(uuid,text)', 'public.common_account_brand_service_state(text,text)',
    'public.common_account_provider_snapshot(uuid)', 'public.withdraw_kabumori_service(uuid)',
    -- F3 (X saga stop, publish authority)
    'public.social_mobile_account_deletion_stop_x(uuid,uuid)', 'public.social_mobile_account_deletion_x_precheck(uuid)',
    'public.postona_x_stop_account_publishing(text,text)', 'public.postona_x_stop_publishing_for_user(uuid,text)',
    'public.set_x_account_publish_authority(text,text,text,timestamp with time zone,timestamp with time zone)'];
  v_internal text[] := array[
    'private.account_lifecycle_lock(uuid,boolean,boolean)', 'private.account_lifecycle_cleanup_authorized(uuid)',
    'private.account_lifecycle_service_state_refusal(uuid,text)', 'private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid)',
    'public.threads_cleanup_authorized(uuid)', 'public.social_mobile_account_deletion_hold(uuid,uuid)',
    'postona_x_resv.g5_x_autopost_allowed(uuid)', 'postona_x_resv.g4_x_account_verified(uuid,text)', 'postona_x_resv.pre_publish_check(uuid,uuid)',
    'postona_x_resv.claim_due(text,integer,integer)', 'postona_x_resv.finish(uuid,uuid,text,text,text)', 'postona_x_resv.lock_own(uuid,integer)'];
  v text; v_oid regprocedure;
begin
  foreach v in array v_service_only loop
    v_oid := to_regprocedure(v);
    if v_oid is null then raise exception 'ACL_A5 missing function %', v; end if;
    if has_function_privilege('anon', v_oid, 'EXECUTE') or has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or has_function_privilege('public', v_oid, 'EXECUTE') or not has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'ACL_A5 % is not service_role-only', v;
    end if;
  end loop;
  foreach v in array v_internal loop
    v_oid := to_regprocedure(v);
    if v_oid is null then raise exception 'ACL_A5 missing internal function %', v; end if;
    if has_function_privilege('anon', v_oid, 'EXECUTE') or has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or has_function_privilege('public', v_oid, 'EXECUTE') or has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'ACL_A5 the internal function % is reachable by an API role', v;
    end if;
  end loop;
  -- F4's pair (the read and the cleanup): service_role EXECUTE exists only where F5's reviewed grant candidate was applied
  foreach v in array array['public.cleanup_threads_provider_footprint(uuid)', 'public.threads_provider_connection_state(uuid)'] loop
    v_oid := to_regprocedure(v);
    if v_oid is null then raise exception 'ACL_A5 missing function %', v; end if;
    if has_function_privilege('anon', v_oid, 'EXECUTE') or has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or has_function_privilege('public', v_oid, 'EXECUTE') then
      raise exception 'ACL_A5 % is reachable by anon / authenticated / PUBLIC', v;
    end if;
    if has_function_privilege('service_role', v_oid, 'EXECUTE') is distinct from v_granted then
      raise exception 'ACL_A5 EXECUTE of % for service_role is % in the % world', v, not v_granted, current_setting('p8.variant');
    end if;
  end loop;
end $$;
\echo ACL_5_SERVICE_SURFACE_PASS

-- A6. Nobody but the owner and service_role reaches the lifecycle, authority and reservation tables for writes; the
--     reconciliation facts are not readable by an API role directly.
do $$
declare v text; v_rel regclass;
begin
  foreach v in array array['public.common_accounts', 'public.service_entitlements', 'private.account_lifecycle_operations',
                           'private.account_lifecycle_settings', 'private.account_lifecycle_managed_checkpoints',
                           'private.account_lifecycle_release_gates', 'public.x_account_publish_authority',
                           'postona_x_resv.reservations', 'postona_x_resv.batches', 'postona_x_resv.audit',
                           'public.social_mobile_account_deletions'] loop
    v_rel := to_regclass(v);
    if v_rel is null then raise exception 'ACL_A6 missing table %', v; end if;
    if has_table_privilege('anon', v_rel, 'INSERT') or has_table_privilege('anon', v_rel, 'UPDATE') or has_table_privilege('anon', v_rel, 'DELETE')
       or has_table_privilege('anon', v_rel, 'TRUNCATE') or has_table_privilege('authenticated', v_rel, 'INSERT')
       or has_table_privilege('authenticated', v_rel, 'UPDATE') or has_table_privilege('authenticated', v_rel, 'DELETE')
       or has_table_privilege('authenticated', v_rel, 'TRUNCATE') then
      raise exception 'ACL_A6 an API role can write %', v;
    end if;
  end loop;
  if has_column_privilege('anon', 'private.account_lifecycle_operations', 'reconciliation', 'SELECT')
     or has_column_privilege('authenticated', 'private.account_lifecycle_operations', 'reconciliation', 'SELECT') then
    raise exception 'ACL_A6 the reconciliation facts are readable by an API role';
  end if;
end $$;
\echo ACL_6_TABLE_WRITES_PASS

-- A7. The reservation API role: exactly the six owner actions, no schema other than postona_x_resv and public USAGE, no
--     bypass, no membership in an API role, no table privilege on the lifecycle/authority tables.
do $$
declare v_have text[];
begin
  select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), '{}') into v_have
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema') and has_function_privilege('postona_resv_api', p.oid, 'EXECUTE')
     and not has_function_privilege('public', p.oid, 'EXECUTE');
  if v_have is distinct from array[
       'postona_x_resv.cancel(uuid,integer)',
       'postona_x_resv.create_batch(text,uuid,integer,text,jsonb,jsonb)',
       'postona_x_resv.get_reservation(uuid)',
       'postona_x_resv.list_reservations(text)',
       'postona_x_resv.reconfirm(uuid,integer,text)',
       'postona_x_resv.reschedule(uuid,integer,timestamp with time zone)'] then
    raise exception 'ACL_A7 the reservation API role executes %', v_have;
  end if;
  if exists (select 1 from pg_roles r where r.rolname = 'postona_resv_api' and (r.rolsuper or r.rolbypassrls or r.rolcanlogin or r.rolinherit)) then
    raise exception 'ACL_A7 the reservation API role has an unexpected attribute';
  end if;
  if exists (select 1 from pg_auth_members m join pg_roles u on u.oid = m.member where u.rolname = 'postona_resv_api') then
    raise exception 'ACL_A7 the reservation API role is a member of another role';
  end if;
  if has_table_privilege('postona_resv_api', 'public.common_accounts', 'SELECT') or has_table_privilege('postona_resv_api', 'public.service_entitlements', 'SELECT')
     or has_table_privilege('postona_resv_api', 'public.x_account_publish_authority', 'SELECT')
     or has_table_privilege('postona_resv_api', 'private.account_lifecycle_operations', 'SELECT') then
    raise exception 'ACL_A7 the reservation API role reads lifecycle or authority tables directly';
  end if;
end $$;
\echo ACL_7_RESERVATION_API_ROLE_PASS

-- A8. The writer guards are all there: the account root, the entitlement identity, the profile root fence, the deletion
--     guard on the workspace tables and F3's provider guard on social_accounts (a missing trigger would silently drop a fence).
do $$
declare v text;
begin
  foreach v in array array[
    'public.common_accounts:account_lifecycle_account_changed', 'public.common_accounts:account_lifecycle_guard_account_delete',
    'public.service_entitlements:account_lifecycle_guard_entitlement_identity', 'public.profiles:account_lifecycle_profile_root_fence',
    'public.social_accounts:social_mobile_deletion_guard', 'public.social_accounts:social_accounts_provider_guard',
    'public.brands:social_mobile_deletion_guard', 'public.brand_memberships:social_mobile_deletion_guard',
    'public.scheduled_posts:social_mobile_deletion_guard', 'public.publish_claims:social_mobile_deletion_guard',
    'public.threads_manual_publish_attempts:social_mobile_deletion_guard'] loop
    if not exists (select 1 from pg_trigger t where t.tgrelid = split_part(v, ':', 1)::regclass and t.tgname = split_part(v, ':', 2)
                      and not t.tgisinternal and t.tgenabled = 'O') then
      raise exception 'ACL_A8 trigger % is missing or disabled', v;
    end if;
  end loop;
end $$;
\echo ACL_8_GUARD_TRIGGERS_PASS
\echo ACL_ALL_PASS
