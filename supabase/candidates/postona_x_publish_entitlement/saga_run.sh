#!/usr/bin/env bash
# F3 X service-end saga stop (002) — proof on a disposable LOCAL PostgreSQL only. Never a remote project.
# Baseline: G5's production-shaped world from the G5/F5 candidate SOURCE (PR #165), which includes the REAL X deletion
# saga SQL (20260928160000), Stage 3B stand-ins + the REAL Stage 3B authority migration, the F3 reservation candidate
# (001 + 002) and the F3 entitlement guard 001. Then: fail-before on the unchanged saga, refusals, 002, SQL behaviour,
# the REAL saga TypeScript end to end over the real driver (loopback TCP), rollback.
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> \
#        RESV_G5_SOURCE_DIR=<dir with supabase/migrations + supabase/tests of the G5/F5 candidate commit> saga_run.sh
# The cluster must also listen on 127.0.0.1 (trust auth). Optional: SAGA_STOP_CANDIDATE=<file> (mutation runs).
# Without the G5 source: RUN_NOT_AVAILABLE (exit 3). Roles are cluster-wide: run alone.
set -euo pipefail

host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${RESV_G5_SOURCE_DIR:-}"
if [[ -z "$g5" || ! -f "$g5/supabase/migrations/20261012230000_common_account_service_brand_state.sql" ]]; then
  echo "RUN_NOT_AVAILABLE: RESV_G5_SOURCE_DIR does not hold the G5/F5 candidate source (PR #165)" >&2; exit 3
fi
export LC_ALL=C PGTZ=UTC

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
stop_sql="${SAGA_STOP_CANDIDATE:-$here/002_x_service_end_saga_stop.sql}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_postona_xsaga_owner"
db="kabumori_postona_xsaga_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-xsaga.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists postona_resv_api" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

"${S[@]}" -d postgres -c "drop role if exists postona_resv_api" >/dev/null
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_svc_child') then create role kb_cal_svc_child nologin inherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_auth_child') then create role kb_cal_auth_child nologin inherit; end if;
end \$\$;
grant service_role to kb_cal_svc_child;
grant authenticated to kb_cal_auth_child;
grant anon, authenticated, service_role, kb_cal_svc_child, kb_cal_auth_child to $owner;
create database $db owner $owner;
SQL
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
val() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }

own -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
own -f "$m/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
own -f "$m/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
own -f "$tests/common_account_lifecycle_fixture.sql" >/dev/null
own -f "$m/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
own -f "$m/20261006230000_common_account_service_start_intent.sql" >/dev/null
own -f "$m/20261009120000_common_account_deletion_completion.sql" >/dev/null
own -f "$tests/common_account_write_guard_fixture.sql" >/dev/null
"${S[@]}" -d "$db" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
own -f "$m/20261010051938_common_account_service_write_guard.sql" >/dev/null
own -f "$m/20261012130000_common_account_core_service_fence.sql" >/dev/null
own -f "$m/20261012230000_common_account_service_brand_state.sql" >/dev/null
own -f "$here/test_stand_ins.sql" >/dev/null
own -f "$repo/supabase/migrations/20261006160200_x_account_publish_authority.sql" >/dev/null
own -f "$repo/supabase/candidates/postona_x_reservations/001_postona_x_reservations.sql" >/dev/null
own -f "$repo/supabase/candidates/postona_x_reservations/002_postona_x_resv_api_role.sql" >/dev/null
echo "BASELINE_G5_SAGA_STAGE3B_RESERVATIONS_READY"

# FB: fail-before on the unchanged saga (no stop step yet).
own -f "$here/saga_fail_before.sql" >"$tmp/fb" 2>&1 || { cat "$tmp/fb"; fail "fail-before script"; }
grep -q "FB1:ERR:SOCIAL_MOBILE_DELETION_UNEXPECTED_DEPENDENT_DATA" "$tmp/fb" || { cat "$tmp/fb"; fail "FB1 not reproduced"; }
grep -q 'FB2:{"status": "purged"}:claimed_left=0' "$tmp/fb" || { cat "$tmp/fb"; fail "FB2 not reproduced"; }
echo "FB_FAIL_BEFORE_REPRODUCED (authority row breaks the purge; an in-flight reservation is silently purged)"

