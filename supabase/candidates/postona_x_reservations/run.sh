#!/usr/bin/env bash
# POSTONA X reservations candidate — disposable LOCAL PostgreSQL proof only. Never a remote project.
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> run.sh
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
# RESV_CANDIDATE runs a modified copy (mutation tests); the runner is local-only either way.
candidate="${RESV_CANDIDATE:-$here/001_postona_x_reservations.sql}"
owner="kb_postona_resv_owner"
prefix="kabumori_postona_resv_$$"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-resv.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  local db
  for db in $("${as_super[@]}" -A -t -d postgres -c "select datname from pg_database where datname like '${prefix}\_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

"${as_super[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
SQL

new_db() {
  local db="${prefix}_$1"
  "${as_super[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
  echo "$db"
}
own() { local db="$1"; shift; "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
scalar() { own "$1" -A -t -c "$2"; }

# R0: refusals and rollback leave nothing behind.
db="$(new_db refuse)"
if own "$db" -f "$candidate" >"$tmp/r0" 2>&1; then fail "applied without prerequisites"; fi
grep -q POSTONA_RESV_PRECONDITION_MISSING "$tmp/r0" || fail "wrong refusal: $(tail -1 "$tmp/r0")"
[[ "$(scalar "$db" "select to_regnamespace('postona_x_resv') is null")" == t ]] || fail "schema left behind"
own "$db" -f "$here/test_fixture.sql" >/dev/null
perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$candidate" > "$tmp/fail.sql"
if own "$db" -f "$tmp/fail.sql" >/dev/null 2>&1; then fail "injected failure applied"; fi
[[ "$(scalar "$db" "select to_regnamespace('postona_x_resv') is null")" == t ]] || fail "partial apply left behind"
own "$db" -f "$candidate" >/dev/null
if own "$db" -f "$candidate" >"$tmp/r0b" 2>&1; then fail "re-apply accepted"; fi
grep -q POSTONA_RESV_ALREADY_APPLIED "$tmp/r0b" || fail "re-apply refused for another reason"
echo "R0_REFUSAL_ROLLBACK_REAPPLY_PASS"

# A1: no API role reaches anything, even with a worst-case default ACL; no PUBLIC EXECUTE; RLS on, no policy.
for role in anon authenticated service_role; do
  if own "$db" -c "set role $role; select count(*) from postona_x_resv.reservations" >"$tmp/a" 2>&1; then fail "$role read reservations"; fi
  grep -q "permission denied" "$tmp/a" || fail "$role: unexpected $(tail -1 "$tmp/a")"
  if own "$db" -c "set role $role; select * from postona_x_resv.list_reservations('x_a')" >"$tmp/a" 2>&1; then fail "$role executed list"; fi
  grep -q "permission denied" "$tmp/a" || fail "$role: unexpected $(tail -1 "$tmp/a")"
  if own "$db" -c "set role $role; select * from postona_x_resv.claim_due('w', 60, 1)" >"$tmp/a" 2>&1; then fail "$role executed claim"; fi
done
[[ "$(scalar "$db" "select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.pronamespace = 'postona_x_resv'::regnamespace and a.grantee = 0")" == 0 ]] || fail "PUBLIC EXECUTE"
[[ "$(scalar "$db" "select count(*) from pg_class c where c.relnamespace = 'postona_x_resv'::regnamespace and c.relkind = 'r' and not c.relrowsecurity")" == 0 ]] || fail "RLS off"
[[ "$(scalar "$db" "select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'postona_x_resv'::regnamespace")" == 0 ]] || fail "policy present"
echo "A1_ACL_NO_API_ACCESS_PASS"

# B1: behaviour (deny by default, then MOCK_ONLY guards).
own "$db" -f "$here/test_behavior.sql" > "$tmp/b" 2>&1 || { cat "$tmp/b"; fail "behaviour"; }
for marker in D0_DENY_BY_DEFAULT_PASS M1_BATCH_ATOMIC_IDEMPOTENT_PASS M2_TENANT_ISOLATION_PASS M3_VALIDATION_NO_PARTIAL_PASS \
              M4_AI_OPT_IN_SERVER_SIDE_PASS M5_RESCHEDULE_CONSENT_CANCEL_PASS M6_INTERVAL_CADENCE_SERVER_CHECK_PASS \
              W1_CLAIM_LEASE_FINISH_PASS W2_LIVE_AUTHORITY_RECHECK_PASS W3_FINISH_LEASE_DEADLINE_PASS \
              L1_LIFECYCLE_CASCADE_PASS POSTONA_RESV_BEHAVIOR_PASS; do
  grep -q "$marker" "$tmp/b" || { cat "$tmp/b"; fail "missing $marker"; }
  echo "$marker"
done

# C1-C3: two sessions (user B, MOCK_ONLY guards still in place from B1).
b_items() {  # $1 = draft prefix, $2 = JST day offset, $3 = hh:mm
  echo "jsonb_build_array(jsonb_build_object('draft_id', '$1', 'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + $2 + '$3'::time) at time zone 'Asia/Tokyo', 'body', '並行$1', 'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to('並行$1', 'UTF8')), 'hex'))))"
}
key="11111111-1111-4111-8111-111111111111"
s1="select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000b', false); begin; select count(*) from postona_x_resv.create_batch('x_b', '$key', 1, 'manual_exact', null, $(b_items c1 5 10:00)); select pg_sleep(1.5); commit;"
own "$db" -A -t -c "$s1" >"$tmp/c1a" 2>&1 &
p1=$!
sleep 0.4
own "$db" -A -t -c "select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000b', false); select count(*) from postona_x_resv.create_batch('x_b', '$key', 1, 'manual_exact', null, $(b_items c1 5 10:00))" >"$tmp/c1b" 2>&1 || fail "C1 second session: $(cat "$tmp/c1b")"
wait $p1 || fail "C1 first session: $(cat "$tmp/c1a")"
[[ "$(scalar "$db" "select count(*) from postona_x_resv.batches where client_batch_id = '$key'")" == 1 ]] || fail "C1 double batch"
[[ "$(scalar "$db" "select count(*) from postona_x_resv.reservations where draft_id = 'c1'")" == 1 ]] || fail "C1 double booking"
echo "C1_CONCURRENT_SAME_KEY_SINGLE_BOOKING_PASS"

s1="select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000b', false); begin; select count(*) from postona_x_resv.create_batch('x_b', gen_random_uuid(), 1, 'manual_exact', null, $(b_items c2a 6 10:00)); select pg_sleep(1.5); commit;"
own "$db" -A -t -c "$s1" >"$tmp/c2a" 2>&1 &
p1=$!
sleep 0.4
if own "$db" -A -t -c "select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000b', false); select count(*) from postona_x_resv.create_batch('x_b', gen_random_uuid(), 1, 'manual_exact', null, $(b_items c2b 6 10:30))" >"$tmp/c2b" 2>&1; then
  fail "C2 overlapping slot accepted"
fi
wait $p1 || fail "C2 first session: $(cat "$tmp/c2a")"
grep -q POSTONA_RESV_SLOT_CONFLICT "$tmp/c2b" || fail "C2 wrong error: $(cat "$tmp/c2b")"
echo "C2_CONCURRENT_OVERLAP_ONE_WINNER_PASS"

own "$db" -c "update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute' where draft_id in ('c1', 'c2a')" >/dev/null
claim="begin; select reservation_id from postona_x_resv.claim_due('w', 120, 50); select pg_sleep(1); commit;"
own "$db" -A -t -c "$claim" >"$tmp/w1" 2>&1 &
p1=$!
own "$db" -A -t -c "$claim" >"$tmp/w2" 2>&1 &
p2=$!
wait $p1 || fail "C3 worker 1"
wait $p2 || fail "C3 worker 2"
total="$(cat "$tmp/w1" "$tmp/w2" | grep -cE '^[0-9a-f-]{36}$' || true)"
unique="$(cat "$tmp/w1" "$tmp/w2" | grep -E '^[0-9a-f-]{36}$' | sort -u | wc -l | tr -d ' ')"
[[ "$total" == 2 && "$unique" == 2 ]] || fail "C3 claims total=$total unique=$unique"
echo "C3_TWO_WORKERS_EACH_ROW_ONCE_PASS"

echo "POSTONA_RESV_CANDIDATE_ALL_PASS"
