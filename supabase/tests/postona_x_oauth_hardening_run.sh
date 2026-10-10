#!/usr/bin/env bash
# Disposable-only proof runner for the POSTONA X OAuth hardening candidate
# (supabase/candidates/postona_x_oauth_hardening_candidate.sql; NOT a migration). On a LOCAL Unix-socket
# PostgreSQL 17 cluster, as a per-run non-superuser owner, it:
#   1. builds the G5 lifecycle world from the existing fixtures and the REAL migrations (the live X
#      onboarding 20260919120000 + 20260922003101, account deletion, common account Phase 1 / service
#      start / Phase 3a), aligns it to Phase 2a-2's starting contract and applies 2a-2, with pgcrypto in
#      the extensions schema;
#   2. puts the service-write guard (T13) in place -- POSTONA_T13=mock (default): PR #124's stand-in,
#      MOCK_ONLY, never a security proof of G5's guard, Supabase Auth or sessions; POSTONA_T13=g5: G5's
#      own guard candidate and fixture (Draft PR #121) from POSTONA_G5_GUARD_FIXTURE /
#      POSTONA_G5_GUARD_MIGRATION -- and then PR #124's Threads/T9 candidate (the personal-workspace
#      provisioner this candidate requires) with its test fixture, from POSTONA_PR124_DIR (a directory
#      holding the three PR #124 files at the reviewed head; defaults to this checkout once PR #124 is in
#      it); then this candidate's own fake attestation key;
#   3. refuses to apply the candidate from adverse states, each with its fixed code and nothing created:
#      no guard, a guard an API role can execute or of another owner, no provisioner, a provisioner of
#      another kind / reachable / of another owner, another creator, a superuser, no pgcrypto, no or a
#      wider provider-identity index, Vault without names, re-apply;
#   4. applies it, checks that the live X RPCs and PR #124's functions are unchanged and that no API role
#      reaches a new function, grants authenticated EXECUTE on the three X v2 and the three Threads RPCs
#      (TEST-ONLY: the candidates grant nothing) and runs postona_x_oauth_hardening_behavior.sql (Stage A
#      reproduction on the live RPCs, then v2);
#   5. races two sessions (the live RPCs re-granted for the switch window): two v2 begins; v2 and Threads
#      begin; live and v2 begin, both orders; the lock order; v2 begin and account deletion, both orders;
#      v2 complete and service deletion, both orders; two v2 completes of one state; one X identity by two
#      people on v2; a live squat racing a genuine v2 connection;
#   6. removes the provisioner, then the guard, after the apply: every v2 RPC fails closed.
# Fake data only; every database and role is dropped. Never production.
#
# MUST RUN ALONE on its disposable cluster: one adverse case grants a role to the cluster-wide
# authenticated role (undone by the case and by the exit trap).
# Usage: POSTONA_PGHOST=/private/tmp/<socket-dir> POSTONA_PGPORT=<port> POSTONA_PGSUPER=<local superuser> \
#        POSTONA_PR124_DIR=<dir> [POSTONA_T13=mock|g5] supabase/tests/postona_x_oauth_hardening_run.sh
# POSTONA_CANDIDATE=<file> runs the same proof against another copy of the candidate.
# The server must answer in English (lc_messages=C).
set -euo pipefail
export LC_ALL=C
export PGOPTIONS="-c client_min_messages=warning"

host="${POSTONA_PGHOST:?POSTONA_PGHOST (local socket dir) required}"
port="${POSTONA_PGPORT:?POSTONA_PGPORT required}"
super="${POSTONA_PGSUPER:?POSTONA_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: POSTONA_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
mode="${POSTONA_T13:-mock}"
case "$mode" in
  mock) ;;
  g5)
    g5_fixture="${POSTONA_G5_GUARD_FIXTURE:?POSTONA_G5_GUARD_FIXTURE required in g5 mode}"
    g5_guard="${POSTONA_G5_GUARD_MIGRATION:?POSTONA_G5_GUARD_MIGRATION required in g5 mode}"
    ;;
  *) echo "POSTONA_T13 must be mock or g5." >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="${POSTONA_CANDIDATE:-$here/../candidates/postona_x_oauth_hardening_candidate.sql}"
if [[ -n "${POSTONA_PR124_DIR:-}" ]]; then
  pr124_candidate="$POSTONA_PR124_DIR/postona_threads_oauth_workspace_candidate.sql"
  pr124_mock_t13="$POSTONA_PR124_DIR/postona_threads_oauth_mock_t13_fixture.sql"
  pr124_fixture="$POSTONA_PR124_DIR/postona_threads_oauth_test_fixture.sql"
