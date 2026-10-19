-- TEST TABLES (postona_threads_reservations_run.sh only, disposable DB), applied BEFORE 007: the test-only Threads
-- verification / entitlement lists the doubles read, and the columns of G4's credential custody / refresh lease tables
-- (PR #258/#263 candidate shapes) that 007 reads. Not G4's or G5's implementation.
create schema t_threads;
create table t_threads.verified (social_account_id text primary key);
create table t_threads.entitlement (user_id uuid primary key, status text not null check (status in ('active', 'ended')));
create table public.threads_account_credential_custody (
  social_account_id text primary key references public.social_accounts (id) on delete cascade,
  vault_secret_id uuid not null, expires_at timestamptz not null, recorded_at timestamptz not null default now(), recorded_by uuid not null);
create table public.threads_credential_refresh_leases (
  social_account_id text primary key references public.social_accounts (id) on delete cascade,
  lease_id uuid not null unique, vault_secret_id uuid not null, lease_expires_at timestamptz not null);
revoke all on table public.threads_account_credential_custody, public.threads_credential_refresh_leases from public, anon, authenticated, service_role;
