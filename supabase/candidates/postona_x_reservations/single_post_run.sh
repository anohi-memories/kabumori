#!/usr/bin/env bash
# POSTONA X single manual post (005, M1) proof on a disposable LOCAL PostgreSQL only. Never a remote project.
# Baseline: G5's production-shaped world from the G5/F5 candidate SOURCE (PR #165: lifecycle, enrollment, Phase 3b
# service-write guard, core fence, brand state), the Stage 3B publish authority (real migration + PR #182's test
# stand-ins), the live X onboarding with PR #257's T13 wrapper, the reservation candidate 001-004 (+ G5 binding 003),
# G4's predicate as PR #257's TEST DOUBLE, then 005. Then: refusals / atomic apply, SQL behaviour, the REAL single-post
# HTTP handler -> driver -> SQL -> fake X end to end, rollback / re-apply.
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> \
#        RESV_G5_SOURCE_DIR=<dir with supabase/migrations + supabase/tests of the G5 candidate commit> single_post_run.sh
# The cluster must also listen on 127.0.0.1 (trust auth). Optional: SINGLE_POST_CANDIDATE=<file> (mutation runs).
# MOCK_ONLY: G4, Auth answers, the X credential source and X. Roles are cluster-wide: run alone.
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
candidate="${SINGLE_POST_CANDIDATE:-$here/005_postona_x_single_post.sql}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_postona_sp_owner"
apilogin="kb_postona_sp_api"
db="kabumori_postona_sp_$$"
plain="kabumori_postona_sp_plain_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-sp.XXXXXX)"
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
echo "BASELINE_G5_STAGE3B_ONBOARDING_GUARD_RESERVATIONS_001_004_READY"

# S0: 005 needs 001-004 and T13; a failed apply leaves nothing; a re-apply is refused.
own "$plain" -f "$here/test_fixture.sql" >/dev/null
own "$plain" -f "$here/001_postona_x_reservations.sql" >/dev/null
if own "$plain" -f "$candidate" >"$tmp/s0" 2>&1; then fail "005 applied without 002-004"; fi
grep -q POSTONA_X_SINGLE_POST_PRECONDITION_001_004_MISSING "$tmp/s0" || fail "S0 wrong refusal: $(tail -1 "$tmp/s0")"
perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$candidate" > "$tmp/fail.sql"
if own "$db" -f "$tmp/fail.sql" >/dev/null 2>&1; then fail "injected failure applied"; fi
[[ "$(val -c "select (to_regprocedure('postona_x_resv.post_now_begin(text,uuid,text,text)') is null and to_regprocedure('postona_x_resv.single_post_fence(uuid,text)') is null)::text")" == true ]] || fail "partial 005"
own "$db" -f "$candidate" >/dev/null
if own "$db" -f "$candidate" >"$tmp/s0" 2>&1; then fail "005 re-apply accepted"; fi
grep -q POSTONA_X_SINGLE_POST_ALREADY_APPLIED "$tmp/s0" || fail "re-apply refused for another reason: $(tail -1 "$tmp/s0")"
echo "S0_REFUSALS_ATOMIC_REAPPLY_PASS"

# People (enrolled + onboarded through the guarded live RPCs) and SQL behaviour.
own "$db" -f "$here/single_post/setup_people.sql" >"$tmp/people" 2>&1 || { cat "$tmp/people"; fail "people"; }
grep -q SINGLE_POST_PEOPLE_READY "$tmp/people" || { cat "$tmp/people"; fail "people not ready"; }
own "$db" -f "$here/single_post/single_post_behavior.sql" >"$tmp/b" 2>&1 || { cat "$tmp/b"; fail "behaviour"; }
for marker in B1_ACL_PASS B2_CONSENT_TEXT_IDEMPOTENCY_PASS B3_WORKER_NEVER_CLAIMS_UNCERTAIN_FENCE_PASS B4_REARM_NEVER_SENT_PASS POSTONA_X_SINGLE_POST_BEHAVIOR_PASS; do
  grep -q "$marker" "$tmp/b" || { cat "$tmp/b"; fail "missing $marker"; }
  echo "$marker"
