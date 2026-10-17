#!/usr/bin/env bash
# POSTONA X OAuth onboarding — T13 guard (001) proof on a disposable LOCAL PostgreSQL only. Never a remote project.
# Baseline: G5's production-shaped world from the G5/F5 candidate SOURCE (PR #165: lifecycle, enrollment, the Phase 3b
# service-write guard, the core fence) with the LIVE v1 X onboarding RPCs (20260919120000 + 20260922003101), plus the
# F3 reservation candidate 001-004 (+ MOCK_ONLY G4 allow list). Then: fail-before on the unguarded RPCs, refusals /
# atomic apply, behaviour, two-session lock order, the Edge's handling of the refusals, rollback.
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> \
#        RESV_G5_SOURCE_DIR=<dir with supabase/migrations + supabase/tests of the G5 candidate commit> run.sh
# Optional: T13_GUARD_CANDIDATE=<file> (mutation runs). Without the G5 source: RUN_NOT_AVAILABLE (exit 3).
# Roles are cluster-wide: run alone.
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
resv="$repo/supabase/candidates/postona_x_reservations"
candidate="${T13_GUARD_CANDIDATE:-$here/001_x_oauth_t13_guard.sql}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_postona_xoauth_t13_owner"
db="kabumori_postona_xoauth_t13_$$"
plain="kabumori_postona_xoauth_t13_plain_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-xoauth-t13.XXXXXX)"
drop_roles() { "${S[@]}" -d postgres -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true; }
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

# Baseline exactly as G5's own runner builds it (G5 candidate source, unmodified), then the reservation candidate.
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
own "$db" -f "$resv/001_postona_x_reservations.sql" >/dev/null
own "$db" -f "$resv/002_postona_x_resv_api_role.sql" >/dev/null
own "$db" -f "$resv/003_postona_x_resv_g5_binding.sql" >/dev/null
own "$db" >/dev/null <<'SQL'
create schema t_mock;
create table t_mock.verified (user_id uuid, social_account_id text, primary key (user_id, social_account_id));
create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from t_mock.verified v where v.user_id = p_user_id and v.social_account_id = p_social_account_id) $$;
SQL
own "$db" -f "$resv/004_postona_x_resv_dispatch.sql" >/dev/null
"${S[@]}" -d postgres -c "grant postona_resv_api to $owner with inherit false, set true" -c "grant postona_resv_worker to $owner with inherit false, set true" >/dev/null
echo "BASELINE_G5_LIVE_X_ONBOARDING_RESERVATIONS_READY"

# FB: fail-before on the LIVE (unguarded) RPCs.
own "$db" -f "$here/fail_before.sql" >"$tmp/fb" 2>&1 || { cat "$tmp/fb"; fail "fail-before script"; }
grep -q "FB1::states=1 consumed=1 secrets=2 accounts=1 verified=1" "$tmp/fb" || { cat "$tmp/fb"; fail "FB1 not reproduced"; }
grep -q "FB2:sa_" "$tmp/fb" || { cat "$tmp/fb"; fail "FB2 not reproduced"; }
grep -q "FB3:sa_" "$tmp/fb" || { cat "$tmp/fb"; fail "FB3 not reproduced"; }
echo "FB_FAIL_BEFORE_REPRODUCED (ended service connects X with 2 Vault secrets; deleting account and signed-out session begin)"

# G0: the guard needs G5's T13 function; a failed apply leaves nothing; a re-apply is refused.
own "$plain" -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
own "$plain" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
if own "$plain" -f "$candidate" >"$tmp/g0" 2>&1; then fail "guard applied without T13"; fi
grep -q POSTONA_X_OAUTH_T13_PRECONDITION_GUARD_MISSING "$tmp/g0" || fail "G0 wrong refusal: $(tail -1 "$tmp/g0")"
perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$candidate" > "$tmp/fail.sql"
if own "$db" -f "$tmp/fail.sql" >/dev/null 2>&1; then fail "injected failure applied"; fi
[[ "$(val -c "select (to_regprocedure('public.begin_social_mobile_x_oauth_connection_unguarded_v1(text,text,timestamptz)') is null
  and (select prosrc from pg_proc where oid = 'public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)'::regprocedure) !~ 'X_OAUTH_T13_GUARD_V1'
  and has_function_privilege('authenticated', 'public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)', 'EXECUTE'))::text")" == true ]] || fail "partial apply"
