#!/usr/bin/env bash
# Disposable-only Phase1H proof runner. Creates a throwaway database on a LOCAL
# Unix-socket PostgreSQL cluster, applies Phase1D/1E/1F/1G fixtures ->
# Phase1B -> 1D -> 1E -> 1F -> 1G -> 1H as a non-superuser owner, runs the
# Phase1H behavior proof, then drops the database.
# Fake data only; never production.
# Usage: PHASE1H_PGHOST=/private/tmp/<socket-dir> PHASE1H_PGPORT=<port> \
#        PHASE1H_PGSUPER=<local superuser> supabase/tests/x_autopost_phase1h_run.sh
set -euo pipefail

host="${PHASE1H_PGHOST:?PHASE1H_PGHOST (local socket dir) required}"
port="${PHASE1H_PGPORT:?PHASE1H_PGPORT required}"
super="${PHASE1H_PGSUPER:?PHASE1H_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: PHASE1H_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_phase1h_$$"
owner="kb_phase1h_owner"
here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
as_owner=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")

cleanup() {
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

"${as_owner[@]}" -f "$here/x_autopost_phase1d_fixture.sql"
"${as_owner[@]}" -f "$here/x_autopost_phase1e_fixture.sql"
"${as_owner[@]}" -f "$here/x_autopost_phase1f_fixture.sql"
"${as_owner[@]}" -f "$here/x_autopost_phase1g_fixture.sql"
"${as_owner[@]}" -f "$migrations/20260924023133_x_autopost_phase1b_account_bound_queue.sql"
"${as_owner[@]}" -f "$migrations/20260924160000_x_autopost_phase1d_claim_domain_partition.sql"
"${as_owner[@]}" -f "$migrations/20260924170000_x_autopost_phase1e_claim_bound_credential_reader.sql"
"${as_owner[@]}" -f "$migrations/20260924180000_x_autopost_phase1f_atomic_completion.sql"
"${as_owner[@]}" -f "$migrations/20260925090000_x_autopost_phase1g_multistep_completion.sql"
"${as_owner[@]}" -f "$migrations/20260925120000_x_autopost_phase1h_dispatch_resume.sql"
"${as_owner[@]}" -f "$here/x_autopost_phase1h_behavior.sql"


cleanup
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname = '$db'")"
[[ "$left" == 0 ]] || { echo "FAIL cleanup left database $db" >&2; exit 1; }
echo "PHASE1H_CLEANUP_PASS"
