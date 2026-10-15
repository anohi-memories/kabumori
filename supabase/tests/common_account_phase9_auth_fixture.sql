-- Fake-only additions for the Phase 9 shared sign-in proof (common_account_phase9_shared_login_run.sh). Applied on the
-- lifecycle / write-guard fixtures, BEFORE the chain. Disposable local database only; every value is fake.
--
-- It makes the stand-in `auth` schema carry the two GoTrue constraints the proof reasons about, so that a duplicate
-- sign-up or a second identity for the same provider subject is refused by the database exactly where GoTrue refuses
-- it (this is a MODEL of GoTrue's schema, not GoTrue: managed behaviour is only provable in a managed disposable
-- project, see docs/common-account/phase9-shared-login-enrollment.md section 9):
--   * one login per (lower-cased) e-mail address;
--   * one identity per (provider, provider subject), and one per (login, provider).
set timezone = 'UTC';

alter table auth.identities add column provider_id text;
create unique index auth_identities_provider_subject_key on auth.identities (provider, provider_id) where provider_id is not null;
create unique index auth_users_email_key on auth.users (lower(email)) where email is not null;
alter table auth.users add column if not exists is_anonymous boolean not null default false;
alter table auth.users add column if not exists created_at timestamptz not null default now();
