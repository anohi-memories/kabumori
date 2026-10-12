#!/usr/bin/env bash
# Disposable-only proof runner for the Threads disconnect candidate
# (supabase/candidates/postona_threads_disconnect/threads_disconnect_candidate.sql, F4).
#
# On a LOCAL Unix-socket PostgreSQL 17 cluster, as a per-run non-superuser owner: the same world as
# postona_threads_cleanup_run.sh (publish-permission fixture + REAL X / deletion migrations + Phase 2a-2,
# pgcrypto, release fixture, G4 publish stack, the stand-in of G5's lifecycle table) plus the Threads
# cleanup candidate, then the disconnect candidate, and:
#   1. preconditions: refused without the publish stack and without the lifecycle table; re-apply refused;
#   2. two-session races: (a) a publish step commits while the disconnect waits for the account row ->
#      the disconnect sees it and keeps the credential; (b) the account row stays locked past lock_timeout
#      -> BUSY and nothing changed (not even the permission);
#   3. postona_threads_disconnect_behavior.sql;
#   4. mutations that remove a safety property must FAIL the proof.
# Fake data only; every database and role it creates is dropped. Never production.
# Usage: THREADS_PGHOST=/private/tmp/<socket-dir> THREADS_PGPORT=<port> THREADS_PGSUPER=<superuser> \
#        supabase/tests/postona_threads_disconnect_run.sh
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
cleanup_candidate="$here/../candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql"
candidate="$here/../candidates/postona_threads_disconnect/threads_disconnect_candidate.sql"
psql_bin="${PSQL:-psql}"
n="$$"
owner="kb_threads_dsc_owner_$n"
prefix="kabumori_threads_dsc_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-threads-dsc.XXXXXX)"
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
got="$(apply "$db" "$candidate")"; [[ "$got" == THREADS_DISCONNECT_PRECONDITION_PUBLISH_STACK ]] || fail "without the publish stack: $got"
stack="${prefix}_stack"
create_db "$stack" "$world"
for f in threads_credential_custody_candidate.sql threads_manual_publish_candidate.sql threads_publish_release_candidate.sql; do
  [[ "$(apply "$stack" "$pub/$f")" == applied ]] || fail "publish stack $f"
done
db="$(copy nolifecycle "$stack")"
got="$(apply "$db" "$candidate")"; [[ "$got" == THREADS_DISCONNECT_PRECONDITION_LIFECYCLE ]] || fail "without the lifecycle table: $got"
base="${prefix}_base"
create_db "$base" "$stack"
as_owner "$base" -f "$here/postona_threads_cleanup_fixture.sql" > /dev/null
[[ "$(apply "$base" "$cleanup_candidate")" == applied ]] || fail "cleanup candidate"
echo "PASS preconditions (publish stack, lifecycle table)"

person='00000000-0000-4000-8000-0000000000e1'
setup_person() {
  as_owner "$1" -A -t > /dev/null <<SQL
create or replace function public.threads_disconnect_gate_open() returns boolean language sql immutable set search_path = '' as \$\$ select true \$\$;
select public.fixture_brand('$person', 'xe');
select postona_rel.login('$person');
insert into postona_rel.lifecycle (user_id, state) values ('$person', 'active');
select postona_rel.connect_threads('$person', public.social_mobile_account_deletion_workspace('$person'), 'erin');
select postona_rel.as_user('$person', 'permission', 'sa_th_erin', 'true', 'false');
select postona_rel.as_user('$person', 'begin', 'sa_th_erin', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'race');
SQL
}
disconnect_sql="begin; select postona_rel.act('$person'); set local role authenticated; select 'ANSWER ' || public.disconnect_threads_account('sa_th_erin', 'erin')::text; commit;"

# 2a. A publish step (holding the account FOR SHARE, as release does) commits creating_container while the
#     disconnect waits for the account row: the disconnect must see it and keep the credential.
race_inflight() {
  local db="$1" out holder
  setup_person "$db"
  as_owner "$db" -A -t -c "begin; select 1 from public.social_accounts where id = 'sa_th_erin' for share; update public.threads_manual_publish_attempts set status = 'creating_container', updated_at = now() where social_account_id = 'sa_th_erin'; select pg_sleep(1.5); commit;" > /dev/null &
  holder=$!
  sleep 0.3
  out="$(as_owner "$db" -A -t -c "$disconnect_sql" 2>&1)" || true
  wait "$holder" || true
  [[ "$out" == *'"code": "PUBLISH_IN_FLIGHT"'*'"local_credentials": "kept"'* ]] || { echo "RACE_INFLIGHT ${out//$'\n'/ }"; return 0; }
  [[ "$(as_owner "$db" -A -t -c "select count(*) from public.social_accounts where id = 'sa_th_erin'")" == 1 ]] || { echo "RACE_INFLIGHT_REMOVED"; return 0; }
  echo PASS
}

