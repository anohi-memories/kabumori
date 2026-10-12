-- Fake-only, applied by postona_threads_cleanup_run.sh / postona_threads_disconnect_run.sh on the G4 publish
-- world after the release fixture. A stand-in of G5's private.account_lifecycle_operations with exactly the
-- columns and CHECKs of 20261001150000_common_account_lifecycle_foundation.sql and the owner lease of
-- 20261009120000_common_account_deletion_completion.sql (lease shape, owner scope) that the Threads
-- candidates read (it is NOT G5's table and carries none of its guards). Disposable local database only.
create table private.account_lifecycle_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  operation_type text not null check (operation_type in ('service_deletion', 'account_deletion')),
  service_key text check (service_key in ('kabumori', 'x_autopost')),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'aborted', 'login_removed')),
  current_step text not null default 'cleanup' check (current_step in ('cleanup', 'ready_for_managed_auth_delete')),
  owner_lease uuid,
  owner_lease_expires_at timestamptz,
  check ((operation_type = 'service_deletion') = (service_key is not null)),
  constraint account_lifecycle_operations_lease_shape check ((owner_lease is null) = (owner_lease_expires_at is null)),
  constraint account_lifecycle_operations_owner_scope check (operation_type = 'account_deletion' or owner_lease is null)
);
revoke all on table private.account_lifecycle_operations from public, anon, authenticated, service_role;
