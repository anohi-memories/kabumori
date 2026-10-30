-- G5 SOURCE CANDIDATE (2026-10-30, Issue #320 G5-01 task 51). NOT applied anywhere. Gives W0 (MVP_W0_INSTALL.sql) to `authenticated` ONLY,
-- the one role a signed-in person's PostgREST request runs as. Run it as the lifecycle owner (never a superuser) with ON_ERROR_STOP after
-- MVP_W0_INSTALL.sql and MVP_RELEASE_PREFLIGHT.sql. One transaction; it refuses unless the function is exactly the reviewed W0 body, owner-only
-- (or already owner + authenticated: idempotent), and the three gates it calls are still owner-only. The stop is MVP_W0_EXECUTE_REVOKE.sql.
-- A NEW authorization boundary (a SECURITY DEFINER writer reachable by every signed-in person): it needs the independent review named in
-- docs/common-account/g5-51-personal-workspace-provisioning.md before any adoption. Production NO_GO.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure := pg_catalog.to_regprocedure('public.postona_ensure_my_personal_workspace()');
  v_acl text;
  v_sig text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'W0_EXEC_GRANT_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if v_fn is null or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = v_owner and p.prosecdef and p.provolatile = 'v'
                                   and p.proconfig = array['search_path=""', 'row_security=off'] and pg_catalog.md5(p.prosrc) = '6ea93e3c13d28b8e7aa7520217642f1b') then
    raise exception 'W0_EXEC_GRANT_PRECONDITION_NOT_W0';
  end if;
  v_acl := (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn);
  if v_acl is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
     and v_acl is distinct from pg_catalog.format('%s=X/%s,authenticated=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user)) then
    raise exception 'W0_EXEC_GRANT_PRECONDITION_ACL %', v_acl;
  end if;
  foreach v_sig in array array['private.postona_personal_session()', 'private.postona_personal_workspace_eligibility(uuid)',
                               'private.account_lifecycle_assert_active_service_write(uuid,text)'] loop
    if pg_catalog.to_regprocedure(v_sig) is null
       or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(v_sig))
            is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user)) then
      raise exception 'W0_EXEC_GRANT_PRECONDITION_GATE %', v_sig;
    end if;
  end loop;
  -- the grant must reach authenticated alone: neither anon nor service_role is a member of it, no API role is a member of the owner
  if exists (select 1 from pg_catalog.pg_roles a where a.rolname in ('anon', 'service_role') and pg_catalog.pg_has_role(a.oid, 'authenticated', 'MEMBER'))
     or exists (select 1 from pg_catalog.pg_roles a where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                 and pg_catalog.pg_has_role(a.oid, v_owner, 'MEMBER')) then
    raise exception 'W0_EXEC_GRANT_PRECONDITION_ROLE_GRAPH';
  end if;
end $$;

grant execute on function public.postona_ensure_my_personal_workspace() to authenticated;

do $$
declare v_fn regprocedure := 'public.postona_ensure_my_personal_workspace()'::regprocedure;
begin
  if (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn)
       is distinct from pg_catalog.format('%s=X/%s,authenticated=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
     or exists (select 1 from pg_catalog.pg_roles a where a.rolname in ('anon', 'service_role') and pg_catalog.has_function_privilege(a.oid, v_fn, 'EXECUTE')) then
    raise exception 'W0_EXEC_GRANT_POSTCONDITION_ACL';
  end if;
end $$;

commit;
