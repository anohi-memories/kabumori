#!/usr/bin/env bash
# POSTONA X publish switch — T13 + G4 guard for ON (001) proof on a disposable LOCAL PostgreSQL only. Never remote.
# Baseline: G5's production-shaped world from the G5/F5 candidate SOURCE (PR #165: lifecycle, enrollment, Phase 3b
# service-write guard), the live X onboarding RPCs with PR #257's T13 wrapper, the F3 reservation candidate 001 (G4's
# predicate stub), and the REAL live publish switch migration 20261003090000 (PR #76). TEST STAND-IN: the legacy
# exact-account helper x_legacy_post_account (a refusing stub of the same signature; the switch never calls it).
# Then: fail-before, refusals / atomic apply, behaviour, two sessions, the Edge's contract, rollback.
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> \
#        RESV_G5_SOURCE_DIR=<dir with supabase/migrations + supabase/tests of the G5 candidate commit> run.sh
# Optional: PUBLISH_GUARD_CANDIDATE=<file> (mutation runs). Without the G5 source: RUN_NOT_AVAILABLE (exit 3).
set -euo pipefail

host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${RESV_G5_SOURCE_DIR:-}"
if [[ -z "$g5" || ! -f "$g5/supabase/migrations/20261010051938_common_account_service_write_guard.sql" ]]; then
  echo "RUN_NOT_AVAILABLE: RESV_G5_SOURCE_DIR does not hold the G5 candidate source" >&2; exit 3
fi
export LC_ALL=C PGTZ=UTC

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
candidate="${PUBLISH_GUARD_CANDIDATE:-$here/001_publish_enabled_t13_guard.sql}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_postona_pubt13_owner"
db="kabumori_postona_pubt13_$$"
plain="kabumori_postona_pubt13_plain_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-pubt13.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  for d in "$db" "$plain"; do "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

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
stand_in() { own "$1" >/dev/null <<'SQL'
-- TEST STAND-IN: the legacy exact-account helper (20260925140000) with the same signature; the switch never calls it.
create function public.x_legacy_post_account(p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text, p_lock boolean)
returns public.social_accounts language plpgsql security definer set search_path = '' as $$
begin raise exception 'TEST_STAND_IN_NOT_CALLED'; end $$;
revoke all on function public.x_legacy_post_account(uuid, text, text, boolean) from public, anon, authenticated, service_role;
SQL
}

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
stand_in "$db"
own "$db" -f "$m/20261003090000_social_mobile_publish_permission_boundary.sql" >/dev/null
own "$db" -f "$repo/supabase/candidates/postona_x_oauth_t13_guard/001_x_oauth_t13_guard.sql" >/dev/null
own "$db" -f "$repo/supabase/candidates/postona_x_reservations/001_postona_x_reservations.sql" >/dev/null
legacy_check="select md5(prosrc) from pg_proc where oid = 'public.assert_x_publish_permission_for_legacy_post(uuid,text,text)'::regprocedure"
legacy0="$(val -c "$legacy_check")"
echo "BASELINE_G5_LIVE_SWITCH_ONBOARDING_GUARD_G4_STUB_READY"

# FB: fail-before on the live switch.
own "$db" -f "$here/fail_before.sql" >"$tmp/fb" 2>&1 || { cat "$tmp/fb"; fail "fail-before script"; }
for line in "FB1:updated:t" "FB2:updated:t" "FB3:updated:t" "FB4:true"; do
  grep -q "$line" "$tmp/fb" || { cat "$tmp/fb"; fail "fail-before: missing $line"; }
done
echo "FB_FAIL_BEFORE_REPRODUCED (ON passes for an ended service, a locked account, a signed-out session, with G4 = DENY)"

# P0: the guard needs the T13 guard and G4's predicate; a failed apply leaves nothing; a re-apply is refused.
own "$plain" -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
own "$plain" -f "$m/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
stand_in "$plain"
own "$plain" -f "$m/20261003090000_social_mobile_publish_permission_boundary.sql" >/dev/null
if own "$plain" -f "$candidate" >"$tmp/p0" 2>&1; then fail "guard applied without T13"; fi
grep -q PUBLISH_ENABLED_T13_PRECONDITION_GUARD_MISSING "$tmp/p0" || fail "P0 wrong refusal: $(tail -1 "$tmp/p0")"
perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$candidate" > "$tmp/fail.sql"
if own "$db" -f "$tmp/fail.sql" >/dev/null 2>&1; then fail "injected failure applied"; fi
[[ "$(val -c "select (to_regprocedure('public.set_social_account_publish_enabled_unguarded_v1(text,boolean,boolean)') is null
  and (select prosrc from pg_proc where oid = 'public.set_social_account_publish_enabled(text,boolean,boolean)'::regprocedure) !~ 'PUBLISH_ENABLED_T13_GUARD_V1')::text")" == true ]] || fail "partial apply"
