#!/usr/bin/env bash
# POSTONA X reservations — API end-to-end proof on a disposable LOCAL PostgreSQL only. Never a remote project.
#   app client (remote-reservation-store.ts) -> API handler (api.ts) -> postona_resv_api role -> SQL candidate.
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> api_e2e_run.sh
# MOCK_ONLY: the access-token verifier and the G5 / G4 decisions are test doubles here. This proves the wiring,
# the read-back rules and the database refusals -- NOT that the real Auth / G5 / G4 boundary is secure.
# Roles are cluster-wide: run this alone (not in parallel with another runner on the same cluster).
set -euo pipefail

host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
export LC_ALL=C PGTZ=UTC

here="$(cd "$(dirname "$0")" && pwd)"
api_sql="${RESV_API_CANDIDATE:-$here/002_postona_x_resv_api_role.sql}"
owner="kb_postona_resv_api_owner"
login="kb_postona_resv_api_login"
db="kabumori_postona_resv_api_$$"
as_super=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-resv-api.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  "${as_super[@]}" -d postgres -c "drop role if exists $login" >/dev/null 2>&1 || true
  "${as_super[@]}" -d postgres -c "drop role if exists postona_resv_api" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

"${as_super[@]}" -d postgres -c "drop role if exists $login" -c "drop role if exists postona_resv_api" >/dev/null
"${as_super[@]}" -d postgres >/dev/null <<SQL
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

# P0: 002 refuses a re-apply and rolls back completely on failure.
perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$api_sql" > "$tmp/fail.sql"
if own -f "$tmp/fail.sql" >/dev/null 2>&1; then fail "injected failure applied"; fi
[[ "$(own -A -t -c "select to_regrole('postona_resv_api') is null and to_regprocedure('postona_x_resv.get_reservation(uuid)') is null")" == t ]] || fail "partial 002 left behind"
own -f "$api_sql" >/dev/null
if own -f "$api_sql" >"$tmp/re" 2>&1; then fail "002 re-apply accepted"; fi
grep -q POSTONA_RESV_API_ALREADY_APPLIED "$tmp/re" || fail "002 re-apply refused for another reason: $(tail -1 "$tmp/re")"
echo "P0_API_ROLE_APPLY_ROLLBACK_PASS"

# Rollout simulation (NOT part of the candidate): a server-side login role becomes a member of postona_resv_api.
"${as_super[@]}" -d postgres -c "create role $login login noinherit" -c "grant postona_resv_api to $login" >/dev/null

# P1: what the API role can and cannot do; the API roles still reach nothing.
asapi() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$login" -d "$db" "$@"; }
if asapi -c "select count(*) from postona_x_resv.reservations" >"$tmp/p" 2>&1; then fail "login role read a table without the API role"; fi
for probe in "select count(*) from postona_x_resv.reservations" "select count(*) from postona_x_resv.batches" \
             "select * from postona_x_resv.claim_due('w', 60, 1)" "select postona_x_resv.pre_publish_check(gen_random_uuid(), gen_random_uuid())" \
             "select postona_x_resv.finish(gen_random_uuid(), gen_random_uuid(), 'uncertain', null, null)" \
             "select postona_x_resv.assert_account_access(gen_random_uuid(), 'x_a')" "update postona_x_resv.reservations set status = 'published'"; do
  if asapi -c "begin; set local role postona_resv_api; $probe; commit;" >"$tmp/p" 2>&1; then fail "API role ran: $probe"; fi
  grep -q "permission denied" "$tmp/p" || fail "API role probe failed for another reason: $probe :: $(tail -1 "$tmp/p")"
done
for role in anon authenticated service_role; do
  if own -c "set role $role; select * from postona_x_resv.get_reservation(gen_random_uuid())" >"$tmp/p" 2>&1; then fail "$role executed get"; fi
  grep -q "permission denied" "$tmp/p" || fail "$role: unexpected $(tail -1 "$tmp/p")"
done
echo "P1_API_ROLE_LEAST_PRIVILEGE_PASS"

# MOCK_ONLY: G5 / G4 test doubles (fake tables) replace the shipped DENY predicates in this disposable database.
own >/dev/null <<'SQL'
create table t.mock_entitlement (user_id uuid primary key, status text not null);
create table t.mock_verified (user_id uuid, social_account_id text, primary key (user_id, social_account_id));
insert into t.mock_entitlement values ('00000000-0000-4000-8000-00000000000a', 'active'), ('00000000-0000-4000-8000-00000000000b', 'active'),
  ('00000000-0000-4000-8000-00000000000c', 'active');
insert into t.mock_verified values ('00000000-0000-4000-8000-00000000000a', 'x_a'), ('00000000-0000-4000-8000-00000000000a', 'x_a2'),
  ('00000000-0000-4000-8000-00000000000a', 'th_a'), ('00000000-0000-4000-8000-00000000000b', 'x_b'),
  ('00000000-0000-4000-8000-00000000000a', 'x_kabu');
create or replace function postona_x_resv.g5_x_autopost_allowed(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from t.mock_entitlement e where e.user_id = p_user_id and e.status = 'active') $$;
create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from t.mock_verified v where v.user_id = p_user_id and v.social_account_id = p_social_account_id) $$;
SQL

# E1: the app client against the real handler and the real database.
RESV_E2E_HOST="$host" RESV_E2E_PORT="$port" RESV_E2E_DB="$db" RESV_E2E_LOGIN="$login" RESV_E2E_OWNER="$owner" \
  node --test "$here/api_e2e/api_e2e.test.mjs" > "$tmp/e2e" 2>&1 || { cat "$tmp/e2e"; fail "e2e"; }
grep -E "^ℹ (tests|pass|fail)" "$tmp/e2e" | tr '\n' ' '; echo
grep -q "^ℹ fail 0" "$tmp/e2e" || { cat "$tmp/e2e"; fail "e2e failures"; }
echo "E1_APP_API_DB_END_TO_END_PASS"
echo "POSTONA_RESV_API_E2E_ALL_PASS"