else
  pr124_candidate="$here/../candidates/postona_threads_oauth_workspace_candidate.sql"
  pr124_mock_t13="$here/postona_threads_oauth_mock_t13_fixture.sql"
  pr124_fixture="$here/postona_threads_oauth_test_fixture.sql"
fi
for f in "$pr124_candidate" "$pr124_mock_t13" "$pr124_fixture"; do
  [[ -s "$f" ]] || { echo "PR #124's file is missing: $f (set POSTONA_PR124_DIR). The candidate depends on its provisioner." >&2; exit 2; }
done
psql_bin="${PSQL:-psql}"
n="$$"
owner="kb_xoauth_owner_$n"  # this run's table owner and candidate creator
other="kb_xoauth_other_$n"  # a creator that owns nothing
mid="kb_xoauth_mid_$n"      # a role an API role may be granted
base="kabumori_xoauth_${n}_base"
t9="kabumori_xoauth_${n}_t9"

as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-xoauth.XXXXXX)"
fail() { echo "FAIL $*" >&2; exit 1; }

restore_roles() {
  "${as_super[@]}" -d postgres > /dev/null 2>&1 <<SQL || true
revoke $mid from authenticated, anon, service_role;
revoke $owner from authenticated, anon, service_role;
SQL
}
cleanup() {
  restore_roles
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like 'kabumori_xoauth_${n}_%' order by datname" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  for role in "$mid" "$other" "$owner"; do
    "${as_super[@]}" -d postgres -c "drop role if exists $role" > /dev/null 2>&1 || true
  done
  rm -rf "$tmp"
}
trap cleanup EXIT

"${as_super[@]}" -d postgres > /dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb nocreaterole;
create role $other login nosuperuser nocreatedb nocreaterole;
create role $mid nologin;
-- The fixtures' helpers act as the app roles (set role authenticated / service_role).
grant anon, authenticated, service_role to $owner;
SQL
[[ "$("${as_super[@]}" -d postgres -c "select exists (select 1 from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and (pg_has_role(r.oid, '$owner', 'MEMBER') or pg_has_role(r.oid, '$mid', 'MEMBER')))")" == f ]] \
  || fail "an API role already reaches this run's roles"

as_owner() { local db="$1"; shift; "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
q() { "$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$1" -c "$2"; }
create_db() {
  [[ "$("${as_super[@]}" -d postgres -c "select count(*) from pg_database where datname = '$1'")" == 0 ]] || fail "database $1 already exists"
  "${as_super[@]}" -d postgres -c "create database $1 owner $owner${2:+ template $2}" > /dev/null
}
copy() { local db="kabumori_xoauth_${n}_$1"; create_db "$db" "${2:-$t9}"; echo "$db"; }
# Applies a file as a role; prints "applied" or the first ERROR text.
apply() {
  local db="$1" role="$2" file="$3" out
  if out="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$role" -d "$db" -f "$file" 2>&1)"; then
    echo applied
  else
    sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1
  fi
}
new_functions() {
  q "$1" "select count(*) from pg_proc where proname in ('begin_social_mobile_x_oauth_connection_v2', 'consume_social_mobile_x_oauth_state_v2',
                                                       'complete_social_mobile_x_oauth_connection_v2')"
}
functions_fingerprint() {
  q "$1" "select md5(string_agg(p.oid::regprocedure::text || ':' || coalesce(p.proacl::text, '') || ':' || md5(p.prosrc), ',' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)"
}
expect_refused() {
  local label="$1" db="$2" code="$3" role="${4:-$owner}" before got
  before="$(functions_fingerprint "$db")"
  got="$(apply "$db" "$role" "$candidate")"
  [[ "$got" == "$code" ]] || fail "$label: expected $code, got ${got:-applied}"
  [[ "$(new_functions "$db")" == 0 && "$(functions_fingerprint "$db")" == "$before" ]] || fail "$label: the refused apply changed something"
  echo "refused as expected: $label"
}