own "$db" -f "$candidate" >/dev/null
if own "$db" -f "$candidate" >"$tmp/p0" 2>&1; then fail "re-apply accepted"; fi
grep -q PUBLISH_ENABLED_T13_ALREADY_APPLIED "$tmp/p0" || fail "re-apply refused for another reason: $(tail -1 "$tmp/p0")"
[[ "$(val -c "$legacy_check")" == "$legacy0" ]] || fail "the send-time check changed"
echo "P0_REFUSALS_ATOMIC_REAPPLY_SEND_CHECK_UNCHANGED_PASS"

# B: behaviour.
own "$db" -f "$here/behavior.sql" >"$tmp/b" 2>&1 || { cat "$tmp/b"; fail "behaviour"; }
for marker in H0_G4_NOT_DELIVERED_DEFAULT_DENY_PASS H1_ACTIVE_OWNER_UNCHANGED_CONTRACT_PASS H2_SERVICE_ENDED_ON_REFUSED_OFF_WORKS_PASS \
              H3_LIFECYCLE_STATES_REFUSED_PASS H4_SIGNED_OUT_REFUSED_PASS H5_OTHER_PERSON_AND_NON_OWNER_PASS H6_NON_POSTONA_BRAND_UNCHANGED_PASS \
              H7_ACL_PASS H8_SAGA_TOMBSTONE_LIVE_ANSWER_PASS POSTONA_PUBLISH_ENABLED_T13_BEHAVIOR_PASS; do
  grep -q "$marker" "$tmp/b" || { cat "$tmp/b"; fail "missing $marker"; }
  echo "$marker"
done

# C: two sessions against a lifecycle step (the G4 test double stays installed from the behaviour run).
uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
as_person() {  # $1 user, $2 session, $3 SQL, [$4 SQL after, as the owner, still in the transaction]
  psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "begin isolation level read committed" \
    -c "do \$\$ begin perform set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\",\"session_id\":\"$2\"}', true); end \$\$" \
    -c "set local role authenticated" -c "$3" -c "reset role" -c "${4:-select 1 where false}" -c "commit"
}
onboard() {  # $1 n -> "account session"
  psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" >"$tmp/onboard.out" 2>>"$tmp/onboard.err" <<SQL
\\ir $here/setup.sql
select pg_temp.onboarded($1) as account \\gset
select :'account' || ' ' || (select id from auth.sessions where user_id = pg_temp.uid($1) order by created_at desc limit 1);
SQL
  grep -E '^sa_' "$tmp/onboard.out" | tail -1
}
toggle() { echo "select public.set_social_account_publish_enabled('$1', $2, $3) ->> 'status'"; }
holding="select (count(*) > 0)::text from pg_stat_activity a where a.state = 'active' and a.query like 'select pg_sleep(%'"
wait_until() { local i; for i in $(seq 1 100); do [[ "$(val -c "$1")" == "$2" ]] && return 0; sleep 0.05; done; fail "timed out waiting for: $1"; }
deadlocks() { val -c "select deadlocks from pg_stat_database where datname = current_database()"; }
enabled() { val -c "select publish_enabled from public.social_accounts where id = '$1'"; }
d0="$(deadlocks)"
# (a) a lifecycle step holds the person's locks longer than 3 s: ON answers busy after waiting, nothing changes.
read -r A51 S51 <<<"$(onboard 51)"; P51="$(uid 51)"
[[ "$A51" == sa_* ]] || { cat "$tmp/onboard.out" "$tmp/onboard.err"; fail "C setup 51: $A51"; }
own "$db" -c "begin" -c "select private.account_lifecycle_lock('$P51', false) is null" -c "select pg_sleep(6)" -c "commit" >/dev/null & h=$!
wait_until "$holding" true
start=$(date +%s)
[[ "$(as_person "$P51" "$S51" "$(toggle "$A51" true false)")" == busy ]] || fail "C1 not busy"
[[ $(( $(date +%s) - start )) -ge 2 ]] || fail "C1 did not wait for the fence"
wait "$h"
[[ "$(enabled "$A51")" == f ]] || fail "C1 changed"
# (b) ON holds the fence: a freeze waits until it commits; the next ON is refused (forbidden), OFF still works.
read -r A52 S52 <<<"$(onboard 52)"; P52="$(uid 52)"
as_person "$P52" "$S52" "$(toggle "$A52" true false)" "select pg_sleep(3)" >"$tmp/c2" 2>&1 & w=$!
wait_until "$holding" true
start=$(date +%s)
own "$db" -c "begin; select user_id from public.common_accounts where user_id = '$P52' for update; update public.common_accounts set status = 'locked' where user_id = '$P52'; commit;" >/dev/null
[[ $(( $(date +%s) - start )) -ge 2 ]] || fail "C2 freeze did not wait"
wait "$w"; grep -qx updated "$tmp/c2" || { cat "$tmp/c2"; fail "C2 ON"; }
[[ "$(as_person "$P52" "$S52" "$(toggle "$A52" false true)")" == updated ]] || fail "C2 OFF after the freeze"
[[ "$(as_person "$P52" "$S52" "$(toggle "$A52" true false)")" == forbidden ]] || fail "C2 ON after the freeze"
# (c) a lifecycle step that holds G5's locks and THEN needs the X row (the X stop functions' order) against ON: no deadlock.
read -r A53 S53 <<<"$(onboard 53)"; P53="$(uid 53)"
own "$db" -c "begin" -c "select private.account_lifecycle_lock('$P53', false) is null" -c "select pg_sleep(1.5)" \
  -c "select 1 from public.social_accounts where id = '$A53' for update" -c "commit" >/dev/null & h=$!
