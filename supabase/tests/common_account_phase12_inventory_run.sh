#!/usr/bin/env bash
# F5 Phase 12: proves the schema-inventory query on a THROW-AWAY LOCAL database full of planted fake values: structure only,
# valid, secret-free, deterministic, read-only at the engine, side-effect free, sensitive to real changes.
# No production schema, no managed project, no credential. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> bash supabase/tests/common_account_phase12_inventory_run.sh
# Optional: P12_REPO_ROOT (a tree that holds supabase/preflight and supabase/tests; the mutation script points it at a mutant copy).
set -euo pipefail
export LC_ALL=C PGTZ=UTC
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="${P12_REPO_ROOT:-$(git -C "$here" rev-parse --show-toplevel)}"
t="$repo/supabase/tests"; d="$repo/supabase/preflight/managed_disposable"
n="$$"; owner="kb_p12i_owner_$n"; reader="kb_p12i_reader_$n"; db="kabumori_p12i_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists kb_p12i_app" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $reader" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop foreign data wrapper if exists p12_fdw cascade" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb createrole;
grant anon, authenticated, service_role to $owner;
create role $reader login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create database $db owner $owner;
SQL
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
own -f "$t/common_account_phase12_platform_stubs.sql" >/dev/null 2>&1
own -f "$t/common_account_phase12_inventory_world.sql" >/dev/null
"${S[@]}" -d "$db" -v "db=$db" -v "owner=$owner" -f "$t/common_account_phase12_inventory_world_super.sql" >/dev/null

( cd "$repo" && PGHOST="$host" PGPORT="$port" P12_DB="$db" P12_SUPER="$super" P12_OWNER="$owner" P12_READER="$reader" \
    P12_INVENTORY_SQL="$d/inventory/schema_inventory.sql" P12_WORLD_SQL="$t/common_account_phase12_inventory_world.sql" \
    P12_WORLD_SUPER_SQL="$t/common_account_phase12_inventory_world_super.sql" \
    deno run --no-config --no-check --allow-read --allow-write --allow-run=psql --allow-env "$d/inventory_proof.ts" )
