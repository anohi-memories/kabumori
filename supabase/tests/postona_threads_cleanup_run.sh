#!/usr/bin/env bash
# Disposable-only proof runner for the Threads provider cleanup candidate
# (supabase/candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql).
#
# On a LOCAL Unix-socket PostgreSQL 17 cluster, as a per-run non-superuser owner: the publish-permission
# world (existing fixture + REAL X / deletion migrations + Phase 2a-2), pgcrypto, the release fixture and the
# G4 publish stack (custody -> manual publish -> release), a stand-in of G5's lifecycle operations table
# (postona_threads_cleanup_fixture.sql), then the candidate, and:
#   1. preconditions: refused without the publish stack and without the lifecycle table; re-apply refused;
#   2. a two-session race (F4): the deletion owner's lease ends while the cleanup waits for the workspace
#      lock -> nothing is removed; then postona_threads_cleanup_behavior.sql;
#   3. mutations that remove a safety property must FAIL the proof.
# Fake data only; every database and role it creates is dropped. Never production.
# Usage: THREADS_PGHOST=/private/tmp/<socket-dir> THREADS_PGPORT=<port> THREADS_PGSUPER=<superuser> \
#        supabase/tests/postona_threads_cleanup_run.sh
set -euo pipefail
export LC_ALL=C

host="${THREADS_PGHOST:?THREADS_PGHOST (local socket dir) required}"
port="${THREADS_PGPORT:?THREADS_PGPORT required}"
super="${THREADS_PGSUPER:?THREADS_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: THREADS_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
pub="$here/../candidates/postona_threads_publish"
candidate="$here/../candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql"
psql_bin="${PSQL:-psql}"
n="$$"
owner="kb_threads_cln_owner_$n"
prefix="kabumori_threads_cln_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-threads-cln.XXXXXX)"
fail() { echo "FAIL $*" >&2; exit 1; }
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $owner" > /dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

"${as_super[@]}" -d postgres > /dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb nocreaterole;
grant anon, authenticated, service_role to $owner;
SQL
as_owner() { local db="$1"; shift; "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
create_db() { "${as_super[@]}" -d postgres -c "create database $1 owner $owner${2:+ template $2}" > /dev/null; }
copy() { local db="${prefix}_$1"; create_db "$db" "$2"; echo "$db"; }
apply() {
  local db="$1" file="$2" out
  if out="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$file" 2>&1)"; then echo applied
  else sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1; fi
}

world="${prefix}_world"
create_db "$world"
as_owner "$world" -f "$here/social_mobile_publish_permission_fixture.sql" > /dev/null
for real in 20260919120000_social_mobile_x_oauth_onboarding.sql 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql \
  20260925140000_x_account_credential_refresh_core.sql 20260926032054_x_account_refresh_rollout_authority.sql \
  20260928160000_social_mobile_account_deletion_candidate.sql 20261003090000_social_mobile_publish_permission_boundary.sql; do
  as_owner "$world" -f "$migrations/$real" > /dev/null
done
as_owner "$world" -f "$here/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
as_owner "$world" -f "$migrations/20261007150000_postona_social_accounts_multi_provider.sql" > /dev/null
as_owner "$world" -f "$here/postona_threads_release_fixture.sql" > /dev/null
"${as_super[@]}" -d "$world" -c "create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions" > /dev/null

# 1. Preconditions.
db="$(copy nostack "$world")"
as_owner "$db" -f "$here/postona_threads_cleanup_fixture.sql" > /dev/null
got="$(apply "$db" "$candidate")"; [[ "$got" == THREADS_CLEANUP_PRECONDITION_PUBLISH_STACK ]] || fail "without the publish stack: $got"
stack="${prefix}_stack"
create_db "$stack" "$world"
for f in threads_credential_custody_candidate.sql threads_manual_publish_candidate.sql threads_publish_release_candidate.sql; do
  [[ "$(apply "$stack" "$pub/$f")" == applied ]] || fail "publish stack $f"
done
db="$(copy nolifecycle "$stack")"
got="$(apply "$db" "$candidate")"; [[ "$got" == THREADS_CLEANUP_PRECONDITION_LIFECYCLE ]] || fail "without the lifecycle table: $got"
base="${prefix}_base"
create_db "$base" "$stack"
as_owner "$base" -f "$here/postona_threads_cleanup_fixture.sql" > /dev/null
echo "PASS preconditions (publish stack, lifecycle table)"

