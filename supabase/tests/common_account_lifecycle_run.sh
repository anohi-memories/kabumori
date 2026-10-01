#!/usr/bin/env bash
# Disposable-only proof runner for the common account lifecycle candidate
# (20261001150000). Creates a throwaway database on a LOCAL Unix-socket
# PostgreSQL cluster, applies the production-shaped fixtures, the real
# onboarding RPC migrations, the social-mobile deletion candidate and the
# candidate under test as a non-superuser owner, then proves: exact preflight,
# additive apply, static source rules, behavior, two-session races in both
# commit orders, and a rollback that only runs from an affirmed shadow state
# and restores the exact prior schema. Fake data only; never production.
#
# Wherever this file runs "delete from auth.users", it is the TEST standing in
# for whoever removes a login (a legacy route today, the orchestrator's managed
# API call later). The candidate itself never deletes a login.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> \
#        CAL_PGSUPER=<local superuser> supabase/tests/common_account_lifecycle_run.sh
set -euo pipefail

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_common_account_$$"
owner="kb_common_account_owner"
here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
# CAL_CANDIDATE / CAL_ROLLBACK exist for common_account_lifecycle_mutations.sh
# only: it points them at deliberately broken copies to prove this runner fails.
candidate="${CAL_CANDIDATE:-$migrations/20261001150000_common_account_lifecycle_foundation.sql}"
rollback="${CAL_ROLLBACK:-$here/common_account_lifecycle_rollback.sql}"
psql_bin="${PSQL:-psql}"
pg_dump_bin="${PG_DUMP:-pg_dump}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
as_owner=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
query=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
schema_dump() { "$pg_dump_bin" -h "$host" -p "$port" -U "$owner" -d "$db" --schema-only --no-comments | grep -v -E '^(\\restrict|\\unrestrict) '; }

tmp="$(mktemp -d /private/tmp/kabumori-common-account.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${as_super[@]}" -d postgres <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then
    create role $owner login nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL

# Production-shaped baseline: the existing fixture, the REAL onboarding RPCs
# and the REAL social-mobile deletion candidate, then this candidate's additions.
"${as_owner[@]}" -f "$here/social_mobile_account_deletion_fixture.sql"
"${as_owner[@]}" -f "$migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" 2>/dev/null
"${as_owner[@]}" -f "$migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql"
"${as_owner[@]}" -f "$migrations/20260928160000_social_mobile_account_deletion_candidate.sql"
"${as_owner[@]}" -f "$here/common_account_lifecycle_fixture.sql"

# 1. Exact preflight. Each case breaks one thing the invariants rely on, checks
#    that the candidate refuses with the exact reason and creates nothing, then
#    restores the schema.
preflight_refuses() {  # label, breaking SQL, expected message, restoring SQL
  "${as_owner[@]}" -c "$2"
  if out="$("${as_owner[@]}" -f "$candidate" 2>&1)"; then echo "FAIL preflight accepted: $1" >&2; exit 1; fi
  grep -qF "$3" <<<"$out" || { echo "FAIL preflight message for $1: $out" >&2; exit 1; }
  [[ "$("${query[@]}" -c "select coalesce(to_regclass('public.common_accounts')::text, 'absent')")" == absent ]] || { echo "FAIL preflight left objects behind: $1" >&2; exit 1; }
  "${as_owner[@]}" -c "$4"
}
preflight_refuses "missing column" \
  "alter table public.social_account_oauth_states rename column initiated_by_user_id to initiated_by_user_id_x" \
  "COMMON_ACCOUNT_PREFLIGHT_COLUMN_MISMATCH:public.social_account_oauth_states.initiated_by_user_id" \
  "alter table public.social_account_oauth_states rename column initiated_by_user_id_x to initiated_by_user_id"
preflight_refuses "column of another type" \
  "alter table storage.objects alter column owner_id type uuid using owner_id::uuid" \
  "COMMON_ACCOUNT_PREFLIGHT_COLUMN_MISMATCH:storage.objects.owner_id (text)" \
  "alter table storage.objects alter column owner_id type text"
# H1 counterexample 5: the table still has "a" foreign key to auth.users, but
# on an unrelated column; membership.user_id itself is no longer bound.
preflight_refuses "foreign key on the wrong column" \
  "alter table public.brand_memberships drop constraint brand_memberships_user_id_fkey;
   alter table public.brand_memberships add column unrelated_auth_id uuid references auth.users (id) on delete cascade" \
  "COMMON_ACCOUNT_PREFLIGHT_FK_MISMATCH:public.brand_memberships(user_id)->auth.users(id)" \
  "alter table public.brand_memberships drop column unrelated_auth_id;
   alter table public.brand_memberships add constraint brand_memberships_user_id_fkey foreign key (user_id) references auth.users (id) on delete cascade"
