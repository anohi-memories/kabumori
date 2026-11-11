#!/usr/bin/env bash
# G3 TASK 31/50 (Issue #318): X / Threads reservation cancel and receipt against row states, another person, an owner move (the new
# owner's view), a deleted owner, a lease that ran out and the audit trail -- the crosses G3-25 (session states x X entries), G3-26
# (deleted user, X), G3-30 (U8 / U8b / U9) and PR #392's P7 run (D1-D5, I2, Q1) did not cover. THROW-AWAY LOCAL PostgreSQL 17, fake
# people / sessions / claims; X candidates 001-006, Threads candidate 007 and its test doubles / people READ at PR #392's head with
# `git show` (unchanged). No product file, no managed or production database, no real token, no provider call, no post.
#
#   CURRENT_OBSERVED  every cell (except PENDING_POLICY) equals the pinned answer
#   INVARIANT         asserted: another person's row answers exactly as an unknown id (no existence oracle, rows unchanged); the new
#                     owner after a move cannot read or cancel the old owner's rows; no lease token / worker reaches a receipt; a
#                     claimed / finished row cannot be cancelled; a cancel never beats a held claim into a send
#   PROPOSED_GAP      listed by name
#   PENDING_POLICY    recorded only, never compared
#
#   CR_PGHOST=/private/tmp/<socket> CR_PGPORT=<port> CR_PGSUPER=<local superuser> CR_G5_SOURCE_DIR=<git archive of G5 #371> bash run.sh
# Optional: CR_X_REV (default PR #392's head). CR_PATCH_SQL: a TEST-ONLY SQL file applied after 007 (the gate self-check; the pinned
# current answers are not checked in that mode). Roles are cluster-wide: run alone.
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CR_PGHOST:?CR_PGHOST required}"; port="${CR_PGPORT:?CR_PGPORT required}"; super="${CR_PGSUPER:?CR_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CR_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${CR_G5_SOURCE_DIR:-}"
[[ -n "$g5" && -f "$g5/supabase/migrations/20261012230000_common_account_service_brand_state.sql" ]] || { echo "RUN_NOT_AVAILABLE: CR_G5_SOURCE_DIR" >&2; exit 3; }
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
rev="${CR_X_REV:-f34aab9714f5d4f11388609262d5f64cdcce5ed9}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_g3cr_owner"; apilogin="kb_g3cr_api"; db="kabumori_g3cr_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/g3cr.XXXXXX)"
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
         postona_x_oauth_t13_guard/g4_predicate_test_double.sql postona_x_oauth_t13_guard/helpers.sql \
         postona_threads_reservations/007_postona_threads_reservations.sql postona_threads_reservations/tests/g5_verdict_test_double.sql \
         postona_threads_reservations/tests/multi_provider_stand_in.sql postona_threads_reservations/tests/test_tables.sql \
         postona_threads_reservations/tests/people.sql postona_threads_reservations/tests/g4_g5_test_doubles.sql; do
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

q() { "${S[@]}" -d "$db" -At -c "$1"; }

# part X (before the Threads stack is applied)
cat "$x/postona_x_oauth_t13_guard/helpers.sql" "$here/x_matrix.sql" >"$tmp/xm.sql"
own -f "$tmp/xm.sql" >"$tmp/xm.out" 2>&1 || { cat "$tmp/xm.out"; fail "X matrix"; }
grep -q X_CANCEL_RECEIPT_MATRIX_DONE "$tmp/xm.out" || { cat "$tmp/xm.out"; fail "X matrix not done"; }
sed -n 's/^ *RESULT|//p' "$tmp/xm.out" >"$tmp/actual.raw"

# part Threads: the same order as PR #392's postona_threads_reservations_run.sh (test doubles, people 61-99, then 007)
t="$x/postona_threads_reservations/tests"
own -f "$t/g5_verdict_test_double.sql" >/dev/null
own -f "$t/multi_provider_stand_in.sql" >/dev/null
own -f "$t/test_tables.sql" >/dev/null
(cd "$t" && own -f people.sql) >"$tmp/people.out" 2>&1 || { cat "$tmp/people.out"; fail "Threads people"; }
grep -q THREADS_PEOPLE_READY "$tmp/people.out" || { cat "$tmp/people.out"; fail "Threads people not ready"; }
own -f "$x/postona_threads_reservations/007_postona_threads_reservations.sql" >/dev/null
own -f "$t/g4_g5_test_doubles.sql" >/dev/null
echo "THREADS_007_READY"
if [ -n "${CR_PATCH_SQL:-}" ]; then own -f "$CR_PATCH_SQL" >/dev/null; echo "PATCH_MODE $CR_PATCH_SQL"; fi
cat "$x/postona_x_oauth_t13_guard/helpers.sql" "$here/threads_matrix.sql" >"$tmp/tm.sql"
own -f "$tmp/tm.sql" >"$tmp/tm.out" 2>&1 || { cat "$tmp/tm.out"; fail "Threads matrix"; }
grep -q THREADS_CANCEL_RECEIPT_MATRIX_DONE "$tmp/tm.out" || { cat "$tmp/tm.out"; fail "Threads matrix not done"; }
sed -n 's/^ *RESULT|//p' "$tmp/tm.out" >>"$tmp/actual.raw"

# T6 real concurrency: the dispatcher's claim holds the row (3 s); the person's cancel arrives 1 s later
waited() {
  local i
  for i in $(seq 1 30); do
    [ "$(q "select count(*) from pg_stat_activity where datname = '$db' and wait_event_type = 'Lock' and query like '%$1%'")" -ge 1 ] && { echo yes; return 0; }
    sleep 0.1
  done
  echo no
}
t6="$(q "select reservation_id from t_ct.race where tag = 'T6'")"
p66="$(q "select user_id from t_ids.people where n = 66")"
s66="$(q "insert into auth.sessions (user_id) values ('$p66') returning id")"
q "update postona_threads_resv.reservations set scheduled_at = now() - interval '1 second' where id = '$t6'" >/dev/null
own -At -c "begin" -c "set local role postona_resv_worker" -c "select reservation_id from postona_threads_resv.claim_due('ct6', 60, 50)" \
  -c "select pg_sleep(3)" -c "commit" >"$tmp/t6a.out" 2>&1 & pa=$!
sleep 1
own -At -c "begin" -c "select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '{\"sub\":\"$p66\",\"role\":\"authenticated\",\"session_id\":\"$s66\"}', true)" \
  -c "set local role postona_resv_api" -c "select postona_threads_resv.cancel_reservation('$t6')" -c "commit" >"$tmp/t6b.out" 2>&1 & pb=$!
t6w="$(waited cancel_reservation)"
wait "$pa" || { cat "$tmp/t6a.out"; fail "T6 claim"; }
wait "$pb" || true
{ echo "T6_cancel_during_held_claim|claim|$(if grep -q "$t6" "$tmp/t6a.out"; then echo claimed; else echo not_claimed; fi)"
  echo "T6_cancel_during_held_claim|cancel_waited_on_lock|$t6w"
  echo "T6_cancel_during_held_claim|cancel|$(if grep -q 'ERROR: ' "$tmp/t6b.out"; then echo "ERR:$(sed -n 's/.*ERROR: *\([A-Z_0-9]*\).*/\1/p' "$tmp/t6b.out" | head -1)"; else grep -m1 -E '^cancelled$' "$tmp/t6b.out" | sed 's/^/ok:/'; fi)"
  echo "T6_cancel_during_held_claim|row|$(q "select status || '/' || coalesce(outcome_code, '-') from postona_threads_resv.reservations where id = '$t6'")"
} >>"$tmp/actual.raw"

sort "$tmp/actual.raw" >"$tmp/actual"
sed 's/^/ACTUAL /' "$tmp/actual"

pending='^(X4_owner_moved_A_to_B\|A_|T4_deleted_owner\|bodies_left\|)'
grep -E "$pending" "$tmp/actual" | sed 's/^/PENDING_POLICY (recorded, not compared) /'
grep -v -E "$pending" "$tmp/actual" >"$tmp/pinned_actual"
if [ -z "${CR_PATCH_SQL:-}" ]; then
  sort >"$tmp/current" <<'CUR'
T1_other_person_by_state|cancel_cancelled|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T1_other_person_by_state|cancel_claimed|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T1_other_person_by_state|cancel_lease_ran_out|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T1_other_person_by_state|cancel_published|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T1_other_person_by_state|cancel_unknown_id|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T1_other_person_by_state|receipt_cancelled|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T1_other_person_by_state|receipt_claimed|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T1_other_person_by_state|receipt_lease_ran_out|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T1_other_person_by_state|receipt_own_account_foreign_request|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T1_other_person_by_state|receipt_published|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T1_other_person_by_state|receipt_unknown_request|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T1_other_person_by_state|rows_unchanged|cancelled=cancelled/-,claimed=claimed/-,lease_ran_out=uncertain/LEASE_EXPIRED,published=published/PUBLISHED
T2_owner_by_state|cancel_cancelled|ERR:POSTONA_THREADS_RESV_NOT_CANCELLABLE
T2_owner_by_state|cancel_claimed|ERR:POSTONA_THREADS_RESV_NOT_CANCELLABLE
T2_owner_by_state|cancel_lease_ran_out|ERR:POSTONA_THREADS_RESV_NOT_CANCELLABLE
T2_owner_by_state|cancel_published|ERR:POSTONA_THREADS_RESV_NOT_CANCELLABLE
T2_owner_by_state|receipt_cancelled|cancelled/-/-
T2_owner_by_state|receipt_claimed|pending/-/-
T2_owner_by_state|receipt_lease_ran_out_after_sweep|uncertain/-/LEASE_EXPIRED
T2_owner_by_state|receipt_lease_ran_out|uncertain/-/LEASE_EXPIRED
T2_owner_by_state|receipt_published|sent/18000000000000061/PUBLISHED
T2_owner_by_state|row_lease_ran_out_after_sweep|uncertain/LEASE_EXPIRED
T3_new_owner_on_old_rows|B_cancel_A_row|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T3_new_owner_on_old_rows|B_cancel_unknown_id|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T3_new_owner_on_old_rows|B_receipt_A_row|ERR:POSTONA_THREADS_RESV_NOT_FOUND
T3_new_owner_on_old_rows|row|failed/OWNER_EPOCH_CHANGED
T3_new_owner_on_old_rows|worker_claim|not_claimed
T4_deleted_owner|old_token_cancel|cancelled
T4_deleted_owner|old_token_receipt|pending
T4_deleted_owner|row_after_old_token_cancel|cancelled/-
T4_deleted_owner|row_after_worker|failed/WORKSPACE_OWNER_UNKNOWN
T4_deleted_owner|sessions_left|0
T4_deleted_owner|worker_claim|not_claimed
T5_cancel_audit|threads_audit_relations|-
T6_cancel_during_held_claim|cancel_waited_on_lock|yes
T6_cancel_during_held_claim|cancel|ERR:POSTONA_THREADS_RESV_NOT_CANCELLABLE
T6_cancel_during_held_claim|claim|claimed
T6_cancel_during_held_claim|row|claimed/-
X1_other_person_by_state|cancel_cancelled|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|cancel_claimed|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|cancel_failed|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|cancel_published|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|cancel_uncertain|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|cancel_unknown_id|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|get_cancelled|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|get_claimed|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|get_failed|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|get_published|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|get_uncertain|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|get_unknown_id|ERR:POSTONA_RESV_NOT_FOUND
X1_other_person_by_state|rows_unchanged|cancelled=cancelled/-,claimed=claimed/-,failed=failed/X_REJECTED_400,published=published/PUBLISHED,uncertain=uncertain/X_TIMEOUT
X2_owner_by_state|cancel_again_cancelled|ERR:POSTONA_RESV_ALREADY_FINAL
X2_owner_by_state|cancel_audit_rows|1
X2_owner_by_state|cancel_claimed|ERR:POSTONA_RESV_CANCEL_TOO_LATE
X2_owner_by_state|cancel_failed|ERR:POSTONA_RESV_ALREADY_FINAL
X2_owner_by_state|cancel_published|ERR:POSTONA_RESV_ALREADY_FINAL
X2_owner_by_state|cancel_uncertain|ERR:POSTONA_RESV_ALREADY_FINAL
X2_owner_by_state|get_cancelled|ok:cancelled
X2_owner_by_state|get_claimed|ok:claimed
X2_owner_by_state|get_failed|ok:failed
X2_owner_by_state|get_published|ok:published
X2_owner_by_state|get_uncertain|ok:uncertain
X3_receipt_columns|reservation_view|reservation_id,batch_id,draft_id,position,origin,mode,body,scheduled_at,fixed,status,revision,consent_state
X3_receipt_columns|single_post_readback|reservation_id,state,provider_post_id,outcome_code,after_freeze,simulated
X4_owner_moved_A_to_B|B_cancel_A_row|ERR:POSTONA_RESV_NOT_FOUND
X4_owner_moved_A_to_B|B_get_A_row|ERR:POSTONA_RESV_NOT_FOUND
X4_owner_moved_A_to_B|B_get_unknown_id|ERR:POSTONA_RESV_NOT_FOUND
X4_owner_moved_A_to_B|B_list_account|ok:-
X4_owner_moved_A_to_B|row|planned/-
X5_single_post_lease_ran_out|other_person_readback_unknown_id|ERR:POSTONA_RESV_NOT_FOUND
X5_single_post_lease_ran_out|other_person_readback|ERR:POSTONA_RESV_NOT_FOUND
X5_single_post_lease_ran_out|readback_after_sweep|ok:uncertain
X5_single_post_lease_ran_out|readback_expired_before_sweep|ok:pending
X5_single_post_lease_ran_out|readback_live_lease|ok:pending
X5_single_post_lease_ran_out|row_after_begin|claimed/-
X5_single_post_lease_ran_out|row_after_sweep|uncertain/LEASE_EXPIRED
Z_threads_store|published_rows|1
Z_x_store|published_rows|1
CUR
  if ! diff "$tmp/current" "$tmp/pinned_actual" >"$tmp/cur.diff"; then cat "$tmp/cur.diff"; fail "today's behaviour differs from the pinned current answers"; fi
  echo "CURRENT_OBSERVED_PINNED_PASS ($(wc -l <"$tmp/pinned_actual" | tr -d ' ') cells)"
fi

cell() { awk -F'|' -v s="$1" -v k="$2" '$1 == s && $2 == k { print $3 }' "$tmp/actual"; }
inv() { local s="$1" k="$2" want="$3" why="$4"; [[ "$(cell "$s" "$k")" == "$want" ]] || fail "INVARIANT $s $k: $why (got '$(cell "$s" "$k")')"; }
same() { local s="$1" k="$2" ref="$3" why="$4"; [[ -n "$(cell "$s" "$ref")" && "$(cell "$s" "$k")" == "$(cell "$s" "$ref")" ]] || fail "INVARIANT $s $k == $ref: $why (got '$(cell "$s" "$k")' vs '$(cell "$s" "$ref")')"; }
for st in claimed uncertain published failed cancelled; do
  same X1_other_person_by_state "get_$st" get_unknown_id "another person's $st row answers as an unknown id"
  same X1_other_person_by_state "cancel_$st" cancel_unknown_id "another person's $st row answers as an unknown id"
done
inv X1_other_person_by_state rows_unchanged "cancelled=cancelled/-,claimed=claimed/-,failed=failed/X_REJECTED_400,published=published/PUBLISHED,uncertain=uncertain/X_TIMEOUT" "another person changes nothing"
inv X2_owner_by_state cancel_claimed ERR:POSTONA_RESV_CANCEL_TOO_LATE "a claimed row cannot be cancelled"
for st in uncertain published failed; do inv X2_owner_by_state "cancel_$st" ERR:POSTONA_RESV_ALREADY_FINAL "a finished row cannot be cancelled"; done
inv X2_owner_by_state cancel_audit_rows 1 "an X cancel leaves one audit row"
inv X3_receipt_columns reservation_view reservation_id,batch_id,draft_id,position,origin,mode,body,scheduled_at,fixed,status,revision,consent_state "no lease token / worker in a receipt"
inv X3_receipt_columns single_post_readback reservation_id,state,provider_post_id,outcome_code,after_freeze,simulated "no lease token / worker in a readback"
same X4_owner_moved_A_to_B B_get_A_row B_get_unknown_id "the new owner cannot see the old owner's row"
inv X4_owner_moved_A_to_B B_cancel_A_row ERR:POSTONA_RESV_NOT_FOUND "the new owner cannot cancel the old owner's row"
inv X4_owner_moved_A_to_B B_list_account ok:- "the new owner's list does not show the old owner's rows"
inv X4_owner_moved_A_to_B row planned/- "nothing changed the row"
same X5_single_post_lease_ran_out other_person_readback other_person_readback_unknown_id "another person's single post answers as an unknown id"
inv X5_single_post_lease_ran_out readback_after_sweep ok:uncertain "a swept single post reads uncertain"
for st in claimed lease_ran_out published cancelled; do
  same T1_other_person_by_state "cancel_$st" cancel_unknown_id "another person's $st Threads row answers as an unknown id"
  same T1_other_person_by_state "receipt_$st" receipt_unknown_request "another person's $st Threads receipt answers as an unknown request"
done
same T1_other_person_by_state receipt_own_account_foreign_request receipt_unknown_request "a request id from another account answers as unknown"
inv T1_other_person_by_state rows_unchanged "cancelled=cancelled/-,claimed=claimed/-,lease_ran_out=uncertain/LEASE_EXPIRED,published=published/PUBLISHED" "another person changes nothing"
for st in claimed lease_ran_out published cancelled; do inv T2_owner_by_state "cancel_$st" ERR:POSTONA_THREADS_RESV_NOT_CANCELLABLE "only a planned Threads row can be cancelled"; done
inv T2_owner_by_state receipt_lease_ran_out uncertain/-/LEASE_EXPIRED "a claimed row whose lease ran out reads uncertain even before the sweep"
inv T2_owner_by_state receipt_published sent/18000000000000061/PUBLISHED "the receipt of a recorded post"
same T3_new_owner_on_old_rows B_cancel_A_row B_cancel_unknown_id "the new owner cannot cancel the old owner's Threads row"
inv T3_new_owner_on_old_rows B_receipt_A_row ERR:POSTONA_THREADS_RESV_NOT_FOUND "the new owner cannot read the old owner's Threads receipt"
inv T3_new_owner_on_old_rows worker_claim not_claimed "the old owner's row is not sent after the move"
inv T3_new_owner_on_old_rows row failed/OWNER_EPOCH_CHANGED "it is stopped with the owner-epoch reason"
inv T4_deleted_owner worker_claim not_claimed "a deleted owner's row is not sent"
inv T4_deleted_owner row_after_worker failed/WORKSPACE_OWNER_UNKNOWN "it is stopped"
inv T6_cancel_during_held_claim claim claimed "the claim holds the row"
inv T6_cancel_during_held_claim cancel ERR:POSTONA_THREADS_RESV_NOT_CANCELLABLE "a cancel that waited for a claim does not cancel a claimed row"
inv T6_cancel_during_held_claim row claimed/- "the claim wins, one owner of the row"
inv Z_x_store published_rows 1 "only the seeded X success"
inv Z_threads_store published_rows 1 "only the seeded Threads success (simulated)"
echo "INVARIANTS_PASS"

sort >"$tmp/proposed" <<'PROP'
T4_deleted_owner|old_token_cancel
T4_deleted_owner|old_token_receipt
T5_cancel_audit|threads_audit_relations
X5_single_post_lease_ran_out|readback_expired_before_sweep
PROP
awk -F'|' '
  $1 == "X5_single_post_lease_ran_out" && $2 == "readback_expired_before_sweep" && $3 == "ok:pending" { print $1 "|" $2 }
  $1 == "T4_deleted_owner" && $2 == "old_token_receipt" && $3 !~ /^ERR:/ { print $1 "|" $2 }
  $1 == "T4_deleted_owner" && $2 == "old_token_cancel" && $3 == "cancelled" { print $1 "|" $2 }
  $1 == "T5_cancel_audit" && $2 == "threads_audit_relations" && $3 == "-" { print $1 "|" $2 }' "$tmp/actual" | sort >"$tmp/proposed_now"
if ! diff "$tmp/proposed" "$tmp/proposed_now" >"$tmp/prop.diff"; then cat "$tmp/prop.diff"; fail "the PROPOSED gaps changed"; fi
echo "PROPOSED_GAPS $(wc -l <"$tmp/proposed_now" | tr -d ' ') (by name)"
sed 's/^/  PROPOSED_GAP /' "$tmp/proposed_now"
echo "G3_CANCEL_RECEIPT_AUTH_CROSS_QA_PASS"
