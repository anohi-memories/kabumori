#!/usr/bin/env bash
# G3 candidate 007 (POSTONA Threads reservations) proof on a disposable LOCAL PostgreSQL only. Never a remote project.
# Baseline as postona_x_reservations/single_post_live_fence_run.sh (G5/F5 candidate SOURCE, Stage 3B authority, PR #257's
# guarded onboarding + G4 X test double, reservations 001-006). Then, in order:
#   P   007 refused while social_accounts is X-only; TEST STAND-IN of 2a-2's platform rule; test tables; people (Threads
#       accounts as test data);
#   FB  fail-before (before 007): a Threads reservation has nowhere to go;
#   S0  007 refusals (001-006 / F5 brand owner missing), injected failure leaves nothing, re-apply refused; X fingerprint;
#   L   SQL behaviour with the G4 / G5 TEST DOUBLES (ACL, create refusals, idempotency, claim -> preflight -> record ->
#       receipt, changes after the claim, after_freeze / uncertain / sweep, release / cancel);
#   R   two dispatcher transactions at once claim disjoint rows (SKIP LOCKED);
#   E   PR #334's dispatcher -> TEST FIXTURE store -> 007, fake G4 ports, fake Threads (0/1 sends);
#   RB  rollback removes only 007 (X fingerprint unchanged), is re-runnable; re-apply.
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> \
#        RESV_G5_SOURCE_DIR=<G5 candidate source dir> postona_threads_reservations_run.sh
# The cluster must also listen on 127.0.0.1 (trust). Optional THREADS_RESV_CANDIDATE / THREADS_RESV_ROLLBACK (mutations).
# MOCK_ONLY: G4, G5's Threads state, Auth answers, credentials, Threads. Roles are cluster-wide: run alone.
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
db="kabumori_postona_g3th_$$"
plain="kabumori_postona_g3th_plain_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-g3th.XXXXXX)"
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
# G3-34: G5's person-session gate S2-2 (caller() asks it first), pinned at PR #510's head, installed by the schema owner
. "$resv/g5_s2_2_pinned.sh"
s22_pinned "$tmp/s22.sql"
own "$db" -f "$tmp/s22.sql" >/dev/null
echo "G5_S2_2_PINNED_INSTALLED"

# G5 R1 / W1 TEST DOUBLE (007 requires them; the counters must see every later change).
own "$db" -f "$t/g5_verdict_test_double.sql" >/dev/null
# P: 007 needs Threads rows to be possible.
if own "$db" -f "$candidate" >"$tmp/p0" 2>&1; then fail "007 applied on an X-only social_accounts"; fi
grep -q POSTONA_THREADS_RESV_PRECONDITION_MULTI_PROVIDER "$tmp/p0" || fail "P wrong refusal: $(grep ERROR "$tmp/p0" | head -1)"
own "$db" -f "$t/multi_provider_stand_in.sql" >/dev/null
own "$db" -f "$t/test_tables.sql" >/dev/null
own "$db" -f "$t/people.sql" >"$tmp/people" 2>&1 || { cat "$tmp/people"; fail "people"; }
grep -q THREADS_PEOPLE_READY "$tmp/people" || { cat "$tmp/people"; fail "people not ready"; }
echo "P_MULTI_PROVIDER_PRECONDITION_PEOPLE_PASS"

# FB: before 007.
own "$db" -f "$t/fail_before.sql" >"$tmp/fb" 2>&1 || { cat "$tmp/fb"; fail "fail-before"; }
for marker in FB1_GAP_X_RESERVATIONS_REFUSE_THREADS_ACCOUNTS FB2_GAP_NO_THREADS_RESERVATION_STORE FB3_GAP_X_DISPATCHER_HAS_NO_THREADS_ROWS THREADS_FAIL_BEFORE_ALL_GAPS_CONFIRMED; do
  grep -q "$marker" "$tmp/fb" || { cat "$tmp/fb"; fail "missing $marker"; }
  echo "$marker"
done