own "$db" -f "$candidate" >/dev/null
if own "$db" -f "$candidate" >"$tmp/g0" 2>&1; then fail "re-apply accepted"; fi
grep -q POSTONA_X_OAUTH_T13_ALREADY_APPLIED "$tmp/g0" || fail "re-apply refused for another reason: $(tail -1 "$tmp/g0")"
echo "G0_REFUSALS_ATOMIC_REAPPLY_PASS"

# B: behaviour.
own "$db" -f "$here/behavior.sql" >"$tmp/b" 2>&1 || { cat "$tmp/b"; fail "behaviour"; }
for marker in G1_ENROLLED_CONNECT_RECONNECT_PASS G2_SERVICE_ENDED_REFUSED_NOTHING_WRITTEN_PASS G3_LIFECYCLE_STATES_REFUSED_PASS \
              G4_SIGNED_OUT_JWT_REFUSED_PASS G5_OTHER_PERSON_REFUSED_PASS G6_SERVICE_ENDED_DURING_EXCHANGE_PASS G7_ACL_PASS \
              R_ONBOARDING_TO_RESERVATION_FENCED_PASS POSTONA_X_OAUTH_T13_BEHAVIOR_PASS; do
  grep -q "$marker" "$tmp/b" || { cat "$tmp/b"; fail "missing $marker"; }
  echo "$marker"
done

