#!/usr/bin/env bash
# A dedicated disposable LOCAL cluster only. Leaves evidence/database for inspection; no remote URI.
set -euo pipefail
host="${H5_PGHOST:?local socket directory required}"
port="${H5_PGPORT:?port required}"
super="${H5_PGSUPER:?local admin required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"
p="${PSQL:-/opt/homebrew/opt/postgresql@17/bin/psql}"
owner="h5_owner_$$"
db="h5_runtime_$$"
a=("$p" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
"${a[@]}" -d postgres -c "create role $owner login nosuperuser" -c "create database $db owner $owner"
"${a[@]}" -d "$db" -c "do \$\$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls;end if;
 if not exists(select 1 from pg_roles where rolname='authenticator') then create role authenticator;end if;
end \$\$;"
q=("$p" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
"${q[@]}" -f "$here/postgres_fixture.sql"
"${q[@]}" -f "$here/claim_candidate.sql"
"${q[@]}" -f "$here/postgres_behavior.sql"
# Two fresh processes race a durable claim: exactly one succeeds, including after worker restart.
claim="set request.jwt.claims='{\"sub\":\"00000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}'; select postona_threads_runtime.claim(repeat('5',64),repeat('c',64),'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','https://postona.example/callback');"
out="$(mktemp -d /private/tmp/h5-pg-evidence.XXXXXX)"
set +e
"${q[@]}" -c "$claim" > "$out/worker1.log" 2>&1 & w1=$!
"${q[@]}" -c "$claim" > "$out/worker2.log" 2>&1 & w2=$!
wait "$w1"; r1=$?
wait "$w2"; r2=$?
"${q[@]}" -c "$claim" > "$out/restart.log" 2>&1; r3=$?
set -e
[[ $(( (r1==0) + (r2==0) )) == 1 && "$r3" != 0 ]] || { echo 'FAIL race/restart'; exit 1; }
echo "PASS: separate PostgreSQL workers race=$r1/$r2 restart=$r3"
code_claim() { printf "%s" "set request.jwt.claims='{\"sub\":\"00000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}'; select postona_threads_runtime.claim(repeat('$1',64),repeat('d',64),'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','https://postona.example/callback');"; }
claim6="$(code_claim 6)"
claim7="$(code_claim 7)"
set +e
"${q[@]}" -c "$claim6" > "$out/code1.log" 2>&1 & w1=$!
"${q[@]}" -c "$claim7" > "$out/code2.log" 2>&1 & w2=$!
wait "$w1"; r1=$?
wait "$w2"; r2=$?
set -e
[[ $(( (r1==0) + (r2==0) )) == 1 ]] || exit 1
echo "PASS: different states share global unique code burn=$r1/$r2; no deadlock"
# Session KEY SHARE must serialize against deletion while the owner transaction holds it.
"${q[@]}" -c "begin; set local request.jwt.claims='{\"sub\":\"00000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}'; select postona_threads_runtime.assert_actor('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'); select pg_sleep(1); commit;" > "$out/session-holder.log" 2>&1 & holder=$!
# Wait until the holding connection has reached pg_sleep, not a fixed guessed delay.
for i in {1..100}; do
  n="$("${q[@]}" -A -t -c "select count(*) from pg_stat_activity where datname=current_database() and query like 'begin;%pg_sleep%' and wait_event='PgSleep'")"
  [[ "$n" == 1 ]] && break
  sleep 0.02
done
[[ "$n" == 1 ]] || exit 1
set +e
"${q[@]}" -c "set lock_timeout='100ms'; delete from auth.sessions;" > "$out/session-delete.log" 2>&1; blocked=$?
set -e
wait "$holder"
[[ "$blocked" != 0 ]] && rg -q 'lock timeout' "$out/session-delete.log" || exit 1
echo 'PASS: session deletion blocked by active KEY SHARE'
# NOINHERIT owner membership is also unsafe (SET ROLE reachability, not just current privileges).
"${a[@]}" -d "$db" -c "grant $owner to authenticated with inherit false"
set +e
"${q[@]}" -f "$here/claim_candidate.sql" > "$out/role-drift.log" 2>&1; drift=$?
set -e
"${a[@]}" -d "$db" -c "revoke $owner from authenticated"
[[ "$drift" != 0 ]] && rg -q 'H5_ROLE_GRAPH_UNSAFE' "$out/role-drift.log" || exit 1
echo "PASS: NOINHERIT role drift refused; evidence=$out database=$db owner=$owner"