wait_until "$holding" true
as_person "$P53" "$S53" "$(toggle "$A53" true false)" >"$tmp/c3" 2>&1 & w=$!
wait "$h" || fail "C3 lifecycle side aborted"
wait "$w" || { cat "$tmp/c3"; fail "C3 ON aborted"; }
grep -qx updated "$tmp/c3" || { cat "$tmp/c3"; fail "C3 ON result"; }
# (d) two ONs at once with the same expectation: one updated, the other stale; enabled once.
read -r A54 S54 <<<"$(onboard 54)"; P54="$(uid 54)"
as_person "$P54" "$S54" "$(toggle "$A54" true false)" >"$tmp/c4a" 2>&1 & a=$!
as_person "$P54" "$S54" "$(toggle "$A54" true false)" >"$tmp/c4b" 2>&1 & b=$!
wait "$a"; wait "$b"
[[ "$(sort "$tmp/c4a" "$tmp/c4b" | tr '\n' ' ')" == "stale updated " ]] || { cat "$tmp/c4a" "$tmp/c4b"; fail "C4"; }
# (e) any other answer of the guard (here: a REPEATABLE READ transaction, which G5's fence refuses) is the live fixed
#     error, never a decision; nothing changes.
read -r A55 S55 <<<"$(onboard 55)"; P55="$(uid 55)"
if psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "begin isolation level repeatable read" \
  -c "do \$\$ begin perform set_config('request.jwt.claims', '{\"sub\":\"$P55\",\"role\":\"authenticated\",\"session_id\":\"$S55\"}', true); end \$\$" \
  -c "set local role authenticated" -c "$(toggle "$A55" true false)" -c "commit" >"$tmp/c5" 2>&1; then fail "C5 repeatable read answered"; fi
grep -q PUBLISH_SETTING_UNAVAILABLE "$tmp/c5" || { cat "$tmp/c5"; fail "C5 wrong error"; }
[[ "$(enabled "$A55")" == f ]] || fail "C5 changed"
[[ "$(deadlocks)" == "$d0" ]] || fail "C deadlock"
echo "C_TWO_SESSION_LOCK_ORDER_PASS"

# E: the live Edge accepts every answer the wrapper can give (no new status or reason). MOCK_ONLY fetch.
if ! DENO_NO_PACKAGE_JSON=1 deno test --no-config --allow-read "$here/edge_contract_test.ts" >"$tmp/e" 2>&1; then cat "$tmp/e"; fail "edge contract"; fi
grep -E "passed|failed" "$tmp/e" | tail -1
echo "E_EDGE_CONTRACT_UNCHANGED_PASS"

# RB: rollback restores the live switch; re-apply works.
own "$db" -f "$here/001_publish_enabled_t13_guard_rollback.sql" >/dev/null
[[ "$(val -c "select (to_regprocedure('public.set_social_account_publish_enabled_unguarded_v1(text,boolean,boolean)') is null
  and (select prosrc from pg_proc where oid = 'public.set_social_account_publish_enabled(text,boolean,boolean)'::regprocedure) !~ 'PUBLISH_ENABLED_T13_GUARD_V1'
  and has_function_privilege('authenticated', 'public.set_social_account_publish_enabled(text,boolean,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_social_account_publish_enabled(text,boolean,boolean)', 'EXECUTE'))::text")" == true ]] || fail "RB did not restore"
own "$db" -f "$here/001_publish_enabled_t13_guard_rollback.sql" >/dev/null
own "$db" -f "$candidate" >/dev/null
[[ "$(val -c "$legacy_check")" == "$legacy0" ]] || fail "the send-time check changed"
echo "RB_ROLLBACK_REAPPLY_PASS"
echo "POSTONA_PUBLISH_ENABLED_T13_ALL_PASS"
