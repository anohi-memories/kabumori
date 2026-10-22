#!/usr/bin/env bash
# G5-17: G4's owner-transport question (Issue #320 comment 6329602523) on a THROW-AWAY LOCAL PostgreSQL 17 with fake data: can an owner-only
# transport (connected as the owner role, READ COMMITTED, the verified person's claims set transaction-locally, no API role) call G5's R0, the T13
# service-write guard and R1 inside the begin transaction, get the owner epoch / lifecycle_version pair, keep it stable to COMMIT, and roll everything
# back on a refusal? World: the Phase 11 model baseline, the REAL membership migration (20260918120000), the ten F5 chain files (T13 = P3b's
# private.account_lifecycle_assert_active_service_write), the owner-epoch candidate (PR #303), 001 (R1 / W1 / W2), 002 (R0), 003. main's X begin
# RPC stands in for the Threads begin (PR #124 is not in this tree). No network, no credential, no managed project. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_owner_transport_pg_run.sh
# Optional: OT_REPO_ROOT.
set -euo pipefail
export LC_ALL=C PGTZ=UTC
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="${OT_REPO_ROOT:-$(git -C "$here" rev-parse --show-toplevel)}"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"
n="$$"; owner="kb_ot_owner_$n"; other="kb_ot_other_$n"; api="kb_ot_api_$n"; prefix="kabumori_ot_$n"; db="${prefix}_main"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $other" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $api" >/dev/null 2>&1 || true
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
-- a second table owner for the hostile-RLS layouts, and the TEST consumer's API role (a stand-in for G3's postona_resv_api); neither logs in
create role $other nologin;
create role $api nologin;
grant $api to $owner with inherit false, set true;
grant anon, authenticated, service_role, kb_cal_svc_child, kb_cal_auth_child to $owner;
create database $db owner $owner;
SQL
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
# the Phase 11 model baseline (the recipe of the Phase 13 prerequisite oracle) ...
own -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do own -f "$m/$f" >/dev/null; done
own -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
own -f "$t/common_account_phase9_auth_fixture.sql" >/dev/null
own -c "create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz not null default now(), not_after timestamptz)" >/dev/null
own -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
# ... the ten chain files in release order ...
for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion \
         20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state \
         20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts \
         20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record; do
  own -f "$m/$f.sql" >/dev/null
done
# ... and the owner-epoch candidate. Its install refuses while an API role keeps TRIGGER / TRUNCATE / REFERENCES on public.brand_memberships; taking
# them away is F3 / G3's (the table's migration), so this TEST-WORLD revoke stands in for that dependency (as in common_account_owner_epoch_run.sh).
own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
own -f "$repo/supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql" >/dev/null
# [A] TEST-WORLD auth.uid(): the model fixture reads only the per-claim setting; the managed definition (as Supabase publishes it) reads the per-claim
# setting, else request.jwt.claims ->> 'sub'. Replaced here so the JSON-claims path can be exercised; managed behaviour stays NOT_VERIFIED.
own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
cand="$repo/supabase/candidates/common_account_authorization_verdict"
own -f "$cand/001_authorization_verdict.sql" >/dev/null
own -f "$cand/002_bootstrap_verdict.sql" >/dev/null
own -f "$cand/003_session_verdict.sql" >/dev/null

( cd "$repo" && CAL_E2E=1 PGSUPER="$super" OT_OTHER="$other" PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$t/common_account_owner_transport_pg_test.ts" )
