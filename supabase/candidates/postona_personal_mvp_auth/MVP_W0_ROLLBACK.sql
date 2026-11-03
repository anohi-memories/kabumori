-- G5 SOURCE CANDIDATE (2026-10-30, Issue #320 G5-01 task 51). NOT applied anywhere. Removes W0 (MVP_W0_INSTALL.sql). Run it as the lifecycle
-- owner (never a superuser) with ON_ERROR_STOP, AFTER MVP_W0_EXECUTE_REVOKE.sql and BEFORE MVP_ROLLBACK.sql (which refuses while W0 exists).
-- It refuses while W0 is granted to anyone, while another function's body names it, or while anything depends on it. Rows W0 created stay:
-- they are the begin RPC's shape and belong to the person (the deletion saga removes them with the account). Production NO_GO.
begin;

set local lock_timeout = '5s';

do $$
declare v_fn regprocedure := pg_catalog.to_regprocedure('public.postona_ensure_my_personal_workspace()');
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'W0_ROLLBACK_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if v_fn is null or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn
                                   and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
                                   and pg_catalog.strpos(p.prosrc, 'W0_POSTCONDITION_NOT_OWN') > 0) then
    raise exception 'W0_ROLLBACK_PRECONDITION_NOT_W0';
  end if;
  if (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn)
       is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user)) then
    raise exception 'W0_ROLLBACK_PRECONDITION_GRANTED';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid <> v_fn and pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'postona_ensure_my_personal_workspace') > 0) then
    raise exception 'W0_ROLLBACK_PRECONDITION_CALLERS';
  end if;
  if exists (select 1 from pg_catalog.pg_depend d where d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = v_fn and d.deptype in ('n', 'a')) then
    raise exception 'W0_ROLLBACK_PRECONDITION_DEPENDENTS';
  end if;
end $$;

drop function public.postona_ensure_my_personal_workspace();

do $$
begin
  if pg_catalog.to_regprocedure('public.postona_ensure_my_personal_workspace()') is not null then
    raise exception 'W0_ROLLBACK_POSTCONDITION';
  end if;
end $$;

commit;
