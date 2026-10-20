-- Rollback of 001_threads_credential_atomic.sql (SOURCE CANDIDATE, G4-11): removes only what 001 created, only when this
-- role owns it. G3 / G4 / G5 objects it reads are untouched.
begin;
set local lock_timeout = '2s';
set local search_path = '';
do $$
begin
  if to_regnamespace('postona_threads_credential') is null then
    raise exception 'THREADS_CREDENTIAL_NOT_APPLIED';
  end if;
  if (select nspowner from pg_catalog.pg_namespace where nspname = 'postona_threads_credential')
     <> (select oid from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'THREADS_CREDENTIAL_ROLLBACK_OWNER';
  end if;
end $$;
drop schema postona_threads_credential cascade;
commit;
