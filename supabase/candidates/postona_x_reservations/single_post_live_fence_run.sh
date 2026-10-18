#!/usr/bin/env bash
# POSTONA X single manual post -- 006 live pre-send fence (M1-F1) and honest record (M1-F3) -- proof on a disposable LOCAL
# PostgreSQL only. Never a remote project. Same production-shaped baseline as single_post_run.sh (G5/F5 candidate SOURCE
# with the Phase 5 brand state, Stage 3B authority, PR #257's guarded onboarding + G4 TEST DOUBLE, reservations 001-004),
# (the deletion fixture already carries the refresh core's x_account_refresh_state_v2 shape), then 005. Then:
#   FB  fail-before on 005 alone: each M1-F1 gap lets a send through;
#   S0  006 refusals (005 / F5 brand state missing or widened), atomic apply, re-apply refused;
#   L   SQL behaviour of 006 (ACL, live fence at begin and right before the send, generation binding, record / after_freeze);
#   R   races: a lifecycle freeze committed while the preflight waits on G5's locks (live read, never a stale pass);
#   E   the REAL single-post HTTP handler -> driver -> SQL -> generation-bound fake G4 -> fake X end to end;
#   RB  rollback restores 005 exactly (bodies + grants); re-apply.
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> \
#        RESV_G5_SOURCE_DIR=<dir with supabase/migrations + supabase/tests of the G5 candidate commit> single_post_live_fence_run.sh
# The cluster must also listen on 127.0.0.1 (trust auth). Optional: LIVE_FENCE_CANDIDATE / LIVE_FENCE_ROLLBACK (mutation runs).
# MOCK_ONLY: G4, Auth answers, the credential source and X. Roles are cluster-wide: run alone.
set -euo pipefail

host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${RESV_G5_SOURCE_DIR:-}"
if [[ -z "$g5" || ! -f "$g5/supabase/migrations/20261012230000_common_account_service_brand_state.sql" ]]; then
  echo "RUN_NOT_AVAILABLE: RESV_G5_SOURCE_DIR does not hold the G5 candidate source" >&2; exit 3
fi
export LC_ALL=C PGTZ=UTC

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
candidate="${LIVE_FENCE_CANDIDATE:-$here/006_postona_x_single_post_live_fence.sql}"
rollback="${LIVE_FENCE_ROLLBACK:-$here/006_postona_x_single_post_live_fence_rollback.sql}"
lf="$here/single_post_live_fence"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_postona_sp_owner"
apilogin="kb_postona_lf_api"
db="kabumori_postona_lf_$$"
plain="kabumori_postona_lf_plain_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-lf.XXXXXX)"
drop_roles() {
  "${S[@]}" -d postgres -c "drop role if exists $apilogin" -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true
}
cleanup() {
  rm -rf "$tmp"
  for d in "$db" "$plain"; do "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done
  drop_roles
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

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
create database $plain owner $owner;
SQL
own() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
val() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }

own "$db" -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
own "$db" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
own "$db" -f "$m/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
own "$db" -f "$m/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
own "$db" -f "$tests/common_account_lifecycle_fixture.sql" >/dev/null
own "$db" -f "$m/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
own "$db" -f "$m/20261006230000_common_account_service_start_intent.sql" >/dev/null
own "$db" -f "$m/20261009120000_common_account_deletion_completion.sql" >/dev/null
own "$db" -f "$tests/common_account_write_guard_fixture.sql" >/dev/null
"${S[@]}" -d "$db" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
own "$db" -f "$m/20261010051938_common_account_service_write_guard.sql" >/dev/null
own "$db" -f "$m/20261012130000_common_account_core_service_fence.sql" >/dev/null
own "$db" -f "$m/20261012230000_common_account_service_brand_state.sql" >/dev/null
own "$db" -f "$repo/supabase/candidates/postona_x_publish_entitlement/test_stand_ins.sql" >/dev/null
own "$db" -f "$repo/supabase/migrations/20261006160200_x_account_publish_authority.sql" >/dev/null
own "$db" -f "$repo/supabase/candidates/postona_x_oauth_t13_guard/001_x_oauth_t13_guard.sql" >/dev/null
own "$db" -f "$here/001_postona_x_reservations.sql" >/dev/null
own "$db" -f "$here/002_postona_x_resv_api_role.sql" >/dev/null
own "$db" -f "$here/003_postona_x_resv_g5_binding.sql" >/dev/null
own "$db" -f "$repo/supabase/candidates/postona_x_oauth_t13_guard/g4_predicate_test_double.sql" >/dev/null
own "$db" -f "$here/004_postona_x_resv_dispatch.sql" >/dev/null
"${S[@]}" -d postgres -c "create role $apilogin login noinherit" -c "grant postona_resv_api to $apilogin" \
  -c "grant postona_resv_api to $owner with inherit false, set true" -c "grant postona_resv_worker to $owner with inherit false, set true" >/dev/null
