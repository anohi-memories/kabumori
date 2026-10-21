#!/usr/bin/env bash
# G5-14: the four POSTONA base tables (public.brands, public.social_accounts, public.social_account_oauth_states, public.published_content_fingerprints)
# are created by NO migration. Proof on a THROW-AWAY LOCAL PostgreSQL 17: on an EMPTY database (the Supabase API roles and a minimal auth.users / auth.uid()
# stand-in only), each main migration that needs one of them refuses, names what is missing, and leaves nothing behind -- so a db reset or a preview
# branch built from migrations alone cannot get past them. No network, no credential, no managed project; nothing is applied anywhere else. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_base_tables_pg_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="${BT_REPO_ROOT:-$(git -C "$here" rev-parse --show-toplevel)}"
n="$$"; owner="kb_bt_owner_$n"; db="kabumori_bt_${n}_empty"
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
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" >/dev/null <<'SQL'
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
SQL
( cd "$repo" && CAL_E2E=1 BT_MIGRATIONS="$repo/supabase/migrations" PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$here/common_account_base_tables_pg_test.ts" )
