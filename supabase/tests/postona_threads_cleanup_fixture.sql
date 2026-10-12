-- Fake-only, applied by postona_threads_cleanup_run.sh on the G4 publish world after the release fixture.
-- A stand-in of G5's private.account_lifecycle_operations with exactly the columns and CHECKs of
-- 20261001150000_common_account_lifecycle_foundation.sql that the cleanup candidate reads (it is NOT G5's
-- table and carries none of its guards). Disposable local database only.
create table private.account_lifecycle_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  operation_type text not null check (operation_type in ('service_deletion', 'account_deletion')),
  service_key text check (service_key in ('kabumori', 'x_autopost')),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'aborted', 'login_removed')),
  current_step text not null default 'cleanup' check (current_step in ('cleanup', 'ready_for_managed_auth_delete')),
  check ((operation_type = 'service_deletion') = (service_key is not null))
);
revoke all on table private.account_lifecycle_operations from public, anon, authenticated, service_role;