# R0: 002 needs the entitlement guard 001; a failure leaves nothing; no re-apply.
if own -f "$stop_sql" >"$tmp/r0" 2>&1; then fail "002 applied without the guard"; fi
grep -q X_SAGA_STOP_PRECONDITION_MISSING "$tmp/r0" || fail "R0 wrong refusal: $(tail -1 "$tmp/r0")"
own -f "$here/001_x_publish_entitlement_guard.sql" >/dev/null
perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$stop_sql" > "$tmp/fail.sql"
if own -f "$tmp/fail.sql" >/dev/null 2>&1; then fail "injected failure applied"; fi
[[ "$(val -c "select to_regprocedure('public.social_mobile_account_deletion_stop_x(uuid,uuid)') is null and to_regclass('public.social_mobile_account_deletion_x_unconfirmed') is null and to_regclass('public.social_mobile_account_deletion_x_unconfirmed_ack_receipts') is null")" == t ]] || fail "partial apply"
own -f "$stop_sql" >/dev/null
if own -f "$stop_sql" >"$tmp/r0" 2>&1; then fail "re-apply accepted"; fi
grep -q X_SAGA_STOP_ALREADY_APPLIED "$tmp/r0" || fail "re-apply refused for another reason"
echo "R0_REFUSALS_ROLLBACK_REAPPLY_PASS"

# B1: SQL behaviour.
own -f "$here/saga_behavior.sql" >"$tmp/b1" 2>&1 || { cat "$tmp/b1"; fail "behaviour"; }
for marker in S1_LEASE_IDEMPOTENT_ACL_PASS S3_FROZEN_STILL_STOPS_PASS S5_IN_FLIGHT_AND_UNCERTAIN_PASS S6_DURABLE_UNCONFIRMED_ACL_PASS X_SAGA_STOP_BEHAVIOR_PASS; do
  grep -q "$marker" "$tmp/b1" || { cat "$tmp/b1"; fail "missing $marker"; }
  echo "$marker"
done

# S2: a membership that appears AFTER acquire (TEST STAND-IN placed past the deletion guard by the superuser) blocks the
# stop with a typed SHARED_WORKSPACE -- never one person's word -- and nothing is revoked or removed.
U2='00000000-0000-4000-8000-0000000000a2'
U3='00000000-0000-4000-8000-0000000000a3'
lease2="$(val -c "set role service_role" -c "select public.social_mobile_account_deletion_acquire('$U2', 'social_only', false) ->> 'lease'" | tail -1)"
[[ "$lease2" =~ ^[0-9a-f-]{36}$ ]] || fail "S2 acquire: $lease2"
"${S[@]}" -d "$db" -c "begin; set local session_replication_role = replica; insert into public.brand_memberships values (public.social_mobile_account_deletion_workspace('$U2'), '$U3', 'member'); commit;" >/dev/null
s2="$(val -c "set role service_role" -c "select public.social_mobile_account_deletion_stop_x('$U2', '$lease2') ->> 'reason'" | tail -1)"
[[ "$s2" == SHARED_WORKSPACE ]] || fail "S2 expected SHARED_WORKSPACE, got $s2"
[[ "$(val -c "select state from public.x_account_publish_authority a join public.social_accounts s on s.id = a.social_account_id where s.brand_id = public.social_mobile_account_deletion_workspace('$U2')")" == enabled ]] \
  || fail "S2 stopped someone else's shared workspace"
