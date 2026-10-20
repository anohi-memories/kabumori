-- TEST TABLES for postona_threads_g4_credential_run.sh only (disposable DB), applied BEFORE 007. Same as test_tables.sql EXCEPT
-- the credential custody table: in this run G4's REAL custody candidate (threads_credential_custody_candidate.sql) owns it.
--   t_threads.verified                       the G4 verified-Threads predicate's TEST DOUBLE list (g4_g5_test_doubles.sql)
--   public.threads_credential_refresh_leases G4's refresh lease shape (PR #258 / #263 candidate) that 007 reads; no G4 writer here
-- Not G4's or G5's implementation.
create schema t_threads;
create table t_threads.verified (social_account_id text primary key);
create table public.threads_credential_refresh_leases (
  social_account_id text primary key references public.social_accounts (id) on delete cascade,
  lease_id uuid not null unique, vault_secret_id uuid not null, lease_expires_at timestamptz not null);
revoke all on table public.threads_credential_refresh_leases from public, anon, authenticated, service_role;
