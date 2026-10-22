#!/usr/bin/env bash
# G3 TASK 25/50 (Issue #318): revoked-session negative QA for the X reservation candidates' person-facing RPCs, on a THROW-AWAY LOCAL
# PostgreSQL 17 with fake people, sessions and claims. The X candidates (001-006) and their test helpers are READ at PR #392's head
# with `git show` (nothing in them is changed); the G5 chain comes from a read-only copy of G5's tree. No product file, no managed or
# production database, no real token.
#
# It records what each entry answers TODAY (current) and checks it two ways:
#   1. CURRENT: every cell equals the pinned current answer below (a change in today's behaviour is a failure to look at);
#   2. DESIRED: the contract G3 must reach later (G5-11 C-3 -- a signed-out / expired / foreign / unknown / missing / anonymous session,
#      or no claims, is refused with POSTONA_RESV_AUTH_REQUIRED before any row is read). Today's cells that miss it are EXPECTED GAPS,
#      checked BY NAME: the run fails if a gap disappears or a new one appears. Undecided cases (service ended; banned; owner change)
#      are TODO: recorded, never asserted against a desired answer.
#
#   QA_PGHOST=/private/tmp/<socket> QA_PGPORT=<port> QA_PGSUPER=<local superuser> QA_G5_SOURCE_DIR=<git archive of G5 #371> bash qa_run.sh
# Optional: QA_X_REV (default f34aab9714f5d4f11388609262d5f64cdcce5ed9, PR #392's head). Roles are cluster-wide: run alone.
# QA_PATCH_SQL: a TEST-ONLY SQL file applied after 006 (the gate self-check: a model fix must make the run fail with "gaps changed";
# the pinned current answers are not checked in that mode).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${QA_PGHOST:?QA_PGHOST required}"; port="${QA_PGPORT:?QA_PGPORT required}"; super="${QA_PGSUPER:?QA_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: QA_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${QA_G5_SOURCE_DIR:-}"
[[ -n "$g5" && -f "$g5/supabase/migrations/20261012230000_common_account_service_brand_state.sql" ]] || { echo "RUN_NOT_AVAILABLE: QA_G5_SOURCE_DIR" >&2; exit 3; }
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
rev="${QA_X_REV:-f34aab9714f5d4f11388609262d5f64cdcce5ed9}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_g3xq_owner"; apilogin="kb_g3xq_api"; db="kabumori_g3xq_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/g3xq.XXXXXX)"
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
if [ -n "${QA_PATCH_SQL:-}" ]; then own -f "$QA_PATCH_SQL" >/dev/null; echo "PATCH_MODE $QA_PATCH_SQL"; fi
echo "BASELINE_X_001_006_READY"

# the inventory: what postona_resv_api may EXECUTE in schema postona_x_resv (the person-facing surface), and nobody else's reach
inv="$(psql -X -q -A -t -h "$host" -p "$port" -U "$owner" -d "$db" -c "select string_agg(p.oid::regprocedure::text, ' ' order by 1)
  from pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace and has_function_privilege('postona_resv_api', p.oid, 'EXECUTE')")"
echo "INVENTORY postona_resv_api EXECUTE: $inv"
[[ "$inv" == "postona_x_resv.cancel(uuid,integer) postona_x_resv.create_batch(text,uuid,integer,text,jsonb,jsonb) postona_x_resv.get_reservation(uuid) postona_x_resv.list_reservations(text) postona_x_resv.post_now_begin(text,uuid,text,text) postona_x_resv.post_now_preflight(uuid,uuid) postona_x_resv.post_now_readback(uuid) postona_x_resv.post_now_record(uuid,uuid,text,text,text,text) postona_x_resv.reconfirm(uuid,integer,text) postona_x_resv.reschedule(uuid,integer,timestamp with time zone)" ]] \
  || fail "inventory changed"
other="$(psql -X -q -A -t -h "$host" -p "$port" -U "$owner" -d "$db" -c "select count(*) from pg_proc p, unnest(array['anon','authenticated','service_role']) r
  where p.pronamespace = 'postona_x_resv'::regnamespace and has_function_privilege(r, p.oid, 'EXECUTE')")"
[[ "$other" == 0 ]] || fail "an API role reaches postona_x_resv"
echo "INVENTORY_PASS (10 functions for postona_resv_api; anon / authenticated / service_role reach none)"

# the matrix
cat "$x/postona_x_oauth_t13_guard/helpers.sql" "$here/qa_matrix.sql" >"$tmp/matrix.sql"
own -f "$tmp/matrix.sql" >"$tmp/matrix.out" 2>&1 || { cat "$tmp/matrix.out"; fail "matrix"; }
grep -q X_REVOKED_SESSION_QA_MATRIX_DONE "$tmp/matrix.out" || { cat "$tmp/matrix.out"; fail "matrix not done"; }
sed -n 's/^ *RESULT|//p' "$tmp/matrix.out" | sort >"$tmp/actual"
cat "$tmp/actual" | sed 's/^/ACTUAL /'

