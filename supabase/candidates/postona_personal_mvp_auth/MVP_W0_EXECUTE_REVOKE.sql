-- G5 SOURCE CANDIDATE (2026-10-30, Issue #320 G5-01 task 51). NOT applied anywhere. The STOP for W0: makes
-- public.postona_ensure_my_personal_workspace() owner-only again, whoever was given it (the G5-49 rule: every non-owner grantee by its quoted
-- name, PUBLIC as the keyword, CASCADE for re-granted chains). Idempotent. Run it as the lifecycle owner (never a superuser) with ON_ERROR_STOP.
-- Workspaces W0 already created stay (the same rows the X OAuth begin RPC creates; R1-MVP answers for them only while it is granted).
-- Production NO_GO.
begin;

set local lock_timeout = '5s';

do $$
declare v_fn regprocedure := pg_catalog.to_regprocedure('public.postona_ensure_my_personal_workspace()');
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'W0_EXEC_REVOKE_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if v_fn is null or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn
                                   and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
                                   and pg_catalog.strpos(p.prosrc, 'W0_POSTCONDITION_NOT_OWN') > 0) then
    raise exception 'W0_EXEC_REVOKE_PRECONDITION_NOT_W0';
  end if;
end $$;

revoke all on function public.postona_ensure_my_personal_workspace() from public, anon, authenticated, service_role cascade;

do $$
declare v_grantee text;
begin
  for v_grantee in select distinct case when x.grantee = 0 then 'public' else pg_catalog.format('%I', r.rolname) end
                     from pg_catalog.pg_proc p cross join pg_catalog.aclexplode(p.proacl) x left join pg_catalog.pg_roles r on r.oid = x.grantee
                    where p.oid = 'public.postona_ensure_my_personal_workspace()'::regprocedure and x.grantee <> p.proowner loop
    execute pg_catalog.format('revoke all on function public.postona_ensure_my_personal_workspace() from %s cascade', v_grantee);
  end loop;
end $$;

do $$
declare v_fn regprocedure := 'public.postona_ensure_my_personal_workspace()'::regprocedure;
begin
  if (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn)
       is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))
     or exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
                 where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')) then
    raise exception 'W0_EXEC_REVOKE_POSTCONDITION_ACL';
  end if;
end $$;

commit;