# 1. The world -----------------------------------------------------------------------------------------
create_db "$base"
as_owner "$base" -f "$here/social_mobile_account_deletion_fixture.sql" > /dev/null
as_owner "$base" -f "$migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" > /dev/null 2>&1
as_owner "$base" -f "$migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" > /dev/null
as_owner "$base" -f "$migrations/20260928160000_social_mobile_account_deletion_candidate.sql" > /dev/null
as_owner "$base" -f "$here/common_account_lifecycle_fixture.sql" > /dev/null
as_owner "$base" -f "$migrations/20261001150000_common_account_lifecycle_foundation.sql" > /dev/null
as_owner "$base" -f "$migrations/20261006230000_common_account_service_start_intent.sql" > /dev/null
as_owner "$base" -f "$migrations/20261009120000_common_account_deletion_completion.sql" > /dev/null
# 2a-2's reviewed starting contract (as postona_social_accounts_multi_provider_run.sh aligns it).
as_owner "$base" -f "$here/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
as_owner "$base" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'" > /dev/null
as_owner "$base" -c "alter table public.x_account_refresh_state_v2 add column last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$')" > /dev/null
awk 'index($0, "create function public.x_account_refresh_reset_on_reconnect()") == 1 { on = 1 } on { print } on && $0 == "$$;" { exit }' \
  "$migrations/20260925140000_x_account_credential_refresh_core.sql" > "$tmp/reset_fn.sql"
[[ -s "$tmp/reset_fn.sql" ]] || fail "could not extract x_account_refresh_reset_on_reconnect"
as_owner "$base" -f "$tmp/reset_fn.sql" > /dev/null
as_owner "$base" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public, anon, authenticated, service_role" > /dev/null
as_owner "$base" -c "create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when (new.connection_status = 'identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect()" > /dev/null
[[ "$(apply "$base" "$owner" "$migrations/20261007150000_postona_social_accounts_multi_provider.sql")" == applied ]] || fail "2a-2 did not apply"
"${as_super[@]}" -d "$base" -c "create schema extensions" -c "grant usage on schema extensions to public" -c "create extension pgcrypto with schema extensions" > /dev/null
if [[ "$mode" == mock ]]; then
  as_owner "$base" -f "$pr124_mock_t13" > /dev/null
  echo "T13: MOCK_ONLY stand-in (PR #124 fixture $(shasum -a 256 "$pr124_mock_t13" | cut -c1-16))"
else
  as_owner "$base" -f "$g5_fixture" > /dev/null
  [[ "$(apply "$base" "$owner" "$g5_guard")" == applied ]] || fail "G5 guard candidate did not apply"
  echo "T13: G5 guard candidate $(shasum -a 256 "$g5_guard" | cut -c1-16) (fixture $(shasum -a 256 "$g5_fixture" | cut -c1-16))"
fi
as_owner "$base" -f "$pr124_fixture" > /dev/null
as_owner "$base" -f "$here/postona_x_oauth_hardening_test_fixture.sql" > /dev/null
# The base keeps no provisioner (for the T9_MISSING case); t9 is the base plus PR #124's candidate.
create_db "$t9" "$base"
[[ "$(apply "$t9" "$owner" "$pr124_candidate")" == applied ]] || fail "PR #124's candidate did not apply"
echo "world built: G5 lifecycle + live X onboarding + 2a-2 + PR #124 T9 ($(shasum -a 256 "$pr124_candidate" | cut -c1-16)) + Vault names + pgcrypto"

# 2. Adverse starting states: refused with nothing created ---------------------------------------------
t13="private.account_lifecycle_assert_active_service_write(uuid, text)"
t9fn="private.social_mobile_ensure_personal_workspace(uuid)"
db="$(copy no_t13)"; q "$db" "drop function $t13" > /dev/null
expect_refused "no guard" "$db" POSTONA_X_OAUTH_PRECONDITION_T13_MISSING
for grantee in authenticated public; do
  db="$(copy "t13_$grantee")"; q "$db" "grant execute on function $t13 to $grantee" > /dev/null
  expect_refused "guard executable by $grantee" "$db" POSTONA_X_OAUTH_PRECONDITION_T13_CONTRACT