# 1. CURRENT: today's answers, pinned
sort >"$tmp/current" <<'CUR'
S00_live|cancel|ok:cancelled
S00_live|create_batch|ok:1
S00_live|get_reservation|ok:planned
S00_live|list_reservations|ok:3
S00_live|post_now_begin|ok:claimed
S00_live|post_now_readback|ok:pending
S00_live|reconfirm|ok:planned
S00_live|reschedule|ok:planned
S01_signed_out|cancel|ok:cancelled
S01_signed_out|create_batch|ok:1
S01_signed_out|get_reservation|ok:planned
S01_signed_out|list_reservations|ok:3
S01_signed_out|post_now_begin|ERR:POSTONA_RESV_AUTH_REQUIRED
S01_signed_out|post_now_readback|ok:pending
S01_signed_out|reconfirm|ok:planned
S01_signed_out|reschedule|ok:planned
S02_expired|cancel|ok:cancelled
S02_expired|create_batch|ok:1
S02_expired|get_reservation|ok:planned
S02_expired|list_reservations|ok:3
S02_expired|post_now_begin|ERR:POSTONA_RESV_AUTH_REQUIRED
S02_expired|post_now_readback|ok:pending
S02_expired|reconfirm|ok:planned
S02_expired|reschedule|ok:planned
S03_foreign_session|cancel|ok:cancelled
S03_foreign_session|create_batch|ok:1
S03_foreign_session|get_reservation|ok:planned
S03_foreign_session|list_reservations|ok:3
S03_foreign_session|post_now_begin|ERR:POSTONA_RESV_AUTH_REQUIRED
S03_foreign_session|post_now_readback|ok:pending
S03_foreign_session|reconfirm|ok:planned
S03_foreign_session|reschedule|ok:planned
S04_unknown_session|cancel|ok:cancelled
S04_unknown_session|create_batch|ok:1
S04_unknown_session|get_reservation|ok:planned
S04_unknown_session|list_reservations|ok:3
S04_unknown_session|post_now_begin|ERR:POSTONA_RESV_AUTH_REQUIRED
S04_unknown_session|post_now_readback|ok:pending
S04_unknown_session|reconfirm|ok:planned
S04_unknown_session|reschedule|ok:planned
S05_no_session_id|cancel|ok:cancelled
S05_no_session_id|create_batch|ok:1
S05_no_session_id|get_reservation|ok:planned
S05_no_session_id|list_reservations|ok:3
S05_no_session_id|post_now_begin|ERR:POSTONA_RESV_AUTH_REQUIRED
S05_no_session_id|post_now_readback|ok:pending
S05_no_session_id|reconfirm|ok:planned
S05_no_session_id|reschedule|ok:planned
S06_anonymous|cancel|ok:cancelled
S06_anonymous|create_batch|ok:1
S06_anonymous|get_reservation|ok:planned
S06_anonymous|list_reservations|ok:3
S06_anonymous|post_now_begin|ok:claimed
S06_anonymous|post_now_readback|ok:pending
S06_anonymous|reconfirm|ok:planned
S06_anonymous|reschedule|ok:planned
S07_refreshed|cancel|ok:cancelled
S07_refreshed|create_batch|ok:1
S07_refreshed|get_reservation|ok:planned
S07_refreshed|list_reservations|ok:3
S07_refreshed|post_now_begin|ok:claimed
S07_refreshed|post_now_readback|ok:pending
S07_refreshed|reconfirm|ok:planned
S07_refreshed|reschedule|ok:planned
S08_new_session_after_signout|cancel|ok:cancelled
S08_new_session_after_signout|create_batch|ok:1
S08_new_session_after_signout|get_reservation|ok:planned
S08_new_session_after_signout|list_reservations|ok:3
S08_new_session_after_signout|post_now_begin|ok:claimed
S08_new_session_after_signout|post_now_readback|ok:pending
S08_new_session_after_signout|reconfirm|ok:planned
S08_new_session_after_signout|reschedule|ok:planned
S09_no_claims|cancel|ERR:POSTONA_RESV_AUTH_REQUIRED
S09_no_claims|create_batch|ERR:POSTONA_RESV_AUTH_REQUIRED
S09_no_claims|get_reservation|ERR:POSTONA_RESV_AUTH_REQUIRED
S09_no_claims|list_reservations|ERR:POSTONA_RESV_AUTH_REQUIRED
S09_no_claims|post_now_begin|ERR:POSTONA_RESV_AUTH_REQUIRED
S09_no_claims|post_now_readback|ERR:POSTONA_RESV_AUTH_REQUIRED
S09_no_claims|reconfirm|ERR:POSTONA_RESV_AUTH_REQUIRED
S09_no_claims|reschedule|ERR:POSTONA_RESV_AUTH_REQUIRED
S10_service_ended|cancel|ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE
S10_service_ended|create_batch|ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE
S10_service_ended|get_reservation|ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE
S10_service_ended|list_reservations|ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE
S10_service_ended|post_now_begin|ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE
S10_service_ended|post_now_readback|ok:pending
S10_service_ended|reconfirm|ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE
S10_service_ended|reschedule|ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE
S11_unknown_id|cancel|ERR:POSTONA_RESV_NOT_FOUND
S11_unknown_id|get_reservation|ERR:POSTONA_RESV_NOT_FOUND
S11_user_switch|cancel|ERR:POSTONA_RESV_NOT_FOUND
S11_user_switch|get_reservation|ERR:POSTONA_RESV_NOT_FOUND
S12_user_deleted|auth_users_delete|deleted
S12_user_deleted|list_reservations|ERR:POSTONA_RESV_ACCOUNT_NOT_FOUND
S12_user_deleted|rows_left|3
CUR
if [ -z "${QA_PATCH_SQL:-}" ]; then
  if ! diff "$tmp/current" "$tmp/actual" >"$tmp/cur.diff"; then cat "$tmp/cur.diff"; fail "today's behaviour differs from the pinned current answers"; fi
  echo "CURRENT_PINNED_PASS ($(wc -l <"$tmp/actual" | tr -d ' ') cells)"
