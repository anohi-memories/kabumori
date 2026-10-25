#!/usr/bin/env bash
# POSTONA X reservations — F3 dispatch (004) proof on a disposable LOCAL PostgreSQL only. Never a remote project.
# Baseline: G5's production-shaped world from the G5/F5 candidate SOURCE (PR #165) + the reservation candidate 001 +
# 002 + 003 (real G5 binding). Then: 004 refusals / apply, SQL behaviour, F3-L1 lock order with two sessions, the
# busy fence, the REAL app store -> reservation HTTP handler -> driver -> SQL and the REAL worker HTTP handler ->
# driver -> SQL -> fake X end to end, rollback.
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> \
#        RESV_G5_SOURCE_DIR=<dir with supabase/migrations + supabase/tests of the G5 candidate commit> dispatch_run.sh
# The cluster must also listen on 127.0.0.1 (trust auth). Optional: DISPATCH_CANDIDATE=<file> (mutation runs).
# MOCK_ONLY: G4 (verified X account) is an allow list; Auth answers, X and the X credential source are fakes.
# Without the G5 source: RUN_NOT_AVAILABLE (exit 3). Roles are cluster-wide: run alone.
set -euo pipefail

host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${RESV_G5_SOURCE_DIR:-}"
if [[ -z "$g5" || ! -f "$g5/supabase/migrations/20261012130000_common_account_core_service_fence.sql" ]]; then
  echo "RUN_NOT_AVAILABLE: RESV_G5_SOURCE_DIR does not hold the G5 candidate source" >&2; exit 3
fi
export LC_ALL=C PGTZ=UTC

here="$(cd "$(dirname "$0")" && pwd)"
candidate="${DISPATCH_CANDIDATE:-$here/004_postona_x_resv_dispatch.sql}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_postona_resv_dsp_owner"
apilogin="kb_postona_resv_dsp_api"
wlogin="kb_postona_resv_dsp_worker"
db="kabumori_postona_resv_dsp_$$"
plain="kabumori_postona_resv_dsp_plain_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-resv-dsp.XXXXXX)"
drop_roles() {
  "${S[@]}" -d postgres -c "drop role if exists $apilogin" -c "drop role if exists $wlogin" \
    -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true
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

# Baseline exactly as G5's own runner builds it (G5 candidate source, unmodified).
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
own "$db" -f "$here/001_postona_x_reservations.sql" >/dev/null
own "$db" -f "$here/002_postona_x_resv_api_role.sql" >/dev/null
echo "BASELINE_G5_RESERVATIONS_001_002_READY"
# G3-34: G5's person-session gate S2-2 (caller() asks it first), pinned at PR #510's head, installed by the schema owner
. "$here/g5_s2_2_pinned.sh"
s22_pinned "$tmp/s22.sql"
own "$db" -f "$tmp/s22.sql" >/dev/null
echo "G5_S2_2_PINNED_INSTALLED"

# D0: 004 needs 003 (the real G5 binding); a failed apply leaves nothing; a re-apply is refused.
own "$plain" -f "$here/test_fixture.sql" >/dev/null
own "$plain" -f "$here/001_postona_x_reservations.sql" >/dev/null
if own "$plain" -f "$candidate" >"$tmp/d0" 2>&1; then fail "004 applied without 003"; fi
grep -q POSTONA_RESV_DISPATCH_PRECONDITION_G5_BINDING_MISSING "$tmp/d0" || fail "D0 wrong refusal: $(tail -1 "$tmp/d0")"
own "$db" -f "$here/003_postona_x_resv_g5_binding.sql" >/dev/null
# MOCK_ONLY G4 (after 003, whose postcondition requires the shipped G4 DENY): an allow list in this database only.
own "$db" >/dev/null <<'SQL'
create schema t_mock;
create table t_mock.verified (user_id uuid, social_account_id text, primary key (user_id, social_account_id));
create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from t_mock.verified v where v.user_id = p_user_id and v.social_account_id = p_social_account_id) $$;
SQL
perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$candidate" > "$tmp/fail.sql"
if own "$db" -f "$tmp/fail.sql" >/dev/null 2>&1; then fail "injected failure applied"; fi
[[ "$(val -c "select (to_regrole('postona_resv_worker') is null and to_regprocedure('postona_x_resv.release_unsent(uuid,uuid)') is null
  and (select prosrc from pg_proc where oid = 'postona_x_resv.lock_own(uuid,integer)'::regprocedure) !~ 'FIRST')::text")" == true ]] || fail "partial 004 left behind"
own "$db" -f "$candidate" >/dev/null
if own "$db" -f "$candidate" >"$tmp/d0" 2>&1; then fail "004 re-apply accepted"; fi
grep -q POSTONA_RESV_DISPATCH_ALREADY_APPLIED "$tmp/d0" || fail "re-apply refused for another reason: $(tail -1 "$tmp/d0")"
echo "D0_REFUSALS_ATOMIC_REAPPLY_PASS"

