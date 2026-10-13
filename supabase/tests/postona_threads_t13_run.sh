#!/usr/bin/env bash
# F4 POSTONA Threads: every AUTHENTICATED Threads writer against the REAL G5 lifecycle (T13 writer guard,
# Phase 4 decision, F5 workspace service state). Disposable and local only; never production.
#
# 1. Builds a throwaway tree under /private/tmp from this checkout's working tree and BOUNDED, READ-ONLY copies
#    of the exact protected sources (nothing is merged, checked out or pushed; an overlay path that already
#    exists stops the run):
#      PR #124 c30f246409a77080cbc03aef6c4cb72b5481e125  G4 Threads OAuth / workspace candidate + its test fixture
#      PR #178 83334a091ded5571cf595fd99d7a035627564735  F5 Phase 6 (stacked on F5 PR #165 4638891f -> G5 PR #152 ccea1fe8
#              -> PR #121 76b50e1e): the Phase 3b guard fixture, the Phase 3b guard (T13), Phase 4, the F5
#              workspace service state and Phase 6 (service-deletion owner lease, cleanup predicate)
#      PR #169 fd15430ddcd640c5c7389582f37f1b478fc7204c  F4 (the cleanup candidate BEFORE the live-lease fix, for
#              fail-before only)
# 2. On a LOCAL Unix-socket PostgreSQL 17 cluster, as a per-run non-superuser owner: G5's own world (the
#    lifecycle fixtures and the REAL Phase 1 / 2 / 3a / 3b / 4 / F5 migrations), the X and Phase 2a-2 migrations,
#    PR #124, the G4 publish stack, the Threads cleanup and disconnect candidates, postona_threads_t13_fixture.sql,
#    then the F4 guards candidate (threads_writer_lifecycle_guards_candidate.sql); before that, the cleanup
#    live-lease fix: fail-before on PR #169's cleanup candidate and pass-after on this branch's (R7: a claimed
#    POSTONA deletion whose lease ends during the lock wait; postona_threads_t13_cleanup_lease.sql: begin -> claim
#    -> ended / released / other person's lease -> taken over, account deletion), and the guards:
#      a. preconditions: drifted replaced body, G5 decision missing or reachable by an API role; re-apply refused;
#      b. two-session races: an owner's POSTONA ending while an admin's release waits (F5 decides after the
#         wait); a non-member naming another workspace never queues on its owner; lock order (the owner's
#         lifecycle before the workspace row) for enabling publishing and for a begin; PR #124 completion
#         waiting on a freeze;
#      c. postona_threads_t13_behavior.sql (OAuth begin/consume/complete, publish, disconnect, cleanup, ACL);
#      d. mutations of the guards candidate must FAIL the proof.
# Requires the git objects of both SHAs. Usage:
#   THREADS_PGHOST=/private/tmp/<socket-dir> THREADS_PGPORT=<port> THREADS_PGSUPER=<superuser> \
#     supabase/tests/postona_threads_t13_run.sh
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
repo="$(git -C "$here" rev-parse --show-toplevel)"
head="$(git -C "$repo" rev-parse HEAD)"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }
PR124=c30f246409a77080cbc03aef6c4cb72b5481e125
PR178=83334a091ded5571cf595fd99d7a035627564735
PR169=fd15430ddcd640c5c7389582f37f1b478fc7204c
for sha in "$PR124" "$PR178" "$PR169"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done

tree="$(mktemp -d /private/tmp/kabumori-threads-t13.XXXXXX)"
n="$$"
owner="kb_threads_t13_owner_$n"
prefix="kabumori_threads_t13_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $owner" > /dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. Combined tree --------------------------------------------------------------------------------------
(cd "$repo" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$tree"
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/T13_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the F4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/T13_MANIFEST.txt"; done
}
overlay "$PR124" supabase/candidates/postona_threads_oauth_workspace_candidate.sql supabase/tests/postona_threads_oauth_test_fixture.sql
overlay "$PR178" supabase/tests/common_account_write_guard_fixture.sql \
  supabase/migrations/20261010051938_common_account_service_write_guard.sql \
  supabase/migrations/20261012130000_common_account_core_service_fence.sql \
  supabase/migrations/20261012230000_common_account_service_brand_state.sql \
  supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql
