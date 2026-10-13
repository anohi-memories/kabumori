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
[[ "$(val -c "select to_regprocedure('public.social_mobile_account_deletion_stop_x(uuid,uuid)') is null")" == t ]] || fail "partial apply"
own -f "$stop_sql" >/dev/null
if own -f "$stop_sql" >"$tmp/r0" 2>&1; then fail "re-apply accepted"; fi
grep -q X_SAGA_STOP_ALREADY_APPLIED "$tmp/r0" || fail "re-apply refused for another reason"
echo "R0_REFUSALS_ROLLBACK_REAPPLY_PASS"

# B1: SQL behaviour.
own -f "$here/saga_behavior.sql" >"$tmp/b1" 2>&1 || { cat "$tmp/b1"; fail "behaviour"; }
for marker in S1_LEASE_IDEMPOTENT_ACL_PASS S3_FROZEN_STILL_STOPS_PASS S5_IN_FLIGHT_AND_UNCERTAIN_PASS X_SAGA_STOP_BEHAVIOR_PASS; do
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

# E1: the REAL saga TypeScript against the real SQL (MOCK_ONLY getUser / revokeX).
if ! SAGA_OWNER_URL="postgres://$owner@127.0.0.1:$port/$db" SAGA_SUPER_URL="postgres://$super@127.0.0.1:$port/$db" \
  DENO_NO_PACKAGE_JSON=1 deno test --no-config --allow-net=127.0.0.1:"$port" --allow-read --allow-env=SAGA_OWNER_URL,SAGA_SUPER_URL \
  "$here/saga_e2e/saga_e2e_test.ts" >"$tmp/e1" 2>&1; then
  cat "$tmp/e1"; fail "saga e2e"
fi
grep -E "passed|failed" "$tmp/e1" | tail -1
echo "E1_REAL_SAGA_END_TO_END_PASS"

# RB: rollback removes the function; re-apply works.
own -f "$here/002_x_service_end_saga_stop_rollback.sql" >/dev/null
[[ "$(val -c "select to_regprocedure('public.social_mobile_account_deletion_stop_x(uuid,uuid)') is null")" == t ]] || fail "RB left the function"
own -f "$stop_sql" >/dev/null
echo "RB_ROLLBACK_REAPPLY_PASS"
echo "X_SAGA_STOP_ALL_PASS"