echo "S2_SHARED_WORKSPACE_BLOCKED_PASS"
# S4: a non-X account that appears AFTER acquire (TEST STAND-IN past the guard): the stop's second line blocks it typed,
# before any credential is read (the read-only precheck covers the case before acquire).
U1='00000000-0000-4000-8000-0000000000a1'
own -c "update public.social_mobile_account_deletions set lease_token = null, lease_expires_at = null where user_id = '$U1'" >/dev/null
lease1="$(val -c "set role service_role" -c "select public.social_mobile_account_deletion_acquire('$U1', 'social_only', false) ->> 'lease'" | tail -1)"
[[ "$lease1" =~ ^[0-9a-f-]{36}$ ]] || fail "S4 acquire: $lease1"
"${S[@]}" -d "$db" -c "begin; set local session_replication_role = replica; alter table public.social_accounts drop constraint if exists social_accounts_platform_check; insert into public.social_accounts (id, brand_id, platform) values ('th_s4', public.social_mobile_account_deletion_workspace('$U1'), 'threads'); commit;" >/dev/null
s4="$(val -c "set role service_role" -c "select public.social_mobile_account_deletion_stop_x('$U1', '$lease1') ->> 'reason'" | tail -1)"
[[ "$s4" == NON_X_ACCOUNT_PRESENT ]] || fail "S4 expected NON_X_ACCOUNT_PRESENT, got $s4"
[[ "$(val -c "set role service_role" -c "select public.social_mobile_account_deletion_x_precheck('$U1') ->> 'non_x_accounts'" | tail -1)" == 1 ]] || fail "S4 precheck count"
echo "S4_NON_X_AFTER_ACQUIRE_BLOCKED_PASS"

# R3 (J3 V3): two sessions. A holder keeps the person's WORKSPACE lock; stop_x waits on it (observed in pg_locks) while
# its lease runs out on the wall clock. After the holder releases, stop_x must answer LEASE_LOST and write nothing
# (authority still enabled, planned reservations untouched, nothing checkpointed). Controls: a valid lease after the
# same wait stops; two concurrent stops on one lease both succeed in turn (idempotent), no deadlock.
U5='00000000-0000-4000-8000-0000000000a5'
U6='00000000-0000-4000-8000-0000000000a6'
acquire() { val -c "set role service_role" -c "select public.social_mobile_account_deletion_acquire('$1', 'social_only', false) ->> 'lease'" | tail -1; }
hold_workspace() { own -c "begin" -c "select public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace('$1'))" -c "select pg_sleep($2)" -c "commit" >/dev/null; }
stop_bg() { if val -c "set role service_role" -c "select public.social_mobile_account_deletion_stop_x('$1', '$2')::text" >"$3" 2>&1; then echo ok >"$3.rc"; else echo err >"$3.rc"; fi; }
wait_until() { local i; for i in $(seq 1 100); do [[ "$(val -c "$1")" == "$2" ]] && return 0; sleep 0.05; done; fail "timed out waiting for: $1"; }
holder_has_lock="select (count(*) > 0)::text from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and l.granted and a.query like '%pg_sleep%'"
waiting_stop="select count(*)::text from pg_stat_activity a where a.wait_event_type = 'Lock' and a.wait_event = 'advisory' and a.query like '%stop_x%'"
authority_of() { val -c "select a.state from public.x_account_publish_authority a join public.social_accounts s on s.id = a.social_account_id where s.brand_id = public.social_mobile_account_deletion_workspace('$1')"; }
planned_of() { val -c "select count(*) from postona_x_resv.reservations where brand_id = public.social_mobile_account_deletion_workspace('$1') and status = 'planned'"; }
deadlocks0="$(val -c "select deadlocks from pg_stat_database where datname = current_database()")"

