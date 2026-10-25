#!/usr/bin/env bash
# G3 TASK 30/50 (Issue #318): the X reservation worker's UNKNOWN / idempotency interleavings -- a lost success response, a send that
# outlives its lease (finish first vs sweep first), finish replays and a real concurrent finish, a crash between the check and the
# send, a hand-back after the lease deadline, cancel against claim / hand-back / a held cancel lock, cancel while not owner, a check
# with less lease left than the provider timeout -- plus a mock run of the worker module itself for the orders its own tests do not
# cover. THROW-AWAY LOCAL PostgreSQL 17, fake people / sessions / claims; X candidates 001-006 and worker.ts READ at PR #392's head
# with `git show` (unchanged); baseline as in PR #466 / #471 / #493 / #495. No product file, no managed or production database, no
# real token, no provider call, no post. G3-29 E1-E9 and the G3-25 / G3-26 / G3-28 cells are not repeated.
#
#   CURRENT_OBSERVED  every cell (except PENDING_POLICY) equals the pinned answer
#   INVARIANT         asserted: an unknown outcome is never turned into a send or a success; a finish is idempotent only for the
#                     same lease + the same success; two finishes on one lease record exactly one outcome; cancel never races a claim
#                     into a send; a hand-back after a sweep is refused
#   PROPOSED_GAP      listed by name (late-success evidence lost when the sweep wins; no minimum lease left at the check)
#   PENDING_POLICY    recorded only, never compared (cancel while not owner)
#
#   UX_PGHOST=/private/tmp/<socket> UX_PGPORT=<port> UX_PGSUPER=<local superuser> UX_G5_SOURCE_DIR=<git archive of G5 #371> bash run.sh
# Optional: UX_X_REV (default PR #392's head). UX_PATCH_SQL: a TEST-ONLY SQL file applied before the matrix (the gate self-check; the
# pinned current answers are not checked in that mode). Roles are cluster-wide: run alone. Needs deno for the worker mock run.
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${UX_PGHOST:?UX_PGHOST required}"; port="${UX_PGPORT:?UX_PGPORT required}"; super="${UX_PGSUPER:?UX_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: UX_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${UX_G5_SOURCE_DIR:-}"
[[ -n "$g5" && -f "$g5/supabase/migrations/20261012230000_common_account_service_brand_state.sql" ]] || { echo "RUN_NOT_AVAILABLE: UX_G5_SOURCE_DIR" >&2; exit 3; }
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
rev="${UX_X_REV:-f34aab9714f5d4f11388609262d5f64cdcce5ed9}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_g3ux_owner"; apilogin="kb_g3ux_api"; db="kabumori_g3ux_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/g3ux.XXXXXX)"
drop_roles() { "${S[@]}" -d postgres -c "drop role if exists $apilogin" -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true; }
cleanup() { rm -rf "$tmp"; "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true; drop_roles; }
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

# the X candidates and helpers exactly as PR #392's head has them (read-only)
c="supabase/candidates"
for f in postona_x_reservations/001_postona_x_reservations.sql postona_x_reservations/002_postona_x_resv_api_role.sql \
         postona_x_reservations/003_postona_x_resv_g5_binding.sql postona_x_reservations/004_postona_x_resv_dispatch.sql \
         postona_x_reservations/005_postona_x_single_post.sql postona_x_reservations/006_postona_x_single_post_live_fence.sql \
         postona_x_publish_entitlement/test_stand_ins.sql postona_x_oauth_t13_guard/001_x_oauth_t13_guard.sql \
         postona_x_oauth_t13_guard/g4_predicate_test_double.sql postona_x_oauth_t13_guard/helpers.sql; do
  mkdir -p "$tmp/x/$(dirname "$f")"; git -C "$repo" show "$rev:$c/$f" >"$tmp/x/$f" || fail "git show $rev:$c/$f"
done
x="$tmp/x"

drop_roles
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
# the same production-shaped baseline as PR #392's single_post_live_fence_run.sh (G5 chain, F5 brand state, guarded onboarding + G4
# test double), then the X candidates 001-006
own -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified 20260928160000_social_mobile_account_deletion_candidate; do own -f "$m/$f.sql" >/dev/null; done
own -f "$tests/common_account_lifecycle_fixture.sql" >/dev/null
for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion; do own -f "$m/$f.sql" >/dev/null; done
own -f "$tests/common_account_write_guard_fixture.sql" >/dev/null
"${S[@]}" -d "$db" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
for f in 20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state; do own -f "$m/$f.sql" >/dev/null; done
own -f "$x/postona_x_publish_entitlement/test_stand_ins.sql" >/dev/null
own -f "$repo/supabase/migrations/20261006160200_x_account_publish_authority.sql" >/dev/null
own -f "$x/postona_x_oauth_t13_guard/001_x_oauth_t13_guard.sql" >/dev/null
own -f "$x/postona_x_reservations/001_postona_x_reservations.sql" >/dev/null
own -f "$x/postona_x_reservations/002_postona_x_resv_api_role.sql" >/dev/null
own -f "$x/postona_x_reservations/003_postona_x_resv_g5_binding.sql" >/dev/null
own -f "$x/postona_x_oauth_t13_guard/g4_predicate_test_double.sql" >/dev/null
own -f "$x/postona_x_reservations/004_postona_x_resv_dispatch.sql" >/dev/null
"${S[@]}" -d postgres -c "create role $apilogin login noinherit" -c "grant postona_resv_api to $apilogin" \
  -c "grant postona_resv_api to $owner with inherit false, set true" -c "grant postona_resv_worker to $owner with inherit false, set true" >/dev/null
own -f "$x/postona_x_reservations/005_postona_x_single_post.sql" >/dev/null
own -f "$x/postona_x_reservations/006_postona_x_single_post_live_fence.sql" >/dev/null
echo "BASELINE_X_001_006_READY"


# the worker module as PR #392's head has it, driven by fake stores / publishers (no network, no database)
mkdir -p "$tmp/deno"
git -C "$repo" show "$rev:supabase/functions/_shared/postona_reservations/worker.ts" >"$tmp/deno/worker.ts" || fail "git show worker.ts"
cp "$here/worker_mock_test.ts" "$tmp/deno/worker_mock_test.ts"
(cd "$tmp/deno" && NO_COLOR=1 deno test --no-config --no-prompt worker_mock_test.ts) >"$tmp/deno.out" 2>&1 || { cat "$tmp/deno.out"; fail "worker mock run"; }
grep -E '^ok \| 4 passed \| 0 failed' "$tmp/deno.out" >"$tmp/deno.sum" || { cat "$tmp/deno.out"; fail "worker mock: expected 4 passed"; }
sed 's/^/WORKER_MOCK /' "$tmp/deno.sum"

if [ -n "${UX_PATCH_SQL:-}" ]; then own -f "$UX_PATCH_SQL" >/dev/null; echo "PATCH_MODE $UX_PATCH_SQL"; fi
cat "$x/postona_x_oauth_t13_guard/helpers.sql" "$here/unknown_matrix.sql" >"$tmp/matrix.sql"
own -f "$tmp/matrix.sql" >"$tmp/matrix.out" 2>&1 || { cat "$tmp/matrix.out"; fail "matrix"; }
grep -q X_WORKER_UNKNOWN_IDEMPOTENCY_MATRIX_DONE "$tmp/matrix.out" || { cat "$tmp/matrix.out"; fail "matrix not done"; }
sed -n 's/^ *RESULT|//p' "$tmp/matrix.out" >"$tmp/actual.raw"

# real concurrency: two sessions; the superuser watches pg_stat_activity for the second one waiting on a lock
q() { "${S[@]}" -d "$db" -At -c "$1"; }
waited() {
  local i
  for i in $(seq 1 30); do
    [ "$(q "select count(*) from pg_stat_activity where datname = '$db' and wait_event_type = 'Lock' and query like '%$1%'")" -ge 1 ] && { echo yes; return 0; }
    sleep 0.1
  done
  echo no
}
answer() { if grep -q 'ERROR: ' "$1"; then echo "ERR:$(sed -n 's/.*ERROR: *\([A-Z_0-9]*\).*/\1/p' "$1" | head -1)"; else echo "ok:$(tr -d '\n' <"$1")"; fi; }

# U5 published holds the row (3 s), uncertain arrives 1 s later on the same lease
u5="$(q "select reservation_id from t_ux.race where tag = 'U5'")"; u5l="$(q "select lease_token from t_ux.race where tag = 'U5'")"
own -At -c "begin" -c "set local role postona_resv_worker" -c "select postona_x_resv.finish('$u5', '$u5l', 'published', '1000000005', null)" \
  -c "select pg_sleep(3)" -c "commit" >"$tmp/u5a.out" 2>&1 & pa=$!
sleep 1
own -At -c "set role postona_resv_worker" -c "select postona_x_resv.finish('$u5', '$u5l', 'uncertain', null, 'X_TIMEOUT')" >"$tmp/u5b.out" 2>&1 & pb=$!
u5w="$(waited X_TIMEOUT)"
wait "$pa" || { cat "$tmp/u5a.out"; fail "U5 first finish"; }
wait "$pb" || true
{ echo "U5_concurrent_finish|first_published|$(answer "$tmp/u5a.out")"
  echo "U5_concurrent_finish|second_waited_on_row_lock|$u5w"
  echo "U5_concurrent_finish|second_uncertain|$(answer "$tmp/u5b.out")"
  echo "U5_concurrent_finish|row|$(q "select status || '/' || coalesce(outcome_code, '-') || '/' || coalesce(provider_post_id, '-') from postona_x_resv.reservations where id = '$u5'")"
  echo "U5_concurrent_finish|finish_audit_rows|$(q "select count(*) from postona_x_resv.audit where reservation_id = '$u5' and action = 'finish'")"
} >>"$tmp/actual.raw"

# U8b the person's cancel holds the row (3 s); a claim round runs meanwhile
u8="$(q "select reservation_id from t_ux.race where tag = 'U8b'")"; u8r="$(q "select revision from t_ux.race where tag = 'U8b'")"
q "update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute' where id = '$u8'" >/dev/null
u8c="$(q "select jsonb_build_object('sub', user_id, 'role', 'authenticated', 'session_id', session)::text from t_ux.people where n = 509")"
own -At -c "begin" -c "select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '$u8c', true)" -c "set local role postona_resv_api" \
  -c "select status from postona_x_resv.cancel('$u8', $u8r)" -c "select pg_sleep(3)" -c "commit" >"$tmp/u8a.out" 2>&1 & pa=$!
sleep 1
own -At -c "set role postona_resv_worker" -c "select coalesce(string_agg(reservation_id::text, ','), '-') from postona_x_resv.claim_due('ux_race', 60, 50)" >"$tmp/u8b.out" 2>&1 & pb=$!
u8w="$(waited claim_due)"
wait "$pa" || { cat "$tmp/u8a.out"; fail "U8b cancel"; }
wait "$pb" || true
{ echo "U8b_claim_during_held_cancel|cancel|$(if grep -q 'ERROR: ' "$tmp/u8a.out"; then answer "$tmp/u8a.out"; else grep -m1 -E '^(cancelled|planned|claimed)$' "$tmp/u8a.out" | sed 's/^/ok:/'; fi)"
  echo "U8b_claim_during_held_cancel|claim_waited_on_lock|$u8w"
  echo "U8b_claim_during_held_cancel|claim_round|$(if grep -q 'ERROR: ' "$tmp/u8b.out"; then answer "$tmp/u8b.out"; elif grep -q "$u8" "$tmp/u8b.out"; then echo claimed; else echo not_claimed; fi)"
  echo "U8b_claim_during_held_cancel|row|$(q "select status || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = '$u8'")"
} >>"$tmp/actual.raw"

sort "$tmp/actual.raw" >"$tmp/actual"
sed 's/^/ACTUAL /' "$tmp/actual"
q "select count(*) from postona_x_resv.reservations where status = 'published'" | sed 's/^/PUBLISHED_ROWS (U4 and U5 records only; no provider call) /'

grep '^U9_' "$tmp/actual" | sed 's/^/PENDING_POLICY (recorded, not compared) /'
grep -v '^U9_' "$tmp/actual" >"$tmp/pinned_actual"
if [ -z "${UX_PATCH_SQL:-}" ]; then
  sort >"$tmp/current" <<'CUR'
U10_check_with_short_lease|claim|claimed
U10_check_with_short_lease|pre_publish_check|ok:OK
U10_check_with_short_lease|row|claimed/-
U1_success_lost_then_late_success|cancel_after|ERR:POSTONA_RESV_ALREADY_FINAL
U1_success_lost_then_late_success|claim|claimed
U1_success_lost_then_late_success|finish_uncertain|ok:uncertain
U1_success_lost_then_late_success|late_id_kept|0
U1_success_lost_then_late_success|late_published|ERR:POSTONA_RESV_LEASE_LOST
U1_success_lost_then_late_success|next_round|not_claimed
U1_success_lost_then_late_success|pre_publish_check|ok:OK
U1_success_lost_then_late_success|row|uncertain/X_TIMEOUT
U2_send_past_lease_finish_first|claim|claimed
U2_send_past_lease_finish_first|finish_published|ok:lease_lost
U2_send_past_lease_finish_first|id_kept|1
U2_send_past_lease_finish_first|next_round|not_claimed
U2_send_past_lease_finish_first|pre_publish_check|ok:OK
U2_send_past_lease_finish_first|row|uncertain/LEASE_EXPIRED_AT_FINISH
U3_send_past_lease_sweep_first|claim|claimed
U3_send_past_lease_sweep_first|finish_published|ERR:POSTONA_RESV_LEASE_LOST
U3_send_past_lease_sweep_first|id_kept|0
U3_send_past_lease_sweep_first|pre_publish_check|ok:OK
U3_send_past_lease_sweep_first|row_after_sweep|uncertain/LEASE_EXPIRED
U3_send_past_lease_sweep_first|sweep_round|not_claimed
U4_finish_replays|claim|claimed
U4_finish_replays|finish_audit_rows|1
U4_finish_replays|finish_published|ok:published
U4_finish_replays|pre_publish_check|ok:OK
U4_finish_replays|replay_failed_before_send|ERR:POSTONA_RESV_LEASE_LOST
U4_finish_replays|replay_other_id|ERR:POSTONA_RESV_LEASE_LOST
U4_finish_replays|replay_same_id|ok:published
U4_finish_replays|replay_uncertain|ERR:POSTONA_RESV_LEASE_LOST
U4_finish_replays|replay_wrong_lease|ERR:POSTONA_RESV_LEASE_LOST
U4_finish_replays|row|published/PUBLISHED/1000000004
U5_concurrent_finish|claim|claimed
U5_concurrent_finish|finish_audit_rows|1
U5_concurrent_finish|first_published|ok:published
U5_concurrent_finish|pre_publish_check|ok:OK
U5_concurrent_finish|row|published/PUBLISHED/1000000005
U5_concurrent_finish|second_uncertain|ERR:POSTONA_RESV_LEASE_LOST
U5_concurrent_finish|second_waited_on_row_lock|yes
U6_crash_after_check_before_send|cancel_after|ERR:POSTONA_RESV_ALREADY_FINAL
U6_crash_after_check_before_send|claim|claimed
U6_crash_after_check_before_send|late_release_unsent|ok:lease_lost
U6_crash_after_check_before_send|pre_publish_check|ok:OK
U6_crash_after_check_before_send|row|uncertain/LEASE_EXPIRED
U6_crash_after_check_before_send|sweep_round|not_claimed
U7_release_after_deadline_before_sweep|claim|claimed
U7_release_after_deadline_before_sweep|next_round|claimed
U7_release_after_deadline_before_sweep|release_unsent|ok:released
U7_release_after_deadline_before_sweep|row|planned/-
U8_cancel_vs_claim_and_hand_back|cancel_after_hand_back|ok:cancelled
U8_cancel_vs_claim_and_hand_back|cancel_while_claimed|ERR:POSTONA_RESV_CANCEL_TOO_LATE
U8_cancel_vs_claim_and_hand_back|claim|claimed
U8_cancel_vs_claim_and_hand_back|next_round|not_claimed
U8_cancel_vs_claim_and_hand_back|release_unsent|ok:released
U8_cancel_vs_claim_and_hand_back|row|cancelled/-
U8_cancel_vs_claim_and_hand_back|stale_lease_check|ok:LEASE_LOST
U8b_claim_during_held_cancel|cancel|ok:cancelled
U8b_claim_during_held_cancel|claim_round|not_claimed
U8b_claim_during_held_cancel|claim_waited_on_lock|yes
U8b_claim_during_held_cancel|row|cancelled/-
Z_store|published_rows_other_than_U4|0
CUR
  if ! diff "$tmp/current" "$tmp/pinned_actual" >"$tmp/cur.diff"; then cat "$tmp/cur.diff"; fail "today's behaviour differs from the pinned current answers"; fi
  echo "CURRENT_OBSERVED_PINNED_PASS ($(wc -l <"$tmp/pinned_actual" | tr -d ' ') cells)"
fi

cell() { awk -F'|' -v s="$1" -v k="$2" '$1 == s && $2 == k { print $3 }' "$tmp/actual"; }
inv() { local s="$1" k="$2" want="$3" why="$4"; [[ "$(cell "$s" "$k")" == "$want" ]] || fail "INVARIANT $s $k: $why (got '$(cell "$s" "$k")')"; }
inv U1_success_lost_then_late_success finish_uncertain ok:uncertain "an unknown outcome is recorded as uncertain"
inv U1_success_lost_then_late_success late_published ERR:POSTONA_RESV_LEASE_LOST "a late success never overwrites uncertain"
inv U1_success_lost_then_late_success row uncertain/X_TIMEOUT "uncertain stays uncertain"
inv U1_success_lost_then_late_success next_round not_claimed "uncertain is never claimed again"
inv U1_success_lost_then_late_success cancel_after ERR:POSTONA_RESV_ALREADY_FINAL "uncertain is final for the person"
inv U2_send_past_lease_finish_first finish_published ok:lease_lost "a success after the lease deadline is never recorded as success"
inv U2_send_past_lease_finish_first row uncertain/LEASE_EXPIRED_AT_FINISH "fenced to uncertain"
inv U2_send_past_lease_finish_first next_round not_claimed "never claimed again"
inv U3_send_past_lease_sweep_first row_after_sweep uncertain/LEASE_EXPIRED "the sweep fences an expired lease"
inv U3_send_past_lease_sweep_first finish_published ERR:POSTONA_RESV_LEASE_LOST "a success after the sweep is never recorded as success"
inv U4_finish_replays replay_same_id ok:published "the same success on the same lease is idempotent"
inv U4_finish_replays replay_other_id ERR:POSTONA_RESV_LEASE_LOST "another provider id is refused"
inv U4_finish_replays replay_uncertain ERR:POSTONA_RESV_LEASE_LOST "a recorded success is never downgraded"
inv U4_finish_replays replay_failed_before_send ERR:POSTONA_RESV_LEASE_LOST "a recorded success is never downgraded"
inv U4_finish_replays replay_wrong_lease ERR:POSTONA_RESV_LEASE_LOST "another lease is refused"
inv U4_finish_replays row published/PUBLISHED/1000000004 "exactly the first success"
inv U4_finish_replays finish_audit_rows 1 "one recorded finish"
inv U5_concurrent_finish second_uncertain ERR:POSTONA_RESV_LEASE_LOST "the second finish on one lease is refused"
inv U5_concurrent_finish row published/PUBLISHED/1000000005 "exactly one outcome"
inv U5_concurrent_finish finish_audit_rows 1 "one recorded finish"
inv U6_crash_after_check_before_send row uncertain/LEASE_EXPIRED "a crashed lease is fenced (not re-sent)"
inv U6_crash_after_check_before_send late_release_unsent ok:lease_lost "a hand-back after the sweep is refused"
inv U8_cancel_vs_claim_and_hand_back cancel_while_claimed ERR:POSTONA_RESV_CANCEL_TOO_LATE "a claimed row cannot be cancelled"
inv U8_cancel_vs_claim_and_hand_back cancel_after_hand_back ok:cancelled "a handed-back row can be cancelled"
inv U8_cancel_vs_claim_and_hand_back next_round not_claimed "a cancelled row is never claimed"
inv U8_cancel_vs_claim_and_hand_back stale_lease_check ok:LEASE_LOST "the old lease cannot pass the check"
inv U8b_claim_during_held_cancel claim_round not_claimed "a claim never takes a row a cancel holds"
inv U8b_claim_during_held_cancel row cancelled/- "the cancel wins"
inv Z_store published_rows_other_than_U4 0 "before the races, only U4 recorded a success (no unknown outcome became one)"
echo "INVARIANTS_PASS"

sort >"$tmp/proposed" <<'PROP'
U10_check_with_short_lease|pre_publish_check
U1_success_lost_then_late_success|late_id_kept
U3_send_past_lease_sweep_first|id_kept
PROP
awk -F'|' '
  $1 == "U1_success_lost_then_late_success" && $2 == "late_id_kept" && $3 == "0" { print $1 "|" $2 }
  $1 == "U3_send_past_lease_sweep_first" && $2 == "id_kept" && $3 == "0" { print $1 "|" $2 }
  $1 == "U10_check_with_short_lease" && $2 == "pre_publish_check" && $3 == "ok:OK" { print $1 "|" $2 }' "$tmp/actual" | sort >"$tmp/proposed_now"
if ! diff "$tmp/proposed" "$tmp/proposed_now" >"$tmp/prop.diff"; then cat "$tmp/prop.diff"; fail "the PROPOSED gaps changed"; fi
echo "PROPOSED_GAPS $(wc -l <"$tmp/proposed_now" | tr -d ' ') (by name)"
sed 's/^/  PROPOSED_GAP /' "$tmp/proposed_now"
echo "G3_X_WORKER_UNKNOWN_IDEMPOTENCY_QA_PASS"