done
db="$(copy t13_membership)"; q "$db" "grant execute on function $t13 to $mid" > /dev/null
"${as_super[@]}" -d postgres -c "grant $mid to authenticated" > /dev/null
expect_refused "guard reachable through a membership" "$db" POSTONA_X_OAUTH_PRECONDITION_T13_CONTRACT
"${as_super[@]}" -d postgres -c "revoke $mid from authenticated" > /dev/null
db="$(copy t13_owner)"; "${as_super[@]}" -d "$db" -c "alter function $t13 owner to $other" > /dev/null
expect_refused "guard of another owner" "$db" POSTONA_X_OAUTH_PRECONDITION_T13_CONTRACT
db="$(copy no_t9 "$base")"
expect_refused "no provisioner (PR #124 not applied)" "$db" POSTONA_X_OAUTH_PRECONDITION_T9_MISSING
db="$(copy t9_definer)"; q "$db" "alter function $t9fn security definer" > /dev/null
expect_refused "provisioner SECURITY DEFINER" "$db" POSTONA_X_OAUTH_PRECONDITION_T9_CONTRACT
db="$(copy t9_reachable)"; q "$db" "grant execute on function $t9fn to service_role" > /dev/null
expect_refused "provisioner executable by service_role" "$db" POSTONA_X_OAUTH_PRECONDITION_T9_CONTRACT
db="$(copy t9_owner)"; "${as_super[@]}" -d "$db" -c "alter function $t9fn owner to $other" > /dev/null
expect_refused "provisioner of another owner" "$db" POSTONA_X_OAUTH_PRECONDITION_T9_CONTRACT
db="$(copy other_creator)"
expect_refused "another creator" "$db" POSTONA_X_OAUTH_PRECONDITION_OWNER "$other"
expect_refused "a superuser" "$db" POSTONA_X_OAUTH_PRECONDITION_OWNER "$super"
db="$(copy no_pgcrypto)"; "${as_super[@]}" -d "$db" -c "drop extension pgcrypto" > /dev/null
expect_refused "no pgcrypto" "$db" POSTONA_X_OAUTH_PRECONDITION_SHAPE
db="$(copy no_identity_index)"; q "$db" "drop index public.social_accounts_platform_user_id_key" > /dev/null
expect_refused "no provider-identity index" "$db" POSTONA_X_OAUTH_PRECONDITION_SHAPE
db="$(copy wide_identity_index)"
q "$db" "drop index public.social_accounts_platform_user_id_key" > /dev/null
q "$db" "create unique index social_accounts_platform_user_id_key on public.social_accounts (platform, platform_user_id, brand_id) where platform_user_id is not null" > /dev/null
expect_refused "a wider provider-identity index" "$db" POSTONA_X_OAUTH_PRECONDITION_SHAPE
db="$(copy vault_unnamed)"; q "$db" "drop view vault.decrypted_secrets" > /dev/null
q "$db" "create view vault.decrypted_secrets as select s.id, s.secret as decrypted_secret from vault.secrets s" > /dev/null
expect_refused "Vault without secret names" "$db" POSTONA_X_OAUTH_PRECONDITION_SHAPE
echo "POSTONA_X_OAUTH_ADVERSE_APPLY_PASS"

# 3. Apply ----------------------------------------------------------------------------------------------
main="$(copy main)"
live_rpcs="select md5(string_agg(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text)) from pg_proc p
           where p.proname in ('begin_social_mobile_x_oauth_connection', 'consume_social_mobile_x_oauth_state', 'complete_social_mobile_x_oauth_connection',
                               'social_mobile_ensure_personal_workspace', 'begin_social_mobile_threads_oauth_connection',
                               'consume_social_mobile_threads_oauth_state', 'complete_social_mobile_threads_oauth_connection')"
live_before="$(q "$main" "$live_rpcs")"
[[ "$(apply "$main" "$owner" "$candidate")" == applied ]] || fail "candidate did not apply"
[[ "$(new_functions "$main")" == 3 ]] || fail "candidate functions missing"
[[ "$(q "$main" "$live_rpcs")" == "$live_before" ]] || fail "the live X RPCs or PR #124's functions changed"
[[ "$(q "$main" "select count(*) from pg_proc p, (values ('anon'), ('authenticated'), ('service_role'), ('public')) r(role)
                 where p.proname in ('begin_social_mobile_x_oauth_connection_v2', 'consume_social_mobile_x_oauth_state_v2',
                                     'complete_social_mobile_x_oauth_connection_v2')
                   and (case when r.role = 'public' then exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)
                             else has_function_privilege(r.role, p.oid, 'EXECUTE') end)")" == 0 ]] \
  || fail "an API role reaches a new function"
reapply="$(copy reapply_src)"; [[ "$(apply "$reapply" "$owner" "$candidate")" == applied ]] || fail "candidate did not apply (re-apply copy)"
got="$(apply "$reapply" "$owner" "$candidate")"; [[ "$got" == POSTONA_X_OAUTH_PRECONDITION_ALREADY_APPLIED ]] || fail "re-apply: $got"
echo "applied: 3 functions, owner-only; live X RPCs and PR #124 unchanged; re-apply refused"