done

# C: a lifecycle step holds the person's G5 locks longer than lock_timeout while the check runs: the claimed row goes
#    back (RELEASED, 'planned' -- never 'uncertain', never sent); a repeat of the request re-arms it afterwards.
P76="$(val -c "select user_id from t_ids.people where n = 76")"; A76="$(val -c "select account from t_ids.people where n = 76")"
S76="$(val -c "insert into auth.sessions (user_id) values ('$P76') returning id")"
as_api() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$apilogin" -d "$db" -c "begin isolation level read committed" -c "set local role postona_resv_api" \
  -c "do \$\$ begin perform set_config('request.jwt.claims', '{\"sub\":\"$P76\",\"role\":\"authenticated\",\"session_id\":\"$S76\"}', true); end \$\$" -c "$1" -c "commit"; }
SHA76="$(val -c "select encode(sha256(convert_to('busy', 'UTF8')), 'hex')")"
REQ76="$(val -c "select gen_random_uuid()")"
B76="$(as_api "select reservation_id || ' ' || lease_token from postona_x_resv.post_now_begin('$A76', '$REQ76', 'busy', '$SHA76')")"
read -r R76 L76 <<<"$B76"
[[ "$R76" =~ ^[0-9a-f-]{36}$ ]] || fail "C begin: $B76"
own "$db" -c "begin" -c "select private.account_lifecycle_lock('$P76', false) is null" -c "select pg_sleep(5)" -c "commit" >/dev/null & h=$!
for i in $(seq 1 100); do [[ "$(val -c "select (count(*) > 0)::text from pg_stat_activity where state = 'active' and query like 'select pg_sleep(%'")" == true ]] && break; sleep 0.05; done
[[ "$(as_api "select postona_x_resv.post_now_check('$R76', '$L76')")" == RELEASED ]] || fail "C busy fence not RELEASED"
[[ "$(val -c "select status from postona_x_resv.reservations where id = '$R76'")" == planned ]] || fail "C row not planned"
wait "$h"
[[ "$(as_api "select state from postona_x_resv.post_now_begin('$A76', '$REQ76', 'busy', '$SHA76')")" == claimed ]] || fail "C repeat did not re-arm"
echo "C_BUSY_FENCE_RELEASED_REARMED_PASS"

# E2E: the REAL single-post HTTP handler / driver / SQL with a fake X (MOCK_ONLY Auth, G4, credentials, X).
if ! RESV_SP_API_URL="postgres://$apilogin@127.0.0.1:$port/$db" RESV_SP_OWNER_URL="postgres://$owner@127.0.0.1:$port/$db" DENO_NO_PACKAGE_JSON=1 \
  deno test --no-config --allow-net=127.0.0.1:"$port" --allow-read --allow-env=RESV_SP_API_URL,RESV_SP_OWNER_URL \
  "$here/single_post/single_post_e2e_test.ts" >"$tmp/e2e" 2>&1; then
  cat "$tmp/e2e"; fail "single-post e2e"
fi
grep -E "passed|failed" "$tmp/e2e" | tail -1
echo "E2E_SINGLE_POST_AUTHORIZED_SENT_READBACK_PASS"

# RB: rollback removes the functions (rows stay valid reservation rows); re-apply works.
own "$db" -f "$here/005_postona_x_single_post_rollback.sql" >/dev/null
[[ "$(val -c "select (to_regprocedure('postona_x_resv.post_now_begin(text,uuid,text,text)') is null and to_regprocedure('postona_x_resv.post_now_get(uuid)') is null
  and to_regprocedure('postona_x_resv.single_post_fence(uuid,text)') is null)::text")" == true ]] || fail "RB left 005"
own "$db" -f "$here/005_postona_x_single_post_rollback.sql" >/dev/null
own "$db" -f "$candidate" >/dev/null
echo "RB_ROLLBACK_REAPPLY_PASS"
echo "POSTONA_X_SINGLE_POST_ALL_PASS"