# F4 race: the owner's lease runs out WHILE the cleanup waits for the person's workspace lock (held by
# another session for 1.5 s; the lease ends 0.7 s after the call starts). The re-check after the locks
# must remove nothing (LEASE_NOT_HELD).
race_lease() {
  local db="$1" person='00000000-0000-4000-8000-0000000000e1' out holder
  as_owner "$db" -A -t > /dev/null <<SQL
select public.fixture_brand('$person', 'xe');
select postona_rel.login('$person');
insert into postona_rel.lifecycle (user_id, state) values ('$person', 'active');
select postona_rel.connect_threads('$person', public.social_mobile_account_deletion_workspace('$person'), 'e');
SQL
  as_owner "$db" -A -t -c "begin; select public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace('$person')); select pg_sleep(1.5); commit;" > /dev/null &
  holder=$!
  sleep 0.3
  out="$(as_owner "$db" -A -t -c "insert into private.account_lifecycle_operations (user_id, operation_type, status, current_step, owner_lease, owner_lease_expires_at) values ('$person', 'account_deletion', 'in_progress', 'cleanup', gen_random_uuid(), clock_timestamp() + interval '700 milliseconds'); select public.cleanup_threads_provider_footprint('$person')::text;" 2>&1)" || true
  wait "$holder" || true
  [[ "$out" == *'"code": "LEASE_NOT_HELD"'* ]] || { echo "RACE_ANSWER ${out//$'\n'/ }"; return 0; }
  [[ "$(as_owner "$db" -A -t -c "select count(*) from public.social_accounts where id = 'sa_th_e'")" == 1 ]] || { echo "RACE_REMOVED"; return 0; }
  echo PASS
}

prove() {
  local file="$1" tag="$2" db out
  db="$(copy "main_$tag" "$base")"
  [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY"; return 0; }
  [[ "$(apply "$db" "$file")" == THREADS_CLEANUP_PRECONDITION_ALREADY_APPLIED ]] || { echo "REAPPLY"; return 0; }
  out="$(race_lease "$(copy "race_$tag" "$db")")"
  [[ "$out" == PASS ]] || { echo "$out"; return 0; }
  if ! out="$(as_owner "$db" -A -t -f "$here/postona_threads_cleanup_behavior.sql" 2>&1)"; then
    echo "BEHAVIOR $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"; return 0
  fi
  grep -q CLEANUP_BEHAVIOR_OK <<<"$out" || { echo "BEHAVIOR_INCOMPLETE"; return 0; }
  echo PASS
}
result="$(prove "$candidate" real)"
[[ "$result" == PASS ]] || fail "candidate: $result"
echo "PASS candidate: apply, re-apply refused, lease race, behavior"

mutate() {
  local tag="$1" from="$2" to="$3" out="$tmp/mut_$1.sql" got
  FROM="$from" TO="$to" perl -0pe 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$candidate" > "$out"
  cmp -s "$candidate" "$out" && fail "mutation $tag: pattern not found"
  got="$(prove "$out" "$tag")"
  [[ "$got" != PASS ]] || fail "mutation $tag was NOT caught"
  echo "PASS mutation $tag caught (${got:0:120})"
}
mutate no_authority "  if p_user_id is null or not public.threads_cleanup_authorized(p_user_id) then" "  if p_user_id is null then"
mutate no_inflight_check "t.status in ('creating_container', 'publishing', 'publish_returned', 'uncertain')" "t.status in ('creating_container')"
mutate no_shared_secret_check "  if v_secret is not null and exists (
       select 1 from public.social_accounts o" "  if false and exists (
       select 1 from public.social_accounts o"
mutate any_service_deletion "(o.operation_type = 'service_deletion' and o.service_key = 'x_autopost')" "(o.operation_type = 'service_deletion')"
# F4 (lease): an account deletion must hold a live owner lease, by the wall clock, re-checked after the locks.
mutate no_lease_check "(o.operation_type = 'account_deletion' and o.owner_lease is not null
            and o.owner_lease_expires_at > pg_catalog.clock_timestamp())" "(o.operation_type = 'account_deletion')"
mutate lease_by_tx_start "o.owner_lease_expires_at > pg_catalog.clock_timestamp()" "o.owner_lease_expires_at > pg_catalog.now()"
mutate no_recheck_after_locks "  if not public.threads_cleanup_authorized(p_user_id) then
    return pg_catalog.jsonb_build_object('outcome', 'blocked', 'code', 'LEASE_NOT_HELD');" "  if false then
    return pg_catalog.jsonb_build_object('outcome', 'blocked', 'code', 'LEASE_NOT_HELD');"
echo "ALL PASS"