lease5="$(acquire "$U5")"; [[ "$lease5" =~ ^[0-9a-f-]{36}$ ]] || fail "R3 acquire: $lease5"
hold_workspace "$U5" 3 & holder=$!
wait_until "$holder_has_lock" true
own -c "update public.social_mobile_account_deletions set lease_expires_at = clock_timestamp() + interval '1 second' where user_id = '$U5'" >/dev/null
stop_bg "$U5" "$lease5" "$tmp/r3" & stopper=$!
wait_until "$waiting_stop" 1
wait "$holder"; wait "$stopper"
[[ "$(cat "$tmp/r3.rc")" == err ]] && grep -q SOCIAL_MOBILE_DELETION_LEASE_LOST "$tmp/r3" || { cat "$tmp/r3"; fail "R3 lease expired while waiting was accepted"; }
[[ "$(authority_of "$U5")" == enabled ]] || fail "R3 authority changed under a lost lease"
[[ "$(planned_of "$U5")" == 2 ]] || fail "R3 reservations changed under a lost lease"
[[ "$(val -c "select count(*) from public.social_mobile_account_deletion_x_unconfirmed where subject_sha256 = public.social_mobile_account_deletion_subject('$U5')")" == 0 ]] || fail "R3 checkpoint written under a lost lease"
# Control: a fresh valid lease after the same wait stops.
lease5b="$(acquire "$U5")"; [[ "$lease5b" =~ ^[0-9a-f-]{36}$ && "$lease5b" != "$lease5" ]] || fail "R3 re-acquire: $lease5b"
hold_workspace "$U5" 1.5 & holder=$!
wait_until "$holder_has_lock" true
stop_bg "$U5" "$lease5b" "$tmp/r3c" & stopper=$!
wait_until "$waiting_stop" 1
wait "$holder"; wait "$stopper"
[[ "$(cat "$tmp/r3c.rc")" == ok ]] && grep -q '"status": "stopped"' "$tmp/r3c" || { cat "$tmp/r3c"; fail "R3 valid lease after the wait"; }
[[ "$(authority_of "$U5")" == revoked && "$(planned_of "$U5")" == 0 ]] || fail "R3 valid lease did not stop"
# Two workers on one valid lease, queued behind the holder: both stop, in turn; the cancellations happen once.
lease6="$(acquire "$U6")"; [[ "$lease6" =~ ^[0-9a-f-]{36}$ ]] || fail "R3 acquire six: $lease6"
hold_workspace "$U6" 1.5 & holder=$!
wait_until "$holder_has_lock" true
stop_bg "$U6" "$lease6" "$tmp/r3w1" & w1=$!
stop_bg "$U6" "$lease6" "$tmp/r3w2" & w2=$!
wait "$holder"; wait "$w1"; wait "$w2"
for w in r3w1 r3w2; do [[ "$(cat "$tmp/$w.rc")" == ok ]] && grep -q '"status": "stopped"' "$tmp/$w" || { cat "$tmp/$w"; fail "R3 worker $w"; }; done
cancelled="$(cat "$tmp/r3w1" "$tmp/r3w2" | grep -o '"reservations_cancelled": [0-9]*' | awk '{s += $2} END {print s}')"
[[ "$cancelled" == 2 ]] || fail "R3 two workers cancelled $cancelled (expected 2 in total)"
[[ "$(val -c "select deadlocks from pg_stat_database where datname = current_database()")" == "$deadlocks0" ]] || fail "R3 deadlock"
# An expired lease takes no row lock: after the workspace wait it refuses at once, without queueing behind a worker
# that holds the X account row (the early wall-clock fence; the late fence alone would wait for that worker).
lease5c="$lease5b" # still live (the control above)
own -c "begin" -c "select 1 from public.social_accounts where brand_id = public.social_mobile_account_deletion_workspace('$U5') for update" -c "select pg_sleep(6)" -c "commit" >/dev/null & row_holder=$!
wait_until "select (count(*) > 0)::text from pg_stat_activity a where a.state = 'active' and a.query like 'select pg_sleep(6)%'" true
hold_workspace "$U5" 2 & holder=$!
wait_until "$holder_has_lock" true
own -c "update public.social_mobile_account_deletions set lease_expires_at = clock_timestamp() + interval '1 second' where user_id = '$U5'" >/dev/null
stop_bg "$U5" "$lease5c" "$tmp/r3e" & stopper=$!
wait "$holder"; wait "$stopper"
[[ "$(val -c "select (count(*) > 0)::text from pg_stat_activity a where a.state = 'active' and a.query like 'select pg_sleep(6)%'")" == true ]] || fail "R3 an expired lease queued behind the worker's row"
[[ "$(cat "$tmp/r3e.rc")" == err ]] && grep -q SOCIAL_MOBILE_DELETION_LEASE_LOST "$tmp/r3e" || { cat "$tmp/r3e"; fail "R3 expired lease after the workspace wait"; }
wait "$row_holder"
echo "R3_LEASE_EXPIRED_WHILE_WAITING_REFUSED_PASS"

