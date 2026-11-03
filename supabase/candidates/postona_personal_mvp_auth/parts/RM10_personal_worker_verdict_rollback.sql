-- G5 SOURCE CANDIDATE (2026-10-28, Issue #320 G5-01 task 46). Rollback of M10_personal_worker_verdict.sql: drops MV. Refuses while another
-- function names it (lower-cased source) or the catalog records a dependency on it (a SQL-standard body, a view, a default ...) -- remove the
-- consumers (G3's worker functions) first. Dynamic SQL is not seen: consumers are removed by procedure.
begin;

set local lock_timeout = '5s';

do $$
declare v_fn regprocedure := pg_catalog.to_regprocedure('private.postona_personal_worker_verdict(uuid,text,text,bigint)');
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'MV_ROLLBACK_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if v_fn is null or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn
                                   and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)) then
    raise exception 'MV_ROLLBACK_PRECONDITION_NOT_INSTALLED';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid <> v_fn and pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'postona_personal_worker_verdict') > 0) then
    raise exception 'MV_ROLLBACK_PRECONDITION_CALLERS';
  end if;
  if exists (select 1 from pg_catalog.pg_depend d
              where d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = v_fn and d.deptype in ('n', 'a')) then
    raise exception 'MV_ROLLBACK_PRECONDITION_DEPENDENTS';
  end if;
end $$;

drop function private.postona_personal_worker_verdict(uuid, text, text, bigint);

commit;
