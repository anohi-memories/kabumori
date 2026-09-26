#!/usr/bin/env bash
# Disposable-only Phase1I proof runner. Creates a throwaway database on a LOCAL
# Unix-socket PostgreSQL cluster, applies Phase1D/1E/1F/1G/1I fixtures ->
# Phase1B -> 1D -> 1E -> 1F -> 1G -> 1H -> refresh core -> Stage 3A rollout -> 1I as a non-superuser owner, runs the
# Phase1I behavior proof and refresh-lease races, then drops the database.
# Fake data only; never production.
# Usage: PHASE1I_PGHOST=/private/tmp/<socket-dir> PHASE1I_PGPORT=<port> \
#        PHASE1I_PGSUPER=<local superuser> supabase/tests/x_autopost_phase1i_run.sh
set -euo pipefail

host="${PHASE1I_PGHOST:?PHASE1I_PGHOST (local socket dir) required}"
port="${PHASE1I_PGPORT:?PHASE1I_PGPORT required}"
super="${PHASE1I_PGSUPER:?PHASE1I_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: PHASE1I_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_phase1i_$$"
owner="kb_phase1i_owner"
here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
as_owner=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")

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

"${as_owner[@]}" -f "$here/x_autopost_phase1d_fixture.sql"
"${as_owner[@]}" -f "$here/x_autopost_phase1e_fixture.sql"
"${as_owner[@]}" -f "$here/x_autopost_phase1f_fixture.sql"
"${as_owner[@]}" -f "$here/x_autopost_phase1g_fixture.sql"
"${as_owner[@]}" -f "$here/x_autopost_phase1i_fixture.sql"
"${as_owner[@]}" -f "$migrations/20260924023133_x_autopost_phase1b_account_bound_queue.sql"
"${as_owner[@]}" -f "$migrations/20260924160000_x_autopost_phase1d_claim_domain_partition.sql"
"${as_owner[@]}" -f "$migrations/20260924170000_x_autopost_phase1e_claim_bound_credential_reader.sql"
"${as_owner[@]}" -f "$migrations/20260924180000_x_autopost_phase1f_atomic_completion.sql"
"${as_owner[@]}" -f "$migrations/20260925090000_x_autopost_phase1g_multistep_completion.sql"
"${as_owner[@]}" -f "$migrations/20260925120000_x_autopost_phase1h_dispatch_resume.sql"
"${as_owner[@]}" -f "$migrations/20260925140000_x_account_credential_refresh_core.sql"
"${as_owner[@]}" -f "$migrations/20260926032054_x_account_refresh_rollout_authority.sql"
"${as_owner[@]}" -f "$migrations/20260925150000_x_autopost_phase1i_account_refresh.sql"
"${as_owner[@]}" -f "$here/x_autopost_phase1i_behavior.sql"

# Races on a fresh account (acct_c): two sessions try to take the refresh lease
# for two attempts of the same account while the first holds its transaction
# open; a third races provider start. Then cross-account leases in parallel.
as_service=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
"${as_owner[@]}" <<'SQL'
update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null, lease_token = null, lease_kind = null, lease_attempt_id = null, leased_at = null;
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null where id in ('acct_b', 'acct_c');
-- Fixture cleanup through the v2 domain (the Phase1D guard forbids anything else).
select set_config('kabumori.x_queue_domain', 'v2', false);
update public.post_queue_attempts_v2 set phase = 'finished', outcome = 'pre_x_terminal', error_code = 'FIXTURE_CLEANUP', finished_at = now() where phase = 'pre_x';
update public.scheduled_posts set status = 'failed', finished_at = now()
where status in ('running', 'pending') and social_account_id is not null;
select set_config('kabumori.x_queue_domain', '', false);
set role service_role;
select public.schedule_account_bound_post_v2('brand_c', 'acct_c', current_date, 'useful_tip', s::smallint, now() - interval '1 hour')
from generate_series(20, 22) s;
select public.schedule_account_bound_post_v2('brand_b', 'acct_b', current_date, 'useful_tip', 30::smallint, now() - interval '1 hour');
reset role;
create table public.race_claims as select row_number() over () as n, q.* from (
  select * from public.claim_due_post_v2() union all select * from public.claim_due_post_v2()
  union all select * from public.claim_due_post_v2() union all select * from public.claim_due_post_v2()) q;
grant select on public.race_claims to service_role;
SQL
[[ "$("${as_service[@]}" -c "select count(*) from public.race_claims")" == 4 ]] || { echo "FAIL race setup" >&2; exit 1; }
begin_for() {
  echo "select b.* from (select * from public.race_claims where social_account_id = '$1' order by n offset $2 limit 1) c cross join lateral public.begin_x_account_refresh_v2(c.attempt_id, c.claim_token, c.social_account_id, c.brand_id) b"
}
tmp="$(mktemp -d /private/tmp/kabumori-phase1i-race.XXXXXX)"
trap 'rm -rf "$tmp"; cleanup' EXIT
"${as_service[@]}" -c "begin; set role service_role; $(begin_for acct_c 0); select pg_sleep(2); commit;" > "$tmp/one" 2>&1 &
sleep 0.5
"${as_service[@]}" -c "set role service_role; $(begin_for acct_c 1);" > "$tmp/two" 2>&1 &
"${as_service[@]}" -c "set role service_role; select public.mark_post_provider_started_v2(attempt_id, claim_token) from public.race_claims where social_account_id = 'acct_c' order by n offset 2 limit 1;" > "$tmp/three" 2>&1 &
"${as_service[@]}" -c "set role service_role; $(begin_for acct_b 0);" > "$tmp/other" 2>&1 &
wait
grep -q 'fake_REFRESH_acct_c' "$tmp/one" || { echo "FAIL first lease: $(cat "$tmp/one")" >&2; exit 1; }
grep -q 'X_REFRESH_IN_PROGRESS' "$tmp/two" || { echo "FAIL second lease not refused: $(cat "$tmp/two")" >&2; exit 1; }
grep -q 'X_REFRESH_IN_PROGRESS' "$tmp/three" || { echo "FAIL provider start not refused: $(cat "$tmp/three")" >&2; exit 1; }
grep -q 'fake_REFRESH_acct_b\|fake_B_refresh_2' "$tmp/other" || { echo "FAIL cross-account lease: $(cat "$tmp/other")" >&2; exit 1; }
state="$("${as_service[@]}" -c "set role service_role; select string_agg(social_account_id || '=' || status, ',' order by social_account_id) from public.x_account_refresh_state_v2 where social_account_id in ('acct_b','acct_c')")"
[[ "$state" == "acct_b=refreshing,acct_c=refreshing" ]] || { echo "FAIL race state $state" >&2; exit 1; }
if grep -h 'fake_' "$tmp/two" "$tmp/three"; then echo "FAIL secret in error output" >&2; exit 1; fi
echo "PHASE1I_RACE_PASS one_lease_per_account=acct_c cross_account=acct_b provider_start_refused state=$state"


cleanup
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname = '$db'")"
[[ "$left" == 0 ]] || { echo "FAIL cleanup left database $db" >&2; exit 1; }
echo "PHASE1I_CLEANUP_PASS"