fi

# 2. DESIRED: the contract; cells that miss it today are expected gaps, by name
REFUSED="ERR:POSTONA_RESV_AUTH_REQUIRED"
awk -F'|' -v refused="$REFUSED" '
  $1 ~ /^S0[1-6]_|^S09_/ { if ($3 != refused) print $1 "|" $2 }                                 # must be refused before any row
  $1 == "S07_refreshed" || $1 == "S08_new_session_after_signout" { live[$2] = $3; other[$1 "|" $2] = $3 }
  $1 == "S00_live" { base[$2] = $3 }
  $1 == "S11_user_switch" { sw[$2] = $3 } $1 == "S11_unknown_id" { un[$2] = $3 }
  END {
    for (k in other) { split(k, a, "|"); if (other[k] !~ /^ok:/) print k }                        # a live session keeps working
    for (e in sw) if (sw[e] != un[e]) print "S11_user_switch|" e                                  # same answer as an unknown id
  }' "$tmp/actual" | sort >"$tmp/gaps"
sort >"$tmp/expected_gaps" <<'GAPS'
S01_signed_out|cancel
S01_signed_out|create_batch
S01_signed_out|get_reservation
S01_signed_out|list_reservations
S01_signed_out|post_now_readback
S01_signed_out|reconfirm
S01_signed_out|reschedule
S02_expired|cancel
S02_expired|create_batch
S02_expired|get_reservation
S02_expired|list_reservations
S02_expired|post_now_readback
S02_expired|reconfirm
S02_expired|reschedule
S03_foreign_session|cancel
S03_foreign_session|create_batch
S03_foreign_session|get_reservation
S03_foreign_session|list_reservations
S03_foreign_session|post_now_readback
S03_foreign_session|reconfirm
S03_foreign_session|reschedule
S04_unknown_session|cancel
S04_unknown_session|create_batch
S04_unknown_session|get_reservation
S04_unknown_session|list_reservations
S04_unknown_session|post_now_readback
S04_unknown_session|reconfirm
S04_unknown_session|reschedule
S05_no_session_id|cancel
S05_no_session_id|create_batch
S05_no_session_id|get_reservation
S05_no_session_id|list_reservations
S05_no_session_id|post_now_readback
S05_no_session_id|reconfirm
S05_no_session_id|reschedule
S06_anonymous|cancel
S06_anonymous|create_batch
S06_anonymous|get_reservation
S06_anonymous|list_reservations
S06_anonymous|post_now_begin
S06_anonymous|post_now_readback
S06_anonymous|reconfirm
S06_anonymous|reschedule
GAPS
if ! diff "$tmp/expected_gaps" "$tmp/gaps" >"$tmp/gap.diff"; then cat "$tmp/gap.diff"; fail "the desired-contract gaps changed (fixed, or a new gap)"; fi
echo "DESIRED_EXPECTED_GAPS $(wc -l <"$tmp/gaps" | tr -d ' ') (listed by name; 0 is the target of the later fix)"
cat "$tmp/gaps" | sed 's/^/GAP /'
echo "TODO (undecided, not asserted): S10_service_ended (receipts / stopping after the service ended), banned users (not modelled), owner change"
echo "G3_X_RESERVATION_REVOKED_SESSION_QA_PASS"