# C: two sessions. G5's lock order (login -> account -> entitlement, then the onboarding writes) against a lifecycle step.
uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
session_of() { val -c "insert into auth.sessions (user_id) values ('$1') returning id"; }
enroll() {  # a login with x_autopost started (G5's real RPC) and a live session id on stdout
  local u="$1" s
  own "$db" -c "select public.fixture_login('$u')" >/dev/null
  s="$(session_of "$u")"
  [[ "$(as_person "$u" "$s" "select public.start_x_autopost_service() ->> 'status'")" == active ]] || fail "enroll $u"
  echo "$s"
}
as_person() {  # $1 user, $2 session, $3 SQL, [$4 SQL after (still in the transaction, as the owner)]
  psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "begin isolation level read committed" \
    -c "do \$\$ begin perform set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\",\"session_id\":\"$2\"}', true); end \$\$" \
    -c "set local role authenticated" -c "$3" -c "reset role" -c "${4:-select 1 where false}" -c "commit"
}
begin_sql() { echo "select social_account_id from public.begin_social_mobile_x_oauth_connection(encode(sha256(convert_to('state:$1', 'UTF8')), 'hex'), 'kabumori://oauth/x', now() + interval '10 minutes')"; }
holding="select (count(*) > 0)::text from pg_stat_activity a where a.state = 'active' and a.query like 'select pg_sleep(%'"
wait_until() { local i; for i in $(seq 1 100); do [[ "$(val -c "$1")" == "$2" ]] && return 0; sleep 0.05; done; fail "timed out waiting for: $1"; }
deadlocks() { val -c "select deadlocks from pg_stat_database where datname = current_database()"; }
d0="$(deadlocks)"
# (a) a lifecycle step holds the person's locks longer than 3 s: begin refuses BUSY, nothing written.
P80="$(uid 80)"; S80="$(enroll "$P80")"
own "$db" -c "begin" -c "select private.account_lifecycle_lock('$P80', false) is null" -c "select pg_sleep(6)" -c "commit" >/dev/null & h=$!
wait_until "$holding" true
start=$(date +%s)
if as_person "$P80" "$S80" "$(begin_sql c80)" >"$tmp/c1" 2>&1; then fail "begin passed a held fence"; fi
elapsed=$(( $(date +%s) - start ))
grep -q SOCIAL_MOBILE_OAUTH_SERVICE_BUSY "$tmp/c1" || { cat "$tmp/c1"; fail "C1 wrong refusal"; }
[[ $elapsed -ge 2 ]] || fail "C1 did not wait for the fence (${elapsed}s)"
wait "$h"
[[ "$(val -c "select count(*) from public.social_account_oauth_states where initiated_by_user_id = '$P80'")" == 0 ]] || fail "C1 wrote a state"
# (b) begin holds the fence: a freeze (account FOR UPDATE -> locked) waits until begin commits; the next begin refuses.
P81="$(uid 81)"; S81="$(enroll "$P81")"
as_person "$P81" "$S81" "$(begin_sql c81)" "select pg_sleep(3)" >"$tmp/c2" 2>&1 & w=$!
wait_until "$holding" true
start=$(date +%s)
own "$db" -c "begin; select user_id from public.common_accounts where user_id = '$P81' for update; update public.common_accounts set status = 'locked' where user_id = '$P81'; commit;" >/dev/null
elapsed=$(( $(date +%s) - start ))
wait "$w" || { cat "$tmp/c2"; fail "C2 begin failed"; }
[[ $elapsed -ge 2 ]] || fail "C2 freeze did not wait for the onboarding transaction (${elapsed}s)"
if as_person "$P81" "$S81" "$(begin_sql c81b)" >"$tmp/c2b" 2>&1; then fail "begin after the freeze passed"; fi
grep -q ACCOUNT_LOCKED "$tmp/c2b" || { cat "$tmp/c2b"; fail "C2 wrong refusal"; }
# (c) two completes of one state at once: exactly one connects, the other is refused; exactly two Vault secrets.
P82="$(uid 82)"; S82="$(enroll "$P82")"
as_person "$P82" "$S82" "$(begin_sql c82)" >/dev/null
ST82="$(as_person "$P82" "$S82" "select oauth_state_id from public.consume_social_mobile_x_oauth_state(encode(sha256(convert_to('state:c82', 'UTF8')), 'hex'))")"
sec0="$(val -c "select count(*) from vault.secrets")"
complete="select public.complete_social_mobile_x_oauth_connection('$ST82', '8201', '@fake8201', 'fake-access-8201', 'fake-refresh-8201') is null"
as_person "$P82" "$S82" "$complete" >"$tmp/c3a" 2>&1 & a=$!
as_person "$P82" "$S82" "$complete" >"$tmp/c3b" 2>&1 & b=$!
ra=0; rb=0; wait "$a" || ra=$?; wait "$b" || rb=$?
[[ $((ra == 0 ? 1 : 0)) -ne $((rb == 0 ? 1 : 0)) ]] || { cat "$tmp/c3a" "$tmp/c3b"; fail "C3 expected exactly one success"; }
cat "$tmp/c3a" "$tmp/c3b" | grep -q OAUTH_STATE_NOT_CONSUMABLE || fail "C3 loser code"
[[ "$(( $(val -c "select count(*) from vault.secrets") - sec0 ))" == 2 ]] || fail "C3 secrets"
# (d) a lifecycle step that holds the person's G5 locks and THEN needs their X row (as the X stop / deletion steps do)
#     runs against a reconnect (begin updates the existing X row): T13 first means begin waits before touching the
#     row, so both complete and the database aborts nothing.
P83="$(uid 83)"; S83="$(enroll "$P83")"
as_person "$P83" "$S83" "$(begin_sql c83)" >/dev/null
own "$db" -c "begin" -c "select private.account_lifecycle_lock('$P83', false) is null" -c "select pg_sleep(1.5)" \
  -c "select 1 from public.social_accounts where brand_id = public.social_mobile_account_deletion_workspace('$P83') for update" -c "commit" >/dev/null & h=$!
wait_until "$holding" true
as_person "$P83" "$S83" "$(begin_sql c83b)" >"$tmp/c4" 2>&1 & w=$!
wait "$h" || fail "C4 lifecycle side aborted"
wait "$w" || { cat "$tmp/c4"; fail "C4 reconnect aborted"; }
[[ "$(deadlocks)" == "$d0" ]] || fail "C deadlock"
echo "C_TWO_SESSION_LOCK_ORDER_PASS"

