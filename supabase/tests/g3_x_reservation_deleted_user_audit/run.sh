#!/usr/bin/env bash
# G3 TASK 26/50 (Issue #318): what happens to X reservations when the person's login (auth.users) is deleted -- the worker's claim and
# pre-send checks, the single-post request, the person's still-signed token, the intended stop / purge order -- on a THROW-AWAY LOCAL
# PostgreSQL 17 with fake people, sessions and claims. The X candidates 001-006 (and F3's X publish stop, 001 of
# postona_x_publish_entitlement, for the control) are READ at PR #392's head with `git show`; nothing in them is changed. The baseline is
# built the same way as PR #466's revoked-session QA. No product file, no managed or production database, no real token, no post.
#
# It records each step (t_od.results), pins today's answers (CURRENT), and checks the desired boundary separately (DESIRED):
#   B1  a deleted person's row is never claimed; a live person's due row in the same round still is (one deletion never stops a round)
#   B2  a row claimed before the deletion is refused at the pre-send check (never OK) and never published
#   B3  a lease that expires after the deletion is fenced (uncertain), never re-claimed
#   B4  a single-post request whose person was deleted mid-way is not OK at its preflight
#   G   (gaps, by name) the person-facing entries still answering for a removed login's still-signed token; rows / bodies / audit left
#       behind after a direct login delete. These are RECORDED, not passed: their fix belongs to the deletion order and to P7 / G5.
#
#   OD_PGHOST=/private/tmp/<socket> OD_PGPORT=<port> OD_PGSUPER=<local superuser> OD_G5_SOURCE_DIR=<git archive of G5 #371> bash run.sh
# Optional: OD_X_REV (default PR #392's head). Roles are cluster-wide: run alone.
# OD_PATCH_SQL: a TEST-ONLY SQL file applied before the matrix (the boundary self-check: a weakened guard must make B1-B4 fail; the
# pinned current answers are not checked in that mode).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${OD_PGHOST:?OD_PGHOST required}"; port="${OD_PGPORT:?OD_PGPORT required}"; super="${OD_PGSUPER:?OD_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: OD_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${OD_G5_SOURCE_DIR:-}"
[[ -n "$g5" && -f "$g5/supabase/migrations/20261012230000_common_account_service_brand_state.sql" ]] || { echo "RUN_NOT_AVAILABLE: OD_G5_SOURCE_DIR" >&2; exit 3; }
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
rev="${OD_X_REV:-f34aab9714f5d4f11388609262d5f64cdcce5ed9}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_g3od_owner"; apilogin="kb_g3od_api"; db="kabumori_g3od_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/g3od.XXXXXX)"
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
         postona_x_publish_entitlement/001_x_publish_entitlement_guard.sql; do
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

# F3's X publish stop (postona_x_publish_entitlement/001), for the intended-order control O6; recorded when it does not apply here
if own -f "$x/postona_x_publish_entitlement/001_x_publish_entitlement_guard.sql" >"$tmp/stop.out" 2>&1; then echo "X_STOP_CANDIDATE_APPLIED"; else echo "X_STOP_CANDIDATE_NOT_APPLIED: $(grep -m1 ERROR "$tmp/stop.out")"; fi

if [ -n "${OD_PATCH_SQL:-}" ]; then own -f "$OD_PATCH_SQL" >/dev/null; echo "PATCH_MODE $OD_PATCH_SQL"; fi
cat "$x/postona_x_oauth_t13_guard/helpers.sql" "$here/orphan_matrix.sql" >"$tmp/matrix.sql"
own -f "$tmp/matrix.sql" >"$tmp/matrix.out" 2>&1 || { cat "$tmp/matrix.out"; fail "matrix"; }
grep -q X_DELETED_USER_AUDIT_MATRIX_DONE "$tmp/matrix.out" || { cat "$tmp/matrix.out"; fail "matrix not done"; }
sed -n 's/^ *RESULT|//p' "$tmp/matrix.out" | sort >"$tmp/actual"
sed 's/^/ACTUAL /' "$tmp/actual"

