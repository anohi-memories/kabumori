#!/usr/bin/env bash
# Disposable-only proof runner for the social-mobile account deletion
# candidate. Creates a throwaway database on a LOCAL Unix-socket PostgreSQL
# cluster, applies the production-shaped fixture and the candidate migration
# as a non-superuser owner, runs the behavior proof and a concurrency check,
# then drops the database. Fake data only; never production.
# Usage: DEL_PGHOST=/private/tmp/<socket-dir> DEL_PGPORT=<port> \
#        DEL_PGSUPER=<local superuser> supabase/tests/social_mobile_account_deletion_run.sh
set -euo pipefail

host="${DEL_PGHOST:?DEL_PGHOST (local socket dir) required}"
port="${DEL_PGPORT:?DEL_PGPORT required}"
super="${DEL_PGSUPER:?DEL_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: DEL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_sm_deletion_$$"
owner="kb_sm_deletion_owner"
here="$(cd "$(dirname "$0")" && pwd)"
migration="$here/../migrations/20260928160000_social_mobile_account_deletion_candidate.sql"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
as_owner=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
as_service=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")

tmp="$(mktemp -d /private/tmp/kabumori-sm-deletion.XXXXXX)"
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

"${as_owner[@]}" -f "$here/social_mobile_account_deletion_fixture.sql"
# The real, unmodified onboarding/reconnect RPCs (the writers R1 must stop).
"${as_owner[@]}" -f "$here/../migrations/20260919120000_social_mobile_x_oauth_onboarding.sql"
"${as_owner[@]}" -f "$here/../migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql"
"${as_owner[@]}" -f "$migration"
if "${as_owner[@]}" -f "$migration" > /dev/null 2>&1; then
  echo "FAIL re-apply was not refused" >&2; exit 1
fi
out="$("${as_owner[@]}" -A -t -f "$here/social_mobile_account_deletion_behavior.sql" 2>&1)" || { echo "$out" >&2; exit 1; }
grep -q SOCIAL_MOBILE_DELETION_BEHAVIOR_PASS <<<"$out" || { echo "FAIL behavior: $out" >&2; exit 1; }
if grep -q 'fake_' <<<"$out"; then echo "FAIL token material in output" >&2; exit 1; fi
echo "SOCIAL_MOBILE_DELETION_BEHAVIOR_PASS"

# Concurrency 1: two deletion requests for the same user. The first holds its
# transaction open; the second waits on the per-user lock, then sees the live
# lease and answers in_progress. Exactly one lease.
user="00000000-0000-4000-8000-0000000000aa"
"${as_owner[@]}" -c "select public.fixture_user_with_workspace('$user', 'R')" >/dev/null
acq="select public.social_mobile_account_deletion_acquire('$user', 'social_and_login', false)"
"${as_service[@]}" -c "begin; set local role service_role; $acq; select pg_sleep(2); commit;" > "$tmp/one" 2>&1 &
sleep 0.5
"${as_service[@]}" -c "set role service_role; $acq;" > "$tmp/two" 2>&1 &
wait
grep -q '"status": "acquired"' "$tmp/one" || { echo "FAIL first acquire: $(cat "$tmp/one")" >&2; exit 1; }
grep -q '"status": "in_progress"' "$tmp/two" || { echo "FAIL second acquire: $(cat "$tmp/two")" >&2; exit 1; }
echo "SOCIAL_MOBILE_DELETION_ACQUIRE_RACE_PASS"

