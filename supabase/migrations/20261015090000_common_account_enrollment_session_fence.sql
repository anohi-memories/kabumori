-- SOURCE CANDIDATE ONLY. NOT applied to production. Independent review is mandatory before any apply; apply as a
-- single reviewed file (never db push), after Phase 8 (20261013140000, PR #193) and BEFORE any app build that depends
-- on it. Additive: no table, column, grant or trigger changes; five existing public functions are re-created with the
-- same signature, owner, ACL and answers, plus one internal check at their top.
--
-- Common account Phase 9 (F5): the enrollment RPCs and the session they are called with.
--
-- What the offline proof (supabase/tests/common_account_phase9_shared_login_*) found:
--   1. public.reactivate_*_service(version) -- the person's EXPLICIT restart of an ended service -- answered for any
--      JWT of the login that is still inside its `exp`, including one whose session was already signed out or
--      revoked (auth.sessions row gone). A signed-out device's token (or one captured earlier) could re-open a service
--      the person had ended, up to the token's lifetime. Every service WRITER is already bound to a live session
--      (Phase 3b, private.account_lifecycle_assert_active_service_write); the restart was the one explicit action
--      that was not.
--   2. A common account is an identity of a real login. An anonymous (guest) session -- `is_anonymous: true` in its
--      token -- would have been enrolled like any other. Neither app has a guest mode and a hosted project keeps
--      anonymous sign-ins off; this makes the database say so too (defense in depth; reverse it here if a guest mode
--      is ever introduced on purpose).
--
-- What this file does:
--   * private.account_lifecycle_enrollment_fence(user, require_live_session): reads the token's claims from the same
--     two sources auth.uid() reads, refuses an anonymous session, and (when asked) requires a session id that is
--     still a live row of auth.sessions for this very login -- read after nothing is locked (the caller locks next).
--   * the automatic start (start_kabumori_service, start_x_autopost_service, ensure_my_profile): anonymous refused;
--     NO session-liveness requirement -- the start is idempotent, never restarts an ended service and is the path of
--     every first sign-in, so it must not gain a new dependency on auth.sessions.
--   * the explicit restart (reactivate_kabumori_service, reactivate_x_autopost_service): anonymous refused AND a live
--     session required.
-- Answers are unchanged for every call that passes. A refused call raises ACCOUNT_LIFECYCLE_AUTH_REQUIRED (42501),
-- which both apps already map to "sign in again" (blocked / ACCOUNT_NOT_FOUND). If auth.sessions cannot be read the
-- restart raises ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE (42501): it fails closed, the automatic start is unaffected.
--
-- Rollback: supabase/tests/common_account_enrollment_fence_rollback.sql restores the five functions exactly as
-- Phase 2 / Phase 4 defined them. Nothing here writes to auth, Storage or Vault, calls an external service or
-- changes a release gate.
begin;

do $$
declare
  v_expected constant text[][] := array[
    ['public.start_kabumori_service()',            '30a600abfe27857f78d20e4c9df5bcc7'],
    ['public.start_x_autopost_service()',          '4f55da5271822c4740d19442edbc77d7'],
    ['public.reactivate_kabumori_service(bigint)', '0b6d8652a479a5a5c0ebda766715d268'],
    ['public.reactivate_x_autopost_service(bigint)', '2b0d6763a8cee835d4b2ac6dd179a09d'],
    ['public.ensure_my_profile()',                 '88b041d2f200a73039eb0e2de409ac39']];
  v_i integer;
  v_fn regprocedure;
begin
  -- The chain this builds on.
  if to_regprocedure('private.account_lifecycle_start_service(uuid,text)') is null
     or to_regprocedure('private.account_lifecycle_reactivate_service(uuid,text,bigint)') is null
     or to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)') is null
     or to_regprocedure('public.record_owned_service_deletion_reconciliation(uuid,text,uuid,uuid,text,integer)') is null then
    raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_CHAIN_MISSING';
  end if;
  if to_regprocedure('private.account_lifecycle_enrollment_fence(uuid,boolean)') is not null then
    raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_ALREADY_APPLIED';
  end if;
  -- The five functions are replaced only while they are exactly what Phase 2 / Phase 4 left (a drifted body is
  -- somebody else's change and is never overwritten silently), owned by the migration owner, executable by
  -- `authenticated` and nobody else.
  for v_i in 1 .. array_length(v_expected, 1) loop
    v_fn := to_regprocedure(v_expected[v_i][1]);
    if v_fn is null
       or (select md5(p.prosrc) from pg_proc p where p.oid = v_fn) is distinct from v_expected[v_i][2] then
      raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_DRIFT:%', v_expected[v_i][1];
    end if;
    if (select p.proowner from pg_proc p where p.oid = v_fn) is distinct from (select r.oid from pg_roles r where r.rolname = current_user)
       or not has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or has_function_privilege('anon', v_fn, 'EXECUTE')
       or has_function_privilege('service_role', v_fn, 'EXECUTE')
       or has_function_privilege('public', v_fn, 'EXECUTE') then
      raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_ACL:%', v_expected[v_i][1];
    end if;
  end loop;
  if (select r.rolsuper from pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_OWNER';
  end if;
  -- The session table as GoTrue creates it, readable by this owner (the same fact Phase 3b depends on).
  if to_regclass('auth.sessions') is null
     or (select count(*) from pg_attribute a
          where a.attrelid = to_regclass('auth.sessions') and not a.attisdropped
            and a.attname in ('id', 'user_id', 'not_after')) <> 3
     or not has_table_privilege(current_user, 'auth.sessions', 'SELECT') then
    raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_AUTH_SESSIONS';
  end if;
end;
$$;

-- 1. The internal check ------------------------------------------------------------------------------------------
create function private.account_lifecycle_enrollment_fence(p_user_id uuid, p_require_live_session boolean)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_legacy_sub text := nullif(current_setting('request.jwt.claim.sub', true), '');
  v_claims jsonb;
  v_session text;
  v_anonymous text;
  v_session_id uuid;
  v_live boolean;
begin
  if p_user_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
  -- The claims, from the one source auth.uid() reads first: the per-claim settings of an older PostgREST when
  -- present, else the JSON claims. Never an argument.
  if v_legacy_sub is not null then
    v_session := nullif(current_setting('request.jwt.claim.session_id', true), '');
    v_anonymous := nullif(current_setting('request.jwt.claim.is_anonymous', true), '');
  else
    begin
      v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    exception when others then
      v_claims := null;
    end;
    if jsonb_typeof(v_claims) = 'object' then
      v_session := v_claims ->> 'session_id';
      v_anonymous := v_claims ->> 'is_anonymous';
    end if;
  end if;
  -- A guest session is not an identity of a person.
  if lower(coalesce(v_anonymous, '')) in ('true', 't', '1') then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not p_require_live_session then
    return;
  end if;
  begin
    v_session_id := v_session::uuid;
  exception when others then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end;
  if v_session_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
  -- Read only; GoTrue owns these rows and nothing here locks them. A sign-out or revocation that committed is seen.
  begin
    v_live := exists (select 1 from auth.sessions s
                       where s.id = v_session_id and s.user_id = p_user_id
                         and (s.not_after is null or s.not_after > clock_timestamp()));
  exception when undefined_table or undefined_column or insufficient_privilege then
    raise exception 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE' using errcode = '42501';
  end;
  if not v_live then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.account_lifecycle_enrollment_fence(uuid, boolean) from public, anon, authenticated, service_role;

-- 2. The automatic start: guest sessions refused, no new dependency on auth.sessions -------------------------------
create or replace function public.start_kabumori_service()
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  perform private.account_lifecycle_enrollment_fence(v_user_id, false);
  return private.account_lifecycle_start_service(v_user_id, 'kabumori');
end;
$$;

create or replace function public.start_x_autopost_service()
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  perform private.account_lifecycle_enrollment_fence(v_user_id, false);
  return private.account_lifecycle_start_service(v_user_id, 'x_autopost');
end;
$$;

-- The legacy Kabumori bootstrap (Phase 4's body, one line added after its own authentication check).
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
  perform private.account_lifecycle_enrollment_fence(v_user_id, false);
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

-- 3. The explicit restart: guest sessions refused AND a live session required -----------------------------------
create or replace function public.reactivate_kabumori_service(p_expected_lifecycle_version bigint)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  perform private.account_lifecycle_enrollment_fence(v_user_id, true);
  return private.account_lifecycle_reactivate_service(v_user_id, 'kabumori', p_expected_lifecycle_version);
end;
$$;

create or replace function public.reactivate_x_autopost_service(p_expected_lifecycle_version bigint)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  perform private.account_lifecycle_enrollment_fence(v_user_id, true);
  return private.account_lifecycle_reactivate_service(v_user_id, 'x_autopost', p_expected_lifecycle_version);
end;
$$;

-- 4. Grants: exactly as before (create or replace keeps them; stated again so the file is self-describing) ---------
revoke all on function public.start_kabumori_service() from public, anon, authenticated, service_role;
revoke all on function public.start_x_autopost_service() from public, anon, authenticated, service_role;
revoke all on function public.ensure_my_profile() from public, anon, authenticated, service_role;
revoke all on function public.reactivate_kabumori_service(bigint) from public, anon, authenticated, service_role;
revoke all on function public.reactivate_x_autopost_service(bigint) from public, anon, authenticated, service_role;
grant execute on function public.start_kabumori_service() to authenticated;
grant execute on function public.start_x_autopost_service() to authenticated;
grant execute on function public.ensure_my_profile() to authenticated;
grant execute on function public.reactivate_kabumori_service(bigint) to authenticated;
grant execute on function public.reactivate_x_autopost_service(bigint) to authenticated;

-- Postcondition: definer + empty search_path, `authenticated` only, the internal check reachable by nobody.
do $$
declare
  v_sig text;
  v_role text;
begin
  foreach v_sig in array array[
    'public.start_kabumori_service()', 'public.start_x_autopost_service()', 'public.ensure_my_profile()',
    'public.reactivate_kabumori_service(bigint)', 'public.reactivate_x_autopost_service(bigint)',
    'private.account_lifecycle_enrollment_fence(uuid,boolean)'] loop
    if not (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p where p.oid = to_regprocedure(v_sig)) then
      raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_POSTCONDITION_DEFINER:%', v_sig;
    end if;
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_role, to_regprocedure(v_sig), 'EXECUTE')
         <> (v_role = 'authenticated' and v_sig like 'public.%') then
        raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_POSTCONDITION_EXECUTE:%:%', v_role, v_sig;
      end if;
    end loop;
    if has_function_privilege('public', to_regprocedure(v_sig), 'EXECUTE') then
      raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_POSTCONDITION_PUBLIC:%', v_sig;
    end if;
  end loop;
end;
$$;

commit;