# S0
own "$plain" -f "$resv/test_fixture.sql" >/dev/null
own "$plain" -f "$resv/001_postona_x_reservations.sql" >/dev/null
if own "$plain" -f "$candidate" >"$tmp/s0" 2>&1; then fail "007 applied without 002-006"; fi
grep -q POSTONA_THREADS_RESV_PRECONDITION_001_006_MISSING "$tmp/s0" || fail "S0 wrong refusal: $(tail -1 "$tmp/s0")"
own "$db" -c "alter function private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint) rename to account_lifecycle_worker_brand_verdict_off" >/dev/null
if own "$db" -f "$candidate" >"$tmp/s0" 2>&1; then fail "007 applied without G5 W1"; fi
own "$db" -c "alter function private.account_lifecycle_worker_brand_verdict_off(text, text, bigint, bigint) rename to account_lifecycle_worker_brand_verdict" >/dev/null
grep -q POSTONA_THREADS_RESV_PRECONDITION_G5_VERDICT "$tmp/s0" || fail "S0 G5 W1: $(grep ERROR "$tmp/s0" | head -1)"
own "$db" -c "grant execute on function private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint) to postona_resv_worker" >/dev/null
if own "$db" -f "$candidate" >"$tmp/s0" 2>&1; then fail "007 applied with W1 reachable by the worker role"; fi
own "$db" -c "revoke execute on function private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint) from postona_resv_worker" >/dev/null
grep -q POSTONA_THREADS_RESV_PRECONDITION_G5_VERDICT "$tmp/s0" || fail "S0 G5 W1 grant: $(grep ERROR "$tmp/s0" | head -1)"
own "$db" -c "alter function private.account_lifecycle_brand_owner(text) rename to account_lifecycle_brand_owner_off" >/dev/null
if own "$db" -f "$candidate" >"$tmp/s0" 2>&1; then fail "007 applied without F5 brand owner"; fi
own "$db" -c "alter function private.account_lifecycle_brand_owner_off(text) rename to account_lifecycle_brand_owner" >/dev/null
grep -q POSTONA_THREADS_RESV_PRECONDITION_F5_BRAND_OWNER "$tmp/s0" || fail "S0 F5: $(grep ERROR "$tmp/s0" | head -1)"
perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$candidate" > "$tmp/fail.sql"
if own "$db" -f "$tmp/fail.sql" >/dev/null 2>&1; then fail "injected failure applied"; fi
[[ "$(val -c "select (to_regnamespace('postona_threads_resv') is null)::text")" == true ]] || fail "partial 007"
own "$db" -f "$candidate" >/dev/null
if own "$db" -f "$candidate" >"$tmp/s0" 2>&1; then fail "007 re-apply accepted"; fi
grep -q POSTONA_THREADS_RESV_ALREADY_APPLIED "$tmp/s0" || fail "re-apply: $(tail -1 "$tmp/s0")"
[[ "$(xfp)" == "$FPX" ]] || fail "007 changed postona_x_resv"
# shipped DENY: before the doubles, nothing can be reserved (G4 verified false; G5 undecided)
P61="$(val -c "select user_id from t_ids.people where n = 61")"; T61="$(val -c "select threads_account from t_ids.people where n = 61")"
S61="$(val -c "insert into auth.sessions (user_id) values ('$P61') returning id")"
deny="$(psql -X -q -A -t -h "$host" -p "$port" -U "$apilogin" -d "$db" -c "begin" -c "set local role postona_resv_api" \
  -c "do \$\$ begin perform set_config('request.jwt.claims', '{\"sub\":\"$P61\",\"role\":\"authenticated\",\"session_id\":\"$S61\",\"is_anonymous\":false}', true); end \$\$" \
  -c "select status from postona_threads_resv.create_reservation('$T61', gen_random_uuid(), 'x', encode(sha256(convert_to('x', 'UTF8')), 'hex'), now() + interval '10 minutes')" -c "commit" 2>&1 || true)"
[[ "$deny" == *POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED* ]] || fail "S0 shipped stubs did not deny: $deny"
echo "S0_REFUSALS_ATOMIC_REAPPLY_X_UNCHANGED_SHIPPED_DENY_PASS"

# L
own "$db" -f "$t/g4_g5_test_doubles.sql" >/dev/null
own "$db" -f "$t/behavior.sql" >"$tmp/b" 2>&1 || { cat "$tmp/b"; fail "behaviour"; }
for marker in L1_ACL_PASS L2_CREATE_REFUSALS_PASS L3_IDEMPOTENCY_PASS L4_CLAIM_PREFLIGHT_RECORD_RECEIPT_PASS L5_CHANGE_AFTER_CLAIM_REFUSED_PASS \
              L6_RECORD_AFTER_FREEZE_UNCERTAIN_PASS L7_RELEASE_CANCEL_RECEIPT_PASS L8_PROFILE_DEFENCE_IN_DEPTH_PASS L9_SERVICE_GENERATION_ABA_PASS \
              POSTONA_THREADS_RESV_BEHAVIOR_PASS; do
  grep -q "$marker" "$tmp/b" || { cat "$tmp/b"; fail "missing $marker"; }
  echo "$marker"
