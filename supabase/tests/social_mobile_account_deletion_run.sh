#!/usr/bin/env bash
# Disposable-only proof runner for the social-mobile account deletion
# candidate. Creates a throwaway database on a LOCAL Unix-socket PostgreSQL
# cluster, applies the production-shaped fixture and the candidate migration
# as a non-superuser owner, runs the behavior proof and a concurrency check,
# then drops the database. Fake data only; never production.
# Usage: DEL_PGHOST=/private/tmp/<socket-dir> DEL_PGPORT=<port> \
#        DEL_PGSUPER=<local superuser> supabase/tests/social_mobile_account_deletion_run.sh
set -euo pipefail

host="${DEL_PGHOST:?DEL_PGHOST (local socket dir) required}"
port="${DEL_PGPORT:?DEL_PGPORT required}"
super="${DEL_PGSUPER:?DEL_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: DEL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_sm_deletion_$$"
owner="kb_sm_deletion_owner"
here="$(cd "$(dirname "$0")" && pwd)"
migration="$here/../migrations/20260928160000_social_mobile_account_deletion_candidate.sql"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
as_owner=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
as_service=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")

tmp="$(mktemp -d /private/tmp/kabumori-sm-deletion.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${as_super[@]}" -d postgres <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then
    create role $owner login nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL

"${as_owner[@]}" -f "$here/social_mobile_account_deletion_fixture.sql"
"${as_owner[@]}" -f "$migration"
if "${as_owner[@]}" -f "$migration" > /dev/null 2>&1; then
  echo "FAIL re-apply was not refused" >&2; exit 1
fi
out="$("${as_owner[@]}" -A -t -f "$here/social_mobile_account_deletion_behavior.sql" 2>&1)" || { echo "$out" >&2; exit 1; }
grep -q SOCIAL_MOBILE_DELETION_BEHAVIOR_PASS <<<"$out" || { echo "FAIL behavior: $out" >&2; exit 1; }
if grep -q 'fake_' <<<"$out"; then echo "FAIL token material in output" >&2; exit 1; fi
echo "SOCIAL_MOBILE_DELETION_BEHAVIOR_PASS"

# Concurrency: two purges for the same user while the first holds its
# transaction open. The advisory lock serializes them: one purges, the other
# finds nothing to purge. Never two partial deletions, never an error.
user="00000000-0000-4000-8000-0000000000aa"
"${as_owner[@]}" -c "select public.fixture_user_with_workspace('$user', 'R')" >/dev/null
"${as_service[@]}" -c "set role service_role; select public.social_mobile_account_deletion_begin('$user')" >/dev/null
"${as_service[@]}" -c "begin; set local role service_role; select public.social_mobile_account_deletion_purge('$user'); select pg_sleep(2); commit;" > "$tmp/one" 2>&1 &
sleep 0.5
"${as_service[@]}" -c "set role service_role; select public.social_mobile_account_deletion_purge('$user');" > "$tmp/two" 2>&1 &
wait
grep -q '"status": "purged"' "$tmp/one" || { echo "FAIL first purge: $(cat "$tmp/one")" >&2; exit 1; }
grep -q '"status": "nothing_to_purge"' "$tmp/two" || { echo "FAIL second purge: $(cat "$tmp/two")" >&2; exit 1; }
left="$("${as_service[@]}" -c "select count(*) from vault.secrets where secret like 'fake_R_%'")"
[[ "$left" == 0 ]] || { echo "FAIL secrets left after race: $left" >&2; exit 1; }
echo "SOCIAL_MOBILE_DELETION_RACE_PASS"

cleanup
trap - EXIT
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname = '$db'")"
[[ "$left" == 0 ]] || { echo "FAIL cleanup left database $db" >&2; exit 1; }
echo "SOCIAL_MOBILE_DELETION_CLEANUP_PASS"
