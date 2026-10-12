#!/usr/bin/env bash
# POSTONA X reservations — G5 binding proof (003) on a disposable LOCAL PostgreSQL only. Never a remote project.
# Builds G5's production-shaped baseline from the G5 candidate SOURCE (Draft PR #165 = PR #152 + PR #121 + main's
# lifecycle migrations), then applies the reservation candidate 001 + 002 + 003 and proves the bound behaviour,
# the lock ordering against a freeze (two sessions), refusals and the rollback.
#
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> \
#        RESV_G5_SOURCE_DIR=<dir with supabase/migrations + supabase/tests of the G5 candidate commit> g5_binding_run.sh
# Without RESV_G5_SOURCE_DIR the run prints RUN_NOT_AVAILABLE and exits 3 (it never guesses G5's SQL).
# MOCK_ONLY: G4 (verified X account) is a test double. Roles are cluster-wide: run alone.
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
binding="${RESV_G5_BINDING:-$here/003_postona_x_resv_g5_binding.sql}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_postona_resv_g5_owner"
login="kb_postona_resv_g5_login"
db="kabumori_postona_resv_g5_$$"
plain="kabumori_postona_resv_g5_plain_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-resv-g5.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  for d in "$db" "$plain"; do "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done
  "${S[@]}" -d postgres -c "drop role if exists $login" -c "drop role if exists postona_resv_api" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

"${S[@]}" -d postgres -c "drop role if exists $login" -c "drop role if exists postona_resv_api" >/dev/null
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
echo "G5_BASELINE_READY"

# The reservation candidate on top: 001 (+ its DENY stubs) and 002 (API role).
own "$db" -f "$here/001_postona_x_reservations.sql" >/dev/null
own "$db" -f "$here/002_postona_x_resv_api_role.sql" >/dev/null
# Rollout simulation (test-only): a login role in postona_resv_api; the owner may SET ROLE to it for the suite.
"${S[@]}" -d postgres -c "create role $login login noinherit" -c "grant postona_resv_api to $login" \
  -c "grant postona_resv_api to $owner with inherit false, set true" >/dev/null
# B0: refusals. 003 needs 001 and G5; a re-apply is refused; a failed apply leaves nothing.
own "$plain" -f "$here/test_fixture.sql" >/dev/null
if own "$plain" -f "$binding" >"$tmp/b0" 2>&1; then fail "003 applied without 001"; fi
grep -q POSTONA_RESV_G5_BINDING_PRECONDITION_001_MISSING "$tmp/b0" || fail "b0 wrong refusal: $(tail -1 "$tmp/b0")"
own "$plain" -f "$here/001_postona_x_reservations.sql" >/dev/null
if own "$plain" -f "$binding" >"$tmp/b0" 2>&1; then fail "003 applied without G5"; fi
grep -q POSTONA_RESV_G5_BINDING_PRECONDITION_G5_MISSING "$tmp/b0" || fail "b0 wrong refusal: $(tail -1 "$tmp/b0")"
perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$binding" > "$tmp/fail.sql"
if own "$db" -f "$tmp/fail.sql" >/dev/null 2>&1; then fail "injected failure applied"; fi
[[ "$(own "$db" -A -t -c "select prosrc !~ 'G5_BINDING' from pg_proc where oid = 'postona_x_resv.g5_x_autopost_allowed(uuid)'::regprocedure")" == t ]] || fail "partial 003 left behind"
own "$db" -f "$binding" >/dev/null
if own "$db" -f "$binding" >"$tmp/b0" 2>&1; then fail "003 re-apply accepted"; fi
grep -q POSTONA_RESV_G5_BINDING_ALREADY_APPLIED "$tmp/b0" || fail "re-apply refused for another reason: $(tail -1 "$tmp/b0")"
echo "B0_BINDING_REFUSALS_ROLLBACK_REAPPLY_PASS"

# MOCK_ONLY G4 (after 003, whose postcondition requires the shipped G4 DENY): an allow list replaces it in this
# disposable database only.
own "$db" >/dev/null <<'SQL'
create schema t_mock;
create table t_mock.verified (user_id uuid, social_account_id text, primary key (user_id, social_account_id));
create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from t_mock.verified v where v.user_id = p_user_id and v.social_account_id = p_social_account_id) $$;
SQL


# B1: behaviour of the bound decision (create / list / get / cancel / worker) in every G5 state.
own "$db" -f "$here/g5_binding/g5_binding_behavior.sql" >"$tmp/b1" 2>&1 || { cat "$tmp/b1"; fail "behaviour"; }
for marker in G1_ACTIVE_ENTITLEMENT_ALLOWS_PASS G2_LIFECYCLE_REFUSES_EVERY_ACTION_PASS G3_WORKER_PATH_BOUND_PASS \
              G4_NO_DIRECT_ACCESS_PASS POSTONA_RESV_G5_BINDING_BEHAVIOR_PASS; do
  grep -q "$marker" "$tmp/b1" || { cat "$tmp/b1"; fail "missing $marker"; }
  echo "$marker"
done