preflight_refuses "foreign key with another delete action" \
  "alter table public.social_account_oauth_states drop constraint social_account_oauth_states_initiated_by_user_id_fkey;
   alter table public.social_account_oauth_states add constraint social_account_oauth_states_initiated_by_user_id_fkey foreign key (initiated_by_user_id) references auth.users (id)" \
  "COMMON_ACCOUNT_PREFLIGHT_FK_MISMATCH:public.social_account_oauth_states(initiated_by_user_id)->auth.users(id)" \
  "alter table public.social_account_oauth_states drop constraint social_account_oauth_states_initiated_by_user_id_fkey;
   alter table public.social_account_oauth_states add constraint social_account_oauth_states_initiated_by_user_id_fkey foreign key (initiated_by_user_id) references auth.users (id) on delete cascade"
preflight_refuses "deferrable foreign key" \
  "alter table public.profiles alter constraint profiles_id_fkey deferrable" \
  "COMMON_ACCOUNT_PREFLIGHT_FK_MISMATCH:public.profiles(id)->auth.users(id)" \
  "alter table public.profiles alter constraint profiles_id_fkey not deferrable"
preflight_refuses "unvalidated foreign key" \
  "alter table public.admin_users drop constraint admin_users_user_id_fkey;
   alter table public.admin_users add constraint admin_users_user_id_fkey foreign key (user_id) references auth.users (id) on delete cascade not valid" \
  "COMMON_ACCOUNT_PREFLIGHT_FK_MISMATCH:public.admin_users(user_id)->auth.users(id)" \
  "alter table public.admin_users validate constraint admin_users_user_id_fkey"
preflight_refuses "Kabumori child table that does not cascade" \
  "create table public.fixture_profile_child (user_id uuid references public.profiles (id))" \
  "COMMON_ACCOUNT_PREFLIGHT_PROFILES_CHILD_NOT_CASCADE" \
  "drop table public.fixture_profile_child"
preflight_refuses "helper with another signature" \
  "alter function public.social_mobile_account_deletion_workspace(uuid) rename to social_mobile_account_deletion_workspace_x" \
  "COMMON_ACCOUNT_PREFLIGHT_FUNCTION_MISMATCH:public.social_mobile_account_deletion_workspace(uuid)" \
  "alter function public.social_mobile_account_deletion_workspace_x(uuid) rename to social_mobile_account_deletion_workspace"
echo "COMMON_ACCOUNT_EXACT_PREFLIGHT_PASS"

# 2. Additive apply: every prior schema line survives; a second apply is refused.
schema_dump > "$tmp/before.sql"
"${as_owner[@]}" -f "$candidate"
schema_dump > "$tmp/after.sql"
# pg_dump orders objects by name, so new objects shift blocks around: compare
# as line multisets. Every prior line must still be present, unchanged.
sort "$tmp/before.sql" > "$tmp/before.sorted"
sort "$tmp/after.sql" > "$tmp/after.sorted"
comm -23 "$tmp/before.sorted" "$tmp/after.sorted" > "$tmp/removed"
if [[ -s "$tmp/removed" ]]; then
  echo "FAIL the candidate changed or removed an existing definition:" >&2
  head -20 "$tmp/removed" >&2
  exit 1
fi
[[ -n "$(comm -13 "$tmp/before.sorted" "$tmp/after.sorted")" ]] || { echo "FAIL the candidate added nothing" >&2; exit 1; }
if out="$("${as_owner[@]}" -f "$candidate" 2>&1)"; then echo "FAIL re-apply was not refused" >&2; exit 1; fi
grep -q 'COMMON_ACCOUNT_FOUNDATION_ALREADY_APPLIED' <<<"$out" || { echo "FAIL re-apply message: $out" >&2; exit 1; }
echo "COMMON_ACCOUNT_ADDITIVE_APPLY_PASS"

# 3. Static checks on the candidate source (comments stripped).
code="$(sed -e 's/--.*$//' "$candidate")"
flat="$(tr '\n' ' ' <<<"$code" | tr ';' '\n')"
# H1 counterexample 1: the candidate must not be able to remove a login or any
# managed-service state. No write of any kind to auth, storage or vault.
if grep -qiE '(delete[[:space:]]+from|update|insert[[:space:]]+into|truncate)[[:space:]]+(only[[:space:]]+)?(auth|storage|vault)\.' <<<"$flat"; then
  echo "FAIL the candidate writes to a managed schema (auth / storage / vault)" >&2; exit 1
fi
if grep -qiE 'auth\.admin|/auth/v1|deleteUser' <<<"$code"; then echo "FAIL the candidate reaches for an Auth admin delete" >&2; exit 1; fi
# People are never matched by e-mail.
if grep -qiE 'e-?mail' <<<"$code"; then echo "FAIL the candidate reads e-mail" >&2; exit 1; fi
# Nothing existing is dropped, replaced or re-granted.
if grep -iE '\bdrop[[:space:]]+(table|function|view|trigger|policy|index|schema|constraint|column)\b|\btruncate[[:space:]]+(table[[:space:]]+)?(only[[:space:]]+)?[a-z_"]+\.|create or replace|alter (table|function|policy) (public|auth|vault|storage)\.' <<<"$code" \
     | grep -qvE 'alter table public\.(common_accounts|service_entitlements) enable row level security'; then
  echo "FAIL the candidate alters, drops or replaces an existing object" >&2; exit 1