mkdir -p "$tree/pr169" && git -C "$repo" show "$PR169:supabase/candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql" > "$tree/pr169/threads_provider_cleanup_candidate.sql"
echo "$PR169 $(shasum -a 256 "$tree/pr169/threads_provider_cleanup_candidate.sql" | cut -c1-16) supabase/candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql (fail-before copy)" >> "$tree/T13_MANIFEST.txt"
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
guards="${THREADS_GUARDS_CANDIDATE:-$c/postona_threads_lifecycle_guards/threads_writer_lifecycle_guards_candidate.sql}"

# ---- 2. The real G5 world -------------------------------------------------------------------------------------
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
q() { local db="$1"; shift; "$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
create_db() { "${as_super[@]}" -d postgres -c "create database $1 owner $owner${2:+ template $2}" > /dev/null; }
copy() { local db="${prefix}_$1"; create_db "$db" "$2"; echo "$db"; }
apply() {
  local db="$1" file="$2" out
  if out="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$file" 2>&1)"; then echo applied
  else sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1; fi
}

world="${prefix}_world"
create_db "$world"
as_owner "$world" -f "$t/social_mobile_account_deletion_fixture.sql" > /dev/null
as_owner "$world" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" > /dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
  as_owner "$world" -f "$m/$f" > /dev/null
done
as_owner "$world" -f "$t/common_account_lifecycle_fixture.sql" > /dev/null
for f in 20261001150000_common_account_lifecycle_foundation.sql 20261006230000_common_account_service_start_intent.sql 20261009120000_common_account_deletion_completion.sql; do
  as_owner "$world" -f "$m/$f" > /dev/null
done
as_owner "$world" -f "$t/common_account_write_guard_fixture.sql" > /dev/null
for f in 20261010051938_common_account_service_write_guard.sql 20261012130000_common_account_core_service_fence.sql 20261012230000_common_account_service_brand_state.sql; do
  [[ "$(apply "$world" "$m/$f")" == applied ]] || fail "G5 $f did not apply"
done
as_owner "$world" -f "$t/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
q "$world" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" > /dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | q "$world" > /dev/null
q "$world" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" > /dev/null
[[ "$(apply "$world" "$m/20261007150000_postona_social_accounts_multi_provider.sql")" == applied ]] || fail "Phase 2a-2 did not apply"
# Phase 6 reads social_accounts.platform (Phase 2a-2), so it comes after it.
[[ "$(apply "$world" "$m/20261013120000_common_account_service_deletion_ownership.sql")" == applied ]] \
  || fail "G5/F5 Phase 6 did not apply: $(apply "$(copy "why6_$RANDOM" "$world")" "$m/20261013120000_common_account_service_deletion_ownership.sql")"
"${as_super[@]}" -d "$world" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' > /dev/null
as_owner "$world" -f "$t/postona_threads_oauth_test_fixture.sql" > /dev/null
for f in "$c/postona_threads_oauth_workspace_candidate.sql" "$c/postona_threads_publish/threads_credential_custody_candidate.sql" \
  "$c/postona_threads_publish/threads_manual_publish_candidate.sql" "$c/postona_threads_publish/threads_publish_release_candidate.sql"; do
  [[ "$(apply "$world" "$f")" == applied ]] || fail "$(basename "$f") did not apply on the real G5 world: $(apply "$(copy "why_$RANDOM" "$world")" "$f")"
