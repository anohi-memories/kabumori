#!/usr/bin/env bash
# Disposable-only Phase1G proof runner. Creates a throwaway database on a LOCAL
# Unix-socket PostgreSQL cluster, applies Phase1D/1E/1F/1G fixtures ->
# Phase1B -> 1D -> 1E -> 1F -> 1G as a non-superuser owner, runs the behavior
# proof and a concurrent tip-thread completion race, then drops the database.
# Fake data only; never production.
# Usage: PHASE1G_PGHOST=/private/tmp/<socket-dir> PHASE1G_PGPORT=<port> \
#        PHASE1G_PGSUPER=<local superuser> supabase/tests/x_autopost_phase1g_run.sh
set -euo pipefail

host="${PHASE1G_PGHOST:?PHASE1G_PGHOST (local socket dir) required}"
port="${PHASE1G_PGPORT:?PHASE1G_PGPORT required}"
super="${PHASE1G_PGSUPER:?PHASE1G_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: PHASE1G_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_phase1g_$$"
owner="kb_phase1g_owner"
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
"${as_owner[@]}" -f "$migrations/20260924023133_x_autopost_phase1b_account_bound_queue.sql"
"${as_owner[@]}" -f "$migrations/20260924160000_x_autopost_phase1d_claim_domain_partition.sql"
"${as_owner[@]}" -f "$migrations/20260924170000_x_autopost_phase1e_claim_bound_credential_reader.sql"
"${as_owner[@]}" -f "$migrations/20260924180000_x_autopost_phase1f_atomic_completion.sql"
"${as_owner[@]}" -f "$migrations/20260925090000_x_autopost_phase1g_multistep_completion.sql"
"${as_owner[@]}" -f "$here/x_autopost_phase1g_behavior.sql"

# Concurrent tip-thread completion: two sessions complete the same fully
# confirmed 2-part thread at once. Exactly one set of side effects must result.
as_service=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
"${as_owner[@]}" <<'SQL'
select public.schedule_account_bound_post_v2('brand_b','acct_b',current_date,'tip',70::smallint,now()-interval '1 minute');
create table public.race_claim as select * from public.claim_due_post_v2();
grant select on public.race_claim to service_role;
select public.plan_provider_steps_v2(attempt_id, claim_token, 'tip_thread', 2::smallint) from public.race_claim;
select public.mark_post_provider_started_v2(attempt_id, claim_token) from public.race_claim;
select public.begin_planned_provider_step_v2(attempt_id, claim_token, 1::smallint, 'create_post') from public.race_claim;
select public.finish_provider_step_v2(attempt_id, claim_token, 1::smallint, 'provider_object_confirmed', 'x_r1', null) from public.race_claim;
select public.begin_planned_provider_step_v2(attempt_id, claim_token, 2::smallint, 'create_reply', 'x_r1') from public.race_claim;
select public.finish_provider_step_v2(attempt_id, claim_token, 2::smallint, 'provider_object_confirmed', 'x_r2', null) from public.race_claim;
SQL
before="$("${as_service[@]}" -c "select use_count from public.tips where id = '00000000-0000-4000-8000-0000000000f2'")"
race="select public.complete_tip_post_v2(attempt_id, claim_token, social_account_id, brand_id, '00000000-0000-4000-8000-0000000000f2') from public.race_claim"
tmp="$(mktemp -d /private/tmp/kabumori-phase1g-race.XXXXXX)"
trap 'rm -rf "$tmp"; cleanup' EXIT
"${as_service[@]}" -c "begin; set role service_role; $race; select pg_sleep(2); commit;" > "$tmp/one" &
sleep 0.5
"${as_service[@]}" -c "set role service_role; $race;" > "$tmp/two" &
wait
results="$(cat "$tmp/one" "$tmp/two" | grep -E 'completed' | sort | tr '\n' ',')"
[[ "$results" == "already_completed,completed," ]] || { echo "FAIL race results: $results" >&2; exit 1; }
counts="$("${as_service[@]}" -c "select ((select use_count from public.tips where id = '00000000-0000-4000-8000-0000000000f2') - $before) || '|' || (select count(*) from public.post_execution_logs l join public.race_claim r on r.scheduled_post_id = l.scheduled_post_id where l.status = 'succeeded')")"
[[ "$counts" == "1|1" ]] || { echo "FAIL race side effects $counts (want 1|1)" >&2; exit 1; }
echo "PHASE1G_RACE_PASS results=$results counts=$counts"

cleanup
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname = '$db'")"
[[ "$left" == 0 ]] || { echo "FAIL cleanup left database $db" >&2; exit 1; }
echo "PHASE1G_CLEANUP_PASS"