# 4. Behavior (TEST-ONLY grants) ---------------------------------------------------------------------------
q "$main" "grant execute on function public.begin_social_mobile_x_oauth_connection_v2(text, text, timestamptz),
                                      public.consume_social_mobile_x_oauth_state_v2(text),
                                      public.complete_social_mobile_x_oauth_connection_v2(uuid, text, text, text, text, text),
                                      public.begin_social_mobile_threads_oauth_connection(text, text, timestamptz),
                                      public.consume_social_mobile_threads_oauth_state(text),
                                      public.complete_social_mobile_threads_oauth_connection(uuid, text, text, text, text) to authenticated" > /dev/null
mock_flag=false; g5_flag=false
if [[ "$mode" == mock ]]; then mock_flag=true; else g5_flag=true; fi
as_owner "$main" -A -t -v mock="$mock_flag" -v g5="$g5_flag" -v owner="$owner" -f "$here/postona_x_oauth_hardening_behavior.sql" > "$tmp/behavior.out" 2>&1 \
  || { tail -5 "$tmp/behavior.out" >&2; fail "behavior"; }
grep '^POSTONA_X_OAUTH_' "$tmp/behavior.out"
grep -q '^POSTONA_X_OAUTH_BEHAVIOR_PASS$' "$tmp/behavior.out" || fail "behavior did not finish"

# 5. Races (the live RPCs re-granted: the window between granting v2 and revoking them) ---------------------
q "$main" "grant execute on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz),
                                      public.consume_social_mobile_x_oauth_state(text),
                                      public.complete_social_mobile_x_oauth_connection(uuid, text, text, text, text) to authenticated" > /dev/null
run() { q "$main" "$1"; }
uid() { printf '00000000-0000-4000-8000-0000000d%04d' "$1"; }
person() { run "select postona_xt.login('$1'); select postona_xt.register('$1')" > /dev/null; }
ws() { run "select postona_xt.ws('$1')"; }
call() { echo "select postona_xt.call('$1', $2);"; }
call_live() { echo "select postona_xt.call('$1', $2, p_guarded => false);"; }
begin_of() { echo "postona_xt.begin_sql('$1')"; }
complete_of() { echo "postona_xt.complete_sql('$1', '$2', 'race_handle', '$3', '$3R')"; }
as_service() { echo "set local role service_role; $1; reset role;"; }
wait_for() {  # condition SQL returning t, label
  for _ in $(seq 1 60); do
    [[ "$(run "$1")" == t ]] && return 0
    sleep 0.1
  done
  fail "timed out waiting for: $2"
}
waiting_on() { echo "select exists (select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%$1%' and pid <> pg_backend_pid())"; }
counts() {
  run "select (select count(*) from public.brands where id = '$2') || '/' || (select count(*) from public.brand_memberships where user_id = '$1')
              || '/' || (select coalesce(string_agg(platform, ',' order by platform), '') from public.social_accounts where brand_id = '$2')
              || '/' || (select count(*) from public.social_account_oauth_states where initiated_by_user_id = '$1')"
}

# Race 1: two v2 begins of one new person.
u="$(uid 1)"; person "$u"; w="$(ws "$u")"
run "begin; $(call "$u" "$(begin_of r1a)") select pg_sleep(1.5); commit;" > "$tmp/r1a" 2>&1 &
sleep 0.3
run "begin; $(call "$u" "$(begin_of r1b)") commit;" > "$tmp/r1b" 2>&1 &
wait_for "$(waiting_on "r1b")" "race1 second begin waiting"
wait
grep -qx OK "$tmp/r1a" && grep -qx OK "$tmp/r1b" || fail "race1: $(cat "$tmp/r1a" "$tmp/r1b")"
[[ "$(counts "$u" "$w")" == "1/1/x/2" ]] || fail "race1 counts $(counts "$u" "$w")"
echo "POSTONA_X_OAUTH_RACE_TWO_BEGINS_PASS"

