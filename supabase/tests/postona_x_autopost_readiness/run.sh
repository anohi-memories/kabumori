#!/usr/bin/env bash
# POSTONA X autopost Stage 3B readiness -- disposable LOCAL proof only (never a remote project).
#
# Builds the production-shaped Stage 3A + PR81 fixture used by x_account_refresh_pilot_run.sh, then:
#   O1  order: the settings reader (160100) refuses before the completion RPC (160000) exists, and the
#       publish authority (160200) refuses before the reader exists;
#   A1-A3 atomicity: each of the three files, with a failure injected just before its COMMIT, leaves
#       none of its objects behind;
#   then applies the exact three files in order and runs readiness_behavior.sql (R1-R4).
# Usage: READY_PGHOST=/private/tmp/<socket-dir> READY_PGPORT=<port> READY_PGSUPER=<local superuser> run.sh
set -euo pipefail

host="${READY_PGHOST:?READY_PGHOST (local socket dir) required}"
port="${READY_PGPORT:?READY_PGPORT required}"
super="${READY_PGSUPER:?READY_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: READY_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
export LC_ALL=C

here="$(cd "$(dirname "$0")" && pwd)"
tests="$here/.."
migrations="$here/../../migrations"
owner="kb_x_ready_owner"
prefix="kabumori_x_ready_$$"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-x-ready.XXXXXX)"

cleanup() {
  rm -rf "$tmp"
  local db
  for db in $("${as_super[@]}" -A -t -d postgres -c "select datname from pg_database where datname like '${prefix}\_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

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
SQL

# Fresh database with everything the Stage 3B files require (production state on 2026-10-10:
# Stage 3A live, PR81 settings store live, Stage 3B absent).
base_db() {
  local db="${prefix}_$1"
  "${as_super[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
  local own=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
  "${own[@]}" -f "$tests/x_account_refresh_core_fixture.sql" >/dev/null
  "${own[@]}" -f "$tests/x_account_stage3b_base_fixture.sql" >/dev/null
  "${own[@]}" -1 -f "$migrations/20260922045046_social_mobile_content_settings_candidate.sql" \
    -f "$migrations/20261003120000_social_mobile_content_settings_hardening.sql" >/dev/null 2>&1
  "${own[@]}" -f "$migrations/20260925140000_x_account_credential_refresh_core.sql" >/dev/null
  "${own[@]}" -f "$migrations/20260926032054_x_account_refresh_rollout_authority.sql" >/dev/null
  echo "$db"
}
as_owner() { local db="$1"; shift; "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
scalar() { as_owner "$1" -A -t -c "$2"; }

C="$migrations/20261006160000_vault_account_brand_post_completion.sql"
R="$migrations/20261006160100_social_mobile_publish_settings_reader.sql"
P="$migrations/20261006160200_x_account_publish_authority.sql"

# O1: wrong order is refused before anything is created.
db="$(base_db order)"
if as_owner "$db" -f "$R" >"$tmp/o1r" 2>&1; then fail "reader applied before the completion RPC"; fi
grep -q PUBLISH_SETTINGS_READER_PRECONDITION_MISSING "$tmp/o1r" || fail "reader refused for another reason: $(tail -1 "$tmp/o1r")"
if as_owner "$db" -f "$P" >"$tmp/o1p" 2>&1; then fail "authority applied before its prerequisites"; fi
grep -q STAGE3B_PUBLISH_PRECONDITION_MISSING "$tmp/o1p" || fail "authority refused for another reason: $(tail -1 "$tmp/o1p")"
[[ "$(scalar "$db" "select count(*) from pg_proc where proname in ('read_social_mobile_publish_settings','check_x_account_publish_authority','set_x_account_publish_authority')")" == 0 ]] \
  || fail "objects left after refused order"
echo "O1_WRONG_ORDER_REFUSED_PASS"

# A1-A3: a failure just before COMMIT rolls the whole file back.
inject() { perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$1" > "$2"; grep -q '^select 1/0;$' "$2" || fail "could not inject into $1"; }
inject "$C" "$tmp/c_fail.sql"; inject "$R" "$tmp/r_fail.sql"; inject "$P" "$tmp/p_fail.sql"
db="$(base_db atomic)"
if as_owner "$db" -f "$tmp/c_fail.sql" >/dev/null 2>&1; then fail "injected completion did not fail"; fi
[[ "$(scalar "$db" "select to_regprocedure('public.complete_vault_account_brand_post(uuid,text,text,text)') is null")" == t ]] || fail "completion left behind"
echo "A1_COMPLETION_ATOMIC_PASS"
as_owner "$db" -f "$C" >/dev/null
if as_owner "$db" -f "$tmp/r_fail.sql" >/dev/null 2>&1; then fail "injected reader did not fail"; fi
[[ "$(scalar "$db" "select to_regprocedure('public.read_social_mobile_publish_settings(uuid,text)') is null")" == t ]] || fail "reader left behind"
echo "A2_READER_ATOMIC_PASS"
as_owner "$db" -f "$R" >/dev/null
if as_owner "$db" -f "$tmp/p_fail.sql" >/dev/null 2>&1; then fail "injected authority did not fail"; fi
[[ "$(scalar "$db" "select (to_regclass('public.x_account_publish_authority') is null and to_regprocedure('public.check_x_account_publish_authority(uuid,text,text)') is null and to_regprocedure('public.set_x_account_publish_authority(text,text,text,timestamptz,timestamptz)') is null)")" == t ]] \
  || fail "authority objects left behind"
echo "A3_AUTHORITY_ATOMIC_PASS"

# Exact three files in order, then the readiness findings.
as_owner "$db" -f "$P" >/dev/null
as_owner "$db" -f "$here/readiness_behavior.sql" > "$tmp/behavior" 2>&1 || { cat "$tmp/behavior"; fail "readiness behavior"; }
for marker in R1_CONSULT_MEMORY_IS_NOT_CONSENT_PASS R2_BASELINE_ALL_CURRENT_GATES_ALLOWED_PASS \
              R3_GAP_G5_ENTITLEMENT_NOT_ENFORCED_MOCK_ONLY R4_GAP_AUTHORITY_ROW_BLOCKS_ACCOUNT_DELETE READINESS_BEHAVIOR_PASS; do
  grep -q "$marker" "$tmp/behavior" || fail "missing $marker"
  echo "$marker"
done
echo "POSTONA_X_AUTOPOST_READINESS_ALL_PASS"