done
# Two worlds from here: the cleanup candidate of this branch, and PR #169's (before the live-lease fix).
finish_world() {
  local db="$1" cleanup_file="$2" f
  for f in "$cleanup_file" "$c/postona_threads_disconnect/threads_disconnect_candidate.sql"; do
    [[ "$(apply "$db" "$f")" == applied ]] || fail "$(basename "$f") did not apply on the real G5 world: $(apply "$(copy "why_$RANDOM" "$db")" "$f")"
  done
  as_owner "$db" -f "$t/postona_threads_t13_fixture.sql" > /dev/null
}
world_pr169="$(copy w169 "$world")"
finish_world "$world_pr169" "$tree/pr169/threads_provider_cleanup_candidate.sql"
finish_world "$world" "$c/postona_threads_cleanup/threads_provider_cleanup_candidate.sql"
echo "PASS world: real G5 (T13 + Phase 4 + F5 + Phase 6) + X + 2a-2 + #124 + publish stack + cleanup + disconnect"
# The cleanup candidate refuses to install without G5's cleanup predicate, or with one an API role can run.
db="$(copy no_predicate "$world_pr169")"
q "$db" -c "drop function public.cleanup_threads_provider_footprint(uuid); drop function public.threads_provider_connection_state(uuid); drop function public.threads_cleanup_authorized(uuid); drop function private.account_lifecycle_cleanup_authorized(uuid);" > /dev/null
got="$(apply "$db" "$c/postona_threads_cleanup/threads_provider_cleanup_candidate.sql")"
[[ "$got" == THREADS_CLEANUP_PRECONDITION_LIFECYCLE ]] || fail "cleanup without G5's predicate: $got"
db="$(copy predicate_reachable "$world_pr169")"
q "$db" -c "drop function public.cleanup_threads_provider_footprint(uuid); drop function public.threads_provider_connection_state(uuid); drop function public.threads_cleanup_authorized(uuid);" > /dev/null
"${as_super[@]}" -d "$db" -c "grant execute on function private.account_lifecycle_cleanup_authorized(uuid) to service_role" > /dev/null
got="$(apply "$db" "$c/postona_threads_cleanup/threads_provider_cleanup_candidate.sql")"
[[ "$got" == THREADS_CLEANUP_PRECONDITION_LIFECYCLE ]] || fail "cleanup with G5's predicate reachable by service_role: $got"
echo "PASS cleanup preconditions (G5 predicate missing / reachable by an API role)"

# ---- The live-lease fix: fail before (PR #169) / pass after (this branch), on the real Phase 6 ----------------
# R7: a CLAIMED POSTONA deletion whose lease ends while the cleanup waits for the workspace lock: nothing removed.
race_service_lease() {
  local db="$1" out holder p='00000000-0000-4000-8000-0000000000e9'
  q "$db" -c "select t13.person('$p', 'raceserv'); create table t13.svc as select (public.begin_service_deletion('$p', 'x_autopost') ->> 'operation_id')::uuid as op;
select public.claim_service_deletion('$p', 'x_autopost', (select op from t13.svc));" > /dev/null
  q "$db" -c "begin; select public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace('$p')); select pg_sleep(1.5); commit;" > /dev/null &
  holder=$!; sleep 0.3
  out="$(q "$db" -c "update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() + interval '700 milliseconds' where id = (select op from t13.svc); select public.cleanup_threads_provider_footprint('$p')::text;" 2>&1)" || true
  wait "$holder" || true
  [[ "$out" == *'"code": "LEASE_NOT_HELD"'* ]] || { echo "R7_SERVICE_LEASE ${out//$'\n'/ }"; return 0; }
  [[ "$(q "$db" -c "select count(*) from public.social_accounts where brand_id = public.social_mobile_account_deletion_workspace('$p') and platform = 'threads'")" == 1 ]] \
    || { echo "R7_REMOVED"; return 0; }
  echo PASS
}
lease_proof() {
  local db="$1" tag="$2" out
  out="$(race_service_lease "$(copy "r7_$tag" "$db")")"
  [[ "$out" == PASS ]] || { echo "$out"; return 0; }
  if ! out="$(as_owner "$(copy "lp_$tag" "$db")" -A -t -f "$t/postona_threads_t13_cleanup_lease.sql" 2>&1)"; then
    echo "LEASE_BEHAVIOR $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"; return 0
  fi
  grep -q T13_CLEANUP_LEASE_OK <<<"$out" || { echo "LEASE_BEHAVIOR_INCOMPLETE"; return 0; }
  echo PASS
}
before="$(lease_proof "$world_pr169" pr169)"
[[ "$before" != PASS ]] || fail "fail-before: PR #169's cleanup passed the live-lease proof (the defect is not reproduced)"
echo "PASS fail-before: PR #169 cleanup candidate fails (${before:0:150})"
# The race alone also fails before (it is not only the behavior file that catches it).
before_race="$(race_service_lease "$(copy r7b_pr169 "$world_pr169")")"
[[ "$before_race" != PASS ]] || fail "fail-before: PR #169's cleanup passed the service-lease race"
echo "PASS fail-before (race): ${before_race:0:120}"
# ... and the behavior file alone fails before, at the unclaimed POSTONA deletion.
if before_sql="$(as_owner "$(copy lpb_pr169 "$world_pr169")" -A -t -f "$t/postona_threads_t13_cleanup_lease.sql" 2>&1)"; then
  fail "fail-before: PR #169's cleanup passed postona_threads_t13_cleanup_lease.sql"