own "$db" -f "$here/005_postona_x_single_post.sql" >/dev/null
fp() { val -c "select md5(string_agg(p.oid::regprocedure::text || ':' || p.prosrc || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || coalesce(array_to_string(p.proacl::text[], ','), ''), '|' order by p.oid::regprocedure::text))
  from pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace"; }
FP005="$(fp)"
echo "BASELINE_005_READY"

own "$db" -f "$lf/people.sql" >"$tmp/people" 2>&1 || { cat "$tmp/people"; fail "people"; }
grep -q LIVE_FENCE_PEOPLE_READY "$tmp/people" || { cat "$tmp/people"; fail "people not ready"; }

# FB: on 005 alone each gap lets a send through (the markers mean "the gap exists").
own "$db" -f "$lf/fail_before.sql" >"$tmp/fb" 2>&1 || { cat "$tmp/fb"; fail "fail-before"; }
for marker in FB1_GAP_005_SENDS_WITH_PUBLISH_SWITCH_OFF FB2_GAP_005_IGNORES_F5_BRAND_STATE FB3_GAP_005_SENDS_WITH_DEGRADED_CREDENTIAL \
              FB4_GAP_005_NO_CREDENTIAL_GENERATION FB5_GAP_005_NO_AFTER_FREEZE_OR_TRANSPORT LIVE_FENCE_FAIL_BEFORE_ALL_GAPS_CONFIRMED; do
  grep -q "$marker" "$tmp/fb" || { cat "$tmp/fb"; fail "missing $marker"; }
  echo "$marker"
done

# S0: 006 needs 005 and F5's brand state with its contract; a failed apply leaves nothing; a re-apply is refused.
own "$plain" -f "$here/test_fixture.sql" >/dev/null
own "$plain" -f "$here/001_postona_x_reservations.sql" >/dev/null
if own "$plain" -f "$candidate" >"$tmp/s0" 2>&1; then fail "006 applied without 005"; fi
grep -q POSTONA_X_SINGLE_POST_FENCE_PRECONDITION_005_MISSING "$tmp/s0" || fail "S0 wrong refusal: $(tail -1 "$tmp/s0")"
own "$db" -c "alter function public.common_account_brand_service_state(text, text) rename to common_account_brand_service_state_off" >/dev/null
if own "$db" -f "$candidate" >"$tmp/s0" 2>&1; then fail "006 applied without F5 brand state"; fi
own "$db" -c "alter function public.common_account_brand_service_state_off(text, text) rename to common_account_brand_service_state" >/dev/null
grep -q POSTONA_X_SINGLE_POST_FENCE_PRECONDITION_F5_BRAND_STATE_MISSING "$tmp/s0" || fail "S0 F5 missing: $(tail -1 "$tmp/s0")"
own "$db" -c "grant execute on function public.common_account_brand_service_state(text, text) to postona_resv_api" >/dev/null
if own "$db" -f "$candidate" >"$tmp/s0" 2>&1; then fail "006 applied with a widened F5 grant"; fi
own "$db" -c "revoke execute on function public.common_account_brand_service_state(text, text) from postona_resv_api" >/dev/null
grep -q POSTONA_X_SINGLE_POST_FENCE_PRECONDITION_F5_BRAND_STATE_CONTRACT "$tmp/s0" || fail "S0 F5 contract: $(tail -1 "$tmp/s0")"
perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$candidate" > "$tmp/fail.sql"
if own "$db" -f "$tmp/fail.sql" >/dev/null 2>&1; then fail "injected failure applied"; fi
[[ "$(val -c "select (to_regclass('postona_x_resv.single_post_bindings') is null and to_regprocedure('postona_x_resv.post_now_preflight(uuid,uuid)') is null)::text")" == true && "$(fp)" == "$FP005" ]] || fail "partial 006"
own "$db" -f "$candidate" >/dev/null
if own "$db" -f "$candidate" >"$tmp/s0" 2>&1; then fail "006 re-apply accepted"; fi
grep -q POSTONA_X_SINGLE_POST_FENCE_ALREADY_APPLIED "$tmp/s0" || fail "re-apply refused for another reason: $(tail -1 "$tmp/s0")"
echo "S0_REFUSALS_ATOMIC_REAPPLY_PASS"

# L: SQL behaviour.
own "$db" -f "$lf/behavior.sql" >"$tmp/b" 2>&1 || { cat "$tmp/b"; fail "behaviour"; }
for marker in L1_ACL_PASS L2_BEGIN_LIVE_FENCE_REFUSALS_PASS L3_BIND_PREFLIGHT_GENERATION_PASS L4_CHANGE_BETWEEN_BEGIN_AND_SEND_REFUSED_PASS \
              L5_REARM_REBINDS_PASS L6_RECORD_AFTER_FREEZE_SIMULATED_READBACK_PASS L7_WORKER_UNCHANGED_PASS L8_OWNER_CHECK_DEFENCE_IN_DEPTH_PASS \
              POSTONA_X_SINGLE_POST_LIVE_FENCE_BEHAVIOR_PASS; do
  grep -q "$marker" "$tmp/b" || { cat "$tmp/b"; fail "missing $marker"; }
  echo "$marker"
done

# L9: without the refresh core's table (it is itself a candidate) the fence and the generation still work (the refresh
#     state is simply not part of them); with it back, the generation includes it again.
A93="$(val -c "select account from t_ids.people where n = 93")"
G_WITH="$(val -c "select postona_x_resv.x_credential_generation('$A93')")"
own "$db" -c "alter table public.x_account_refresh_state_v2 rename to x_account_refresh_state_v2_off" >/dev/null
G_WITHOUT="$(val -c "select postona_x_resv.x_credential_generation('$A93')")"
own "$db" -c "alter table public.x_account_refresh_state_v2_off rename to x_account_refresh_state_v2" >/dev/null
own "$db" -c "insert into public.x_account_refresh_state_v2 (social_account_id, generation) values ('$A93', 5)" >/dev/null
G_ROW="$(val -c "select postona_x_resv.x_credential_generation('$A93')")"
[[ "$G_WITH" =~ ^[0-9a-f]{64}$ && "$G_WITHOUT" == "$G_WITH" && "$G_ROW" =~ ^[0-9a-f]{64}$ && "$G_ROW" != "$G_WITH" ]] || fail "L9 generation without / with the refresh table"
echo "L9_NO_REFRESH_TABLE_GENERATION_PASS"

# R: a lifecycle step holds the person's G5 locks and ends x_autopost (R1: commits; R2: rolls back) while the preflight
#    runs: the preflight waits on T13's locks (under lock_timeout), then reads F5's state LIVE -- R1 refuses (failed, never
#    sent), R2 passes. Never a pass from a snapshot taken before the freeze committed.
race() {
  local n="$1" finish="$2" P A S R L B h out
  P="$(val -c "select user_id from t_ids.people where n = $n")"; A="$(val -c "select account from t_ids.people where n = $n")"
  S="$(val -c "insert into auth.sessions (user_id) values ('$P') returning id")"
  own "$db" -c "update public.social_accounts set publish_enabled = true where id = '$A'" >/dev/null
  as_api() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$apilogin" -d "$db" -c "begin isolation level read committed" -c "set local role postona_resv_api" \
    -c "do \$\$ begin perform set_config('request.jwt.claims', '{\"sub\":\"$P\",\"role\":\"authenticated\",\"session_id\":\"$S\"}', true); end \$\$" -c "$1" -c "commit"; }
  B="$(as_api "select reservation_id || ' ' || lease_token from postona_x_resv.post_now_begin('$A', gen_random_uuid(), 'race $n', encode(sha256(convert_to('race $n', 'UTF8')), 'hex'))")"
  read -r R L <<<"$B"
  [[ "$R" =~ ^[0-9a-f-]{36}$ ]] || fail "R begin $n: $B"
  own "$db" -c "begin" -c "select private.account_lifecycle_lock('$P', false) is null" \
    -c "update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '$P' and service_key = 'x_autopost'" \
    -c "select pg_sleep(1.5)" -c "$finish" >/dev/null & h=$!
  for i in $(seq 1 100); do [[ "$(val -c "select (count(*) > 0)::text from pg_stat_activity where state = 'active' and query like 'select pg_sleep(1.5%'")" == true ]] && break; sleep 0.05; done
  out="$(as_api "select verdict from postona_x_resv.post_now_preflight('$R', '$L')")"
  wait "$h"
  echo "$out $(val -c "select status || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = '$R'")"
}
[[ "$(race 91 commit)" == "NOT_PUBLISHABLE failed/NOT_PUBLISHABLE_AT_SEND" ]] || fail "R1 freeze committed during the preflight was not seen"
echo "R1_FREEZE_COMMITTED_DURING_PREFLIGHT_REFUSED_PASS"
[[ "$(race 92 rollback)" == "OK claimed/-" ]] || fail "R2 rolled-back freeze refused"
echo "R2_FREEZE_ROLLED_BACK_PREFLIGHT_OK_PASS"

# E: the REAL single-post HTTP handler / driver / SQL with the generation-bound fake G4 and a fake X.
if ! RESV_SP_API_URL="postgres://$apilogin@127.0.0.1:$port/$db" RESV_SP_OWNER_URL="postgres://$owner@127.0.0.1:$port/$db" DENO_NO_PACKAGE_JSON=1 \
  deno test --no-config --allow-net=127.0.0.1:"$port" --allow-read --allow-env=RESV_SP_API_URL,RESV_SP_OWNER_URL \
  "$lf/live_fence_e2e_test.ts" >"$tmp/e2e" 2>&1; then
  cat "$tmp/e2e"; fail "live-fence e2e"
fi
grep -E "passed|failed" "$tmp/e2e" | tail -1
echo "E2E_LIVE_FENCE_PASS"

# RB: rollback restores 005 exactly (function bodies, settings and grants), drops the bindings; re-runnable; re-apply works.
own "$db" -f "$rollback" >/dev/null
[[ "$(fp)" == "$FP005" ]] || fail "RB did not restore 005 exactly"
[[ "$(val -c "select (to_regclass('postona_x_resv.single_post_bindings') is null and has_function_privilege('postona_resv_api', 'postona_x_resv.post_now_check(uuid,uuid)', 'EXECUTE'))::text")" == true ]] || fail "RB left 006"
own "$db" -f "$rollback" >/dev/null 2>&1
[[ "$(fp)" == "$FP005" ]] || fail "RB second run changed 005"
own "$db" -f "$candidate" >/dev/null
[[ "$(val -c "select (not has_function_privilege('postona_resv_api', 'postona_x_resv.post_now_check(uuid,uuid)', 'EXECUTE'))::text")" == true ]] || fail "re-apply"
echo "RB_ROLLBACK_RESTORES_005_REAPPLY_PASS"
echo "POSTONA_X_SINGLE_POST_LIVE_FENCE_ALL_PASS"