done

# R: two dispatcher transactions at once.
R1="$(val -c "insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at, bound_owner_epoch, bound_lifecycle_version)
  select p.user_id, p.brand, p.threads_account, gen_random_uuid(), 'R1', encode(sha256(convert_to('R1', 'UTF8')), 'hex'), now() - interval '2 seconds',
    (select e.v from t_g5.owner_epoch e where e.brand_id = p.brand), (select l.v from t_g5.lifecycle l where l.user_id = p.user_id) from t_ids.people p where p.n = 98 returning id")"
R2="$(val -c "insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at, bound_owner_epoch, bound_lifecycle_version)
  select p.user_id, p.brand, p.threads_account, gen_random_uuid(), 'R2', encode(sha256(convert_to('R2', 'UTF8')), 'hex'), now() - interval '1 second',
    (select e.v from t_g5.owner_epoch e where e.brand_id = p.brand), (select l.v from t_g5.lifecycle l where l.user_id = p.user_id) from t_ids.people p where p.n = 98 returning id")"
wk() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$wklogin" -d "$db" "$@"; }
wk -c "begin" -c "set local role postona_resv_worker" -c "select reservation_id from postona_threads_resv.claim_due('ra', 60, 1)" -c "select pg_sleep(2)" -c "commit" >"$tmp/ra" & h=$!
for i in $(seq 1 100); do [[ "$("${S[@]}" -d "$db" -A -t -c "select (count(*) > 0)::text from pg_stat_activity where state = 'active' and query like 'select pg_sleep(2)%'")" == true ]] && break; sleep 0.05; done
[[ "$("${S[@]}" -d "$db" -A -t -c "select (count(*) > 0)::text from pg_stat_activity where state = 'active' and query like 'select pg_sleep(2)%'")" == true ]] || fail "R the first claim was not observed holding its lock"
wk -c "begin" -c "set local role postona_resv_worker" -c "select reservation_id from postona_threads_resv.claim_due('rb', 60, 50)" -c "commit" >"$tmp/rb"
# B must not have waited for A: A is still inside its pg_sleep when B is done (SKIP LOCKED, never a blocking claim).
[[ "$("${S[@]}" -d "$db" -A -t -c "select (count(*) > 0)::text from pg_stat_activity where state = 'active' and query like 'select pg_sleep(2)%'")" == true ]] || fail "R second claim waited for the first"
wait "$h"
[[ "$(grep -E '^[0-9a-f-]{36}$' "$tmp/ra")" == "$R1" && "$(grep -E '^[0-9a-f-]{36}$' "$tmp/rb")" == "$R2" ]] || fail "R claims overlap: A=$(cat "$tmp/ra") B=$(cat "$tmp/rb")"
[[ "$(val -c "select count(distinct claimed_by)::text || '/' || count(*) from postona_threads_resv.reservations where id in ('$R1', '$R2') and status = 'claimed'")" == "2/2" ]] || fail "R not both claimed once"
own "$db" -c "update postona_threads_resv.reservations set status = 'cancelled', lease_token = null, lease_expires_at = null where id in ('$R1', '$R2')" >/dev/null
echo "R_CONCURRENT_CLAIMS_DISJOINT_PASS"

# E
if ! THREADS_RESV_WORKER_URL="postgres://$wklogin@127.0.0.1:$port/$db" THREADS_RESV_OWNER_URL="postgres://$owner@127.0.0.1:$port/$db" DENO_NO_PACKAGE_JSON=1 \
  deno test --no-config --allow-net=127.0.0.1:"$port" --allow-read --allow-env=THREADS_RESV_WORKER_URL,THREADS_RESV_OWNER_URL \
  "$t/threads_dispatch_pg_e2e_test.ts" >"$tmp/e2e" 2>&1; then
  cat "$tmp/e2e"; fail "e2e"
fi
grep -E "passed|failed" "$tmp/e2e" | tail -1
echo "E2E_THREADS_DISPATCH_PG_PASS"

# RB
own "$db" -f "$rollback" >/dev/null
[[ "$(val -c "select (to_regnamespace('postona_threads_resv') is null)::text")" == true && "$(xfp)" == "$FPX" ]] || fail "RB"
own "$db" -f "$rollback" >/dev/null 2>&1
own "$db" -f "$candidate" >/dev/null
[[ "$(xfp)" == "$FPX" ]] || fail "re-apply changed X"
echo "RB_ROLLBACK_X_UNCHANGED_REAPPLY_PASS"
echo "POSTONA_THREADS_RESV_ALL_PASS"