# R3a (J3 V3 re-review): the lease runs out while stop_x waits on a ROW lock it needs AFTER the early clock check --
# the X account row (the stop's social_accounts FOR UPDATE) or an expired claimed reservation (the sweep). stop_x
# must answer LEASE_LOST and the WHOLE transaction must roll back: authority still enabled, planned reservations
# untouched, no service_stop audit, the reservation still claimed, nothing checkpointed. Control: a valid lease
# after the same row wait stops.
U7='00000000-0000-4000-8000-0000000000a7'
U8='00000000-0000-4000-8000-0000000000a8'
hold_rows() { own -c "begin" -c "$2" -c "select pg_sleep($3)" -c "commit" >/dev/null; }
holder_sleeping="select (count(*) > 0)::text from pg_stat_activity a where a.state = 'active' and a.query like 'select pg_sleep(%'"
row_waiting_stop="select count(*)::text from pg_stat_activity a where a.wait_event_type = 'Lock' and a.wait_event in ('transactionid', 'tuple') and a.query like '%stop_x%'"
stop_audits_of() { val -c "select count(*) from postona_x_resv.audit a where a.user_id = '$1' and a.action = 'service_stop'"; }
unconfirmed_of() { val -c "select count(*) from public.social_mobile_account_deletion_x_unconfirmed where subject_sha256 = public.social_mobile_account_deletion_subject('$1')"; }
expire_in_one_second() { own -c "update public.social_mobile_account_deletions set lease_expires_at = clock_timestamp() + interval '1 second' where user_id = '$1'" >/dev/null; }
row_wait_case() { # $1 user, $2 lease, $3 locking statement, $4 out file
  hold_rows "$1" "$3" 3 & holder=$!
  wait_until "$holder_sleeping" true
  expire_in_one_second "$1"
  stop_bg "$1" "$2" "$4" & stopper=$!
  wait_until "$row_waiting_stop" 1
  wait "$holder"; wait "$stopper"
}
# (a) the X account row.
lease7="$(acquire "$U7")"; [[ "$lease7" =~ ^[0-9a-f-]{36}$ ]] || fail "R3a acquire: $lease7"
row_wait_case "$U7" "$lease7" "select 1 from public.social_accounts where brand_id = public.social_mobile_account_deletion_workspace('$U7') for update" "$tmp/r3a"
[[ "$(cat "$tmp/r3a.rc")" == err ]] && grep -q SOCIAL_MOBILE_DELETION_LEASE_LOST "$tmp/r3a" || { cat "$tmp/r3a"; fail "R3a account-row wait across expiry was accepted"; }
[[ "$(authority_of "$U7")" == enabled && "$(planned_of "$U7")" == 2 && "$(stop_audits_of "$U7")" == 0 ]] || fail "R3a account-row wait left a partial stop"
# (b) an expired claimed reservation held by a worker (the sweep waits on it).
own -c "update postona_x_resv.reservations set status = 'claimed', lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second' where brand_id = public.social_mobile_account_deletion_workspace('$U8') and position = 0" >/dev/null
lease8="$(acquire "$U8")"; [[ "$lease8" =~ ^[0-9a-f-]{36}$ ]] || fail "R3a acquire eight: $lease8"
row_wait_case "$U8" "$lease8" "select 1 from postona_x_resv.reservations where brand_id = public.social_mobile_account_deletion_workspace('$U8') and status = 'claimed' for update" "$tmp/r3b"
[[ "$(cat "$tmp/r3b.rc")" == err ]] && grep -q SOCIAL_MOBILE_DELETION_LEASE_LOST "$tmp/r3b" || { cat "$tmp/r3b"; fail "R3a reservation-row wait across expiry was accepted"; }
[[ "$(val -c "select status from postona_x_resv.reservations where brand_id = public.social_mobile_account_deletion_workspace('$U8') and position = 0")" == claimed ]] || fail "R3a sweep committed under a lost lease"
[[ "$(authority_of "$U8")" == enabled && "$(planned_of "$U8")" == 1 && "$(stop_audits_of "$U8")" == 0 && "$(unconfirmed_of "$U8")" == 0 ]] || fail "R3a reservation-row wait left a partial stop"
# Control: a fresh valid lease after the same account-row wait stops (and the sweep/checkpoint commit together).
lease8b="$(acquire "$U8")"; [[ "$lease8b" =~ ^[0-9a-f-]{36}$ ]] || fail "R3a re-acquire: $lease8b"
hold_rows "$U8" "select 1 from public.social_accounts where brand_id = public.social_mobile_account_deletion_workspace('$U8') for update" 1.5 & holder=$!
wait_until "$holder_sleeping" true
stop_bg "$U8" "$lease8b" "$tmp/r3c2" & stopper=$!
wait_until "$row_waiting_stop" 1
wait "$holder"; wait "$stopper"
[[ "$(cat "$tmp/r3c2.rc")" == ok ]] && grep -q '"status": "stopped"' "$tmp/r3c2" || { cat "$tmp/r3c2"; fail "R3a valid lease after the row wait"; }
[[ "$(authority_of "$U8")" == revoked && "$(planned_of "$U8")" == 0 && "$(unconfirmed_of "$U8")" == 1 ]] || fail "R3a valid lease did not stop as one unit"
[[ "$(val -c "select deadlocks from pg_stat_database where datname = current_database()")" == "$deadlocks0" ]] || fail "R3a deadlock"
echo "R3A_ROW_WAIT_EXPIRY_ROLLS_BACK_PASS"

