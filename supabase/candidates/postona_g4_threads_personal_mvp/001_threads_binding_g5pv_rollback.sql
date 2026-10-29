-- NOT A MIGRATION. Rollback of 001_threads_binding_g5pv.sql (G4-02 #2, Issue #561). Roll back
-- ../postona_threads_binding_epoch/002_custody_connect_proof.sql first (its writer requires this schema's entry).
-- Refuses unless the personal-profile binding (no owner_epoch column) is the one installed, owned by the caller.
begin;
set local lock_timeout = '2s';
set local search_path = '';
do $$
begin
  if to_regnamespace('postona_threads_binding') is null then
    raise exception 'THREADS_BINDING_NOT_APPLIED';
  end if;
  if (select nspowner from pg_catalog.pg_namespace where nspname = 'postona_threads_binding')
     <> (select oid from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'THREADS_BINDING_ROLLBACK_OWNER';
  end if;
  if to_regprocedure('postona_threads_binding.record_state_generation(uuid,uuid,bigint)') is null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = to_regclass('postona_threads_binding.bindings') and a.attname = 'owner_epoch' and not a.attisdropped) then
    raise exception 'THREADS_BINDING_G5PV_ROLLBACK_NOT_PERSONAL_PROFILE';
  end if;
  -- The CASCADE below may only remove this schema's own objects: refuse while anything outside it depends on them.
  if exists (
    select 1 from pg_catalog.pg_depend d
     where d.refobjid in (select c.oid from pg_catalog.pg_class c where c.relnamespace = to_regnamespace('postona_threads_binding')
                          union all
                          select p.oid from pg_catalog.pg_proc p where p.pronamespace = to_regnamespace('postona_threads_binding')
                          union all
                          select t.oid from pg_catalog.pg_type t where t.typnamespace = to_regnamespace('postona_threads_binding'))
       and d.deptype in ('n', 'a')
       and not exists (select 1 from pg_catalog.pg_class c where c.oid = d.objid and c.relnamespace = to_regnamespace('postona_threads_binding'))
       and not exists (select 1 from pg_catalog.pg_proc p where p.oid = d.objid and p.pronamespace = to_regnamespace('postona_threads_binding'))
       and not exists (select 1 from pg_catalog.pg_type t where t.oid = d.objid and t.typnamespace = to_regnamespace('postona_threads_binding'))
       and not exists (select 1 from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
                        where k.oid = d.objid and c.relnamespace = to_regnamespace('postona_threads_binding'))
       and not exists (select 1 from pg_catalog.pg_attrdef a join pg_catalog.pg_class c on c.oid = a.adrelid
                        where a.oid = d.objid and c.relnamespace = to_regnamespace('postona_threads_binding'))) then
    raise exception 'THREADS_BINDING_G5PV_ROLLBACK_DEPENDENTS';
  end if;
end $$;
drop schema postona_threads_binding cascade;
commit;
