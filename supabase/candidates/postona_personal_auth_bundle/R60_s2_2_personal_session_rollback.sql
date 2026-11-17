-- Rollback of 004_s2_2_personal_session.sql (G5-34, S2-2): drops private.postona_personal_session(). It refuses unless the function is exactly
-- the installed one (body, owner, attributes, owner-only ACL; another body or shape is someone else's change and is left alone), and while the
-- body of any other function names it (a consumer still calls it: remove the consumer first; PL/pgSQL calls are not tracked as dependencies).
-- Nothing else is touched: SV, R0, R1, T13, W1 and the S2-3 predicate stay. It writes no row.
--
-- G5-38 REVISION (2026-10-26, Issue #320 task 38): the callers check compares in LOWER CASE (an unquoted name may be written in any case; the
-- G5-34 check missed an upper-case caller), and a recorded dependency (a view, a SQL-standard BEGIN ATOMIC body ...) is refused by name with
-- S22_ROLLBACK_PRECONDITION_DEPENDENTS before PostgreSQL's DROP ... RESTRICT would stop it -- the same fence as the S2-3 rollback (G5-37).
-- What it CANNOT see: a name assembled at run time (dynamic SQL), a caller in another database or outside the database (Edge / app); a comment
-- that names the gate counts as a caller (a fail-closed false positive). It is a fence for the reachable cases, not a complete call graph.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure := pg_catalog.to_regprocedure('private.postona_personal_session()');
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'S22_ROLLBACK_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if v_fn is null then
    raise exception 'S22_ROLLBACK_NOT_APPLIED';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'a5d4d71c532847a8573e86a4bd0c791d' then
    raise exception 'S22_ROLLBACK_PRECONDITION_BODY';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""', 'row_security=off']
                and not p.proisstrict and not p.proleakproof and p.proparallel = 'u' and p.prokind = 'f' and not p.proretset
                and p.procost = 100 and p.prorows = 0 and p.prosupport::oid = 0 and p.prorettype = 'text'::pg_catalog.regtype
                and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
                and p.pronargs = 0 and p.pronargdefaults = 0 and p.proargmodes is null and p.protrftypes is null and p.proargnames is null
           from pg_catalog.pg_proc p where p.oid = v_fn) is not true
     or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = v_fn)
          is distinct from pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user)) then
    raise exception 'S22_ROLLBACK_PRECONDITION_SHAPE';
  end if;
  -- no API role reaches it: neither a MEMBER (direct or indirect, INHERIT or not) of a role that may EXECUTE it, nor of the owner
  if exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
              where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and (pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE') or r.oid = v_owner)) then
    raise exception 'S22_ROLLBACK_PRECONDITION_API_ROLE_REACHES';
  end if;
  -- and no other non-superuser role may EXECUTE it
  if exists (select 1 from pg_catalog.pg_roles r
              where not r.rolsuper and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE') and not pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE')) then
    raise exception 'S22_ROLLBACK_PRECONDITION_OTHER_ROLE_EXECUTES';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid <> v_fn and pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'postona_personal_session') > 0) then
    raise exception 'S22_ROLLBACK_PRECONDITION_CALLERS';
  end if;
  if exists (select 1 from pg_catalog.pg_depend d where d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = v_fn) then
    raise exception 'S22_ROLLBACK_PRECONDITION_DEPENDENTS';
  end if;
end $$;

drop function private.postona_personal_session();

do $$
begin
  if pg_catalog.to_regprocedure('private.postona_personal_session()') is not null then
    raise exception 'S22_ROLLBACK_POSTCONDITION_LEFT';
  end if;
end $$;

commit;