# B2: lock ordering against a freeze, two sessions (the person A of the behaviour suite).
A='00000000-0000-4000-8000-000000000031'
ACC="x$(echo "$A" | tr -d '-')"
api() {  # $1 = SQL; runs as the login role in ONE transaction with the API role and A's claims
  psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$login" -d "$db" <<SQL
begin isolation level read committed;
set local role postona_resv_api;
select set_config('request.jwt.claim.sub', '$A', true), set_config('request.jwt.claims', '{"sub":"$A","role":"authenticated"}', true) \\g /dev/null
$1
commit;
SQL
}
items="$(own "$db" -A -t -c "select jsonb_build_array(jsonb_build_object('draft_id', 'race_1', 'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + 20 + time '10:00') at time zone 'Asia/Tokyo', 'body', 'race', 'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to('race', 'UTF8')), 'hex'))))")"
# (a) A freeze holds the account lock first: the reservation write waits (<= 3 s) and is refused as BUSY.
own "$db" -c "begin; select private.account_lifecycle_lock('$A', false); select pg_sleep(6); commit;" >/dev/null 2>&1 &
holder=$!
sleep 1
start=$(date +%s)
if api "select count(*) from postona_x_resv.create_batch('$ACC', gen_random_uuid(), 1, 'manual_exact', null, '$items'::jsonb);" >"$tmp/b2a" 2>&1; then fail "write passed a held fence"; fi
elapsed=$(( $(date +%s) - start ))
grep -q POSTONA_RESV_SERVICE_BUSY "$tmp/b2a" || fail "B2a wrong refusal: $(cat "$tmp/b2a")"
[[ $elapsed -ge 2 ]] || fail "B2a did not wait for the fence (${elapsed}s)"
wait $holder
[[ "$(own "$db" -A -t -c "select count(*) from postona_x_resv.reservations where draft_id = 'race_1'")" == 0 ]] || fail "B2a wrote"
# (b) The reservation transaction holds the fence: a freeze (account FOR UPDATE) waits until it commits.
api "select count(*) from postona_x_resv.create_batch('$ACC', gen_random_uuid(), 1, 'manual_exact', null, '$items'::jsonb); select pg_sleep(4);" >/dev/null 2>&1 &
writer=$!
sleep 1
start=$(date +%s)
own "$db" -c "begin; select user_id from public.common_accounts where user_id = '$A' for update; update public.common_accounts set status = 'locked' where user_id = '$A'; commit;" >/dev/null
elapsed=$(( $(date +%s) - start ))
wait $writer || fail "B2b writer failed"
[[ $elapsed -ge 2 ]] || fail "B2b freeze did not wait for the reservation transaction (${elapsed}s)"
[[ "$(own "$db" -A -t -c "select count(*) from postona_x_resv.reservations where draft_id = 'race_1'")" == 1 ]] || fail "B2b reservation missing"
# After the freeze committed, the next write is refused.
if api "select count(*) from postona_x_resv.list_reservations('$ACC');" >"$tmp/b2c" 2>&1; then fail "write after freeze passed"; fi
grep -q POSTONA_RESV_SERVICE_NOT_ACTIVE "$tmp/b2c" || fail "B2c wrong refusal: $(cat "$tmp/b2c")"
own "$db" -c "update public.common_accounts set status = 'active' where user_id = '$A'" >/dev/null
# (c) The G5 decision needs READ COMMITTED: any other isolation is refused (fail closed).
if psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$login" -d "$db" >"$tmp/b2d" 2>&1 <<SQL
begin isolation level repeatable read;
set local role postona_resv_api;
select set_config('request.jwt.claim.sub', '$A', true) \\g /dev/null
select count(*) from postona_x_resv.list_reservations('$ACC');
commit;
SQL
then fail "repeatable read passed"; fi
grep -q POSTONA_RESV_SERVICE_NOT_ACTIVE "$tmp/b2d" || fail "B2d wrong refusal: $(cat "$tmp/b2d")"
echo "B2_LOCK_ORDER_WITH_FREEZE_PASS"

# B3: rollback restores the DENY stub; 003 can be applied again afterwards.
own "$db" -f "$here/003_postona_x_resv_g5_binding_rollback.sql" >/dev/null
if api "select count(*) from postona_x_resv.list_reservations('$ACC');" >"$tmp/b3" 2>&1; then fail "allowed after rollback"; fi
grep -q POSTONA_RESV_SERVICE_NOT_ACTIVE "$tmp/b3" || fail "B3 wrong refusal"
# Re-binding needs the shipped G4 DENY back (003 refuses to bind next to a replaced G4 predicate).
if own "$db" -f "$binding" >"$tmp/b3" 2>&1; then fail "003 bound next to a mocked G4"; fi
grep -q "G4 predicate is not the shipped DENY" "$tmp/b3" || fail "B3 wrong refusal: $(tail -1 "$tmp/b3")"
own "$db" >/dev/null <<'SQL'
create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G4 contract (Issue #131): true only for an X account whose platform identity was proven by the reviewed
  -- OAuth flow for exactly this user and whose publish permission is on. Not implemented in G3: always false.
  select false
$$;
SQL
own "$db" -f "$binding" >/dev/null
# G5 allows A again, but G4 (shipped DENY) still refuses: the two decisions are independent.
if api "select count(*) from postona_x_resv.list_reservations('$ACC');" >"$tmp/b3" 2>&1; then fail "allowed without G4"; fi
grep -q POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED "$tmp/b3" || fail "B3 G4 refusal: $(cat "$tmp/b3")"
echo "B3_ROLLBACK_REBIND_G4_INDEPENDENT_PASS"
echo "POSTONA_RESV_G5_BINDING_ALL_PASS"