fi
if grep -iE '^\s*(grant|revoke) ' <<<"$flat" | grep -qvE '(common_accounts|service_entitlements|account_lifecycle_|start_kabumori_service|start_x_autopost_service|common_account_deletion_|_service_deletion|withdraw_kabumori_service|_common_account_)'; then
  echo "FAIL the candidate grants or revokes on an object it did not create" >&2; exit 1
fi
# The only existing table it ever deletes from is the Kabumori profile row.
if grep -iE 'delete[[:space:]]+from' <<<"$flat" | grep -qvE 'delete[[:space:]]+from[[:space:]]+public\.profiles[[:space:]]+where[[:space:]]+id[[:space:]]*=[[:space:]]*p_user_id'; then
  echo "FAIL the candidate deletes from a table other than public.profiles" >&2; exit 1
fi
# Phase 1 has no enforcing guard mode: the word may appear in comments only.
if grep -qi "'enforce'" <<<"$code"; then echo "FAIL the candidate defines an enforcing guard mode" >&2; exit 1; fi
echo "COMMON_ACCOUNT_STATIC_NO_MANAGED_DELETE_PASS"

# 4. Behavior.
out="$("${as_owner[@]}" -A -t -f "$here/common_account_lifecycle_behavior.sql" 2>&1)" || { echo "$out" >&2; exit 1; }
grep -q COMMON_ACCOUNT_LIFECYCLE_BEHAVIOR_PASS <<<"$out" || { echo "FAIL behavior: $out" >&2; exit 1; }
echo "COMMON_ACCOUNT_LIFECYCLE_BEHAVIOR_PASS"

# 5. Two-session races. Each helper prints SQL for one committed call.
uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
as_user() { echo "select set_config('request.jwt.claim.sub', '$1', true); set local role authenticated; $2; reset role;"; }
as_service() { echo "set local role service_role; $1; reset role;"; }
run() { "${query[@]}" -c "$1"; }
start_sql() { as_user "$1" "select public.start_$2_service()"; }
begin_sql() { as_service "select public.begin_common_account_deletion('$1', $2)"; }
prepare_sql() { as_service "select public.prepare_common_account_auth_delete('$1', '$2')"; }
checkpoint_sql() { as_service "select public.record_common_account_deletion_checkpoint('$1', '$2', '$3')"; }
eligibility_sql() { as_service "select public.common_account_deletion_eligibility('$1')"; }
onboard_sql() { as_user "$1" "select * from public.begin_social_mobile_x_oauth_connection(repeat('$2', 64), 'kabumori-social://oauth-callback', now() + interval '10 minutes')"; }
count() { "${query[@]}" -c "select count(*) from $1"; }
workspace() { echo "'u_' || substr(md5('$1'), 1, 24)"; }
operation_of() { "${query[@]}" -c "select id from private.account_lifecycle_operations where user_id = '$1' and operation_type = 'account_deletion' and status = 'in_progress'"; }
wait_for() {  # condition SQL returning t, label
  for _ in $(seq 1 50); do
    [[ "$("${query[@]}" -c "$1")" == t ]] && return 0
    sleep 0.1
  done
  echo "FAIL timed out waiting for: $2" >&2; exit 1
}
# A login whose account row is already committed (Kabumori registered, version 2).
# Races on it are decided by the row lock, not by a unique-index wait on a new row.
registered_login() {
  "${as_owner[@]}" -c "select public.fixture_login('$1')" >/dev/null
  run "begin; $(start_sql "$1" kabumori) commit;" | grep -q '"started": true' || { echo "FAIL setup registered login $1" >&2; exit 1; }
}
# An account in 'deleting' with no service and both checkpoints recorded.
deleting_login() {
  "${as_owner[@]}" -c "select public.fixture_login('$1')" >/dev/null
  run "begin; $(begin_sql "$1" 0) commit;" | grep -q '"status": "started"' || { echo "FAIL setup deleting login $1" >&2; exit 1; }
  local op; op="$(operation_of "$1")"
  run "begin; $(checkpoint_sql "$1" "$op" session_revocation) $(checkpoint_sql "$1" "$op" storage_cleanup) commit;" >/dev/null
}
pause_on() {  # pause any entitlement insert for this login, inside the writing transaction
  "${as_owner[@]}" <<SQL
create function public.fixture_pause() returns trigger language plpgsql as \$\$
begin perform pg_sleep(2); return new; end \$\$;
create trigger fixture_pause before insert on public.service_entitlements
  for each row when (new.user_id = '$1') execute function public.fixture_pause();
SQL
}
pause_off() { "${as_owner[@]}" -c "drop trigger fixture_pause on public.service_entitlements" -c "drop function public.fixture_pause()"; }

