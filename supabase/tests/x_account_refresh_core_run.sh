#!/usr/bin/env bash
# Disposable-only proof runner for the universal refresh core. Creates a
# throwaway database on a LOCAL Unix-socket PostgreSQL cluster, applies the
# production-shaped fixture and ONLY the core migration (no Phase1B..1I) as a
# non-superuser owner, runs the behavior proof and lease/commit races, then
# drops the database. Fake data only; never production.
# Usage: CORE_PGHOST=/private/tmp/<socket-dir> CORE_PGPORT=<port> \
#        CORE_PGSUPER=<local superuser> supabase/tests/x_account_refresh_core_run.sh
set -euo pipefail

host="${CORE_PGHOST:?CORE_PGHOST (local socket dir) required}"
port="${CORE_PGPORT:?CORE_PGPORT required}"
super="${CORE_PGSUPER:?CORE_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: CORE_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_refresh_core_$$"
owner="kb_refresh_core_owner"
here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
as_owner=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
as_service=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")

cleanup() {
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

"${as_owner[@]}" -f "$here/x_account_refresh_core_fixture.sql"
"${as_owner[@]}" -f "$migrations/20260925140000_x_account_credential_refresh_core.sql"
# Not re-runnable: a second apply refuses before creating anything.
if "${as_owner[@]}" -f "$migrations/20260925140000_x_account_credential_refresh_core.sql" > /dev/null 2>&1; then
  echo "FAIL core re-apply was not refused" >&2; exit 1
fi
"${as_owner[@]}" -f "$here/x_account_refresh_core_behavior.sql" | grep -q CORE_BEHAVIOR_PASS || { echo "FAIL behavior" >&2; exit 1; }
echo "CORE_BEHAVIOR_PASS"

# Races. Fresh running posts; stale states reset by the owner (operator).
"${as_owner[@]}" <<'SQL'
update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null;
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = 'X_OLD_CODE', updated_at = now()
where id in ('acct_d', 'acct_i', 'ai_salaryman_lab_x');
create table public.race_posts as
select b.brand_id, b.account, n, gen_random_uuid() as post_id
from (values ('brand_d', 'acct_d'), ('brand_i', 'acct_i'), ('ai_salaryman_lab', 'ai_salaryman_lab_x')) b(brand_id, account)
cross join generate_series(1, 2) n;
insert into public.scheduled_posts (id, brand_id, status, attempt_count, started_at)
select post_id, brand_id, 'running', 1, now() from public.race_posts;
grant select on public.race_posts to service_role;
SQL
[[ "$("${as_service[@]}" -c "select count(*) from public.race_posts")" == 6 ]] || { echo "FAIL race setup" >&2; exit 1; }
begin_for() {
  echo "select b.refresh_token from (select * from public.race_posts where account = '$1' and n = $2) p cross join lateral public.begin_x_account_refresh_legacy_post(p.post_id, p.account, p.brand_id) b"
}
tmp="$(mktemp -d /private/tmp/kabumori-refresh-core-race.XXXXXX)"
trap 'rm -rf "$tmp"; cleanup' EXIT

# 1. Same account, two posts: the first holds its transaction open; exactly one lease.
"${as_service[@]}" -c "begin; set local role service_role; $(begin_for acct_d 1); select pg_sleep(2); commit;" > "$tmp/one" 2>&1 &
sleep 0.5
"${as_service[@]}" -c "set role service_role; $(begin_for acct_d 2);" > "$tmp/two" 2>&1 &
wait
grep -q 'fake_D_REFRESH_2' "$tmp/one" || { echo "FAIL first lease: $(cat "$tmp/one")" >&2; exit 1; }
grep -q 'X_REFRESH_IN_PROGRESS' "$tmp/two" || { echo "FAIL second lease not refused: $(cat "$tmp/two")" >&2; exit 1; }
if grep -h 'fake_' "$tmp/two"; then echo "FAIL secret in error output" >&2; exit 1; fi

# 2. Two accounts refresh and commit in parallel; both health mirrors update
#    social_accounts. The self-conflicting commit lock serializes them: both
#    commit, no deadlock.
lease() { "${as_service[@]}" -c "set role service_role; select b.lease_token from (select * from public.race_posts where account = '$1' and n = 1) p cross join lateral public.begin_x_account_refresh_legacy_post(p.post_id, p.account, p.brand_id) b"; }
li="$(lease acct_i)"; la="$(lease ai_salaryman_lab_x)"
"${as_service[@]}" -c "begin; set local role service_role; select public.commit_x_account_refresh_legacy_post('$li', 'acct_i', 'fake_I_race', null, 60); select pg_sleep(1); commit;" > "$tmp/ci" 2>&1 &
"${as_service[@]}" -c "begin; set local role service_role; select public.commit_x_account_refresh_legacy_post('$la', 'ai_salaryman_lab_x', 'fake_AI_race', null, 60); select pg_sleep(1); commit;" > "$tmp/ca" 2>&1 &
wait
grep -q committed "$tmp/ci" && grep -q committed "$tmp/ca" || { echo "FAIL parallel commits: $(cat "$tmp/ci" "$tmp/ca")" >&2; exit 1; }
state="$("${as_service[@]}" -c "set role service_role; select string_agg(social_account_id || '=' || status, ',' order by social_account_id) from public.x_account_refresh_state_v2 where social_account_id in ('acct_d','acct_i','ai_salaryman_lab_x')")"
[[ "$state" == "acct_d=refreshing,acct_i=idle,ai_salaryman_lab_x=idle" ]] || { echo "FAIL race state $state" >&2; exit 1; }
health="$("${as_service[@]}" -c "select string_agg(id || '=' || coalesce(last_connection_error_code, '-'), ',' order by id) from public.social_accounts where id in ('acct_i','ai_salaryman_lab_x')")"
[[ "$health" == "acct_i=-,ai_salaryman_lab_x=-" ]] || { echo "FAIL health after commit $health" >&2; exit 1; }
echo "CORE_RACE_PASS one_lease_per_account=acct_d parallel_commits=acct_i,ai_salaryman_lab_x state=$state"

cleanup
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname = '$db'")"
[[ "$left" == 0 ]] || { echo "FAIL cleanup left database $db" >&2; exit 1; }
echo "CORE_CLEANUP_PASS"