# E1: the REAL saga TypeScript against the real SQL (MOCK_ONLY getUser / revokeX).
if ! SAGA_OWNER_URL="postgres://$owner@127.0.0.1:$port/$db" SAGA_SUPER_URL="postgres://$super@127.0.0.1:$port/$db" \
  DENO_NO_PACKAGE_JSON=1 deno test --no-config --allow-net=127.0.0.1:"$port" --allow-read --allow-env=SAGA_OWNER_URL,SAGA_SUPER_URL \
  "$here/saga_e2e/saga_e2e_test.ts" >"$tmp/e1" 2>&1; then
  cat "$tmp/e1"; fail "saga e2e"
fi
grep -E "passed|failed" "$tmp/e1" | tail -1
echo "E1_REAL_SAGA_END_TO_END_PASS"

# RB: the rollback REFUSES while unknown-post evidence exists (R1); a refusal changes nothing.
rollback_sql="$here/002_x_service_end_saga_stop_rollback.sql"
objects_present="select (to_regprocedure('public.social_mobile_account_deletion_stop_x(uuid,uuid)') is not null
  and to_regprocedure('public.social_mobile_account_deletion_x_unconfirmed_ack(uuid,text)') is not null
  and to_regclass('public.social_mobile_account_deletion_x_unconfirmed') is not null
  and to_regclass('public.social_mobile_account_deletion_x_unconfirmed_ack_receipts') is not null)::text"
if own -f "$rollback_sql" >"$tmp/rb" 2>&1; then fail "RB dropped the unknown-post record"; fi
grep -q X_SAGA_STOP_ROLLBACK_UNCONFIRMED_PRESENT "$tmp/rb" || { cat "$tmp/rb"; fail "RB refused for another reason"; }
[[ "$(val -c "$objects_present")" == true ]] || fail "RB refusal was not atomic"
own -c "delete from public.social_mobile_account_deletion_x_unconfirmed" >/dev/null # TEST STAND-IN: evidence acknowledged / exported