# Race 1: a service start is in flight (uncommitted) when deletion begins.
# Deletion waits on the account row; the version the person confirmed is then
# stale, so it is refused, and a fresh begin sees the new service.
u="$(uid 901)"
registered_login "$u"
run "begin; $(start_sql "$u" x_autopost) select pg_sleep(2); commit;" > "$tmp/r1_start" 2>&1 &
sleep 0.5
run "begin; $(begin_sql "$u" 2) commit;" > "$tmp/r1_begin" 2>&1 &
wait
grep -q '"status": "active"' "$tmp/r1_start" || { echo "FAIL race1 start: $(cat "$tmp/r1_start")" >&2; exit 1; }
grep -q '"status": "lifecycle_changed"' "$tmp/r1_begin" || { echo "FAIL race1 begin did not see the start: $(cat "$tmp/r1_begin")" >&2; exit 1; }
[[ "$("${query[@]}" -c "select status from public.common_accounts where user_id = '$u'")" == active ]] || { echo "FAIL race1 account state" >&2; exit 1; }
run "begin; $(begin_sql "$u" 3) commit;" > "$tmp/r1_begin2" 2>&1
grep -q '"services_to_end": \["kabumori", "x_autopost"\]' "$tmp/r1_begin2" || { echo "FAIL race1 second begin: $(cat "$tmp/r1_begin2")" >&2; exit 1; }
run "begin; $(prepare_sql "$u" "$(operation_of "$u")") commit;" > "$tmp/r1_prepare" 2>&1
grep -q '"reason": "SERVICES_REMAIN"' "$tmp/r1_prepare" || { echo "FAIL race1 prepare: $(cat "$tmp/r1_prepare")" >&2; exit 1; }
# Same order for a login that has no account row yet: the person previewed
# "nothing" (version 0) while a first registration was in flight. The row that
# appears is not the fresh, empty one the confirmation was about.
u="$(uid 900)"
"${as_owner[@]}" -c "select public.fixture_login('$u')" >/dev/null
run "begin; $(start_sql "$u" kabumori) select pg_sleep(2); commit;" > "$tmp/r1_first_start" 2>&1 &
sleep 0.5
run "begin; $(begin_sql "$u" 0) commit;" > "$tmp/r1_absent_begin" 2>&1 &
wait
grep -q '"started": true' "$tmp/r1_first_start" || { echo "FAIL race1 first start: $(cat "$tmp/r1_first_start")" >&2; exit 1; }
grep -q '"status": "lifecycle_changed"' "$tmp/r1_absent_begin" || { echo "FAIL race1 absent preview accepted: $(cat "$tmp/r1_absent_begin")" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_START_THEN_DELETE_PASS"

# Race 2 (reverse order): deletion begins first and is uncommitted when a
# service start arrives. The start waits, then fails closed; nothing is created.
u="$(uid 902)"
registered_login "$u"
run "begin; $(begin_sql "$u" 2) select pg_sleep(2); commit;" > "$tmp/r2_begin" 2>&1 &
sleep 0.5
run "begin; $(start_sql "$u" x_autopost) commit;" > "$tmp/r2_start" 2>&1 &
wait
grep -q '"status": "started"' "$tmp/r2_begin" || { echo "FAIL race2 begin: $(cat "$tmp/r2_begin")" >&2; exit 1; }
grep -q '"reason": "ACCOUNT_DELETION_IN_PROGRESS"' "$tmp/r2_start" || { echo "FAIL race2 start not refused: $(cat "$tmp/r2_start")" >&2; exit 1; }
[[ "$(count "public.service_entitlements where user_id = '$u' and service_key = 'x_autopost'")" == 0 ]] || { echo "FAIL race2 created an entitlement" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_DELETE_THEN_START_PASS"

# Race 3: the readiness check is uncommitted (it holds the login row) when a
# lifecycle start and the legacy profile bootstrap arrive. Both wait. The
# lifecycle start is refused. The legacy creator is NOT gated in Phase 1 and
# succeeds afterwards -- so "ready" must be, and is, revalidated: the next
# prepare sees the new data and drops the operation back to cleanup. The login
# is never removed by any of this.
u="$(uid 903)"
deleting_login "$u"
op="$(operation_of "$u")"
run "begin; $(prepare_sql "$u" "$op") select pg_sleep(2); commit;" > "$tmp/r3_prepare" 2>&1 &
sleep 0.5
run "begin; $(start_sql "$u" kabumori) commit;" > "$tmp/r3_start" 2>&1 &
run "begin; $(as_user "$u" "select public.ensure_my_profile()") commit;" > "$tmp/r3_profile" 2>&1 &
wait
grep -q '"status": "ready_for_managed_auth_delete"' "$tmp/r3_prepare" || { echo "FAIL race3 prepare: $(cat "$tmp/r3_prepare")" >&2; exit 1; }
grep -q '"reason": "ACCOUNT_DELETION_IN_PROGRESS"' "$tmp/r3_start" || { echo "FAIL race3 start: $(cat "$tmp/r3_start")" >&2; exit 1; }
if grep -qi 'error' "$tmp/r3_profile"; then echo "FAIL race3 legacy bootstrap errored: $(cat "$tmp/r3_profile")" >&2; exit 1; fi
run "begin; $(prepare_sql "$u" "$op") commit;" > "$tmp/r3_prepare2" 2>&1
grep -q 'UNREGISTERED_SERVICE_FOOTPRINT' "$tmp/r3_prepare2" || { echo "FAIL race3 readiness not revalidated: $(cat "$tmp/r3_prepare2")" >&2; exit 1; }
[[ "$("${query[@]}" -c "select current_step from private.account_lifecycle_operations where id = '$op'")" == cleanup ]] || { echo "FAIL race3 operation still ready" >&2; exit 1; }
[[ "$(count "auth.users where id = '$u'")" == 1 && "$(count "public.profiles where id = '$u'")" == 1 ]] || { echo "FAIL race3 login or profile lost" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_READY_THEN_CREATORS_PASS"

# Race 4 (reverse order): each legacy creator is uncommitted when the readiness
# check arrives. It waits on the login row, then sees the new service data and
# refuses.
u="$(uid 904)"
deleting_login "$u"
op="$(operation_of "$u")"
run "begin; $(onboard_sql "$u" b) select pg_sleep(2); commit;" > "$tmp/r4_onboard" 2>&1 &
sleep 0.5
run "begin; $(prepare_sql "$u" "$op") commit;" > "$tmp/r4_prepare" 2>&1 &
wait
if grep -qi 'error' "$tmp/r4_onboard"; then echo "FAIL race4 onboarding errored: $(cat "$tmp/r4_onboard")" >&2; exit 1; fi
grep -q 'UNREGISTERED_SERVICE_FOOTPRINT' "$tmp/r4_prepare" || { echo "FAIL race4 prepare: $(cat "$tmp/r4_prepare")" >&2; exit 1; }
u="$(uid 905)"
deleting_login "$u"
op="$(operation_of "$u")"
run "begin; $(as_user "$u" "select public.ensure_my_profile()") select pg_sleep(2); commit;" > "$tmp/r4_profile" 2>&1 &
sleep 0.5
run "begin; $(prepare_sql "$u" "$op") commit;" > "$tmp/r4_prepare2" 2>&1 &
wait
grep -q 'UNREGISTERED_SERVICE_FOOTPRINT' "$tmp/r4_prepare2" || { echo "FAIL race4 prepare vs profile: $(cat "$tmp/r4_prepare2")" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_CREATORS_THEN_READY_PASS"

# Race 5: two deletion requests for one person. Exactly one operation.
u="$(uid 906)"
registered_login "$u"
run "begin; $(begin_sql "$u" 2) select pg_sleep(2); commit;" > "$tmp/r5_one" 2>&1 &
sleep 0.5
run "begin; $(begin_sql "$u" 2) commit;" > "$tmp/r5_two" 2>&1 &
wait
grep -q '"status": "started"' "$tmp/r5_one" || { echo "FAIL race5 first: $(cat "$tmp/r5_one")" >&2; exit 1; }
grep -q '"status": "in_progress"' "$tmp/r5_two" || { echo "FAIL race5 second: $(cat "$tmp/r5_two")" >&2; exit 1; }
[[ "$(count "private.account_lifecycle_operations where user_id = '$u'")" == 1 ]] || { echo "FAIL race5 operation count" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_DOUBLE_DELETE_PASS"

# Race 6: two first-ever starts for one person. One account, one entitlement.
u="$(uid 907)"
"${as_owner[@]}" -c "select public.fixture_login('$u')" >/dev/null
run "begin; $(start_sql "$u" x_autopost) select pg_sleep(2); commit;" > "$tmp/r6_one" 2>&1 &
sleep 0.5
run "begin; $(start_sql "$u" x_autopost) commit;" > "$tmp/r6_two" 2>&1 &
wait
grep -q '"started": true' "$tmp/r6_one" || { echo "FAIL race6 first: $(cat "$tmp/r6_one")" >&2; exit 1; }
grep -q '"started": false' "$tmp/r6_two" || { echo "FAIL race6 second: $(cat "$tmp/r6_two")" >&2; exit 1; }
[[ "$(count "public.service_entitlements where user_id = '$u'")" == 1 && "$("${query[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$u'")" == 2 ]] || { echo "FAIL race6 rows" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_DOUBLE_START_PASS"

# Race 7: the decision window itself. A test-only trigger pauses a service
# start INSIDE the RPC, after it took the account lock and read the state but
# before its entitlement row exists. Only the account row lock (I1) can make a
# concurrent deletion wait here.
u="$(uid 909)"
registered_login "$u"
pause_on "$u"
run "begin; $(start_sql "$u" x_autopost) commit;" > "$tmp/r7_start" 2>&1 &
sleep 0.5
run "begin; $(begin_sql "$u" 2) commit;" > "$tmp/r7_begin" 2>&1 &
wait
pause_off
grep -q '"started": true' "$tmp/r7_start" || { echo "FAIL race7 start: $(cat "$tmp/r7_start")" >&2; exit 1; }
grep -q '"status": "lifecycle_changed"' "$tmp/r7_begin" || { echo "FAIL race7 deletion was decided on stale state: $(cat "$tmp/r7_begin")" >&2; exit 1; }
[[ "$("${query[@]}" -c "select status from public.common_accounts where user_id = '$u'")" == active ]] || { echo "FAIL race7 account state" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_DECISION_WINDOW_PASS"

# Race 8: lock order against a hard delete of the login (shadow mode: what the
# existing Kabumori route and the existing X saga do today). The start is
# paused inside the RPC holding its locks. Both follow auth.users ->
# common_accounts, so the delete waits and then cascades: no deadlock.
u="$(uid 910)"
"${as_owner[@]}" -c "select public.fixture_login('$u')" >/dev/null
run "begin; $(start_sql "$u" x_autopost) commit;" >/dev/null
pause_on "$u"
run "begin; $(start_sql "$u" kabumori) commit;" > "$tmp/r8_start" 2>&1 &
sleep 0.5
run "begin; delete from auth.users where id = '$u'; commit;" > "$tmp/r8_delete" 2>&1 &
wait
pause_off
grep -q '"started": true' "$tmp/r8_start" || { echo "FAIL race8 start: $(cat "$tmp/r8_start")" >&2; exit 1; }
if grep -qi 'error' "$tmp/r8_delete"; then echo "FAIL race8 hard delete: $(cat "$tmp/r8_delete")" >&2; exit 1; fi
left="$("${query[@]}" -c "select (select count(*) from auth.users where id = '$u') + (select count(*) from public.common_accounts where user_id = '$u')
  + (select count(*) from public.service_entitlements where user_id = '$u') + (select count(*) from public.profiles where id = '$u')")"
[[ "$left" == 0 ]] || { echo "FAIL race8 rows left after the hard delete: $left" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_HARD_DELETE_LOCK_ORDER_PASS"

# Race 9 (H1 counterexample 3): an operator hold on the account is uncommitted
# when the backfill reaches that login. The backfill waits on the account row,
# re-reads the state after the lock, and grants nothing.
u="$(uid 911)"
"${as_owner[@]}" -c "select public.fixture_login('$u', true, false)" -c "insert into public.common_accounts (user_id) values ('$u')" >/dev/null
run "begin; update public.common_accounts set status = 'locked' where user_id = '$u'; select pg_sleep(2); commit;" > "$tmp/r9_lock" 2>&1 &
sleep 0.5
run "select private.account_lifecycle_backfill(true)" > "$tmp/r9_backfill" 2>&1 &
wait
grep -q '"applied": true' "$tmp/r9_backfill" || { echo "FAIL race9 backfill: $(cat "$tmp/r9_backfill")" >&2; exit 1; }
[[ "$("${query[@]}" -c "select status from public.common_accounts where user_id = '$u'")" == locked \
   && "$(count "public.service_entitlements where user_id = '$u'")" == 0 ]] || { echo "FAIL race9 entitlement granted to a locked account" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_LOCK_THEN_BACKFILL_PASS"

# Race 10 (reverse order): the backfill is paused inside its transaction, after
# it locked this login and decided, when the operator hold arrives. The hold
# waits for the backfill (it is seen blocked on a lock), so the entitlement was
# granted to an account that was still active, and the hold lands afterwards.
u="$(uid 912)"
"${as_owner[@]}" -c "select public.fixture_login('$u', true, false)" -c "insert into public.common_accounts (user_id) values ('$u')" >/dev/null
pause_on "$u"
run "select private.account_lifecycle_backfill(true)" > "$tmp/r10_backfill" 2>&1 &
wait_for "select exists (select 1 from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep')" "race10 backfill pause"
run "begin; update public.common_accounts set status = 'locked' where user_id = '$u'; commit;" > "$tmp/r10_lock" 2>&1 &
wait_for "select exists (select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%set status = ''locked''%' and pid <> pg_backend_pid())" "race10 hold blocked behind the backfill"
wait
pause_off
grep -q '"applied": true' "$tmp/r10_backfill" || { echo "FAIL race10 backfill: $(cat "$tmp/r10_backfill")" >&2; exit 1; }
[[ "$("${query[@]}" -c "select c.status || ':' || e.status || ':' || (e.created_at <= c.updated_at) from public.common_accounts c join public.service_entitlements e using (user_id) where c.user_id = '$u'")" == "locked:active:true" ]] || { echo "FAIL race10 order" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_BACKFILL_THEN_LOCK_PASS"

# Race 11 (H1 F2): a requirement change (a new always-required checkpoint) is
# uncommitted when the readiness check arrives. prepare waits on the settings
# row and then decides against the new requirement: not ready.
u="$(uid 913)"
deleting_login "$u"
op="$(operation_of "$u")"
run "begin; insert into private.account_lifecycle_managed_checkpoints values ('race_requirement_a', 'always'); select pg_sleep(2); commit;" > "$tmp/r11_registry" 2>&1 &
sleep 0.5
run "begin; $(prepare_sql "$u" "$op") commit;" > "$tmp/r11_prepare" 2>&1 &
wait
grep -q '"missing_checkpoints": \["race_requirement_a"\]' "$tmp/r11_prepare" || { echo "FAIL race11 readiness granted across a requirement change: $(cat "$tmp/r11_prepare")" >&2; exit 1; }
"${as_owner[@]}" -c "delete from private.account_lifecycle_managed_checkpoints where checkpoint_key = 'race_requirement_a'"
# Race 12 (reverse order): the readiness is granted but uncommitted when the
# requirement change arrives. The change waits, then moves the epoch and
# withdraws the readiness that was just granted.
u="$(uid 914)"
deleting_login "$u"
op="$(operation_of "$u")"
run "begin; $(prepare_sql "$u" "$op") select pg_sleep(2); commit;" > "$tmp/r12_prepare" 2>&1 &
sleep 0.5
run "begin; insert into private.account_lifecycle_managed_checkpoints values ('race_requirement_b', 'always'); commit;" > "$tmp/r12_registry" 2>&1 &
wait
grep -q '"status": "ready_for_managed_auth_delete"' "$tmp/r12_prepare" || { echo "FAIL race12 prepare: $(cat "$tmp/r12_prepare")" >&2; exit 1; }
[[ "$("${query[@]}" -c "select current_step || ':' || coalesce(last_error_code, '') from private.account_lifecycle_operations where id = '$op'")" == "cleanup:REQUIREMENT_EPOCH_CHANGED" ]] || { echo "FAIL race12 readiness survived a requirement change" >&2; exit 1; }
"${as_owner[@]}" -c "delete from private.account_lifecycle_managed_checkpoints where checkpoint_key = 'race_requirement_b'"
echo "COMMON_ACCOUNT_RACE_REQUIREMENT_CHANGE_PASS"

# Race 13 (H1 F1): a late admin membership is uncommitted when the readiness
# check arrives. Its insert holds the login row through its foreign key, so
# prepare waits, then sees the admin and refuses.
u="$(uid 916)"
deleting_login "$u"
op="$(operation_of "$u")"
run "begin; insert into public.admin_users values ('$u'); select pg_sleep(2); commit;" > "$tmp/r13_admin" 2>&1 &
sleep 0.5
run "begin; $(prepare_sql "$u" "$op") commit;" > "$tmp/r13_prepare" 2>&1 &
wait
grep -q '"reasons": \["ADMIN_ACCOUNT"\]' "$tmp/r13_prepare" || { echo "FAIL race13 readiness granted past a late admin: $(cat "$tmp/r13_prepare")" >&2; exit 1; }
# Race 14 (reverse order): the readiness is granted but uncommitted when the
# admin membership arrives. Phase 1 does not intercept admin_users, so the
# stored step stays ready -- and the authorization reads as stale, and the
# next prepare withdraws it. Nothing in Phase 1 authorizes a delete on it.
u="$(uid 917)"
deleting_login "$u"
op="$(operation_of "$u")"
run "begin; $(prepare_sql "$u" "$op") select pg_sleep(2); commit;" > "$tmp/r14_prepare" 2>&1 &
sleep 0.5
run "begin; insert into public.admin_users values ('$u'); commit;" > "$tmp/r14_admin" 2>&1 &
wait
grep -q '"status": "ready_for_managed_auth_delete"' "$tmp/r14_prepare" || { echo "FAIL race14 prepare: $(cat "$tmp/r14_prepare")" >&2; exit 1; }
run "begin; $(eligibility_sql "$u") commit;" > "$tmp/r14_eligibility" 2>&1
grep -q '"authorization": {"state": "stale", "problems": \["ADMIN_ACCOUNT"\]}' "$tmp/r14_eligibility" || { echo "FAIL race14 stale authorization not reported: $(cat "$tmp/r14_eligibility")" >&2; exit 1; }
run "begin; $(prepare_sql "$u" "$op") commit;" > "$tmp/r14_prepare2" 2>&1
grep -q '"reasons": \["ADMIN_ACCOUNT"\]' "$tmp/r14_prepare2" || { echo "FAIL race14 stale readiness refreshed: $(cat "$tmp/r14_prepare2")" >&2; exit 1; }
"${as_owner[@]}" -c "delete from public.admin_users where user_id in ('$(uid 916)', '$(uid 917)')"
echo "COMMON_ACCOUNT_RACE_LATE_BLOCKER_PASS"

# A lifecycle call outside READ COMMITTED would not see the state committed
# during its lock wait: it is refused.
u="$(uid 908)"
"${as_owner[@]}" -c "select public.fixture_login('$u')" >/dev/null
run "begin isolation level repeatable read; $(start_sql "$u" kabumori) commit;" > "$tmp/rr" 2>&1 || true
grep -q 'ACCOUNT_LIFECYCLE_REQUIRES_READ_COMMITTED' "$tmp/rr" || { echo "FAIL isolation guard: $(cat "$tmp/rr")" >&2; exit 1; }
run "begin isolation level repeatable read; select private.account_lifecycle_backfill(true); commit;" > "$tmp/rr_backfill" 2>&1 || true
grep -q 'ACCOUNT_LIFECYCLE_REQUIRES_READ_COMMITTED' "$tmp/rr_backfill" || { echo "FAIL backfill isolation guard: $(cat "$tmp/rr_backfill")" >&2; exit 1; }
echo "COMMON_ACCOUNT_ISOLATION_GUARD_PASS"

if grep -qi 'deadlock' "$tmp"/r*; then echo "FAIL deadlock detected" >&2; exit 1; fi
echo "COMMON_ACCOUNT_NO_DEADLOCK_PASS"

# 6. Rollback runs only from an affirmed shadow state, and then restores the
#    exact prior schema. Each refusal leaves every object in place.
registry="private.account_lifecycle_managed_checkpoints"
rollback_refuses() {  # label, expected message
  if out="$("${as_owner[@]}" -f "$rollback" 2>&1)"; then echo "FAIL rollback ran: $1" >&2; exit 1; fi
  grep -qF "$2" <<<"$out" || { echo "FAIL rollback refusal for $1: $out" >&2; exit 1; }
  [[ "$("${query[@]}" -c "select to_regclass('public.common_accounts') is not null and to_regprocedure('private.account_lifecycle_guard_account_delete()') is not null")" == t ]] || { echo "FAIL rollback removed objects: $1" >&2; exit 1; }
}
rollback_refuses "deletion in flight" "COMMON_ACCOUNT_ROLLBACK_REFUSED_OPERATIONS_EXIST"
# Clear the shadow rows the tests left (shadow mode: plain deletes are allowed).
"${as_owner[@]}" -c "delete from private.account_lifecycle_operations" -c "delete from public.common_accounts"
# H1 counterexample 6: no settings row. The guard treats that as "refuse", so
# rollback must not treat it as "safe to remove the guard".
"${as_owner[@]}" -c "delete from private.account_lifecycle_settings"
rollback_refuses "missing settings row" "COMMON_ACCOUNT_ROLLBACK_REFUSED_SETTINGS_NOT_AFFIRMED"
"${as_owner[@]}" -c "insert into private.account_lifecycle_settings default values"
"${as_owner[@]}" -c "update private.account_lifecycle_settings set integration_state = 'started'"
rollback_refuses "integration started" "COMMON_ACCOUNT_ROLLBACK_REFUSED_INTEGRATION_STARTED"
"${as_owner[@]}" -c "update private.account_lifecycle_settings set integration_state = 'not_started'"
# H1 F3: the built-in names are all present, but their meaning was weakened.
"${as_owner[@]}" -c "alter table $registry disable trigger account_lifecycle_guard_checkpoint_registry" \
  -c "update $registry set requirement = 'apple_identity' where checkpoint_key in ('session_revocation', 'storage_cleanup')"
rollback_refuses "built-in checkpoint with a weakened meaning" "COMMON_ACCOUNT_ROLLBACK_REFUSED_REQUIREMENTS_NOT_AFFIRMED"
"${as_owner[@]}" -c "update $registry set requirement = 'always' where checkpoint_key in ('session_revocation', 'storage_cleanup')" \
  -c "delete from $registry where checkpoint_key = 'storage_cleanup'"
rollback_refuses "missing built-in checkpoint" "COMMON_ACCOUNT_ROLLBACK_REFUSED_REQUIREMENTS_NOT_AFFIRMED"
"${as_owner[@]}" -c "insert into $registry values ('storage_cleanup', 'always')" \
  -c "alter table $registry enable trigger account_lifecycle_guard_checkpoint_registry" \
  -c "insert into $registry values ('extension_requirement', 'always')"
rollback_refuses "extension requirement registered" "COMMON_ACCOUNT_ROLLBACK_REFUSED_REQUIREMENTS_NOT_AFFIRMED"
"${as_owner[@]}" -c "delete from $registry where checkpoint_key = 'extension_requirement'"
# A finished operation is enough: it means deletion intent / readiness was used.
u="$(uid 918)"
"${as_owner[@]}" -c "select public.fixture_login('$u')" >/dev/null
run "begin; $(begin_sql "$u" 0) commit;" >/dev/null
run "begin; $(as_service "select public.abort_common_account_deletion('$u', '$(operation_of "$u")')") commit;" | grep -q '"status": "aborted"' || { echo "FAIL setup aborted operation" >&2; exit 1; }
rollback_refuses "finished lifecycle operation" "COMMON_ACCOUNT_ROLLBACK_REFUSED_OPERATIONS_EXIST"
"${as_owner[@]}" -c "delete from private.account_lifecycle_operations" -c "delete from public.common_accounts"
u="$(uid 915)"
registered_login "$u"
rollback_refuses "a client already registered a service" "COMMON_ACCOUNT_ROLLBACK_REFUSED_SELF_SERVICE_ENTITLEMENTS_EXIST"
"${as_owner[@]}" -c "delete from public.service_entitlements" -c "update public.common_accounts set status = 'locked' where user_id = '$u'"
rollback_refuses "operator hold present" "COMMON_ACCOUNT_ROLLBACK_REFUSED_ACCOUNT_NOT_ACTIVE"
"${as_owner[@]}" -c "delete from public.common_accounts"
"${as_owner[@]}" -c "create view public.fixture_dependent as select user_id from public.common_accounts"
rollback_refuses "downstream dependency" "because other objects depend on it"
"${as_owner[@]}" -c "drop view public.fixture_dependent"
"${as_owner[@]}" -f "$rollback"
schema_dump > "$tmp/rolled_back.sql"
diff -q "$tmp/before.sql" "$tmp/rolled_back.sql" >/dev/null || { echo "FAIL rollback did not restore the prior schema:" >&2; diff "$tmp/before.sql" "$tmp/rolled_back.sql" | head -20 >&2; exit 1; }
"${as_owner[@]}" -f "$candidate"
echo "COMMON_ACCOUNT_ROLLBACK_AFFIRMED_SHADOW_ONLY_PASS"

cleanup
trap - EXIT
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname = '$db'")"
[[ "$left" == 0 ]] || { echo "FAIL cleanup left database $db" >&2; exit 1; }
echo "COMMON_ACCOUNT_CLEANUP_PASS"