fi
before_sql="$(sed -n 's/^.*ERROR: *//p' <<<"$before_sql" | head -1)"
[[ "$before_sql" == *"unclaimed POSTONA deletion"* ]] || fail "fail-before failed for another reason: $before_sql"
echo "PASS fail-before (behavior): ${before_sql:0:140}"
after="$(lease_proof "$world" fix)"
[[ "$after" == PASS ]] || fail "pass-after: $after"
echo "PASS pass-after: this branch's cleanup candidate (R7 service-lease race + postona_threads_t13_cleanup_lease.sql)"

# ---- 3a. Preconditions of the guards candidate ---------------------------------------------------------------
expect_refused() { local label="$1" db="$2" code="$3" got; got="$(apply "$db" "$guards")"; [[ "$got" == "$code" ]] || fail "$label: $got"; }
db="$(copy drift "$world")"
q "$db" -c "create or replace function public.threads_manual_publish_authorize(p_user uuid, p_social_account_id text, p_require_permission boolean) returns text language plpgsql security definer set search_path = '' as \$\$ begin return null; end; \$\$;" > /dev/null
expect_refused "a drifted authorize" "$db" THREADS_GUARDS_PRECONDITION_DRIFT
db="$(copy f5_reachable "$world")"
"${as_super[@]}" -d "$db" -c "grant execute on function private.account_lifecycle_assert_brand_service_active(text,text) to authenticated" > /dev/null
expect_refused "F5 reachable by authenticated" "$db" THREADS_GUARDS_PRECONDITION_G5
db="$(copy f5_missing "$world")"
q "$db" -c "drop function private.account_lifecycle_assert_brand_service_active(text,text)" > /dev/null
expect_refused "F5 missing" "$db" THREADS_GUARDS_PRECONDITION_G5
echo "PASS guards preconditions (drift, F5 missing / reachable)"

