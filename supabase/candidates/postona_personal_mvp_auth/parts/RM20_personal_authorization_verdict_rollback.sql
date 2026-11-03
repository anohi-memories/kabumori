-- G5 SOURCE CANDIDATE (2026-10-28, Issue #320 G5-01 task 47). Rollback of M20_personal_authorization_verdict.sql: drops R1-MVP. Refuses unless it
-- is the MVP body (it never drops the full profile's reviewed R1) and while another function names it (lower-cased source) or the catalog records
-- a dependency on it. Callers outside the database (G6's transport) are removed by procedure first.
begin;

set local lock_timeout = '5s';

do $$
declare v_fn regprocedure := pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)');
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'R1MVP_ROLLBACK_PRECONDITION_OWNER_IS_SUPERUSER';
  end if;
  if v_fn is null or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn
                                   and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
                                   and pg_catalog.strpos(p.prosrc, '''g5pv:'' || f_lifecycle::text') > 0) then
    raise exception 'R1MVP_ROLLBACK_PRECONDITION_NOT_MVP';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid <> v_fn and pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'common_account_authorization_verdict') > 0) then
    raise exception 'R1MVP_ROLLBACK_PRECONDITION_CALLERS';
  end if;
  if exists (select 1 from pg_catalog.pg_depend d
              where d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = v_fn and d.deptype in ('n', 'a')) then
    raise exception 'R1MVP_ROLLBACK_PRECONDITION_DEPENDENTS';
  end if;
end $$;

drop function public.common_account_authorization_verdict(text, text, text);

commit;
