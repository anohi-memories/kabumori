#!/usr/bin/env bash
# G5-12: the Supabase Data API change of 2026-10-30 against the common-account objects, on a THROW-AWAY LOCAL PostgreSQL 17 with fake data.
# The same world is built TWICE by the same owner role (a stand-in for Supabase's `postgres`):
#   <prefix>_before: default privileges as Supabase gave them before 2026-10-30 -- new tables, sequences and functions in schema public granted
#                    to anon, authenticated and service_role;
#   <prefix>_after:  the 2026-10-30 behaviour -- the table and sequence defaults revoked (functions unchanged, as the changelog documents);
# then the Phase 11 model baseline, the REAL membership migration (20260918120000), the ten F5 chain files, the owner-epoch candidate (PR #303) and
# the three verdict candidates (001 / 002 / 003). No network, no credential, no managed project; nothing is applied anywhere else. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_data_api_grants_pg_run.sh
# Optional: DAPI_REPO_ROOT (a tree with supabase/migrations, supabase/tests and supabase/candidates).
set -euo pipefail
export LC_ALL=C PGTZ=UTC
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="${DAPI_REPO_ROOT:-$(git -C "$here" rev-parse --show-toplevel)}"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"; cand="$repo/supabase/candidates/common_account_authorization_verdict"
n="$$"; owner="kb_dapi_owner_$n"; prefix="kabumori_dapi_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_svc_child') then create role kb_cal_svc_child nologin inherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_auth_child') then create role kb_cal_auth_child nologin inherit; end if;
end \$\$;
grant service_role to kb_cal_svc_child;
grant authenticated to kb_cal_auth_child;
create role $owner login nosuperuser nocreatedb createrole;
grant anon, authenticated, service_role, kb_cal_svc_child, kb_cal_auth_child to $owner;
create database ${prefix}_before owner $owner;
create database ${prefix}_after owner $owner;
SQL

build() {
  local db="$1" mode="$2"
  own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
  # Supabase's defaults for the creating role in schema public, BEFORE the world is built (they apply to objects created afterwards)
  own -c "alter default privileges in schema public grant all on functions to anon, authenticated, service_role" >/dev/null
  if [[ "$mode" == before ]]; then
    own -c "alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
            alter default privileges in schema public grant all on sequences to anon, authenticated, service_role" >/dev/null
  fi
  own -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
  # The fixture (the pre-existing base) itself sets the OLD table defaults. The 2026-10-30 change happens here, before anything the G5 chain
  # creates: in the `after` world the table and sequence defaults are revoked from the API roles (the changelog's four statements, for this role).
  if [[ "$mode" == after ]]; then
    own -c "alter default privileges in schema public revoke all on tables from anon, authenticated, service_role;
            alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role" >/dev/null
  fi
  own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
  for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do own -f "$m/$f" >/dev/null; done
  own -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
  own -f "$t/common_account_phase9_auth_fixture.sql" >/dev/null
  own -c "create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz not null default now(), not_after timestamptz)" >/dev/null
  own -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
  for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion \
           20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state \
           20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts \
           20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record; do
    own -f "$m/$f.sql" >/dev/null
  done
  # TEST-WORLD stand-in for F3 / G3's revoke on public.brand_memberships (the owner-epoch candidate requires it), as every G5 runner does; with the
  # "before" defaults the table was also granted TRUNCATE / REFERENCES / TRIGGER to service_role, which this revokes too
  own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated, service_role" >/dev/null
  own -f "$repo/supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql" >/dev/null
  own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
  own -f "$cand/001_authorization_verdict.sql" >/dev/null
  own -f "$cand/002_bootstrap_verdict.sql" >/dev/null
  own -f "$cand/003_session_verdict.sql" >/dev/null
}
build "${prefix}_before" before
build "${prefix}_after" after

( cd "$repo" && CAL_E2E=1 DAPI_BEFORE="${prefix}_before" DAPI_AFTER="${prefix}_after" DAPI_AUDIT="$t/common_account_data_api_grants_audit.sql" PGSUPER="$super" \
    PGHOST="$host" PGPORT="$port" PGUSER="$owner" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$t/common_account_data_api_grants_pg_test.ts" )
