-- POSTONA X publish switch — T13 + G4 guard for turning publish_enabled ON (F3 SOURCE CANDIDATE, 2026-10-17).
-- NOT in supabase/migrations/. Applies only after the live switch (20261003090000, PR #76), G5/F5's common-account
-- foundation + Phase 3b service-write guard, and the F3 reservation candidate 001 (which holds G4's predicate stub
-- postona_x_resv.g4_x_account_verified). Never apply without one Sol（高） review of the Auth boundary (together with
-- G4 / F5) and the user's explicit approval.
--
-- Gap: public.set_social_account_publish_enabled(account, desired, expected) turns automatic X publishing ON for a
-- self-service POSTONA workspace even when the caller's POSTONA x_autopost service has ended, is being ended, the
-- common account is locked or being deleted, the caller has signed out (the session is gone), or the X identity was
-- never proven (Issue #131). PR #182 still refuses such a send at send time; the ON write itself was unfenced.
--
-- What this file does (and nothing else):
--   * renames the live function to set_social_account_publish_enabled_unguarded_v1 and revokes every API role from
--     it -- its body, answers, lock order and the account-deletion handling are NOT changed;
--   * creates, under the SAME name and signature, a SECURITY DEFINER wrapper (empty search_path, lock_timeout 3 s):
--       - OFF (desired false), invalid input, no caller, an account the caller is not a member of, or an account of a
--         brand that is NOT a self-service POSTONA workspace (code_profile_key <> 'social_mobile_user_v1', e.g. the
--         Kabumori / AI Lab brands) -> straight to the unchanged function (OFF always stays available);
--       - ON in a self-service workspace -> FIRST G5's T13 private.account_lifecycle_assert_active_service_write(
--         auth.uid(), 'x_autopost') (live authenticated session; login KEY SHARE -> common account FOR UPDATE ->
--         x_autopost entitlement FOR UPDATE, held to COMMIT; account active, no account / service deletion,
--         entitlement active), then the caller must be the workspace OWNER, then G4's verified-X-account predicate
--         (the shipped stub is DENY: ON stays refused until G4 delivers), and only then the unchanged function
--         (which takes the workspace locks after the lifecycle locks: G5's order).
--   * keeps the live answer contract EXACTLY (the Edge accepts nothing else): a guard refusal is mapped onto the
--     existing statuses -- deletion in progress / lock wait -> {status: busy}; service not active, not registered,
--     account locked or not found, not the owner -> {status: forbidden}; signed out -> {status: auth_required};
--     X identity not verified by G4 -> {status: blocked, reason: CONNECTION_NOT_VERIFIED}; anything else -> the live
--     PUBLISH_SETTING_UNAVAILABLE error. Nothing is written on any refusal.
--   * re-grants EXECUTE to authenticated only, exactly as today.
-- It does not touch the send-time check (assert_x_publish_permission_for_legacy_post, PR #182's guard), the Edge,
-- Vault, tokens, the OAuth onboarding (PR #257) or any other function.
-- Rollback: 001_publish_enabled_t13_guard_rollback.sql.
begin;

set local lock_timeout = '5s';

do $$
declare v_fn regprocedure; v_p record; v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if to_regprocedure('public.set_social_account_publish_enabled(text,boolean,boolean)') is null then
    raise exception 'PUBLISH_ENABLED_T13_PRECONDITION_SWITCH_MISSING';
  end if;
  if to_regprocedure('public.set_social_account_publish_enabled_unguarded_v1(text,boolean,boolean)') is not null then
    raise exception 'PUBLISH_ENABLED_T13_ALREADY_APPLIED';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = 'public.set_social_account_publish_enabled(text,boolean,boolean)'::regprocedure) is distinct from v_owner then
    raise exception 'PUBLISH_ENABLED_T13_PRECONDITION_OWNER';
  end if;
  if not pg_catalog.has_function_privilege('authenticated', 'public.set_social_account_publish_enabled(text,boolean,boolean)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.set_social_account_publish_enabled(text,boolean,boolean)', 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', 'public.set_social_account_publish_enabled(text,boolean,boolean)', 'EXECUTE') then
    raise exception 'PUBLISH_ENABLED_T13_PRECONDITION_LIVE_GRANTS';
  end if;
  -- G5's T13 guard, the reviewed shape; G4's predicate (F3 reservation candidate 001), owner-only.
  v_fn := to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)');
  if v_fn is null then
    raise exception 'PUBLISH_ENABLED_T13_PRECONDITION_GUARD_MISSING';
  end if;
  select p.prorettype::regtype::text as ret, p.provolatile, p.prosecdef, p.proconfig, p.proowner into v_p from pg_catalog.pg_proc p where p.oid = v_fn;
  if v_p.ret <> 'void' or v_p.provolatile <> 'v' or not v_p.prosecdef or v_p.proconfig is distinct from array['search_path=""'] or v_p.proowner <> v_owner
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
    raise exception 'PUBLISH_ENABLED_T13_PRECONDITION_GUARD_CONTRACT';
  end if;
  v_fn := to_regprocedure('postona_x_resv.g4_x_account_verified(uuid,text)');
  if v_fn is null then
    raise exception 'PUBLISH_ENABLED_T13_PRECONDITION_G4_PREDICATE_MISSING';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) <> v_owner
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
    raise exception 'PUBLISH_ENABLED_T13_PRECONDITION_G4_PREDICATE_CONTRACT';
  end if;
end $$;

alter function public.set_social_account_publish_enabled(text, boolean, boolean) rename to set_social_account_publish_enabled_unguarded_v1;
revoke all on function public.set_social_account_publish_enabled_unguarded_v1(text, boolean, boolean) from public, anon, authenticated, service_role;

create function public.set_social_account_publish_enabled(
  p_social_account_id text, p_desired_enabled boolean, p_expected_current_enabled boolean
) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
-- PUBLISH_ENABLED_T13_GUARD_V1 (F3 2026-10-17): ON in a self-service workspace = T13 + owner + G4 first.
declare
  v_user uuid := auth.uid();
  v_brand text;
  v_profile text;
  v_code text;
begin
  if p_desired_enabled is distinct from true or v_user is null
     or p_social_account_id is null or p_social_account_id !~ '^[A-Za-z0-9_-]{1,100}$' or p_expected_current_enabled is null then
    return public.set_social_account_publish_enabled_unguarded_v1(p_social_account_id, p_desired_enabled, p_expected_current_enabled);
  end if;
  -- Plain reads, no lock (as the live switch's own pre-check): which workspace, and is the caller in it at all.
  select sa.brand_id into v_brand from public.social_accounts sa where sa.id = p_social_account_id;
  if not found or not exists (select 1 from public.brand_memberships bm where bm.brand_id = v_brand and bm.user_id = v_user) then
    return public.set_social_account_publish_enabled_unguarded_v1(p_social_account_id, p_desired_enabled, p_expected_current_enabled);
  end if;
  select b.code_profile_key into v_profile from public.brands b where b.id = v_brand;
  if v_profile is distinct from 'social_mobile_user_v1' then
    return public.set_social_account_publish_enabled_unguarded_v1(p_social_account_id, p_desired_enabled, p_expected_current_enabled);
  end if;
  -- T13 first: the person, their live session and their x_autopost service, locks held to COMMIT.
  begin
    perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');
  exception
    when lock_not_available then
      return pg_catalog.jsonb_build_object('status', 'busy');
    when insufficient_privilege then
      v_code := sqlerrm;
      if v_code = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' then
        return pg_catalog.jsonb_build_object('status', 'auth_required');
      elsif v_code in ('ACCOUNT_DELETION_IN_PROGRESS', 'SERVICE_DELETION_IN_PROGRESS') then
        return pg_catalog.jsonb_build_object('status', 'busy');
      elsif v_code in ('SERVICE_NOT_ACTIVE', 'SERVICE_NOT_REGISTERED', 'ACCOUNT_LOCKED', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND') then
        return pg_catalog.jsonb_build_object('status', 'forbidden');
      end if;
      raise exception 'PUBLISH_SETTING_UNAVAILABLE' using errcode = 'P0001';
  end;
  -- Only the workspace's owner turns its publishing ON (an admin member of a personal workspace cannot).
  if not exists (select 1 from public.brand_memberships bm where bm.brand_id = v_brand and bm.user_id = v_user and bm.role = 'owner') then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;
  -- G4's verified X identity for exactly this person and account (the shipped stub is DENY, Issue #131).
  if postona_x_resv.g4_x_account_verified(v_user, p_social_account_id) is not true then
    return pg_catalog.jsonb_build_object('status', 'blocked', 'reason', 'CONNECTION_NOT_VERIFIED');
  end if;
  return public.set_social_account_publish_enabled_unguarded_v1(p_social_account_id, p_desired_enabled, p_expected_current_enabled);
end $$;

revoke all on function public.set_social_account_publish_enabled(text, boolean, boolean) from public, anon, service_role;
grant execute on function public.set_social_account_publish_enabled(text, boolean, boolean) to authenticated;

-- Postconditions: the wrapper is definer / empty path / authenticated-only and calls the guard; the unguarded switch,
-- the guard and G4's predicate are reachable by no API role.
do $$
declare v_fn text; v_role text;
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = 'public.set_social_account_publish_enabled(text,boolean,boolean)'::regprocedure
                 and p.prosecdef and p.provolatile = 'v' and p.proconfig @> array['search_path=""'] and p.prosrc ~ 'PUBLISH_ENABLED_T13_GUARD_V1'
                 and p.prosrc ~ 'account_lifecycle_assert_active_service_write\(v_user, ''x_autopost''\)'
                 and p.prosrc ~ 'g4_x_account_verified\(v_user, p_social_account_id\)')
     or not pg_catalog.has_function_privilege('authenticated', 'public.set_social_account_publish_enabled(text,boolean,boolean)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.set_social_account_publish_enabled(text,boolean,boolean)', 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', 'public.set_social_account_publish_enabled(text,boolean,boolean)', 'EXECUTE') then
    raise exception 'PUBLISH_ENABLED_T13_POSTCONDITION wrapper';
  end if;
  foreach v_fn in array array['public.set_social_account_publish_enabled_unguarded_v1(text,boolean,boolean)',
                              'private.account_lifecycle_assert_active_service_write(uuid,text)',
                              'postona_x_resv.g4_x_account_verified(uuid,text)'] loop
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      if pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') then
        raise exception 'PUBLISH_ENABLED_T13_POSTCONDITION % reaches %', v_role, v_fn;
      end if;
    end loop;
  end loop;
end $$;

commit;