# Concurrency 2: an X reconnect racing an uncommitted deletion start. The
# reconnect waits on the account row lock and then fails closed on the
# committed tombstone; it never installs new credentials.
user2="00000000-0000-4000-8000-0000000000bb"
"${as_owner[@]}" -c "select public.fixture_user_with_workspace('$user2', 'Q')" >/dev/null
"${as_service[@]}" -c "begin; set local role service_role; select public.social_mobile_account_deletion_acquire('$user2', 'social_and_login', false); select pg_sleep(2); commit;" > "$tmp/del" 2>&1 &
sleep 0.5
"${as_service[@]}" -c "begin; select set_config('request.jwt.claim.sub', '$user2', true); set local role authenticated; select * from public.begin_social_mobile_x_oauth_connection(repeat('9', 64), 'kabumori-social://oauth-callback', now() + interval '10 minutes'); commit;" > "$tmp/oauth" 2>&1 &
wait
grep -q '"status": "acquired"' "$tmp/del" || { echo "FAIL deletion start: $(cat "$tmp/del")" >&2; exit 1; }
grep -q 'SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS' "$tmp/oauth" || { echo "FAIL reconnect not refused: $(cat "$tmp/oauth")" >&2; exit 1; }
echo "SOCIAL_MOBILE_DELETION_RECONNECT_RACE_PASS"

# Full deletion sequence for one user as separate committed service_role calls
# (what the Edge Function does). Prints only statuses, never material.
delete_sequence() {
  "${as_service[@]}" -v ON_ERROR_STOP=1 -v uid="$1" <<'SQL'
set role service_role;
select (public.social_mobile_account_deletion_acquire(:'uid'::uuid, 'social_and_login', false)) ->> 'lease' as lease \gset
select public.social_mobile_account_deletion_credentials(:'uid'::uuid, :'lease'::uuid) as creds \gset
select 'marked=' || (public.social_mobile_account_deletion_mark_x_revoked(:'uid'::uuid, :'lease'::uuid, (
  select coalesce(jsonb_agg(jsonb_build_object('id', a ->> 'id',
    'access_sha256', encode(sha256(convert_to(a ->> 'access_token', 'UTF8')), 'hex'),
    'refresh_sha256', encode(sha256(convert_to(a ->> 'refresh_token', 'UTF8')), 'hex')) order by a ->> 'id'), '[]'::jsonb)
  from jsonb_array_elements((:'creds'::jsonb) -> 'accounts') a where (a ->> 'revoke_required')::boolean)) ->> 'status');
select 'purged=' || (public.social_mobile_account_deletion_purge(:'uid'::uuid, :'lease'::uuid) ->> 'status');
select 'finalized=' || (public.social_mobile_account_deletion_finalize(:'uid'::uuid, :'lease'::uuid) ->> 'status');
SQL
}
# Rows the user or the user's derived workspace still has (must be 0 after success).
orphans() {
  "${as_owner[@]}" -A -t -c "select (select count(*) from public.brands where id = 'u_' || substr(md5('$1'), 1, 24))
    + (select count(*) from public.brand_memberships where user_id = '$1' or brand_id = 'u_' || substr(md5('$1'), 1, 24))
    + (select count(*) from public.social_accounts where brand_id = 'u_' || substr(md5('$1'), 1, 24))
    + (select count(*) from public.social_account_oauth_states where brand_id = 'u_' || substr(md5('$1'), 1, 24) or initiated_by_user_id = '$1')
    + (select count(*) from public.social_mobile_account_deletions where user_id = '$1')
    + (select count(*) from auth.users where id = '$1')"
}
onboard_sql() {
  echo "select set_config('request.jwt.claim.sub', '$1', true); set local role authenticated; select * from public.begin_social_mobile_x_oauth_connection(repeat('$2', 64), 'kabumori-social://oauth-callback', now() + interval '10 minutes'); reset role;"
}

# Concurrency 3 (H2 phase 4b finding, exact order): a FIRST onboarding starts
# and stays uncommitted; deletion starts meanwhile. Deletion must wait for the
# creation, then delete it: success is reported only with zero orphans.
user3="00000000-0000-4000-8000-0000000000c3"
"${as_owner[@]}" -c "insert into auth.users values ('$user3')" >/dev/null
"${as_service[@]}" -c "begin; $(onboard_sql "$user3" a) select pg_sleep(3); commit;" > "$tmp/onboard3" 2>&1 &
sleep 1
delete_sequence "$user3" > "$tmp/delete3" 2>&1 &
wait
if grep -qi 'error' "$tmp/onboard3"; then echo "FAIL onboarding-first: onboarding errored: $(cat "$tmp/onboard3")" >&2; exit 1; fi
grep -q 'finalized=completed' "$tmp/delete3" || { echo "FAIL onboarding-first: deletion did not complete: $(cat "$tmp/delete3")" >&2; exit 1; }
[[ "$(orphans "$user3")" == 0 ]] || { echo "FAIL onboarding-first: orphans after success: $(orphans "$user3")" >&2; exit 1; }
echo "SOCIAL_MOBILE_DELETION_ONBOARDING_FIRST_RACE_PASS orphans=0"

