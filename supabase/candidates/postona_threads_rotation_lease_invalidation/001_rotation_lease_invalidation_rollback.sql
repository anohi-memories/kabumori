-- Rollback of 001_rotation_lease_invalidation.sql (ISOLATED SOURCE CANDIDATE ONLY, G4-27). Removes the two triggers and
-- the trigger function; no data changes (leases already ended stay ended). Run it BEFORE rolling back the rotation
-- candidate (the trigger function deletes from its lease table). Afterwards the same-now() finding of PR #453 is back.
begin;

set local lock_timeout = '5s';
set local search_path = '';

drop trigger if exists threads_credential_refresh_lease_invalidate_row on public.threads_account_credential_custody;
drop trigger if exists threads_credential_refresh_lease_invalidate_truncate on public.threads_account_credential_custody;
drop function if exists public.threads_credential_refresh_lease_invalidate();

do $$
begin
  if pg_catalog.to_regprocedure('public.threads_credential_refresh_lease_invalidate()') is not null
     or exists (select 1 from pg_catalog.pg_trigger t
                 where t.tgname in ('threads_credential_refresh_lease_invalidate_row', 'threads_credential_refresh_lease_invalidate_truncate')) then
    raise exception 'THREADS_LEASE_INVALIDATION_ROLLBACK_INCOMPLETE';
  end if;
end $$;

commit;
