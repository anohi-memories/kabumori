-- G5 SOURCE CANDIDATE (2026-10-29, Issue #320 G5-01 task 48). NOT in supabase/migrations/, NOT applied anywhere. Production NO_GO without the one
-- bundled independent review of the personal MVP profile (M10 + M20 + the stricter P3 + the two verbatim slices + THIS grant), the G5 担当ちゃ's
-- acceptance and the owner's explicit production approval.
--
-- The ONE privilege the personal MVP needs for G6's real path: EXECUTE on R1-MVP public.common_account_authorization_verdict(text, text, text) to
-- authenticated -- the role of G6's G5 transport (PostgREST /rest/v1/rpc, the person's JWT). Nothing else: no other function, schema, table,
-- anon, service_role or PUBLIC. R1-MVP itself answers only about the caller: the subject comes from the request's JWT claims only (D1 strict:
-- sub = auth.uid(), role authenticated, a uuid session_id that is the caller's live row in auth.sessions, is_anonymous exactly false), the
-- workspace must be the caller's derived personal id with S2-3 'own', and anything unexpected is unknown, never allow.
--
-- Run AFTER MVP_INSTALL.sql, as the lifecycle owner (never a superuser), with ON_ERROR_STOP, and only once G6 pins the personal profile
-- (PR #556, G5_R1_PERSONAL_MVP_PROFILE): docs/common-account/g5-48-postona-mvp-r1-authenticated-execute.md. It grants ONLY when:
--   * R1-MVP is EXACTLY the reviewed body: owner = current_user, plpgsql, SECURITY DEFINER, STABLE, returns jsonb, proconfig exactly
--     {search_path="", row_security=off}, md5(prosrc) = the M20 body (postona_personal_mvp_auth_build.py --check re-derives this pin);
--   * its ACL is exactly owner-only (a second run, or any drift, refuses);
--   * it is the only function of that name in public (PostgREST resolves by name and argument names);
--   * the two gates it calls (S2-3, GC) are still owner-only SECURITY DEFINER with search_path '';
--   * anon / service_role / PUBLIC do not inherit authenticated.
-- Postcondition: the ACL is exactly {owner=X/owner, authenticated=X/owner}; anon and service_role cannot execute it.
-- Withdraw: MVP_R1_EXECUTE_REVOKE.sql (idempotent, the emergency stop).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure := pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)');
  v_gate regprocedure;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'R1MVP_EXEC_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if v_fn is null or not exists (
       select 1 from pg_catalog.pg_proc p
        where p.oid = v_fn and p.proowner = v_owner and p.prosecdef and p.provolatile = 's' and not p.proretset
          and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
          and p.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
          and p.proconfig = array['search_path=""', 'row_security=off']
          and pg_catalog.md5(p.prosrc) = '8d8392a3ceee4e157dab73cab6b089a6') then
    raise exception 'R1MVP_EXEC_PRECONDITION_NOT_MVP';
  end if;
  if (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from pg_catalog.format('%s=X/%s', current_user, current_user) then
    raise exception 'R1MVP_EXEC_PRECONDITION_ACL';
  end if;
  if (select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'common_account_authorization_verdict') <> 1 then
    raise exception 'R1MVP_EXEC_PRECONDITION_OVERLOAD';
  end if;
  foreach v_gate in array array['private.postona_personal_workspace_eligibility(uuid)', 'private.account_lifecycle_generation_covered()']::regprocedure[] loop
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_gate and p.proowner = v_owner and p.prosecdef
                     and p.proconfig @> array['search_path=""'] and p.proacl is not null)
       or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) x where p.oid = v_gate and x.grantee <> p.proowner) then
      raise exception 'R1MVP_EXEC_PRECONDITION_DEPENDENCY %', v_gate;
    end if;
  end loop;
  if pg_catalog.to_regrole('authenticated') is null or pg_catalog.to_regrole('anon') is null or pg_catalog.to_regrole('service_role') is null
     or exists (select 1 from pg_catalog.pg_roles a where a.rolname in ('anon', 'service_role')
                   and pg_catalog.pg_has_role(a.oid, 'authenticated', 'MEMBER')) then
    raise exception 'R1MVP_EXEC_PRECONDITION_ROLE_GRAPH';
  end if;
end $$;

grant execute on function public.common_account_authorization_verdict(text, text, text) to authenticated;

do $$
declare v_fn regprocedure := 'public.common_account_authorization_verdict(text,text,text)'::regprocedure;
begin
  if (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn)
       is distinct from pg_catalog.format('%s=X/%s,authenticated=X/%s', current_user, current_user, current_user)
     or not pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE') or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'R1MVP_EXEC_POSTCONDITION_ACL';
  end if;
end $$;

commit;