# Rollout simulation (test-only): login roles in the two execution roles; the owner may SET ROLE to them.
"${S[@]}" -d postgres -c "create role $apilogin login noinherit" -c "grant postona_resv_api to $apilogin" \
  -c "create role $wlogin login noinherit" -c "grant postona_resv_worker to $wlogin" \
  -c "grant postona_resv_api to $owner with inherit false, set true" -c "grant postona_resv_worker to $owner with inherit false, set true" >/dev/null

# D1: SQL behaviour.
own "$db" -f "$here/dispatch/dispatch_behavior.sql" >"$tmp/d1" 2>&1 || { cat "$tmp/d1"; fail "behaviour"; }
for marker in W1_WORKER_ROLE_BOUNDARY_PASS W2_W3_RELEASE_UNSENT_PASS W4_W5_W6_LIVE_PERMISSIONS_AT_CLAIM_AND_SEND_PASS \
              POSTONA_RESV_DISPATCH_BEHAVIOR_PASS; do
  grep -q "$marker" "$tmp/d1" || { cat "$tmp/d1"; fail "missing $marker"; }
  echo "$marker"
done

# D2: F3-L1. A lifecycle step that holds G5's locks for a person and THEN needs that person's reservation row (as the
# X stop functions do) runs against the owner cancel, the worker's pre-publish check and the worker's claim. G5's
# locks are taken first everywhere now: every side completes, the database aborts nothing (deadlock count unchanged).
uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
rid() { val -c "select id from t_ids.ids where name = 'r$1'"; }
due() { own "$db" -c "update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute', expires_at = now() + interval '6 hours' where id = '$1'" >/dev/null; }
as_worker() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$wlogin" -d "$db" -c "begin isolation level read committed" -c "set local role postona_resv_worker" -c "$1" -c "commit"; }
as_api() { # $1 user, $2 SQL; G3-34: a live session of the user and a proven non-anonymous sign-in (what G5's S2-2 reads)
  local s; s="$(own "$db" -A -t -c "insert into auth.sessions (user_id) values ('$1') returning id")"
  psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$apilogin" -d "$db" -c "begin isolation level read committed" -c "set local role postona_resv_api" \
    -c "select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\",\"session_id\":\"$s\",\"is_anonymous\":false}', true)" -c "$2" -c "commit"
}
holder() { # $1 user, $2 reservation (or '' for none), $3 seconds; G5 lifecycle lock, wait, then the row
  local row="select 1"; [[ -n "$2" ]] && row="select 1 from postona_x_resv.reservations where id = '$2' for update"
  own "$db" -c "begin" -c "select private.account_lifecycle_lock('$1', false) is null" -c "select pg_sleep($3)" -c "$row" -c "commit" >/dev/null
}
wait_until() { local i; for i in $(seq 1 100); do [[ "$(val -c "$1")" == "$2" ]] && return 0; sleep 0.05; done; fail "timed out waiting for: $1"; }
holding="select (count(*) > 0)::text from pg_stat_activity a where a.state = 'active' and a.query like 'select pg_sleep(%'"
deadlocks() { val -c "select deadlocks from pg_stat_database where datname = current_database()"; }
# The worker login reaches only postona_resv_worker: no other role, no table, no owner function.
for sql in "set role service_role" "set role postona_resv_api" "set role $owner" "set role authenticated" "select count(*) from postona_x_resv.reservations"; do
  if psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$wlogin" -d "$db" -c "$sql" >/dev/null 2>&1; then fail "worker login: $sql"; fi
done
if as_worker "select count(*) from postona_x_resv.list_reservations('x')" >/dev/null 2>&1; then fail "worker role reached an owner function"; fi
d0="$(deadlocks)"
# (a) owner cancel
A44="$(uid 44)"; R44="$(rid 44)"
holder "$A44" "$R44" 1.5 & h=$!
wait_until "$holding" true
as_api "$A44" "select status from postona_x_resv.cancel('$R44', 1)" >"$tmp/l1a" 2>&1 & c=$!
wait "$h" || fail "L1a lifecycle side aborted"
wait "$c" || { cat "$tmp/l1a"; fail "L1a owner cancel aborted"; }
grep -q cancelled "$tmp/l1a" || { cat "$tmp/l1a"; fail "L1a cancel result"; }
# (b) worker pre-publish check
A45="$(uid 45)"; R45="$(rid 45)"; due "$R45"
as_worker "select count(*) from postona_x_resv.claim_due('w1', 120, 50)" >/dev/null
L45="$(val -c "select lease_token from postona_x_resv.reservations where id = '$R45' and status = 'claimed'")"
[[ -n "$L45" ]] || fail "L1b claim"
holder "$A45" "$R45" 1.5 & h=$!
wait_until "$holding" true
as_worker "select postona_x_resv.pre_publish_check('$R45', '$L45')" >"$tmp/l1b" 2>&1 & c=$!
wait "$h" || fail "L1b lifecycle side aborted"
wait "$c" || { cat "$tmp/l1b"; fail "L1b pre-publish check aborted"; }
grep -qx OK "$tmp/l1b" || { cat "$tmp/l1b"; fail "L1b verdict"; }
# (c) worker claim
A46="$(uid 46)"; R46="$(rid 46)"; due "$R46"
holder "$A46" "$R46" 1.5 & h=$!
wait_until "$holding" true
as_worker "select coalesce(string_agg(reservation_id::text, ','), '') from postona_x_resv.claim_due('w2', 120, 50)" >"$tmp/l1c" 2>&1 & c=$!
wait "$h" || fail "L1c lifecycle side aborted"
wait "$c" || { cat "$tmp/l1c"; fail "L1c claim aborted"; }
grep -q "$R46" "$tmp/l1c" || { cat "$tmp/l1c"; fail "L1c claim result"; }
[[ "$(deadlocks)" == "$d0" ]] || fail "L1 deadlock ($d0 -> $(deadlocks))"
echo "L1_G5_FIRST_LOCK_ORDER_NO_DEADLOCK_PASS"