# R1b (J3 V3 re-review): a stop_x that has WRITTEN a checkpoint but not committed while the rollback runs. The rollback
# must wait for it (lock first) and then see what it committed: writer commits -> refused, nothing dropped, the
# evidence kept; writer aborts -> the rollback proceeds.
U9='00000000-0000-4000-8000-0000000000a9'
U10='00000000-0000-4000-8000-0000000000aa'
writer_has_written="select (count(*) > 0)::text from pg_locks l join pg_stat_activity a on a.pid = l.pid
  where l.relation = to_regclass('public.social_mobile_account_deletion_x_unconfirmed') and l.mode = 'RowExclusiveLock' and l.granted and a.query like 'select pg_sleep(%'"
rollback_waiting="select count(*)::text from pg_stat_activity a where a.wait_event_type = 'Lock' and a.wait_event = 'relation' and (a.query like '%lock table%' or a.query like '%drop table%')"
writer_case() { # $1 user, $2 commit|rollback, $3 out file
  own -c "update postona_x_resv.reservations set status = 'claimed', lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second' where brand_id = public.social_mobile_account_deletion_workspace('$1') and position = 0" >/dev/null
  local lease; lease="$(acquire "$1")"; [[ "$lease" =~ ^[0-9a-f-]{36}$ ]] || fail "R1b acquire: $lease"
  own -c "begin" -c "set local role service_role" -c "select public.social_mobile_account_deletion_stop_x('$1', '$lease') is not null" \
      -c "reset role" -c "select pg_sleep(2)" -c "$2" >/dev/null & writer=$!
  wait_until "$writer_has_written" true
  if own -f "$rollback_sql" >"$3" 2>&1; then echo ok >"$3.rc"; else echo err >"$3.rc"; fi & roller=$!
  wait_until "$rollback_waiting" 1
  wait "$writer"; wait "$roller"
}
writer_case "$U9" commit "$tmp/r1b"
[[ "$(cat "$tmp/r1b.rc")" == err ]] && grep -q X_SAGA_STOP_ROLLBACK_UNCONFIRMED_PRESENT "$tmp/r1b" || { cat "$tmp/r1b"; fail "R1b rollback dropped evidence a concurrent writer committed"; }
[[ "$(val -c "$objects_present")" == true && "$(unconfirmed_of "$U9")" == 1 ]] || fail "R1b refusal changed tables / functions / evidence"
own -c "delete from public.social_mobile_account_deletion_x_unconfirmed" >/dev/null # TEST STAND-IN: acknowledged / exported
writer_case "$U10" rollback "$tmp/r1b2"
[[ "$(cat "$tmp/r1b2.rc")" == ok ]] || { cat "$tmp/r1b2"; fail "R1b rollback after an aborted writer"; }
[[ "$(val -c "select (to_regprocedure('public.social_mobile_account_deletion_stop_x(uuid,uuid)') is null and to_regprocedure('public.social_mobile_account_deletion_x_unconfirmed_ack(uuid,integer)') is null and to_regprocedure('public.social_mobile_account_deletion_x_unconfirmed_ack(uuid,text)') is null and to_regprocedure('public.social_mobile_account_deletion_x_unconfirmed_snapshot(text)') is null and to_regclass('public.social_mobile_account_deletion_x_unconfirmed') is null and to_regclass('public.social_mobile_account_deletion_x_unconfirmed_ack_receipts') is null)::text")" == true ]] || fail "RB left an object"
echo "R1B_ROLLBACK_WAITS_FOR_WRITERS_PASS"
own -f "$stop_sql" >/dev/null
echo "RB_ROLLBACK_REAPPLY_PASS"
echo "X_SAGA_STOP_ALL_PASS"
