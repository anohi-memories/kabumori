#!/usr/bin/env bash
# G5-16: D-2 of docs/security/supabase-data-api-explicit-grants-20261030.md (section 14) on a THROW-AWAY LOCAL PostgreSQL 17: the table / column ACL
# precondition of G4's 20261007150000 (taken VERBATIM from the migration text by the test) against three ACL layouts of a stand-in
# public.social_accounts with the contract's 14 columns -- the contract's table-level SELECT, G4's column-level proposal (no Vault references), and
# the R-7-violating layout the contract allows -- plus what each layout lets `authenticated` read, including the app's real select lists. No network,
# no credential, no managed project; nothing is applied anywhere else; no G4 file is changed. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_d2_column_acl_pg_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="${D2_REPO_ROOT:-$(git -C "$here" rev-parse --show-toplevel)}"
n="$$"; owner="kb_d2_owner_$n"; db="kabumori_d2_${n}"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
}
trap cleanup EXIT
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL
( cd "$repo" && CAL_E2E=1 D2_REPO="$repo" PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$here/common_account_d2_column_acl_pg_test.ts" )