# D2b: the fence held longer than G5's lock_timeout (3 s): the pre-publish check hands the row back (RELEASED,
# 'planned', never 'uncertain'); a claim skips that owner this round without failing.
A47="$(uid 47)"; R47="$(rid 47)"; due "$R47"
as_worker "select count(*) from postona_x_resv.claim_due('w3', 120, 50)" >/dev/null
L47="$(val -c "select lease_token from postona_x_resv.reservations where id = '$R47' and status = 'claimed'")"
[[ -n "$L47" ]] || fail "busy claim"
holder "$A47" "" 9 & h=$!  # longer than two lock_timeout waits (3 s + 3 s)
wait_until "$holding" true
[[ "$(as_worker "select postona_x_resv.pre_publish_check('$R47', '$L47')")" == RELEASED ]] || fail "busy fence not RELEASED"
[[ "$(val -c "select status from postona_x_resv.reservations where id = '$R47'")" == planned ]] || fail "busy fence row not planned"
[[ "$(as_worker "select count(*) from postona_x_resv.claim_due('w3', 120, 50) where reservation_id = '$R47'")" == 0 ]] || fail "busy owner claimed"
wait "$h"
[[ "$(as_worker "select count(*) from postona_x_resv.claim_due('w3', 120, 50) where reservation_id = '$R47'")" == 1 ]] || fail "owner not claimed after the fence"
own "$db" -c "update postona_x_resv.reservations set status = 'cancelled', lease_token = null, lease_expires_at = null where id = '$R47' or id = '$R45' or id = '$R46'" >/dev/null
echo "BUSY_FENCE_RELEASED_NOT_UNCERTAIN_PASS"

# D3: the REAL app store / reservation HTTP handler / worker HTTP handler / driver / SQL with a fake X.
if ! RESV_DSP_API_URL="postgres://$apilogin@127.0.0.1:$port/$db" RESV_DSP_WORKER_URL="postgres://$wlogin@127.0.0.1:$port/$db" \
  RESV_DSP_OWNER_URL="postgres://$owner@127.0.0.1:$port/$db" DENO_NO_PACKAGE_JSON=1 \
  deno test --no-config --no-check --allow-net=127.0.0.1:"$port" --allow-read --allow-env=RESV_DSP_API_URL,RESV_DSP_WORKER_URL,RESV_DSP_OWNER_URL \
  "$here/dispatch/dispatch_e2e_test.ts" >"$tmp/d3" 2>&1; then
  cat "$tmp/d3"; fail "dispatch e2e"
fi
grep -E "passed|failed" "$tmp/d3" | tail -1
echo "D3_REAL_APP_API_WORKER_END_TO_END_PASS"

# D4: rollback restores 001's row-first bodies, removes release_unsent and the worker role; re-apply works.
own "$db" -f "$here/004_postona_x_resv_dispatch_rollback.sql" >/dev/null
[[ "$(val -c "select (to_regrole('postona_resv_worker') is null and to_regprocedure('postona_x_resv.release_unsent(uuid,uuid)') is null
  and to_regprocedure('postona_x_resv.release_claim(uuid,uuid,text)') is null
  and (select prosrc from pg_proc where oid = 'postona_x_resv.lock_own(uuid,integer)'::regprocedure) !~ 'FIRST'
  and (select prosrc from pg_proc where oid = 'postona_x_resv.claim_due(text,integer,integer)'::regprocedure) !~ 'v_allowed')::text")" == true ]] || fail "D4 rollback left 004"
own "$db" -f "$here/004_postona_x_resv_dispatch_rollback.sql" >/dev/null
own "$db" -f "$candidate" >/dev/null
echo "D4_ROLLBACK_REAPPLY_PASS"
echo "POSTONA_RESV_DISPATCH_ALL_PASS"