# Race 2: v2 begin and Threads begin; live begin and v2 begin; each in both orders.
i=0
for pair in "v2 threads" "threads v2" "live v2" "v2 live"; do
  first="${pair% *}"; second="${pair#* }"; i=$((i + 1)); u="$(uid $((10 + i)))"; person "$u"; w="$(ws "$u")"
  sql_of() {
    case "$1" in
      v2) call "$u" "$(begin_of "r2$2$i")" ;;
      threads) call "$u" "postona_xt.threads_begin_sql('r2$2$i')" ;;
      live) call_live "$u" "postona_xt.live_begin_sql('r2$2$i')" ;;
    esac
  }
  run "begin; $(sql_of "$first" a) select pg_sleep(1.5); commit;" > "$tmp/r2a" 2>&1 &
  sleep 0.3
  run "begin; $(sql_of "$second" b) commit;" > "$tmp/r2b" 2>&1 &
  wait_for "$(waiting_on "r2b$i")" "race2 $pair: second waiting"
  wait
  grep -qx OK "$tmp/r2a" && grep -qx OK "$tmp/r2b" || fail "race2 $pair: $(cat "$tmp/r2a" "$tmp/r2b")"
  expected="1/1/x/2"; [[ "$pair" == *threads* ]] && expected="1/1/threads,x/2"
  [[ "$(counts "$u" "$w")" == "$expected" ]] || fail "race2 $pair counts $(counts "$u" "$w")"
done
echo "POSTONA_X_OAUTH_RACE_X_THREADS_LIVE_PASS"

# Race 3: lock order. While the person's common account is held, a v2 begin waits inside the guard and
# holds no workspace lock; while the workspace lock is held, a v2 begin that passed the guard keeps the
# account and entitlement locked.
u="$(uid 30)"; person "$u"; w="$(ws "$u")"
run "begin; select 1 from public.common_accounts where user_id = '$u' for update; select pg_sleep(2); commit;" > /dev/null &
sleep 0.3
run "begin; $(call "$u" "$(begin_of r3a)") commit;" > "$tmp/r3a" 2>&1 &
wait_for "$(waiting_on "r3a")" "race3a begin waiting on the account"
run "set lock_timeout = '300ms'; begin; select public.social_mobile_account_deletion_workspace_lock('$w'); commit;" > /dev/null \
  || fail "race3a: the waiting begin already holds the workspace lock"
[[ "$(counts "$u" "$w")" == "0/0//0" ]] || fail "race3a wrote before the guard"
wait
grep -qx OK "$tmp/r3a" || fail "race3a begin: $(cat "$tmp/r3a")"
u="$(uid 31)"; person "$u"; w="$(ws "$u")"
run "begin; select public.social_mobile_account_deletion_workspace_lock('$w'); select pg_sleep(2); commit;" > /dev/null &
sleep 0.3
run "begin; $(call "$u" "$(begin_of r3b)") commit;" > "$tmp/r3b" 2>&1 &
wait_for "$(waiting_on "r3b")" "race3b begin waiting on the workspace"
if run "set lock_timeout = '300ms'; select 1 from public.common_accounts where user_id = '$u' for update" > /dev/null 2>&1; then
  fail "race3b: the account is not held while the begin waits for the workspace"
fi
if run "set lock_timeout = '300ms'; select 1 from public.service_entitlements where user_id = '$u' and service_key = 'x_autopost' for update" > /dev/null 2>&1; then
  fail "race3b: the entitlement is not held while the begin waits for the workspace"
fi
wait
grep -qx OK "$tmp/r3b" || fail "race3b begin: $(cat "$tmp/r3b")"
echo "POSTONA_X_OAUTH_RACE_LOCK_ORDER_PASS"

# Race 4: v2 begin and account deletion, both orders.
u="$(uid 40)"; person "$u"; w="$(ws "$u")"; v="$(run "select lifecycle_version from public.common_accounts where user_id = '$u'")"
run "begin; $(as_service "select public.begin_common_account_deletion('$u', $v)") select pg_sleep(1.5); commit;" > "$tmp/r4d" 2>&1 &
sleep 0.3
run "begin; $(call "$u" "$(begin_of r4t)") commit;" > "$tmp/r4t" 2>&1 &
wait_for "$(waiting_on "r4t")" "race4 begin waiting behind the deletion"
wait
grep -q '"status": "started"' "$tmp/r4d" || fail "race4 deletion: $(cat "$tmp/r4d")"
grep -qx '42501 ACCOUNT_DELETION_IN_PROGRESS' "$tmp/r4t" || fail "race4 begin not refused: $(cat "$tmp/r4t")"
[[ "$(counts "$u" "$w")" == "0/0//0" ]] || fail "race4 begin created something"
u="$(uid 41)"; person "$u"; w="$(ws "$u")"; v="$(run "select lifecycle_version from public.common_accounts where user_id = '$u'")"
run "begin; $(call "$u" "$(begin_of r4t2)") select pg_sleep(1.5); commit;" > "$tmp/r4t2" 2>&1 &
sleep 0.3
run "begin; $(as_service "select public.begin_common_account_deletion('$u', $v) /* r4d2 */") commit;" > "$tmp/r4d2" 2>&1 &
wait_for "$(waiting_on "r4d2")" "race4 deletion waiting behind the begin"
wait
grep -qx OK "$tmp/r4t2" || fail "race4 begin first: $(cat "$tmp/r4t2")"
grep -q '"status": "started"' "$tmp/r4d2" || fail "race4 deletion after begin: $(cat "$tmp/r4d2")"
echo "POSTONA_X_OAUTH_RACE_BEGIN_AND_DELETION_PASS"