# 2b. The account row stays locked past the function's lock_timeout (3 s): BUSY, and nothing changed.
race_busy() {
  local db="$1" out holder
  setup_person "$db"
  as_owner "$db" -A -t -c "begin; select 1 from public.social_accounts where id = 'sa_th_erin' for share; select pg_sleep(4); commit;" > /dev/null &
  holder=$!
  sleep 0.3
  out="$(as_owner "$db" -A -t -c "$disconnect_sql" 2>&1)" || true
  wait "$holder" || true
  [[ "$out" == *'{"code": "BUSY", "status": "refused"}'* ]] || { echo "RACE_BUSY ${out//$'\n'/ }"; return 0; }
  [[ "$(as_owner "$db" -A -t -c "select count(*) from public.social_account_manual_publish_permissions where social_account_id = 'sa_th_erin'")" == 1 ]] \
    || { echo "RACE_BUSY_PERMISSION_CHANGED"; return 0; }
  echo PASS
}

prove() {
  local file="$1" tag="$2" db out
  db="$(copy "main_$tag" "$base")"
  [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY $(apply "$(copy "apply_$tag" "$base")" "$file")"; return 0; }
  [[ "$(apply "$db" "$file")" == THREADS_DISCONNECT_PRECONDITION_ALREADY_APPLIED ]] || { echo "REAPPLY"; return 0; }
  out="$(race_inflight "$(copy "racei_$tag" "$db")")"
  [[ "$out" == PASS ]] || { echo "$out"; return 0; }
  if [[ "${RACE_BUSY:-1}" == 1 ]]; then
    out="$(race_busy "$(copy "raceb_$tag" "$db")")"
    [[ "$out" == PASS ]] || { echo "$out"; return 0; }
  fi
  if ! out="$(as_owner "$db" -A -t -f "$here/postona_threads_disconnect_behavior.sql" 2>&1)"; then
    echo "BEHAVIOR $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"; return 0
  fi
  grep -q DISCONNECT_BEHAVIOR_OK <<<"$out" || { echo "BEHAVIOR_INCOMPLETE"; return 0; }
  echo PASS
}
result="$(prove "$candidate" real)"
[[ "$result" == PASS ]] || fail "candidate: $result"
echo "PASS candidate: apply, re-apply refused, races (in flight, busy), behavior"

mutate() {
  local tag="$1" from="$2" to="$3" out="$tmp/mut_$1.sql" got
  FROM="$from" TO="$to" perl -0pe 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$candidate" > "$out"
  cmp -s "$candidate" "$out" && fail "mutation $tag: pattern not found"
  got="$(RACE_BUSY=0 prove "$out" "$tag")"
  [[ "$got" != PASS ]] || fail "mutation $tag was NOT caught"
  echo "PASS mutation $tag caught (${got:0:140})"
}
mutate gate_open "language sql immutable set search_path = '' as \$\$ select false \$\$;" "language sql immutable set search_path = '' as \$\$ select true \$\$;"
mutate no_lifecycle_decision "  v_code := private.account_lifecycle_service_state_refusal(v_user, 'x_autopost');" "  v_code := null;"
mutate removal_during_deletion "v_code not in ('SERVICE_NOT_ACTIVE', 'SERVICE_NOT_REGISTERED')" \
  "v_code not in ('SERVICE_NOT_ACTIVE', 'SERVICE_NOT_REGISTERED', 'ACCOUNT_DELETION_IN_PROGRESS', 'SERVICE_DELETION_IN_PROGRESS')"
mutate active_only "  if v_code is not null and v_code not in ('SERVICE_NOT_ACTIVE', 'SERVICE_NOT_REGISTERED') then" "  if v_code is not null then"
mutate no_session_check "  if not found then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  -- Only the caller's own" "  -- Only the caller's own"
mutate foreign_workspace "  v_workspace := public.social_mobile_account_deletion_workspace(v_user);" \
  "  select a.brand_id into v_workspace from public.social_accounts a where a.id = p_social_account_id;"
mutate any_member_role "  if v_role not in ('owner', 'admin') then" "  if false then"
mutate no_handle_check "  if pg_catalog.ltrim(v_account.handle, '@') is distinct from pg_catalog.ltrim(p_expected_handle, '@') then" "  if false then"
mutate permission_kept "  delete from public.social_account_manual_publish_permissions p where p.social_account_id = v_account.id;
  v_withdrawn := found;" "  v_withdrawn := false;"
mutate no_inflight_check "t.status in ('creating_container', 'publishing', 'publish_returned', 'uncertain')" "t.status in ('creating_container')"
mutate no_shared_secret_check "  if v_secret is not null and exists (
       select 1 from public.social_accounts o" "  if false and exists (
       select 1 from public.social_accounts o"
mutate no_account_row_lock "   where a.brand_id = v_workspace and a.platform = 'threads' for update;" "   where a.brand_id = v_workspace and a.platform = 'threads';"
# F4 T13 task (found on the real G5 world): the connection's OAuth states must go with it, and their verifier.
mutate no_oauth_state_removal "    delete from public.social_account_oauth_states s where s.social_account_id = v_account.id;
" ""
mutate verifier_kept "    delete from vault.secrets s where s.id = any (v_verifiers)" "    delete from vault.secrets s where false and s.id = any (v_verifiers)"
echo "ALL PASS"
