-- Rollback of 001_threads_binding_epoch.sql (SOURCE CANDIDATE, G4-09). Removes only what 001 created, and only when this
-- role owns it; PR #124, F5 and G5 objects are untouched.
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
end $$;
drop schema postona_threads_binding cascade;
commit;
