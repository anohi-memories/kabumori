#!/usr/bin/env bash
# POSTONA X reservations — live boundary proof with the REAL Postgres driver (jsr:@db/postgres 0.19.5) on a
# disposable LOCAL PostgreSQL only (loopback TCP 127.0.0.1; never a remote project).
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> live_boundary_run.sh
# The cluster must also listen on 127.0.0.1 (the driver test connects over loopback TCP, trust auth, no password).
# MOCK_ONLY: Auth answers and the G5 / G4 predicates are test doubles. Roles are cluster-wide: run alone.
set -euo pipefail

host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
export LC_ALL=C PGTZ=UTC

here="$(cd "$(dirname "$0")" && pwd)"
owner="kb_postona_resv_live_owner"
login="kb_postona_resv_live_login"
db="kabumori_postona_resv_live_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $login" -c "drop role if exists postona_resv_api" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

"${S[@]}" -d postgres -c "drop role if exists $login" -c "drop role if exists postona_resv_api" >/dev/null
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
own -f "$here/test_fixture.sql" >/dev/null
own -f "$here/001_postona_x_reservations.sql" >/dev/null
own -f "$here/002_postona_x_resv_api_role.sql" >/dev/null
# Rollout simulation (test-only): the server-side login role is a member of postona_resv_api, nothing else.
"${S[@]}" -d postgres -c "create role $login login noinherit" -c "grant postona_resv_api to $login" >/dev/null
# MOCK_ONLY G5 / G4 doubles (disposable database only).
own >/dev/null <<'SQL'
create table t.mock_entitlement (user_id uuid primary key, status text not null);
create table t.mock_verified (user_id uuid, social_account_id text, primary key (user_id, social_account_id));
insert into t.mock_entitlement values ('00000000-0000-4000-8000-00000000000a', 'active'), ('00000000-0000-4000-8000-00000000000b', 'active');
insert into t.mock_verified values ('00000000-0000-4000-8000-00000000000a', 'x_a'), ('00000000-0000-4000-8000-00000000000b', 'x_b');
create or replace function postona_x_resv.g5_x_autopost_allowed(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from t.mock_entitlement e where e.user_id = p_user_id and e.status = 'active') $$;
create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from t.mock_verified v where v.user_id = p_user_id and v.social_account_id = p_social_account_id) $$;
SQL

out="$(mktemp /private/tmp/kabumori-postona-resv-live.XXXXXX)"
if ! RESV_LIVE_DB_URL="postgres://$login@127.0.0.1:$port/$db" RESV_LIVE_OWNER_URL="postgres://$owner@127.0.0.1:$port/$db" \
  DENO_NO_PACKAGE_JSON=1 deno test --no-config --no-check --allow-net=127.0.0.1:"$port" --allow-read \
  --allow-env=RESV_LIVE_DB_URL,RESV_LIVE_OWNER_URL "$here/live_boundary/live_boundary_test.ts" >"$out" 2>&1; then
  cat "$out"; rm -f "$out"; fail "live boundary"
fi
grep -E "passed|failed" "$out" | tail -1
rm -f "$out"
echo "POSTONA_RESV_LIVE_BOUNDARY_ALL_PASS"