# Race 5: v2 complete and POSTONA-only service deletion, both orders.
u="$(uid 50)"; person "$u"
[[ "$(run "$(call "$u" "$(begin_of r5)")")" == OK ]] || fail "race5 setup"
run "begin; $(as_service "select public.begin_service_deletion('$u', 'x_autopost')") select pg_sleep(1.5); commit;" > "$tmp/r5d" 2>&1 &
sleep 0.3
run "begin; $(call "$u" "$(complete_of r5 1700000000000005001 fakeXaccessTOKENrace5)") commit;" > "$tmp/r5c" 2>&1 &
wait_for "$(waiting_on "fakeXaccessTOKENrace5")" "race5 complete waiting behind the deletion"
wait
grep -q '"status": "started"' "$tmp/r5d" || fail "race5 deletion: $(cat "$tmp/r5d")"
grep -qx '42501 SERVICE_DELETION_IN_PROGRESS' "$tmp/r5c" || fail "race5 complete not refused: $(cat "$tmp/r5c")"
[[ "$(run "select consumed_at is null from public.social_account_oauth_states where state_hash = postona_xt.h('r5')")" == t ]] || fail "race5 state consumed"
u="$(uid 51)"; person "$u"
[[ "$(run "$(call "$u" "$(begin_of r5b)")")" == OK ]] || fail "race5b setup"
run "begin; $(call "$u" "$(complete_of r5b 1700000000000005002 fakeXaccessTOKENrace5b)") select pg_sleep(1.5); commit;" > "$tmp/r5bc" 2>&1 &
sleep 0.3
run "begin; $(as_service "select public.begin_service_deletion('$u', 'x_autopost') /* r5bd */") commit;" > "$tmp/r5bd" 2>&1 &
wait_for "$(waiting_on "r5bd")" "race5 deletion waiting behind the complete"
wait
grep -qx OK "$tmp/r5bc" || fail "race5 complete first: $(cat "$tmp/r5bc")"
grep -q '"status": "started"' "$tmp/r5bd" || fail "race5 deletion after complete: $(cat "$tmp/r5bd")"
echo "POSTONA_X_OAUTH_RACE_COMPLETE_AND_SERVICE_DELETION_PASS"

# Race 6: two v2 completes of one state: exactly one succeeds.
u="$(uid 60)"; person "$u"
[[ "$(run "$(call "$u" "$(begin_of r6)")")" == OK ]] || fail "race6 setup"
run "begin; $(call "$u" "$(complete_of r6 1700000000000006001 fakeXaccessTOKENrace6a)") select pg_sleep(1.5); commit;" > "$tmp/r6a" 2>&1 &
sleep 0.3
run "begin; $(call "$u" "$(complete_of r6 1700000000000006001 fakeXaccessTOKENrace6b)") commit;" > "$tmp/r6b" 2>&1 &
wait_for "$(waiting_on "fakeXaccessTOKENrace6b")" "race6 second complete waiting"
wait
grep -qx OK "$tmp/r6a" || fail "race6 first: $(cat "$tmp/r6a")"
grep -qx 'P0001 OAUTH_STATE_NOT_CONSUMABLE' "$tmp/r6b" || fail "race6 second: $(cat "$tmp/r6b")"
echo "POSTONA_X_OAUTH_RACE_TWO_COMPLETES_PASS"

