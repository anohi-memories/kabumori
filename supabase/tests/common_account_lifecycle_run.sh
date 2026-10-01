#!/usr/bin/env bash
# Disposable-only proof runner for the common account lifecycle candidate
# (20261001150000). Creates a throwaway database on a LOCAL Unix-socket
# PostgreSQL cluster, applies the production-shaped fixtures, the real
# onboarding RPC migrations, the social-mobile deletion candidate and the
# candidate under test as a non-superuser owner, then proves: additive apply,
# refused re-apply, behavior, two-session races in both commit orders, and a
# rollback that restores the exact prior schema. Fake data only; never production.
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
candidate="$migrations/20261001150000_common_account_lifecycle_foundation.sql"
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

# 1. Preflight refuses an incomplete schema (nothing is created).
"${as_owner[@]}" -c "alter table public.social_account_oauth_states rename column initiated_by_user_id to initiated_by_user_id_x"
if out="$("${as_owner[@]}" -f "$candidate" 2>&1)"; then echo "FAIL preflight accepted a missing column" >&2; exit 1; fi
grep -q 'COMMON_ACCOUNT_PREFLIGHT_MISSING_COLUMN:public.social_account_oauth_states.initiated_by_user_id' <<<"$out" || { echo "FAIL preflight message: $out" >&2; exit 1; }
"${as_owner[@]}" -c "alter table public.social_account_oauth_states rename column initiated_by_user_id_x to initiated_by_user_id"
[[ "$("${query[@]}" -c "select coalesce(to_regclass('public.common_accounts')::text, 'absent')")" == absent ]] || { echo "FAIL preflight left objects behind" >&2; exit 1; }
echo "COMMON_ACCOUNT_PREFLIGHT_PASS"

# 2. Additive apply: the schema dump only gains lines; a second apply is refused.
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

# Static checks on the candidate source (comments stripped): people are never
# matched by e-mail; nothing existing is dropped, replaced or re-granted.
code="$(sed -e 's/--.*$//' "$candidate")"
if grep -qiE 'e-?mail' <<<"$code"; then echo "FAIL the candidate reads e-mail" >&2; exit 1; fi
if grep -qiE '\b(drop|truncate|create or replace|alter (table|function|policy) (public|auth|vault)\.)' <<<"$code" \
   && grep -iE '\b(drop|truncate|create or replace|alter (table|function|policy) (public|auth|vault)\.)' <<<"$code" \
      | grep -qvE 'alter table public\.(common_accounts|service_entitlements) enable row level security'; then
  echo "FAIL the candidate alters, drops or replaces an existing object" >&2; exit 1
fi
if tr '\n' ' ' <<<"$code" | tr ';' '\n' | grep -iE '^\s*(grant|revoke) ' | grep -qvE '(common_accounts|service_entitlements|account_lifecycle_|start_kabumori_service|start_x_autopost_service|common_account_deletion_eligibility|_service_deletion|withdraw_kabumori_service|_common_account_)'; then
  echo "FAIL the candidate grants or revokes on an object it did not create" >&2; exit 1
fi
echo "COMMON_ACCOUNT_STATIC_PASS"

# 3. Behavior.
out="$("${as_owner[@]}" -A -t -f "$here/common_account_lifecycle_behavior.sql" 2>&1)" || { echo "$out" >&2; exit 1; }
grep -q COMMON_ACCOUNT_LIFECYCLE_BEHAVIOR_PASS <<<"$out" || { echo "FAIL behavior: $out" >&2; exit 1; }
echo "COMMON_ACCOUNT_LIFECYCLE_BEHAVIOR_PASS"