# ---- 3b. Two-session races --------------------------------------------------------------------------------------
A='00000000-0000-4000-8000-0000000000a1'   # workspace owner
B='00000000-0000-4000-8000-0000000000b1'   # admin of A's workspace
Z='00000000-0000-4000-8000-0000000000f1'   # not a member
setup_race() {
  q "$1" > /dev/null <<SQL
create or replace function public.threads_disconnect_gate_open() returns boolean language sql immutable set search_path = '' as \$\$ select true \$\$;
create table t13.ids (k text primary key, v text);
insert into t13.ids values ('acct_a', t13.person('$A', 'alice')), ('acct_z', t13.person('$Z', 'zed'));
select t13.login('$B'); select t13.register('$B');
insert into public.brand_memberships (brand_id, user_id, role) values (public.social_mobile_account_deletion_workspace('$A'), '$B', 'admin');
insert into t13.ids values ('att', (t13.as_user('$B', 'begin', (select v from t13.ids where k = 'acct_a'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'race') -> 'attempt' ->> 'attempt_id'));
SQL
}
ws_a="public.social_mobile_account_deletion_workspace('$A')"
# R1: A's POSTONA ends while B's release waits on A's entitlement: F5 decides after the wait.
race_owner_ends() {
  local db="$1" out holder
  setup_race "$db"
  q "$db" -c "begin; update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '$A' and service_key = 'x_autopost'; select pg_sleep(1.5); commit;" > /dev/null &
  holder=$!; sleep 0.3
  out="$(q "$db" -c "select 'ANSWER ' || t13.release('$B', (select v::uuid from t13.ids where k = 'att'), 'create_container')::text" 2>&1)" || true
  wait "$holder" || true
  [[ "$out" == *'"code": "SERVICE_NOT_ACTIVE"'* ]] || { echo "R1_OWNER_ENDS ${out//$'\n'/ }"; return 0; }
  [[ "$(q "$db" -c "select status || coalesce(grant_step, '') from public.threads_manual_publish_attempts where id = (select v::uuid from t13.ids where k = 'att')")" == reserved ]] \
    || { echo "R1_ATTEMPT_MOVED"; return 0; }
  echo PASS
}
# R2: Z names A's account while A's common account row is held: Z is refused at once, without queueing.
race_no_queue() {
  local db="$1" out holder
  setup_race "$db"
  q "$db" -c "begin; update public.common_accounts set status = status where user_id = '$A'; select pg_sleep(2); commit;" > /dev/null &
  holder=$!; sleep 0.3
  out="$(q "$db" -c "select 'ANSWER ' || t13.timed_begin('$Z', (select v from t13.ids where k = 'acct_a'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')" 2>&1)" || true
  wait "$holder" || true
  [[ "$out" == *'ANSWER ACCOUNT_NOT_FOUND true'* ]] || { echo "R2_QUEUED ${out//$'\n'/ }"; return 0; }
  echo PASS
}
# R3/R4: lock order. A freeze holds A's entitlement, then locks A's workspace row. The writer must wait for the
# owner's lifecycle BEFORE taking the workspace row (no deadlock): the freeze commits, the writer is refused.
race_lock_order() {
  local db="$1" call="$2" tag="$3" out holder hold
  setup_race "$db"
  [[ "$call" == permission ]] && q "$db" -c "select t13.as_user('$A', 'permission', (select v from t13.ids where k = 'acct_a'), 'false', 'true')" > /dev/null
  q "$db" -c "begin; update public.service_entitlements set status = 'suspended' where user_id = '$A' and service_key = 'x_autopost'; select pg_sleep(0.7); select 1 from public.brands where id = $ws_a for update; select pg_sleep(0.3); commit;" > "$tree/hold_$tag.log" 2>&1 &
  holder=$!; sleep 0.3
  if [[ "$call" == permission ]]; then
    out="$(q "$db" -c "select 'ANSWER ' || t13.as_user('$B', 'permission', (select v from t13.ids where k = 'acct_a'), 'true', 'false')::text" 2>&1)" || true
  else
    out="$(q "$db" -c "select 'ANSWER ' || t13.as_user('$B', 'begin', (select v from t13.ids where k = 'acct_a'), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'x')::text" 2>&1)" || true
  fi
  hold=0; wait "$holder" || hold=$?
  [[ "$hold" == 0 ]] && ! grep -qi deadlock "$tree/hold_$tag.log" || { echo "R_${tag}_FREEZE_FAILED $(tr '\n' ' ' < "$tree/hold_$tag.log")"; return 0; }
  [[ "$out" == *'"code": "SERVICE_NOT_ACTIVE"'* ]] || { echo "R_${tag}_ANSWER ${out//$'\n'/ }"; return 0; }
  echo PASS
}
# R6: the owner's lifecycle row is held past G5's 3 s lock_timeout: the writer answers BUSY (retryable) and
# nothing changed.
race_busy() {
  local db="$1" out holder
  setup_race "$db"
  q "$db" -c "begin; update public.common_accounts set status = status where user_id = '$A'; select pg_sleep(4); commit;" > /dev/null &
  holder=$!; sleep 0.3
  out="$(q "$db" -c "select 'ANSWER ' || t13.release('$B', (select v::uuid from t13.ids where k = 'att'), 'create_container')::text" 2>&1)" || true
  wait "$holder" || true
  [[ "$out" == *'"code": "BUSY"'* ]] || { echo "R6_BUSY ${out//$'\n'/ }"; return 0; }
  [[ "$(q "$db" -c "select status from public.threads_manual_publish_attempts where id = (select v::uuid from t13.ids where k = 'att')")" == reserved ]] \
    || { echo "R6_ATTEMPT_MOVED"; return 0; }
  echo PASS
}
# R5: PR #124's completion waits on a freeze of the person and is refused after it (nothing written).
race_complete_freeze() {
  local db="$1" out holder p='00000000-0000-4000-8000-0000000000c9'
  q "$db" -c "select t13.login('$p'); select t13.register('$p'); create table t13.oauth as select t13.begin_oauth('$p', 'cate') as id;" > /dev/null
  q "$db" -c "begin; update public.common_accounts set status = 'locked' where user_id = '$p'; select pg_sleep(1.5); commit;" > /dev/null &
  holder=$!; sleep 0.3
  out="$(q "$db" -c "select t13.call('$p', format('select t13.complete_oauth(%L, %L, %L)', '$p', (select id from t13.oauth), 'cate'), 'owner')" 2>&1)" || true
  wait "$holder" || true
  [[ "$out" == '42501 ACCOUNT_LOCKED' ]] || { echo "R5_COMPLETE ${out//$'\n'/ }"; return 0; }
  [[ "$(q "$db" -c "select count(*) from public.social_accounts where brand_id = public.social_mobile_account_deletion_workspace('$p') and connection_status = 'identity_verified'")" == 0 ]] \
    || { echo "R5_WRITTEN"; return 0; }
  echo PASS
}

prove() {
  local file="$1" tag="$2" db out r
  db="$(copy "m_$tag" "$world")"
  [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY $(apply "$(copy "a_$tag" "$world")" "$file")"; return 0; }
  [[ "$(apply "$db" "$file")" == THREADS_GUARDS_PRECONDITION_ALREADY_APPLIED ]] || { echo "REAPPLY"; return 0; }
  for r in owner_ends no_queue lock_permission lock_begin busy complete_freeze; do
    case "$r" in
      busy) out="$(race_busy "$(copy "r6_$tag" "$db")")" ;;
      owner_ends) out="$(race_owner_ends "$(copy "r1_$tag" "$db")")" ;;
      no_queue) out="$(race_no_queue "$(copy "r2_$tag" "$db")")" ;;
      lock_permission) out="$(race_lock_order "$(copy "r3_$tag" "$db")" permission "perm_$tag")" ;;
      lock_begin) out="$(race_lock_order "$(copy "r4_$tag" "$db")" begin "begin_$tag")" ;;
      complete_freeze) [[ "$tag" == real ]] || continue; out="$(race_complete_freeze "$(copy "r5_$tag" "$db")")" ;;
    esac
    [[ "$out" == PASS ]] || { echo "$out"; return 0; }
  done
  if ! out="$(as_owner "$db" -A -t -f "$t/postona_threads_t13_behavior.sql" 2>&1)"; then
    echo "BEHAVIOR $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"; return 0
  fi
  grep -q T13_BEHAVIOR_OK <<<"$out" || { echo "BEHAVIOR_INCOMPLETE"; return 0; }
  echo PASS
}
result="$(prove "$guards" real)"
[[ "$result" == PASS ]] || fail "guards candidate: $result"
echo "PASS guards candidate: apply, re-apply refused, races (owner ends during release, no queue, lock order x2, #124 completion vs freeze), behavior"