# CURRENT: today's answers, pinned
sort >"$tmp/current" <<'CUR'
O1_raw_delete_planned|control_row_claimed|true
O1_raw_delete_planned|deleted_row_claimed|false
O1_raw_delete_planned|delete|deleted
O1_raw_delete_planned|footprint_after|memberships=0 accounts=1 sessions=0 common_account=0
O1_raw_delete_planned|row_after_delete|planned/-
O1_raw_delete_planned|row_after_expiry|expired/-
O1_raw_delete_planned|row_after_round|planned/-
O2_claimed_then_deleted|claimed_before_delete|true
O2_claimed_then_deleted|delete|deleted
O2_claimed_then_deleted|pre_publish_check|ok:NOT_PUBLISHABLE
O2_claimed_then_deleted|row_after_check|failed/NOT_PUBLISHABLE_AT_SEND
O3_claimed_deleted_lease_expired|delete|deleted
O3_claimed_deleted_lease_expired|row_after_sweep|uncertain/LEASE_EXPIRED
O4_single_post_deleted_mid_request|begin|ok
O4_single_post_deleted_mid_request|delete|deleted
O4_single_post_deleted_mid_request|preflight_old_claims|ok:NOT_PUBLISHABLE
O4_single_post_deleted_mid_request|row_after_preflight|failed/NOT_PUBLISHABLE_AT_SEND
O5_old_token_after_delete|audit_rows_left|2
O5_old_token_after_delete|bodies_left|2
O5_old_token_after_delete|cancel|ERR:POSTONA_RESV_ACCOUNT_NOT_FOUND
O5_old_token_after_delete|delete|deleted
O5_old_token_after_delete|get_reservation|ERR:POSTONA_RESV_ACCOUNT_NOT_FOUND
O5_old_token_after_delete|list_reservations|ERR:POSTONA_RESV_ACCOUNT_NOT_FOUND
O5_old_token_after_delete|post_now_readback|ok:pending
O5_old_token_after_delete|rows_left|2
O6_stop_then_delete|delete|deleted
O6_stop_then_delete|row_after_delete|cancelled/-
O6_stop_then_delete|row_after_stop|cancelled/-
O6_stop_then_delete|stop|called
O7_purge_order_model|audit_rows_left|1
O7_purge_order_model|purge|purged
O7_purge_order_model|row_after_purge|gone
CUR
if [ -z "${OD_PATCH_SQL:-}" ]; then
  if ! diff "$tmp/current" "$tmp/actual" >"$tmp/cur.diff"; then cat "$tmp/cur.diff"; fail "today's behaviour differs from the pinned current answers"; fi
  echo "CURRENT_PINNED_PASS ($(wc -l <"$tmp/actual" | tr -d ' ') cells)"
fi

# DESIRED: the boundary B1-B4 must hold today (a failure here is a release blocker, not a gap)
cell() { awk -F'|' -v s="$1" -v k="$2" '$1 == s && $2 == k { print $3 }' "$tmp/actual"; }
[[ "$(cell O1_raw_delete_planned deleted_row_claimed)" == false ]] || fail "B1 a deleted person's row was claimed"
[[ "$(cell O1_raw_delete_planned control_row_claimed)" == true ]] || fail "B1 the round stopped for a live person"
[[ "$(cell O2_claimed_then_deleted pre_publish_check)" != ok:OK ]] || fail "B2 the pre-send check answered OK after the deletion"
[[ "$(cell O3_claimed_deleted_lease_expired row_after_sweep)" == uncertain/LEASE_EXPIRED ]] || fail "B3 the expired lease was not fenced"
[[ "$(cell O4_single_post_deleted_mid_request preflight_old_claims)" != ok:OK ]] || fail "B4 the single-post preflight answered OK after the deletion"
echo "DESIRED_BOUNDARY_B1_B4_PASS (no row of a deleted person is claimed or passes a pre-send check; nothing published)"

# G: what is left / still answering after a direct login delete -- expected gaps by name (the run fails if one disappears or appears)
awk -F'|' '
  $1 == "O5_old_token_after_delete" && ($2 == "list_reservations" || $2 == "get_reservation" || $2 == "cancel" || $2 == "post_now_readback") && $3 != "ERR:POSTONA_RESV_AUTH_REQUIRED" { print $1 "|" $2 }
  $1 == "O5_old_token_after_delete" && ($2 == "rows_left" || $2 == "bodies_left" || $2 == "audit_rows_left") && $3 != "0" { print $1 "|" $2 }
  $1 == "O1_raw_delete_planned" && $2 == "row_after_delete" && $3 != "gone" { print $1 "|" $2 }' "$tmp/actual" | sort >"$tmp/gaps"
sort >"$tmp/expected_gaps" <<'GAPS'
O1_raw_delete_planned|row_after_delete
O5_old_token_after_delete|audit_rows_left
O5_old_token_after_delete|bodies_left
O5_old_token_after_delete|cancel
O5_old_token_after_delete|get_reservation
O5_old_token_after_delete|list_reservations
O5_old_token_after_delete|post_now_readback
O5_old_token_after_delete|rows_left
GAPS
if ! diff "$tmp/expected_gaps" "$tmp/gaps" >"$tmp/gap.diff"; then cat "$tmp/gap.diff"; fail "the recorded gaps changed"; fi
echo "RECORDED_GAPS $(wc -l <"$tmp/gaps" | tr -d ' ') (by name; their fix is the deletion order / P7, not this test)"
sed 's/^/GAP /' "$tmp/gaps"
echo "TODO (undecided, not asserted): whether reservation bodies / audit must be erased when the login is deleted (deletion policy), service end, owner change"
echo "G3_X_DELETED_USER_AUDIT_PASS"