# 4. Two-session races. Each helper prints SQL for one committed call.
uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
as_user() { echo "select set_config('request.jwt.claim.sub', '$1', true); set local role authenticated; $2; reset role;"; }
as_service() { echo "set local role service_role; $1; reset role;"; }
run() { "${query[@]}" -c "$1"; }
start_sql() { as_user "$1" "select public.start_$2_service()"; }
begin_sql() { as_service "select public.begin_common_account_deletion('$1', $2)"; }
finalize_sql() { as_service "select public.finalize_common_account_deletion('$1', '$2')"; }
onboard_sql() { as_user "$1" "select * from public.begin_social_mobile_x_oauth_connection(repeat('$2', 64), 'kabumori-social://oauth-callback', now() + interval '10 minutes')"; }
count() { "${query[@]}" -c "select count(*) from $1"; }
workspace() { echo "'u_' || substr(md5('$1'), 1, 24)"; }
operation_of() { "${query[@]}" -c "select id from private.account_lifecycle_operations where user_id = '$1' and operation_type = 'account_deletion' and status = 'in_progress'"; }
# A login whose account row is already committed (Kabumori registered, version 2).
# Races on it are decided by the row lock, not by a unique-index wait on a new row.
registered_login() {
  "${as_owner[@]}" -c "select public.fixture_login('$1')" >/dev/null
  run "begin; $(start_sql "$1" kabumori) commit;" | grep -q '"started": true' || { echo "FAIL setup registered login $1" >&2; exit 1; }
}
# An account already in 'deleting' with no service: ready for finalize.
deleting_login() {
  "${as_owner[@]}" -c "select public.fixture_login('$1')" >/dev/null
  run "begin; $(begin_sql "$1" 1) commit;" | grep -q '"status": "started"' || { echo "FAIL setup deleting login $1" >&2; exit 1; }
}

# Race 1: a service start is in flight (uncommitted) when deletion begins.
# Deletion waits on the account row; the version the person confirmed is then
# stale, so it is refused, and a fresh begin sees the new service: finalize
# cannot skip it.
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
run "begin; $(finalize_sql "$u" "$(operation_of "$u")") commit;" > "$tmp/r1_finalize" 2>&1
grep -q '"reason": "SERVICES_REMAIN"' "$tmp/r1_finalize" || { echo "FAIL race1 finalize: $(cat "$tmp/r1_finalize")" >&2; exit 1; }
[[ "$(count "auth.users where id = '$u'")" == 1 ]] || { echo "FAIL race1 login removed" >&2; exit 1; }
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

# Race 3: finalize is uncommitted when a lifecycle start AND both legacy
# creators (the real profile bootstrap and the real X onboarding RPC) arrive.
# All three wait and fail; the login is gone and nothing is orphaned.
u="$(uid 903)"
deleting_login "$u"
op="$(operation_of "$u")"
run "begin; $(finalize_sql "$u" "$op") select pg_sleep(3); commit;" > "$tmp/r3_finalize" 2>&1 &
sleep 0.5
run "begin; $(start_sql "$u" kabumori) commit;" > "$tmp/r3_start" 2>&1 &
run "begin; $(as_user "$u" "select public.ensure_my_profile()") commit;" > "$tmp/r3_profile" 2>&1 &
run "begin; $(onboard_sql "$u" a) commit;" > "$tmp/r3_onboard" 2>&1 &
wait
grep -q '"status": "completed"' "$tmp/r3_finalize" || { echo "FAIL race3 finalize: $(cat "$tmp/r3_finalize")" >&2; exit 1; }
grep -q 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND' "$tmp/r3_start" || { echo "FAIL race3 start: $(cat "$tmp/r3_start")" >&2; exit 1; }
grep -q 'violates foreign key constraint' "$tmp/r3_profile" || { echo "FAIL race3 profile bootstrap: $(cat "$tmp/r3_profile")" >&2; exit 1; }
grep -q 'violates foreign key constraint' "$tmp/r3_onboard" || { echo "FAIL race3 onboarding: $(cat "$tmp/r3_onboard")" >&2; exit 1; }
left="$("${query[@]}" -c "select (select count(*) from auth.users where id = '$u') + (select count(*) from public.common_accounts where user_id = '$u')
  + (select count(*) from public.profiles where id = '$u') + (select count(*) from public.brands where id = $(workspace "$u"))
  + (select count(*) from public.brand_memberships where user_id = '$u') + (select count(*) from public.social_accounts where brand_id = $(workspace "$u"))
  + (select count(*) from public.social_account_oauth_states where initiated_by_user_id = '$u' or brand_id = $(workspace "$u"))")"