mutate() {
  local name="$1" from="$2" to="$3" out="$tree/mut_$1.sql" got
  FROM="$from" TO="$to" perl -0pe 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$guards" > "$out"
  cmp -s "$guards" "$out" && fail "mutation $name: pattern not found"
  got="$(prove "$out" "$name")"
  [[ "$got" != PASS ]] || fail "mutation $name was NOT caught"
  echo "PASS mutation $name caught (${got:0:130})"
}
fence_in_authorize="  v_code := public.threads_manual_publish_owner_fence(v_brand_id);
  if v_code is not null then return v_code; end if;
  select b.* into v_brand from public.brands b where b.id = v_brand_id for share;"
mutate no_owner_fence "$fence_in_authorize" "  select b.* into v_brand from public.brands b where b.id = v_brand_id for share;"
mutate owner_fence_after_row_locks "$fence_in_authorize" "  select b.* into v_brand from public.brands b where b.id = v_brand_id for share;
  v_code := public.threads_manual_publish_owner_fence(v_brand_id);
  if v_code is not null then return v_code; end if;"
mutate no_member_precheck "  if not exists (select 1 from public.brand_memberships m where m.brand_id = v_brand_id and m.user_id = p_user) then
    return 'ACCOUNT_NOT_FOUND';
  end if;
  v_code" "  v_code"
mutate no_early_fence_on_enable "    v_code := public.threads_manual_publish_owner_fence(v_brand_id);
    if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  end if;
  perform 1 from public.brands b" "  end if;
  perform 1 from public.brands b"
mutate owner_unknown_as_service "        when sqlerrm = 'WORKSPACE_OWNER_UNKNOWN' then 'WORKSPACE_INACTIVE'
" ""
mutate busy_as_blocked "    when lock_not_available or deadlock_detected then
      -- ACCOUNT_LIFECYCLE_BUSY (55P03) or any other timed-out wait: retryable, nothing was decided.
      return 'BUSY';
" ""
cat "$tree/T13_MANIFEST.txt"
echo "ALL PASS (RUN: local disposable PG17 with the REAL G5 T13 / Phase 4 / F5 / Phase 6 migrations. NOT_RUN: managed Supabase Auth / PostgREST / Vault, H5 owner transport, Meta, production)"