# Race 7: one X identity completed by two people on v2: exactly one connects; the other writes nothing.
u="$(uid 70)"; u2="$(uid 71)"; person "$u"; person "$u2"
[[ "$(run "$(call "$u" "$(begin_of r7a)")")" == OK && "$(run "$(call "$u2" "$(begin_of r7b)")")" == OK ]] || fail "race7 setup"
run "begin; $(call "$u" "$(complete_of r7a 1700000000000007001 fakeXaccessTOKENrace7a)") select pg_sleep(1.5); commit;" > "$tmp/r7a" 2>&1 &
sleep 0.3
run "begin; $(call "$u2" "$(complete_of r7b 1700000000000007001 fakeXaccessTOKENrace7b)") commit;" > "$tmp/r7b" 2>&1 &
wait_for "$(waiting_on "fakeXaccessTOKENrace7b")" "race7 second person waiting on the identity"
wait
grep -qx OK "$tmp/r7a" || fail "race7 first: $(cat "$tmp/r7a")"
grep -qx 'P0001 X_ACCOUNT_ALREADY_CONNECTED' "$tmp/r7b" || fail "race7 second: $(cat "$tmp/r7b")"
[[ "$(run "select (select count(*) from vault.secrets where secret like 'fakeXaccessTOKENrace7b%') || '/' ||
                  (select consumed_at is null from public.social_account_oauth_states where state_hash = postona_xt.h('r7b')) || '/' ||
                  (select connection_status from public.social_accounts where id = postona_xt.x_id('$u2'))")" == "0/true/authorization_pending" ]] \
  || fail "race7 second person wrote something"
echo "POSTONA_X_OAUTH_RACE_ONE_IDENTITY_PASS"

# Race 8 (the switch window): a squat through the live complete racing a genuine v2 connection of the
# same X id. Whichever commits first holds the identity; the other fails as a whole.
u="$(uid 80)"; u2="$(uid 81)"; person "$u"; person "$u2"
[[ "$(run "$(call_live "$u" "postona_xt.live_begin_sql('r8s')")")" == OK && "$(run "$(call "$u2" "$(begin_of r8v)")")" == OK ]] || fail "race8 setup"
run "begin; $(call_live "$u" "postona_xt.live_complete_sql('r8s', '1700000000000008001', 'victim', 'made-up-r8', 'made-up-r8-2')") select pg_sleep(1.5); commit;" > "$tmp/r8s" 2>&1 &
sleep 0.3
run "begin; $(call "$u2" "$(complete_of r8v 1700000000000008001 fakeXaccessTOKENrace8v)") commit;" > "$tmp/r8v" 2>&1 &
wait_for "$(waiting_on "fakeXaccessTOKENrace8v")" "race8 genuine connection waiting on the identity"
wait
grep -qx OK "$tmp/r8s" || fail "race8 squat: $(cat "$tmp/r8s")"
grep -qx 'P0001 X_ACCOUNT_ALREADY_CONNECTED' "$tmp/r8v" || fail "race8 genuine: $(cat "$tmp/r8v")"
echo "POSTONA_X_OAUTH_RACE_LIVE_SQUAT_WINDOW_PASS (the window stays open until the live RPCs are revoked)"

# 6. Fail closed after the apply: without the provisioner, then without the guard.
u="$(uid 90)"; person "$u"; w="$(ws "$u")"
[[ "$(run "$(call "$u" "$(begin_of r9)")")" == OK ]] || fail "fail-closed setup"
q "$main" "drop function $t9fn" > /dev/null
got="$(run "$(call "$u" "$(begin_of r9b)")")"
[[ "$got" == "42883 function private.social_mobile_ensure_personal_workspace("* ]] || fail "provisioner removed: $got"
[[ "$(counts "$u" "$w")" == "1/1/x/1" ]] || fail "provisioner removed: something was written"
q "$main" "drop function $t13" > /dev/null
for rpc in "$(begin_of r9c)" "postona_xt.consume_sql('r9')" "$(complete_of r9 1700000000000009001 fakeXaccessTOKENrace9)"; do
  got="$(run "$(call "$u" "$rpc")")"
  [[ "$got" == "42883 function private.account_lifecycle_assert_active_service_write("* ]] || fail "guard removed: $got"
done
[[ "$(counts "$u" "$w")" == "1/1/x/1" && "$(run "select consumed_at is null from public.social_account_oauth_states where state_hash = postona_xt.h('r9')")" == t ]] \
  || fail "guard removed: something was written"
echo "POSTONA_X_OAUTH_FAIL_CLOSED_PASS"

if [[ "$mode" == mock ]]; then
  echo "POSTONA_X_OAUTH_RUN_PASS (T13: MOCK_ONLY stand-in)"
else
  echo "POSTONA_X_OAUTH_RUN_PASS (T13: G5 guard candidate)"
fi