# K: G4's predicate contract (F3 does not implement G4). The shipped DENY fails K1 (G4 not delivered); the TEST DOUBLE
# built from what the onboarding records passes; with it, a freshly onboarded person reserves and the worker claims.
own "$db" >/dev/null <<'SQL'
create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select false
$$;
revoke all on function postona_x_resv.g4_x_account_verified(uuid, text) from public, anon, authenticated, service_role;
SQL
if own "$db" -f "$here/g4_predicate_contract.sql" >"$tmp/k0" 2>&1; then fail "the shipped DENY passed the G4 contract"; fi
grep -q "FAIL K1 verified own account" "$tmp/k0" || { cat "$tmp/k0"; fail "K0 wrong failure"; }
own "$db" -c "delete from public.social_account_oauth_states where state_hash in (select encode(sha256(convert_to('state:k' || n, 'UTF8')), 'hex') from generate_series(91, 94) n)" >/dev/null
own "$db" -f "$here/g4_predicate_test_double.sql" >/dev/null
own "$db" -f "$here/g4_predicate_contract.sql" >"$tmp/k1" 2>&1 || { cat "$tmp/k1"; fail "G4 contract with the test double"; }
grep -q G4_PREDICATE_CONTRACT_PASS "$tmp/k1" || { cat "$tmp/k1"; fail "missing G4_PREDICATE_CONTRACT_PASS"; }
P91="$(uid 91)"; A91="$(val -c "select id from public.social_accounts where platform_user_id = '9101'")"
items="$(val -c "select jsonb_build_array(jsonb_build_object('draft_id', 'k91', 'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + 3 + time '10:00') at time zone 'Asia/Tokyo', 'body', 'k91', 'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to('k91', 'UTF8')), 'hex'))))")"
R91="$(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "begin" \
  -c "do \$\$ begin perform set_config('request.jwt.claims', '{\"sub\":\"$P91\",\"role\":\"authenticated\"}', true); end \$\$" \
  -c "set local role postona_resv_api" -c "select reservation_id from postona_x_resv.create_batch('$A91', gen_random_uuid(), 1, 'manual_exact', null, '$items'::jsonb)" -c "commit")"
[[ "$R91" =~ ^[0-9a-f-]{36}$ ]] || fail "K reservation after onboarding: $R91"
own "$db" -c "update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute', expires_at = now() + interval '6 hours' where id = '$R91'" >/dev/null
[[ "$(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "begin" -c "set local role postona_resv_worker" \
  -c "select count(*) from postona_x_resv.claim_due('w1', 120, 50) where reservation_id = '$R91'" -c "commit")" == 1 ]] || fail "K worker did not claim the onboarded person's row"
echo "K_G4_CONTRACT_DENY_FAILS_TEST_DOUBLE_PASSES_CHAIN_PASS"

# E: the Edge Function's own handling of the guard's refusals (real oauth_logic.ts; MOCK_ONLY fetch).
if ! DENO_NO_PACKAGE_JSON=1 deno test --no-config --allow-read "$here/edge_contract_test.ts" >"$tmp/e" 2>&1; then cat "$tmp/e"; fail "edge contract"; fi
grep -E "passed|failed" "$tmp/e" | tail -1
echo "E_EDGE_FAILS_CLOSED_PASS"

# RB: rollback restores the live names, bodies and grants; re-apply works.
own "$db" -f "$here/001_x_oauth_t13_guard_rollback.sql" >/dev/null
[[ "$(val -c "select (to_regprocedure('public.begin_social_mobile_x_oauth_connection_unguarded_v1(text,text,timestamptz)') is null
  and (select prosrc from pg_proc where oid = 'public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)'::regprocedure) !~ 'X_OAUTH_T13_GUARD_V1'
  and (select proconfig from pg_proc where oid = 'public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'::regprocedure) = array['search_path=public, vault']
  and has_function_privilege('authenticated', 'public.consume_social_mobile_x_oauth_state(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.consume_social_mobile_x_oauth_state(text)', 'EXECUTE'))::text")" == true ]] || fail "RB did not restore"
own "$db" -f "$here/001_x_oauth_t13_guard_rollback.sql" >/dev/null
own "$db" -f "$candidate" >/dev/null
echo "RB_ROLLBACK_REAPPLY_PASS"
echo "POSTONA_X_OAUTH_T13_ALL_PASS"
