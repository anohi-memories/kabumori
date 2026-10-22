#!/usr/bin/env bash
# G5-20: the owner-epoch candidate's widened exposure check (column / system-column ACLs of public.brand_memberships, and every privilege on the
# epoch history), proven on a THROW-AWAY LOCAL PostgreSQL 17 with fake data. Two databases from the REAL membership migration (20260918120000):
# "main" with the candidate installed, "fresh" for the install-time refusals (preconditions, global / schema default privileges). The TEST-WORLD
# revoke of TRIGGER / TRUNCATE / REFERENCES stands in for G3's dependency (L-1), exactly as in common_account_owner_epoch_run.sh. No network, no
# credential, no managed project; nothing is applied anywhere else; no G3 / G4 / G6 file is read or changed. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_owner_epoch_acl_pg_run.sh
# Optional: OA_REPO_ROOT (a tree with supabase/migrations, supabase/tests and supabase/candidates; the mutation script points it at a mutant copy).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="${OA_REPO_ROOT:-$(cd "$here/../.." && pwd)}"
cand="$repo/supabase/candidates/common_account_brand_owner_epoch"
n="$$"; owner="kb_oa_owner_$n"; prefix="kabumori_oa_$n"
# mid / mid2: roles an API role will be made a member of during the tests; admin: never reached; child: a MEMBER OF authenticated (not reached)
mid="kb_oa_mid_$n"; mid2="kb_oa_mid2_$n"; admin="kb_oa_admin_$n"; child="kb_oa_child_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d r
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  for r in "$mid2" "$mid" "$admin" "$child" "$owner"; do
    "${S[@]}" -d postgres -c "drop role if exists $r" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb;
grant anon, authenticated, service_role to $owner;
create role $mid nologin; create role $mid2 nologin; create role $admin nologin; create role $child nologin;
grant authenticated to $child;
create database ${prefix}_main owner $owner;
create database ${prefix}_fresh owner $owner;
SQL
for w in main fresh; do
  own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_$w" "$@"; }
  own -f "$here/social_mobile_account_deletion_fixture.sql" >/dev/null
  own -c "create schema if not exists private; grant usage on schema private to anon, authenticated, service_role" >/dev/null
  own -c "alter default privileges in schema private grant all on tables to anon, authenticated, service_role" >/dev/null
  # the REAL migration's table and ACL (the fixture's stand-in table is replaced)
  own -c "drop table public.brand_memberships" >/dev/null
  own -f "$repo/supabase/migrations/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
  # TEST-WORLD stand-in for G3's L-1 dependency (the same statement as common_account_owner_epoch_run.sh)
  own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
  "${S[@]}" -d "${prefix}_$w" -c "grant usage on schema private to $mid; create schema att authorization $mid" >/dev/null
done
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_main" -f "$cand/001_brand_owner_epoch.sql" >/dev/null
( cd "$repo" && CAL_E2E=1 OA_CANDIDATE="$cand/001_brand_owner_epoch.sql" OA_ROLLBACK="$cand/001_brand_owner_epoch_rollback.sql" PGSUPER="$super" \
    OA_OWNER="$owner" OA_MID="$mid" OA_MID2="$mid2" OA_ADMIN="$admin" OA_CHILD="$child" OA_DB_MAIN="${prefix}_main" OA_DB_FRESH="${prefix}_fresh" \
    PGHOST="$host" PGPORT="$port" PGUSER="$owner" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$here/common_account_owner_epoch_acl_pg_test.ts" )