# Concurrency 4 (reverse order): deletion starts first and holds its start
# transaction; a FIRST onboarding begins meanwhile. It waits for the
# workspace lock and then fails closed; nothing is created.
user4="00000000-0000-4000-8000-0000000000c4"
"${as_owner[@]}" -c "insert into auth.users values ('$user4')" >/dev/null
"${as_service[@]}" -c "begin; set local role service_role; select public.social_mobile_account_deletion_acquire('$user4', 'social_and_login', false); select pg_sleep(2); commit;" > "$tmp/delete4" 2>&1 &
sleep 0.5
"${as_service[@]}" -c "begin; $(onboard_sql "$user4" b) commit;" > "$tmp/onboard4" 2>&1 &
wait
grep -q '"status": "acquired"' "$tmp/delete4" || { echo "FAIL deletion-first: $(cat "$tmp/delete4")" >&2; exit 1; }
grep -q 'SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS' "$tmp/onboard4" || { echo "FAIL deletion-first: onboarding not refused: $(cat "$tmp/onboard4")" >&2; exit 1; }
[[ "$("${as_owner[@]}" -A -t -c "select count(*) from public.brands where id = 'u_' || substr(md5('$user4'), 1, 24)")" == 0 ]] || { echo "FAIL deletion-first: workspace created" >&2; exit 1; }
lease4="$(grep -o '"lease": "[0-9a-f-]*"' "$tmp/delete4" | cut -d'"' -f4)"
"${as_service[@]}" -c "set role service_role; select public.social_mobile_account_deletion_release('$user4', '$lease4')" >/dev/null
delete_sequence "$user4" > "$tmp/delete4b" 2>&1 || { echo "FAIL deletion-first: resume: $(cat "$tmp/delete4b")" >&2; exit 1; }
grep -q 'finalized=completed' "$tmp/delete4b" || { echo "FAIL deletion-first: completion: $(cat "$tmp/delete4b")" >&2; exit 1; }
[[ "$(orphans "$user4")" == 0 ]] || { echo "FAIL deletion-first: orphans" >&2; exit 1; }
echo "SOCIAL_MOBILE_DELETION_DELETION_FIRST_RACE_PASS orphans=0"

# Workspace creation outside READ COMMITTED would not see a newer tombstone
# after the lock wait: it is refused.
user5="00000000-0000-4000-8000-0000000000c5"
"${as_owner[@]}" -c "insert into auth.users values ('$user5')" >/dev/null
"${as_service[@]}" -c "begin isolation level repeatable read; $(onboard_sql "$user5" c) commit;" > "$tmp/rr" 2>&1 || true
grep -q 'SOCIAL_MOBILE_WORKSPACE_CREATION_REQUIRES_READ_COMMITTED' "$tmp/rr" || { echo "FAIL isolation guard: $(cat "$tmp/rr")" >&2; exit 1; }
echo "SOCIAL_MOBILE_DELETION_ISOLATION_GUARD_PASS"

if grep -qi 'deadlock' "$tmp"/*; then echo "FAIL deadlock detected" >&2; exit 1; fi
if grep -q 'fake_' "$tmp"/*; then echo "FAIL token material in output" >&2; exit 1; fi
echo "SOCIAL_MOBILE_DELETION_NO_DEADLOCK_PASS"

cleanup
trap - EXIT
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname = '$db'")"
[[ "$left" == 0 ]] || { echo "FAIL cleanup left database $db" >&2; exit 1; }
echo "SOCIAL_MOBILE_DELETION_CLEANUP_PASS"