[[ "$left" == 0 ]] || { echo "FAIL race3 orphans after finalize: $left" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_FINALIZE_THEN_CREATORS_PASS orphans=0"

# Race 4 (reverse order): each legacy creator is uncommitted when finalize
# arrives. Finalize waits on the auth.users row, then sees the new service
# data and refuses; the login and the (owned) data remain.
u="$(uid 904)"
deleting_login "$u"
op="$(operation_of "$u")"
run "begin; $(onboard_sql "$u" b) select pg_sleep(2); commit;" > "$tmp/r4_onboard" 2>&1 &
sleep 0.5
run "begin; $(finalize_sql "$u" "$op") commit;" > "$tmp/r4_finalize" 2>&1 &
wait
if grep -qi 'error' "$tmp/r4_onboard"; then echo "FAIL race4 onboarding errored: $(cat "$tmp/r4_onboard")" >&2; exit 1; fi
grep -q 'UNREGISTERED_SERVICE_FOOTPRINT' "$tmp/r4_finalize" || { echo "FAIL race4 finalize: $(cat "$tmp/r4_finalize")" >&2; exit 1; }
[[ "$(count "auth.users where id = '$u'")" == 1 && "$(count "public.brand_memberships where user_id = '$u' and role = 'owner'")" == 1 ]] || { echo "FAIL race4 login or ownership lost" >&2; exit 1; }
u="$(uid 905)"
deleting_login "$u"
op="$(operation_of "$u")"
run "begin; $(as_user "$u" "select public.ensure_my_profile()") select pg_sleep(2); commit;" > "$tmp/r4_profile" 2>&1 &
sleep 0.5
run "begin; $(finalize_sql "$u" "$op") commit;" > "$tmp/r4_finalize2" 2>&1 &
wait
grep -q 'UNREGISTERED_SERVICE_FOOTPRINT' "$tmp/r4_finalize2" || { echo "FAIL race4 finalize vs profile: $(cat "$tmp/r4_finalize2")" >&2; exit 1; }
[[ "$(count "auth.users where id = '$u'")" == 1 && "$(count "public.profiles where id = '$u'")" == 1 ]] || { echo "FAIL race4 login or profile lost" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_CREATORS_THEN_FINALIZE_PASS"

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
# before it changed any row. Only the account row lock (I1) can make a
# concurrent deletion wait here; without it the deletion would be decided on
# the state from before the start.
u="$(uid 909)"
registered_login "$u"
"${as_owner[@]}" <<'SQL'
create function public.fixture_pause() returns trigger language plpgsql as $$
begin perform pg_sleep(2); return new; end $$;
create trigger fixture_pause before insert on public.service_entitlements
  for each row execute function public.fixture_pause();
SQL
run "begin; $(start_sql "$u" x_autopost) commit;" > "$tmp/r7_start" 2>&1 &
sleep 0.5
run "begin; $(begin_sql "$u" 2) commit;" > "$tmp/r7_begin" 2>&1 &
wait
"${as_owner[@]}" -c "drop trigger fixture_pause on public.service_entitlements" -c "drop function public.fixture_pause()"
grep -q '"started": true' "$tmp/r7_start" || { echo "FAIL race7 start: $(cat "$tmp/r7_start")" >&2; exit 1; }
grep -q '"status": "lifecycle_changed"' "$tmp/r7_begin" || { echo "FAIL race7 deletion was decided on stale state: $(cat "$tmp/r7_begin")" >&2; exit 1; }
[[ "$("${query[@]}" -c "select status from public.common_accounts where user_id = '$u'")" == active ]] || { echo "FAIL race7 account state" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_DECISION_WINDOW_PASS"

# Race 8: lock order against a LEGACY hard delete (what the existing Kabumori
# route and the existing X saga do while the guard is in shadow mode). The
# start is paused inside the RPC holding its locks; the hard delete arrives.
# Both follow auth.users -> common_accounts, so the delete waits and then
# cascades cleanly: no deadlock, no orphan.
u="$(uid 910)"
"${as_owner[@]}" -c "select public.fixture_login('$u')" >/dev/null
run "begin; $(start_sql "$u" x_autopost) commit;" >/dev/null
"${as_owner[@]}" <<'SQL'
create function public.fixture_pause() returns trigger language plpgsql as $$
begin perform pg_sleep(2); return new; end $$;
create trigger fixture_pause before insert on public.service_entitlements
  for each row execute function public.fixture_pause();
SQL
run "begin; $(start_sql "$u" kabumori) commit;" > "$tmp/r8_start" 2>&1 &
sleep 0.5
run "begin; delete from auth.users where id = '$u'; commit;" > "$tmp/r8_delete" 2>&1 &
wait
"${as_owner[@]}" -c "drop trigger fixture_pause on public.service_entitlements" -c "drop function public.fixture_pause()"
grep -q '"started": true' "$tmp/r8_start" || { echo "FAIL race8 start: $(cat "$tmp/r8_start")" >&2; exit 1; }
if grep -qi 'error' "$tmp/r8_delete"; then echo "FAIL race8 legacy delete: $(cat "$tmp/r8_delete")" >&2; exit 1; fi
left="$("${query[@]}" -c "select (select count(*) from auth.users where id = '$u') + (select count(*) from public.common_accounts where user_id = '$u')
  + (select count(*) from public.service_entitlements where user_id = '$u') + (select count(*) from public.profiles where id = '$u')")"
[[ "$left" == 0 ]] || { echo "FAIL race8 rows left after the legacy delete: $left" >&2; exit 1; }
echo "COMMON_ACCOUNT_RACE_LEGACY_DELETE_LOCK_ORDER_PASS"

# A lifecycle call outside READ COMMITTED would not see the state committed
# during its lock wait: it is refused.
u="$(uid 908)"
"${as_owner[@]}" -c "select public.fixture_login('$u')" >/dev/null
run "begin isolation level repeatable read; $(start_sql "$u" kabumori) commit;" > "$tmp/rr" 2>&1 || true
grep -q 'ACCOUNT_LIFECYCLE_REQUIRES_READ_COMMITTED' "$tmp/rr" || { echo "FAIL isolation guard: $(cat "$tmp/rr")" >&2; exit 1; }
echo "COMMON_ACCOUNT_ISOLATION_GUARD_PASS"

if grep -qi 'deadlock' "$tmp"/r*; then echo "FAIL deadlock detected" >&2; exit 1; fi
echo "COMMON_ACCOUNT_NO_DEADLOCK_PASS"

# 5. Rollback: refused while a deletion is in flight; afterwards the schema is
#    byte-identical to the dump taken before the candidate, and it re-applies.
if out="$("${as_owner[@]}" -f "$here/common_account_lifecycle_rollback.sql" 2>&1)"; then echo "FAIL rollback ran with a deletion in flight" >&2; exit 1; fi
grep -q 'COMMON_ACCOUNT_ROLLBACK_REFUSED_OPERATION_IN_PROGRESS' <<<"$out" || { echo "FAIL rollback refusal: $out" >&2; exit 1; }
"${as_owner[@]}" -c "update private.account_lifecycle_operations set status = 'aborted', current_step = 'finished', finished_at = now() where status = 'in_progress'"
"${as_owner[@]}" -f "$here/common_account_lifecycle_rollback.sql"
schema_dump > "$tmp/rolled_back.sql"
diff -q "$tmp/before.sql" "$tmp/rolled_back.sql" >/dev/null || { echo "FAIL rollback did not restore the prior schema:" >&2; diff "$tmp/before.sql" "$tmp/rolled_back.sql" | head -20 >&2; exit 1; }
"${as_owner[@]}" -f "$candidate"
echo "COMMON_ACCOUNT_ROLLBACK_PASS"

cleanup
trap - EXIT
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname = '$db'")"
[[ "$left" == 0 ]] || { echo "FAIL cleanup left database $db" >&2; exit 1; }
echo "COMMON_ACCOUNT_CLEANUP_PASS"
