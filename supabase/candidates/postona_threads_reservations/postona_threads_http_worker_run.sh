#!/usr/bin/env bash
# G3 TASK 3/50 (+ TASK 6/50: the dispatcher's native pre-publish hook) proof (disposable LOCAL PostgreSQL only; never a
# remote project): the TEST FIXTURE HTTP entry (create /
# cancel / text-free receipt, MOCK caller verdicts) and the worker test entry (PR #334 dispatcher + 007 worker store + the
# PROPOSED pre-publish hook around a SIMULATED two-step send) over candidate 007 (PR #339). Same baseline and setup as
# postona_threads_reservations_run.sh (001-006, the 2a-2 platform stand-in, test tables, people, 007, G4/G5 doubles);
# 007's own proofs stay in that runner. Usage and environment as that runner. MOCK_ONLY: caller verdicts, G4, G5's
# Threads state, credentials, Threads. Roles are cluster-wide: run alone.
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
resv="$here/../postona_x_reservations"
candidate="${THREADS_RESV_CANDIDATE:-$here/007_postona_threads_reservations.sql}"
rollback="${THREADS_RESV_ROLLBACK:-$here/007_postona_threads_reservations_rollback.sql}"
t="$here/tests"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_postona_sp_owner"
apilogin="kb_postona_g3_api"
wklogin="kb_postona_g3_worker"
db="kabumori_postona_g3http_$$"
plain="kabumori_postona_g3http_plain_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-g3http.XXXXXX)"
drop_roles() {
  "${S[@]}" -d postgres -c "drop role if exists $apilogin" -c "drop role if exists $wklogin" -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true
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
own "$db" -f "$resv/001_postona_x_reservations.sql" >/dev/null
own "$db" -f "$resv/002_postona_x_resv_api_role.sql" >/dev/null
own "$db" -f "$resv/003_postona_x_resv_g5_binding.sql" >/dev/null
own "$db" -f "$repo/supabase/candidates/postona_x_oauth_t13_guard/g4_predicate_test_double.sql" >/dev/null
own "$db" -f "$resv/004_postona_x_resv_dispatch.sql" >/dev/null
"${S[@]}" -d postgres -c "create role $apilogin login noinherit" -c "grant postona_resv_api to $apilogin" \
  -c "grant postona_resv_api to $owner with inherit false, set true" -c "grant postona_resv_worker to $owner with inherit false, set true" >/dev/null
own "$db" -f "$resv/005_postona_x_single_post.sql" >/dev/null
own "$db" -f "$resv/006_postona_x_single_post_live_fence.sql" >/dev/null
fp() { val -c "select md5(string_agg(p.oid::regprocedure::text || ':' || p.prosrc || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || coalesce(array_to_string(p.proacl::text[], ','), ''), '|' order by p.oid::regprocedure::text))
  from pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace"; }
FP005="$(fp)"
"${S[@]}" -d postgres -c "create role $wklogin login noinherit" -c "grant postona_resv_worker to $wklogin" >/dev/null
xfp() { val -c "select md5(coalesce(string_agg(p.oid::regprocedure::text || ':' || p.prosrc || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || coalesce(array_to_string(p.proacl::text[], ','), ''), '|' order by p.oid::regprocedure::text), '')
  || (select coalesce(string_agg(c.relname || ':' || coalesce(array_to_string(c.relacl::text[], ','), ''), '|' order by c.relname), '') from pg_class c where c.relnamespace = 'postona_x_resv'::regnamespace))
  from pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace"; }
FPX="$(xfp)"
echo "BASELINE_001_006_READY"

# P: 007 needs Threads rows to be possible.
if own "$db" -f "$candidate" >"$tmp/p0" 2>&1; then fail "007 applied on an X-only social_accounts"; fi
grep -q POSTONA_THREADS_RESV_PRECONDITION_MULTI_PROVIDER "$tmp/p0" || fail "P wrong refusal: $(grep ERROR "$tmp/p0" | head -1)"
own "$db" -f "$t/multi_provider_stand_in.sql" >/dev/null
own "$db" -f "$t/test_tables.sql" >/dev/null
own "$db" -f "$t/people.sql" >"$tmp/people" 2>&1 || { cat "$tmp/people"; fail "people"; }
grep -q THREADS_PEOPLE_READY "$tmp/people" || { cat "$tmp/people"; fail "people not ready"; }
echo "P_MULTI_PROVIDER_PRECONDITION_PEOPLE_PASS"

own "$db" -f "$candidate" >/dev/null
own "$db" -f "$t/g4_g5_test_doubles.sql" >/dev/null
[[ "$(xfp)" == "$FPX" ]] || fail "007 changed postona_x_resv"
echo "SETUP_007_DOUBLES_READY"

if ! THREADS_HTTP_API_URL="postgres://$apilogin@127.0.0.1:$port/$db" THREADS_HTTP_WORKER_URL="postgres://$wklogin@127.0.0.1:$port/$db" \
  THREADS_HTTP_OWNER_URL="postgres://$owner@127.0.0.1:$port/$db" DENO_NO_PACKAGE_JSON=1 \
  deno test --no-config --allow-net=127.0.0.1:"$port" --allow-read --allow-env=THREADS_HTTP_API_URL,THREADS_HTTP_WORKER_URL,THREADS_HTTP_OWNER_URL \
  "$t/http_worker_pg_e2e_test.ts" "$t/dispatch_native_hook_pg_e2e_test.ts" >"$tmp/e2e" 2>&1; then
  cat "$tmp/e2e"; fail "http/worker e2e"
fi
grep -E "passed|failed" "$tmp/e2e" | tail -1
[[ "$(xfp)" == "$FPX" ]] || fail "the run changed postona_x_resv"
echo "E2E_THREADS_HTTP_WORKER_PG_PASS"
echo "POSTONA_THREADS_HTTP_WORKER_ALL_PASS"
