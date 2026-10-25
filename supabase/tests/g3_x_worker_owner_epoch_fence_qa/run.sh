#!/usr/bin/env bash
# G3 TASK 29/50 (Issue #318): the X reservation worker between CLAIM and SEND against owner changes, lease expiry, an unknown outcome
# and a changed X identity -- the interleavings beyond G3-28's W4 (a planned row re-claimed after A -> B -> A). THROW-AWAY LOCAL
# PostgreSQL 17, fake people / sessions / claims; X candidates 001-006 READ at PR #392's head with `git show` (unchanged); baseline as
# in PR #466 / #471 / #493. No product file, no managed or production database, no real token, no post.
#
#   CURRENT    every cell equals the pinned answer
#   INVARIANT  fail-closed / no-double-send properties that hold today and must keep holding (asserted): a check after A -> B refuses;
#              an expired lease is fenced to uncertain and never re-claimed; an outcome reported after an owner change is recorded as
#              reported (uncertain / failed), never turned back into a claimable row; a claimed row is never claimed twice
#   PROPOSED   gaps against an owner-epoch binding as Threads 007 does (PR #360): an owner that comes back (A -> B -> A, A -> none -> A)
#              passes the pre-send check / is claimed again; a changed X identity on the same account row passes. Listed by name.
#              Closing them needs G5's owner epoch (PR #457, independent review not done) / G4's connection epoch -- not decided here.
#
#   EF_PGHOST=/private/tmp/<socket> EF_PGPORT=<port> EF_PGSUPER=<local superuser> EF_G5_SOURCE_DIR=<git archive of G5 #371> bash run.sh
# Optional: EF_X_REV (default PR #392's head). EF_PATCH_SQL: a TEST-ONLY SQL file applied before the matrix (the gate self-check; the
# pinned current answers are not checked in that mode). Roles are cluster-wide: run alone.
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${EF_PGHOST:?EF_PGHOST required}"; port="${EF_PGPORT:?EF_PGPORT required}"; super="${EF_PGSUPER:?EF_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: EF_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${EF_G5_SOURCE_DIR:-}"
[[ -n "$g5" && -f "$g5/supabase/migrations/20261012230000_common_account_service_brand_state.sql" ]] || { echo "RUN_NOT_AVAILABLE: EF_G5_SOURCE_DIR" >&2; exit 3; }
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
rev="${EF_X_REV:-f34aab9714f5d4f11388609262d5f64cdcce5ed9}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_g3ef_owner"; apilogin="kb_g3ef_api"; db="kabumori_g3ef_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/g3ef.XXXXXX)"
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

if [ -n "${EF_PATCH_SQL:-}" ]; then own -f "$EF_PATCH_SQL" >/dev/null; echo "PATCH_MODE $EF_PATCH_SQL"; fi
cat "$x/postona_x_oauth_t13_guard/helpers.sql" "$here/fence_matrix.sql" >"$tmp/matrix.sql"
own -f "$tmp/matrix.sql" >"$tmp/matrix.out" 2>&1 || { cat "$tmp/matrix.out"; fail "matrix"; }
grep -q X_WORKER_OWNER_EPOCH_FENCE_MATRIX_DONE "$tmp/matrix.out" || { cat "$tmp/matrix.out"; fail "matrix not done"; }
sed -n 's/^ *RESULT|//p' "$tmp/matrix.out" | sort >"$tmp/actual"
sed 's/^/ACTUAL /' "$tmp/actual"

if [ -z "${EF_PATCH_SQL:-}" ]; then
  sort >"$tmp/current" <<'CUR'
E1_claim_then_A_to_B|claim|claimed
E1_claim_then_A_to_B|pre_publish_check|ok:NOT_PUBLISHABLE
E1_claim_then_A_to_B|row|failed/NOT_PUBLISHABLE_AT_SEND
E2_claim_then_ABA|claim|claimed
E2_claim_then_ABA|pre_publish_check|ok:OK
E2_claim_then_ABA|row|claimed/-
E3_claim_then_A_none_A|claim|claimed
E3_claim_then_A_none_A|pre_publish_check_after_return|ok:OK
E4_planned_A_none_A|claim_after_return|claimed
E4_planned_A_none_A|claim_while_none|not_claimed
E5_claim_ABA_lease_expired|claim|claimed
E5_claim_ABA_lease_expired|next_round|not_claimed
E5_claim_ABA_lease_expired|round_after|not_claimed
E5_claim_ABA_lease_expired|row|uncertain/LEASE_EXPIRED
E6_check_ok_then_ABA_uncertain|claim|claimed
E6_check_ok_then_ABA_uncertain|finish_replay|ERR:POSTONA_RESV_LEASE_LOST
E6_check_ok_then_ABA_uncertain|finish_uncertain|ok:uncertain
E6_check_ok_then_ABA_uncertain|pre_publish_check|ok:OK
E6_check_ok_then_ABA_uncertain|round_after|not_claimed
E6_check_ok_then_ABA_uncertain|row|uncertain/UNCERTAIN
E7_check_ok_then_A_to_B_failed|claim|claimed
E7_check_ok_then_A_to_B_failed|finish_failed_before_send|ok:failed_before_send
E7_check_ok_then_A_to_B_failed|pre_publish_check|ok:OK
E7_check_ok_then_A_to_B_failed|round_after|not_claimed
E7_check_ok_then_A_to_B_failed|row|failed/FAILED_BEFORE_SEND
E8_x_identity_changed|claim|claimed
E8_x_identity_changed|pre_publish_check|ok:OK
E9_second_claim|claim|claimed
E9_second_claim|second_round|not_claimed
CUR
  if ! diff "$tmp/current" "$tmp/actual" >"$tmp/cur.diff"; then cat "$tmp/cur.diff"; fail "today's behaviour differs from the pinned current answers"; fi
  echo "CURRENT_PINNED_PASS ($(wc -l <"$tmp/actual" | tr -d ' ') cells)"
fi

cell() { awk -F'|' -v s="$1" -v k="$2" '$1 == s && $2 == k { print $3 }' "$tmp/actual"; }
[[ "$(cell E1_claim_then_A_to_B pre_publish_check)" == ok:NOT_PUBLISHABLE && "$(cell E1_claim_then_A_to_B row)" == failed/NOT_PUBLISHABLE_AT_SEND ]] || fail "INVARIANT E1 a check after A -> B must refuse"
[[ "$(cell E5_claim_ABA_lease_expired row)" == uncertain/LEASE_EXPIRED && "$(cell E5_claim_ABA_lease_expired next_round)" == not_claimed \
   && "$(cell E5_claim_ABA_lease_expired round_after)" == not_claimed ]] || fail "INVARIANT E5 an expired lease must be fenced, never re-claimed"
[[ "$(cell E6_check_ok_then_ABA_uncertain finish_uncertain)" == ok:uncertain && "$(cell E6_check_ok_then_ABA_uncertain row)" == uncertain/UNCERTAIN \
   && "$(cell E6_check_ok_then_ABA_uncertain round_after)" == not_claimed && "$(cell E6_check_ok_then_ABA_uncertain finish_replay)" == ERR:POSTONA_RESV_LEASE_LOST ]] \
   || fail "INVARIANT E6 an unknown outcome must stay uncertain, never re-claimed, never re-reported"
[[ "$(cell E7_check_ok_then_A_to_B_failed row)" == failed/FAILED_BEFORE_SEND && "$(cell E7_check_ok_then_A_to_B_failed round_after)" == not_claimed ]] \
   || fail "INVARIANT E7 a reported failure must stay failed"
[[ "$(cell E9_second_claim claim)" == claimed && "$(cell E9_second_claim second_round)" == not_claimed ]] || fail "INVARIANT E9 one lease only"
echo "INVARIANTS_PASS (E1 E5 E6 E7 E9: refuse after A -> B; fence an expired lease; record unknown / failed outcomes as reported; one lease)"

sort >"$tmp/proposed" <<'PROP'
E2_claim_then_ABA|pre_publish_check
E3_claim_then_A_none_A|pre_publish_check_after_return
E4_planned_A_none_A|claim_after_return
E8_x_identity_changed|pre_publish_check
PROP
awk -F'|' '
  $1 == "E2_claim_then_ABA" && $2 == "pre_publish_check" && $3 == "ok:OK" { print $1 "|" $2 }
  $1 == "E3_claim_then_A_none_A" && $2 == "pre_publish_check_after_return" && $3 == "ok:OK" { print $1 "|" $2 }
  $1 == "E4_planned_A_none_A" && $2 == "claim_after_return" && $3 == "claimed" { print $1 "|" $2 }
  $1 == "E8_x_identity_changed" && $2 == "pre_publish_check" && $3 == "ok:OK" { print $1 "|" $2 }' "$tmp/actual" | sort >"$tmp/proposed_now"
if ! diff "$tmp/proposed" "$tmp/proposed_now" >"$tmp/prop.diff"; then cat "$tmp/prop.diff"; fail "the PROPOSED gaps changed"; fi
echo "PROPOSED_GAPS $(wc -l <"$tmp/proposed_now" | tr -d ' ') (by name; closing them needs an owner / connection epoch binding)"
sed 's/^/  PROPOSED /' "$tmp/proposed_now"
echo "G3_X_WORKER_OWNER_EPOCH_FENCE_QA_PASS"
